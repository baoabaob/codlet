//! One absolute shutdown window, owned by Core. Ordinary requests/subscriptions
//! retire first; only explicit cleanup requests can use the remaining window.

use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CleanupRequest {
    method: String,
    params: Value,
}

impl HostOwner {
    pub(super) fn cleanup_snapshot(&self) -> HostCleanupSnapshot {
        HostCleanupSnapshot {
            phase: self.cleanup_phase,
            remaining_budget_ms: self.cleanup_deadline.map(|deadline| {
                if self.cleanup_phase == HostCleanupPhase::Running {
                    deadline
                        .saturating_duration_since(Instant::now())
                        .as_millis()
                        .min(u128::from(u64::MAX)) as u64
                } else {
                    0
                }
            }),
            pending_requests: if self.observation.state == ExecutionState::Stopping {
                self.pending.len()
                    + self.retiring_attachments.len()
                    + self.retiring_os.len()
                    + self.scope_cleanup.len()
                    + self.scope_cleanup_queue.len()
            } else {
                0
            },
            error: self
                .cleanup_error
                .as_ref()
                .map(|error| error.chars().take(4096).collect()),
        }
    }

    pub(super) fn pump_cleanup(&mut self, client: &CdpClient) {
        let Some(supervisor) = &mut self.supervisor else {
            return;
        };
        let shutdown_id = supervisor.shutdown_request_id();
        let events = supervisor.poll();
        // A fault retires this batch before any queued request can act, matching
        // ordinary RPC dispatch. A valid frame beside a protocol fault does not
        // retain admission merely because it arrived first in the same poll.
        if let Some(error) = events.iter().find_map(|event| match event {
            HostEvent::Failed { error } => Some(error.clone()),
            _ => None,
        }) {
            if self.cleanup_phase == HostCleanupPhase::Running {
                self.cleanup_failed(HostCleanupPhase::Failed, error.to_string());
            }
            self.cancel_raw_requests(None);
            self.outbox.clear();
            self.finish_retirement();
            return;
        }
        for event in events {
            match event {
                HostEvent::Request { id, method, params } => {
                    let result = self.dispatch_cleanup(client, id, &method, params);
                    if let Some(result) = result {
                        self.queue(Outbound::Reply(id, result));
                    }
                }
                HostEvent::Response { id, result } if Some(id) == shutdown_id => {
                    match result {
                        Ok(_) => self.cleanup_phase = HostCleanupPhase::Completed,
                        Err(error) => self.cleanup_failed(
                            if error.code == "cleanup_timeout" {
                                HostCleanupPhase::TimedOut
                            } else {
                                HostCleanupPhase::Failed
                            },
                            format!("{}: {}", error.code, error.message),
                        ),
                    }
                    self.cancel_raw_requests(None);
                    self.outbox.clear();
                }
                _ => {}
            }
        }
        if self.cleanup_phase == HostCleanupPhase::Running
            && self
                .cleanup_deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
        {
            self.cleanup_failed(
                HostCleanupPhase::TimedOut,
                "cleanup_timeout: the total Core cleanup budget expired".into(),
            );
        }
        self.pump_raw_pending();
        // A deadline retires pending CDP waiters instead of letting late replies
        // reach a later generation. Already-applied page effects are not undone.
        if self.cleanup_phase != HostCleanupPhase::Running {
            self.cancel_raw_requests(None);
            self.outbox.clear();
        } else {
            self.flush_outbox();
        }
        if self.cleanup_phase == HostCleanupPhase::Running
            && self
                .supervisor
                .as_ref()
                .is_some_and(|supervisor| supervisor.exit_report().is_some())
        {
            self.cleanup_failed(
                HostCleanupPhase::Failed,
                "cleanup_incomplete: host exited before confirming deactivate".into(),
            );
        }
        self.finish_retirement();
    }

    fn dispatch_cleanup(
        &mut self,
        client: &CdpClient,
        id: u64,
        method: &str,
        params: Value,
    ) -> Option<Result<Value, HostRpcError>> {
        if method != "cleanup.request" {
            return Some(Err(HostRpcError::new(
                "host_stopping",
                "ordinary Core requests retire before deactivate",
            )));
        }
        if self.cleanup_phase != HostCleanupPhase::Running
            || self
                .cleanup_deadline
                .is_none_or(|deadline| Instant::now() >= deadline)
        {
            return Some(Err(HostRpcError::new(
                "cleanup_timeout",
                "the total Core cleanup budget expired",
            )));
        }
        let input: CleanupRequest = match decode_params(params) {
            Ok(input) => input,
            Err(error) => return Some(Err(error)),
        };
        if input.method != "cdp.request" {
            return Some(Err(HostRpcError::new(
                "cleanup_method_unavailable",
                "cleanup supports Core cdp.request; new subscriptions are not admitted",
            )));
        }
        if !self.cleanup_raw_is_current() {
            return Some(Err(HostRpcError::new(
                "permission_denied",
                "cdp.raw is not currently authorized for this generation's cleanup",
            )));
        }
        // Reuse the same permission and payload checks as the active generation.
        // The CDP method itself remains unrestricted by official adapters.
        self.dispatch(client, id, &input.method, input.params)
    }

    fn cleanup_failed(&mut self, phase: HostCleanupPhase, error: String) {
        self.cleanup_phase = phase;
        self.cleanup_error = Some(error.chars().take(4096).collect());
        if self.failure.is_none() {
            let failure = HostError::new(
                if phase == HostCleanupPhase::TimedOut {
                    "cleanup_timeout"
                } else {
                    "cleanup_failed"
                },
                self.cleanup_error.clone().unwrap(),
            );
            self.observation.error = Some(failure.to_string());
            self.failure = Some(failure);
        }
    }
}
