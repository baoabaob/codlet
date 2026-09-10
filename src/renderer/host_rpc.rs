//! Asynchronous renderer-to-host capability calls. The renderer owns caller,
//! lease and document checks; the managed process owner owns execution and the
//! same absolute deadline. Neither wait path needs another thread.

use super::*;
use crate::capabilities::host_provider_plugin_id;

#[cfg(windows)]
use crate::cdp::CdpRequest;
#[cfg(windows)]
use crate::host_runtime::{
    HostCapabilityClient, HostCapabilityOperation, RendererCall, RendererEndpoint, RpcRoute,
};
#[cfg(windows)]
use crate::plugin_host::HostError;

type Admission = Result<(), (&'static str, String)>;

#[derive(Default)]
pub(super) struct HostRpcBridge {
    registration_error: Option<String>,
    #[cfg(windows)]
    client: Option<HostCapabilityClient>,
    #[cfg(windows)]
    pending: Vec<PendingCall>,
    #[cfg(windows)]
    direct: Vec<DirectInvocation>,
}

#[derive(Default)]
pub(super) struct ScopedCall {
    #[cfg(windows)]
    inner: Option<RendererCall>,
}

#[cfg(windows)]
struct DirectInvocation {
    endpoint: RendererEndpoint,
    token: String,
    route: RpcRoute,
    cancel: Option<CdpRequest>,
    cancelled: bool,
}

#[cfg(windows)]
const MAX_PENDING: usize = 16;
#[cfg(windows)]
const MAX_PER_BINDING: usize = 4;

#[cfg(windows)]
struct PendingCall {
    target_id: String,
    session_id: String,
    document_epoch: u64,
    consumer: ActivePlugin,
    lease: CapabilityLease,
    provider_id: String,
    provider_generation: u64,
    capability: CapabilityDescriptor,
    request_id: Option<u64>,
    deadline: Instant,
    phase: Option<Phase>,
    scope: RendererCall,
}

#[cfg(windows)]
enum Phase {
    Invoking(HostCapabilityOperation),
    Delivering { request: CdpRequest, success: bool },
}

impl RendererRuntime {
    #[cfg(windows)]
    pub fn set_host_capability_client(&mut self, client: HostCapabilityClient) {
        // Changing the owned transport cannot transfer pending calls to it.
        self.host_rpc.pending.clear();
        self.host_rpc.registration_error = client
            .shared
            .register_plugins(&self.logical_plugins())
            .err()
            .map(|error| error.to_string());
        self.host_rpc.client = Some(client);
        for target in self.sessions.keys() {
            self.publish_rpc_target(target);
            self.publish_rpc_renderers(target);
        }
    }

    pub(crate) fn register_rpc_plugins(
        &self,
        plugins: &[LoadedPlugin],
    ) -> Result<(), RendererError> {
        if let Some(message) = &self.host_rpc.registration_error {
            return Err(RendererError::PluginRejected {
                plugin_id: "core-rpc".into(),
                message: message.clone(),
            });
        }
        #[cfg(windows)]
        if let Some(client) = &self.host_rpc.client {
            client.shared.register_plugins(plugins).map_err(|error| {
                RendererError::PluginRejected {
                    plugin_id: plugins
                        .first()
                        .map_or_else(|| "core-rpc".into(), |plugin| plugin.manifest.id.clone()),
                    message: error.to_string(),
                }
            })?;
        }
        #[cfg(not(windows))]
        let _ = plugins;
        Ok(())
    }

    pub(super) fn retire_rpc_plugin(&self, id: &str, generation: u64) {
        #[cfg(windows)]
        if let Some(client) = &self.host_rpc.client {
            client.shared.retire_plugin(id, generation);
        }
        #[cfg(not(windows))]
        let _ = (id, generation);
    }

    pub(super) fn publish_rpc_target(&self, target: &str) {
        #[cfg(windows)]
        if let (Some(client), Some(session)) = (&self.host_rpc.client, self.sessions.get(target)) {
            let _ = client
                .shared
                .publish_target(&session.session, session.document_epoch);
        }
        #[cfg(not(windows))]
        let _ = target;
    }

    pub(super) fn publish_rpc_renderers(&self, target: &str) {
        #[cfg(windows)]
        if let (Some(client), Some(session)) = (&self.host_rpc.client, self.sessions.get(target)) {
            for plugin in &session.plugins {
                if matches!(
                    plugin.state,
                    RendererPluginState::Ready | RendererPluginState::Active
                ) && plugin.activation_confirmed
                    && !session.recovery_pending
                {
                    if let Some(endpoint) = self.rpc_endpoint(target, plugin) {
                        let _ = client.shared.publish_renderer(endpoint);
                    }
                } else {
                    client.shared.retire_renderer(target, Some(&plugin.id));
                }
            }
        }
        #[cfg(not(windows))]
        let _ = target;
    }

    pub(super) fn retire_rpc_renderer(&self, target: &str, id: Option<&str>) {
        #[cfg(windows)]
        if let Some(client) = &self.host_rpc.client {
            client.shared.retire_renderer(target, id);
        }
        #[cfg(not(windows))]
        let _ = (target, id);
    }

    #[cfg(windows)]
    fn rpc_endpoint(&self, target: &str, plugin: &ActivePlugin) -> Option<RendererEndpoint> {
        let session = self.sessions.get(target)?;
        Some(RendererEndpoint {
            session: session.session.clone(),
            plugin_id: plugin.id.clone(),
            generation: plugin.generation,
            document_epoch: session.document_epoch,
            context_id: plugin.context_id?,
            binding: plugin.binding_name.clone(),
            authorization: plugin.authorization.clone(),
            registry_path: self.plugin_registry.path().to_owned(),
        })
    }

    pub(super) fn renderer_authority_current(&self, plugin: &ActivePlugin) -> bool {
        self.renderer_authority_status(plugin).is_ok()
    }

    pub(super) fn renderer_authority_status(
        &self,
        plugin: &ActivePlugin,
    ) -> Result<(), (&'static str, String)> {
        let Some(expected) = plugin.authorization.as_ref() else {
            return Ok(());
        };
        let registry = PluginRegistry::load(self.plugin_registry.path())
            .map_err(|error| ("registry_error", error.to_string()))?;
        if registry.local_plugins().get(&plugin.id) != Some(expected) {
            return Err((
                "authorization_revoked",
                "the caller renderer's complete trust record changed".into(),
            ));
        }
        Ok(())
    }

    pub(super) fn native_rpc_ready(
        &self,
        id: &str,
        generation: u64,
    ) -> Option<Result<bool, String>> {
        #[cfg(windows)]
        {
            self.host_rpc.client.as_ref().map(|client| {
                client
                    .shared
                    .host_ready(id, generation)
                    .map_err(|error| error.to_string())
            })
        }
        #[cfg(not(windows))]
        {
            let _ = (id, generation);
            None
        }
    }

    pub(super) fn prepare_scoped_call(
        &self,
        target: &str,
        consumer: &ActivePlugin,
        request: &BindingMessage,
    ) -> Result<ScopedCall, (&'static str, String)> {
        #[cfg(windows)]
        if let Some(client) = &self.host_rpc.client {
            let endpoint = self.rpc_endpoint(target, consumer).ok_or_else(|| {
                (
                    "target_ended",
                    "the caller renderer realm has retired".into(),
                )
            })?;
            let deadline = self
                .drive_deadline
                .unwrap_or_else(|| Instant::now() + Duration::from_secs(15))
                .min(Instant::now() + Duration::from_millis(request.timeout_ms.unwrap_or(15_000)));
            let call = client
                .shared
                .begin_renderer_call(
                    &endpoint,
                    &request.capability,
                    request.parent_token.as_deref(),
                    request.id,
                    deadline,
                )
                .map_err(|error| (error.code, error.message))?;
            return Ok(ScopedCall { inner: Some(call) });
        }
        #[cfg(not(windows))]
        let _ = (target, consumer, request);
        if request.parent_token.is_some() {
            return Err((
                "invocation_cancelled",
                "Core RPC lineage is unavailable".into(),
            ));
        }
        Ok(ScopedCall::default())
    }

    pub(super) fn cancel_scoped_call(&mut self, target: &str, consumer: &ActivePlugin, id: u64) {
        #[cfg(windows)]
        {
            if let (Some(client), Some(endpoint)) =
                (&self.host_rpc.client, self.rpc_endpoint(target, consumer))
            {
                client.shared.cancel_renderer_call(&endpoint, id);
            }
            self.host_rpc.pending.retain(|call| {
                call.target_id != target
                    || call.consumer.binding_name != consumer.binding_name
                    || call.request_id != Some(id)
            });
        }
        #[cfg(not(windows))]
        let _ = (target, consumer, id);
    }

    pub(super) fn scoped_call_current(
        &self,
        scope: &ScopedCall,
    ) -> Result<(), (&'static str, String)> {
        #[cfg(windows)]
        if let (Some(client), Some(call)) = (&self.host_rpc.client, &scope.inner) {
            return client
                .shared
                .validate(&call.route)
                .map_err(|error| (error.code, error.message));
        }
        #[cfg(not(windows))]
        let _ = scope;
        Ok(())
    }

    pub(super) fn invoke_scoped_renderer(
        &mut self,
        target: &str,
        provider: &ActivePlugin,
        request: &BindingMessage,
        scope: &ScopedCall,
    ) -> Result<Value, String> {
        #[cfg(windows)]
        if let (Some(client), Some(call)) = (self.host_rpc.client.clone(), &scope.inner) {
            let endpoint = self
                .rpc_endpoint(target, provider)
                .ok_or_else(|| "the original renderer endpoint has retired".to_owned())?;
            client
                .shared
                .validate(&call.route)
                .map_err(|error| error.to_string())?;
            if !client.shared.endpoint_is_current(&endpoint) {
                return Err("the original renderer endpoint is not Ready".into());
            }
            if !endpoint.authority_is_current() {
                return Err(
                    "authorization_revoked: the renderer provider's complete trust record changed"
                        .into(),
                );
            }
            let token = client
                .shared
                .begin_renderer_invocation(&endpoint, call.route.lineage.clone())
                .map_err(|error| error.to_string())?;
            let mut envelope = serde_json::to_value(request).expect("binding request is JSON");
            envelope["coreInvocation"] = json!({"token":token,"caller":call.route.caller,"scope":call.route.lineage.scope,"depth":call.route.lineage.depth,"remainingMs":call.route.lineage.deadline.saturating_duration_since(Instant::now()).as_millis()});
            let expression = format!(
                "globalThis.__codletRendererV1.__rpcInvoke({}, {})",
                serde_json::to_string(&endpoint.binding).unwrap(),
                envelope
            );
            self.host_rpc.direct.push(DirectInvocation {
                endpoint: endpoint.clone(),
                token: token.clone(),
                route: call.route.clone(),
                cancel: None,
                cancelled: false,
            });
            let previous = self.drive_deadline;
            self.drive_deadline = Some(previous.map_or(call.route.lineage.deadline, |end| {
                end.min(call.route.lineage.deadline)
            }));
            let result = self
                .evaluate_with_binding_pump(target, &expression, endpoint.context_id)
                .and_then(parse_provider_result);
            self.drive_deadline = previous;
            self.host_rpc
                .direct
                .retain(|invocation| invocation.token != token);
            client.shared.end_renderer_invocation(&token);
            client
                .shared
                .validate(&call.route)
                .map_err(|error| error.to_string())?;
            if !endpoint.authority_is_current() {
                return Err("authorization_revoked: the renderer provider's complete trust record changed before delivery".into());
            }
            return result;
        }
        #[cfg(not(windows))]
        let _ = scope;
        if !self.renderer_authority_current(provider) {
            return Err(
                "authorization_revoked: the renderer provider's complete trust record changed"
                    .into(),
            );
        }
        self.evaluate_with_binding_pump(
            target,
            &provider_invocation_expression(&provider.binding_name, request),
            provider
                .context_id
                .ok_or_else(|| "renderer context retired".to_owned())?,
        )
        .and_then(parse_provider_result)
    }

    pub fn pending_host_call_count(&self) -> usize {
        #[cfg(windows)]
        {
            self.host_rpc.pending.len()
        }
        #[cfg(not(windows))]
        {
            0
        }
    }

    pub(super) fn has_pending_host_capabilities(&self) -> bool {
        self.pending_host_call_count() != 0
    }

    pub(super) fn cancel_host_capabilities_for(
        &mut self,
        target_id: &str,
        plugin_id: Option<&str>,
    ) {
        self.retire_rpc_renderer(target_id, plugin_id);
        #[cfg(windows)]
        self.host_rpc.pending.retain(|call| {
            call.target_id != target_id || plugin_id.is_some_and(|id| call.consumer.id != id)
        });
        #[cfg(not(windows))]
        let _ = (target_id, plugin_id);
    }

    #[cfg(not(windows))]
    pub(super) fn queue_host_capability(
        &mut self,
        _target_id: &str,
        _consumer: &ActivePlugin,
        _lease: &CapabilityLease,
        provider_id: &str,
        _request: &BindingMessage,
        _scope: &mut ScopedCall,
    ) -> Option<Admission> {
        host_provider_plugin_id(provider_id).map(|_| {
            Err((
                "host_runtime_unavailable",
                "Managed Host execution is unavailable on this platform.".into(),
            ))
        })
    }

    #[cfg(windows)]
    pub(super) fn queue_host_capability(
        &mut self,
        target_id: &str,
        consumer: &ActivePlugin,
        lease: &CapabilityLease,
        provider_id: &str,
        request: &BindingMessage,
        scope: &mut ScopedCall,
    ) -> Option<Admission> {
        host_provider_plugin_id(provider_id)?;
        Some(
            self.admit_host_call(target_id, consumer, lease, provider_id, request, scope)
                .map_err(|error| (error.code, error.message)),
        )
    }

    #[cfg(windows)]
    fn admit_host_call(
        &mut self,
        target_id: &str,
        consumer: &ActivePlugin,
        lease: &CapabilityLease,
        provider_id: &str,
        request: &BindingMessage,
        scope: &mut ScopedCall,
    ) -> Result<(), HostError> {
        if self.host_rpc.pending.len() >= MAX_PENDING
            || self
                .host_rpc
                .pending
                .iter()
                .filter(|call| {
                    call.target_id == target_id
                        && call.consumer.binding_name == consumer.binding_name
                })
                .count()
                >= MAX_PER_BINDING
        {
            return Err(HostError::new(
                "request_limit",
                "Too many pending Host calls for this renderer binding or runtime.",
            ));
        }
        let client = self.host_rpc.client.as_ref().ok_or_else(|| {
            HostError::new(
                "host_runtime_unavailable",
                "The managed Host executor is unavailable.",
            )
        })?;
        // Read the exact registry registration authorized by this lease. A fresh
        // process observation must never upgrade an old caller to another owner.
        let provider_generation = self
            .capabilities
            .provider_generation(provider_id)
            .ok_or_else(|| {
                HostError::new(
                    "capability_denied",
                    "The authorized Host provider registration has retired.",
                )
            })?;
        let session = self
            .sessions
            .get(target_id)
            .filter(|session| session.session.is_live() && !session.recovery_pending)
            .ok_or_else(|| HostError::new("target_ended", "The renderer document has retired."))?;
        let parent_deadline = self.drive_deadline.unwrap_or(
            session
                .session
                .request_deadline()
                .map_err(|error| HostError::new("target_ended", error.to_string()))?,
        );
        let deadline = parent_deadline
            .min(Instant::now() + Duration::from_millis(request.timeout_ms.unwrap_or(15_000)));
        let scope = scope.inner.take().ok_or_else(|| {
            HostError::new(
                "capability_denied",
                "Core did not authenticate this renderer call",
            )
        })?;
        if scope.route.provider_id != provider_id || scope.route.generation != provider_generation {
            return Err(HostError::new(
                "stale_generation",
                "The Core route no longer matches the renderer's original provider lease.",
            ));
        }
        let deadline = deadline.min(scope.route.lineage.deadline);
        let operation = client.begin_routed(
            scope.route.clone(),
            request.method.clone(),
            request.params.clone(),
        )?;
        self.host_rpc.pending.push(PendingCall {
            target_id: target_id.into(),
            session_id: session.session.session_id().into(),
            document_epoch: session.document_epoch,
            consumer: consumer.clone(),
            lease: lease.clone(),
            provider_id: provider_id.into(),
            provider_generation,
            capability: request.capability.clone(),
            request_id: request.id,
            deadline,
            phase: Some(Phase::Invoking(operation)),
            scope,
        });
        Ok(())
    }

    pub(super) fn poll_host_capabilities(&mut self) {
        #[cfg(windows)]
        {
            if let Some(client) = &self.host_rpc.client {
                for invocation in &mut self.host_rpc.direct {
                    if !invocation.cancelled
                        && (client.shared.validate(&invocation.route).is_err()
                            || !client.shared.endpoint_is_current(&invocation.endpoint))
                    {
                        invocation.cancelled = true;
                        client.shared.end_renderer_invocation(&invocation.token);
                        let expression = format!(
                            "globalThis.__codletRendererV1.__rpcCancel({}, {})",
                            serde_json::to_string(&invocation.endpoint.binding).unwrap(),
                            serde_json::to_string(&invocation.token).unwrap()
                        );
                        invocation.cancel = invocation
                            .endpoint
                            .session
                            .until(Instant::now() + Duration::from_millis(250))
                            .start_evaluate_in_context(
                                &expression,
                                Some(invocation.endpoint.context_id),
                            )
                            .ok();
                    }
                    if invocation
                        .cancel
                        .as_mut()
                        .is_some_and(|request| !matches!(request.try_response(), Ok(None)))
                    {
                        invocation.cancel = None;
                    }
                }
            }
            // Taking the bounded list avoids borrowing the bridge while issuing
            // CDP deliveries or inspecting current renderer/registry ownership.
            let calls = std::mem::take(&mut self.host_rpc.pending);
            for call in calls {
                if let Some(pending) = self.advance_host_call(call) {
                    self.host_rpc.pending.push(pending);
                }
            }
        }
    }

    #[cfg(windows)]
    fn caller_is_current(&self, call: &PendingCall) -> bool {
        self.sessions.get(&call.target_id).is_some_and(|session| {
            session.session.is_live()
                && !session.recovery_pending
                && session.session.session_id() == call.session_id
                && session.document_epoch == call.document_epoch
                && session.plugins.iter().any(|current| {
                    current.id == call.consumer.id
                        && current.generation == call.consumer.generation
                        && current.binding_name == call.consumer.binding_name
                        && current.context_id.is_some()
                        && current.context_id == call.consumer.context_id
                        && current.principal == call.consumer.principal
                })
        })
    }

    #[cfg(windows)]
    fn provider_is_current(&self, call: &PendingCall) -> bool {
        self.host_rpc
            .client
            .as_ref()
            .is_some_and(|client| client.shared.validate(&call.scope.route).is_ok())
            && self.capabilities.provider_generation(&call.provider_id)
                == Some(call.provider_generation)
            && self
                .capabilities
                .invoke_endpoint(
                    &call.consumer.principal,
                    &call.lease,
                    |provider, capability| {
                        provider == call.provider_id && capability == &call.capability
                    },
                )
                .unwrap_or(false)
    }

    #[cfg(windows)]
    fn advance_host_call(&mut self, mut call: PendingCall) -> Option<PendingCall> {
        if !self.caller_is_current(&call) {
            return None; // Drop cancels the invocation or an unsent CDP delivery.
        }
        if Instant::now() >= call.deadline {
            self.host_call_diagnostic(&call, "The original Host RPC deadline expired.");
            return None;
        }
        match call
            .phase
            .take()
            .expect("a retained Host call has one phase")
        {
            Phase::Invoking(mut operation) => {
                if !self.provider_is_current(&call) {
                    drop(operation);
                    return self.begin_host_reply(
                        call,
                        Err(HostError::new(
                            "capability_denied",
                            "The original Host capability lease has retired.",
                        )),
                    );
                }
                match operation.try_result() {
                    Some(result) => {
                        let result = if self.renderer_authority_current(&call.consumer) {
                            result
                        } else {
                            Err(HostError::new(
                                "authorization_revoked",
                                "the caller renderer's complete trust record changed before delivery",
                            ))
                        };
                        self.begin_host_reply(call, result)
                    }
                    None => {
                        call.phase = Some(Phase::Invoking(operation));
                        Some(call)
                    }
                }
            }
            Phase::Delivering {
                mut request,
                success,
            } => {
                if success && !self.provider_is_current(&call) {
                    return None;
                }
                match request.try_response() {
                    Ok(Some(response)) => {
                        let result = response
                            .result
                            .expect("successful CDP response contains a result");
                        if let Err(error) =
                            check_binding_response(&call.consumer.binding_name, &result)
                        {
                            self.host_call_diagnostic(&call, &error.to_string());
                        }
                        None
                    }
                    Ok(None) => {
                        call.phase = Some(Phase::Delivering { request, success });
                        Some(call)
                    }
                    Err(error) => {
                        self.host_call_diagnostic(&call, &error.to_string());
                        None
                    }
                }
            }
        }
    }

    #[cfg(windows)]
    fn begin_host_reply(
        &mut self,
        mut call: PendingCall,
        result: Result<Value, HostError>,
    ) -> Option<PendingCall> {
        let Some(id) = call.request_id else {
            // Notifications still occupy bounded execution resources until the
            // endpoint completes, but do not produce renderer response frames.
            if let Err(error) = result {
                self.host_call_diagnostic(&call, &error.to_string());
            }
            return None;
        };
        let success = result.is_ok();
        let response = match result {
            Ok(value) => binding_success(id, value),
            Err(error) => binding_error(id, error.code, &error.message),
        };
        let delivery = binding_response_expression(&call.consumer.binding_name, &response)
            .and_then(|expression| {
                self.sessions[&call.target_id]
                    .session
                    .until(call.deadline)
                    .start_evaluate_in_context(&expression, call.consumer.context_id)
                    .map_err(RendererError::from)
            });
        match delivery {
            Ok(request) => {
                call.phase = Some(Phase::Delivering { request, success });
                Some(call)
            }
            Err(error) => {
                self.host_call_diagnostic(&call, &error.to_string());
                None
            }
        }
    }

    #[cfg(windows)]
    fn host_call_diagnostic(&mut self, call: &PendingCall, message: &str) {
        self.diagnostics.push(RendererDiagnostic {
            target_id: call.target_id.clone(),
            plugin_id: call.consumer.id.clone(),
            message: format!("Host capability {}: {message}", call.capability),
        });
    }
}
