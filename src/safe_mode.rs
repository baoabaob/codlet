//! A recovery owner with no plugin catalog, JavaScript runtime, watcher, or updater.
use crate::runtime_control::ControlBroker;
use crate::runtime_status::{RendererStatus, StatusEvent, StatusPublisher};
use std::path::PathBuf;

pub(crate) struct RecoverySession {
    path: PathBuf,
    control: ControlBroker,
    status: StatusPublisher,
    stopped: std::cell::Cell<bool>,
    sequence: std::cell::Cell<u64>,
}

impl RecoverySession {
    /// Deliberately does not read the registry: malformed configuration must not
    /// prevent launching the official client for recovery.
    pub(crate) fn new(path: PathBuf, control: ControlBroker, status: StatusPublisher) -> Self {
        control.restrict_to_recovery();
        Self {
            path,
            control,
            status,
            stopped: std::cell::Cell::new(false),
            sequence: std::cell::Cell::new(0),
        }
    }

    pub(crate) fn ready(&self) {
        if self.stopped.get() {
            return;
        }
        let events = vec![StatusEvent {
            target_id: String::new(),
            code: "safe_mode".into(),
            message: "Safe mode: all plugins skipped; saved enablement is unchanged".into(),
        }];
        self.status.publish_renderer_observation(
            RendererStatus {
                recent_events: events.clone(),
                ..Default::default()
            },
            crate::runtime_inspection::RendererInspection {
                recent_events: events,
                ..Default::default()
            },
        );
        self.publish_hosts();
        self.status.set_ready();
        self.control.set_ready();
    }

    pub(crate) fn pump(&self) {
        if self.stopped.get() {
            return;
        }
        self.publish_hosts();
        if let Some(job) = self.control.take_next() {
            let result = crate::plugin_cli::recover_in_safe_mode(&self.path, &job.request);
            if let Err(error) = &result {
                crate::runtime_log::error("safe_mode_recovery", &error.to_string());
            }
            self.control.complete(&job.operation_id, result);
        }
    }

    pub(crate) fn stop(&self, reason: &str) {
        if self.stopped.replace(true) {
            return;
        }
        self.control.stop();
        self.publish_hosts();
        self.status.terminate(reason.to_owned());
    }

    fn publish_hosts(&self) {
        self.sequence.set(self.sequence.get().saturating_add(1));
        self.status
            .publish_host_observation(crate::plugin_execution::HostRuntimeSnapshot {
                sequence: self.sequence.get(),
                owner_alive: !self.stopped.get(),
                runtime_stopping: self.stopped.get(),
                sampled_at_unix_ms: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
                ..Default::default()
            });
    }

    #[cfg(windows)]
    pub(crate) fn path(&self) -> &std::path::Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_control::{PluginControlAction, PluginControlRequest};
    use crate::runtime_control::{ControlRequest, ControlStatus};

    fn request(action: PluginControlAction) -> PluginControlRequest {
        PluginControlRequest {
            action,
            plugin_id: "dev.broken".into(),
            permission: None,
            cascade: false,
            remove_source: None,
            local_import: None,
        }
    }

    #[test]
    fn corrupt_registry_still_becomes_ready_without_changing_it_or_enabling_plugins() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.json");
        std::fs::write(&path, b"not json").unwrap();
        let status = StatusPublisher::new();
        let control = ControlBroker::new([3; 16], "a".repeat(64));
        let session = RecoverySession::new(path.clone(), control.clone(), status);
        session.ready();
        for action in [PluginControlAction::Enable, PluginControlAction::Reload] {
            assert_eq!(
                control
                    .handle(ControlRequest::prepare(request(action)))
                    .status,
                ControlStatus::InvalidRequest
            );
        }
        assert_eq!(std::fs::read(path).unwrap(), b"not json");
        assert!(control.take_next().is_none());
        session.stop("test_exit");
    }

    #[test]
    fn disable_of_broken_source_is_saved_once_and_next_normal_launch_remains_disabled() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.json");
        let mut registry = crate::plugins::PluginRegistry::load(&path).unwrap();
        registry
            .register_local(
                "dev.broken",
                crate::plugins::LocalPluginRegistration {
                    path: temp.path().canonicalize().unwrap().join("missing-source"),
                    ..Default::default()
                },
            )
            .unwrap();
        registry.set_enabled("dev.broken", true).unwrap();
        registry.save().unwrap();
        let before = std::fs::read(&path).unwrap();
        let control = ControlBroker::new([4; 16], "b".repeat(64));
        let session = RecoverySession::new(path.clone(), control.clone(), StatusPublisher::new());
        session.ready();
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let prepared = control.handle(ControlRequest::prepare(request(
            PluginControlAction::Disable,
        )));
        let ticket = prepared.operation_id().unwrap().to_owned();
        let submitted = control.handle(ControlRequest::submit(ticket.clone()));
        assert_eq!(submitted.status, ControlStatus::Queued);
        session.pump();
        let result = control.handle(ControlRequest::result(ticket.clone()));
        assert_eq!(result.status, ControlStatus::Completed, "{result:?}");
        assert!(
            !crate::plugins::PluginRegistry::load(&path)
                .unwrap()
                .is_enabled("dev.broken")
        );
        let saved = std::fs::read(&path).unwrap();
        control.handle(ControlRequest::submit(ticket));
        session.pump();
        assert_eq!(std::fs::read(&path).unwrap(), saved);
    }
}
