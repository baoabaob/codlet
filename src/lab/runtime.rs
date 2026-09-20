//! Explicit choice of the normal plugin owner or the Core-only recovery owner.
use super::{LabError, Reporter, management};
use crate::cdp::{CdpClient, TargetSession};
use crate::plugin_control::{PluginControlError, PluginControlRequest};
use crate::runtime_control::{ControlBroker, ControlRequest, ControlStatus};
use crate::runtime_status::StatusPublisher;
use crate::safe_mode::RecoverySession;
use crate::windows::control_pipe::{ControlServer, RegistryScope};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

pub(super) enum LabRuntime {
    Normal(Box<management::LabRuntime>),
    Safe {
        session: RecoverySession,
        control: ControlBroker,
        server: Box<ControlServer>,
        receipts: BTreeSet<String>,
    },
}

impl LabRuntime {
    pub fn manage_service(&self) -> Option<crate::runtime_manage::RuntimeManageService> {
        match self {
            Self::Normal(owner) => Some(owner.manage_service.clone()),
            _ => None,
        }
    }
    pub fn prepare(path: PathBuf, safe: bool) -> Result<Self, LabError> {
        if !safe {
            return management::LabRuntime::prepare(path)
                .map(|owner| Self::Normal(Box::new(owner)));
        }
        let scope = RegistryScope::for_path(&path).map_err(preflight)?;
        let lease = scope
            .acquire(std::time::Duration::from_millis(1500))
            .map_err(preflight)?;
        crate::runtime_log::initialize(&path);
        let status = StatusPublisher::new();
        let server = ControlServer::bind_isolated(lease, status.clone()).map_err(preflight)?;
        let control = server.broker();
        let session = RecoverySession::new(path, control.clone(), status);
        Ok(Self::Safe {
            session,
            control,
            server: Box::new(server),
            receipts: BTreeSet::new(),
        })
    }
    pub fn registry_path(&self) -> &Path {
        match self {
            Self::Normal(owner) => owner.registry_path(),
            Self::Safe { session, .. } => session.path(),
        }
    }
    pub fn registry_scope(&self) -> &str {
        match self {
            Self::Normal(owner) => owner.registry_scope(),
            Self::Safe { server, .. } => server.scope().id(),
        }
    }
    pub fn renderer(&mut self) -> Option<&mut crate::renderer::RendererRuntime> {
        match self {
            Self::Normal(owner) => Some(&mut owner.renderer),
            _ => None,
        }
    }
    pub fn observe_client_versions(&mut self, version: String) {
        if let Self::Normal(owner) = self {
            owner.observe_client_versions(version);
        }
    }
    pub fn configure_runtime_updates(
        &mut self,
        child: &crate::windows::process::ChildProcess,
        reporter: &mut Reporter,
    ) {
        if let Self::Normal(owner) = self {
            owner.configure_runtime_updates(child, reporter);
        }
    }
    pub fn take_update_restart_requested(&mut self) -> bool {
        match self {
            Self::Normal(owner) => owner.take_update_restart_requested(),
            _ => false,
        }
    }
    pub fn take_update_restart_cancelled(&mut self) -> bool {
        match self {
            Self::Normal(owner) => owner.take_update_restart_cancelled(),
            _ => false,
        }
    }
    pub fn update_installing(&self) -> bool {
        matches!(self, Self::Normal(owner) if owner.update_installing())
    }
    pub fn update_preparation_blocked(&self) -> bool {
        matches!(self, Self::Normal(owner) if owner.update_preparation_blocked())
    }
    pub fn activate(
        &mut self,
        client: CdpClient,
        sessions: &BTreeMap<String, TargetSession>,
        reporter: &mut Reporter,
    ) -> Result<(), LabError> {
        match self {
            Self::Normal(owner) => owner.activate(client, sessions, reporter),
            Self::Safe { session, .. } => {
                session.ready();
                reporter.emit("safe_mode_ready", serde_json::json!({"plugins_loaded":0,"plugin_executors":[],"registry_unchanged":true}));
                Ok(())
            }
        }
    }
    pub fn stop(&mut self, reporter: &mut Reporter) -> bool {
        match self {
            Self::Normal(owner) => owner.stop(reporter),
            Self::Safe { session, .. } => {
                session.stop("isolated_safe_mode_stopped");
                true
            }
        }
    }
    pub fn submit(&mut self, request: PluginControlRequest) -> Result<String, PluginControlError> {
        match self {
            Self::Normal(owner) => owner.submit(request),
            Self::Safe {
                control, receipts, ..
            } => {
                let prepared = control.handle(ControlRequest::prepare(request));
                if prepared.status != ControlStatus::Prepared {
                    return Err(PluginControlError::new(
                        "safe_mode_control",
                        prepared
                            .error
                            .unwrap_or_else(|| format!("{:?}", prepared.status)),
                    ));
                }
                let ticket = prepared
                    .operation_id()
                    .expect("prepared receipt")
                    .to_owned();
                let submitted = control.handle(ControlRequest::submit(&ticket));
                if submitted.status != ControlStatus::Queued {
                    return Err(PluginControlError::new(
                        "safe_mode_control",
                        "Recovery request was not queued",
                    ));
                }
                receipts.insert(ticket.clone());
                Ok(ticket)
            }
        }
    }
    pub fn pump(
        &mut self,
        sessions: &BTreeMap<String, TargetSession>,
        reporter: &mut Reporter,
    ) -> Result<(), LabError> {
        match self {
            Self::Normal(owner) => owner.pump(sessions, reporter),
            Self::Safe {
                session,
                control,
                receipts,
                ..
            } => {
                session.pump();
                receipts.retain(|ticket| {
                    let report = control.handle(ControlRequest::result(ticket));
                    if matches!(report.status, ControlStatus::Queued | ControlStatus::Running) { return true; }
                    reporter.emit("plugin_control_result", serde_json::json!({"operation_id":ticket,"control":report,"safe_mode":true}));
                    false
                });
                Ok(())
            }
        }
    }
}
fn preflight(error: impl std::fmt::Display) -> LabError {
    LabError::Preflight(error.to_string())
}
