//! Bounded execution facts for diagnostics. This DTO never carries executable
//! source, package paths, transport handles or a complete lifecycle history.

use super::*;
pub use crate::plugin_execution::{
    HostCleanupPhase, HostCleanupSnapshot, HostPluginSnapshot, HostProcessExitSnapshot,
    HostRuntimeSnapshot,
};

impl HostRuntime {
    pub fn execution_snapshot(&self) -> HostRuntimeSnapshot {
        let mut snapshot = self
            .published
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .snapshot
            .clone();
        snapshot.runtime_stopping = self.stopping.load(Ordering::Acquire);
        snapshot.owner_alive = self
            .worker
            .as_ref()
            .is_some_and(|worker| !worker.is_finished());
        snapshot
    }
}

pub(super) fn update(published: &mut Published, owners: &[HostOwner]) {
    let history_truncated = published.snapshot.history_truncated
        || published.observations.iter().any(|old| {
            !owners.iter().any(|owner| {
                owner.observation.plugin.manifest.id == old.plugin.manifest.id
                    && owner.observation.plugin.generation == old.plugin.generation
            })
        });
    let mut retained_terminal = 0;
    let mut plugins: Vec<_> = owners
        .iter()
        .rev()
        .filter(|owner| {
            if matches!(
                owner.observation.state,
                ExecutionState::Failed | ExecutionState::Exited
            ) {
                retained_terminal += 1;
                retained_terminal <= 64
            } else {
                true
            }
        })
        .map(|owner| HostPluginSnapshot {
            id: owner.observation.plugin.manifest.id.clone(),
            version: owner.observation.plugin.manifest.version.clone(),
            generation: owner.observation.plugin.generation,
            state: owner.observation.state,
            process_id: owner.observation.process_id,
            error: owner
                .observation
                .error
                .as_ref()
                .map(|error| error.chars().take(4096).collect()),
            pending_core_requests: owner.pending.len(),
            subscriptions: usize::from(owner.subscription.is_some()),
            outbox: owner.outbox.len(),
            launching: owner.launching,
            cleanup: owner.cleanup_snapshot(),
            exit: owner
                .stop_report
                .as_ref()
                .and_then(|report| report.result.as_ref().ok())
                .map(|exit| HostProcessExitSnapshot {
                    process_id: exit.process_id,
                    exit_code: exit.exit_code,
                    forced: exit.forced,
                    workers_reaped: exit.workers_reaped,
                }),
        })
        .collect();
    plugins.reverse();
    published.snapshot = HostRuntimeSnapshot {
        sequence: published.snapshot.sequence.saturating_add(1),
        sampled_at_unix_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| {
                duration.as_millis().min(u128::from(u64::MAX)) as u64
            }),
        runtime_stopping: false,
        owner_alive: true,
        retained_limit: MAX_HOSTS + 64,
        history_truncated: history_truncated || retained_terminal > 64,
        plugins,
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_bound_terminal_records_and_keep_all_live_owners_without_source_or_handles() {
        let mut owners = Vec::new();
        for index in 0..100 {
            let manifest = serde_json::from_value(json!({"schema":1,"id":format!("dev.sample-{index}"),"version":"1","host":{"entry":"host.js"},"permissions":["host.process"]})).unwrap();
            let mut owner = HostOwner::new(LoadedPlugin {
                manifest,
                source: None,
                host: Some(crate::plugins::LoadedHost {
                    root: std::path::PathBuf::from("C:/source-not-for-inspection"),
                    entry: std::path::PathBuf::from("C:/source-not-for-inspection/host.js"),
                    source: Arc::from("module.exports = SECRET_EXECUTABLE_SOURCE"),
                }),
                generation: 1,
            });
            owner.observation.state = if index < 84 {
                ExecutionState::Exited
            } else {
                owner.launching = true;
                ExecutionState::Starting
            };
            owners.push(owner);
        }
        let mut published = Published::default();
        update(&mut published, &owners);
        let first = published.snapshot.clone();
        assert_eq!(first.retained_limit, 80);
        assert_eq!(first.plugins.len(), 80);
        assert!(first.history_truncated);
        assert_eq!(
            first
                .plugins
                .iter()
                .filter(|plugin| plugin.state == ExecutionState::Starting)
                .count(),
            16
        );
        let json = serde_json::to_string(&first).unwrap();
        assert!(
            !json.contains("SECRET_EXECUTABLE_SOURCE")
                && !json.contains("source-not-for-inspection")
        );
        update(&mut published, &owners);
        assert_eq!(published.snapshot.sequence, first.sequence + 1);
        assert!(published.snapshot.sampled_at_unix_ms >= first.sampled_at_unix_ms);
        assert_eq!(
            serde_json::from_str::<HostRuntimeSnapshot>(&json).unwrap(),
            first
        );
    }
}
