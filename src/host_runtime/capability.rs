//! Bounded, pollable calls into managed Host providers. Core remains the owner
//! of caller identity, generation, cancellation and the original deadline.

use crate::capabilities::{CapabilityDescriptor, CapabilityScope};
use serde::Serialize;

use super::*;

const COMMAND_QUEUE: usize = 8;
const MAX_OPERATIONS: usize = 16;
const MAX_INVOCATIONS_PER_HOST: usize = 4;
const MAX_CHILDREN: usize = MAX_PENDING + MAX_OUTBOX;
const MAX_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCapabilityCaller {
    pub plugin_id: String,
    pub generation: u64,
    pub target_id: String,
    pub document_epoch: u64,
}

#[derive(Debug, Clone)]
pub struct HostCapabilityRequest {
    pub owner_plugin_id: String,
    pub expected_generation: u64,
    pub capability: CapabilityDescriptor,
    pub method: String,
    pub params: Value,
    pub caller: HostCapabilityCaller,
    pub deadline: Instant,
}

/// Core-side transport only. The caller must already have resolved the current
/// capability lease and authenticated renderer/document identity.
#[derive(Clone)]
pub struct HostCapabilityClient {
    sender: mpsc::SyncSender<Command>,
    stopping: Arc<AtomicBool>,
    count: Arc<AtomicUsize>,
    waker: CdpClient,
}

struct Permit(Arc<AtomicUsize>);

impl Drop for Permit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Yields one result. Dropping or cancelling a receipt retires this invocation
/// and its still-pending managed children; it does not undo remote effects.
pub struct HostCapabilityOperation {
    receiver: mpsc::Receiver<Result<Value, HostError>>,
    cancelled: Arc<AtomicBool>,
    permit: Option<Arc<Permit>>,
    delivered: bool,
}

impl HostCapabilityOperation {
    pub fn try_result(&mut self) -> Option<Result<Value, HostError>> {
        if self.delivered {
            return None;
        }
        let result = match self.receiver.try_recv() {
            Ok(result) => result,
            Err(mpsc::TryRecvError::Empty) => return None,
            Err(mpsc::TryRecvError::Disconnected) => Err(HostError::new(
                "owner_stopped",
                "the host capability owner stopped before publishing its result",
            )),
        };
        self.delivered = true;
        self.permit.take();
        Some(result)
    }

    pub fn cancel(&self) {
        if !self.delivered {
            self.cancelled.store(true, Ordering::Release);
        }
    }
}

impl Drop for HostCapabilityOperation {
    fn drop(&mut self) {
        self.cancel();
    }
}

struct Completion {
    sender: Option<mpsc::SyncSender<Result<Value, HostError>>>,
    cancelled: Arc<AtomicBool>,
    _permit: Arc<Permit>,
    waker: CdpClient,
}

impl Completion {
    fn finish(mut self, result: Result<Value, HostError>) {
        if let Some(sender) = self.sender.take() {
            let _ = sender.try_send(result);
        }
        // Drop wakes after the result was made visible.
    }
}

impl Drop for Completion {
    fn drop(&mut self) {
        // A wake must observe Disconnected even when the owner unwinds.
        self.sender.take();
        self.waker.notify_runtime_activity();
    }
}

pub(super) struct Command {
    request: HostCapabilityRequest,
    completion: Completion,
}

pub(super) struct Invocation {
    id: u64,
    deadline: Instant,
    completion: Completion,
    children: Vec<u64>,
}

impl HostRuntime {
    pub fn capability_client(&self) -> HostCapabilityClient {
        self.capabilities.clone()
    }
}

impl HostCapabilityClient {
    pub fn begin_request(
        &self,
        request: HostCapabilityRequest,
    ) -> Result<HostCapabilityOperation, HostError> {
        validate_request(&request)?;
        if self.stopping.load(Ordering::Acquire) {
            return Err(HostError::new(
                "runtime_stopping",
                "the host runtime is stopping",
            ));
        }
        self.count
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < MAX_OPERATIONS).then_some(count + 1)
            })
            .map_err(|_| {
                HostError::new(
                    "request_limit",
                    "too many pending or unconsumed Host capability results",
                )
            })?;
        let permit = Arc::new(Permit(Arc::clone(&self.count)));
        let cancelled = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = mpsc::sync_channel(1);
        let completion = Completion {
            sender: Some(sender),
            cancelled: Arc::clone(&cancelled),
            _permit: Arc::clone(&permit),
            waker: self.waker.clone(),
        };
        self.sender
            .try_send(Command {
                request,
                completion,
            })
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => HostError::new(
                    "request_queue_full",
                    "the Host capability command queue is full",
                ),
                mpsc::TrySendError::Disconnected(_) => {
                    HostError::new("owner_stopped", "the Host capability owner stopped")
                }
            })?;
        Ok(HostCapabilityOperation {
            receiver,
            cancelled,
            permit: Some(permit),
            delivered: false,
        })
    }
}

fn validate_request(request: &HostCapabilityRequest) -> Result<(), HostError> {
    for identity in [
        HostIdentity {
            plugin_id: request.owner_plugin_id.clone(),
            generation: request.expected_generation,
        },
        HostIdentity {
            plugin_id: request.caller.plugin_id.clone(),
            generation: request.caller.generation,
        },
    ] {
        identity
            .validate()
            .map_err(|message| HostError::new("invalid_identity", message))?;
    }
    if request.capability.scope != CapabilityScope::Target
        || !valid_identifier(&request.method)
        || request.method.len() > 256
        || !valid_identifier(&request.caller.target_id)
        || request.caller.document_epoch == 0
        || request.caller.document_epoch > 9_007_199_254_740_991
    {
        return Err(HostError::new(
            "invalid_params",
            "Host capability calls need a Target descriptor, valid method, and current caller document identity",
        ));
    }
    let remaining = request.deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(timeout());
    }
    if remaining > MAX_TIMEOUT {
        return Err(HostError::new(
            "invalid_timeout",
            "Host capability deadlines must be within 15 seconds",
        ));
    }
    if !payload_fits(&request.params) {
        return Err(HostError::new(
            "request_too_large",
            "Host capability params exceed the JSONL payload limit",
        ));
    }
    Ok(())
}

pub(super) fn channel(
    stopping: Arc<AtomicBool>,
    waker: CdpClient,
) -> (HostCapabilityClient, mpsc::Receiver<Command>) {
    let (sender, receiver) = mpsc::sync_channel(COMMAND_QUEUE);
    (
        HostCapabilityClient {
            sender,
            stopping,
            count: Arc::new(AtomicUsize::new(0)),
            waker,
        },
        receiver,
    )
}

pub(super) fn apply(command: Command, owners: &mut [HostOwner]) {
    let Command {
        request,
        completion,
    } = command;
    let Some(owner) = owners
        .iter_mut()
        .find(|owner| owner.observation.plugin.manifest.id == request.owner_plugin_id)
    else {
        completion.finish(Err(HostError::new(
            "host_not_running",
            "this capability provider has no owned Host generation",
        )));
        return;
    };
    owner.begin_capability(request, completion);
}

pub(super) fn reject_stopped(command: Command) {
    command.completion.finish(Err(HostError::new(
        "runtime_stopping",
        "the runtime stopped before this capability call was dispatched",
    )));
}

fn timeout() -> HostError {
    HostError::new(
        "request_timeout",
        "the original capability invocation deadline expired",
    )
}

fn cancelled() -> HostError {
    HostError::new(
        "invocation_cancelled",
        "the caller retired this capability invocation",
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ChildRequest {
    invocation_id: u64,
    method: String,
    params: Value,
}

impl HostOwner {
    fn begin_capability(&mut self, request: HostCapabilityRequest, completion: Completion) {
        let result = (|| {
            if completion.cancelled.load(Ordering::Acquire) {
                return Err(cancelled());
            }
            validate_request(&request)?;
            if self.observation.plugin.generation != request.expected_generation {
                return Err(HostError::new(
                    "stale_generation",
                    "capability provider generation no longer matches",
                ));
            }
            if self.observation.state != ExecutionState::Active {
                return Err(HostError::new(
                    "host_unavailable",
                    "the capability provider is not active",
                ));
            }
            if !self
                .observation
                .plugin
                .manifest
                .host_provides()
                .contains(&request.capability)
            {
                return Err(HostError::new(
                    "undeclared_capability",
                    "this Host generation did not declare that exact capability",
                ));
            }
            if self.capabilities.len() >= MAX_INVOCATIONS_PER_HOST {
                return Err(HostError::new(
                    "request_limit",
                    "this Host has four active capability invocations",
                ));
            }
            let remaining_ms = request
                .deadline
                .saturating_duration_since(Instant::now())
                .as_millis();
            if remaining_ms == 0 {
                return Err(timeout());
            }
            let params = json!({
                "capability": request.capability, "method": request.method,
                "params": request.params, "caller": request.caller,
                "remainingMs": remaining_ms,
            });
            self.supervisor
                .as_mut()
                .expect("active provider has a supervisor")
                .send_cancellable_request_until(
                    "capability.invoke",
                    params,
                    request.deadline,
                    Arc::clone(&completion.cancelled),
                )
        })();
        match result {
            Ok(id) => self.capabilities.push(Invocation {
                id,
                deadline: request.deadline,
                completion,
                children: Vec::new(),
            }),
            Err(error) => completion.finish(Err(error)),
        }
    }

    pub(super) fn expire_capabilities(&mut self) {
        let now = Instant::now();
        let mut index = 0;
        while index < self.capabilities.len() {
            let invocation = &self.capabilities[index];
            let error = if invocation.completion.cancelled.load(Ordering::Acquire) {
                cancelled()
            } else if now >= invocation.deadline {
                timeout()
            } else {
                index += 1;
                continue;
            };
            self.complete_capability(index, Err(error), true);
        }
    }

    pub(super) fn finish_capability_response(
        &mut self,
        id: u64,
        result: Result<Value, HostRpcError>,
    ) {
        let Some(index) = self
            .capabilities
            .iter()
            .position(|invocation| invocation.id == id)
        else {
            return;
        };
        let invocation = &self.capabilities[index];
        let result = if invocation.completion.cancelled.load(Ordering::Acquire) {
            Err(cancelled())
        } else if Instant::now() >= invocation.deadline {
            Err(timeout())
        } else {
            match result {
                Ok(value) if payload_fits(&value) => Ok(value),
                Ok(_) => Err(HostError::new(
                    "response_too_large",
                    "Host capability result exceeds the payload limit",
                )),
                Err(error) => {
                    let code = match error.code.as_str() {
                        "method_not_found" => "method_not_found",
                        "request_timeout" => "request_timeout",
                        "invocation_cancelled" => "invocation_cancelled",
                        "host_stopping" => "host_stopping",
                        "request_limit" => "request_limit",
                        "response_too_large" => "response_too_large",
                        _ => "provider_error",
                    };
                    Err(HostError::new(
                        code,
                        format!("{}: {}", error.code, error.message)
                            .chars()
                            .take(4096)
                            .collect::<String>(),
                    ))
                }
            }
        };
        self.complete_capability(index, result, false);
    }

    pub(super) fn finish_capability_timeout(&mut self, id: u64) {
        if let Some(index) = self
            .capabilities
            .iter()
            .position(|invocation| invocation.id == id)
        {
            self.complete_capability(index, Err(timeout()), true);
        }
    }

    fn complete_capability(
        &mut self,
        index: usize,
        result: Result<Value, HostError>,
        notify: bool,
    ) {
        let invocation = self.capabilities.swap_remove(index);
        if let Some(supervisor) = &mut self.supervisor {
            supervisor.cancel_request(invocation.id);
            for child in &invocation.children {
                supervisor.abandon_incoming(*child);
            }
        }
        self.pending
            .retain(|(_, _, parent)| *parent != Some(invocation.id));
        self.outbox.retain(|outbound| !matches!(outbound, Outbound::Reply(id, _) if invocation.children.contains(id)));
        if notify
            && matches!(
                self.observation.state,
                ExecutionState::Starting | ExecutionState::Active
            )
        {
            let error = result.as_ref().expect_err("cancellation has an error");
            self.queue(Outbound::CapabilityCancel(
                json!({"invocationId":invocation.id,"code":error.code,"message":error.message}),
            ));
        }
        invocation.completion.finish(result);
    }

    pub(super) fn retire_capabilities(&mut self, error: HostError) {
        while !self.capabilities.is_empty() {
            self.complete_capability(0, Err(error.clone()), false);
        }
    }

    pub(super) fn child_reply_finished(&mut self, id: u64) {
        for invocation in &mut self.capabilities {
            invocation.children.retain(|child| *child != id);
        }
    }

    pub(super) fn dispatch_capability_child(
        &mut self,
        client: &CdpClient,
        id: u64,
        params: Value,
    ) -> Option<Result<Value, HostRpcError>> {
        let input: ChildRequest = match decode_params(params) {
            Ok(input) => input,
            Err(error) => return Some(Err(error)),
        };
        let Some(invocation) = self
            .capabilities
            .iter_mut()
            .find(|invocation| invocation.id == input.invocation_id)
        else {
            return Some(Err(HostRpcError::new(
                "invocation_cancelled",
                "this generation has no active invocation with that Core token",
            )));
        };
        if invocation.completion.cancelled.load(Ordering::Acquire)
            || Instant::now() >= invocation.deadline
        {
            return Some(Err(HostRpcError::new(
                "invocation_cancelled",
                "the parent capability invocation has retired",
            )));
        }
        if invocation.children.len() >= MAX_CHILDREN {
            return Some(Err(HostRpcError::new(
                "request_limit",
                "this invocation has too many pending managed children",
            )));
        }
        let deadline = invocation.deadline;
        invocation.children.push(id);
        self.dispatch_raw(
            client,
            id,
            &input.method,
            input.params,
            Some((input.invocation_id, deadline)),
        )
    }
}
