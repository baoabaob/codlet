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
    Update,
    Rollback,
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
            Self::Update => "update",
            Self::Rollback => "rollback",
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
    /// Explicit local or managed package selection and grants. Submission carries only a receipt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_import: Option<Box<crate::local_import::LocalImportRequest>>,
    /// Present only after explicit confirmation to delete this registered source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remove_source: Option<Box<crate::source_removal::SourceRemovalRequest>>,
}

fn is_false(value: &bool) -> bool {
    !value
}

impl PluginControlRequest {
    pub(crate) fn activation_requested(&self) -> bool {
        self.action.starts_plugin()
            || matches!(
                self.action,
                PluginControlAction::Update | PluginControlAction::Rollback
            ) && self
                .local_import
                .as_ref()
                .is_some_and(|selection| selection.enable)
    }

    pub fn validate(&self) -> Result<(), PluginControlError> {
        if let Some(selection) = &self.remove_source {
            if self.action != PluginControlAction::Remove {
                return Err(PluginControlError::new(
                    "invalid_source_removal",
                    "Only remove may explicitly delete a confirmed source directory.",
                ));
            }
            selection.validate()?;
        }
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
        if matches!(
            self.action,
            PluginControlAction::Import
                | PluginControlAction::Update
                | PluginControlAction::Rollback
        ) != self.local_import.is_some()
        {
            return Err(PluginControlError::new(
                "invalid_import",
                "Import, update and rollback require one explicit package selection.",
            ));
        }
        if let Some(selection) = &self.local_import {
            selection.validate()?;
            use crate::managed_plugins::ManagedOperation;
            let valid = match self.action {
                PluginControlAction::Import => {
                    matches!(selection.managed, None | Some(ManagedOperation::Install))
                }
                PluginControlAction::Update => selection.managed == Some(ManagedOperation::Update),
                PluginControlAction::Rollback => {
                    selection.managed == Some(ManagedOperation::Rollback)
                }
                _ => false,
            };
            if !valid {
                return Err(PluginControlError::new(
                    "invalid_managed_operation",
                    "The action must match the previewed managed operation.",
                ));
            }
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

pub(crate) fn recovery_request(request: &PluginControlRequest) -> bool {
    matches!(
        request.action,
        PluginControlAction::Disable | PluginControlAction::Revoke
    ) || (request.action == PluginControlAction::Remove && request.remove_source.is_none())
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
