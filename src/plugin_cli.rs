//! CLI routing and presentation for plugin management. This module never owns a
//! renderer; online mutations execute in the Host, and offline edits hold its lease.
use std::time::{Duration, Instant};

use thiserror::Error;

use crate::local_plugins::{LocalPluginError, load_local_plugin};
use crate::plugin_control::{PluginControlAction, PluginControlError, PluginControlRequest};
use crate::plugins::{
    ManifestError, PluginRegistry, PluginRegistryError, bundled_plugins, default_registry_path,
};
use crate::runtime_control::{
    ControlCompletion, ControlReport, ControlRequest, ControlStatus, valid_operation_id,
};
use crate::runtime_status::StatusCode;
use crate::windows::control_pipe::{
    ControlPipeError, RegistryScope, RegistryScopeGuard, discover, query,
};
use crate::windows::launch_mutex::LaunchMutexGuard;
use crate::windows::status_pipe::query_current_user;

const OFFLINE_LEASE_TIMEOUT: Duration = Duration::from_millis(1500);
const OFFLINE_LAUNCH_TIMEOUT: Duration = Duration::from_secs(5);
const OPERATION_WAIT_TIMEOUT: Duration = Duration::from_secs(15);
const RESULT_POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, Error)]
pub enum PluginCliError {
    #[error(transparent)]
    Registry(#[from] PluginRegistryError),
    #[error(transparent)]
    Manifest(#[from] ManifestError),
    #[error(transparent)]
    LocalPlugin(#[from] LocalPluginError),
    #[error(transparent)]
    Request(#[from] PluginControlError),
    #[error(transparent)]
    Pipe(#[from] ControlPipeError),
    #[error("unknown plugin {0}; use `codlet plugin list` to inspect available plugins")]
    UnknownPlugin(String),
    #[error("plugin reload requires a running Codlet Host for this registry")]
    ReloadOffline,
    #[error("plugin management failed: {0}")]
    Control(String),
    #[error(
        "operation {0} is not confirmed complete; do not repeat the mutation, use `codlet plugin operation {0}`"
    )]
    Uncertain(String),
    #[error(
        "operation was not submitted ({0}); retry the plugin command later to obtain a new receipt"
    )]
    NotSubmitted(String),
    #[error("offline edit refused: {0}")]
    OfflineUnavailable(String),
    #[error("invalid operation receipt")]
    InvalidOperation,
}

pub fn manage(mut request: PluginControlRequest, json: bool) -> Result<(), PluginCliError> {
    request.plugin_id = crate::plugins::canonical_plugin_id(&request.plugin_id).to_owned();
    with_output(json, |output| manage_inner(request, output))
}

#[derive(Default)]
struct CliOutput {
    ticket: Option<String>,
    control: Option<ControlReport>,
    offline: Option<(String, bool)>,
}

fn with_output(
    json: bool,
    work: impl FnOnce(&mut CliOutput) -> Result<(), PluginCliError>,
) -> Result<(), PluginCliError> {
    let mut output = CliOutput::default();
    let result = work(&mut output);
    if json {
        let outcome = if output.offline.is_some() {
            "offline_saved"
        } else if matches!(&result, Err(PluginCliError::Uncertain(_))) {
            "uncertain"
        } else if matches!(&result, Err(PluginCliError::NotSubmitted(_))) {
            "not_submitted"
        } else if result.is_err() {
            "failed"
        } else if output
            .control
            .as_ref()
            .is_some_and(|report| report.status == ControlStatus::Completed)
        {
            "completed"
        } else {
            "operation_status"
        };
        let error = result
            .as_ref()
            .err()
            .map(|error| serde_json::json!({"code": error.code(), "message": error.to_string()}));
        let offline = output.offline.as_ref().map(|(plugin_id, enabled)| {
            serde_json::json!({
                "plugin_id": plugin_id, "enabled": enabled, "applies": "next-codlet-launch"
            })
        });
        println!(
            "{}",
            serde_json::json!({"schema_version": 1, "outcome": outcome,
            "operation_id": output.ticket, "control": output.control, "offline": offline, "error": error})
        );
    } else if let Some((plugin_id, enabled)) = &output.offline {
        println!("plugin-state: id={plugin_id}; enabled={enabled}; applies=next-codlet-launch");
    } else if let Some(report) = &output.control {
        print_report(report, output.ticket.as_deref());
    }
    result
}

impl PluginCliError {
    fn code(&self) -> &str {
        match self {
            Self::Registry(_) => "registry_error",
            Self::Manifest(_) => "manifest_error",
            Self::LocalPlugin(_) => "local_plugin_error",
            Self::Request(error) => &error.code,
            Self::Pipe(_) => "ipc_error",
            Self::UnknownPlugin(_) => "unknown_plugin",
            Self::ReloadOffline => "host_required",
            Self::Control(_) => "control_failed",
            Self::Uncertain(_) => "operation_uncertain",
            Self::NotSubmitted(_) => "not_submitted",
            Self::OfflineUnavailable(_) => "offline_unavailable",
            Self::InvalidOperation => "invalid_operation",
        }
    }
}

fn manage_inner(
    request: PluginControlRequest,
    output: &mut CliOutput,
) -> Result<(), PluginCliError> {
    request.validate()?;
    let scope = RegistryScope::for_path(&default_registry_path()?)?;
    let prepared = query(&scope, &ControlRequest::prepare(request.clone()));
    if prepared.status == ControlStatus::NotRunning {
        if request.action == PluginControlAction::Reload {
            return Err(PluginCliError::ReloadOffline);
        }
        return offline_edit(&scope, &request, output);
    }
    if prepared.status != ControlStatus::Prepared {
        let error = report_error(&prepared);
        output.control = Some(prepared);
        return Err(error);
    }
    let ticket = prepared
        .operation_id()
        .expect("transport verified prepared receipt")
        .to_owned();
    output.ticket = Some(ticket.clone());
    // Submission is attempted exactly once. Every subsequent exchange is read-only.
    let mut report = query(&scope, &ControlRequest::submit(&ticket));
    if matches!(
        report.status,
        ControlStatus::Busy
            | ControlStatus::NotReady
            | ControlStatus::Stopping
            | ControlStatus::Expired
            | ControlStatus::StaleHost
            | ControlStatus::InvalidRequest
            | ControlStatus::NotRunning
    ) {
        let error = PluginCliError::NotSubmitted(
            report
                .error
                .clone()
                .unwrap_or_else(|| format!("{:?}", report.status)),
        );
        output.control = Some(report);
        return Err(error);
    }
    let deadline = Instant::now() + OPERATION_WAIT_TIMEOUT;
    while matches!(
        report.status,
        ControlStatus::Queued | ControlStatus::Running
    ) && Instant::now() < deadline
    {
        std::thread::sleep(RESULT_POLL_INTERVAL);
        let sampled = query(&scope, &ControlRequest::result(&ticket));
        if sampled.status == ControlStatus::Busy {
            continue;
        }
        report = sampled;
    }
    let result = if report.status != ControlStatus::Completed {
        Err(PluginCliError::Uncertain(ticket))
    } else if report.is_success() {
        Ok(())
    } else {
        Err(report_error(&report))
    };
    output.control = Some(report);
    result
}

pub fn operation(ticket: &str, json: bool) -> Result<(), PluginCliError> {
    with_output(json, |output| {
        if !valid_operation_id(ticket) {
            return Err(PluginCliError::InvalidOperation);
        }
        output.ticket = Some(ticket.into());
        let scope = RegistryScope::for_path(&default_registry_path()?)?;
        let report = query(&scope, &ControlRequest::result(ticket));
        let result = if matches!(
            report.status,
            ControlStatus::Prepared | ControlStatus::Queued | ControlStatus::Running
        ) || report.is_success()
        {
            Ok(())
        } else {
            Err(report_error(&report))
        };
        output.control = Some(report);
        result
    })
}

fn offline_edit(
    scope: &RegistryScope,
    request: &PluginControlRequest,
    output: &mut CliOutput,
) -> Result<(), PluginCliError> {
    let _lease = offline_lease(scope)?;
    let mut registry = PluginRegistry::load(scope.path())?;
    let plugin_id = &request.plugin_id;
    let enabled = request.action == PluginControlAction::Enable;
    let is_bundled = bundled_plugins()?
        .iter()
        .any(|plugin| plugin.manifest.id == *plugin_id);
    if !is_bundled {
        let registration = registry
            .local_plugins()
            .get(plugin_id)
            .cloned()
            .ok_or_else(|| PluginCliError::UnknownPlugin(plugin_id.clone()))?;
        if enabled {
            load_local_plugin(plugin_id, &registration.path, &registration.grants, 1)?;
            // Keep the authorization that was validated in the optimistic save check.
            registry.register_local(plugin_id, registration)?;
        }
    }
    registry.set_enabled(plugin_id, enabled)?;
    registry.save()?;
    output.offline = Some((plugin_id.clone(), enabled));
    Ok(())
}

struct OfflineLease {
    _launch: LaunchMutexGuard,
    _scope: RegistryScopeGuard,
}

fn offline_lease(scope: &RegistryScope) -> Result<OfflineLease, PluginCliError> {
    let lease = scope.acquire(OFFLINE_LEASE_TIMEOUT).map_err(|error| PluginCliError::OfflineUnavailable(
        format!("registry is owned by a Host or another editor ({error}); retry after checking runtime status")
    ))?;
    // Existing releases coordinate their listener binding with this launch mutex.
    // Hold it through the evidence check and save, in the same scope-then-launch
    // order as the new Host. An older, unidentified running Host is still refused.
    let launch =
        LaunchMutexGuard::acquire_current_user(OFFLINE_LAUNCH_TIMEOUT).map_err(|error| {
            PluginCliError::OfflineUnavailable(format!(
                "Host launch is in progress ({error}); retry after checking runtime status"
            ))
        })?;
    // A missing endpoint before acquiring the lease is not an offline fact: a Host
    // could have been between configuration loading and binding the pipe.
    let current = query(scope, &ControlRequest::identify());
    if current.status != ControlStatus::NotRunning {
        return Err(PluginCliError::OfflineUnavailable(
            "a matching control endpoint appeared; retry the online command".into(),
        ));
    }
    let discovery = discover();
    let legacy_status = if discovery.status == ControlStatus::NotRunning {
        Some(query_current_user().status)
    } else {
        None
    };
    check_offline_evidence(scope.id(), &discovery, legacy_status)
        .map_err(PluginCliError::OfflineUnavailable)?;
    Ok(OfflineLease {
        _launch: launch,
        _scope: lease,
    })
}

fn check_offline_evidence(
    scope: &str,
    discovery: &ControlReport,
    legacy_status: Option<StatusCode>,
) -> Result<(), String> {
    match discovery.status {
        ControlStatus::Identified
            if discovery
                .registry_scope
                .as_deref()
                .is_some_and(|active| active != scope) =>
        {
            Ok(())
        }
        ControlStatus::Identified => {
            Err("a Host identifies this registry but its control endpoint is unavailable".into())
        }
        ControlStatus::NotRunning if legacy_status == Some(StatusCode::NotRunning) => Ok(()),
        ControlStatus::NotRunning => Err(format!(
            "an older or unverified Host may be active ({legacy_status:?}); it does not expose a registry identity, so close that Host or use its matching Codlet build before editing offline"
        )),
        other => Err(format!(
            "control discovery is {other:?}; an absent mutation pipe alone does not prove the registry is offline"
        )),
    }
}

fn report_error(report: &ControlReport) -> PluginCliError {
    if let Some(operation) = &report.operation {
        match &operation.completion {
            Some(ControlCompletion::Error { error }) => {
                return PluginCliError::Request(error.clone());
            }
            Some(ControlCompletion::Report { report }) => {
                return PluginCliError::Control(
                    report
                        .message
                        .clone()
                        .unwrap_or_else(|| format!("lifecycle outcome {:?}", report.outcome)),
                );
            }
            _ => {}
        }
    }
    PluginCliError::Control(
        report
            .error
            .clone()
            .unwrap_or_else(|| format!("Host state {:?}", report.status)),
    )
}

fn print_report(report: &ControlReport, ticket: Option<&str>) {
    let status = serde_json::to_value(report.status).expect("control status is serializable");
    println!("plugin-control: status={}", status.as_str().unwrap());
    if let Some(ticket) = ticket.or_else(|| report.operation_id()) {
        println!("operation-id: {ticket}");
    }
    if let Some(operation) = &report.operation {
        println!(
            "plugin-operation: action={}; id={}",
            operation.request.action.as_str(),
            operation.request.plugin_id
        );
        match &operation.completion {
            Some(ControlCompletion::Report { report }) => {
                let outcome = serde_json::to_value(report.outcome)
                    .expect("lifecycle outcome is serializable");
                println!(
                    "plugin-state: id={}; enabled={}; applies=running-host; outcome={}",
                    report.plugin_id,
                    report.desired_enabled,
                    outcome.as_str().unwrap()
                );
                for generation in &report.generations {
                    println!(
                        "plugin-generation: id={}; generation={}",
                        generation.plugin_id, generation.generation
                    );
                }
                for failure in &report.target_failures {
                    println!(
                        "plugin-target-failure: target={}; id={}; stage={}; error={}",
                        failure.target_id, failure.plugin_id, failure.stage, failure.error
                    );
                }
                if let Some(message) = &report.message {
                    println!("message: {message}");
                }
            }
            Some(ControlCompletion::Error { error }) => println!("error: {error}"),
            None => {}
        }
    }
    if let Some(error) = &report.error {
        println!("error: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offline_requires_positive_evidence_and_allows_a_known_other_registry() {
        let missing = ControlReport::failure(ControlStatus::NotRunning, "fixture");
        assert!(check_offline_evidence("scope-a", &missing, Some(StatusCode::NotRunning)).is_ok());
        for status in [
            StatusCode::Running,
            StatusCode::Busy,
            StatusCode::Timeout,
            StatusCode::UntrustedServer,
            StatusCode::CommunicationError,
        ] {
            assert!(check_offline_evidence("scope-a", &missing, Some(status)).is_err());
        }
        let mut discovered = ControlReport::failure(ControlStatus::Identified, "fixture");
        discovered.registry_scope = Some("scope-b".into());
        assert!(check_offline_evidence("scope-a", &discovered, None).is_ok());
        discovered.registry_scope = Some("scope-a".into());
        assert!(check_offline_evidence("scope-a", &discovered, None).is_err());
        for status in [
            ControlStatus::Busy,
            ControlStatus::Timeout,
            ControlStatus::UntrustedServer,
            ControlStatus::CommunicationError,
        ] {
            discovered.status = status;
            assert!(check_offline_evidence("scope-a", &discovered, None).is_err());
        }
    }
}
