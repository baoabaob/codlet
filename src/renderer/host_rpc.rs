//! Asynchronous renderer-to-host capability calls. The renderer owns caller,
//! lease and document checks; the managed process owner owns execution and the
//! same absolute deadline. Neither wait path needs another thread.

use super::*;
use crate::capabilities::host_provider_plugin_id;

#[cfg(windows)]
use crate::cdp::CdpRequest;
#[cfg(windows)]
use crate::host_runtime::{
    HostCapabilityCaller, HostCapabilityClient, HostCapabilityOperation, HostCapabilityRequest,
};
#[cfg(windows)]
use crate::plugin_host::HostError;

type Admission = Result<(), (&'static str, String)>;

#[derive(Default)]
pub(super) struct HostRpcBridge {
    #[cfg(windows)]
    client: Option<HostCapabilityClient>,
    #[cfg(windows)]
    pending: Vec<PendingCall>,
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
        self.host_rpc.client = Some(client);
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
        _capability: &CapabilityDescriptor,
        _request: &BindingMessage,
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
        capability: &CapabilityDescriptor,
        request: &BindingMessage,
    ) -> Option<Admission> {
        host_provider_plugin_id(provider_id)?;
        Some(
            self.admit_host_call(target_id, consumer, lease, provider_id, capability, request)
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
        capability: &CapabilityDescriptor,
        request: &BindingMessage,
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
        let deadline = parent_deadline.min(Instant::now() + Duration::from_secs(15));
        let operation = client.begin_request(HostCapabilityRequest {
            owner_plugin_id: host_provider_plugin_id(provider_id)
                .expect("host provider key was checked")
                .into(),
            expected_generation: provider_generation,
            capability: capability.clone(),
            method: request.method.clone(),
            params: request.params.clone(),
            caller: HostCapabilityCaller {
                plugin_id: consumer.id.clone(),
                generation: consumer.generation,
                target_id: target_id.into(),
                document_epoch: session.document_epoch,
            },
            deadline,
        })?;
        self.host_rpc.pending.push(PendingCall {
            target_id: target_id.into(),
            session_id: session.session.session_id().into(),
            document_epoch: session.document_epoch,
            consumer: consumer.clone(),
            lease: lease.clone(),
            provider_id: provider_id.into(),
            provider_generation,
            capability: capability.clone(),
            request_id: request.id,
            deadline,
            phase: Some(Phase::Invoking(operation)),
        });
        Ok(())
    }

    pub(super) fn poll_host_capabilities(&mut self) {
        #[cfg(windows)]
        {
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
        self.capabilities.provider_generation(&call.provider_id) == Some(call.provider_generation)
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
                    Some(result) => self.begin_host_reply(call, result),
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
