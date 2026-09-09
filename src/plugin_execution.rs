//! Read-only facts published by an execution owner for optional management UIs.
//! This module does not start plugins, inspect files, or route control requests.

use serde::{Deserialize, Serialize};

use crate::plugins::LoadedPlugin;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionState {
    Starting,
    Active,
    /// Stop was requested; the owner has not yet confirmed exit and cleanup.
    Stopping,
    /// The owner has confirmed process exit and finished supervisor cleanup.
    Failed,
    /// The owner has confirmed process exit and finished supervisor cleanup.
    Exited,
}

#[derive(Debug, Clone)]
pub struct PluginExecutionObservation {
    pub plugin: LoadedPlugin,
    pub state: ExecutionState,
    /// A current or last observed process ID; state determines current liveness.
    pub process_id: Option<u32>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostCleanupPhase {
    #[default]
    NotStarted,
    Running,
    Completed,
    Failed,
    TimedOut,
    Unavailable,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HostCleanupSnapshot {
    pub phase: HostCleanupPhase,
    pub remaining_budget_ms: Option<u64>,
    pub pending_requests: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HostProcessExitSnapshot {
    pub process_id: u32,
    pub exit_code: u32,
    pub forced: bool,
    pub workers_reaped: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HostPluginSnapshot {
    pub id: String,
    pub version: String,
    pub generation: u64,
    pub state: ExecutionState,
    pub process_id: Option<u32>,
    pub error: Option<String>,
    pub pending_core_requests: usize,
    pub subscriptions: usize,
    pub outbox: usize,
    pub launching: bool,
    pub cleanup: HostCleanupSnapshot,
    pub exit: Option<HostProcessExitSnapshot>,
}

/// Current owners and a bounded set of latest terminal records, never a complete
/// history. This cross-platform DTO carries no executable source or OS handles.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HostRuntimeSnapshot {
    pub sequence: u64,
    pub sampled_at_unix_ms: u64,
    pub runtime_stopping: bool,
    pub owner_alive: bool,
    pub retained_limit: usize,
    /// True once an older generation/terminal record has left this bounded list.
    pub history_truncated: bool,
    pub plugins: Vec<HostPluginSnapshot>,
}
