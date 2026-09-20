//! Managed, independently authorized OS endpoints. This service owns a fixed
//! worker pool; an authorization is a non-serializable exact-generation token.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::plugins::{LoadedPlugin, LocalPluginRegistration, Permission, PluginRegistry};

mod filesystem;
mod network;
mod process;

pub const OS_BROKER_WORKERS: usize = 4;
pub const MAX_OS_QUEUE: usize = 8;
pub const MAX_OS_OPERATIONS: usize = 16;
pub const MAX_OS_BYTES: usize = 256 * 1024;
pub const DEFAULT_OS_BYTES: usize = 64 * 1024;
pub const MAX_OS_DEADLINE: Duration = Duration::from_secs(15);
const CHECK_INTERVAL: Duration = Duration::from_millis(10);
const MAX_AUTHORIZATION_IDENTITIES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{code}: {message}")]
pub struct OsBrokerError {
    pub code: &'static str,
    pub message: String,
}
impl OsBrokerError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
type Result<T> = std::result::Result<T, OsBrokerError>;

struct Shared {
    sender: mpsc::SyncSender<Work>,
    closing: AtomicBool,
    retained: AtomicUsize,
    registry_path: Option<PathBuf>,
    owners: Mutex<BTreeMap<String, (u64, Weak<Authorization>)>>,
}

struct Authorization {
    plugin_id: String,
    generation: u64,
    declared: Vec<Permission>,
    registration: LocalPluginRegistration,
    live: AtomicBool,
    change_reported: AtomicBool,
    shared: Weak<Shared>,
}

#[derive(Clone)]
pub struct OsAuthorization(Arc<Authorization>);
impl OsAuthorization {
    pub fn plugin_id(&self) -> &str {
        &self.0.plugin_id
    }
    pub fn generation(&self) -> u64 {
        self.0.generation
    }
    pub fn revoke(&self) {
        self.0.live.store(false, Ordering::Release);
    }
    pub fn matches_registration(&self, registration: &LocalPluginRegistration) -> bool {
        self.0.registration == *registration
    }
    pub fn is_current(&self) -> bool {
        self.check_current().is_ok()
    }
    /// Fast in-process retirement check for idle owner pumps. Actual request
    /// admission uses is_current/begin_request for a fresh full-record guard.
    pub fn is_live(&self) -> bool {
        self.0.live.load(Ordering::Acquire)
            && self
                .0
                .shared
                .upgrade()
                .is_some_and(|shared| !shared.closing.load(Ordering::Acquire))
    }

    /// This is eligibility for the owner's separate, bounded cleanup phase,
    /// never a way to revive ordinary requests using a revoked token.
    pub fn cleanup_permission_current(&self, permission: Permission) -> bool {
        if !self.0.declared.contains(&permission)
            || !self.0.registration.grants.contains(&permission)
        {
            return false;
        }
        let Some(shared) = self.0.shared.upgrade() else {
            return false;
        };
        if shared.closing.load(Ordering::Acquire) {
            return false;
        }
        let Some(path) = &shared.registry_path else {
            return true;
        };
        PluginRegistry::load(path)
            .ok()
            .and_then(|registry| registry.local_plugins().get(self.plugin_id()).cloned())
            .is_some_and(|registration| {
                registration.path == self.0.registration.path
                    && registration.grants.contains(&permission)
            })
    }

    fn check_current(&self) -> Result<()> {
        if !self.0.live.load(Ordering::Acquire) {
            return Err(revoked());
        }
        let shared = self.0.shared.upgrade().ok_or_else(stopped)?;
        if shared.closing.load(Ordering::Acquire) {
            self.revoke();
            return Err(stopped());
        }
        if let Some(path) = &shared.registry_path {
            let current = PluginRegistry::load(path).map_err(|error| {
                self.revoke();
                OsBrokerError::new(
                    "authorization_unavailable",
                    format!("cannot verify current registration: {error}"),
                )
            })?;
            if current.local_plugins().get(self.plugin_id()) != Some(&self.0.registration) {
                self.revoke();
                return Err(revoked());
            }
        }
        Ok(())
    }

    fn require(&self, permission: Permission) -> Result<()> {
        self.check_current()?;
        if !self.0.declared.contains(&permission)
            || !self.0.registration.grants.contains(&permission)
        {
            return Err(OsBrokerError::new(
                "permission_denied",
                format!(
                    "{} must be declared and explicitly granted before using this endpoint",
                    permission.as_str()
                ),
            ));
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct OsBrokerClient {
    shared: Arc<Shared>,
}

impl OsBrokerClient {
    pub fn authorize(&self, plugin: &LoadedPlugin) -> Result<OsAuthorization> {
        if self.shared.closing.load(Ordering::Acquire) {
            return Err(stopped());
        }
        if !crate::plugins::valid_plugin_id(&plugin.manifest.id)
            || !(1..=9_007_199_254_740_991).contains(&plugin.generation)
        {
            return Err(OsBrokerError::new(
                "invalid_owner",
                "OS authorization requires a valid logical ID and positive safe generation",
            ));
        }
        let host = plugin.host.as_ref().ok_or_else(|| {
            OsBrokerError::new(
                "invalid_owner",
                "OS authorization requires a loaded Host entry",
            )
        })?;
        let registration = host.authorization.clone().ok_or_else(|| {
            OsBrokerError::new(
                "permission_denied",
                "inspection alone does not supply a recorded Host authorization",
            )
        })?;
        if (registration.path != host.root
            && registration.path.canonicalize().ok().as_ref() != Some(&host.root))
            || plugin
                .manifest
                .permissions
                .iter()
                .any(|permission| !registration.grants.contains(permission))
        {
            return Err(OsBrokerError::new(
                "permission_denied",
                "loaded Host source does not match its explicit registration and grants",
            ));
        }
        registration
            .broker_policy
            .validate_grants(&registration.grants)
            .map_err(|error| OsBrokerError::new("invalid_policy", error.to_string()))?;
        let authorization = OsAuthorization(Arc::new(Authorization {
            plugin_id: plugin.manifest.id.clone(),
            generation: plugin.generation,
            declared: plugin.manifest.permissions.clone(),
            registration,
            live: AtomicBool::new(true),
            change_reported: AtomicBool::new(false),
            shared: Arc::downgrade(&self.shared),
        }));
        authorization.check_current()?;
        let mut owners = self
            .shared
            .owners
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some((generation, previous)) = owners.get(authorization.plugin_id()) {
            if *generation >= authorization.generation() {
                return Err(OsBrokerError::new(
                    "stale_generation",
                    "OS authorization never reuses a previously allocated owner generation",
                ));
            }
            if let Some(previous) = previous.upgrade() {
                previous.live.store(false, Ordering::Release);
            }
        } else if owners.len() >= MAX_AUTHORIZATION_IDENTITIES {
            return Err(OsBrokerError::new(
                "identity_limit",
                "OS authorization identity history is full",
            ));
        }
        owners.insert(
            authorization.plugin_id().into(),
            (authorization.generation(), Arc::downgrade(&authorization.0)),
        );
        Ok(authorization)
    }

    pub fn revoke_owner(&self, plugin_id: &str, generation: u64) -> bool {
        let owners = self
            .shared
            .owners
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some((current, authorization)) = owners.get(plugin_id)
            && *current == generation
            && let Some(authorization) = authorization.upgrade()
        {
            authorization.live.store(false, Ordering::Release);
            return true;
        }
        false
    }

    /// Report each changed complete record once even if a request already
    /// noticed and revoked it; the foreground can retire the same old owner.
    pub fn revoke_changed(&self, registry: &PluginRegistry) -> Vec<(String, u64)> {
        let owners = self
            .shared
            .owners
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        owners
            .iter()
            .filter_map(|(id, (generation, weak))| {
                let authorization = weak.upgrade()?;
                if registry.local_plugins().get(id) != Some(&authorization.registration) {
                    authorization.live.store(false, Ordering::Release);
                    if !authorization.change_reported.swap(true, Ordering::AcqRel) {
                        return Some((id.clone(), *generation));
                    }
                }
                None
            })
            .collect()
    }

    pub fn begin_request(
        &self,
        authorization: &OsAuthorization,
        endpoint: &str,
        params: Value,
        deadline: Instant,
    ) -> Result<OsBrokerOperation> {
        if !Weak::ptr_eq(&authorization.0.shared, &Arc::downgrade(&self.shared)) {
            return Err(OsBrokerError::new(
                "invalid_owner",
                "authorization belongs to another broker",
            ));
        }
        let permission = permission_for_endpoint(endpoint).ok_or_else(|| {
            OsBrokerError::new("method_not_found", "OS broker endpoint is not registered")
        })?;
        authorization.require(permission)?;
        let now = Instant::now();
        if deadline <= now {
            return Err(expired());
        }
        if deadline.saturating_duration_since(now) > MAX_OS_DEADLINE {
            return Err(OsBrokerError::new(
                "invalid_deadline",
                "OS request deadline may not exceed 15 seconds",
            ));
        }
        let bytes = serde_json::to_vec(&params).map_err(|error| invalid(error.to_string()))?;
        if bytes.len() > MAX_OS_BYTES {
            return Err(OsBrokerError::new(
                "request_too_large",
                "OS request exceeds its JSON byte limit",
            ));
        }
        self.shared
            .retained
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < MAX_OS_OPERATIONS).then_some(count + 1)
            })
            .map_err(|_| {
                OsBrokerError::new("broker_busy", "OS operation/result capacity is full")
            })?;
        let permit = Arc::new(Permit(Arc::downgrade(&self.shared)));
        let cancelled = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = mpsc::sync_channel(1);
        let guard = RequestGuard {
            authorization: authorization.clone(),
            cancelled: cancelled.clone(),
            deadline,
        };
        let work = Work {
            endpoint: endpoint.into(),
            params,
            guard: guard.clone(),
            sender,
            _permit: permit.clone(),
        };
        self.shared
            .sender
            .try_send(work)
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => {
                    OsBrokerError::new("broker_busy", "OS request queue is full")
                }
                mpsc::TrySendError::Disconnected(_) => stopped(),
            })?;
        Ok(OsBrokerOperation {
            receiver,
            guard,
            permit: Some(permit),
            delivered: false,
            terminal_cause: None,
        })
    }
}

pub fn permission_for_endpoint(endpoint: &str) -> Option<Permission> {
    match endpoint {
        "host.fs.readText" | "host.fs.readDir" | "host.fs.stat" => Some(Permission::HostFs),
        "host.network.fetch"
        | "host.network.authorizeChannel"
        | "host.network.authorizeForward" => Some(Permission::HostNetwork),
        "host.process.run" => Some(Permission::HostProcess),
        "host.system.info" => Some(Permission::HostSystem),
        _ => None,
    }
}

struct Permit(Weak<Shared>);
impl Drop for Permit {
    fn drop(&mut self) {
        if let Some(shared) = self.0.upgrade() {
            shared.retained.fetch_sub(1, Ordering::AcqRel);
        }
    }
}

pub struct OsBrokerOperation {
    receiver: mpsc::Receiver<Result<Value>>,
    guard: RequestGuard,
    permit: Option<Arc<Permit>>,
    delivered: bool,
    terminal_cause: Option<OsBrokerError>,
}
impl OsBrokerOperation {
    pub fn cancel(&self) {
        self.guard.cancelled.store(true, Ordering::Release);
    }
    pub fn try_result(&mut self) -> Option<Result<Value>> {
        if self.delivered {
            return None;
        }
        let authorization = self.guard.check();
        if let Err(error) = authorization {
            self.terminal_cause.get_or_insert(error);
            self.cancel();
        }
        // Cancellation is not proof that a child Job or IO handle retired. The
        // worker completes this channel only after its owned cleanup finishes.
        let result = match self.receiver.try_recv() {
            Ok(Err(error)) if error.code == "cleanup_incomplete" => Err(error),
            Ok(result) => {
                if let Some(error) = self.terminal_cause.take() {
                    Err(error)
                } else {
                    self.guard.authorization.check_current().and(result)
                }
            }
            Err(mpsc::TryRecvError::Empty) => return None,
            Err(mpsc::TryRecvError::Disconnected) => Err(OsBrokerError::new(
                "cleanup_incomplete",
                "OS worker stopped without confirming operation resource cleanup",
            )),
        };
        self.delivered = true;
        self.permit.take();
        Some(result)
    }
}
impl Drop for OsBrokerOperation {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[derive(Clone)]
struct RequestGuard {
    authorization: OsAuthorization,
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
}
impl RequestGuard {
    fn check(&self) -> Result<()> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(OsBrokerError::new(
                "cancelled",
                "OS operation was cancelled",
            ));
        }
        if Instant::now() >= self.deadline {
            return Err(expired());
        }
        if !self.authorization.0.live.load(Ordering::Acquire) {
            return Err(revoked());
        }
        if self
            .authorization
            .0
            .shared
            .upgrade()
            .is_none_or(|shared| shared.closing.load(Ordering::Acquire))
        {
            return Err(stopped());
        }
        Ok(())
    }
    fn check_full(&self) -> Result<()> {
        self.check()?;
        self.authorization.check_current()
    }
}
struct Work {
    endpoint: String,
    params: Value,
    guard: RequestGuard,
    sender: mpsc::SyncSender<Result<Value>>,
    _permit: Arc<Permit>,
}

pub struct OsBroker {
    shared: Arc<Shared>,
    workers: Vec<JoinHandle<()>>,
}
impl OsBroker {
    pub fn new() -> Result<Self> {
        Self::build(None)
    }
    pub fn for_registry(registry_path: PathBuf) -> Result<Self> {
        Self::build(Some(registry_path))
    }
    fn build(registry_path: Option<PathBuf>) -> Result<Self> {
        let (sender, receiver) = mpsc::sync_channel::<Work>(MAX_OS_QUEUE);
        let receiver = Arc::new(Mutex::new(receiver));
        let shared = Arc::new(Shared {
            sender,
            closing: AtomicBool::new(false),
            retained: AtomicUsize::new(0),
            registry_path,
            owners: Mutex::new(BTreeMap::new()),
        });
        let mut broker = Self {
            shared,
            workers: Vec::new(),
        };
        for index in 0..OS_BROKER_WORKERS {
            let state = broker.shared.clone();
            let receiver = receiver.clone();
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .max_blocking_threads(1)
                .thread_name("codlet-os-dns")
                .build()
                .map_err(|error| OsBrokerError::new("broker_start_failed", error.to_string()))?;
            let client = reqwest::Client::builder()
                .hickory_dns(true)
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .connect_timeout(Duration::from_secs(3))
                .timeout(MAX_OS_DEADLINE)
                .pool_max_idle_per_host(0)
                .build()
                .map_err(|error| OsBrokerError::new("broker_start_failed", error.to_string()))?;
            let worker = thread::Builder::new()
                .name(format!("codlet-os-{index}"))
                .spawn(move || {
                    while !state.closing.load(Ordering::Acquire) {
                        let next = receiver
                            .lock()
                            .unwrap_or_else(|poison| poison.into_inner())
                            .recv_timeout(CHECK_INTERVAL);
                        let work = match next {
                            Ok(work) => work,
                            Err(mpsc::RecvTimeoutError::Timeout) => continue,
                            Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        };
                        let result = work
                            .guard
                            .check_full()
                            .and_then(|()| match work.endpoint.as_str() {
                                "host.fs.readText" | "host.fs.readDir" | "host.fs.stat" => {
                                    filesystem::execute(&work.endpoint, work.params, &work.guard)
                                }
                                "host.network.fetch" => runtime.block_on(network::fetch(
                                    &client,
                                    work.params,
                                    &work.guard,
                                )),
                                "host.network.authorizeChannel" => {
                                    network::authorize_channel(work.params, &work.guard)
                                }
                                "host.network.authorizeForward" => {
                                    network::authorize_forward(work.params, &work.guard)
                                }
                                "host.process.run" => process::run(work.params, &work.guard),
                                "host.system.info" => system_info(work.params),
                                _ => Err(OsBrokerError::new(
                                    "method_not_found",
                                    "OS endpoint is unavailable",
                                )),
                            })
                            .and_then(|value| {
                                work.guard.check_full()?;
                                if serde_json::to_vec(&value)
                                    .map_err(|error| invalid(error.to_string()))?
                                    .len()
                                    > MAX_OS_BYTES
                                {
                                    return Err(OsBrokerError::new(
                                        "response_too_large",
                                        "OS result exceeds its serialized JSON limit",
                                    ));
                                }
                                Ok(value)
                            });
                        let _ = work.sender.try_send(result);
                    }
                    // Queued requests never acquired OS resources. Confirm their
                    // retirement explicitly instead of abandoning result channels.
                    while let Ok(work) = receiver
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner())
                        .try_recv()
                    {
                        let _ = work.sender.try_send(Err(stopped()));
                    }
                    drop(client);
                    runtime.shutdown_timeout(Duration::from_millis(100));
                })
                .map_err(|error| OsBrokerError::new("broker_start_failed", error.to_string()))?;
            broker.workers.push(worker);
        }
        Ok(broker)
    }
    pub fn client(&self) -> OsBrokerClient {
        OsBrokerClient {
            shared: self.shared.clone(),
        }
    }
    pub fn stop(&mut self) -> Result<()> {
        self.shared.closing.store(true, Ordering::Release);
        for (_, weak) in self
            .shared
            .owners
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .values()
        {
            if let Some(owner) = weak.upgrade() {
                owner.live.store(false, Ordering::Release);
            }
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while self.workers.iter().any(|worker| !worker.is_finished()) && Instant::now() < deadline {
            thread::sleep(CHECK_INTERVAL);
        }
        if self.workers.iter().any(|worker| !worker.is_finished()) {
            return Err(OsBrokerError::new(
                "broker_stop_timeout",
                "OS worker retirement was not confirmed within its bound",
            ));
        }
        for worker in self.workers.drain(..) {
            worker
                .join()
                .map_err(|_| OsBrokerError::new("broker_worker_failed", "an OS worker panicked"))?;
        }
        Ok(())
    }
}
impl Drop for OsBroker {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn system_info(params: Value) -> Result<Value> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Empty {}
    let _: Empty = decode(params)?;
    Ok(
        serde_json::json!({"os":std::env::consts::OS,"architecture":std::env::consts::ARCH,"logicalCpus":thread::available_parallelism().map(|count| count.get().min(4096)).unwrap_or(1)}),
    )
}
fn decode<T: DeserializeOwned>(params: Value) -> Result<T> {
    serde_json::from_value(params).map_err(|error| invalid(error.to_string()))
}
fn byte_limit(value: Option<usize>) -> Result<usize> {
    let value = value.unwrap_or(DEFAULT_OS_BYTES);
    if value == 0 || value > MAX_OS_BYTES {
        return Err(invalid(
            "maxBytes/maxOutputBytes must be between 1 and 262144",
        ));
    }
    Ok(value)
}
fn invalid(message: impl Into<String>) -> OsBrokerError {
    OsBrokerError::new("invalid_params", message)
}
fn revoked() -> OsBrokerError {
    OsBrokerError::new(
        "permission_revoked",
        "this exact-generation authorization is no longer current",
    )
}
fn expired() -> OsBrokerError {
    OsBrokerError::new("deadline_exceeded", "OS operation deadline expired")
}
fn stopped() -> OsBrokerError {
    OsBrokerError::new("broker_stopped", "OS broker is stopping or unavailable")
}
