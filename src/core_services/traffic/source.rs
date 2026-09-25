use super::*;
use super::{
    engine::{Engine, Exchange},
    model::*,
    rpc::{self, Handler, Rpc},
    streams,
};
use tokio_util::sync::CancellationToken;
pub(super) struct Route {
    pub peer: Arc<Rpc>,
    pub config: Mutex<Arc<RouteConfig>>,
    pub stopped: CancellationToken,
}
pub(super) struct RouteConfig {
    pub base: url::Url,
    pub ca: String,
}
pub(super) fn base(value: &str) -> Result<url::Url> {
    let target = url(value)?;
    let path = value
        .split_once("://")
        .map(|(_, tail)| tail.find('/').map(|i| &tail[i..]).unwrap_or("/"))
        .unwrap_or("/");
    if value.len() > 2048
        || !matches!(target.scheme(), "http" | "https")
        || target.query().is_some()
        || bad_path(path)
    {
        return Err(error("invalid_target", "invalid upstream base"));
    }
    let mut target = target;
    let path = format!("{}/", target.path().trim_end_matches('/'));
    target.set_path(&path);
    Ok(target)
}
pub(super) fn bad_path(path: &str) -> bool {
    let path = path.split('?').next().unwrap_or("");
    let lower = path.to_ascii_lowercase();
    path.contains('\\')
        || ["%2e", "%2f", "%5c", "%25"]
            .iter()
            .any(|v| lower.contains(v))
        || path.split('/').any(|p| p == "." || p == "..")
}
pub(super) fn token(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
pub(super) fn private_token() -> Result<String> {
    use base64::Engine as _;
    use sha2::Digest;
    // Two independent 128-bit OS-random handles retain the source ABI's
    // 256-bit, 43-character base64url capability token.
    let seed = format!("{}{}", files::token("source")?, files::token("source")?);
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(sha2::Sha256::digest(seed.as_bytes())))
}
impl Engine {
    pub fn start_source(self: &Arc<Self>, listener: tokio::net::TcpListener) {
        let engine = self.clone();
        self.spawn(async move {
            let candidates=Arc::new(tokio::sync::Semaphore::new(4));
            loop {
                let accepted=tokio::select!{_=engine.stopped.cancelled()=>break,result=listener.accept()=>result};
                let Ok((mut stream,_))=accepted else{engine.stop();break};
                let Ok(permit)=candidates.clone().try_acquire_owned() else{continue};
                let engine=engine.clone();engine.clone().spawn(async move {
                    let _permit=permit;
                    let hello=tokio::select!{_=engine.stopped.cancelled()=>return,value=tokio::time::timeout(Duration::from_secs(5),rpc::read_frame(&mut stream))=>value};
                    let Ok(Ok(hello))=hello else{return};
                    if hello.as_object().is_none_or(|v|v.len()!=1)||!secure_equal(hello["token"].as_str().unwrap_or("").as_bytes(),engine.source_token.as_bytes()){return;}
                    let (peer,outgoing)=rpc::socket_peer(engine.stopped.child_token());
                    {
                        let mut current=engine.source_peer.lock().unwrap_or_else(|p|p.into_inner());
                        if current.is_some(){return;}*current=Some(peer.clone());
                    }
                    let weak=Arc::downgrade(&engine);let source=peer.clone();
                    let handler:Handler=Arc::new(move|method,params|{let weak=weak.clone();let source=source.clone();Box::pin(async move{weak.upgrade().ok_or_else(||error("traffic_unavailable","engine retired"))?.source_request(source,&method,params).await})});
                    if peer.send(json!({"event":"connected"})).is_ok(){rpc::serve_socket(stream,peer.clone(),outgoing,handler,Arc::new(|_|{})).await;}
                    let removed={let mut routes=engine.routes.lock().unwrap_or_else(|p|p.into_inner());let removed=routes.iter().filter(|(_,r)|Arc::ptr_eq(&r.peer,&peer)).map(|(id,_)|id.clone()).collect::<Vec<_>>();removed.into_iter().filter_map(|id|routes.remove(&id)).collect::<Vec<_>>()};
                    for route in removed {route.stopped.cancel();}
                    let values=engine.delegated.lock().unwrap_or_else(|p|p.into_inner()).values().filter(|v|v.delegate.as_ref().is_some_and(|(p,_)|Arc::ptr_eq(p,&peer))).cloned().collect::<Vec<_>>();
                    for value in values {value.retire(false);}
                    let mut current=engine.source_peer.lock().unwrap_or_else(|p|p.into_inner());
                    if current.as_ref().is_some_and(|p|Arc::ptr_eq(p,&peer)){*current=None;}
                });
            }
        });
    }
    async fn certificate(
        &self,
        peer: Arc<Rpc>,
        id: &str,
        value: Option<&Value>,
        fallback: &str,
    ) -> Result<String> {
        let Some(value) = value else {
            return Ok(fallback.to_owned());
        };
        let bytes = streams::remote_body(
            peer,
            id.to_owned(),
            value.clone(),
            self.stopped.child_token(),
            128 * 1024,
        )?
        .collect(128 * 1024)
        .await?;
        let value = String::from_utf8(bytes.to_vec())
            .map_err(|_| error("invalid_ca_bundle", "invalid CA encoding"))?;
        if value.is_empty() {
            return Ok(value);
        }
        let certificates = reqwest::Certificate::from_pem_bundle(value.as_bytes())
            .map_err(|_| error("invalid_ca_bundle", "invalid CA bundle"))?;
        if certificates.is_empty() || certificates.len() > 64 {
            return Err(error("invalid_ca_bundle", "invalid CA bundle"));
        }
        let mut remainder = value.as_str();
        while let Some(tail) = remainder
            .trim_start()
            .strip_prefix("-----BEGIN CERTIFICATE-----")
        {
            let Some((_, tail)) = tail.split_once("-----END CERTIFICATE-----") else {
                return Err(error("invalid_ca_bundle", "invalid CA bundle"));
            };
            remainder = tail;
        }
        if !remainder.trim().is_empty() {
            return Err(error("invalid_ca_bundle", "invalid CA bundle"));
        }
        Ok(value)
    }
    pub async fn source_request(
        self: &Arc<Self>,
        peer: Arc<Rpc>,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        if peer.stopped.is_cancelled() {
            return Err(error("peer_closed", "source retired"));
        }
        match method {
            "route.register" | "route.update" => {
                let id = string(&params, "token")?;
                if !token(id) {
                    return Err(error("invalid_target", "invalid route token"));
                }
                let prior = self
                    .routes
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(id)
                    .cloned();
                if method == "route.register" && prior.is_some() {
                    return Err(error("route_collision", "route already exists"));
                }
                if method == "route.update"
                    && prior.as_ref().is_none_or(|r| !Arc::ptr_eq(&r.peer, &peer))
                {
                    return Err(error("target_not_found", "route unavailable"));
                }
                let fallback = prior
                    .as_ref()
                    .map(|r| {
                        r.config
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .ca
                            .clone()
                    })
                    .unwrap_or_default();
                let config = Arc::new(RouteConfig {
                    base: base(string(&params, "upstreamBaseUrl")?)?,
                    ca: self
                        .certificate(peer.clone(), id, params.get("additionalCaPem"), &fallback)
                        .await?,
                });
                if peer.stopped.is_cancelled() {
                    return Err(error("peer_closed", "source retired"));
                }
                let mut routes = self.routes.lock().unwrap_or_else(|p| p.into_inner());
                if method == "route.update" {
                    let current = routes
                        .get(id)
                        .filter(|r| prior.as_ref().is_some_and(|p| Arc::ptr_eq(p, r)))
                        .ok_or_else(|| error("route_closed", "route retired"))?;
                    *current.config.lock().unwrap_or_else(|p| p.into_inner()) = config;
                    Ok(json!({"updated":true}))
                } else {
                    if routes.contains_key(id) {
                        return Err(error("route_collision", "route already exists"));
                    }
                    if routes.len() >= 32 {
                        return Err(error("resource_limit", "route limit reached"));
                    }
                    routes.insert(
                        id.to_owned(),
                        Arc::new(Route {
                            peer,
                            config: Mutex::new(config),
                            stopped: self.stopped.child_token(),
                        }),
                    );
                    self.route_changed.notify_waiters();
                    Ok(
                        json!({"baseUrl":format!("http://127.0.0.1:{}/{}/{}",self.port,self.prefix,id)}),
                    )
                }
            }
            "route.close" => {
                let id = string(&params, "token")?;
                let mut routes = self.routes.lock().unwrap_or_else(|p| p.into_inner());
                if routes.get(id).is_none_or(|r| !Arc::ptr_eq(&r.peer, &peer)) {
                    return Err(error("target_not_found", "route unavailable"));
                }
                if let Some(route) = routes.remove(id) {
                    route.stopped.cancel();
                }
                Ok(json!({"closed":true}))
            }
            "http.intercept" => {
                let id = string(&params, "exchange")?.to_owned();
                if !token(&id) {
                    return Err(error("invalid_target", "invalid exchange token"));
                }
                let permit = self
                    .http_slots
                    .clone()
                    .try_acquire_owned()
                    .map_err(|_| error("resource_limit", "HTTP capacity reached"))?;
                let exchange = self.exchange(
                    &peer.stopped,
                    permit,
                    Some((peer.clone(), id.clone())),
                    None,
                    false,
                )?;
                {
                    let mut values = self.delegated.lock().unwrap_or_else(|p| p.into_inner());
                    if values.contains_key(&id) {
                        exchange.notify.store(false, Ordering::Release);
                        return Err(error("resource_limit", "exchange already exists"));
                    }
                    values.insert(id.clone(), exchange.clone());
                }
                let outcome=async {
                    let value=&params["request"];let target=bounded_string(value,"url",8192)?;if !matches!(url(target)?.scheme(),"http"|"https"){return Err(error("invalid_target","HTTP URL required"));}
                    let request=Request{id:files::token("request")?,url:target.to_owned(),method:super::model::method(string(value,"method")?)?,headers:pairs(value.get("headers").unwrap_or(&json!([])))?,body:streams::remote_body(peer.clone(),id.clone(),value.get("body").cloned().unwrap_or(Value::Null),exchange.stopped.child_token(),streams::BODY_LIMIT)?,protocols:vec![]};
                    let response=self.intercept_http(request,&exchange,&Default::default()).await?;exchange.check()?;
                    let body=exchange.streams.export(response.body)?;
                    Ok(json!({"status":response.status,"headers":strip(&response.headers,false),"body":body}))
                }.await;
                if outcome.is_err() {
                    exchange.retire(false);
                }
                outcome
            }
            "http.release" | "http.cancel" => {
                let id = string(&params, "exchange")?;
                let exchange = self
                    .delegated
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(id)
                    .filter(|e| {
                        e.delegate
                            .as_ref()
                            .is_some_and(|(p, _)| Arc::ptr_eq(p, &peer))
                    })
                    .cloned();
                if let Some(exchange) = exchange {
                    exchange.retire(method == "http.cancel");
                }
                Ok(json!({"retired":true}))
            }
            "relay" => {
                let id = string(&params, "lease")?;
                let exchange = self
                    .delegated
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(id)
                    .filter(|e| {
                        e.delegate
                            .as_ref()
                            .is_some_and(|(p, _)| Arc::ptr_eq(p, &peer))
                    })
                    .cloned()
                    .ok_or_else(|| error("stream_retired", "exchange retired"))?;
                exchange
                    .streams
                    .handle(string(&params, "operation")?, &params["payload"])
                    .await
            }
            _ => Err(error("invalid_method", "unknown source operation")),
        }
    }
    pub async fn delegate_http(
        &self,
        request: &Request,
        exchange: &Arc<Exchange>,
    ) -> Result<Response> {
        let (peer, id) = exchange
            .delegate
            .as_ref()
            .ok_or_else(|| error("invalid_target", "missing source"))?;
        let body = exchange.streams.export(request.body.clone())?;
        let result=peer.request("http.forward",json!({"exchange":id,"request":{"url":request.url,"method":request.method,"headers":request.headers,"body":body}}),&exchange.stopped,Duration::from_secs(300)).await?;
        let final_url = result
            .get("finalUrl")
            .and_then(Value::as_str)
            .unwrap_or(&request.url);
        if !matches!(url(final_url)?.scheme(), "http" | "https") {
            return Err(error("invalid_response", "invalid final URL"));
        }
        let body = streams::remote_body(
            peer.clone(),
            id.clone(),
            result.get("body").cloned().unwrap_or(Value::Null),
            exchange.stopped.child_token(),
            streams::BODY_LIMIT,
        )?;
        Self::headers_response(&result, body)
    }
    pub fn retire_removed_owners(&self) {
        let Some(hub) = self.hub.upgrade() else {
            self.stop();
            return;
        };
        let channels = self
            .channels
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for channel in channels {
            if !(channel.check)("channel", "").unwrap_or(false) {
                channel.close(self);
            }
        }
        let sources = hub
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .sources
            .values()
            .cloned()
            .collect::<Vec<_>>();
        // Owned source cancellation lives with its authority record; no cached
        // origin or generation decision survives its removal.
        for source in sources {
            if !(source.check)("intercept", &source.base_url).unwrap_or(false) {
                source.stopped.cancel();
            }
        }
    }
}
fn secure_equal(left: &[u8], right: &[u8]) -> bool {
    let mut diff = left.len() ^ right.len();
    for (index, byte) in right.iter().enumerate() {
        diff |= usize::from(*byte ^ left.get(index).copied().unwrap_or(0));
    }
    diff == 0
}
