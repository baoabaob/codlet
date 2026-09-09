//! Interpretation of process-owner evidence. Registration intent and arbitrary
//! plugin side effects are deliberately not inferred from this retained sample.

use std::fmt::Write;

use serde::Serialize;

use super::{DiagnosticIssue, RuntimeObservations};
use crate::plugin_execution::{ExecutionState, HostCleanupPhase, HostRuntimeSnapshot};
use crate::runtime_status::HostState;

const HOST_FRESHNESS_LIMIT_MS: u64 = 5_000;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStateCounts {
    pub starting: usize,
    pub active: usize,
    pub stopping: usize,
    pub failed: usize,
    pub exited: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProcessFinding {
    pub plugin_id: String,
    pub generation: u64,
    pub code: &'static str,
    /// Terminal observations remain useful history after disable/remove. They
    /// alone cannot prove that the current desired configuration is unhealthy.
    pub terminal: bool,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHostProcesses {
    pub basis: &'static str,
    pub assessment: &'static str,
    pub freshness: &'static str,
    pub freshness_limit_ms: u64,
    pub queried_at_unix_ms: u64,
    pub age_ms: Option<u64>,
    pub states: HostStateCounts,
    pub findings: Vec<HostProcessFinding>,
    pub sample: HostRuntimeSnapshot,
}

impl RuntimeObservations {
    pub(super) fn with_hosts(
        mut self,
        hosts: HostRuntimeSnapshot,
        queried_at_unix_ms: u64,
    ) -> Self {
        let age_ms = queried_at_unix_ms.checked_sub(hosts.sampled_at_unix_ms);
        let freshness = match age_ms {
            _ if hosts.sequence == 0 || hosts.sampled_at_unix_ms == 0 => "not_sampled",
            None => "clock_skew",
            Some(age) if age > HOST_FRESHNESS_LIMIT_MS => "stale",
            Some(_) => "fresh",
        };
        let mut states = HostStateCounts::default();
        let mut findings = Vec::new();
        for plugin in &hosts.plugins {
            match plugin.state {
                ExecutionState::Starting => states.starting += 1,
                ExecutionState::Active => states.active += 1,
                ExecutionState::Stopping => states.stopping += 1,
                ExecutionState::Failed => states.failed += 1,
                ExecutionState::Exited => states.exited += 1,
            }
            let terminal = matches!(
                plugin.state,
                ExecutionState::Failed | ExecutionState::Exited
            );
            let finding = if matches!(
                plugin.cleanup.phase,
                HostCleanupPhase::Failed | HostCleanupPhase::TimedOut
            ) {
                Some((
                    if plugin.cleanup.phase == HostCleanupPhase::TimedOut {
                        "cleanup_timed_out"
                    } else {
                        "cleanup_failed"
                    },
                    plugin
                        .cleanup
                        .error
                        .as_ref()
                        .or(plugin.error.as_ref())
                        .cloned()
                        .unwrap_or_else(|| {
                            "This generation did not complete cooperative cleanup.".into()
                        }),
                ))
            } else if plugin.state == ExecutionState::Failed {
                Some((
                    "failed_generation",
                    plugin.error.clone().unwrap_or_else(|| {
                        "This generation failed; no detailed error was retained.".into()
                    }),
                ))
            } else if plugin
                .exit
                .as_ref()
                .is_some_and(|exit| exit.forced || exit.exit_code != 0)
            {
                Some((
                    "non_cooperative_exit",
                    "This generation required forced termination or exited with a nonzero code."
                        .into(),
                ))
            } else {
                None
            };
            if let Some((code, message)) = finding {
                findings.push(HostProcessFinding {
                    plugin_id: plugin.id.clone(),
                    generation: plugin.generation,
                    code,
                    terminal,
                    message,
                });
            }
        }
        let host_state = self.sample.as_ref().map(|sample| sample.host_state);
        let assessment = match host_state {
            Some(HostState::Terminated) => "runtime_terminated",
            Some(HostState::Starting) => "runtime_starting",
            _ if freshness != "fresh" => freshness,
            _ if hosts.runtime_stopping => "runtime_stopping",
            _ if !hosts.owner_alive => "owner_stopped",
            _ if states.starting + states.stopping > 0 => "lifecycle_busy",
            _ if states.active > 0 => "active",
            _ => "no_active_hosts",
        };
        if assessment == "owner_stopped" && host_state == Some(HostState::Ready) {
            self.issues.push(DiagnosticIssue::new(
                "runtime_host_owner_stopped",
                "The JS process owner has stopped while the Runtime Host is still ready; this executor cannot service online operations.",
                "Inspect the Host log and retained plugin errors. Restart the Codlet-owned session after identifying the owner failure.",
            ));
        }
        self.reason = "Authenticated publication includes renderer/kernel facts and a separately timestamped JS process-owner sample. Retained terminal records are history, and absence is not a statement about registry intent or past executions.".into();
        self.host_processes = Some(RuntimeHostProcesses {
            basis: "authenticated_process_owner_snapshot",
            assessment,
            freshness,
            freshness_limit_ms: HOST_FRESHNESS_LIMIT_MS,
            queried_at_unix_ms,
            age_ms,
            states,
            findings,
            sample: hosts,
        });
        self
    }

    pub(super) fn render_hosts(&self, output: &mut String) {
        let Some(hosts) = &self.host_processes else {
            return;
        };
        let _ = writeln!(
            output,
            "  host-processes: {}; freshness={}; sequence={}; sampled-at-unix-ms={}; owner-alive={}; runtime-stopping={}; retained={}/{}; history-truncated={}",
            hosts.assessment,
            hosts.freshness,
            hosts.sample.sequence,
            hosts.sample.sampled_at_unix_ms,
            hosts.sample.owner_alive,
            hosts.sample.runtime_stopping,
            hosts.sample.plugins.len(),
            hosts.sample.retained_limit,
            hosts.sample.history_truncated,
        );
        for plugin in &hosts.sample.plugins {
            let _ = writeln!(
                output,
                "    host-plugin: {}; version={}; generation={}; state={:?}; pid={:?}; pending-core={}; subscriptions={}; outbox={}; launching={}; cleanup={:?}; cleanup-pending={}; cleanup-budget-ms={:?}",
                plugin.id,
                plugin.version,
                plugin.generation,
                plugin.state,
                plugin.process_id,
                plugin.pending_core_requests,
                plugin.subscriptions,
                plugin.outbox,
                plugin.launching,
                plugin.cleanup.phase,
                plugin.cleanup.pending_requests,
                plugin.cleanup.remaining_budget_ms,
            );
            if let Some(exit) = &plugin.exit {
                let _ = writeln!(
                    output,
                    "      confirmed-exit: pid={}; code={}; forced={}; workers-reaped={}",
                    exit.process_id, exit.exit_code, exit.forced, exit.workers_reaped,
                );
            }
        }
        for finding in &hosts.findings {
            let _ = writeln!(
                output,
                "    host-finding: {}; generation={}; code={}; terminal={}; message={}",
                finding.plugin_id,
                finding.generation,
                finding.code,
                finding.terminal,
                finding.message,
            );
        }
    }
}
