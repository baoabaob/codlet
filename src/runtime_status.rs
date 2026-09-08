//! Read-only, sampled Host state. No CDP client or renderer execution entrypoint lives here.
use std::fmt::Write as _;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::runtime_inspection::{RendererInspection, RuntimeInspection};

pub const STATUS_SCHEMA_VERSION: u32 = 1;
pub const MAX_STATUS_REQUEST_BYTES: usize = 1024;
pub const MAX_STATUS_RESPONSE_BYTES: usize = 256 * 1024;
pub const MAX_STATUS_TARGETS: usize = 128;
pub const MAX_STATUS_PLUGINS_PER_TARGET: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StatusCode {
    Running,
    NotRunning,
    Busy,
    Timeout,
    Incompatible,
    UntrustedServer,
    CommunicationError,
    InvalidRequest,
    SnapshotTooLarge,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusReport {
    pub schema_version: u32,
    pub status: StatusCode,
    pub snapshot: Option<HostSnapshot>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostState {
    Starting,
    Ready,
    Terminated,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostSnapshot {
    pub host_pid: u32,
    pub codlet_version: String,
    pub state: HostState,
    pub sequence: u64,
    pub sampled_at_unix_ms: u64,
    pub codex: Option<CodexStatus>,
    pub renderer: RendererStatus,
    pub termination: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CodexStatus {
    pub pid: u32,
    pub package_full_name: String,
    pub package_version: String,
    pub executable: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RendererStatus {
    pub targets: Vec<TargetStatus>,
    pub recent_events: Vec<StatusEvent>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TargetStatus {
    pub target_id: String,
    pub session_id: String,
    pub session_live: bool,
    pub plugins: Vec<PluginStatus>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginLifecycle {
    Activating,
    Ready,
    Active,
    Stopping,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginStatus {
    pub id: String,
    pub version: String,
    pub generation: u64,
    pub lifecycle: PluginLifecycle,
    pub context_present: bool,
    pub activation_confirmed: bool,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusEvent {
    pub target_id: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StatusRequest {
    schema_version: u32,
    command: String,
}

pub(crate) fn validate_request(bytes: &[u8]) -> Result<(), StatusCode> {
    if bytes.len() > MAX_STATUS_REQUEST_BYTES {
        return Err(StatusCode::InvalidRequest);
    }
    let request: StatusRequest =
        serde_json::from_slice(bytes).map_err(|_| StatusCode::InvalidRequest)?;
    if request.schema_version != STATUS_SCHEMA_VERSION {
        return Err(StatusCode::Incompatible);
    }
    if request.command != "status" {
        return Err(StatusCode::InvalidRequest);
    }
    Ok(())
}

impl StatusReport {
    pub fn outcome(status: StatusCode, error: Option<String>) -> Self {
        Self {
            schema_version: STATUS_SCHEMA_VERSION,
            status,
            snapshot: None,
            error,
        }
    }

    pub fn is_success(&self) -> bool {
        matches!(self.status, StatusCode::Running | StatusCode::NotRunning)
    }

    pub fn to_human_readable(&self) -> String {
        let code = serde_json::to_value(self.status).expect("status is serializable");
        let mut output = format!(
            "host-status: {}\nschema-version: {}\n",
            code.as_str().unwrap(),
            self.schema_version
        );
        if let Some(snapshot) = &self.snapshot {
            let state = serde_json::to_value(snapshot.state).expect("state is serializable");
            let _ = writeln!(
                output,
                "host-pid: {}\ncodlet-version: {}\nhost-state: {}\nsnapshot-sequence: {}\nsampled-at-unix-ms: {}",
                snapshot.host_pid,
                snapshot.codlet_version,
                state.as_str().unwrap(),
                snapshot.sequence,
                snapshot.sampled_at_unix_ms
            );
            if let Some(codex) = &snapshot.codex {
                let _ = writeln!(
                    output,
                    "codex-pid: {}\npackage: {}\npackage-version: {}",
                    codex.pid, codex.package_full_name, codex.package_version
                );
            }
            for target in &snapshot.renderer.targets {
                let _ = writeln!(
                    output,
                    "target: {}; session={}; live={}",
                    target.target_id, target.session_id, target.session_live
                );
                for plugin in &target.plugins {
                    let state =
                        serde_json::to_value(plugin.lifecycle).expect("lifecycle is serializable");
                    let _ = writeln!(
                        output,
                        "  plugin: {}; version={}; generation={}; lifecycle={}; context-present={}; activation-confirmed={}; active={}",
                        plugin.id,
                        plugin.version,
                        plugin.generation,
                        state.as_str().unwrap(),
                        plugin.context_present,
                        plugin.activation_confirmed,
                        plugin.active
                    );
                }
            }
            for event in &snapshot.renderer.recent_events {
                let _ = writeln!(
                    output,
                    "renderer-event: target={}; code={}; message={}",
                    event.target_id, event.code, event.message
                );
            }
            if snapshot.renderer.truncated {
                output.push_str("snapshot-truncated: true\n");
            }
            if let Some(reason) = &snapshot.termination {
                let _ = writeln!(output, "termination: {reason}");
            }
        }
        if let Some(error) = &self.error {
            let _ = writeln!(output, "error: {error}");
        }
        output
    }
}

/// Readers only clone the components of a single publication while holding this
/// lock. DTO construction, serialization and IO happen after releasing it.
#[derive(Clone)]
pub struct StatusPublisher(Arc<Mutex<PublishedState>>);

struct PublishedState {
    legacy: Arc<HostSnapshot>,
    renderer: Option<Arc<RendererInspection>>,
    identity: Option<Arc<RuntimeIdentity>>,
}

#[derive(Debug, PartialEq, Eq)]
struct RuntimeIdentity {
    incarnation: String,
    scope: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum RuntimeIdentityError {
    #[error("the publisher is already bound to a different Host incarnation or registry scope")]
    AlreadyBound,
    #[error("a terminated publisher cannot acquire a new Host identity")]
    Terminated,
}

impl Default for StatusPublisher {
    fn default() -> Self {
        Self::new()
    }
}

impl StatusPublisher {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(PublishedState {
            legacy: Arc::new(HostSnapshot {
                host_pid: std::process::id(),
                codlet_version: env!("CARGO_PKG_VERSION").to_owned(),
                state: HostState::Starting,
                sequence: 0,
                sampled_at_unix_ms: now_ms(),
                codex: None,
                renderer: RendererStatus::default(),
                termination: None,
            }),
            renderer: None,
            identity: None,
        })))
    }

    pub fn snapshot(&self) -> Arc<HostSnapshot> {
        Arc::clone(&self.0.lock().unwrap_or_else(|p| p.into_inner()).legacy)
    }

    pub fn bind_runtime_identity(
        &self,
        incarnation: [u8; 16],
        scope: &str,
    ) -> Result<(), RuntimeIdentityError> {
        let identity = RuntimeIdentity {
            incarnation: incarnation
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
            scope: scope.to_owned(),
        };
        let mut current = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(existing) = &current.identity {
            return if **existing == identity {
                Ok(())
            } else {
                Err(RuntimeIdentityError::AlreadyBound)
            };
        }
        if current.legacy.state == HostState::Terminated {
            return Err(RuntimeIdentityError::Terminated);
        }
        current.identity = Some(Arc::new(identity));
        let legacy = Arc::make_mut(&mut current.legacy);
        legacy.sequence = legacy.sequence.saturating_add(1);
        legacy.sampled_at_unix_ms = now_ms();
        Ok(())
    }

    pub fn inspection_snapshot(&self) -> Option<RuntimeInspection> {
        let (legacy, renderer, identity) = {
            let current = self.0.lock().unwrap_or_else(|p| p.into_inner());
            (
                Arc::clone(&current.legacy),
                current.renderer.as_ref().map(Arc::clone),
                Arc::clone(current.identity.as_ref()?),
            )
        };
        Some(RuntimeInspection {
            host_incarnation: identity.incarnation.clone(),
            registry_scope: identity.scope.clone(),
            host_pid: legacy.host_pid,
            codlet_version: legacy.codlet_version.clone(),
            state: legacy.state,
            sequence: legacy.sequence,
            sampled_at_unix_ms: legacy.sampled_at_unix_ms,
            codex: legacy.codex.clone(),
            renderer: renderer.as_deref().cloned(),
            termination: legacy.termination.clone(),
        })
    }

    fn update(&self, update: impl FnOnce(&mut HostSnapshot, &mut Option<Arc<RendererInspection>>)) {
        let mut current = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let PublishedState {
            legacy, renderer, ..
        } = &mut *current;
        let snapshot = Arc::make_mut(legacy);
        if snapshot.state == HostState::Terminated {
            return;
        }
        update(snapshot, renderer);
        snapshot.sequence = snapshot.sequence.saturating_add(1);
        snapshot.sampled_at_unix_ms = now_ms();
    }

    pub fn set_codex(&self, codex: CodexStatus) {
        self.update(|snapshot, _| snapshot.codex = Some(codex));
    }

    pub fn set_ready(&self) {
        self.update(|snapshot, _| snapshot.state = HostState::Ready);
    }

    pub fn publish_renderer(&self, renderer: RendererStatus) {
        self.update(|snapshot, inspection| {
            snapshot.renderer = renderer;
            // Legacy-only callers did not sample provider facts for this state.
            *inspection = None;
        });
    }

    pub fn publish_renderer_observation(
        &self,
        legacy: RendererStatus,
        inspection: RendererInspection,
    ) {
        let inspection = Arc::new(inspection);
        self.update(|snapshot, renderer| {
            snapshot.renderer = legacy;
            *renderer = Some(inspection);
        });
    }

    pub fn terminate(&self, reason: impl Into<String>) {
        self.update(|snapshot, inspection| {
            snapshot.state = HostState::Terminated;
            snapshot.termination = Some(reason.into());
            snapshot.renderer.targets.clear();
            *inspection = None;
        });
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capabilities::{CapabilityDescriptor, CapabilityScope};
    use crate::runtime_inspection::{InspectedTarget, ProviderKind, RegisteredProvider};

    fn observation(generation: u64) -> (RendererStatus, RendererInspection) {
        let plugin = PluginStatus {
            id: "dev.provider".into(),
            version: "1".into(),
            generation,
            lifecycle: PluginLifecycle::Active,
            context_present: true,
            activation_confirmed: true,
            active: true,
        };
        (
            RendererStatus {
                targets: vec![TargetStatus {
                    target_id: "main".into(),
                    session_id: "session-main".into(),
                    session_live: true,
                    plugins: vec![plugin.clone()],
                }],
                ..RendererStatus::default()
            },
            RendererInspection {
                providers: vec![RegisteredProvider {
                    id: "dev.provider".into(),
                    generation,
                    kind: ProviderKind::Renderer,
                    provides: vec![
                        CapabilityDescriptor::new("dev.api", 1, CapabilityScope::Target).unwrap(),
                    ],
                    capabilities_truncated: false,
                }],
                targets: vec![InspectedTarget {
                    target_id: "main".into(),
                    session_id: "session-main".into(),
                    session_live: true,
                    document_epoch: generation,
                    recovery_pending: false,
                    scope_active: true,
                    plugins: vec![plugin],
                }],
                ..RendererInspection::default()
            },
        )
    }

    #[test]
    fn inspection_identity_legacy_publication_and_termination_keep_status_v1_unchanged() {
        let publisher = StatusPublisher::new();
        assert!(publisher.inspection_snapshot().is_none());
        publisher
            .bind_runtime_identity([42; 16], "fixture-scope")
            .unwrap();
        let bound_sequence = publisher.snapshot().sequence;
        publisher
            .bind_runtime_identity([42; 16], "fixture-scope")
            .unwrap();
        assert_eq!(publisher.snapshot().sequence, bound_sequence);
        assert_eq!(
            publisher.bind_runtime_identity([41; 16], "fixture-scope"),
            Err(RuntimeIdentityError::AlreadyBound)
        );
        assert_eq!(
            publisher.bind_runtime_identity([42; 16], "other-scope"),
            Err(RuntimeIdentityError::AlreadyBound)
        );
        let (legacy, renderer) = observation(1);
        publisher.publish_renderer_observation(legacy, renderer);
        let complete = publisher.inspection_snapshot().unwrap();
        assert_eq!(complete.host_incarnation, "2a".repeat(16));
        assert_eq!(complete.registry_scope, "fixture-scope");
        let wire = serde_json::to_value(&*publisher.snapshot()).unwrap();
        let fields: std::collections::BTreeSet<_> = wire
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            fields,
            std::collections::BTreeSet::from([
                "host_pid",
                "codlet_version",
                "state",
                "sequence",
                "sampled_at_unix_ms",
                "codex",
                "renderer",
                "termination"
            ])
        );

        publisher.publish_renderer(RendererStatus::default());
        assert!(publisher.inspection_snapshot().unwrap().renderer.is_none());
        assert_eq!(
            complete.renderer.as_ref().unwrap().providers[0].generation,
            1
        );
        let (legacy, renderer) = observation(2);
        publisher.publish_renderer_observation(legacy, renderer);
        publisher.terminate("test shutdown");
        let terminal = publisher.inspection_snapshot().unwrap();
        let (legacy, renderer) = observation(3);
        publisher.publish_renderer_observation(legacy, renderer);
        publisher.set_ready();
        assert_eq!(publisher.inspection_snapshot().unwrap(), terminal);
        assert_eq!(terminal.state, HostState::Terminated);
        assert!(terminal.renderer.is_none());
        assert!(publisher.snapshot().renderer.targets.is_empty());
        let unbound = StatusPublisher::new();
        unbound.terminate("never bound");
        assert_eq!(
            unbound.bind_runtime_identity([42; 16], "fixture-scope"),
            Err(RuntimeIdentityError::Terminated)
        );
        assert!(unbound.inspection_snapshot().is_none());
    }

    #[test]
    fn inspection_metadata_and_provider_target_generations_are_one_immutable_publication() {
        let publisher = StatusPublisher::new();
        publisher
            .bind_runtime_identity([7; 16], "fixture-scope")
            .unwrap();
        publisher.set_ready();
        let (legacy, renderer) = observation(1);
        publisher.publish_renderer_observation(legacy, renderer);
        let original = publisher.inspection_snapshot().unwrap();
        let base_sequence = original.sequence;
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                barrier.wait();
                for generation in 2..=101 {
                    let (legacy, renderer) = observation(generation);
                    publisher.publish_renderer_observation(legacy, renderer);
                }
            });
            barrier.wait();
            for _ in 0..500 {
                let sample = publisher.inspection_snapshot().unwrap();
                let renderer = sample.renderer.unwrap();
                let generation = renderer.providers[0].generation;
                assert_eq!(renderer.targets[0].plugins[0].generation, generation);
                assert_eq!(renderer.targets[0].document_epoch, generation);
                assert_eq!(sample.sequence, base_sequence + generation - 1);
            }
        });
        assert_eq!(original.renderer.unwrap().providers[0].generation, 1);
        let legacy = publisher.snapshot();
        let latest = publisher.inspection_snapshot().unwrap();
        assert_eq!(latest.sequence, legacy.sequence);
        assert_eq!(latest.sampled_at_unix_ms, legacy.sampled_at_unix_ms);
        assert_eq!(
            latest.renderer.unwrap().targets[0].plugins,
            legacy.renderer.targets[0].plugins
        );
    }

    #[test]
    fn status_requests_are_strict_and_read_only() {
        assert_eq!(
            validate_request(br#"{"schema_version":1,"command":"status"}"#),
            Ok(())
        );
        assert_eq!(
            validate_request(br#"{"schema_version":2,"command":"status"}"#),
            Err(StatusCode::Incompatible)
        );
        for bytes in [
            br#"{"schema_version":1,"command":"eval"}"#.as_slice(),
            br#"{"schema_version":1,"command":"status","js":"1+1"}"#,
            br#"{"schema_version":1,"command":"status","command":"status"}"#,
            b"[]",
            b"null",
        ] {
            assert_eq!(validate_request(bytes), Err(StatusCode::InvalidRequest));
        }
        assert_eq!(
            validate_request(&vec![b' '; MAX_STATUS_REQUEST_BYTES + 1]),
            Err(StatusCode::InvalidRequest)
        );
    }

    #[test]
    fn publication_tracks_start_ready_and_terminal_without_resurrection() {
        let publisher = StatusPublisher::new();
        assert_eq!(publisher.snapshot().state, HostState::Starting);
        assert!(publisher.snapshot().codex.is_none());
        publisher.set_ready();
        assert_eq!(publisher.snapshot().state, HostState::Ready);
        publisher.terminate("child_exited:0");
        let terminal = publisher.snapshot();
        publisher.set_ready();
        assert_eq!(publisher.snapshot().state, HostState::Terminated);
        assert_eq!(publisher.snapshot().sequence, terminal.sequence);
        assert!(terminal.sampled_at_unix_ms > 0);
        let report = StatusReport::outcome(StatusCode::NotRunning, None);
        assert_eq!(serde_json::to_value(report).unwrap()["schema_version"], 1);
    }

    #[test]
    fn concurrent_publication_cannot_lose_updates_or_revive_terminated_host() {
        let publisher = StatusPublisher::new();
        let barrier = Arc::new(std::sync::Barrier::new(5));
        let workers: Vec<_> = (0..4)
            .map(|_| {
                let publisher = publisher.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    for _ in 0..100 {
                        publisher.set_ready();
                    }
                })
            })
            .collect();
        barrier.wait();
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(publisher.snapshot().sequence, 400);
        std::thread::scope(|scope| {
            for _ in 0..4 {
                let publisher = &publisher;
                scope.spawn(move || {
                    for _ in 0..100 {
                        publisher.publish_renderer(RendererStatus::default());
                    }
                });
            }
            publisher.terminate("test_end");
        });
        assert_eq!(publisher.snapshot().state, HostState::Terminated);
        assert_eq!(
            publisher.snapshot().termination.as_deref(),
            Some("test_end")
        );
        assert!(publisher.snapshot().sequence <= 801);
    }
}
