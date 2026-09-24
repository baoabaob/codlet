//! One authenticated service instance shared by renderer and Host entries.
//! Slow OS work runs on a bounded pool, never on the CDP/coordinator owner.

use crate::core_resources::{CoreResources, ResourceOwner};
use crate::plugin_services::{PluginServices, ServiceError, ServiceOwner};
use crate::plugins::{LoadedPlugin, Permission, PluginRegistry};
use serde_json::{Value, json};
use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex, Weak,
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

mod desktop;
mod files;
mod network;
pub(crate) mod traffic;

pub const CAPABILITY: &str = "codlet.core.services";
#[cfg(target_os = "macos")]
pub(crate) fn pump_platform_events() {
    desktop::macos_hotkeys::pump();
}
type Result<T> = std::result::Result<T, ServiceError>;
type DocumentKey = (String, String, u64);
type DocumentRunners = (u64, Vec<(&'static str, String)>);

pub(crate) struct ServiceCaller<'a> {
    pub id: &'a str,
    pub generation: u64,
    pub host: bool,
    pub document: Option<String>,
}

#[derive(Clone)]
pub struct SharedCoreServices(Arc<Shared>);
struct Shared {
    registry: PathBuf,
    persistent: PluginServices,
    resources: CoreResources,
    files: files::Files,
    desktop: desktop::Desktop,
    network: network::Network,
    owners: Mutex<BTreeMap<String, Principal>>,
    retired: Mutex<BTreeMap<String, u64>>,
    documents: Mutex<BTreeMap<DocumentKey, DocumentRunners>>,
    log: Mutex<(u64, VecDeque<Value>)>,
    traffic: Mutex<BTreeMap<String, Value>>,
    entrance: Mutex<Option<traffic::Traffic>>,
    sender: mpsc::SyncSender<Work>,
    pending: AtomicUsize,
}

#[derive(Clone)]
pub(crate) struct Principal {
    pub plugin: LoadedPlugin,
    pub owner: ServiceOwner,
    pub resources: ResourceOwner,
}
struct Work {
    principal: Principal,
    method: String,
    params: Value,
    host: bool,
    document: Option<(String, u64)>,
    deadline: Instant,
    cancelled: Arc<AtomicBool>,
    sender: mpsc::SyncSender<Result<Value>>,
    waker: crate::cdp::CdpClient,
}
pub struct ServiceOperation {
    receiver: mpsc::Receiver<Result<Value>>,
    cancelled: Arc<AtomicBool>,
    delivered: bool,
}
impl ServiceOperation {
    pub fn try_result(&mut self) -> Option<Result<Value>> {
        if self.delivered {
            return None;
        }
        let value = match self.receiver.try_recv() {
            Ok(value) => value,
            Err(mpsc::TryRecvError::Empty) => return None,
            Err(mpsc::TryRecvError::Disconnected) => {
                Err(error("runtime_stopped", "the Core service worker stopped"))
            }
        };
        self.delivered = true;
        Some(value)
    }
}
impl Drop for ServiceOperation {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
    }
}

impl SharedCoreServices {
    pub fn new(registry: &Path) -> Result<Self> {
        let persistent = PluginServices::new(registry)?;
        let (sender, receiver) = mpsc::sync_channel::<Work>(16);
        let shared = Arc::new(Shared {
            registry: registry.to_owned(),
            persistent,
            resources: CoreResources::default(),
            files: files::Files::default(),
            desktop: desktop::Desktop::default(),
            network: network::Network::default(),
            owners: Mutex::new(BTreeMap::new()),
            retired: Mutex::new(BTreeMap::new()),
            documents: Mutex::new(BTreeMap::new()),
            log: Mutex::new((0, VecDeque::new())),
            traffic: Mutex::new(BTreeMap::new()),
            entrance: Mutex::new(None),
            sender,
            pending: AtomicUsize::new(0),
        });
        let receiver = Arc::new(Mutex::new(receiver));
        for index in 0..4 {
            let weak = Arc::downgrade(&shared);
            let receiver = receiver.clone();
            std::thread::Builder::new()
                .name(format!("codlet-services-{index}"))
                .spawn(move || {
                    loop {
                        let received = receiver
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .recv_timeout(Duration::from_millis(250));
                        match received {
                            Ok(work) => {
                                let Some(shared) = weak.upgrade() else {
                                    break;
                                };
                                let service = SharedCoreServices(shared);
                                let result = service.execute(&work);
                                service.record(
                                    &work.principal,
                                    &work.method,
                                    result.as_ref().err().map(|e| e.code),
                                );
                                let _ = work.sender.try_send(result);
                                service.0.pending.fetch_sub(1, Ordering::AcqRel);
                                work.waker.notify_runtime_activity();
                            }
                            Err(mpsc::RecvTimeoutError::Disconnected) => break,
                            Err(mpsc::RecvTimeoutError::Timeout) if weak.strong_count() == 0 => {
                                break;
                            }
                            Err(mpsc::RecvTimeoutError::Timeout) => {}
                        }
                    }
                })
                .map_err(|_| error("worker_unavailable", "cannot start a Core service worker"))?;
        }
        let weak = Arc::downgrade(&shared);
        std::thread::Builder::new()
            .name("codlet-service-lifetimes".into())
            .spawn(move || monitor(weak))
            .map_err(|_| {
                error(
                    "worker_unavailable",
                    "cannot start the Core resource monitor",
                )
            })?;
        Ok(Self(shared))
    }

    pub fn register(&self, plugins: &[LoadedPlugin]) -> Result<()> {
        let registry = PluginRegistry::load(&self.0.registry)
            .map_err(|_| error("registry_error", "cannot read the plugin registry"))?;
        for plugin in plugins {
            if self
                .0
                .retired
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(&plugin.manifest.id)
                .is_some_and(|generation| plugin.generation <= *generation)
            {
                return Err(error(
                    "stale_generation",
                    "the plugin generation has retired",
                ));
            }
            let id = plugin.manifest.id.clone();
            let source_identity = if let Some(current) = registry
                .managed_plugins()
                .get(&id)
                .and_then(|record| record.current())
            {
                format!(
                    "github:{}/{}",
                    current.source.owner.to_ascii_lowercase(),
                    current.source.repository.to_ascii_lowercase()
                )
            } else if let Some(auth) = &plugin.authorization {
                format!("local:{}", auth.path.display())
            } else {
                format!("bundled:{id}")
            };
            let policy = plugin
                .authorization
                .as_ref()
                .map(|auth| auth.broker_policy.clone())
                .unwrap_or_default();
            let default_cwd = plugin
                .authorization
                .as_ref()
                .map(|auth| auth.path.clone())
                .unwrap_or_else(|| self.0.registry.parent().unwrap().to_owned());
            let principal = Principal {
                owner: ServiceOwner {
                    plugin_id: id.clone(),
                    source_identity: source_identity.clone(),
                },
                resources: ResourceOwner {
                    plugin_id: id.clone(),
                    source_identity,
                    generation: plugin.generation,
                    default_cwd,
                    executables: policy.executables,
                    cwd_roots: policy.cwd_roots,
                    env_keys: policy.env_keys,
                },
                plugin: plugin.clone(),
            };
            let old = self
                .0
                .owners
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(id, principal.clone());
            if let Some(old) = old
                && (old.plugin.generation != plugin.generation || old.owner != principal.owner)
            {
                self.retire_resources(&old);
            }
        }
        Ok(())
    }

    pub fn retire(&self, id: &str, generation: u64) {
        self.0
            .retired
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(id.into())
            .and_modify(|n| *n = (*n).max(generation))
            .or_insert(generation);
        let old = {
            let mut owners = self.0.owners.lock().unwrap_or_else(|p| p.into_inner());
            if owners
                .get(id)
                .is_some_and(|p| p.plugin.generation <= generation)
            {
                owners.remove(id)
            } else {
                None
            }
        };
        if let Some(old) = old {
            self.retire_resources(&old);
        }
    }
    fn retire_resources(&self, principal: &Principal) {
        if let Some(traffic) = self
            .0
            .entrance
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
        {
            traffic.retire(&owner_key(principal));
        }
        let _ = self.0.resources.retire(&principal.resources);
        self.0.files.retire(principal);
        self.0.desktop.retire(principal);
        self.0.network.retire(principal);
        self.0
            .traffic
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&owner_key(principal));
        self.0
            .documents
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|(_, id, generation), _| {
                id != &principal.owner.plugin_id || generation != &principal.plugin.generation
            });
    }

    pub fn retire_document(&self, target: &str, plugin_id: Option<&str>) {
        let mut retired = Vec::new();
        for ((document, id, generation), (epoch, runners)) in self
            .0
            .documents
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter_mut()
        {
            if document == target && plugin_id.is_none_or(|filter| filter == id) {
                *epoch += 1;
                retired.push((id.clone(), *generation, std::mem::take(runners)));
            }
        }
        for (id, generation, runners) in retired {
            let principal = self
                .0
                .owners
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(&id)
                .filter(|p| p.plugin.generation == generation)
                .cloned();
            if let Some(principal) = principal {
                for (kind, id) in runners {
                    if kind == "runner" {
                        let _ = self.0.resources.invoke(
                            &principal.resources,
                            "tasks.unregister",
                            json!({"runner":id}),
                        );
                    } else {
                        let _ = self.0.files.invoke(
                            &principal,
                            "cancelDialog",
                            json!({"dialog":id}),
                            &|| Ok(()),
                        );
                    }
                }
            }
        }
    }

    pub(crate) fn begin(
        &self,
        caller: ServiceCaller<'_>,
        method: &str,
        params: Value,
        deadline: Instant,
        waker: crate::cdp::CdpClient,
    ) -> Result<ServiceOperation> {
        let ServiceCaller {
            id,
            generation,
            host,
            document,
        } = caller;
        #[cfg(target_os = "macos")]
        desktop::macos_hotkeys::set_waker(waker.clone());
        if serde_json::to_vec(&params).map_or(true, |value| value.len() > 512 * 1024) {
            return Err(error(
                "request_too_large",
                "Core service input exceeds 512 KiB",
            ));
        }
        let principal = self
            .0
            .owners
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
            .filter(|p| p.plugin.generation == generation)
            .cloned()
            .ok_or_else(|| {
                error(
                    "stale_generation",
                    "the plugin service owner is not registered",
                )
            })?;
        self.check(&principal, method, host, &params)?;
        let document = if let Some(target) = document {
            let mut documents = self.0.documents.lock().unwrap_or_else(|p| p.into_inner());
            let key = (target.clone(), id.to_owned(), generation);
            if documents.len() >= 2048 && !documents.contains_key(&key) {
                return Err(error(
                    "resource_limit",
                    "renderer service document limit reached",
                ));
            }
            let epoch = documents.entry(key).or_default().0;
            Some((target, epoch))
        } else {
            None
        };
        self.0
            .pending
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < 32).then_some(n + 1)
            })
            .map_err(|_| error("resource_limit", "Core service request limit reached"))?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = mpsc::sync_channel(1);
        if self
            .0
            .sender
            .try_send(Work {
                principal,
                method: method.into(),
                params,
                host,
                document,
                deadline,
                cancelled: cancelled.clone(),
                sender,
                waker,
            })
            .is_err()
        {
            self.0.pending.fetch_sub(1, Ordering::AcqRel);
            return Err(error("resource_limit", "Core service worker queue is full"));
        }
        Ok(ServiceOperation {
            receiver,
            cancelled,
            delivered: false,
        })
    }

    fn current(&self, principal: &Principal) -> Result<()> {
        self.current_checked(principal, false)
    }
    fn current_checked(&self, principal: &Principal, require_active: bool) -> Result<()> {
        if !self
            .0
            .owners
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&principal.owner.plugin_id)
            .is_some_and(|current| {
                current.plugin.generation == principal.plugin.generation
                    && current.owner == principal.owner
            })
        {
            return Err(error(
                "stale_generation",
                "the plugin service owner retired",
            ));
        }
        if let Some(expected) = &principal.plugin.authorization {
            let registry = PluginRegistry::load(&self.0.registry)
                .map_err(|_| error("registry_error", "cannot verify plugin authorization"))?;
            if registry.local_plugins().get(&principal.owner.plugin_id) != Some(expected) {
                self.retire(&principal.owner.plugin_id, principal.plugin.generation);
                return Err(error(
                    "authorization_revoked",
                    "the plugin's complete trust record changed",
                ));
            }
            if require_active && !registry.is_enabled(&principal.owner.plugin_id) {
                self.retire_host_traffic(&principal.owner.plugin_id, principal.plugin.generation);
                return Err(error(
                    "authorization_revoked",
                    "the traffic owner is disabled",
                ));
            }
        }
        Ok(())
    }
    fn check(&self, principal: &Principal, method: &str, host: bool, params: &Value) -> Result<()> {
        self.current_checked(principal, method.starts_with("traffic."))?;
        let permission = if params.get("reference").and_then(Value::as_str).is_some()
            && matches!(
                method,
                "files.read" | "files.stat" | "files.readDir" | "files.writeAtomic"
            ) {
            Permission::CoreFilesDialog
        } else {
            permission(method)?
        };
        if !principal.plugin.manifest.permissions.contains(&permission)
            || principal
                .plugin
                .authorization
                .as_ref()
                .is_some_and(|auth| !auth.grants.contains(&permission))
        {
            return Err(error(
                "permission_denied",
                format!("{} must be declared and granted", permission.as_str()),
            ));
        }
        if method == "credentials.resolve" && !host {
            return Err(error(
                "permission_denied",
                "credential plaintext is not returned to renderer entries",
            ));
        }
        if method == "resources.reportTraffic" && !host {
            return Err(error(
                "permission_denied",
                "traffic resource observations must originate from the Host",
            ));
        }
        if method.starts_with("traffic.") && !host {
            return Err(error(
                "permission_denied",
                "traffic data connections require an authenticated Host entry",
            ));
        }
        Ok(())
    }

    /// Called by Native before creating its client, never by a plugin RPC.
    pub(crate) fn prepare_traffic(&self) -> Result<traffic::Traffic> {
        let mut entrance = self.0.entrance.lock().unwrap_or_else(|p| p.into_inner());
        if entrance.is_none() {
            *entrance = Some(traffic::Traffic::bind()?);
        }
        Ok(entrance.as_ref().unwrap().clone())
    }

    pub(crate) fn retire_host_traffic(&self, id: &str, generation: u64) {
        let principal = self
            .0
            .owners
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
            .filter(|p| p.plugin.generation == generation)
            .cloned();
        if let Some(p) = principal
            && let Some(traffic) = self
                .0
                .entrance
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .as_ref()
        {
            traffic.retire(&owner_key(&p));
        }
    }

    fn traffic_check(&self, p: &Principal, action: &str, target: &str) -> Result<bool> {
        self.current_checked(p, true)?;
        let granted = |permission| {
            p.plugin.manifest.permissions.contains(&permission)
                && p.plugin
                    .authorization
                    .as_ref()
                    .is_some_and(|a| a.grants.contains(&permission))
        };
        if !granted(Permission::TrafficIntercept) {
            return Ok(false);
        }
        let mut url = url::Url::parse(target)
            .map_err(|_| error("invalid_url", "invalid traffic destination"))?;
        if url.scheme() == "ws" {
            let _ = url.set_scheme("http");
        } else if url.scheme() == "wss" {
            let _ = url.set_scheme("https");
        }
        network::authorize_url(p, url.as_str())?;
        match action {
            "intercept" => Ok(true),
            "sensitiveHeaders" => Ok(granted(Permission::TrafficSensitiveHeaders)),
            "redirect" => Ok(granted(Permission::TrafficRedirect)),
            _ => Err(error(
                "permission_denied",
                "unsupported traffic authority action",
            )),
        }
    }
    fn execute(&self, work: &Work) -> Result<Value> {
        let check = || {
            if work.cancelled.load(Ordering::Acquire) {
                return Err(error("invocation_cancelled", "the requesting RPC ended"));
            }
            if Instant::now() >= work.deadline {
                return Err(error(
                    "request_timeout",
                    "the original service deadline expired",
                ));
            }
            if let Some((target, epoch)) = &work.document
                && !self
                    .0
                    .documents
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(&(
                        target.clone(),
                        work.principal.owner.plugin_id.clone(),
                        work.principal.plugin.generation,
                    ))
                    .is_some_and(|current| current.0 == *epoch)
            {
                return Err(error(
                    "scope_ended",
                    "the originating renderer document ended",
                ));
            }
            self.check(&work.principal, &work.method, work.host, &work.params)
        };
        check()?;
        let p = &work.principal;
        let params = work.params.clone();
        let value = match work.method.split_once('.') {
            Some(("storage", method)) => self.0.persistent.invoke_storage(&p.owner, method, params),
            Some(("credentials", "resolve")) => {
                let reference = string(&params, "reference")?;
                let origin = string(&params, "origin")?;
                let secret = self
                    .0
                    .persistent
                    .resolve_credential(&p.owner, reference, origin)?;
                Ok(json!({"secret": secret.as_str()}))
            }
            Some(("credentials", method)) => self
                .0
                .persistent
                .invoke_credentials(&p.owner, method, params),
            Some(("events", "createTopic" | "subscribe")) if params.get("capability").is_some() => {
                self.event_capability(p, &work.method, params, work.host)
            }
            Some(("events" | "tasks" | "processes", _)) => self
                .0
                .resources
                .invoke(&p.resources, &work.method, params)
                .map_err(|e| error(e.code, e.message)),
            Some(("files", method)) => self.0.files.invoke(p, method, params, &check),
            Some(("desktop", method)) => self.0.desktop.invoke(p, method, params, &check),
            Some(("network", method)) => {
                self.0
                    .network
                    .invoke(p, method, params, &self.0.persistent, &check)
            }
            Some(("traffic", method)) => {
                let entrance = self
                    .0
                    .entrance
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone()
                    .ok_or_else(|| {
                        error(
                            "traffic_unavailable",
                        "No enabled and authorized traffic Host was present at client launch; restart the client after enabling and granting traffic.intercept",
                        )
                    })?;
                let weak = Arc::downgrade(&self.0);
                let snapshot = p.clone();
                entrance.invoke(
                    p,
                    method,
                    params,
                    Arc::new(move |action, target| {
                        let shared = weak.upgrade().ok_or_else(|| {
                            error("runtime_stopped", "Core traffic authority retired")
                        })?;
                        SharedCoreServices(shared).traffic_check(&snapshot, action, target)
                    }),
                )
            }
            Some(("resources", "list")) => {
                let jobs = self
                    .0
                    .resources
                    .invoke(&p.resources, "resources.list", params.clone())
                    .map_err(|e| error(e.code, e.message))?;
                Ok(
                    json!({"jobs":jobs,"files":self.0.files.list(p),"desktop":self.0.desktop.list(p),"network":self.0.network.list(p),"traffic":self.0.traffic.lock().unwrap_or_else(|p|p.into_inner()).get(&owner_key(p)).cloned().unwrap_or(json!([]))}),
                )
            }
            Some(("resources", "reportTraffic")) => {
                let channels = params
                    .get("channels")
                    .and_then(Value::as_array)
                    .filter(|v| v.len() <= 4)
                    .ok_or_else(|| {
                        error(
                            "invalid_params",
                            "traffic observations require at most four channels",
                        )
                    })?;
                let channels=channels.iter().map(|channel| {
                    let id=string(channel,"id")?;
                    if id.len()>64{return Err(error("invalid_params","invalid traffic channel ID"))}
                    Ok(json!({"id":id,"open":channel.get("open").and_then(Value::as_bool).unwrap_or(false),"activeRequests":channel.get("activeRequests").and_then(Value::as_u64).unwrap_or(0).min(4),"forwardAttempts":channel.get("forwardAttempts").and_then(Value::as_u64).unwrap_or(0),"observedBy":"managed-host"}))
                }).collect::<Result<Vec<_>>>()?;
                self.0
                    .traffic
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .insert(owner_key(p), json!(channels));
                Ok(json!({"recorded":true}))
            }
            Some(("diagnostics", "read")) => {
                let after = params.get("after").and_then(Value::as_u64).unwrap_or(0);
                let log = self.0.log.lock().unwrap_or_else(|p| p.into_inner());
                let events = log
                    .1
                    .iter()
                    .filter(|v| {
                        v["pluginId"] == p.owner.plugin_id
                            && v["cursor"].as_u64().is_some_and(|n| n > after)
                    })
                    .take(128)
                    .cloned()
                    .collect::<Vec<_>>();
                Ok(
                    json!({"events":events,"cursor":log.0,"gap":log.1.front().and_then(|v| v["cursor"].as_u64()).is_some_and(|first| after != 0 && after + 1 < first)}),
                )
            }
            _ => Err(error("method_not_found", "unknown Core service method")),
        }?;
        if let Err(failure) = check() {
            self.rollback_resource(p, &work.method, &value);
            return Err(if mutates(&work.method) {
                error(
                    "outcome_unknown",
                    "the caller retired before receiving the operation receipt; inspect the resulting state before retrying",
                )
            } else {
                failure
            });
        }
        let document_resource = match work.method.as_str() {
            "tasks.register" => Some("runner"),
            "files.openDialog" | "files.saveDialog" => Some("dialog"),
            _ => None,
        };
        if let Some(kind) = document_resource
            && let (Some((document, epoch)), Some(runner)) =
                (&work.document, value.get(kind).and_then(Value::as_str))
        {
            let mut documents = self.0.documents.lock().unwrap_or_else(|p| p.into_inner());
            let entry = documents.get_mut(&(
                document.clone(),
                p.owner.plugin_id.clone(),
                p.plugin.generation,
            ));
            if let Some((current, runners)) = entry
                && *current == *epoch
            {
                if kind == "dialog" {
                    runners.retain(|(kind, _)| *kind != "dialog");
                }
                if !runners.iter().any(|(k, id)| *k == kind && id == runner) {
                    if runners.len() >= 128 {
                        drop(documents);
                        self.rollback_resource(p, &work.method, &value);
                        return Err(error(
                            "resource_limit",
                            "document resource registration limit reached",
                        ));
                    }
                    runners.push((kind, runner.into()));
                }
            } else {
                drop(documents);
                self.rollback_resource(p, &work.method, &value);
                return Err(error(
                    "scope_ended",
                    "the originating renderer document ended",
                ));
            }
        }
        if serde_json::to_vec(&value).map_or(true, |v| v.len() > 768 * 1024) {
            return Err(error(
                "response_too_large",
                "Core service result exceeds 768 KiB; request a smaller page",
            ));
        }
        Ok(value)
    }
    fn record(&self, principal: &Principal, method: &str, failure: Option<&str>) {
        // Only operation names and stable error codes: never params, file data,
        // credential values, request headers, clipboard or notification text.
        let mut log = self.0.log.lock().unwrap_or_else(|p| p.into_inner());
        log.0 += 1;
        let cursor = log.0;
        log.1.push_back(json!({"cursor":cursor,"time":now_ms(),"pluginId":principal.owner.plugin_id,"generation":principal.plugin.generation,"method":method,"code":failure.unwrap_or("ok")}));
        if log.1.len() > 512 {
            log.1.pop_front();
        }
    }
    fn event_capability(
        &self,
        p: &Principal,
        method: &str,
        params: Value,
        host: bool,
    ) -> Result<Value> {
        let capability: crate::capabilities::CapabilityDescriptor =
            serde_json::from_value(params["capability"].clone()).map_err(|_| {
                error(
                    "invalid_params",
                    "event capability must be a valid descriptor",
                )
            })?;
        if capability.scope != crate::capabilities::CapabilityScope::Runtime {
            return Err(error(
                "scope_unavailable",
                "shared event topics require a Runtime capability",
            ));
        }
        if method == "events.createTopic" {
            let provides = if host {
                p.plugin.manifest.host_provides()
            } else {
                p.plugin.manifest.renderer_provides()
            };
            if !provides.contains(&capability) {
                return Err(error(
                    "capability_denied",
                    "event export must name a capability provided by this entry",
                ));
            }
            return self
                .0
                .resources
                .invoke(&p.resources, method, params)
                .map_err(|e| error(e.code, e.message));
        }
        let requires = if host {
            p.plugin.manifest.host_requires()
        } else {
            p.plugin.manifest.renderer_requires()
        };
        if !requires.contains(&capability) {
            return Err(error(
                "capability_denied",
                "event subscription must name a declared requirement",
            ));
        }
        let owners = self
            .0
            .owners
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .filter(|owner| {
                owner.plugin.manifest.host_provides().contains(&capability)
                    || owner
                        .plugin
                        .manifest
                        .renderer_provides()
                        .contains(&capability)
            })
            .cloned()
            .collect::<Vec<_>>();
        if owners.len() != 1 {
            return Err(error(
                "capability_denied",
                "event capability must resolve to exactly one active provider",
            ));
        }
        self.current(&owners[0])?;
        self.0
            .resources
            .invoke_events_for(&p.resources, &owners[0].resources, method, params)
            .map_err(|e| error(e.code, e.message))
    }
    fn rollback_resource(&self, p: &Principal, method: &str, value: &Value) {
        match method {
            "tasks.register" => {
                let _ = self.0.resources.invoke(
                    &p.resources,
                    "tasks.unregister",
                    json!({"runner":value["runner"]}),
                );
            }
            "processes.spawn" => {
                let _ = self.0.resources.invoke(
                    &p.resources,
                    "processes.close",
                    json!({"process":value["process"]}),
                );
            }
            "events.createTopic" => {
                let _ = self.0.resources.invoke(
                    &p.resources,
                    "events.close",
                    json!({"topic":value["topic"]}),
                );
            }
            "events.subscribe" => {
                let _ = self.0.resources.invoke(
                    &p.resources,
                    "events.close",
                    json!({"subscription":value["subscription"]}),
                );
            }
            "network.createProfile" => {
                let _ = self.0.network.invoke(
                    p,
                    "closeProfile",
                    json!({"profile":value["profile"]}),
                    &self.0.persistent,
                    &|| Ok(()),
                );
            }
            "traffic.register" | "traffic.openSource" => {
                if let Some(traffic) = self
                    .0
                    .entrance
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .as_ref()
                {
                    let _ = traffic.invoke(
                        p,
                        if method == "traffic.openSource" {
                            "closeSource"
                        } else {
                            "unregister"
                        },
                        if method == "traffic.openSource" {
                            json!({"source":value["source"]})
                        } else {
                            json!({"registration":value["registration"]})
                        },
                        Arc::new(|_, _| Ok(false)),
                    );
                }
            }
            "traffic.connect" => {
                if let Some(traffic) = self
                    .0
                    .entrance
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .as_ref()
                    && let Some(token) = value["token"].as_str()
                {
                    traffic.revoke_ticket(&owner_key(p), token);
                }
            }
            "files.watch" => {
                let _ = self
                    .0
                    .files
                    .invoke(p, "unwatch", json!({"watch":value["watch"]}), &|| Ok(()));
            }
            "files.openDialog" | "files.saveDialog" => {
                let _ = self.0.files.invoke(
                    p,
                    "cancelDialog",
                    json!({"dialog":value["dialog"]}),
                    &|| Ok(()),
                );
            }
            "desktop.registerShortcut" => {
                let _ = self.0.desktop.invoke(
                    p,
                    "unregisterShortcut",
                    json!({"registration":value["registration"]}),
                    &|| Ok(()),
                );
            }
            "desktop.notify" => {
                let _ = self.0.desktop.invoke(
                    p,
                    "dismissNotification",
                    json!({"notification":value["notification"]}),
                    &|| Ok(()),
                );
            }
            _ => {}
        }
    }
}
fn mutates(method: &str) -> bool {
    matches!(
        method,
        "storage.transaction"
            | "storage.clearCache"
            | "credentials.put"
            | "credentials.remove"
            | "files.writeAtomic"
            | "files.mkdir"
            | "files.remove"
            | "tasks.start"
            | "processes.write"
            | "desktop.notify"
            | "desktop.clipboardWrite"
            | "network.fetch"
    )
}
impl Drop for Shared {
    fn drop(&mut self) {
        let _ = self.resources.shutdown();
    }
}
fn monitor(weak: Weak<Shared>) {
    loop {
        std::thread::sleep(Duration::from_millis(500));
        let Some(shared) = weak.upgrade() else {
            break;
        };
        let service = SharedCoreServices(shared);
        let owners = service
            .0
            .owners
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for owner in owners {
            if service
                .current_checked(
                    &owner,
                    owner
                        .plugin
                        .manifest
                        .permissions
                        .contains(&Permission::TrafficIntercept),
                )
                .is_err()
            {
                service.retire(&owner.owner.plugin_id, owner.plugin.generation);
            }
        }
    }
}
fn permission(method: &str) -> Result<Permission> {
    use Permission::*;
    Ok(match method.split_once('.') {
        Some(("storage", _)) => CoreStorage,
        Some(("credentials", "resolve")) => CoreCredentialsUse,
        Some(("credentials", _)) => CoreCredentials,
        Some(("files", "read" | "stat" | "readDir")) => HostFs,
        Some(("files", "writeAtomic" | "remove" | "mkdir")) => HostFsWrite,
        Some(("files", "watch" | "changes" | "unwatch")) => HostFsWatch,
        Some((
            "files",
            "openDialog" | "saveDialog" | "dialogStatus" | "cancelDialog" | "release",
        )) => CoreFilesDialog,
        Some(("events", _)) => CoreEvents,
        Some(("tasks", _)) => CoreTasks,
        Some(("processes", _)) => HostProcessSpawn,
        Some(("resources", "reportTraffic")) => HostNetwork,
        Some(("network", "fetch")) => HostNetwork,
        Some(("network", _)) => CoreNetwork,
        Some(("traffic", _)) => TrafficIntercept,
        Some(("desktop", "notify" | "dismissNotification" | "notificationEvents")) => {
            CoreNotifications
        }
        Some(("desktop", "clipboardRead")) => CoreClipboardRead,
        Some(("desktop", "clipboardWrite")) => CoreClipboardWrite,
        Some(("desktop", "registerShortcut" | "unregisterShortcut" | "shortcutEvents")) => {
            CoreShortcuts
        }
        Some(("diagnostics" | "resources", _)) => CoreDiagnostics,
        _ => return Err(error("method_not_found", "unknown Core service method")),
    })
}
pub(crate) fn error(code: &'static str, message: impl Into<String>) -> ServiceError {
    ServiceError {
        code,
        message: message.into(),
        data: None,
    }
}
pub(crate) fn string<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 4096)
        .ok_or_else(|| error("invalid_params", format!("{name} must be a bounded string")))
}
pub(crate) fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
pub(crate) fn owner_key(p: &Principal) -> String {
    format!(
        "{}:{}:{}",
        p.owner.plugin_id, p.owner.source_identity, p.plugin.generation
    )
}
