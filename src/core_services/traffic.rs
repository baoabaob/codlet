//! Process traffic authority and the bounded, separate Host data plane.
//! No credential, URL query, header, body, or frame enters service diagnostics.
use super::*;
use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::thread::JoinHandle;
use tokio::sync::{mpsc as async_mpsc, watch};

#[cfg(test)]
mod tests;
mod wire;

const MAX_REGISTRATIONS: usize = 32;
const MAX_LEASES: usize = 128;
const MAX_PENDING: usize = 512;
const MAX_FRAME: usize = 64 * 1024;
const QUEUED_FRAMES: usize = 512;
const QUEUED_BYTES: usize = 512 * 1024;
type Check = Arc<dyn Fn(&str, &str) -> Result<bool> + Send + Sync>;

#[derive(Clone)]
pub(crate) struct Traffic {
    hub: Arc<Hub>,
    _lifetime: Arc<Lifetime>,
}
struct Lifetime {
    stop: watch::Sender<bool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}
impl Drop for Lifetime {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
        if let Some(worker) = self.worker.lock().unwrap_or_else(|p| p.into_inner()).take()
            && worker.thread().id() != std::thread::current().id()
        {
            let _ = worker.join();
        }
    }
}
struct Hub {
    address: SocketAddr,
    state: Mutex<State>,
    resolvers: Arc<tokio::sync::Semaphore>,
}
#[derive(Default)]
struct State {
    tickets: BTreeMap<String, Ticket>,
    peers: BTreeMap<String, Peer>,
    registrations: BTreeMap<String, Arc<Registration>>,
    leases: BTreeMap<String, Lease>,
    pending: BTreeMap<String, Pending>,
    sequence: u64,
    revision: u64,
    applied_revision: u64,
    order: u64,
    change_queued: bool,
    ready: bool,
    attached: bool,
    activated_sources: Vec<Value>,
    unsupported_sources: Vec<Value>,
    launch: Option<Value>,
    peak_pending: usize,
}
#[derive(Clone, PartialEq, Eq)]
enum Role {
    Gateway,
    Host(String),
}
struct Ticket {
    role: Role,
    expires: Instant,
}
struct Peer {
    role: Role,
    sender: async_mpsc::Sender<Vec<u8>>,
    stop: watch::Sender<bool>,
    queued_bytes: Arc<AtomicUsize>,
}
struct Registration {
    key: String,
    owner: String,
    plugin_id: String,
    generation: u64,
    options: Value,
    check: Check,
    active: AtomicBool,
    order: u64,
}
#[derive(Clone)]
struct Lease {
    registration: Arc<Registration>,
    opening_request: Value,
    url: String,
    expires: Instant,
}
struct Pending {
    source: String,
    destination: String,
    id: Value,
    lease: String,
    expires: Instant,
}

impl Traffic {
    pub(crate) fn bind() -> Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .map_err(|_| error("traffic_unavailable", "cannot bind the traffic data plane"))?;
        listener.set_nonblocking(true).map_err(|_| {
            error(
                "traffic_unavailable",
                "cannot configure the traffic data plane",
            )
        })?;
        let address = listener
            .local_addr()
            .map_err(|_| error("traffic_unavailable", "traffic address unavailable"))?;
        let hub = Arc::new(Hub {
            address,
            state: Mutex::new(State::default()),
            resolvers: Arc::new(tokio::sync::Semaphore::new(4)),
        });
        let (stop, stopped) = watch::channel(false);
        let weak = Arc::downgrade(&hub);
        let worker = std::thread::Builder::new()
            .name("codlet-traffic-data".into())
            .spawn(move || wire::serve(listener, weak, stopped))
            .map_err(|_| error("traffic_unavailable", "cannot start the traffic data plane"))?;
        Ok(Self {
            hub,
            _lifetime: Arc::new(Lifetime {
                stop,
                worker: Mutex::new(Some(worker)),
            }),
        })
    }

    /// Only the Native launch owner gets this ticket. It is never an RPC result.
    pub(crate) fn gateway_endpoint(&self) -> Result<Value> {
        self.endpoint(Role::Gateway)
    }

    fn endpoint(&self, role: Role) -> Result<Value> {
        let max_pending = if role == Role::Gateway { 256 } else { 64 };
        let token = files::token("traffic-peer")?;
        let mut state = self.hub.state.lock().unwrap_or_else(|p| p.into_inner());
        state
            .tickets
            .retain(|_, ticket| ticket.expires > Instant::now());
        if state.tickets.len() >= 64 {
            return Err(error("resource_limit", "traffic ticket limit reached"));
        }
        // A new ticket supersedes unclaimed tickets for this exact generation.
        state.tickets.retain(|_, ticket| ticket.role != role);
        state.tickets.insert(
            token.clone(),
            Ticket {
                role,
                expires: Instant::now() + Duration::from_secs(30),
            },
        );
        Ok(
            json!({"host":"127.0.0.1","port":self.hub.address.port(),"token":token,"maxFrameBytes":MAX_FRAME,"queuedFrames":QUEUED_FRAMES,"maxQueuedBytes":QUEUED_BYTES,"maxPendingRequests":max_pending}),
        )
    }

    pub(crate) fn set_attached(&self, attached: bool) {
        let mut state = self.hub.state.lock().unwrap_or_else(|p| p.into_inner());
        state.attached = attached;
        if !attached {
            state.activated_sources.clear();
            state.unsupported_sources.clear();
        }
        self.hub.changed(&mut state);
    }

    pub(crate) fn set_source_activation(&self, activated: Value, unsupported: Value) {
        let mut state = self.hub.state.lock().unwrap_or_else(|p| p.into_inner());
        state.activated_sources = activated.as_array().cloned().unwrap_or_default();
        state.unsupported_sources = unsupported.as_array().cloned().unwrap_or_default();
        state.attached = !state.activated_sources.is_empty();
        self.hub.changed(&mut state);
    }

    pub(crate) fn launch_descriptor(&self) -> Option<Value> {
        self.hub
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .launch
            .clone()
    }

    pub(super) fn invoke(
        &self,
        p: &Principal,
        method: &str,
        params: Value,
        check: Check,
    ) -> Result<Value> {
        let owner = owner_key(p);
        match method {
            "connect" => self.endpoint(Role::Host(owner)),
            "register" => {
                let object = params
                    .as_object()
                    .ok_or_else(|| error("invalid_params", "traffic options required"))?;
                if serde_json::to_vec(&params).map_or(true, |v| v.len() > 1024) {
                    return Err(error(
                        "invalid_params",
                        "traffic registration metadata exceeds 1024 bytes",
                    ));
                }
                if object.keys().any(|key| {
                    !["id", "origins", "priority", "timeoutMs", "handlers"].contains(&key.as_str())
                }) {
                    return Err(error(
                        "invalid_params",
                        "unknown traffic registration field",
                    ));
                }
                let id = string(&params, "id")?;
                if id.is_empty()
                    || id.len() > 128
                    || !id
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
                {
                    return Err(error("invalid_params", "invalid interceptor id"));
                }
                let origins = params["origins"]
                    .as_array()
                    .filter(|v| !v.is_empty() && v.len() <= 64)
                    .ok_or_else(|| error("invalid_params", "one to 64 exact origins required"))?;
                for value in origins {
                    let value = value
                        .as_str()
                        .ok_or_else(|| error("invalid_params", "invalid traffic origin"))?;
                    let url = url::Url::parse(value)
                        .map_err(|_| error("invalid_params", "invalid traffic origin"))?;
                    if !matches!(url.scheme(), "http" | "https")
                        || url.as_str() != format!("{}/", url.origin().ascii_serialization())
                        || !url.username().is_empty()
                        || url.password().is_some()
                    {
                        return Err(error(
                            "invalid_params",
                            "traffic scopes must be exact HTTP(S) origins",
                        ));
                    }
                    if !check("intercept", url.as_str())? {
                        return Err(error("permission_denied", "traffic origin is not granted"));
                    }
                }
                let priority = params.get("priority").and_then(Value::as_i64).unwrap_or(0);
                let timeout = params
                    .get("timeoutMs")
                    .and_then(Value::as_u64)
                    .unwrap_or(1000);
                if params.get("priority").is_some_and(|v| v.as_i64().is_none())
                    || params
                        .get("timeoutMs")
                        .is_some_and(|v| v.as_u64().is_none())
                {
                    return Err(error("invalid_params", "traffic budgets must be integers"));
                }
                if !(-1000..=1000).contains(&priority) || !(1..=2000).contains(&timeout) {
                    return Err(error("invalid_params", "invalid interceptor budget"));
                }
                let handlers = params["handlers"]
                    .as_array()
                    .filter(|v| !v.is_empty() && v.len() <= 3)
                    .ok_or_else(|| error("invalid_params", "interceptor handlers required"))?;
                if handlers
                    .iter()
                    .any(|v| !matches!(v.as_str(), Some("request" | "response" | "webSocket")))
                {
                    return Err(error("invalid_params", "unsupported interceptor handler"));
                }
                let mut state = self.hub.state.lock().unwrap_or_else(|p| p.into_inner());
                if !state.ready {
                    return Err(error(
                        "traffic_unavailable",
                        "the Native traffic entrance is not ready",
                    ));
                }
                if state.registrations.len() >= MAX_REGISTRATIONS {
                    return Err(error("resource_limit", "interceptor limit reached"));
                }
                if state
                    .registrations
                    .values()
                    .filter(|r| r.owner == owner)
                    .count()
                    >= 8
                {
                    return Err(error("resource_limit", "owner interceptor limit reached"));
                }
                if state
                    .registrations
                    .values()
                    .any(|r| r.owner == owner && r.options["id"] == id)
                {
                    return Err(error(
                        "duplicate_interceptor",
                        "interceptor id already registered",
                    ));
                }
                let key = files::token("interceptor")?;
                state.order = state
                    .order
                    .checked_add(1)
                    .filter(|n| *n <= 9_007_199_254_740_991)
                    .ok_or_else(|| error("resource_limit", "registration order exhausted"))?;
                let order = state.order;
                let options = json!({"id":id,"origins":origins,"priority":priority,"timeoutMs":timeout,"handlers":handlers});
                state.registrations.insert(
                    key.clone(),
                    Arc::new(Registration {
                        key: key.clone(),
                        owner,
                        plugin_id: p.owner.plugin_id.clone(),
                        generation: p.plugin.generation,
                        options,
                        check,
                        active: AtomicBool::new(false),
                        order,
                    }),
                );
                Ok(
                    json!({"registration":key,"state":"pending_activation","revision":state.revision}),
                )
            }
            "unregister" => {
                let key = string(&params, "registration")?;
                let mut state = self.hub.state.lock().unwrap_or_else(|p| p.into_inner());
                if state
                    .registrations
                    .get(key)
                    .is_some_and(|r| r.owner != owner)
                {
                    return Err(error(
                        "permission_denied",
                        "registration belongs to another owner",
                    ));
                }
                self.hub.remove_registration(&mut state, key);
                self.hub.changed(&mut state);
                Ok(json!({"closed":true}))
            }
            "status" => {
                let state = self.hub.state.lock().unwrap_or_else(|p| p.into_inner());
                Ok(
                    json!({"available":state.ready && state.attached,"listening":state.ready,"attached":state.attached,"activatedSources":state.activated_sources,"unsupportedSources":state.unsupported_sources,"registered":state.registrations.values().filter(|r|r.owner==owner).count(),"active":state.leases.values().filter(|l|l.registration.owner==owner).count(),"pending":state.pending.values().filter(|call|state.leases.get(&call.lease).is_some_and(|l|l.registration.owner==owner)).count()}),
                )
            }
            _ => Err(error(
                "method_not_found",
                "unknown traffic management method",
            )),
        }
    }

    pub(super) fn retire(&self, owner: &str) {
        let mut state = self.hub.state.lock().unwrap_or_else(|p| p.into_inner());
        let keys = state
            .registrations
            .values()
            .filter(|r| r.owner == owner)
            .map(|r| r.key.clone())
            .collect::<Vec<_>>();
        for key in keys {
            self.hub.remove_registration(&mut state, &key);
        }
        state
            .tickets
            .retain(|_, ticket| ticket.role != Role::Host(owner.to_owned()));
        for peer in state
            .peers
            .values()
            .filter(|peer| peer.role == Role::Host(owner.to_owned()))
        {
            let _ = peer.stop.send(true);
        }
        self.hub.changed(&mut state);
    }

    pub(super) fn revoke_ticket(&self, owner: &str, token: &str) {
        let mut state = self.hub.state.lock().unwrap_or_else(|p| p.into_inner());
        if state
            .tickets
            .get(token)
            .is_some_and(|t| t.role == Role::Host(owner.to_owned()))
        {
            state.tickets.remove(token);
        }
    }

    #[cfg(test)]
    pub(crate) fn resources(&self) -> Value {
        let state = self.hub.state.lock().unwrap_or_else(|p| p.into_inner());
        json!({"peers":state.peers.len(),"tickets":state.tickets.len(),"registrations":state.registrations.len(),"leases":state.leases.len(),"pending":state.pending.len(),"peakPending":state.peak_pending,"queuedBytes":state.peers.values().map(|p|p.queued_bytes.load(Ordering::Acquire)).sum::<usize>(),"maxQueuedBytesPerPeer":QUEUED_BYTES})
    }
}

impl Registration {
    fn matches(&self, value: &str) -> bool {
        let Ok(mut target) = url::Url::parse(value) else {
            return false;
        };
        if target.scheme() == "ws" {
            let _ = target.set_scheme("http");
        } else if target.scheme() == "wss" {
            let _ = target.set_scheme("https");
        }
        self.options["origins"].as_array().is_some_and(|origins| {
            origins.iter().any(|value| {
                value
                    .as_str()
                    .and_then(|v| url::Url::parse(v).ok())
                    .is_some_and(|origin| origin.origin() == target.origin())
            })
        })
    }
}

impl Hub {
    fn send(&self, state: &State, peer: &str, value: Value) -> Result<()> {
        let data = serde_json::to_vec(&value)
            .map_err(|_| error("invalid_frame", "invalid traffic frame"))?;
        if data.len() > MAX_FRAME {
            return Err(error("frame_too_large", "traffic frame exceeds its bound"));
        }
        let peer = state
            .peers
            .get(peer)
            .ok_or_else(|| error("peer_closed", "traffic peer retired"))?;
        let bytes = data.len();
        peer.queued_bytes
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                n.checked_add(bytes).filter(|n| *n <= QUEUED_BYTES)
            })
            .map_err(|_| {
                let _ = peer.stop.send(true);
                error(
                    "traffic_backpressure",
                    "traffic peer byte queue exceeded its bound",
                )
            })?;
        if peer.sender.try_send(data).is_err() {
            peer.queued_bytes.fetch_sub(bytes, Ordering::AcqRel);
            let _ = peer.stop.send(true);
            return Err(error(
                "traffic_backpressure",
                "traffic peer queue exceeded its bound",
            ));
        }
        Ok(())
    }
    fn changed(&self, state: &mut State) {
        state.revision = state.revision.saturating_add(1);
        if state.change_queued {
            return;
        }
        state.change_queued = true;
        for (key, peer) in &state.peers {
            if peer.role == Role::Gateway {
                let _ = self.send(
                    state,
                    key,
                    json!({"event":"changed","revision":state.revision}),
                );
            }
        }
    }
    fn remove_registration(&self, state: &mut State, key: &str) {
        state.registrations.remove(key);
        let leases = state
            .leases
            .iter()
            .filter(|(_, l)| l.registration.key == key)
            .map(|(k, _)| k.clone())
            .collect::<Vec<_>>();
        for lease in leases {
            self.release(state, &lease);
        }
    }
    fn release(&self, state: &mut State, key: &str) {
        let Some(lease) = state.leases.remove(key) else {
            return;
        };
        let calls = state
            .pending
            .iter()
            .filter(|(_, p)| p.lease == key)
            .map(|(k, _)| k.clone())
            .collect::<Vec<_>>();
        for call in calls {
            if let Some(call) = state.pending.remove(&call) {
                let _ = self.send(
                    state,
                    &call.source,
                    json!({"id":call.id,"error":{"code":"stream_retired"}}),
                );
            }
        }
        for (peer_id, peer) in &state.peers {
            if peer.role == Role::Gateway
                || peer.role == Role::Host(lease.registration.owner.clone())
            {
                let _ = self.send(state, peer_id, json!({"event":"leaseClosed","lease":key}));
            }
        }
    }
    fn disconnected(&self, peer: &str) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let Some(peer) = state.peers.remove(peer) else {
            return;
        };
        let keys = match peer.role {
            Role::Gateway => {
                state.ready = false;
                state.attached = false;
                state.activated_sources.clear();
                state.unsupported_sources.clear();
                state.launch = None;
                state.registrations.keys().cloned().collect::<Vec<_>>()
            }
            Role::Host(owner) => state
                .registrations
                .values()
                .filter(|r| r.owner == owner)
                .map(|r| r.key.clone())
                .collect(),
        };
        for key in keys {
            self.remove_registration(&mut state, &key);
        }
        self.changed(&mut state);
    }
}
