//! Plugin-management domain values shared by the renderer owner and control clients.
//! No transport, threads, Codex UI knowledge or execution authority lives here.
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginControlAction {
    Enable,
    Disable,
    Reload,
    Revoke,
    Import,
    Remove,
}

impl PluginControlAction {
    pub(crate) fn starts_plugin(self) -> bool {
        matches!(self, Self::Enable | Self::Import)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Enable => "enable",
            Self::Disable => "disable",
            Self::Reload => "reload",
            Self::Revoke => "revoke",
            Self::Import => "import",
            Self::Remove => "remove",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginControlRequest {
    pub action: PluginControlAction,
    pub plugin_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission: Option<crate::plugins::Permission>,
    /// Explicitly confirmed stop of the enabled/running dependent closure.
    #[serde(default, skip_serializing_if = "is_false")]
    pub cascade: bool,
    /// Explicit local selection and grants. Submission still carries only a receipt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_import: Option<Box<crate::local_import::LocalImportRequest>>,
}

fn is_false(value: &bool) -> bool {
    !value
}

impl PluginControlRequest {
    pub fn validate(&self) -> Result<(), PluginControlError> {
        if self.cascade
            && !matches!(
                self.action,
                PluginControlAction::Disable | PluginControlAction::Remove
            )
        {
            return Err(PluginControlError::new(
                "invalid_cascade",
                "cascade is only valid for disable or remove",
            ));
        }
        if !crate::plugins::valid_plugin_id(&self.plugin_id) {
            return Err(PluginControlError::new(
                "invalid_plugin_id",
                "plugin id is invalid",
            ));
        }
        if (self.action == PluginControlAction::Revoke) != self.permission.is_some() {
            return Err(PluginControlError::new(
                "invalid_permission",
                "Only revoke requires one explicit permission.",
            ));
        }
        if (self.action == PluginControlAction::Import) != self.local_import.is_some() {
            return Err(PluginControlError::new(
                "invalid_import",
                "Only import requires one explicit local selection.",
            ));
        }
        if let Some(selection) = &self.local_import {
            selection.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginControlOutcome {
    Applied,
    Unchanged,
    RolledBack,
    Degraded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginGeneration {
    pub plugin_id: String,
    pub generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginTargetFailure {
    pub target_id: String,
    pub plugin_id: String,
    pub stage: String,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginControlReport {
    pub action: PluginControlAction,
    pub plugin_id: String,
    pub outcome: PluginControlOutcome,
    pub desired_enabled: bool,
    pub affected_plugin_ids: Vec<String>,
    /// Generations remaining in the runtime catalog, not every allocated candidate.
    pub generations: Vec<PluginGeneration>,
    pub target_failures: Vec<PluginTargetFailure>,
    pub message: Option<String>,
}

impl PluginControlReport {
    pub fn is_success(&self) -> bool {
        matches!(
            self.outcome,
            PluginControlOutcome::Applied | PluginControlOutcome::Unchanged
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[error("{code}: {message}")]
pub struct PluginControlError {
    pub code: String,
    pub message: String,
}

impl PluginControlError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
