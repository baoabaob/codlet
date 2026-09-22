use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(super) fn serve(listener: TcpListener, hub: Weak<Hub>, mut stopped: watch::Receiver<bool>) {
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread().max_blocking_threads(4).enable_all().build() else { return; };
    runtime.block_on(async move {
        let Ok(listener) = tokio::net::TcpListener::from_std(listener) else { return; };
        let slots = Arc::new(tokio::sync::Semaphore::new(MAX_REGISTRATIONS + 8));
        let mut tasks = tokio::task::JoinSet::new();
        let mut timer = tokio::time::interval(Duration::from_millis(100));
        loop {
            tokio::select! {
                _ = stopped.changed() => break,
                result = listener.accept() => {
                    let Ok((stream, _)) = result else { break; };
                    let Ok(permit) = slots.clone().try_acquire_owned() else { drop(stream); continue; };
                    let hub = hub.clone();
                    tasks.spawn(async move { let _permit = permit; connection(stream, hub).await; });
                }
                _ = tasks.join_next(), if !tasks.is_empty() => {},
                _ = timer.tick() => { let Some(hub) = hub.upgrade() else { break; }; hub.expire(); }
            }
        }
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
        if let Some(hub) = hub.upgrade() {
            let peers = hub.state.lock().unwrap_or_else(|p|p.into_inner()).peers.keys().cloned().collect::<Vec<_>>();
            for peer in peers { hub.disconnected(&peer); }
        }
    });
    runtime.shutdown_timeout(Duration::from_secs(4));
}

async fn read_frame(reader: &mut (impl tokio::io::AsyncRead + Unpin)) -> std::io::Result<Value> {
    let length = reader.read_u32().await? as usize;
    if length == 0 || length > MAX_FRAME { return Err(std::io::ErrorKind::InvalidData.into()); }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).await?;
    serde_json::from_slice(&bytes).map_err(|_| std::io::ErrorKind::InvalidData.into())
}

async fn connection(mut stream: tokio::net::TcpStream, weak: Weak<Hub>) {
    if stream.set_nodelay(true).is_err() { return; }
    let Ok(Ok(hello)) = tokio::time::timeout(Duration::from_secs(5), read_frame(&mut stream)).await else { return; };
    let Some(token) = hello.get("token").and_then(Value::as_str).filter(|v|v.len() <= 128) else { return; };
    let Some(hub) = weak.upgrade() else { return; };
    let Ok(id) = files::token("peer") else { return; };
    let (sender, mut outgoing) = async_mpsc::channel::<Vec<u8>>(QUEUED_FRAMES);
    let queued_bytes = Arc::new(AtomicUsize::new(0));
    let (stop, mut stopped) = watch::channel(false);
    {
        let mut state = hub.state.lock().unwrap_or_else(|p| p.into_inner());
        let Some(ticket) = state.tickets.remove(token).filter(|v|v.expires > Instant::now()) else { return; };
        if state.peers.values().any(|p|p.role == ticket.role) { return; }
        state.peers.insert(id.clone(), Peer { role: ticket.role, sender, stop, queued_bytes:queued_bytes.clone() });
        if hub.send(&state, &id, json!({"event":"connected","maxFrameBytes":MAX_FRAME})).is_err() { state.peers.remove(&id); return; }
    }
    drop(hub);
    let (mut reader, mut writer) = stream.into_split();
    let read = async {
        loop {
            let frame = read_frame(&mut reader).await?;
            let Some(hub) = weak.upgrade() else { return Err::<(), std::io::Error>(std::io::ErrorKind::BrokenPipe.into()); };
            let request_id = frame.get("id").cloned().filter(valid_id);
            if frame.get("method").and_then(Value::as_str)==Some("systemRoute") {
                let gateway=hub.state.lock().unwrap_or_else(|p|p.into_inner()).peers.get(&id).is_some_and(|p|p.role==Role::Gateway);
                if gateway && let Some(request_id)=request_id.clone() {
                    let permit=hub.resolvers.clone().try_acquire_owned();
                    if let Ok(permit)=permit {
                        let peer_id=id.clone(); let target=frame["params"]["url"].as_str().unwrap_or("").to_owned();
                        tokio::task::spawn_blocking(move || {
                            let _permit=permit;
                            let result=(|| {
                                if target.len()>8192 { return Err(error("invalid_url","route URL exceeds bound")); }
                                let mut target=url::Url::parse(&target).map_err(|_|error("invalid_url","invalid route URL"))?;
                                if target.scheme()=="wss" { let _=target.set_scheme("https"); }
                                if target.scheme()=="ws" { let _=target.set_scheme("http"); }
                                if !matches!(target.scheme(),"http"|"https") || !target.username().is_empty() || target.password().is_some() { return Err(error("invalid_url","invalid route URL")); }
                                super::super::network::proxy::system_proxy(&target)
                            })();
                            let reply=match result { Ok(proxy)=>json!({"id":request_id,"result":{"proxyUrl":proxy}}), Err(error)=>json!({"id":request_id,"error":{"code":error.code}}) };
                            let state=hub.state.lock().unwrap_or_else(|p|p.into_inner());
                            let _=hub.send(&state,&peer_id,reply);
                        });
                        continue;
                    }
                    let state=hub.state.lock().unwrap_or_else(|p|p.into_inner());
                    let _=hub.send(&state,&id,json!({"id":request_id,"error":{"code":"resource_limit"}}));
                    continue;
                }
            }
            if let Err(error) = hub.process(&id, frame)
                && let Some(request_id) = request_id
            {
                let state = hub.state.lock().unwrap_or_else(|p| p.into_inner());
                let _ = hub.send(&state, &id, json!({"id":request_id,"error":{"code":error.code}}));
            }
        }
    };
    let write = async {
        while let Some(bytes) = outgoing.recv().await {
            queued_bytes.fetch_sub(bytes.len(), Ordering::AcqRel);
            tokio::time::timeout(Duration::from_secs(2), async {
                writer.write_u32(bytes.len() as u32).await?;
                writer.write_all(&bytes).await
            }).await.map_err(|_| std::io::Error::from(std::io::ErrorKind::TimedOut))??;
        }
        Ok::<_,std::io::Error>(())
    };
    tokio::select! { _ = read => {}, _ = write => {}, _ = stopped.changed() => {} }
    if let Some(hub) = weak.upgrade() { hub.disconnected(&id); }
}

fn valid_id(value: &Value) -> bool {
    value.as_str().is_some_and(|v| !v.is_empty() && v.len() <= 128)
        || value.as_u64().is_some_and(|v| v > 0 && v <= 9_007_199_254_740_991)
}

impl Hub {
    fn check_lease(&self, id: &str, lease: &Lease) -> Result<()> {
        match (lease.registration.check)("intercept", &lease.url) {
            Ok(true) => Ok(()),
            result => {
                self.release(&mut self.state.lock().unwrap_or_else(|p|p.into_inner()), id);
                Err(result.err().unwrap_or_else(||error("permission_denied", "traffic scope revoked")))
            }
        }
    }
    fn expire(&self) {
        let mut state = self.state.lock().unwrap_or_else(|p|p.into_inner());
        let now = Instant::now();
        state.tickets.retain(|_, ticket|ticket.expires > now);
        let leases = state.leases.iter().filter(|(_,v)|v.expires <= now).map(|(k,_)|k.clone()).collect::<Vec<_>>();
        for lease in leases { self.release(&mut state, &lease); }
        let calls = state.pending.iter().filter(|(_,v)|v.expires <= now).map(|(k,_)|k.clone()).collect::<Vec<_>>();
        for call in calls {
            if let Some(call) = state.pending.remove(&call) {
                let _ = self.send(&state, &call.source, json!({"id":call.id,"error":{"code":"traffic_timeout"}}));
                self.release(&mut state, &call.lease);
            }
        }
    }

    fn process(&self, peer_id: &str, frame: Value) -> Result<()> {
        let object = frame.as_object().ok_or_else(||error("invalid_frame", "object required"))?;
        let id = object.get("id").filter(|id|valid_id(id)).cloned().ok_or_else(||error("invalid_frame", "request id required"))?;
        let (role, method) = {
            let state = self.state.lock().unwrap_or_else(|p|p.into_inner());
            let role = state.peers.get(peer_id).ok_or_else(||error("peer_closed", "peer retired"))?.role.clone();
            (role, frame.get("method").and_then(Value::as_str).map(str::to_owned))
        };
        let Some(method) = method else { return self.reply(peer_id, frame); };
        let params = frame.get("params").cloned().unwrap_or(json!({}));
        let value = match method.as_str() {
            "applied" if role == Role::Gateway => {
                let revision=params["revision"].as_u64().ok_or_else(||error("invalid_params","revision required"))?;
                let mut state=self.state.lock().unwrap_or_else(|p|p.into_inner());
                if revision>state.revision { return Err(error("invalid_params","future revision")); }
                state.applied_revision=state.applied_revision.max(revision);
                json!({"applied":true})
            }
            "synchronized" if matches!(role,Role::Host(_)) => {
                let state=self.state.lock().unwrap_or_else(|p|p.into_inner());
                let registration=state.registrations.get(string(&params,"registration")?).ok_or_else(||error("interceptor_retired","registration retired"))?;
                if role!=Role::Host(registration.owner.clone()) { return Err(error("permission_denied","registration belongs to another owner")); }
                let revision=params["revision"].as_u64().ok_or_else(||error("invalid_params","revision required"))?;
                json!({"applied":state.ready && state.applied_revision>=revision})
            }
            "launched" if role == Role::Gateway => {
                if serde_json::to_vec(&params).map_or(true,|v|v.len()>16*1024) { return Err(error("invalid_params","launch descriptor exceeds bound")); }
                let mut state=self.state.lock().unwrap_or_else(|p|p.into_inner());
                if state.launch.is_some() { return Err(error("invalid_params","launch descriptor already committed")); }
                state.launch=Some(params);
                json!({"accepted":true})
            }
            "certificateAuthority" if role == Role::Gateway => {
                json!({"caPem":self.certificates.lock().unwrap_or_else(|p|p.into_inner()).pem()})
            }
            "certificate" if role == Role::Gateway => {
                let url = string(&params,"url")?;
                let target=url::Url::parse(url).map_err(|_|error("invalid_url","invalid certificate origin"))?;
                if target.scheme() != "https" || !target.username().is_empty() || target.password().is_some() || target.as_str()!=format!("{}/",target.origin().ascii_serialization()) {
                    return Err(error("invalid_url","certificate needs an exact HTTPS origin"));
                }
                let registrations=self.state.lock().unwrap_or_else(|p|p.into_inner()).registrations.values()
                    .filter(|r|r.active.load(Ordering::Acquire) && r.matches(url)).cloned().collect::<Vec<_>>();
                if !registrations.iter().any(|r|(r.check)("intercept",url).unwrap_or(false)) { return Err(error("permission_denied","no active interceptor covers this certificate")); }
                self.certificates.lock().unwrap_or_else(|p|p.into_inner()).leaf(target.host_str().unwrap().trim_matches(['[',']']))?
            }
            "ready" if role == Role::Gateway => {
                let mut state = self.state.lock().unwrap_or_else(|p|p.into_inner());
                state.ready = true;
                json!({"ready":true})
            }
            "snapshot" if role == Role::Gateway => {
                let (revision, registrations) = {
                    let mut state = self.state.lock().unwrap_or_else(|p|p.into_inner());
                    state.change_queued = false;
                    let mut registrations = state.registrations.values().filter(|r|r.active.load(Ordering::Acquire)).cloned().collect::<Vec<_>>();
                    registrations.sort_by_key(|r|r.order);
                    (state.revision, registrations)
                };
                let mut live = Vec::new();
                for registration in registrations {
                    let allowed = registration.options["origins"].as_array().unwrap().iter()
                        .all(|origin|(registration.check)("intercept", origin.as_str().unwrap()).unwrap_or(false));
                    if allowed { live.push(json!({"registration":registration.key,"pluginId":registration.plugin_id,"generation":registration.generation,"options":registration.options,"order":registration.order})); }
                }
                json!({"revision":revision,"registrations":live})
            }
            "activate" | "setEnabled" if matches!(role, Role::Host(_)) => {
                let key = string(&params, "registration")?;
                let registration = self.state.lock().unwrap_or_else(|p|p.into_inner()).registrations.get(key).cloned()
                    .ok_or_else(||error("stale_generation", "registration retired"))?;
                if role != Role::Host(registration.owner.clone()) { return Err(error("permission_denied", "registration belongs to another generation")); }
                for origin in registration.options["origins"].as_array().unwrap() {
                    if !(registration.check)("intercept", origin.as_str().unwrap())? { return Err(error("permission_denied", "traffic grant retired")); }
                }
                let mut state = self.state.lock().unwrap_or_else(|p|p.into_inner());
                if !state.registrations.contains_key(key) || !state.ready { return Err(error("traffic_unavailable", "traffic entrance retired")); }
                let enabled = if method == "activate" { true } else { params["enabled"].as_bool().ok_or_else(||error("invalid_params", "enabled must be boolean"))? };
                registration.active.store(enabled, Ordering::Release);
                if !enabled {
                    let leases = state.leases.iter().filter(|(_,lease)|lease.registration.key==key).map(|(id,_)|id.clone()).collect::<Vec<_>>();
                    for lease in leases { self.release(&mut state, &lease); }
                }
                self.changed(&mut state);
                json!({"activated":enabled,"attached":state.attached,"revision":state.revision})
            }
            "authorize" | "open" if role == Role::Gateway => {
                let key = string(&params, "registration")?;
                let registration = self.state.lock().unwrap_or_else(|p|p.into_inner()).registrations.get(key).cloned()
                    .ok_or_else(||error("stale_generation", "registration retired"))?;
                let url = string(&params, "url")?;
                if !registration.active.load(Ordering::Acquire) { return Err(error("traffic_unavailable", "interceptor is not active")); }
                if url.len() > 8192 { return Err(error("invalid_params", "URL exceeds bound")); }
                let action = if method == "open" { "intercept" } else { string(&params, "action")? };
                if action != "redirect" && !registration.matches(url) { return Err(error("permission_denied", "request is outside the registered filter")); }
                let allowed = (registration.check)(action, url)?;
                if method == "authorize" { json!({"allowed":allowed}) }
                else {
                    if !allowed { return Err(error("permission_denied", "traffic scope revoked")); }
                    let mut state = self.state.lock().unwrap_or_else(|p|p.into_inner());
                    if !state.registrations.contains_key(key) { return Err(error("stale_generation", "registration retired")); }
                    if state.leases.len() >= MAX_LEASES { return Err(error("resource_limit", "traffic lease limit reached")); }
                    if !state.peers.values().any(|p|p.role == Role::Host(registration.owner.clone())) { return Err(error("peer_closed", "Host data peer is unavailable")); }
                    let lease = files::token("exchange")?;
                    let mut policy_url = url::Url::parse(url).map_err(|_|error("invalid_url", "invalid traffic URL"))?;
                    if policy_url.scheme() == "ws" { let _ = policy_url.set_scheme("http"); }
                    else if policy_url.scheme() == "wss" { let _ = policy_url.set_scheme("https"); }
                    state.leases.insert(lease.clone(), Lease { registration, url:policy_url.origin().ascii_serialization(), expires:Instant::now()+Duration::from_secs(300) });
                    json!({"lease":lease})
                }
            }
            "release" if role == Role::Gateway => {
                let mut state = self.state.lock().unwrap_or_else(|p|p.into_inner());
                self.release(&mut state, string(&params,"lease")?);
                json!({"released":true})
            }
            "relay" => { self.relay(peer_id, id, role, params)?; return Ok(()); }
            _ => return Err(error("permission_denied", "traffic data operation is unavailable")),
        };
        let state = self.state.lock().unwrap_or_else(|p|p.into_inner());
        self.send(&state, peer_id, json!({"id":id,"result":value}))
    }

    fn relay(&self, peer: &str, id: Value, role: Role, params: Value) -> Result<()> {
        let lease_id = string(&params, "lease")?;
        let operation = string(&params, "operation")?;
        if !["invoke", "stream.read", "stream.cancel"].contains(&operation) || role != Role::Gateway && operation == "invoke" {
            return Err(error("permission_denied", "traffic operation is unavailable"));
        }
        let lease = self.state.lock().unwrap_or_else(|p|p.into_inner()).leases.get(lease_id).cloned()
            .ok_or_else(||error("stream_retired", "exchange retired"))?;
        if role != Role::Gateway && role != Role::Host(lease.registration.owner.clone()) { return Err(error("permission_denied", "exchange belongs to another generation")); }
        self.check_lease(lease_id, &lease)?;
        let mut state = self.state.lock().unwrap_or_else(|p|p.into_inner());
        if !state.leases.contains_key(lease_id) { return Err(error("stream_retired", "exchange retired")); }
        let peer_limit = if role == Role::Gateway { 256 } else { 64 };
        if state.pending.len() >= MAX_PENDING || state.pending.values().filter(|call|call.source == peer).count() >= peer_limit { return Err(error("resource_limit", "traffic request limit reached")); }
        let destination = state.peers.iter().find(|(_,p)|p.role == if role == Role::Gateway {Role::Host(lease.registration.owner.clone())}else{Role::Gateway}).map(|(id,_)|id.clone())
            .ok_or_else(||error("peer_closed", "opposite traffic peer is unavailable"))?;
        state.sequence = state.sequence.checked_add(1).ok_or_else(||error("resource_limit", "traffic sequence exhausted"))?;
        let relay = format!("r{}", state.sequence);
        let timeout = if operation == "invoke" { lease.registration.options["timeoutMs"].as_u64().unwrap() } else { 30_000 };
        self.send(&state, &destination, json!({"id":relay,"method":operation,"params":{"lease":lease_id,"registration":lease.registration.key,"payload":params.get("payload")}}))?;
        state.pending.insert(relay, Pending { source:peer.into(), destination, id, lease:lease_id.into(), expires:Instant::now()+Duration::from_millis(timeout) });
        state.peak_pending = state.peak_pending.max(state.pending.len());
        Ok(())
    }

    fn reply(&self, peer: &str, frame: Value) -> Result<()> {
        let Some(key) = frame.get("id").and_then(Value::as_str) else { return Err(error("invalid_frame", "invalid relay id")); };
        let (lease_id, lease) = {
            let state = self.state.lock().unwrap_or_else(|p|p.into_inner());
            let Some(pending) = state.pending.get(key) else { return Ok(()); };
            if pending.destination != peer { return Err(error("permission_denied", "reply belongs to another peer")); }
            (pending.lease.clone(), state.leases.get(&pending.lease).cloned().ok_or_else(||error("stream_retired", "exchange retired"))?)
        };
        // A grant can change while plugin code or a stream read is pending.
        // Recheck before committing the result, without holding the hub mutex.
        self.check_lease(&lease_id, &lease)?;
        let mut state = self.state.lock().unwrap_or_else(|p|p.into_inner());
        let Some(pending) = state.pending.get(key) else { return Ok(()); }; // A bounded operation may already have expired.
        if pending.destination != peer { return Err(error("permission_denied", "reply belongs to another peer")); }
        let pending = state.pending.remove(key).unwrap();
        let reply = if let Some(failure) = frame.get("error") {
            let code = match failure.get("code").and_then(Value::as_str) {
                Some(code @ ("body_too_large" | "body_already_consumed" | "stream_retired" | "request_cancelled" | "invalid_frame" | "invalid_body")) => code,
                _ => "traffic_callback_failed",
            };
            json!({"id":pending.id,"error":{"code":code}})
        }
            else { json!({"id":pending.id,"result":frame.get("result")}) };
        self.send(&state, &pending.source, reply)
    }
}
