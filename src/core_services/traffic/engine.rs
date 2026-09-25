//! The generic traffic engine. Client-specific hooks remain in launch plugins.
use super::*;
use super::{
    model::*,
    rpc::{Event, Handler, Rpc},
    streams::{Body, Streams},
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

pub(super) struct Engine {
    pub hub: Weak<Hub>,
    pub gateway: Arc<Rpc>,
    pub stopped: CancellationToken,
    pub runtime: tokio::runtime::Handle,
    pub tasks: AtomicUsize,
    pub prefix: String,
    pub port: u16,
    pub source_port: u16,
    pub source_token: String,
    pub environment: BTreeMap<String, String>,
    pub inherited_ca: Option<String>,
    pub routes: Mutex<BTreeMap<String, Arc<super::source::Route>>>,
    pub source_peer: Mutex<Option<Arc<Rpc>>>,
    pub delegated: Mutex<BTreeMap<String, Arc<Exchange>>>,
    pub leases: Mutex<BTreeMap<String, Weak<Exchange>>>,
    pub channels: Mutex<BTreeMap<String, Arc<super::channels::Channel>>>,
    pub exchanges: Mutex<BTreeMap<String, Weak<Exchange>>>,
    pub http_slots: Arc<Semaphore>,
    pub ws_slots: Arc<Semaphore>,
    pub route_changed: tokio::sync::Notify,
    pub blockers: Arc<Semaphore>,
    pub clients: Mutex<std::collections::VecDeque<(super::transport::ClientKey, reqwest::Client)>>,
}
pub(super) struct LeaseContext {
    pub id: String,
    pub streams: Arc<Streams>,
}
pub(super) struct Exchange {
    pub id: String,
    pub engine: Weak<Engine>,
    pub stopped: CancellationToken,
    pub leases: Mutex<BTreeMap<String, Arc<LeaseContext>>>,
    pub streams: Arc<Streams>,
    pub delegate: Option<(Arc<Rpc>, String)>,
    pub channel: Option<Arc<super::channels::Channel>>,
    pub web_socket: bool,
    pub outbound: tokio::sync::Mutex<super::channels::Outbound>,
    pub ws_ready: tokio::sync::Notify,
    pub finished: AtomicBool,
    pub notify: AtomicBool,
    pub _permit: tokio::sync::OwnedSemaphorePermit,
}
impl Exchange {
    pub fn retire(&self, notify: bool) {
        if !notify {
            self.notify.store(false, Ordering::Release);
        }
        if self.finished.swap(true, Ordering::AcqRel) {
            return;
        }
        self.stopped.cancel();
        self.streams.close();
        let leases = std::mem::take(&mut *self.leases.lock().unwrap_or_else(|p| p.into_inner()));
        if let Some(engine) = self.engine.upgrade() {
            engine
                .exchanges
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&self.id);
            for lease in leases.values() {
                lease.streams.close();
                engine
                    .leases
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&lease.id);
                if let Some(hub) = engine.hub.upgrade() {
                    hub.release(
                        &mut hub.state.lock().unwrap_or_else(|p| p.into_inner()),
                        &lease.id,
                    );
                }
            }
            if let Some((peer, id)) = &self.delegate {
                {
                    let mut values = engine.delegated.lock().unwrap_or_else(|p| p.into_inner());
                    if values.get(id).is_some_and(|e| e.id == self.id) {
                        values.remove(id);
                    }
                }
                if self.notify.load(Ordering::Acquire) {
                    let peer = peer.clone();
                    let id = id.clone();
                    engine.spawn(async move {
                        let _ = peer
                            .request(
                                "http.cancel",
                                json!({"exchange":id}),
                                &peer.stopped,
                                Duration::from_secs(2),
                            )
                            .await;
                    });
                }
            }
            if let Some(channel) = &self.channel {
                channel.completed(&engine, self);
            }
        }
    }
    pub fn check(&self) -> Result<()> {
        if self.stopped.is_cancelled() {
            Err(error("request_cancelled", "exchange retired"))
        } else {
            Ok(())
        }
    }
}
impl Drop for Exchange {
    fn drop(&mut self) {
        self.retire(true);
    }
}
pub(super) struct Completion(pub Arc<Exchange>);
impl Drop for Completion {
    fn drop(&mut self) {
        self.0.retire(false);
    }
}

impl Engine {
    pub async fn start(hub: Arc<Hub>, environment: BTreeMap<String, String>) -> Result<Arc<Self>> {
        let ca_path = environment.get("NODE_EXTRA_CA_CERTS").cloned();
        let inherited_ca =
            tokio::task::spawn_blocking(move || super::transport::inherited_ca(ca_path))
                .await
                .map_err(|_| error("invalid_ca_bundle", "cannot load inherited trust"))??;
        let stopped = CancellationToken::new();
        let http = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| error("traffic_unavailable", "cannot bind native HTTP ingress"))?;
        let source = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| error("traffic_unavailable", "cannot bind source peer"))?;
        let port = http
            .local_addr()
            .map_err(|_| error("traffic_unavailable", "missing ingress address"))?
            .port();
        let source_port = source
            .local_addr()
            .map_err(|_| error("traffic_unavailable", "missing source address"))?
            .port();
        let prefix = super::source::private_token()?;
        let source_token = super::source::private_token()?;
        let descriptor = json!({"source":{"version":1,"kind":"plaintext","protocols":["http","sse","webSocket"],"operations":["route.register","route.update","route.close","http.intercept"],"endpoint":{"host":"127.0.0.1","port":source_port,"token":source_token},"routeBaseUrl":format!("http://127.0.0.1:{port}/{prefix}")},"environmentPatch":{"set":{},"removeCaseInsensitive":[]}});
        let id = files::token("native-gateway")?;
        let weak = Arc::downgrade(&hub);
        let target = id.clone();
        let gateway = Rpc::new(
            move |frame| {
                weak.upgrade()
                    .ok_or_else(|| error("peer_closed", "authority retired"))?
                    .process(&target, frame)
            },
            stopped.child_token(),
            256,
        );
        let (sender, mut receiver) = async_mpsc::channel(QUEUED_FRAMES);
        let queued_bytes = Arc::new(AtomicUsize::new(0));
        let (stop, mut watched) = watch::channel(false);
        {
            let mut state = hub.state.lock().unwrap_or_else(|p| p.into_inner());
            if state.peers.values().any(|p| p.role == Role::Gateway) {
                return Err(error("traffic_unavailable", "gateway already present"));
            }
            state.peers.insert(
                id.clone(),
                Peer {
                    role: Role::Gateway,
                    sender,
                    stop,
                    queued_bytes: queued_bytes.clone(),
                },
            );
            state.ready = true;
            state.launch = Some(descriptor.clone());
            state.applied_revision = state.revision;
        }
        let engine = Arc::new(Self {
            hub: Arc::downgrade(&hub),
            gateway,
            stopped,
            runtime: tokio::runtime::Handle::current(),
            tasks: AtomicUsize::new(0),
            prefix,
            port,
            source_port,
            source_token,
            inherited_ca,
            environment: environment
                .into_iter()
                .filter(|(key, _)| {
                    matches!(
                        key.to_ascii_uppercase().as_str(),
                        "HTTP_PROXY" | "HTTPS_PROXY" | "ALL_PROXY" | "NO_PROXY"
                    )
                })
                .collect(),
            routes: Mutex::new(BTreeMap::new()),
            source_peer: Mutex::new(None),
            delegated: Mutex::new(BTreeMap::new()),
            leases: Mutex::new(BTreeMap::new()),
            channels: Mutex::new(BTreeMap::new()),
            exchanges: Mutex::new(BTreeMap::new()),
            http_slots: Arc::new(Semaphore::new(4)),
            ws_slots: Arc::new(Semaphore::new(32)),
            route_changed: tokio::sync::Notify::new(),
            blockers: Arc::new(Semaphore::new(4)),
            clients: Mutex::new(std::collections::VecDeque::new()),
        });
        let weak = Arc::downgrade(&engine);
        let handler: Handler = Arc::new(move |method, params| {
            let weak = weak.clone();
            Box::pin(async move {
                weak.upgrade()
                    .ok_or_else(|| error("traffic_unavailable", "engine retired"))?
                    .data_request(&method, params)
                    .await
            })
        });
        let weak = Arc::downgrade(&engine);
        let event: Event = Arc::new(move |value| {
            if let Some(engine) = weak.upgrade() {
                engine.event(value);
            }
        });
        let current = engine.clone();
        engine.spawn(async move {
            let slots = Arc::new(Semaphore::new(256));
            loop {
                tokio::select! {
                    _ = current.stopped.cancelled() => break,
                    _ = watched.changed() => break,
                    value = receiver.recv() => {
                        let Some(bytes): Option<Vec<u8>> = value else { break; };
                        queued_bytes.fetch_sub(bytes.len(), Ordering::AcqRel);
                        let Ok(value)=serde_json::from_slice(&bytes) else { break; };
                        if current.gateway.receive(value,&handler,&event,&slots).is_err() { break; }
                    }
                }
            }
            current.stop();
            hub.disconnected(&id);
        });
        engine.start_http(http);
        engine.start_source(source);
        Ok(engine)
    }
    pub fn spawn(self: &Arc<Self>, future: impl std::future::Future<Output = ()> + Send + 'static) {
        struct Task(Arc<Engine>);
        impl Drop for Task {
            fn drop(&mut self) {
                self.0.tasks.fetch_sub(1, Ordering::AcqRel);
            }
        }
        self.tasks.fetch_add(1, Ordering::AcqRel);
        let guard = Task(self.clone());
        self.runtime.spawn(async move {
            let _guard = guard;
            future.await;
        });
    }
    pub fn stop(&self) {
        self.stopped.cancel();
        self.gateway.close();
        self.clients
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
        let exchanges = self
            .exchanges
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .filter_map(Weak::upgrade)
            .collect::<Vec<_>>();
        for exchange in exchanges {
            exchange.retire(false);
        }
    }
    // Call only after releasing the authority state lock: closing channels
    // releases their leases and notifies the Host through that same authority.
    pub fn retire_owner(&self, owner: &str) {
        let channels = self
            .channels
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .filter(|c| c.owner == owner)
            .cloned()
            .collect::<Vec<_>>();
        for channel in channels {
            channel.close(self);
        }
        self.clients
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|(key, _)| key.owner != owner);
    }
    fn event(&self, value: Value) {
        if value["event"] == "leaseClosed" {
            if let Some(id) = value["lease"].as_str() {
                let exchange = self
                    .leases
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(id)
                    .and_then(Weak::upgrade);
                if let Some(exchange) = exchange {
                    exchange.retire(true);
                }
            }
        } else if value["event"] == "changed" {
            if let Some(hub) = self.hub.upgrade() {
                let mut state = hub.state.lock().unwrap_or_else(|p| p.into_inner());
                state.change_queued = false;
                state.applied_revision = state.revision;
            }
            self.route_changed.notify_waiters();
            self.retire_removed_owners();
        }
    }
    pub fn exchange(
        self: &Arc<Self>,
        parent: &CancellationToken,
        permit: tokio::sync::OwnedSemaphorePermit,
        delegate: Option<(Arc<Rpc>, String)>,
        channel: Option<Arc<super::channels::Channel>>,
        web_socket: bool,
    ) -> Result<Arc<Exchange>> {
        let stopped = parent.child_token();
        let exchange = Arc::new(Exchange {
            id: files::token("native-exchange")?,
            engine: Arc::downgrade(self),
            streams: Arc::new(Streams::new(stopped.child_token())),
            stopped,
            leases: Mutex::new(BTreeMap::new()),
            delegate,
            channel,
            web_socket,
            outbound: tokio::sync::Mutex::new(Default::default()),
            ws_ready: tokio::sync::Notify::new(),
            finished: AtomicBool::new(false),
            notify: AtomicBool::new(true),
            _permit: permit,
        });
        let mut all = self.exchanges.lock().unwrap_or_else(|p| p.into_inner());
        all.retain(|_, v| v.strong_count() > 0);
        if all.len() >= 4096 {
            return Err(error("resource_limit", "exchange limit reached"));
        }
        all.insert(exchange.id.clone(), Arc::downgrade(&exchange));
        drop(all);
        let weak = Arc::downgrade(&exchange);
        let stopped = exchange.stopped.clone();
        self.spawn(async move {
            stopped.cancelled().await;
            if let Some(exchange) = weak.upgrade() {
                exchange.retire(true);
            }
        });
        Ok(exchange)
    }
    pub async fn data_request(self: &Arc<Self>, method: &str, params: Value) -> Result<Value> {
        let lease = string(&params, "lease")?;
        let exchange = self
            .leases
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(lease)
            .and_then(Weak::upgrade)
            .ok_or_else(|| error("stream_retired", "exchange retired"))?;
        exchange.check()?;
        let store = exchange
            .leases
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .find(|v| v.id == lease)
            .map(|v| v.streams.clone())
            .ok_or_else(|| error("stream_retired", "lease retired"))?;
        store.handle(method, &params["payload"]).await
    }
    pub fn headers_response(value: &Value, body: Body) -> Result<Response> {
        Ok(Response {
            status: status(&value["status"])?,
            headers: pairs(value.get("headers").unwrap_or(&json!([])))?,
            body,
            final_url: value
                .get("finalUrl")
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
    }
}
