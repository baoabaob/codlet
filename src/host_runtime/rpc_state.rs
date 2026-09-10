//! Core-owned registrations, target handles and invocation lineage shared by
//! both executors. Plugin JSON never supplies a caller or a document epoch.

use std::collections::BTreeMap;

use crate::capabilities::{
    CapabilityDescriptor, CapabilityLease, CapabilityPrincipal, CapabilityRegistry,
    CapabilityScope, CapabilityScopeInstance, host_provider_id,
};
use crate::cdp::{CdpEvent, TargetSession};
use crate::renderer::{BUILTIN_HOST_PROVIDER_ID, builtin_host_capabilities};

use super::*;

const MAX_HANDLES: usize = 64;
const MAX_RAW_SESSIONS: usize = 128;
const MAX_TARGETS: usize = 64;
const MAX_RENDERER_INVOCATIONS: usize = 32;
const MAX_ENTRY_IDENTITIES: usize = 8192;

pub(super) struct RawAttachPermit {
    shared: CoreRpcShared,
    active: bool,
}
impl Drop for RawAttachPermit {
    fn drop(&mut self) {
        if self.active {
            self.shared
                .0
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .reserved_attaches -= 1;
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum RpcScope {
    Runtime,
    Target {
        #[serde(rename = "targetId")]
        target_id: String,
        epoch: u64,
    },
}

impl RpcScope {
    fn instance(&self) -> CapabilityScopeInstance {
        match self {
            Self::Runtime => CapabilityScopeInstance::Runtime,
            Self::Target { target_id, .. } => CapabilityScopeInstance::Target(target_id.clone()),
        }
    }
    pub fn target(&self) -> Option<(&str, u64)> {
        match self {
            Self::Target { target_id, epoch } => Some((target_id, *epoch)),
            Self::Runtime => None,
        }
    }
}

#[derive(Clone)]
pub(crate) struct RpcLineage {
    pub scope: RpcScope,
    pub deadline: Instant,
    pub depth: u8,
    pub cancellations: Vec<Arc<AtomicBool>>,
}

impl RpcLineage {
    pub fn cancelled(&self) -> bool {
        self.cancellations
            .iter()
            .any(|flag| flag.load(Ordering::Acquire))
    }
}

#[derive(Clone)]
pub(crate) struct RpcRoute {
    principal: CapabilityPrincipal,
    lease: CapabilityLease,
    pub provider_id: String,
    pub generation: u64,
    pub capability: CapabilityDescriptor,
    pub caller: HostCapabilityCaller,
    pub lineage: RpcLineage,
}

pub(crate) struct RendererCall {
    pub route: RpcRoute,
    shared: CoreRpcShared,
    key: Option<(String, String, u64)>,
    cancelled: Arc<AtomicBool>,
}

impl Drop for RendererCall {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
        if let Some(key) = &self.key {
            self.shared
                .0
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .renderer_calls
                .remove(key);
        }
    }
}

#[derive(Clone)]
pub(crate) struct RendererEndpoint {
    pub session: TargetSession,
    pub plugin_id: String,
    pub generation: u64,
    pub document_epoch: u64,
    pub context_id: u64,
    pub binding: String,
    pub authorization: Option<crate::plugins::LocalPluginRegistration>,
    pub registry_path: std::path::PathBuf,
}

impl RendererEndpoint {
    pub fn authority_is_current(&self) -> bool {
        self.authorization.as_ref().is_none_or(|expected| {
            crate::plugins::PluginRegistry::load(&self.registry_path).is_ok_and(|registry| {
                registry.local_plugins().get(&self.plugin_id) == Some(expected)
            })
        })
    }
}

#[derive(Clone, PartialEq, Eq)]
struct Declaration {
    generation: u64,
    provides: Vec<CapabilityDescriptor>,
    requires: Vec<CapabilityDescriptor>,
    grants: Vec<String>,
}

struct TargetScope {
    epoch: u64,
    frame_id: Option<String>,
    renderer_document: Option<(String, u64)>,
}

struct RawSession {
    owner: String,
    generation: u64,
    target_id: String,
}
struct ScopeHandle {
    owner: String,
    generation: u64,
    session_id: String,
    scope: RpcScope,
    cancelled: Arc<AtomicBool>,
}
struct RendererInvocation {
    endpoint: RendererEndpoint,
    lineage: RpcLineage,
}

struct State {
    registry: CapabilityRegistry,
    declarations: BTreeMap<String, Declaration>,
    blocked: BTreeMap<String, u64>,
    hosts: BTreeMap<String, (u64, ExecutionState, Option<String>)>,
    targets: BTreeMap<String, TargetScope>,
    raw_sessions: BTreeMap<String, RawSession>,
    reserved_attaches: usize,
    cleanup_sessions: BTreeMap<(String, u64), Vec<String>>,
    retiring_sessions: BTreeMap<String, (String, u64)>,
    handles: BTreeMap<String, ScopeHandle>,
    renderers: BTreeMap<(String, String), RendererEndpoint>,
    invocations: BTreeMap<String, RendererInvocation>,
    renderer_calls: BTreeMap<(String, String, u64), Arc<AtomicBool>>,
    next_id: u64,
}

impl Default for State {
    fn default() -> Self {
        let mut registry = CapabilityRegistry::new();
        registry
            .register_provider(
                BUILTIN_HOST_PROVIDER_ID,
                1,
                &builtin_host_capabilities(),
                &[],
                &[],
            )
            .expect("static Core capabilities");
        registry
            .activate_scope(CapabilityScopeInstance::Runtime)
            .expect("new Runtime scope");
        Self {
            registry,
            declarations: BTreeMap::new(),
            blocked: BTreeMap::new(),
            hosts: BTreeMap::new(),
            targets: BTreeMap::new(),
            raw_sessions: BTreeMap::new(),
            reserved_attaches: 0,
            cleanup_sessions: BTreeMap::new(),
            retiring_sessions: BTreeMap::new(),
            handles: BTreeMap::new(),
            renderers: BTreeMap::new(),
            invocations: BTreeMap::new(),
            renderer_calls: BTreeMap::new(),
            next_id: 0,
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct CoreRpcShared(Arc<Mutex<State>>);

impl CoreRpcShared {
    pub fn register_plugins(&self, plugins: &[LoadedPlugin]) -> Result<(), HostError> {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        for plugin in plugins {
            let grants = plugin
                .manifest
                .permissions
                .iter()
                .map(|permission| permission.as_str().to_owned())
                .collect::<Vec<_>>();
            let mut entries = Vec::new();
            if plugin.manifest.host.is_some() {
                entries.push((
                    host_provider_id(&plugin.manifest.id),
                    plugin.manifest.host_provides(),
                    plugin.manifest.host_requires(),
                ));
            }
            if plugin.manifest.renderer.is_some() {
                entries.push((
                    plugin.manifest.id.clone(),
                    plugin.manifest.renderer_provides(),
                    plugin.manifest.renderer_requires(),
                ));
            }
            for (id, provides, requires) in entries {
                if !state.declarations.contains_key(&id)
                    && !state.blocked.contains_key(&id)
                    && state.declarations.len()
                        + state
                            .blocked
                            .keys()
                            .filter(|id| !state.declarations.contains_key(*id))
                            .count()
                        >= MAX_ENTRY_IDENTITIES
                {
                    return Err(HostError::new(
                        "identity_limit",
                        "Core has exhausted its bounded entry identity history",
                    ));
                }
                if state
                    .blocked
                    .get(&id)
                    .is_some_and(|generation| plugin.generation <= *generation)
                {
                    continue;
                }
                let declaration = Declaration {
                    generation: plugin.generation,
                    provides: provides.to_vec(),
                    requires: requires.to_vec(),
                    grants: grants.clone(),
                };
                if state.declarations.get(&id) == Some(&declaration) {
                    continue;
                }
                if state
                    .declarations
                    .get(&id)
                    .is_some_and(|old| old.generation >= declaration.generation)
                {
                    return Err(HostError::new(
                        "stale_generation",
                        "an entry registration cannot change without a fresh generation",
                    ));
                }
                state
                    .registry
                    .unregister_provider(&id)
                    .map_err(registry_error)?;
                state
                    .registry
                    .register_provider(&id, plugin.generation, provides, requires, &grants)
                    .map_err(registry_error)?;
                state.declarations.insert(id, declaration);
            }
        }
        Ok(())
    }

    pub fn retire_plugin(&self, id: &str, generation: u64) {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        for entry in [id.to_owned(), host_provider_id(id)] {
            state
                .blocked
                .entry(entry.clone())
                .and_modify(|value| *value = (*value).max(generation))
                .or_insert(generation);
            if state
                .declarations
                .get(&entry)
                .is_some_and(|value| value.generation <= generation)
            {
                let _ = state.registry.unregister_provider(&entry);
                state.declarations.remove(&entry);
            }
        }
        state
            .renderers
            .retain(|(_, plugin), endpoint| plugin != id || endpoint.generation > generation);
        state.invocations.retain(|_, invocation| {
            invocation.endpoint.plugin_id != id || invocation.endpoint.generation > generation
        });
    }

    pub fn host_state(
        &self,
        id: &str,
        generation: u64,
        value: ExecutionState,
        error: Option<&str>,
    ) {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .hosts
            .insert(
                id.into(),
                (
                    generation,
                    value,
                    error.map(|value| value.chars().take(4096).collect()),
                ),
            );
    }

    pub fn host_ready(&self, id: &str, generation: u64) -> Result<bool, HostError> {
        let state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        match state.hosts.get(id) {
            Some((current, ExecutionState::Active, _)) if *current == generation => Ok(true),
            Some((current, ExecutionState::Starting, _)) if *current == generation => Ok(false),
            Some((current, _, _)) if *current < generation => Ok(false),
            None => Ok(false),
            Some((current, _, Some(error))) if *current == generation => {
                Err(HostError::new("host_unavailable", error.clone()))
            }
            _ => Err(HostError::new(
                "host_unavailable",
                "the pinned Host provider generation has retired",
            )),
        }
    }

    pub fn publish_renderer(&self, endpoint: RendererEndpoint) -> Result<(), HostError> {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if state.registry.provider_generation(&endpoint.plugin_id) != Some(endpoint.generation) {
            return Err(stale());
        }
        let target = endpoint.session.target_id().to_owned();
        let document = (
            endpoint.session.session_id().to_owned(),
            endpoint.document_epoch,
        );
        if state
            .targets
            .get(&target)
            .and_then(|scope| scope.renderer_document.as_ref())
            .is_some_and(|old| old.0 == document.0 && old.1 != document.1)
        {
            state.retire_target_document(&target);
        }
        state.ensure_target(&target)?;
        state.targets.get_mut(&target).unwrap().renderer_document = Some(document);
        state
            .renderers
            .insert((target, endpoint.plugin_id.clone()), endpoint);
        Ok(())
    }

    pub fn publish_target(
        &self,
        session: &TargetSession,
        document_epoch: u64,
    ) -> Result<(), HostError> {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let target = session.target_id();
        let document = (session.session_id().to_owned(), document_epoch);
        if state
            .targets
            .get(target)
            .and_then(|scope| scope.renderer_document.as_ref())
            .is_some_and(|old| old.0 == document.0 && old.1 != document.1)
        {
            state.retire_target_document(target);
        }
        state.ensure_target(target)?;
        state.targets.get_mut(target).unwrap().renderer_document = Some(document);
        Ok(())
    }

    pub fn retire_renderer(&self, target: &str, plugin: Option<&str>) {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        state.renderers.retain(|(current, id), _| {
            current != target || plugin.is_some_and(|plugin| id != plugin)
        });
        state.invocations.retain(|_, invocation| {
            invocation.endpoint.session.target_id() != target
                || plugin.is_some_and(|id| invocation.endpoint.plugin_id != id)
        });
    }

    pub(super) fn reserve_raw_attach(&self) -> Result<RawAttachPermit, HostError> {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if state.raw_sessions.len() + state.retiring_sessions.len() + state.reserved_attaches
            >= MAX_RAW_SESSIONS
        {
            return Err(HostError::new(
                "scope_limit",
                "Core is tracking, attaching or retiring 128 owned raw sessions",
            ));
        }
        state.reserved_attaches += 1;
        Ok(RawAttachPermit {
            shared: self.clone(),
            active: true,
        })
    }

    pub(super) fn track_raw_attach(
        &self,
        owner: &str,
        generation: u64,
        target: &str,
        session: &str,
        mut permit: RawAttachPermit,
    ) -> Result<(), HostError> {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if state.raw_sessions.contains_key(session) || state.retiring_sessions.contains_key(session)
        {
            drop(state);
            return Err(HostError::new(
                "scope_denied",
                "CDP returned an already-owned raw session identity",
            ));
        }
        permit.active = false;
        state.reserved_attaches -= 1;
        state.raw_sessions.insert(
            session.into(),
            RawSession {
                owner: owner.into(),
                generation,
                target_id: target.into(),
            },
        );
        Ok(())
    }

    pub fn owned_target(
        &self,
        owner: &str,
        generation: u64,
        session: &str,
    ) -> Result<String, HostError> {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .raw_sessions
            .get(session)
            .filter(|raw| raw.owner == owner && raw.generation == generation)
            .map(|raw| raw.target_id.clone())
            .ok_or_else(|| {
                HostError::new(
                    "scope_denied",
                    "the current Host generation does not own this Core-recorded raw session",
                )
            })
    }

    pub fn retire_raw_session(&self, session: &str) {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retire_session(session);
    }

    pub fn retire_host_scopes(&self, owner: &str, generation: u64) {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let sessions = state
            .raw_sessions
            .iter()
            .filter(|(_, raw)| raw.owner == owner && raw.generation == generation)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for session in sessions {
            state.schedule_session_cleanup(&session);
        }
    }

    pub fn retire_late_attachment(&self, owner: &str, generation: u64, session: &str) {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if state
            .raw_sessions
            .get(session)
            .is_some_and(|raw| raw.owner == owner && raw.generation == generation)
        {
            state.schedule_session_cleanup(session);
        }
    }

    pub fn take_cleanup_sessions(&self, owner: &str, generation: u64) -> Vec<String> {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .cleanup_sessions
            .remove(&(owner.into(), generation))
            .unwrap_or_default()
    }
    pub fn has_cleanup_sessions(&self, owner: &str, generation: u64) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .cleanup_sessions
            .get(&(owner.into(), generation))
            .is_some_and(|sessions| !sessions.is_empty())
    }

    pub fn issue_handle(
        &self,
        owner: &str,
        generation: u64,
        session: &str,
        frame_id: String,
    ) -> Result<Value, HostError> {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let target = state
            .raw_sessions
            .get(session)
            .filter(|raw| raw.owner == owner && raw.generation == generation)
            .map(|raw| raw.target_id.clone())
            .ok_or_else(|| {
                HostError::new(
                    "scope_denied",
                    "the raw session retired before scope admission",
                )
            })?;
        if state.handles.len() >= MAX_HANDLES {
            return Err(HostError::new(
                "scope_limit",
                "Core has 64 live Target scope handles",
            ));
        }
        state.ensure_target(&target)?;
        let target_scope = state.targets.get_mut(&target).unwrap();
        target_scope.frame_id = Some(frame_id);
        let scope = RpcScope::Target {
            target_id: target,
            epoch: target_scope.epoch,
        };
        let id = state.next_token("scope")?;
        state.handles.insert(
            id.clone(),
            ScopeHandle {
                owner: owner.into(),
                generation,
                session_id: session.into(),
                scope,
                cancelled: Arc::new(AtomicBool::new(false)),
            },
        );
        Ok(json!({"handleId":id,"kind":"target"}))
    }

    pub fn close_handle(&self, owner: &str, generation: u64, id: &str) -> Result<Value, HostError> {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if !state
            .handles
            .get(id)
            .is_some_and(|handle| handle.owner == owner && handle.generation == generation)
        {
            return Err(HostError::new(
                "scope_denied",
                "this generation does not own that live scope handle",
            ));
        }
        if let Some(handle) = state.handles.remove(id) {
            handle.cancelled.store(true, Ordering::Release);
        }
        Ok(json!({"closed":true}))
    }

    pub fn observe(&self, event: &CdpEvent) {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let params = event.params.as_ref();
        match event.method.as_str() {
            "Target.detachedFromTarget" => {
                if let Some(session) = params
                    .and_then(|value| value.get("sessionId"))
                    .and_then(Value::as_str)
                {
                    state.retire_session(session);
                }
            }
            "Target.targetDestroyed" => {
                if let Some(target) = params
                    .and_then(|value| value.get("targetId"))
                    .and_then(Value::as_str)
                {
                    state.retire_target_document(target);
                    state.targets.remove(target);
                    state
                        .registry
                        .deactivate_scope(&CapabilityScopeInstance::Target(target.into()));
                    let sessions = state
                        .raw_sessions
                        .iter()
                        .filter(|(_, raw)| raw.target_id == target)
                        .map(|(id, _)| id.clone())
                        .collect::<Vec<_>>();
                    for id in sessions {
                        state.retire_session(&id);
                    }
                }
            }
            "Page.frameNavigated" => {
                let frame = params.and_then(|value| value.get("frame"));
                if frame.is_some_and(|frame| frame.get("parentId").is_none()) {
                    let target = event.session_id.as_ref().and_then(|session| {
                        state
                            .raw_sessions
                            .get(session)
                            .map(|raw| raw.target_id.clone())
                            .or_else(|| {
                                state
                                    .targets
                                    .iter()
                                    .find(|(_, target)| {
                                        target
                                            .renderer_document
                                            .as_ref()
                                            .is_some_and(|(current, _)| current == session)
                                    })
                                    .map(|(id, _)| id.clone())
                            })
                    });
                    if let Some(target) = target {
                        state.retire_target_document(&target);
                    }
                }
            }
            _ => {}
        }
    }

    pub fn invalidate_targets(&self) {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let targets = state.targets.keys().cloned().collect::<Vec<_>>();
        for target in targets {
            state.retire_target_document(&target);
        }
    }

    pub fn resolve_host(
        &self,
        plugin: &LoadedPlugin,
        capability: &CapabilityDescriptor,
        handle: Option<&str>,
        parent: Option<&RpcLineage>,
        deadline: Instant,
    ) -> Result<RpcRoute, HostError> {
        let state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let mut cancellations = parent.map_or_else(Vec::new, |parent| parent.cancellations.clone());
        let scope = if let Some(handle) = handle {
            let handle = state
                .handles
                .get(handle)
                .filter(|handle| {
                    handle.owner == plugin.manifest.id && handle.generation == plugin.generation
                })
                .ok_or_else(|| {
                    HostError::new(
                        "scope_denied",
                        "scope handle is stale or belongs to another Host generation",
                    )
                })?;
            cancellations.push(Arc::clone(&handle.cancelled));
            handle.scope.clone()
        } else if let Some(parent) = parent {
            parent.scope.clone()
        } else if capability.scope == CapabilityScope::Runtime {
            RpcScope::Runtime
        } else {
            return Err(HostError::new(
                "scope_required",
                "Target capability calls require a Core-issued scope handle or an active Target invocation",
            ));
        };
        let depth = parent.map_or(1, |parent| parent.depth.saturating_add(1));
        if depth > 8 {
            return Err(HostError::new(
                "rpc_depth_limit",
                "managed RPC nesting exceeds eight invocations",
            ));
        }
        let lineage = RpcLineage {
            scope,
            deadline: parent.map_or(deadline, |parent| deadline.min(parent.deadline)),
            depth,
            cancellations,
        };
        state.resolve(
            &host_provider_id(&plugin.manifest.id),
            &plugin.manifest.id,
            plugin.generation,
            capability,
            lineage,
        )
    }

    pub fn resolve_renderer(
        &self,
        endpoint: &RendererEndpoint,
        capability: &CapabilityDescriptor,
        parent_token: Option<&str>,
        deadline: Instant,
    ) -> Result<RpcRoute, HostError> {
        let state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let target = endpoint.session.target_id();
        let scope = state.targets.get(target).ok_or_else(stale)?;
        let parent = if let Some(token) = parent_token {
            let invocation = state
                .invocations
                .get(token)
                .filter(|invocation| same_endpoint(&invocation.endpoint, endpoint))
                .ok_or_else(|| {
                    HostError::new(
                        "invocation_cancelled",
                        "renderer parent token is stale or belongs to another realm",
                    )
                })?;
            Some(&invocation.lineage)
        } else {
            None
        };
        let lineage = RpcLineage {
            scope: RpcScope::Target {
                target_id: target.into(),
                epoch: scope.epoch,
            },
            deadline: parent.map_or(deadline, |parent| deadline.min(parent.deadline)),
            depth: parent.map_or(1, |parent| parent.depth.saturating_add(1)),
            cancellations: parent.map_or_else(Vec::new, |parent| parent.cancellations.clone()),
        };
        if lineage.depth > 8 {
            return Err(HostError::new(
                "rpc_depth_limit",
                "managed RPC nesting exceeds eight invocations",
            ));
        }
        let mut route = state.resolve(
            &endpoint.plugin_id,
            &endpoint.plugin_id,
            endpoint.generation,
            capability,
            lineage,
        )?;
        route.caller.document_epoch = endpoint.document_epoch;
        Ok(route)
    }

    pub fn begin_renderer_call(
        &self,
        endpoint: &RendererEndpoint,
        capability: &CapabilityDescriptor,
        parent_token: Option<&str>,
        request_id: Option<u64>,
        deadline: Instant,
    ) -> Result<RendererCall, HostError> {
        let mut route = self.resolve_renderer(endpoint, capability, parent_token, deadline)?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let key = request_id.map(|id| {
            (
                endpoint.session.session_id().to_owned(),
                endpoint.binding.clone(),
                id,
            )
        });
        if let Some(key) = &key {
            let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
            if state.renderer_calls.len() >= 64 {
                return Err(HostError::new(
                    "request_limit",
                    "Core has 64 pending renderer requests",
                ));
            }
            if state.renderer_calls.contains_key(key) {
                return Err(HostError::new(
                    "duplicate_request_id",
                    "this renderer request is already pending",
                ));
            }
            state
                .renderer_calls
                .insert(key.clone(), Arc::clone(&cancelled));
        }
        route.lineage.cancellations.push(Arc::clone(&cancelled));
        Ok(RendererCall {
            route,
            shared: self.clone(),
            key,
            cancelled,
        })
    }

    pub fn cancel_renderer_call(&self, endpoint: &RendererEndpoint, id: u64) {
        let key = (
            endpoint.session.session_id().to_owned(),
            endpoint.binding.clone(),
            id,
        );
        if let Some(cancelled) = self
            .0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .renderer_calls
            .remove(&key)
        {
            cancelled.store(true, Ordering::Release);
        }
    }

    pub fn endpoint_is_current(&self, endpoint: &RendererEndpoint) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .renderers
            .get(&(
                endpoint.session.target_id().to_owned(),
                endpoint.plugin_id.clone(),
            ))
            .is_some_and(|current| same_endpoint(current, endpoint))
    }

    pub fn validate(&self, route: &RpcRoute) -> Result<(), HostError> {
        let state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        state.validate_lineage(&route.lineage)?;
        state
            .registry
            .invoke(&route.principal, &route.lease, || ())
            .map_err(access_error)
    }

    pub fn renderer_endpoint(
        &self,
        route: &RpcRoute,
    ) -> Result<Option<RendererEndpoint>, HostError> {
        self.validate(route)?;
        let state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let Some((target, _)) = route.lineage.scope.target() else {
            return Err(HostError::new(
                "scope_mismatch",
                "renderer providers require Target scope",
            ));
        };
        Ok(state
            .renderers
            .get(&(target.into(), route.provider_id.clone()))
            .filter(|endpoint| {
                endpoint.generation == route.generation && endpoint.session.is_live()
            })
            .cloned())
    }

    pub fn begin_renderer_invocation(
        &self,
        endpoint: &RendererEndpoint,
        lineage: RpcLineage,
    ) -> Result<String, HostError> {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        state.validate_lineage(&lineage)?;
        if state.invocations.len() >= MAX_RENDERER_INVOCATIONS {
            return Err(HostError::new(
                "request_limit",
                "Core has too many active renderer invocations",
            ));
        }
        let token = state.next_token("invocation")?;
        state.invocations.insert(
            token.clone(),
            RendererInvocation {
                endpoint: endpoint.clone(),
                lineage,
            },
        );
        Ok(token)
    }

    pub fn end_renderer_invocation(&self, token: &str) {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .invocations
            .remove(token);
    }
}

impl State {
    fn schedule_session_cleanup(&mut self, session: &str) {
        let raw = self.raw_sessions.remove(session);
        self.retire_session(session);
        if let Some(raw) = raw {
            self.retiring_sessions
                .insert(session.into(), (raw.owner.clone(), raw.generation));
            self.cleanup_sessions
                .entry((raw.owner, raw.generation))
                .or_default()
                .push(session.into());
        }
    }
    fn next_token(&mut self, prefix: &str) -> Result<String, HostError> {
        self.next_id = self.next_id.checked_add(1).ok_or_else(|| {
            HostError::new(
                "scope_ids_exhausted",
                "restart Core before issuing another scope or invocation",
            )
        })?;
        Ok(format!("{prefix}-{}", self.next_id))
    }
    fn ensure_target(&mut self, target: &str) -> Result<(), HostError> {
        if self.targets.contains_key(target) {
            return Ok(());
        }
        if self.targets.len() >= MAX_TARGETS {
            return Err(HostError::new(
                "scope_limit",
                "Core has 64 active Target scopes",
            ));
        }
        let epoch = self
            .registry
            .activate_scope(CapabilityScopeInstance::Target(target.into()))
            .map_err(registry_error)?;
        self.targets.insert(
            target.into(),
            TargetScope {
                epoch,
                frame_id: None,
                renderer_document: None,
            },
        );
        Ok(())
    }
    fn retire_target_document(&mut self, target: &str) {
        if !self.targets.contains_key(target) {
            return;
        }
        let scope = CapabilityScopeInstance::Target(target.into());
        self.registry.deactivate_scope(&scope);
        let epoch = self
            .registry
            .activate_scope(scope)
            .expect("retired Target scope");
        if let Some(target) = self.targets.get_mut(target) {
            target.epoch = epoch;
            target.renderer_document = None;
            target.frame_id = None;
        }
        self.handles.retain(|_, handle| {
            let keep = handle.scope.target().is_none_or(|(id, _)| id != target);
            if !keep {
                handle.cancelled.store(true, Ordering::Release);
            }
            keep
        });
        self.renderers.retain(|(id, _), _| id != target);
        self.invocations
            .retain(|_, invocation| invocation.endpoint.session.target_id() != target);
    }
    fn retire_session(&mut self, session: &str) {
        self.raw_sessions.remove(session);
        self.retiring_sessions.remove(session);
        for sessions in self.cleanup_sessions.values_mut() {
            sessions.retain(|current| current != session);
        }
        self.cleanup_sessions
            .retain(|_, sessions| !sessions.is_empty());
        self.handles.retain(|_, handle| {
            let keep = handle.session_id != session;
            if !keep {
                handle.cancelled.store(true, Ordering::Release);
            }
            keep
        });
        let targets = self
            .renderers
            .values()
            .filter(|endpoint| endpoint.session.session_id() == session)
            .map(|endpoint| endpoint.session.target_id().to_owned())
            .collect::<Vec<_>>();
        for target in targets {
            self.retire_target_document(&target);
        }
    }
    fn validate_lineage(&self, lineage: &RpcLineage) -> Result<(), HostError> {
        if lineage.cancelled() {
            return Err(HostError::new(
                "invocation_cancelled",
                "an ancestor invocation or scope handle has retired",
            ));
        }
        if Instant::now() >= lineage.deadline {
            return Err(HostError::new(
                "request_timeout",
                "the original managed RPC deadline expired",
            ));
        }
        if let RpcScope::Target { target_id, epoch } = &lineage.scope
            && !self
                .targets
                .get(target_id)
                .is_some_and(|target| target.epoch == *epoch)
        {
            return Err(HostError::new(
                "scope_ended",
                "the original Target document scope has retired",
            ));
        }
        Ok(())
    }
    fn resolve(
        &self,
        consumer: &str,
        caller: &str,
        generation: u64,
        capability: &CapabilityDescriptor,
        lineage: RpcLineage,
    ) -> Result<RpcRoute, HostError> {
        self.validate_lineage(&lineage)?;
        let principal = self
            .registry
            .issue_principal(consumer, generation, &lineage.scope.instance())
            .map_err(access_error)?;
        let lease = self
            .registry
            .resolve_capability(&principal, capability)
            .map_err(access_error)?;
        let provider_id = self
            .registry
            .invoke_endpoint(&principal, &lease, |provider, _| provider.to_owned())
            .map_err(access_error)?;
        let provider_generation = self
            .registry
            .provider_generation(&provider_id)
            .ok_or_else(stale)?;
        let (target_id, document_epoch) = lineage.scope.target().map_or_else(
            || (String::new(), 0),
            |(target, epoch)| (target.into(), epoch),
        );
        Ok(RpcRoute {
            principal,
            lease,
            provider_id,
            generation: provider_generation,
            capability: capability.clone(),
            caller: HostCapabilityCaller {
                plugin_id: caller.into(),
                generation,
                target_id,
                document_epoch,
            },
            lineage,
        })
    }
}

fn same_endpoint(left: &RendererEndpoint, right: &RendererEndpoint) -> bool {
    left.plugin_id == right.plugin_id
        && left.generation == right.generation
        && left.document_epoch == right.document_epoch
        && left.context_id == right.context_id
        && left.binding == right.binding
        && left.session.session_id() == right.session.session_id()
        && left.session.target_id() == right.session.target_id()
        && right.session.is_live()
}
fn registry_error(error: impl std::fmt::Display) -> HostError {
    HostError::new("dependency_conflict", error.to_string())
}
fn access_error(error: impl std::fmt::Display) -> HostError {
    HostError::new("capability_denied", error.to_string())
}
fn stale() -> HostError {
    HostError::new(
        "capability_denied",
        "the original provider or document registration has retired",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plugin(
        id: &str,
        generation: u64,
        provides: &[CapabilityDescriptor],
        requires: &[CapabilityDescriptor],
    ) -> LoadedPlugin {
        LoadedPlugin { authorization:None, manifest:crate::plugins::PluginManifest::parse(&json!({"schema":1,"id":id,"version":"1","host":{"entry":"host.js"},"provides":provides,"requires":requires,"permissions":["host.process"]}).to_string()).unwrap(), source:None, host:None, generation }
    }
    fn descriptor(scope: CapabilityScope) -> CapabilityDescriptor {
        CapabilityDescriptor::new("dev.rpc.kernel", 1, scope).unwrap()
    }
    fn attach(shared: &CoreRpcShared, owner: &str, generation: u64, session: &str) -> String {
        let permit = shared.reserve_raw_attach().unwrap();
        shared
            .track_raw_attach(owner, generation, "target-a", session, permit)
            .unwrap();
        shared
            .issue_handle(owner, generation, session, "frame-a".into())
            .unwrap()["handleId"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    #[test]
    fn runtime_routes_pin_generation_and_enforce_the_original_depth_and_registration() {
        let shared = CoreRpcShared::default();
        let capability = descriptor(CapabilityScope::Runtime);
        let consumer = plugin("dev.consumer", 1, &[], std::slice::from_ref(&capability));
        let provider = plugin("dev.provider", 1, std::slice::from_ref(&capability), &[]);
        shared
            .register_plugins(&[consumer.clone(), provider.clone()])
            .unwrap();
        let route = shared
            .resolve_host(
                &consumer,
                &capability,
                None,
                None,
                Instant::now() + Duration::from_secs(1),
            )
            .unwrap();
        assert_eq!(route.generation, 1);
        assert_eq!(route.caller.plugin_id, "dev.consumer");
        assert_eq!(route.lineage.scope, RpcScope::Runtime);
        let mut parent = route.lineage.clone();
        parent.depth = 8;
        assert_eq!(
            shared
                .resolve_host(
                    &consumer,
                    &capability,
                    None,
                    Some(&parent),
                    Instant::now() + Duration::from_secs(2)
                )
                .err()
                .unwrap()
                .code,
            "rpc_depth_limit"
        );
        let child = shared
            .resolve_host(
                &consumer,
                &capability,
                None,
                Some(&route.lineage),
                Instant::now() + Duration::from_secs(2),
            )
            .unwrap();
        assert_eq!(child.lineage.deadline, route.lineage.deadline);
        shared.retire_plugin("dev.provider", 1);
        shared
            .register_plugins(std::slice::from_ref(&provider))
            .unwrap();
        assert!(
            shared.validate(&route).is_err(),
            "same-generation replay must not revive the lease"
        );
        let mut next = provider;
        next.generation = 2;
        shared.register_plugins(&[next]).unwrap();
        assert_eq!(
            shared
                .resolve_host(
                    &consumer,
                    &capability,
                    None,
                    None,
                    Instant::now() + Duration::from_secs(1)
                )
                .unwrap()
                .generation,
            2
        );
        assert!(
            shared.validate(&route).is_err(),
            "a pending route cannot upgrade to the replacement"
        );
    }

    #[test]
    fn target_handles_bind_owner_generation_and_retire_runtime_consumers_on_navigation() {
        let shared = CoreRpcShared::default();
        let capability = descriptor(CapabilityScope::Runtime);
        let consumer = plugin("dev.consumer", 2, &[], std::slice::from_ref(&capability));
        let other = plugin("dev.other", 2, &[], std::slice::from_ref(&capability));
        let provider = plugin("dev.provider", 1, std::slice::from_ref(&capability), &[]);
        shared
            .register_plugins(&[consumer.clone(), other.clone(), provider])
            .unwrap();
        let handle = attach(&shared, "dev.consumer", 2, "session-a");
        assert_eq!(
            shared
                .resolve_host(
                    &other,
                    &capability,
                    Some(&handle),
                    None,
                    Instant::now() + Duration::from_secs(1)
                )
                .err()
                .unwrap()
                .code,
            "scope_denied"
        );
        assert!(shared.close_handle("dev.consumer", 1, &handle).is_err());
        let route = shared
            .resolve_host(
                &consumer,
                &capability,
                Some(&handle),
                None,
                Instant::now() + Duration::from_secs(1),
            )
            .unwrap();
        shared.observe(&CdpEvent {
            method: "Page.frameNavigated".into(),
            params: Some(json!({"frame":{"id":"frame-a"}})),
            session_id: Some("session-a".into()),
        });
        assert!(shared.validate(&route).is_err());
        assert!(
            shared
                .resolve_host(
                    &consumer,
                    &capability,
                    Some(&handle),
                    None,
                    Instant::now() + Duration::from_secs(1)
                )
                .is_err()
        );
        assert!(
            shared.owned_target("dev.consumer", 2, "session-a").is_ok(),
            "navigation retains Core's raw-session cleanup ownership"
        );
        let handle = shared
            .issue_handle("dev.consumer", 2, "session-a", "frame-a".into())
            .unwrap()["handleId"]
            .as_str()
            .unwrap()
            .to_owned();
        let next = shared
            .resolve_host(
                &consumer,
                &capability,
                Some(&handle),
                None,
                Instant::now() + Duration::from_secs(1),
            )
            .unwrap();
        shared.close_handle("dev.consumer", 2, &handle).unwrap();
        assert_eq!(
            shared.validate(&next).err().unwrap().code,
            "invocation_cancelled"
        );
        assert!(
            shared
                .resolve_host(
                    &consumer,
                    &capability,
                    None,
                    None,
                    Instant::now() + Duration::from_secs(1)
                )
                .is_ok()
        );
    }

    #[test]
    fn raw_attach_capacity_is_reserved_before_dispatch_and_survives_fail_closed_scope_loss() {
        let shared = CoreRpcShared::default();
        let mut reservations = (0..MAX_RAW_SESSIONS)
            .map(|_| shared.reserve_raw_attach().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            shared.reserve_raw_attach().err().unwrap().code,
            "scope_limit"
        );
        let first = reservations.pop().unwrap();
        shared
            .track_raw_attach("dev.owner", 1, "target-a", "session-a", first)
            .unwrap();
        assert!(shared.reserve_raw_attach().is_err());
        drop(reservations);
        shared
            .issue_handle("dev.owner", 1, "session-a", "frame-a".into())
            .unwrap();
        shared.invalidate_targets();
        assert!(shared.owned_target("dev.owner", 1, "session-a").is_ok());
        shared.retire_host_scopes("dev.owner", 1);
        assert_eq!(shared.take_cleanup_sessions("dev.owner", 1), ["session-a"]);
        assert!(!shared.has_cleanup_sessions("dev.owner", 1));
        let almost = (0..MAX_RAW_SESSIONS - 1)
            .map(|_| shared.reserve_raw_attach().unwrap())
            .collect::<Vec<_>>();
        assert!(
            shared.reserve_raw_attach().is_err(),
            "a dispatched detach still owns the session quota"
        );
        drop(almost);
        shared.retire_raw_session("session-a");
        let all = (0..MAX_RAW_SESSIONS)
            .map(|_| shared.reserve_raw_attach().unwrap())
            .collect::<Vec<_>>();
        assert!(shared.reserve_raw_attach().is_err());
        drop(all);
    }
}
