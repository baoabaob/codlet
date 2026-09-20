//! Response validation shared by authenticated OS transports.
use crate::runtime_control::{
    CONTROL_SCHEMA_VERSION, ControlCompletion, ControlReport, ControlRequest, ControlStatus,
};

pub(crate) fn decode_response(
    bytes: &[u8],
    pid: u32,
    scope: Option<&str>,
    request: &ControlRequest,
) -> ControlReport {
    let value: serde_json::Value = match serde_json::from_slice(bytes) {
        Ok(value) => value,
        Err(error) => return failure(ControlStatus::CommunicationError, error),
    };
    match value
        .get("schema_version")
        .and_then(serde_json::Value::as_u64)
    {
        Some(version) if version != u64::from(CONTROL_SCHEMA_VERSION) => {
            return failure(
                ControlStatus::Incompatible,
                format!("Host control schema {version}; client supports {CONTROL_SCHEMA_VERSION}"),
            );
        }
        Some(_) => {}
        None => {
            return failure(
                ControlStatus::CommunicationError,
                "Host response has no control schema version",
            );
        }
    }
    let inspecting = matches!(
        request,
        ControlRequest::Inspect { .. } | ControlRequest::InspectExecution { .. }
    );
    let inspecting_hosts = matches!(request, ControlRequest::InspectExecution { .. });
    if !inspecting && value.get("inspection").is_some() {
        return failure(
            ControlStatus::CommunicationError,
            "The legacy control reply must not contain an inspection field",
        );
    }
    if !inspecting_hosts && value.get("host_inspection").is_some() {
        return failure(
            ControlStatus::CommunicationError,
            "Host process facts are only allowed on inspect_execution replies",
        );
    }
    let report: ControlReport = match serde_json::from_slice(bytes) {
        Ok(report) => report,
        Err(error) => return failure(ControlStatus::CommunicationError, error),
    };
    if report.host_pid != pid {
        return failure(
            ControlStatus::UntrustedServer,
            "Control response PID differs from its live pipe server",
        );
    }
    let valid_scope = report.registry_scope.as_deref().is_some_and(|actual| {
        actual.len() == 64
            && actual
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            && scope.is_none_or(|expected| actual == expected)
    });
    if !valid_scope {
        return failure(
            ControlStatus::UntrustedServer,
            "Control response registry scope differs from this endpoint",
        );
    }
    if let Some(inspection) = &report.inspection {
        if !inspecting {
            return failure(
                ControlStatus::CommunicationError,
                "Inspection data is not allowed on this control command",
            );
        }
        if inspection.host_pid != pid
            || report.registry_scope.as_deref() != Some(inspection.registry_scope.as_str())
            || !valid_incarnation(&inspection.host_incarnation)
        {
            return failure(
                ControlStatus::UntrustedServer,
                "Inspection identity does not match its authenticated Host and registry",
            );
        }
    }
    let valid_shape = match report.status {
        ControlStatus::Inspected => {
            inspecting
                && report.inspection.is_some()
                && report.operation.is_none()
                && report.error.is_none()
        }
        ControlStatus::InspectionTooLarge => {
            inspecting
                && report.inspection.is_none()
                && report.operation.is_none()
                && report.error.is_some()
        }
        ControlStatus::Identified => {
            matches!(request, ControlRequest::Identify { .. })
                && report.operation.is_none()
                && report.error.is_none()
        }
        ControlStatus::Prepared
        | ControlStatus::Queued
        | ControlStatus::Running
        | ControlStatus::Completed => {
            report.error.is_none()
                && report.operation.as_ref().is_some_and(|operation| {
                    let matches_request = match request {
                        ControlRequest::Prepare { request, .. } => operation.request == *request,
                        ControlRequest::Submit { operation_id, .. }
                        | ControlRequest::Result { operation_id, .. } => {
                            operation.operation_id == *operation_id
                        }
                        _ => false,
                    };
                    let valid_completion = match &operation.completion {
                        Some(ControlCompletion::Report { report: result }) => {
                            result.plugin_id == operation.request.plugin_id
                                && result.action == operation.request.action
                        }
                        _ => true,
                    };
                    matches_request
                        && operation.request.validate().is_ok()
                        && crate::runtime_control::valid_operation_id(&operation.operation_id)
                        && (operation.completion.is_some()
                            == (report.status == ControlStatus::Completed))
                        && valid_completion
                })
        }
        ControlStatus::NotRunning
        | ControlStatus::UntrustedServer
        | ControlStatus::CommunicationError
        | ControlStatus::Timeout => false,
        _ => report.operation.is_none() && report.error.is_some(),
    } && (report.status == ControlStatus::Inspected
        || (report.inspection.is_none() && report.host_inspection.is_none()));
    if !valid_shape {
        return failure(
            ControlStatus::CommunicationError,
            "Unexpected control response state or shape",
        );
    }
    report
}

pub(crate) fn valid_incarnation(incarnation: &str) -> bool {
    incarnation.len() == 32
        && incarnation
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn failure(status: ControlStatus, message: impl std::fmt::Display) -> ControlReport {
    ControlReport::failure(status, message.to_string())
}
