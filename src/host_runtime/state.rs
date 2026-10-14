//! Explicit plugin JSON state transfer. This owns no serialization of closures,
//! external processes or Native objects, and never speculatively replays writes.
use super::*;

pub const MAX_HOST_STATE_BYTES: usize = 256 * 1024;
const STATE_TIMEOUT: Duration = Duration::from_millis(1500);

pub struct HostStateOperation {
    receiver: mpsc::Receiver<Result<Value, HostError>>,
    delivered: bool,
}
impl HostStateOperation {
    pub fn try_result(&mut self) -> Option<Result<Value, HostError>> {
        if self.delivered {
            return None;
        }
        let result = match self.receiver.try_recv() {
            Ok(value) => value,
            Err(mpsc::TryRecvError::Empty) => return None,
            Err(mpsc::TryRecvError::Disconnected) => Err(HostError::new(
                "owner_stopped",
                "Host state owner stopped before returning its snapshot",
            )),
        };
        self.delivered = true;
        Some(result)
    }
}
pub(super) struct Completion {
    sender: mpsc::SyncSender<Result<Value, HostError>>,
    _permit: lifecycle::OperationPermit,
}
impl Completion {
    pub(super) fn finish(self, value: Result<Value, HostError>) {
        let _ = self.sender.try_send(value);
    }
}
pub(super) struct Pending {
    pub id: u64,
    completion: Completion,
    resume: bool,
    core: Option<String>,
}

pub fn validate_snapshot(value: &Value) -> Result<(), HostError> {
    if value.is_null() {
        return Ok(());
    } // Explicit legacy stateless snapshot.
    let valid = value.as_object().is_some_and(|object| {
        object.len() == 2
            && object.contains_key("value")
            && object
                .get("schema")
                .and_then(Value::as_u64)
                .is_some_and(|schema| (1..=u32::MAX as u64).contains(&schema))
    });
    if !valid {
        return Err(HostError::new(
            "invalid_snapshot",
            "Host state must be {schema:positive uint32,value:JSON}",
        ));
    }
    if serde_json::to_vec(value)
        .map_err(|error| HostError::new("invalid_snapshot", error.to_string()))?
        .len()
        > MAX_HOST_STATE_BYTES
    {
        return Err(HostError::new(
            "snapshot_too_large",
            "Host state exceeds 256 KiB",
        ));
    }
    Ok(())
}

impl HostRuntime {
    /// Read-only, bounded saveState request to the exact active generation.
    /// Failure preserves that generation; the caller decides takeover order.
    pub fn begin_snapshot(
        &self,
        plugin_id: &str,
        generation: u64,
    ) -> Result<HostStateOperation, HostError> {
        self.begin_state_operation(plugin_id, generation, false)
    }
    pub fn begin_resume(
        &self,
        plugin_id: &str,
        generation: u64,
    ) -> Result<HostStateOperation, HostError> {
        self.begin_state_operation(plugin_id, generation, true)
    }
    fn begin_state_operation(
        &self,
        plugin_id: &str,
        generation: u64,
        resume: bool,
    ) -> Result<HostStateOperation, HostError> {
        let identity = HostIdentity {
            plugin_id: plugin_id.into(),
            generation,
        };
        identity
            .validate()
            .map_err(|error| HostError::new("invalid_identity", error))?;
        if self.stopping.load(Ordering::Acquire) {
            return Err(HostError::new(
                "runtime_stopping",
                "Host runtime is stopping",
            ));
        }
        self.operations
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < 16).then_some(count + 1)
            })
            .map_err(|_| HostError::new("operation_limit", "too many Host lifecycle operations"))?;
        let permit = lifecycle::OperationPermit(Arc::clone(&self.operations));
        let (sender, receiver) = mpsc::sync_channel(1);
        let completion = Completion {
            sender,
            _permit: permit,
        };
        self.commands
            .try_send(if resume {
                lifecycle::Command::Resume(identity, completion)
            } else {
                lifecycle::Command::Snapshot(identity, completion)
            })
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => {
                    HostError::new("launch_queue_full", "Host lifecycle queue is full")
                }
                mpsc::TrySendError::Disconnected(_) => {
                    HostError::new("owner_stopped", "Host lifecycle owner stopped")
                }
            })?;
        Ok(HostStateOperation {
            receiver,
            delivered: false,
        })
    }
}

pub(super) fn begin(
    owners: &mut [HostOwner],
    identity: HostIdentity,
    completion: Completion,
    resume: bool,
) {
    let Some(owner) = owners.iter_mut().find(|owner| {
        owner.observation.plugin.manifest.id == identity.plugin_id
            && owner.observation.plugin.generation == identity.generation
            && owner.observation.state == ExecutionState::Active
    }) else {
        completion.finish(Err(HostError::new(
            "stale_generation",
            "snapshot requires the exact active Host generation",
        )));
        return;
    };
    if owner.state_operation.is_some() {
        completion.finish(Err(HostError::new(
            "state_transition_busy",
            "Host already has a state operation",
        )));
        return;
    }
    if !resume {
        owner.state_paused = true;
    }
    match owner.supervisor.as_mut().unwrap().send_request(
        if resume {
            "host.resume"
        } else {
            "host.snapshot"
        },
        Value::Null,
        STATE_TIMEOUT,
    ) {
        Ok(id) => {
            owner.state_operation = Some(Pending {
                id,
                completion,
                resume,
                core: None,
            })
        }
        Err(error) => {
            owner.state_paused = false;
            completion.finish(Err(error));
        }
    }
}
pub(super) fn submit_core(
    commands: &mpsc::SyncSender<lifecycle::Command>,
    operations: &Arc<AtomicUsize>,
    identity: HostIdentity,
    operation: String,
    resume: bool,
) -> Result<HostStateOperation, HostError> {
    operations
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
            (count < 16).then_some(count + 1)
        })
        .map_err(|_| HostError::new("operation_limit", "Too many Host lifecycle receipts"))?;
    let (sender, receiver) = mpsc::sync_channel(1);
    let completion = Completion {
        sender,
        _permit: lifecycle::OperationPermit(operations.clone()),
    };
    commands
        .try_send(lifecycle::Command::CoreAdmission(
            identity, operation, resume, completion,
        ))
        .map_err(|error| match error {
            mpsc::TrySendError::Full(_) => HostError::new(
                "operation_queue_full",
                "Host lifecycle command queue is full",
            ),
            mpsc::TrySendError::Disconnected(_) => {
                HostError::new("owner_stopped", "Host lifecycle owner stopped")
            }
        })?;
    Ok(HostStateOperation {
        receiver,
        delivered: false,
    })
}
pub(super) fn begin_core(
    owners: &mut [HostOwner],
    identity: HostIdentity,
    operation: String,
    completion: Completion,
    resume: bool,
) {
    let Some(owner) = owners.iter_mut().find(|owner| {
        owner.observation.plugin.manifest.id == identity.plugin_id
            && owner.observation.plugin.generation == identity.generation
            && owner.observation.state == ExecutionState::Active
    }) else {
        completion.finish(Err(HostError::new(
            "stale_generation",
            "Core admission requires its exact active Host generation",
        )));
        return;
    };
    if owner.state_operation.is_some() {
        completion.finish(Err(HostError::new(
            "state_transition_busy",
            "Another Host state receipt is pending",
        )));
        return;
    }
    let rehold = owner
        .services
        .core_admission
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .holding;
    match owner.supervisor.as_mut().unwrap().send_request(
        if resume {
            "host.coreResume"
        } else {
            "host.corePause"
        },
        json!({"operationId":operation,"rehold":rehold}),
        STATE_TIMEOUT,
    ) {
        Ok(id) => {
            owner.state_operation = Some(Pending {
                id,
                completion,
                resume,
                core: Some(operation),
            })
        }
        Err(error) => completion.finish(Err(error)),
    }
}
impl HostOwner {
    pub(super) fn finish_state_response(
        &mut self,
        id: u64,
        value: Result<Value, HostRpcError>,
    ) -> bool {
        if !self
            .state_operation
            .as_ref()
            .is_some_and(|pending| pending.id == id)
        {
            return false;
        }
        let pending = self.state_operation.take().unwrap();
        let result = value
            .map_err(|error| {
                HostError::new(
                    if pending.core.is_some() && error.code == "core_admission_traffic_busy" {
                        "core_admission_traffic_busy"
                    } else {
                        "snapshot_failed"
                    },
                    format!("{}: {}", error.code, error.message),
                )
            })
            .and_then(|snapshot| {
                if let Some(operation) = &pending.core {
                    if snapshot.get("operationId").and_then(Value::as_str)
                        != Some(operation.as_str())
                        || snapshot.get(if pending.resume { "resumed" } else { "held" })
                            != Some(&Value::Bool(true))
                    {
                        return Err(HostError::new(
                            "core_admission_unconfirmed",
                            "Host did not acknowledge this exact Core admission operation",
                        ));
                    }
                } else if pending.resume {
                    if snapshot.get("resumed") != Some(&Value::Bool(true)) {
                        return Err(HostError::new(
                            "resume_failed",
                            "Host did not acknowledge resumed admission",
                        ));
                    }
                    self.state_paused = false;
                } else {
                    validate_snapshot(&snapshot)?;
                }
                Ok(snapshot)
            });
        pending.completion.finish(result);
        true
    }
    pub(super) fn finish_state_timeout(&mut self, id: u64) -> bool {
        if !self
            .state_operation
            .as_ref()
            .is_some_and(|pending| pending.id == id)
        {
            return false;
        }
        self.state_operation
            .take()
            .unwrap()
            .completion
            .finish(Err(HostError::new(
                "snapshot_timeout",
                "Host state snapshot deadline expired; old generation retained",
            )));
        true
    }
    pub(super) fn retire_state_operation(&mut self) {
        if let Some(pending) = self.state_operation.take() {
            pending.completion.finish(Err(HostError::new(
                "host_stopping",
                "Host retired before returning its snapshot",
            )));
        }
    }
}
