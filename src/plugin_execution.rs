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
