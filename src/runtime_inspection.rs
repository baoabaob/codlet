//! Read-only evidence from one Host publication. No plugin source, registry
//! preferences, executable authority, or mutable renderer handles cross here.

use serde::{Deserialize, Serialize};

use crate::capabilities::CapabilityDescriptor;
use crate::runtime_status::{CodexStatus, HostState, PluginStatus, StatusEvent};

pub const MAX_INSPECTION_PROVIDERS: usize = 256;
pub const MAX_INSPECTION_CAPABILITIES_PER_PROVIDER: usize = 128;
pub const MAX_INSPECTION_CAPABILITIES: usize = 1024;
pub const MAX_INSPECTION_ID_BYTES: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeInspection {
    pub host_incarnation: String,
    pub registry_scope: String,
    pub host_pid: u32,
    pub codlet_version: String,
    pub state: HostState,
    pub sequence: u64,
    pub sampled_at_unix_ms: u64,
    pub codex: Option<CodexStatus>,
    pub renderer: Option<RendererInspection>,
    pub termination: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RendererInspection {
    /// These are current kernel registrations, not declarations read from disk.
    /// Registration alone does not imply that a target can route a call.
    pub providers: Vec<RegisteredProvider>,
    pub targets: Vec<InspectedTarget>,
    pub recent_events: Vec<StatusEvent>,
    /// Omitted records cannot be interpreted as nonexistent or inactive.
    pub truncated: bool,
    pub lifecycle_busy: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Host,
    Renderer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisteredProvider {
    pub id: String,
    pub generation: u64,
    pub kind: ProviderKind,
    pub provides: Vec<CapabilityDescriptor>,
    pub capabilities_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InspectedTarget {
    pub target_id: String,
    pub session_id: String,
    pub session_live: bool,
    pub document_epoch: u64,
    pub recovery_pending: bool,
    pub scope_active: bool,
    pub plugins: Vec<PluginStatus>,
}
