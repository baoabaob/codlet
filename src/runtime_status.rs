//! Read-only, sampled Host state. No CDP client or renderer execution entrypoint lives here.
use std::fmt::Write as _;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

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

#[derive(Debug, Clone, Serialize, Deserialize)]
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

/// Readers only clone an Arc while holding this lock. Serialization and all IO
/// happen after releasing it; publication never waits for a client or a worker.
#[derive(Clone)]
pub struct StatusPublisher(Arc<Mutex<Arc<HostSnapshot>>>);

impl Default for StatusPublisher {
    fn default() -> Self {
        Self::new()
    }
}

impl StatusPublisher {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(Arc::new(HostSnapshot {
            host_pid: std::process::id(),
            codlet_version: env!("CARGO_PKG_VERSION").to_owned(),
            state: HostState::Starting,
            sequence: 0,
            sampled_at_unix_ms: now_ms(),
            codex: None,
            renderer: RendererStatus::default(),
            termination: None,
        }))))
    }

    pub fn snapshot(&self) -> Arc<HostSnapshot> {
        Arc::clone(&self.0.lock().unwrap_or_else(|p| p.into_inner()))
    }

    fn update(&self, update: impl FnOnce(&mut HostSnapshot)) {
        let mut current = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let snapshot = Arc::make_mut(&mut current);
        if snapshot.state == HostState::Terminated {
            return;
        }
        update(snapshot);
        snapshot.sequence = snapshot.sequence.saturating_add(1);
        snapshot.sampled_at_unix_ms = now_ms();
    }

    pub fn set_codex(&self, codex: CodexStatus) {
        self.update(|snapshot| snapshot.codex = Some(codex));
    }

    pub fn set_ready(&self) {
        self.update(|snapshot| snapshot.state = HostState::Ready);
    }

    pub fn publish_renderer(&self, renderer: RendererStatus) {
        self.update(|snapshot| snapshot.renderer = renderer);
    }

    pub fn terminate(&self, reason: impl Into<String>) {
        self.update(|snapshot| {
            snapshot.state = HostState::Terminated;
            snapshot.termination = Some(reason.into());
            snapshot.renderer.targets.clear();
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
