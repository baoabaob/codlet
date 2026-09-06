use std::cell::Cell;
use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as FmtWrite;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;

use crate::capabilities::{
    CapabilityAccessError, CapabilityDescriptor, CapabilityLease, CapabilityPrincipal,
    CapabilityRegistry, CapabilityRegistryError, CapabilityScopeInstance,
};
use crate::cdp::{
    CdpEvent, CdpEventStream, EventStreamError, TargetChange, TargetError, TargetSession,
};
use crate::plugins::{LoadedPlugin, ManifestError, PluginRegistry, RendererWorld, bundled_plugins};

const BOOTSTRAP_SOURCE: &str = include_str!("../bundled/runtime/bootstrap.js");
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_RENDERER_RPC_PAYLOAD_BYTES: usize = 1024 * 1024;
const MAX_RENDERER_RPC_METHOD_BYTES: usize = 256;
const MAX_RENDERER_RPC_PLUGIN_ID_BYTES: usize = 128;
const BUILTIN_HOST_PROVIDER_ID: &str = "codlet.core.host";
const BUILTIN_HOST_CAPABILITY_NAME: &str = "codlet.runtime.ping";
const BUILTIN_HOST_CAPABILITY_API: u32 = 1;
const BUILTIN_MANAGE_CAPABILITY_NAME: &str = "codlet.runtime.manage";
const BUILTIN_MANAGE_CAPABILITY_API: u32 = 1;
const RUNTIME_MANAGE_GRANT: &str = "runtime.manage";
const MAX_RENDERER_WAIT_DEPTH: usize = 8;

#[derive(Debug, Error)]
pub enum RendererError {
    #[error(transparent)]
    Manifest(#[from] ManifestError),
    #[error(transparent)]
    Capability(#[from] CapabilityRegistryError),
    #[error(transparent)]
    CapabilityAccess(#[from] CapabilityAccessError),
    #[error(transparent)]
    Target(#[from] TargetError),
    #[error("{method} returned invalid data: {message}")]
    InvalidResponse {
        method: &'static str,
        message: &'static str,
    },
    #[error("renderer bootstrap for plugin {plugin_id} rejected activation: {message}")]
    BootstrapRejected { plugin_id: String, message: String },
    #[error("plugin {plugin_id} rejected activation: {message}")]
    PluginRejected { plugin_id: String, message: String },
    #[error("plugin {0} requests a renderer world not implemented by M1")]
    UnsupportedWorld(String),
    #[error("renderer target {0} is already attached")]
    TargetAlreadyAttached(String),
    #[error("plugin {plugin_id} generation {generation} exceeds the renderer integer range")]
    InvalidGeneration { plugin_id: String, generation: u64 },
    #[error("Runtime.bindingCalled contained invalid data: {0}")]
    InvalidBindingEvent(&'static str),
    #[error("renderer provider {plugin_id} returned invalid endpoint data: {message}")]
    InvalidProviderResult { plugin_id: String, message: String },
    #[error("renderer binding response for plugin {plugin_id} was rejected: {message}")]
    BindingResponseRejected { plugin_id: String, message: String },
    #[error(transparent)]
    BindingEvents(#[from] EventStreamError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RendererBootstrapReport {
    pub target_id: String,
    pub plugin_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RendererDiagnostic {
    pub target_id: String,
    pub plugin_id: String,
    pub message: String,
}

pub struct RendererRuntime {
    plugins: Vec<LoadedPlugin>,
    plugin_registry: PluginRegistry,
    capabilities: CapabilityRegistry,
    sessions: HashMap<String, RendererSession>,
    diagnostics: Vec<RendererDiagnostic>,
    drive_deadline: Option<Instant>,
    drive_depth: usize,
    pending_actions: Vec<HostAction>,
}

struct RendererSession {
    session: TargetSession,
    plugins: Vec<ActivePlugin>,
    events: CdpEventStream,
}

#[derive(Clone)]
struct ActivePlugin {
    id: String,
    generation: u64,
    world_name: String,
    context_id: Option<u64>,
    binding_name: String,
    principal: CapabilityPrincipal,
    leases: BTreeMap<CapabilityDescriptor, CapabilityLease>,
    last_request_id: Cell<u64>,
    bootstrap_identifier: String,
    script_identifier: Option<String>,
    state: RendererPluginState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RendererPluginState {
    Activating,
    Ready,
    Active,
    Stopping,
}

type TargetAuthorization = (
    CapabilityPrincipal,
    BTreeMap<CapabilityDescriptor, CapabilityLease>,
);
type TargetAuthorizations = BTreeMap<String, TargetAuthorization>;

#[derive(Deserialize)]
struct LifecycleResult {
    ok: bool,
    error: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct BindingMessage {
    v: u32,
    #[serde(rename = "type")]
    message_type: String,
    #[serde(rename = "pluginId")]
    plugin_id: String,
    generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    id: Option<u64>,
    capability: CapabilityDescriptor,
    method: String,
    params: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderResult {
    ok: bool,
    #[serde(default)]
    value: Value,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Serialize)]
struct BindingResponse<'a> {
    v: u32,
    #[serde(rename = "type")]
    message_type: &'a str,
    id: u64,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<BindingResponseError<'a>>,
}

#[derive(Serialize)]
struct BindingResponseError<'a> {
    code: &'a str,
    message: String,
}

struct BindingCall {
    binding_name: String,
    execution_context_id: u64,
    payload: String,
}

#[derive(Debug)]
struct HostEndpointOutcome {
    value: Value,
    after_response: Option<HostAction>,
}

#[derive(Debug)]
struct HostEndpointFailure {
    code: &'static str,
    message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum HostAction {
    DisablePlugin { plugin_id: String },
}

impl RendererRuntime {
    pub fn bundled(plugin_registry: PluginRegistry) -> Result<Self, RendererError> {
        Self::new(bundled_plugins()?, plugin_registry)
    }

    pub fn new(
        plugins: Vec<LoadedPlugin>,
        plugin_registry: PluginRegistry,
    ) -> Result<Self, RendererError> {
        if let Some(plugin) = plugins
            .iter()
            .find(|plugin| plugin.generation > MAX_JAVASCRIPT_SAFE_INTEGER)
        {
            return Err(RendererError::InvalidGeneration {
                plugin_id: plugin.manifest.id.clone(),
                generation: plugin.generation,
            });
        }
        let (plugins, capabilities) = order_plugins(plugins)?;
        Ok(Self {
            plugins,
            plugin_registry,
            capabilities,
            sessions: HashMap::new(),
            diagnostics: Vec::new(),
            drive_deadline: None,
            drive_depth: 0,
            pending_actions: Vec::new(),
        })
    }

    pub fn attach(
        &mut self,
        session: &TargetSession,
    ) -> Result<RendererBootstrapReport, RendererError> {
        let target_id = session.target_id().to_owned();
        if self.sessions.contains_key(&target_id) {
            return Err(RendererError::TargetAlreadyAttached(target_id));
        }
        let scope = CapabilityScopeInstance::Target(target_id.clone());
        self.capabilities.activate_scope(scope.clone())?;
        let authorizations = match self.resolve_target_authorizations(&scope) {
            Ok(authorizations) => authorizations,
            Err(error) => {
                self.capabilities.deactivate_scope(&scope);
                return Err(error.into());
            }
        };
        let renderer_session = RendererSession {
            session: session.clone(),
            plugins: Vec::with_capacity(self.plugins.len()),
            events: session.subscribe_events(),
        };
        self.sessions.insert(target_id.clone(), renderer_session);
        if let Err(error) = self.install_target_plugins(&target_id, authorizations) {
            let _ = self.deactivate_target(&target_id);
            self.flush_host_actions();
            return Err(error);
        }
        let plugin_count = self
            .sessions
            .get(&target_id)
            .expect("installed renderer session must exist")
            .plugins
            .iter()
            .filter(|plugin| plugin.state == RendererPluginState::Active)
            .count();
        let report = RendererBootstrapReport {
            target_id: target_id.clone(),
            plugin_count,
        };
        self.flush_host_actions();
        Ok(report)
    }

    fn install_target_plugins(
        &mut self,
        target_id: &str,
        mut authorizations: TargetAuthorizations,
    ) -> Result<(), RendererError> {
        if let Some(plugin) = self
            .plugins
            .iter()
            .find(|plugin| plugin.manifest.renderer.world != RendererWorld::Isolated)
        {
            return Err(RendererError::UnsupportedWorld(plugin.manifest.id.clone()));
        }
        let catalog = self.plugins.clone();
        let session = self
            .sessions
            .get(target_id)
            .expect("installing renderer session must exist")
            .session
            .clone();

        for plugin in catalog {
            let world_name = renderer_world_name(&plugin);
            let context_id = current_isolated_context(&session, &world_name)?;
            let binding_name =
                renderer_binding_name(session.target_id(), session.session_id(), &plugin);
            add_renderer_binding(&session, &binding_name, &world_name)?;
            let bootstrap_identifier =
                match add_new_document_script(&session, BOOTSTRAP_SOURCE, &world_name) {
                    Ok(identifier) => identifier,
                    Err(error) => {
                        let _ = remove_renderer_binding(&session, &binding_name);
                        return Err(error);
                    }
                };
            if let Err(message) = evaluate_lifecycle(&session, BOOTSTRAP_SOURCE, context_id) {
                let _ = remove_new_document_script(&session, &bootstrap_identifier);
                let _ = remove_renderer_binding(&session, &binding_name);
                return Err(RendererError::BootstrapRejected {
                    plugin_id: plugin.manifest.id.clone(),
                    message,
                });
            }

            let (principal, leases) = authorizations
                .remove(&plugin.manifest.id)
                .expect("every ordered plugin must have host authorization");
            self.sessions
                .get_mut(target_id)
                .expect("installing renderer session must exist")
                .plugins
                .push(ActivePlugin {
                    id: plugin.manifest.id.clone(),
                    generation: plugin.generation,
                    world_name: world_name.clone(),
                    context_id: Some(context_id),
                    binding_name: binding_name.clone(),
                    principal,
                    leases,
                    last_request_id: Cell::new(0),
                    bootstrap_identifier,
                    script_identifier: None,
                    state: RendererPluginState::Activating,
                });

            let expression = activation_expression(&plugin, &binding_name);
            if let Err(message) = self
                .evaluate_with_binding_pump(target_id, &expression, context_id)
                .and_then(parse_lifecycle_result)
            {
                return Err(RendererError::PluginRejected {
                    plugin_id: plugin.manifest.id.clone(),
                    message,
                });
            }
            self.ensure_live_target(target_id).map_err(|message| {
                RendererError::PluginRejected {
                    plugin_id: plugin.manifest.id.clone(),
                    message,
                }
            })?;
            let candidate = self
                .sessions
                .get_mut(target_id)
                .expect("installing renderer session must exist")
                .plugins
                .iter_mut()
                .find(|candidate| {
                    candidate.id == plugin.manifest.id && candidate.generation == plugin.generation
                })
                .expect("ready renderer candidate must remain registered");
            candidate.state = RendererPluginState::Ready;

            let script_identifier = add_new_document_script(&session, &expression, &world_name)?;
            self.ensure_live_target(target_id).map_err(|message| {
                RendererError::PluginRejected {
                    plugin_id: plugin.manifest.id.clone(),
                    message,
                }
            })?;
            let candidate = self
                .sessions
                .get_mut(target_id)
                .expect("live session exists")
                .plugins
                .iter_mut()
                .find(|candidate| candidate.id == plugin.manifest.id)
                .expect("ready candidate exists");
            candidate.script_identifier = Some(script_identifier);
            candidate.state = RendererPluginState::Active;
        }
        assert!(
            authorizations.is_empty(),
            "every target authorization must be consumed exactly once"
        );
        Ok(())
    }

    fn ensure_live_target(&mut self, target_id: &str) -> Result<(), String> {
        if self
            .sessions
            .get(target_id)
            .is_some_and(|s| s.session.is_live())
        {
            return Ok(());
        }
        self.capabilities
            .deactivate_scope(&CapabilityScopeInstance::Target(target_id.to_owned()));
        self.sessions.remove(target_id);
        Err("renderer target session has ended".to_owned())
    }

    fn evaluate_with_binding_pump(
        &mut self,
        target_id: &str,
        expression: &str,
        context_id: u64,
    ) -> Result<Value, String> {
        self.ensure_live_target(target_id)?;
        if self.drive_depth >= MAX_RENDERER_WAIT_DEPTH {
            return Err(format!(
                "renderer RPC nested wait depth exceeds {MAX_RENDERER_WAIT_DEPTH}"
            ));
        }
        let session = self
            .sessions
            .get(target_id)
            .expect("live renderer session must exist")
            .session
            .clone();
        let previous_deadline = self.drive_deadline;
        let expires_at =
            previous_deadline.unwrap_or(session.request_deadline().map_err(|e| e.to_string())?);
        self.drive_deadline = Some(expires_at);
        self.drive_depth += 1;
        let result = self.drive_evaluation(
            target_id,
            &session.until(expires_at),
            expression,
            context_id,
        );
        self.drive_depth -= 1;
        self.drive_deadline = previous_deadline;
        result
    }

    fn drive_evaluation(
        &mut self,
        target_id: &str,
        session: &TargetSession,
        expression: &str,
        context_id: u64,
    ) -> Result<Value, String> {
        let mut request = session
            .start_evaluate_in_context(expression, Some(context_id))
            .map_err(|error| error.to_string())?;
        loop {
            let observed_activity = request.activity_epoch();
            self.ensure_live_target(target_id)?;
            if Instant::now() >= self.drive_deadline.expect("driven request has a deadline") {
                return Err(
                    "Runtime.evaluate exceeded its deadline (absolute renderer RPC budget)"
                        .to_owned(),
                );
            }
            if let Some(response) = request.try_response().map_err(|error| error.to_string())? {
                return Ok(response
                    .result
                    .expect("successful CDP response must contain result"));
            }
            let event = self
                .sessions
                .get(target_id)
                .expect("installing renderer session must exist")
                .events
                .recv_timeout(Duration::ZERO);
            match event {
                Ok(event) => {
                    self.handle_renderer_event(target_id, event)
                        .map_err(|error| error.to_string())?;
                }
                Err(EventStreamError::Timeout) => {
                    request.wait_for_activity(observed_activity);
                }
                Err(error) => return Err(error.to_string()),
            }
        }
    }

    pub fn apply_target_change(
        &mut self,
        change: TargetChange,
    ) -> Result<Option<RendererBootstrapReport>, RendererError> {
        match change {
            TargetChange::Attached(session) => self.attach(&session).map(Some),
            TargetChange::NavigatedAway(session) => {
                self.handle_navigation_away(&session)?;
                Ok(None)
            }
            TargetChange::SessionEnded {
                target_id,
                session_id,
            } => {
                self.handle_session_ended(&target_id, &session_id);
                Ok(None)
            }
        }
    }

    pub fn deactivate_target(&mut self, target_id: &str) -> Result<(), RendererError> {
        let scope = CapabilityScopeInstance::Target(target_id.to_owned());
        let plugins = self
            .sessions
            .get(target_id)
            .map(|s| {
                s.plugins
                    .iter()
                    .rev()
                    .map(|p| p.id.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut first_error = None;
        for plugin_id in plugins {
            if let Err(error) = self.deactivate_plugin(target_id, &plugin_id) {
                first_error.get_or_insert(error);
            }
        }
        self.capabilities.deactivate_scope(&scope);
        self.sessions.remove(target_id);
        self.flush_host_actions();
        first_error.map_or(Ok(()), Err)
    }

    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }

    pub fn plugin_count(&self) -> usize {
        self.plugins.len()
    }

    pub fn take_diagnostics(&mut self) -> Vec<RendererDiagnostic> {
        std::mem::take(&mut self.diagnostics)
    }

    pub fn pump_bindings(&mut self) -> Result<usize, RendererError> {
        self.pump_bindings_with_timeout(Duration::ZERO)
    }

    pub fn pump_bindings_with_timeout(
        &mut self,
        timeout: Duration,
    ) -> Result<usize, RendererError> {
        let mut handled = 0;
        let expires_at = Instant::now()
            .checked_add(timeout)
            .unwrap_or_else(Instant::now);
        let mut waiting_for_first_event = true;
        let mut target_ids: Vec<_> = self.sessions.keys().cloned().collect();
        target_ids.sort();
        for target_id in target_ids {
            loop {
                let wait = if waiting_for_first_event {
                    expires_at.saturating_duration_since(Instant::now())
                } else {
                    Duration::ZERO
                };
                let event = self.sessions.get(&target_id);
                let Some(session) = event else {
                    break;
                };
                if !session.session.is_live() {
                    let _ = self.ensure_live_target(&target_id);
                    break;
                }
                let event = session.events.recv_timeout(wait);
                match event {
                    Ok(event) => {
                        waiting_for_first_event = false;
                        if self.handle_renderer_event(&target_id, event)? {
                            handled += 1;
                        }
                        self.flush_host_actions();
                    }
                    Err(EventStreamError::Timeout) => break,
                    Err(error) => return Err(error.into()),
                }
            }
        }
        Ok(handled)
    }

    fn resolve_target_authorizations(
        &self,
        scope: &CapabilityScopeInstance,
    ) -> Result<TargetAuthorizations, CapabilityAccessError> {
        self.plugins
            .iter()
            .map(|plugin| {
                let principal = self.capabilities.issue_principal(
                    &plugin.manifest.id,
                    plugin.generation,
                    scope,
                )?;
                let leases: BTreeMap<CapabilityDescriptor, CapabilityLease> = plugin
                    .manifest
                    .requires
                    .iter()
                    .map(|requirement| {
                        self.capabilities
                            .resolve_capability(&principal, requirement)
                            .map(|lease| (requirement.clone(), lease))
                    })
                    .collect::<Result<_, _>>()?;
                for lease in leases.values() {
                    self.capabilities.invoke(&principal, lease, || ())?;
                }
                Ok((plugin.manifest.id.clone(), (principal, leases)))
            })
            .collect()
    }

    fn handle_navigation_away(&mut self, departed: &TargetSession) -> Result<(), RendererError> {
        let target_id = departed.target_id();
        let matches_current = self
            .sessions
            .get(target_id)
            .is_some_and(|session| session.session.session_id() == departed.session_id());
        let session = if matches_current {
            self.capabilities
                .deactivate_scope(&CapabilityScopeInstance::Target(target_id.to_owned()));
            Some(
                self.sessions
                    .remove(target_id)
                    .expect("matching renderer session must still exist"),
            )
        } else {
            return Ok(());
        };

        let mut first_error =
            session.and_then(|session| session.remove_persisted_resources().err());
        if let Err(error) = departed.detach() {
            first_error.get_or_insert(error.into());
        }
        first_error.map_or(Ok(()), Err)
    }

    fn handle_session_ended(&mut self, target_id: &str, session_id: &str) {
        if self
            .sessions
            .get(target_id)
            .is_some_and(|session| session.session.session_id() == session_id)
        {
            self.capabilities
                .deactivate_scope(&CapabilityScopeInstance::Target(target_id.to_owned()));
            self.sessions.remove(target_id);
        }
    }

    fn handle_renderer_event(
        &mut self,
        target_id: &str,
        event: CdpEvent,
    ) -> Result<bool, RendererError> {
        if self.ensure_live_target(target_id).is_err() {
            return Ok(false);
        }
        match event.method.as_str() {
            "Runtime.executionContextCreated" => {
                let context = event
                    .params
                    .as_ref()
                    .and_then(|params| params.get("context"))
                    .and_then(Value::as_object)
                    .ok_or(RendererError::InvalidBindingEvent(
                        "context is not an object",
                    ))?;
                // Default and main-world contexts have no executionContextName. They
                // are unrelated to the plugin bindings and must not abort the pump.
                let Some(name_value) = context.get("name") else {
                    return Ok(false);
                };
                let name = name_value
                    .as_str()
                    .ok_or(RendererError::InvalidBindingEvent(
                        "context.name is not a string",
                    ))?;
                let context_id = context.get("id").and_then(Value::as_u64).ok_or(
                    RendererError::InvalidBindingEvent("context.id is not an unsigned integer"),
                )?;
                if let Some(plugin) = self
                    .sessions
                    .get_mut(target_id)
                    .expect("renderer target disappeared while handling its event")
                    .plugins
                    .iter_mut()
                    .find(|plugin| {
                        plugin.world_name == name && plugin.state != RendererPluginState::Stopping
                    })
                {
                    plugin.context_id = Some(context_id);
                }
                Ok(false)
            }
            "Runtime.executionContextDestroyed" => {
                let context_id = event
                    .params
                    .as_ref()
                    .and_then(|params| params.get("executionContextId"))
                    .and_then(Value::as_u64)
                    .ok_or(RendererError::InvalidBindingEvent(
                        "executionContextId is not an unsigned integer",
                    ))?;
                for plugin in &mut self
                    .sessions
                    .get_mut(target_id)
                    .expect("renderer target disappeared while handling its event")
                    .plugins
                {
                    if plugin.context_id == Some(context_id) {
                        plugin.context_id = None;
                    }
                }
                Ok(false)
            }
            "Runtime.executionContextsCleared" => {
                for plugin in &mut self
                    .sessions
                    .get_mut(target_id)
                    .expect("renderer target disappeared while handling its event")
                    .plugins
                {
                    plugin.context_id = None;
                }
                Ok(false)
            }
            "Runtime.bindingCalled" => self.route_binding_call(target_id, &event),
            _ => Ok(false),
        }
    }

    fn route_binding_call(
        &mut self,
        target_id: &str,
        event: &CdpEvent,
    ) -> Result<bool, RendererError> {
        let previous_deadline = self.drive_deadline;
        if previous_deadline.is_none() {
            self.drive_deadline = Some(self.sessions[target_id].session.request_deadline()?);
        }
        let result = self.route_binding_call_inner(target_id, event);
        self.drive_deadline = previous_deadline;
        match result {
            Ok(handled) => Ok(handled),
            Err(error) => {
                self.diagnostics.push(RendererDiagnostic {
                    target_id: target_id.to_owned(),
                    plugin_id: "renderer-rpc".to_owned(),
                    message: error.to_string(),
                });
                Ok(true)
            }
        }
    }

    fn route_binding_call_inner(
        &mut self,
        target_id: &str,
        event: &CdpEvent,
    ) -> Result<bool, RendererError> {
        let call = parse_binding_call(event)?;
        let session = self
            .sessions
            .get(target_id)
            .expect("renderer target disappeared while routing its binding");
        let target_session = session
            .session
            .until(self.drive_deadline.expect("binding route has a deadline"));
        if event.session_id.as_deref() != Some(session.session.session_id()) {
            // CdpClient normally filters session events before they reach this
            // router. Keep the identity check here as a second, local guard.
            return Ok(false);
        }
        let Some(consumer) = session
            .plugins
            .iter()
            .find(|plugin| plugin.binding_name == call.binding_name)
        else {
            // Only our namespace is actionable. Other Runtime bindings may be
            // installed by the page or by DevTools and must pass through.
            if !call.binding_name.starts_with("codlet_rpc_v1_") {
                return Ok(false);
            }
            if let (Some(id), Some(context_id)) = (
                binding_request_id(&call.payload),
                session.plugins.iter().find_map(|plugin| {
                    (plugin.context_id == Some(call.execution_context_id))
                        .then_some(call.execution_context_id)
                }),
            ) {
                let response = binding_error(
                    id,
                    "unknown_binding",
                    "renderer RPC binding is not active for this target session",
                );
                deliver_raw_binding_response(
                    &target_session,
                    &call.binding_name,
                    context_id,
                    &response,
                )?;
                return Ok(true);
            }
            return Ok(false);
        };
        let Some(consumer_context_id) = consumer.context_id else {
            // A binding event from a destroyed execution context cannot be
            // routed or answered safely.
            return Ok(false);
        };
        if call.execution_context_id != consumer_context_id {
            if let Some(id) = binding_request_id(&call.payload) {
                let response = binding_error(
                    id,
                    "context_mismatch",
                    "renderer RPC binding was called from the wrong execution context",
                );
                deliver_binding_response(
                    &target_session,
                    consumer,
                    consumer_context_id,
                    &response,
                )?;
                return Ok(true);
            }
            return Ok(false);
        }
        let request = match parse_binding_message(&call.payload) {
            Ok(request) => request,
            Err(message) => {
                if let Some(id) = binding_request_id(&call.payload) {
                    let response = binding_error(id, "invalid_request", &message);
                    deliver_binding_response(
                        &target_session,
                        consumer,
                        consumer_context_id,
                        &response,
                    )?;
                    return Ok(true);
                }
                return Ok(false);
            }
        };
        if request.plugin_id != consumer.id || request.generation != consumer.generation {
            if let Some(id) = request.id {
                let response = binding_error(
                    id,
                    "stale_generation",
                    "renderer RPC principal generation is stale",
                );
                deliver_binding_response(
                    &target_session,
                    consumer,
                    consumer_context_id,
                    &response,
                )?;
            }
            return Ok(true);
        }
        if let Some(id) = request.id {
            let last_request_id = consumer.last_request_id.get();
            if id <= last_request_id {
                let response = binding_error(
                    id,
                    "duplicate_request_id",
                    "renderer RPC request id is duplicate or out of order for this plugin generation",
                );
                deliver_binding_response(
                    &target_session,
                    consumer,
                    consumer_context_id,
                    &response,
                )?;
                return Ok(true);
            }
            consumer.last_request_id.set(id);
        }
        let Some(lease) = consumer.leases.get(&request.capability) else {
            if let Some(id) = request.id {
                let response = binding_error(
                    id,
                    "capability_denied",
                    "capability was not resolved for this plugin generation and target",
                );
                deliver_binding_response(
                    &target_session,
                    consumer,
                    consumer_context_id,
                    &response,
                )?;
            }
            return Ok(true);
        };
        let authorization = self.capabilities.invoke_endpoint(
            &consumer.principal,
            lease,
            |provider_id, descriptor| (provider_id.to_owned(), descriptor.clone()),
        );
        let consumer = consumer.clone();
        let mut after_response = None;
        let outcome = match authorization {
            Ok((provider_id, descriptor)) => {
                if provider_id == BUILTIN_HOST_PROVIDER_ID {
                    match invoke_builtin_host_endpoint(
                        &mut self.plugin_registry,
                        &self.plugins,
                        &consumer.id,
                        consumer.principal.has_grant(RUNTIME_MANAGE_GRANT),
                        consumer.state == RendererPluginState::Active,
                        &descriptor,
                        &request,
                    ) {
                        Ok(host) => {
                            after_response = host.after_response;
                            Ok(host.value)
                        }
                        Err(error) => Err((error.code, error.message)),
                    }
                } else {
                    let provider = self.sessions.get(target_id).and_then(|session| {
                        session
                            .plugins
                            .iter()
                            .find(|plugin| {
                                plugin.id == provider_id
                                    && plugin.state == RendererPluginState::Active
                            })
                            .cloned()
                    });
                    match provider.and_then(|provider| {
                        provider.context_id.map(|context_id| (provider, context_id))
                    }) {
                        Some((provider, provider_context_id)) => match self
                            .evaluate_with_binding_pump(
                                target_id,
                                &provider_invocation_expression(&provider.binding_name, &request),
                                provider_context_id,
                            )
                            .and_then(parse_provider_result)
                        {
                            Ok(value) => Ok(value),
                            Err(message) => Err(("provider_error", message)),
                        },
                        None => Err((
                            "provider_unavailable",
                            "capability provider has no active renderer context".to_owned(),
                        )),
                    }
                }
            }
            Err(error) => Err(("capability_denied", error.to_string())),
        };
        // Nested calls may destroy the target or remove a consumer. Never answer
        // through a snapshot unless its original binding/context still exists.
        if self.ensure_live_target(target_id).is_err()
            || !self.sessions.get(target_id).is_some_and(|s| {
                s.plugins.iter().any(|p| {
                    p.binding_name == consumer.binding_name
                        && p.context_id == Some(consumer_context_id)
                })
            })
        {
            if let Some(action) = after_response {
                self.queue_host_action(action);
            }
            return Ok(true);
        }
        let response_delivery_error = if let Some(id) = request.id {
            let response = match outcome {
                Ok(value) => binding_success(id, value),
                Err((code, message)) => binding_error(id, code, &message),
            };
            deliver_binding_response(&target_session, &consumer, consumer_context_id, &response)
                .err()
        } else {
            None
        };
        if let Some(error) = response_delivery_error {
            self.diagnostics.push(RendererDiagnostic {
                target_id: target_id.to_owned(),
                plugin_id: consumer.id.clone(),
                message: format!("renderer RPC response delivery failed: {error}"),
            });
        }
        if let Some(action) = after_response {
            self.queue_host_action(action);
        }
        Ok(true)
    }

    fn queue_host_action(&mut self, action: HostAction) {
        let HostAction::DisablePlugin { plugin_id } = &action;
        for session in self.sessions.values_mut() {
            for plugin in &mut session.plugins {
                if plugin.id == *plugin_id {
                    plugin.state = RendererPluginState::Stopping;
                }
            }
        }
        if !self.pending_actions.contains(&action) {
            self.pending_actions.push(action);
        }
    }

    fn flush_host_actions(&mut self) {
        if self.drive_depth > 0 || self.drive_deadline.is_some() {
            return;
        }
        for action in std::mem::take(&mut self.pending_actions) {
            self.apply_host_action(action);
        }
    }

    fn apply_host_action(&mut self, action: HostAction) {
        match action {
            HostAction::DisablePlugin { plugin_id } => {
                let mut target_ids: Vec<_> = self.sessions.keys().cloned().collect();
                target_ids.sort();
                for target_id in target_ids {
                    if let Err(error) = self.deactivate_plugin(&target_id, &plugin_id) {
                        self.diagnostics.push(RendererDiagnostic {
                            target_id,
                            plugin_id: plugin_id.clone(),
                            message: error.to_string(),
                        });
                    }
                }
                let _ = self.capabilities.unregister_provider(&plugin_id);
                self.plugins
                    .retain(|plugin| plugin.manifest.id != plugin_id);
            }
        }
    }
}

impl RendererRuntime {
    fn deactivate_plugin(&mut self, target_id: &str, plugin_id: &str) -> Result<(), RendererError> {
        if self.ensure_live_target(target_id).is_err() {
            return Ok(());
        }
        let session = &mut self
            .sessions
            .get_mut(target_id)
            .expect("live session exists");
        let Some(plugin) = session
            .plugins
            .iter_mut()
            .find(|plugin| plugin.id == plugin_id)
        else {
            return Ok(());
        };
        let was_activating = plugin.state == RendererPluginState::Activating;
        plugin.state = RendererPluginState::Stopping;
        let mut plugin = plugin.clone();
        let target_session = session.session.clone();
        let previous_deadline = self.drive_deadline;
        self.drive_deadline = Some(previous_deadline.unwrap_or(target_session.request_deadline()?));
        let lifecycle_session = target_session.until(
            self.drive_deadline
                .expect("cleanup lifecycle has a deadline"),
        );
        let mut first_error = None;
        if !was_activating {
            match current_isolated_context(&lifecycle_session, &plugin.world_name) {
                Ok(context_id) => {
                    plugin.context_id = Some(context_id);
                    if let Some(current) = self
                        .sessions
                        .get_mut(target_id)
                        .and_then(|s| s.plugins.iter_mut().find(|p| p.id == plugin_id))
                    {
                        current.context_id = Some(context_id);
                    }
                    if let Err(message) = self
                        .evaluate_with_binding_pump(
                            target_id,
                            &deactivation_expression(&plugin.id, plugin.generation),
                            context_id,
                        )
                        .and_then(parse_lifecycle_result)
                    {
                        first_error = Some(RendererError::PluginRejected {
                            plugin_id: plugin.id.clone(),
                            message,
                        });
                    }
                }
                Err(error) => {
                    first_error = Some(error);
                }
            }
        }
        self.drive_deadline = previous_deadline;
        // Retirement is a separate, bounded cleanup phase. It never pumps plugin
        // code and cannot renew the deadline of an abandoned nested evaluation.
        let cleanup_session = target_session.until(target_session.request_deadline()?);
        if (was_activating || first_error.is_some())
            && target_session.is_live()
            && let Some(context_id) = plugin.context_id
        {
            let binding = serde_json::to_string(&plugin.binding_name).expect("binding is UTF-8");
            let _ = cleanup_session.evaluate_in_context(
                &format!("globalThis.__codletRendererV1.__rpcClose({binding})"),
                Some(context_id),
            );
        }
        if target_session.is_live() {
            if let Some(identifier) = &plugin.script_identifier
                && let Err(error) = remove_new_document_script(&cleanup_session, identifier)
            {
                first_error.get_or_insert(error);
            }
            if let Err(error) =
                remove_new_document_script(&cleanup_session, &plugin.bootstrap_identifier)
            {
                first_error.get_or_insert(error);
            }
            if let Err(error) = remove_renderer_binding(&cleanup_session, &plugin.binding_name) {
                first_error.get_or_insert(error);
            }
        }
        if let Some(session) = self.sessions.get_mut(target_id) {
            session
                .plugins
                .retain(|p| p.binding_name != plugin.binding_name);
        }
        first_error.map_or(Ok(()), Err)
    }
}

impl RendererSession {
    fn remove_persisted_resources(&self) -> Result<(), RendererError> {
        let mut first_error = None;
        for plugin in self.plugins.iter().rev() {
            if let Some(identifier) = &plugin.script_identifier
                && let Err(error) = remove_new_document_script(&self.session, identifier)
            {
                first_error.get_or_insert(error);
            }
            if let Err(error) =
                remove_new_document_script(&self.session, &plugin.bootstrap_identifier)
            {
                first_error.get_or_insert(error);
            }
            if let Err(error) = remove_renderer_binding(&self.session, &plugin.binding_name) {
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }
}

fn current_isolated_context(
    session: &TargetSession,
    world_name: &str,
) -> Result<u64, RendererError> {
    let frame_tree = session.request("Page.getFrameTree", None)?;
    let frame_id = frame_tree
        .pointer("/frameTree/frame/id")
        .and_then(Value::as_str)
        .ok_or(RendererError::InvalidResponse {
            method: "Page.getFrameTree",
            message: "frameTree.frame.id is not a string",
        })?;
    let result = session.request(
        "Page.createIsolatedWorld",
        Some(json!({"frameId": frame_id, "worldName": world_name})),
    )?;
    result
        .get("executionContextId")
        .and_then(Value::as_u64)
        .ok_or(RendererError::InvalidResponse {
            method: "Page.createIsolatedWorld",
            message: "executionContextId is not an unsigned integer",
        })
}

fn add_new_document_script(
    session: &TargetSession,
    expression: &str,
    world_name: &str,
) -> Result<String, RendererError> {
    let source = new_document_expression(expression);
    let result = session.request(
        "Page.addScriptToEvaluateOnNewDocument",
        Some(json!({"source": source, "worldName": world_name})),
    )?;
    result
        .get("identifier")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(RendererError::InvalidResponse {
            method: "Page.addScriptToEvaluateOnNewDocument",
            message: "identifier is not a string",
        })
}

fn remove_new_document_script(
    session: &TargetSession,
    identifier: &str,
) -> Result<(), RendererError> {
    session.request(
        "Page.removeScriptToEvaluateOnNewDocument",
        Some(json!({"identifier": identifier})),
    )?;
    Ok(())
}

fn add_renderer_binding(
    session: &TargetSession,
    binding_name: &str,
    world_name: &str,
) -> Result<(), RendererError> {
    session.request(
        "Runtime.addBinding",
        Some(json!({
            "name": binding_name,
            "executionContextName": world_name
        })),
    )?;
    Ok(())
}

fn remove_renderer_binding(
    session: &TargetSession,
    binding_name: &str,
) -> Result<(), RendererError> {
    session.request("Runtime.removeBinding", Some(json!({"name": binding_name})))?;
    Ok(())
}

fn evaluate_lifecycle(
    session: &TargetSession,
    expression: &str,
    context_id: u64,
) -> Result<(), String> {
    let result = session
        .evaluate_in_context(expression, Some(context_id))
        .map_err(|error| error.to_string())?;
    parse_lifecycle_result(result)
}

fn parse_lifecycle_result(result: Value) -> Result<(), String> {
    if result.get("exceptionDetails").is_some() {
        return Err("Runtime.evaluate reported exceptionDetails".to_owned());
    }
    let value = result
        .pointer("/result/value")
        .cloned()
        .ok_or_else(|| "Runtime.evaluate did not return a value".to_owned())?;
    let lifecycle: LifecycleResult = serde_json::from_value(value)
        .map_err(|error| format!("Runtime.evaluate returned invalid lifecycle data: {error}"))?;
    if lifecycle.ok {
        Ok(())
    } else {
        Err(lifecycle
            .error
            .unwrap_or_else(|| "renderer lifecycle returned ok=false".to_owned()))
    }
}

fn activation_expression(plugin: &LoadedPlugin, binding_name: &str) -> String {
    let metadata = json!({
        "id": plugin.manifest.id,
        "version": plugin.manifest.version,
        "generation": plugin.generation,
        "binding": binding_name,
        "provides": plugin.manifest.provides,
        "requires": plugin.manifest.requires
    });
    format!(
        r#"(async () => {{
            try {{
                const runtime = globalThis.__codletRendererV1;
                if (!runtime || runtime.abi !== 1) return {{ ok: false, error: 'renderer bootstrap is unavailable' }};
                const module = {{ exports: {{}} }};
                ((module, exports) => {{
{source}
                }})(module, module.exports);
                return await runtime.activate({metadata}, module.exports);
            }} catch (error) {{
                return {{ ok: false, error: error instanceof Error ? error.message : String(error) }};
            }}
        }})()
//# sourceURL=codlet://{id}/renderer.js"#,
        source = plugin.source,
        metadata = metadata,
        id = plugin.manifest.id
    )
}

fn deactivation_expression(plugin_id: &str, generation: u64) -> String {
    let plugin_id = serde_json::to_string(plugin_id).expect("string serialization cannot fail");
    format!("globalThis.__codletRendererV1.deactivate({plugin_id}, {generation})")
}

fn new_document_expression(expression: &str) -> String {
    format!(
        r#"(() => {{
            if (globalThis.top !== globalThis) return;
            const url = new URL(globalThis.location.href);
            if (url.protocol !== 'app:' || url.host !== '-' || url.pathname !== '/index.html') return;
            void ({expression});
        }})()"#
    )
}

fn renderer_world_name(plugin: &LoadedPlugin) -> String {
    format!(
        "codlet.plugin.{}.g{}",
        plugin.manifest.id, plugin.generation
    )
}

fn renderer_binding_name(target_id: &str, session_id: &str, plugin: &LoadedPlugin) -> String {
    format!(
        "codlet_rpc_v1_p_{}_t_{}_s_{}_g_{}",
        hex_component(&plugin.manifest.id),
        hex_component(target_id),
        hex_component(session_id),
        plugin.generation
    )
}

fn hex_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len() * 2);
    for byte in value.bytes() {
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

fn parse_binding_call(event: &CdpEvent) -> Result<BindingCall, RendererError> {
    let params = event.params.as_ref().and_then(Value::as_object).ok_or(
        RendererError::InvalidBindingEvent("params is not an object"),
    )?;
    let binding_name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or(RendererError::InvalidBindingEvent("name is not a string"))?;
    let payload =
        params
            .get("payload")
            .and_then(Value::as_str)
            .ok_or(RendererError::InvalidBindingEvent(
                "payload is not a string",
            ))?;
    let execution_context_id = params
        .get("executionContextId")
        .and_then(Value::as_u64)
        .ok_or(RendererError::InvalidBindingEvent(
            "executionContextId is not an unsigned integer",
        ))?;
    Ok(BindingCall {
        binding_name: binding_name.to_owned(),
        execution_context_id,
        payload: payload.to_owned(),
    })
}

fn parse_binding_message(payload: &str) -> Result<BindingMessage, String> {
    if payload.len() > MAX_RENDERER_RPC_PAYLOAD_BYTES {
        return Err(format!(
            "renderer RPC payload exceeds {MAX_RENDERER_RPC_PAYLOAD_BYTES} bytes"
        ));
    }
    let request: BindingMessage = serde_json::from_str(payload)
        .map_err(|error| format!("renderer RPC request is not valid JSON: {error}"))?;
    if request.v != 1 {
        return Err(format!("unsupported renderer RPC version {}", request.v));
    }
    if request.plugin_id.is_empty() {
        return Err("renderer RPC pluginId must be non-empty".to_owned());
    }
    if request.plugin_id.len() > MAX_RENDERER_RPC_PLUGIN_ID_BYTES {
        return Err(format!(
            "renderer RPC pluginId exceeds {MAX_RENDERER_RPC_PLUGIN_ID_BYTES} bytes"
        ));
    }
    if request
        .id
        .is_some_and(|id| !(1..=MAX_JAVASCRIPT_SAFE_INTEGER).contains(&id))
    {
        return Err(format!(
            "renderer RPC request id must be between 1 and {MAX_JAVASCRIPT_SAFE_INTEGER}"
        ));
    }
    match request.message_type.as_str() {
        "request" if request.id.is_some_and(|id| id > 0) => {}
        "notification" if request.id.is_none() => {}
        "request" => return Err("renderer RPC request id must be positive".to_owned()),
        "notification" => {
            return Err("renderer RPC notification must not contain an id".to_owned());
        }
        _ => return Err("renderer RPC message type is not recognized".to_owned()),
    }
    if request.method.is_empty() {
        return Err("renderer RPC method must be non-empty".to_owned());
    }
    if request.method.len() > MAX_RENDERER_RPC_METHOD_BYTES {
        return Err(format!(
            "renderer RPC method exceeds {MAX_RENDERER_RPC_METHOD_BYTES} bytes"
        ));
    }
    Ok(request)
}

fn binding_request_id(payload: &str) -> Option<u64> {
    if payload.len() > MAX_RENDERER_RPC_PAYLOAD_BYTES {
        return None;
    }
    serde_json::from_str::<Value>(payload)
        .ok()?
        .get("id")
        .and_then(Value::as_u64)
        .filter(|id| (1..=MAX_JAVASCRIPT_SAFE_INTEGER).contains(id))
}

fn binding_success(id: u64, result: Value) -> BindingResponse<'static> {
    BindingResponse {
        v: 1,
        message_type: "response",
        id,
        ok: true,
        result: Some(result),
        error: None,
    }
}

fn binding_error(id: u64, code: &'static str, message: &str) -> BindingResponse<'static> {
    BindingResponse {
        v: 1,
        message_type: "response",
        id,
        ok: false,
        result: None,
        error: Some(BindingResponseError {
            code,
            message: message.to_owned(),
        }),
    }
}

fn provider_invocation_expression(binding_name: &str, request: &BindingMessage) -> String {
    let binding = serde_json::to_string(binding_name).expect("binding name is valid UTF-8");
    let request =
        serde_json::to_string(request).expect("renderer request serialization cannot fail");
    format!("globalThis.__codletRendererV1.__rpcInvoke({binding}, {request})")
}

fn parse_provider_result(value: Value) -> Result<Value, String> {
    if value.get("exceptionDetails").is_some() {
        return Err("provider Runtime.evaluate reported exceptionDetails".to_owned());
    }
    let returned = value
        .pointer("/result/value")
        .cloned()
        .ok_or_else(|| "provider Runtime.evaluate did not return a value".to_owned())?;
    let has_value = returned.get("value").is_some();
    let result: ProviderResult = serde_json::from_value(returned)
        .map_err(|error| format!("provider endpoint returned invalid data: {error}"))?;
    if result.ok {
        if has_value {
            Ok(result.value)
        } else {
            Err("provider endpoint returned ok=true without a value".to_owned())
        }
    } else {
        Err(result
            .error
            .unwrap_or_else(|| "provider endpoint returned ok=false".to_owned()))
    }
}

fn invoke_builtin_host_endpoint(
    plugin_registry: &mut PluginRegistry,
    plugins: &[LoadedPlugin],
    caller_id: &str,
    has_runtime_manage_grant: bool,
    caller_active: bool,
    descriptor: &CapabilityDescriptor,
    request: &BindingMessage,
) -> Result<HostEndpointOutcome, HostEndpointFailure> {
    match descriptor.name.as_str() {
        BUILTIN_HOST_CAPABILITY_NAME
            if descriptor.api.get() == BUILTIN_HOST_CAPABILITY_API
                && descriptor.scope == crate::capabilities::CapabilityScope::Target =>
        {
            if request.method != "ping" {
                return Err(host_failure(
                    "method_not_found",
                    "host capability method is not registered",
                ));
            }
            if !request.params.is_null() {
                return Err(host_failure(
                    "invalid_params",
                    "host ping expects null params",
                ));
            }
            Ok(HostEndpointOutcome {
                value: json!({"pong": true, "abi": 1}),
                after_response: None,
            })
        }
        BUILTIN_MANAGE_CAPABILITY_NAME
            if descriptor.api.get() == BUILTIN_MANAGE_CAPABILITY_API
                && descriptor.scope == crate::capabilities::CapabilityScope::Target =>
        {
            if !has_runtime_manage_grant {
                return Err(host_failure(
                    "permission_denied",
                    "runtime.manage permission was not granted to this plugin generation",
                ));
            }
            match request.method.as_str() {
                "list" => {
                    if !request.params.is_null() {
                        return Err(host_failure(
                            "invalid_params",
                            "runtime manage list expects null params",
                        ));
                    }
                    let catalog = bundled_plugins()
                        .expect("bundled plugin manifests were validated when the runtime started");
                    let plugins = catalog
                        .into_iter()
                        .map(|plugin| {
                            let id = plugin.manifest.id;
                            let enabled = plugin_registry.is_enabled(&id);
                            let active = plugins.iter().any(|active| active.manifest.id == id);
                            json!({
                                "id": id,
                                "version": plugin.manifest.version,
                                "enabled": enabled,
                                "active": active
                            })
                        })
                        .collect::<Vec<_>>();
                    Ok(HostEndpointOutcome {
                        value: json!({"plugins": plugins}),
                        after_response: None,
                    })
                }
                "disableSelf" => {
                    if !caller_active {
                        return Err(host_failure(
                            "plugin_not_active",
                            "runtime manage disableSelf requires an active calling plugin",
                        ));
                    }
                    if request.id.is_none() {
                        return Err(host_failure(
                            "request_required",
                            "runtime manage disableSelf requires a request response",
                        ));
                    }
                    if !request.params.is_null() {
                        return Err(host_failure(
                            "invalid_params",
                            "runtime manage disableSelf expects null params",
                        ));
                    }
                    let caller = plugins
                        .iter()
                        .find(|plugin| plugin.manifest.id == caller_id)
                        .ok_or_else(|| {
                            host_failure(
                                "plugin_not_active",
                                "the calling plugin is not active in the runtime catalog",
                            )
                        })?;
                    if let Some(dependent) =
                        plugins.iter().find(|plugin| {
                            plugin.manifest.id != caller_id
                                && plugin.manifest.requires.iter().any(|requirement| {
                                    caller.manifest.provides.contains(requirement)
                                })
                        })
                    {
                        return Err(host_failure(
                            "dependency_conflict",
                            format!(
                                "plugin {} still depends on a capability provided by {caller_id}",
                                dependent.manifest.id
                            ),
                        ));
                    }

                    let mut candidate = plugin_registry.clone();
                    candidate
                        .set_enabled(caller_id, false)
                        .map_err(|error| host_failure("registry_error", error.to_string()))?;
                    candidate
                        .save()
                        .map_err(|error| host_failure("registry_error", error.to_string()))?;
                    *plugin_registry = candidate;
                    Ok(HostEndpointOutcome {
                        value: json!({"pluginId": caller_id, "enabled": false}),
                        after_response: Some(HostAction::DisablePlugin {
                            plugin_id: caller_id.to_owned(),
                        }),
                    })
                }
                _ => Err(host_failure(
                    "method_not_found",
                    "runtime manage capability method is not registered",
                )),
            }
        }
        _ => Err(host_failure(
            "host_error",
            "host capability descriptor is not recognized",
        )),
    }
}

fn host_failure(code: &'static str, message: impl Into<String>) -> HostEndpointFailure {
    HostEndpointFailure {
        code,
        message: message.into(),
    }
}

fn deliver_binding_response(
    session: &TargetSession,
    consumer: &ActivePlugin,
    context_id: u64,
    response: &BindingResponse<'_>,
) -> Result<(), RendererError> {
    deliver_raw_binding_response(session, &consumer.binding_name, context_id, response)
}

fn deliver_raw_binding_response(
    session: &TargetSession,
    binding_name: &str,
    context_id: u64,
    response: &BindingResponse<'_>,
) -> Result<(), RendererError> {
    let response =
        serde_json::to_string(response).map_err(|error| RendererError::InvalidProviderResult {
            plugin_id: binding_name.to_owned(),
            message: format!("failed to serialize renderer RPC response: {error}"),
        })?;
    let binding = serde_json::to_string(binding_name).expect("binding name is valid UTF-8");
    let response = serde_json::to_string(&response).expect("response JSON is valid UTF-8");
    let expression =
        format!("globalThis.__codletRendererV1.__rpcReceive({binding}, JSON.parse({response}))");
    let result = session
        .evaluate_in_context(&expression, Some(context_id))
        .map_err(RendererError::Target)?;
    if result.get("exceptionDetails").is_some() {
        return Err(RendererError::BindingResponseRejected {
            plugin_id: binding_name.to_owned(),
            message: "consumer Runtime.evaluate reported exceptionDetails".to_owned(),
        });
    }
    if result.pointer("/result/value/ok") != Some(&Value::Bool(true)) {
        return Err(RendererError::BindingResponseRejected {
            plugin_id: binding_name.to_owned(),
            message: "consumer did not accept the RPC response".to_owned(),
        });
    }
    Ok(())
}

fn order_plugins(
    plugins: Vec<LoadedPlugin>,
) -> Result<(Vec<LoadedPlugin>, CapabilityRegistry), CapabilityRegistryError> {
    let mut registry = CapabilityRegistry::new();
    let builtin_host_capabilities = builtin_host_capabilities();
    registry.register_provider(
        BUILTIN_HOST_PROVIDER_ID,
        1,
        &builtin_host_capabilities,
        &[],
        &[],
    )?;
    for plugin in &plugins {
        let grants: Vec<_> = plugin
            .manifest
            .permissions
            .iter()
            .map(|permission| permission.as_str().to_owned())
            .collect();
        registry.register_provider(
            &plugin.manifest.id,
            plugin.generation,
            &plugin.manifest.provides,
            &plugin.manifest.requires,
            &grants,
        )?;
    }
    let order = registry.resolve_activation_order()?;
    let mut plugins_by_id: BTreeMap<_, _> = plugins
        .into_iter()
        .map(|plugin| (plugin.manifest.id.clone(), plugin))
        .collect();
    let plugins = order
        .into_iter()
        .filter_map(|plugin_id| plugins_by_id.remove(&plugin_id))
        .collect();
    Ok((plugins, registry))
}

fn builtin_host_capability() -> CapabilityDescriptor {
    CapabilityDescriptor::new(
        BUILTIN_HOST_CAPABILITY_NAME,
        BUILTIN_HOST_CAPABILITY_API,
        crate::capabilities::CapabilityScope::Target,
    )
    .expect("the built-in host capability descriptor is valid")
}

fn builtin_host_capabilities() -> [CapabilityDescriptor; 2] {
    [builtin_host_capability(), builtin_manage_capability()]
}

fn builtin_manage_capability() -> CapabilityDescriptor {
    CapabilityDescriptor::new(
        BUILTIN_MANAGE_CAPABILITY_NAME,
        BUILTIN_MANAGE_CAPABILITY_API,
        crate::capabilities::CapabilityScope::Target,
    )
    .expect("the built-in runtime manage capability descriptor is valid")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capabilities::{CapabilityRegistryError, CapabilityScope};
    use crate::plugins::{
        PluginManifest, bundled_codex_ui_adapter, bundled_codlet, bundled_plugins,
    };
    use tempfile::{TempDir, tempdir};

    fn test_registry() -> (TempDir, PluginRegistry) {
        let directory = tempdir().unwrap();
        let registry = PluginRegistry::load(directory.path().join("config.json")).unwrap();
        (directory, registry)
    }

    #[test]
    fn generated_plugin_script_carries_generation_and_main_frame_guard() {
        let plugin = bundled_codlet().unwrap();
        let activation = activation_expression(&plugin, "codlet_rpc_test");
        assert!(activation.contains("runtime.activate"));
        assert!(activation.contains("\"generation\":1"));
        assert!(activation.contains("module.exports"));

        let persisted = new_document_expression(&activation);
        assert!(persisted.contains("globalThis.top !== globalThis"));
        assert!(persisted.contains("url.protocol !== 'app:'"));
        assert!(persisted.contains("url.pathname !== '/index.html'"));
        assert!(BOOTSTRAP_SOURCE.contains("runExclusive"));
        assert!(!activation.contains("CapabilityPrincipal"));
        assert!(activation.contains("\"binding\""));
        assert!(activation.contains("\"provides\""));
        assert!(activation.contains("\"requires\""));
        assert!(!BOOTSTRAP_SOURCE.contains("context.capabilities"));
    }

    #[test]
    fn bundled_capability_graph_orders_adapter_before_gui() {
        let (ordered, _) = order_plugins(bundled_plugins().unwrap()).unwrap();
        assert_eq!(
            ordered
                .iter()
                .map(|plugin| plugin.manifest.id.as_str())
                .collect::<Vec<_>>(),
            ["codex.ui.adapter", "codlet"]
        );
    }

    #[test]
    fn every_plugin_generation_gets_a_distinct_world() {
        let plugins = bundled_plugins().unwrap();
        assert_eq!(
            renderer_world_name(&plugins[0]),
            "codlet.plugin.codex.ui.adapter.g1"
        );
        assert_eq!(renderer_world_name(&plugins[1]), "codlet.plugin.codlet.g1");
        assert_ne!(
            renderer_world_name(&plugins[0]),
            renderer_world_name(&plugins[1])
        );
    }

    #[test]
    fn binding_namespace_is_unique_per_plugin_target_session_and_generation() {
        let plugin = bundled_codlet().unwrap();
        let first = renderer_binding_name("target-a", "session-a", &plugin);
        let mut replacement = plugin.clone();
        replacement.generation = 2;

        let variants = [
            first.clone(),
            renderer_binding_name("target-b", "session-a", &plugin),
            renderer_binding_name("target-a", "session-b", &plugin),
            renderer_binding_name("target-a", "session-a", &replacement),
        ];
        assert_eq!(
            variants
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            4
        );
        assert!(variants.iter().all(|binding| {
            binding.starts_with("codlet_rpc_v1_")
                && binding
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        }));
    }

    #[test]
    fn binding_messages_reject_ids_outside_javascript_safe_range() {
        let payload = format!(
            r#"{{"v":1,"type":"request","pluginId":"dev.consumer","generation":1,"id":{},"capability":{{"name":"renderer.example","api":1,"scope":"target"}},"method":"call","params":null}}"#,
            MAX_JAVASCRIPT_SAFE_INTEGER + 1
        );
        let error = parse_binding_message(&payload)
            .err()
            .expect("an unsafe request id must be rejected");
        assert!(error.contains("between 1 and"));
    }

    #[test]
    fn renderer_runtime_rejects_an_unresolved_capability() {
        let manifest = PluginManifest::parse(
            r#"{
                "schema": 1,
                "id": "dev.consumer",
                "version": "1",
                "renderer": {"entry": "dist/renderer.js", "world": "isolated"},
                "requires": [
                    {"name": "runtime.missing", "api": 1, "scope": "runtime"}
                ]
            }"#,
        )
        .unwrap();
        let plugin = LoadedPlugin {
            manifest,
            source: "module.exports = {};".to_owned(),
            generation: 1,
        };
        let (_registry_directory, registry) = test_registry();

        assert!(matches!(
            RendererRuntime::new(vec![plugin], registry),
            Err(RendererError::Capability(
                CapabilityRegistryError::MissingRequirement { requirement, .. }
            )) if requirement.scope == CapabilityScope::Runtime
        ));
    }

    #[test]
    fn renderer_runtime_rejects_generation_above_javascript_safe_integer() {
        let mut plugin = bundled_codex_ui_adapter().unwrap();
        plugin.generation = 9_007_199_254_740_992;
        let (_registry_directory, registry) = test_registry();

        assert!(matches!(
            RendererRuntime::new(vec![plugin], registry),
            Err(RendererError::InvalidGeneration {
                plugin_id,
                generation: 9_007_199_254_740_992,
            }) if plugin_id == "codex.ui.adapter"
        ));
    }

    #[test]
    fn built_in_host_ping_is_strict_and_side_effect_free() {
        let (_registry_directory, mut registry) = test_registry();
        let descriptor = builtin_host_capability();
        let request = BindingMessage {
            v: 1,
            message_type: "request".to_owned(),
            plugin_id: "dev.consumer".to_owned(),
            generation: 1,
            id: Some(1),
            capability: descriptor.clone(),
            method: "ping".to_owned(),
            params: Value::Null,
        };
        let result = invoke_builtin_host_endpoint(
            &mut registry,
            &[],
            "dev.consumer",
            false,
            true,
            &descriptor,
            &request,
        )
        .unwrap();
        assert_eq!(result.value, json!({"pong": true, "abi": 1}));
        assert!(result.after_response.is_none());

        let mut unknown_method = request;
        unknown_method.method = "anything-else".to_owned();
        assert_eq!(
            invoke_builtin_host_endpoint(
                &mut registry,
                &[],
                "dev.consumer",
                false,
                true,
                &descriptor,
                &unknown_method,
            )
            .unwrap_err()
            .code,
            "method_not_found"
        );
    }

    #[test]
    fn runtime_manage_persists_before_scheduling_self_disable() {
        let (registry_directory, mut registry) = test_registry();
        let path = registry.path().to_owned();
        let plugins = bundled_plugins().unwrap();
        let descriptor = builtin_manage_capability();
        let request = BindingMessage {
            v: 1,
            message_type: "request".to_owned(),
            plugin_id: "codlet".to_owned(),
            generation: 1,
            id: Some(1),
            capability: descriptor.clone(),
            method: "disableSelf".to_owned(),
            params: Value::Null,
        };

        let denied = invoke_builtin_host_endpoint(
            &mut registry,
            &plugins,
            "codlet",
            false,
            true,
            &descriptor,
            &request,
        )
        .unwrap_err();
        assert_eq!(denied.code, "permission_denied");
        assert!(!path.exists());

        let result = invoke_builtin_host_endpoint(
            &mut registry,
            &plugins,
            "codlet",
            true,
            true,
            &descriptor,
            &request,
        )
        .unwrap();
        assert_eq!(
            result.value,
            json!({"pluginId": "codlet", "enabled": false})
        );
        assert_eq!(
            result.after_response,
            Some(HostAction::DisablePlugin {
                plugin_id: "codlet".to_owned()
            })
        );
        assert!(!PluginRegistry::load(&path).unwrap().is_enabled("codlet"));
        drop(registry_directory);
    }

    #[test]
    fn host_requirement_is_resolved_without_exposing_a_renderer_provider() {
        let manifest = PluginManifest::parse(
            r#"{
                "schema": 1,
                "id": "dev.consumer",
                "version": "1",
                "renderer": {"entry": "dist/renderer.js", "world": "isolated"},
                "requires": [
                    {"name": "codlet.runtime.ping", "api": 1, "scope": "target"}
                ]
            }"#,
        )
        .unwrap();
        let (ordered, _) = order_plugins(vec![LoadedPlugin {
            manifest,
            source: "module.exports = {};".to_owned(),
            generation: 1,
        }])
        .unwrap();
        assert_eq!(
            ordered
                .iter()
                .map(|plugin| plugin.manifest.id.as_str())
                .collect::<Vec<_>>(),
            ["dev.consumer"]
        );
    }

    #[test]
    fn renderer_rpc_payload_limit_is_enforced_before_json_parsing() {
        let payload = "{".repeat(MAX_RENDERER_RPC_PAYLOAD_BYTES + 1);
        let error = parse_binding_message(&payload)
            .err()
            .expect("an oversized payload must be rejected");
        assert!(error.contains("payload exceeds"));
    }
}
