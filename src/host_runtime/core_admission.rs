//! Core-private transaction admission. The lease survives generation replacement
//! and is never selected by plugin parameters or an ordinary snapshot resume.
use super::*;

#[derive(Default)]
pub(super) struct Admission {
    pub operation: Option<String>,
    pub releasing: bool,
    pub holding: bool,
}

pub(crate) struct HostCoreAdmissionOperation {
    operation: String,
    resume: bool,
    compensating: bool,
    identities: Vec<HostIdentity>,
    pending: Vec<(String, HostStateOperation)>,
    queued: VecDeque<(HostIdentity, bool)>,
    failures: Vec<String>,
    traffic_busy: usize,
    hard_failure: bool,
    commands: mpsc::SyncSender<lifecycle::Command>,
    permits: Arc<AtomicUsize>,
    admission: Arc<Mutex<Admission>>,
    delivered: bool,
}
impl HostCoreAdmissionOperation {
    pub(crate) fn try_result(&mut self) -> Option<Result<Value, HostError>> {
        if self.delivered {
            return None;
        }
        let mut index = 0;
        while index < self.pending.len() {
            let Some(result) = self.pending[index].1.try_result() else {
                index += 1;
                continue;
            };
            let (id, _) = self.pending.remove(index);
            if let Err(error) = result {
                if error.code == "core_admission_traffic_busy" {
                    self.traffic_busy += 1;
                } else {
                    self.hard_failure = true;
                }
                self.failures.push(format!("{id}: {error}"));
            }
        }
        self.submit_queued();
        if !self.pending.is_empty()
            || !self.queued.is_empty()
            || self.permits.load(Ordering::Acquire) != 0
        {
            return None;
        }
        if self.resume && !self.failures.is_empty() && !self.compensating {
            self.compensating = true;
            self.admission
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .releasing = false;
            // Some children may already have acknowledged release. Re-hold every
            // captured current generation before reporting uncertain restoration.
            self.enqueue(false);
            if !self.pending.is_empty()
                || !self.queued.is_empty()
                || self.permits.load(Ordering::Acquire) != 0
            {
                return None;
            }
        }
        self.delivered = true;
        if !self.failures.is_empty() {
            let code = if !self.resume && self.traffic_busy > 0 && !self.hard_failure {
                "core_admission_traffic_busy"
            } else {
                "core_admission_unconfirmed"
            };
            return Some(Err(HostError::new(
                code,
                format!(
                    "Host admission receipts were not all confirmed; the Core lease remains reserved. {}",
                    self.failures
                        .iter()
                        .take(8)
                        .map(|value| value.chars().take(1024).collect::<String>())
                        .collect::<Vec<_>>()
                        .join("; ")
                ),
            )));
        }
        if self.resume {
            let mut admission = self.admission.lock().unwrap_or_else(|p| p.into_inner());
            if admission.operation.as_deref() != Some(self.operation.as_str())
                || !admission.releasing
            {
                return Some(Err(HostError::new(
                    "core_admission_stale",
                    "Core Host admission owner changed before release completed",
                )));
            }
            admission.operation = None;
            admission.releasing = false;
            admission.holding = false;
        } else {
            self.admission
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .holding = true;
        }
        Some(Ok(
            json!({"operationId":self.operation, "held":!self.resume,"resumed":self.resume}),
        ))
    }
    fn enqueue(&mut self, resume: bool) {
        self.queued.extend(
            self.identities
                .iter()
                .cloned()
                .map(|identity| (identity, resume)),
        );
        self.submit_queued();
    }
    fn submit_queued(&mut self) {
        while self.pending.len() < 4 {
            let Some((identity, resume)) = self.queued.pop_front() else {
                break;
            };
            match state::submit_core(
                &self.commands,
                &self.permits,
                identity.clone(),
                self.operation.clone(),
                resume,
            ) {
                Ok(operation) => self.pending.push((identity.plugin_id.clone(), operation)),
                Err(error) if matches!(error.code, "operation_limit" | "operation_queue_full") => {
                    self.queued.push_front((identity, resume));
                    break;
                }
                Err(error) => {
                    self.hard_failure = true;
                    self.failures
                        .push(format!("{}: {error}", identity.plugin_id));
                }
            }
        }
    }
}

impl HostRuntime {
    pub(crate) fn begin_core_admission(
        &self,
        operation: &str,
    ) -> Result<HostCoreAdmissionOperation, HostError> {
        self.core_admission_operation(operation, false)
    }
    pub(crate) fn resume_core_admission(
        &self,
        operation: &str,
    ) -> Result<HostCoreAdmissionOperation, HostError> {
        self.core_admission_operation(operation, true)
    }
    fn core_admission_operation(
        &self,
        operation: &str,
        resume: bool,
    ) -> Result<HostCoreAdmissionOperation, HostError> {
        if operation.is_empty()
            || operation.len() > 96
            || !operation
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
        {
            return Err(HostError::new(
                "core_admission_id_invalid",
                "A bounded Core transaction identity is required; no lease was changed",
            ));
        }
        if self.stopping.load(Ordering::Acquire) {
            return Err(HostError::new(
                "runtime_stopping",
                "Host runtime is stopping; no lease was changed",
            ));
        }
        let observations = self.observations();
        if self.operations.load(Ordering::Acquire) != 0
            || observations.iter().any(|owner| {
                matches!(
                    owner.state,
                    ExecutionState::Starting | ExecutionState::Stopping
                )
            })
        {
            return Err(HostError::new(
                "core_admission_busy",
                "Host lifecycle work must settle before Core admission changes; no lease was changed",
            ));
        }
        let admission = self.services.core_admission.clone();
        {
            let mut held = admission.lock().unwrap_or_else(|p| p.into_inner());
            if held
                .operation
                .as_deref()
                .is_some_and(|current| current != operation)
                || (resume && held.operation.as_deref() != Some(operation))
                || held.releasing
            {
                return Err(HostError::new(
                    "core_admission_stale",
                    "Another operation owns Core Host admission; no lease was changed",
                ));
            }
            held.operation = Some(operation.into());
            held.releasing = resume;
        }
        // Every error after acquiring the lease is delivered in this operation,
        // so Ok always tells the coordinator it owns compensation responsibility.
        let mut result = HostCoreAdmissionOperation {
            operation: operation.into(),
            resume,
            compensating: false,
            identities: observations
                .into_iter()
                .filter(|owner| owner.state == ExecutionState::Active)
                .map(|owner| HostIdentity {
                    plugin_id: owner.plugin.manifest.id,
                    generation: owner.plugin.generation,
                })
                .collect(),
            pending: Vec::new(),
            queued: VecDeque::new(),
            failures: Vec::new(),
            traffic_busy: 0,
            hard_failure: false,
            commands: self.commands.clone(),
            permits: self.operations.clone(),
            admission,
            delivered: false,
        };
        result.enqueue(resume);
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn batch(
        count: usize,
        resume: bool,
    ) -> (
        HostCoreAdmissionOperation,
        mpsc::Receiver<lifecycle::Command>,
    ) {
        let (commands, receiver) = mpsc::sync_channel(16);
        let admission = Arc::new(Mutex::new(Admission {
            operation: Some("fixture-core".into()),
            releasing: resume,
            holding: resume,
        }));
        let mut operation = HostCoreAdmissionOperation {
            operation: "fixture-core".into(),
            resume,
            compensating: false,
            identities: (0..count)
                .map(|id| HostIdentity {
                    plugin_id: format!("fixture.{id}"),
                    generation: 2,
                })
                .collect(),
            pending: Vec::new(),
            queued: VecDeque::new(),
            failures: Vec::new(),
            traffic_busy: 0,
            hard_failure: false,
            commands,
            permits: Arc::new(AtomicUsize::new(0)),
            admission,
            delivered: false,
        };
        operation.enqueue(resume);
        (operation, receiver)
    }
    fn acknowledge(command: lifecycle::Command, failure: bool) -> bool {
        let lifecycle::Command::CoreAdmission(_, id, resume, completion) = command else {
            panic!("unexpected lifecycle command")
        };
        if failure {
            completion.finish(Err(HostError::new(
                "fixture_release_failed",
                "synthetic release was refused",
            )));
        } else {
            completion.finish(Ok(
                json!({"operationId":id,"held":!resume,"resumed":resume}),
            ));
        }
        resume
    }
    #[test]
    fn core_receipts_queue_more_than_one_lifecycle_permit_batch_without_losing_owners() {
        let (mut operation, receiver) = batch(43, false);
        let mut acknowledged = 0;
        let result = loop {
            while let Ok(command) = receiver.try_recv() {
                assert!(!acknowledge(command, false));
                acknowledged += 1;
            }
            if let Some(result) = operation.try_result() {
                break result;
            }
            assert!(acknowledged <= 43);
        };
        assert!(result.unwrap()["held"] == true);
        assert_eq!(acknowledged, 43);
        assert_eq!(
            operation.admission.lock().unwrap().operation.as_deref(),
            Some("fixture-core")
        );
    }
    #[test]
    fn failed_partial_release_reholds_every_owner_and_never_clears_the_core_lease() {
        let (mut operation, receiver) = batch(3, true);
        assert!(acknowledge(receiver.try_recv().unwrap(), false));
        assert!(operation.try_result().is_none());
        assert!(operation.admission.lock().unwrap().operation.is_some());
        assert!(acknowledge(receiver.try_recv().unwrap(), true));
        assert!(acknowledge(receiver.try_recv().unwrap(), false));
        assert!(operation.try_result().is_none());
        let mut reheld = 0;
        while let Ok(command) = receiver.try_recv() {
            assert!(!acknowledge(command, false));
            reheld += 1;
        }
        assert_eq!(reheld, 3);
        let error = operation.try_result().unwrap().unwrap_err();
        assert!(error.message.contains("synthetic release was refused"));
        assert_eq!(
            operation.admission.lock().unwrap().operation.as_deref(),
            Some("fixture-core")
        );
        assert!(!operation.admission.lock().unwrap().releasing);
    }
    #[test]
    fn lease_release_requires_all_children_and_the_original_operation_receipt() {
        let (mut operation, receiver) = batch(2, true);
        assert!(acknowledge(receiver.try_recv().unwrap(), false));
        assert!(operation.try_result().is_none());
        assert!(operation.admission.lock().unwrap().operation.is_some());
        assert!(acknowledge(receiver.try_recv().unwrap(), false));
        assert!(operation.try_result().unwrap().unwrap()["resumed"] == true);
        assert!(operation.admission.lock().unwrap().operation.is_none());
        assert!(operation.try_result().is_none());
    }
    #[test]
    fn busy_preflight_preserves_next_start_category_and_only_reserves_the_lease() {
        for hard_failure in [false, true] {
            let (mut operation, receiver) = batch(2, false);
            let lifecycle::Command::CoreAdmission(_, _, _, completion) =
                receiver.try_recv().unwrap()
            else {
                panic!("unexpected lifecycle command")
            };
            completion.finish(Err(HostError::new(
                "core_admission_traffic_busy",
                "accepted stream is retained",
            )));
            acknowledge(receiver.try_recv().unwrap(), hard_failure);
            let error = operation.try_result().unwrap().unwrap_err();
            assert_eq!(
                error.code,
                if hard_failure {
                    "core_admission_unconfirmed"
                } else {
                    "core_admission_traffic_busy"
                }
            );
            let admission = operation.admission.lock().unwrap();
            assert_eq!(admission.operation.as_deref(), Some("fixture-core"));
            assert!(
                !admission.holding,
                "old busy traffic is not globally stopped before preflight succeeds"
            );
        }
    }
}
