//! Bounded management mailbox. IPC workers reserve/submit/read receipts here;
//! only the foreground runtime takes jobs and supplies their lifecycle results.
use std::collections::{BTreeMap, VecDeque};
use std::io::{self, Write};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::plugin_control::{PluginControlError, PluginControlReport, PluginControlRequest};
use crate::plugin_execution::HostRuntimeSnapshot;
use crate::runtime_inspection::RuntimeInspection;
use crate::runtime_status::StatusPublisher;

pub const CONTROL_SCHEMA_VERSION: u32 = 1;
pub const MAX_CONTROL_REQUEST_BYTES: usize = 4096;
pub const MAX_CONTROL_RESPONSE_BYTES: usize = 256 * 1024;
pub const MAX_CONTROL_PENDING: usize = 8;
pub const MAX_CONTROL_RECORDS: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
pub enum ControlRequest {
    Identify {
        schema_version: u32,
    },
    Inspect {
        schema_version: u32,
    },
    InspectExecution {
        schema_version: u32,
    },
    Prepare {
        schema_version: u32,
        request: PluginControlRequest,
    },
    Submit {
        schema_version: u32,
        operation_id: String,
    },
    Result {
        schema_version: u32,
        operation_id: String,
    },
}

impl ControlRequest {
    pub fn identify() -> Self {
        Self::Identify {
            schema_version: CONTROL_SCHEMA_VERSION,
        }
    }
    pub fn inspect() -> Self {
        Self::Inspect {
            schema_version: CONTROL_SCHEMA_VERSION,
        }
    }
    pub fn inspect_execution() -> Self {
        Self::InspectExecution {
            schema_version: CONTROL_SCHEMA_VERSION,
        }
    }
    pub fn prepare(request: PluginControlRequest) -> Self {
        Self::Prepare {
            schema_version: CONTROL_SCHEMA_VERSION,
            request,
        }
    }
    pub fn submit(operation_id: impl Into<String>) -> Self {
        Self::Submit {
            schema_version: CONTROL_SCHEMA_VERSION,
            operation_id: operation_id.into(),
        }
    }
    pub fn result(operation_id: impl Into<String>) -> Self {
        Self::Result {
            schema_version: CONTROL_SCHEMA_VERSION,
            operation_id: operation_id.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlStatus {
    Identified,
    Inspected,
    InspectionTooLarge,
    Prepared,
    Queued,
    Running,
    Completed,
    NotRunning,
    Busy,
    NotReady,
    Stopping,
    Expired,
    StaleHost,
    InvalidRequest,
    Incompatible,
    UntrustedServer,
    CommunicationError,
    Timeout,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ControlCompletion {
    Report { report: PluginControlReport },
    Error { error: PluginControlError },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControlOperation {
    pub operation_id: String,
    pub request: PluginControlRequest,
    pub completion: Option<ControlCompletion>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControlReport {
    pub schema_version: u32,
    pub host_pid: u32,
    pub registry_scope: Option<String>,
    pub status: ControlStatus,
    pub operation: Option<ControlOperation>,
    pub error: Option<String>,
    /// Only Inspect replies carry this extension. Existing v1 replies retain
    /// their original field set for clients with deny_unknown_fields.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inspection: Option<RuntimeInspection>,
    /// Only the explicit InspectExecution command adds host process facts.
    /// Legacy Inspect and mutation replies keep their original wire fields.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_inspection: Option<HostRuntimeSnapshot>,
}

impl ControlReport {
    pub fn failure(status: ControlStatus, message: impl Into<String>) -> Self {
        Self {
            schema_version: CONTROL_SCHEMA_VERSION,
            host_pid: 0,
            registry_scope: None,
            status,
            operation: None,
            error: Some(message.into()),
            inspection: None,
            host_inspection: None,
        }
    }

    pub fn is_success(&self) -> bool {
        matches!(&self.operation, Some(ControlOperation {
            completion: Some(ControlCompletion::Report { report }), ..
        }) if self.status == ControlStatus::Completed && report.is_success())
    }

    pub fn operation_id(&self) -> Option<&str> {
        self.operation
            .as_ref()
            .map(|operation| operation.operation_id.as_str())
    }
}

pub fn decode_request(bytes: &[u8]) -> Result<ControlRequest, ControlStatus> {
    if bytes.len() > MAX_CONTROL_REQUEST_BYTES {
        return Err(ControlStatus::InvalidRequest);
    }
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| ControlStatus::InvalidRequest)?;
    match value
        .get("schema_version")
        .and_then(serde_json::Value::as_u64)
    {
        Some(version) if version != u64::from(CONTROL_SCHEMA_VERSION) => {
            return Err(ControlStatus::Incompatible);
        }
        Some(_) => {}
        None => return Err(ControlStatus::InvalidRequest),
    }
    let request: ControlRequest =
        serde_json::from_slice(bytes).map_err(|_| ControlStatus::InvalidRequest)?;
    match &request {
        ControlRequest::Prepare { request, .. } => request
            .validate()
            .map_err(|_| ControlStatus::InvalidRequest)?,
        ControlRequest::Submit { operation_id, .. }
        | ControlRequest::Result { operation_id, .. } => {
            parse_ticket(operation_id).ok_or(ControlStatus::InvalidRequest)?;
        }
        _ => {}
    }
    Ok(request)
}

/// No body is accepted with submission: a server-issued receipt already binds
/// the exact action and plugin ID. Evicted receipts can never become new jobs.
#[derive(Clone)]
pub struct ControlBroker(Arc<Mutex<BrokerState>>, Option<StatusPublisher>);

struct BrokerState {
    incarnation: String,
    scope: String,
    last_ticket: u64,
    ready: bool,
    stopped: bool,
    records: BTreeMap<u64, Record>,
    queue: VecDeque<u64>,
}

struct Record {
    request: PluginControlRequest,
    status: ControlStatus,
    completion: Option<ControlCompletion>,
}

#[derive(Debug)]
pub struct ControlJob {
    pub operation_id: String,
    pub request: PluginControlRequest,
}

impl ControlBroker {
    pub fn new(incarnation: [u8; 16], scope: String) -> Self {
        let incarnation = incarnation
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Self(
            Arc::new(Mutex::new(BrokerState {
                incarnation,
                scope,
                last_ticket: 0,
                ready: false,
                stopped: false,
                records: BTreeMap::new(),
                queue: VecDeque::new(),
            })),
            None,
        )
    }

    /// The Host binds the publisher identity before exposing this reader to any
    /// IPC worker. An inspection still verifies that identity on every snapshot.
    pub fn with_inspection(
        incarnation: [u8; 16],
        scope: String,
        publisher: StatusPublisher,
    ) -> Self {
        let mut broker = Self::new(incarnation, scope);
        broker.1 = Some(publisher);
        broker
    }

    pub fn set_ready(&self) {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if !state.stopped {
            state.ready = true;
        }
    }

    pub fn stop(&self) {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        state.stopped = true;
        state.queue.clear();
    }

    pub fn handle(&self, request: ControlRequest) -> ControlReport {
        if serde_json::to_vec(&request)
            .map_or(true, |bytes| bytes.len() > MAX_CONTROL_REQUEST_BYTES)
        {
            return self
                .0
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .failure(
                    ControlStatus::InvalidRequest,
                    "Control request exceeds its bounded wire size",
                );
        }
        if matches!(
            &request,
            ControlRequest::Inspect { .. } | ControlRequest::InspectExecution { .. }
        ) {
            return self.inspect(matches!(&request, ControlRequest::InspectExecution { .. }));
        }
        if matches!(
            &request,
            ControlRequest::Submit { .. } | ControlRequest::Result { .. }
        ) {
            return self.handle_ticket(request);
        }
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if matches!(request, ControlRequest::Identify { .. }) {
            return state.report(ControlStatus::Identified, None, None);
        }
        if state.stopped {
            return state.failure(ControlStatus::Stopping, "Host control is shutting down");
        }
        if !state.ready {
            return state.failure(ControlStatus::NotReady, "Host renderer is still starting");
        }
        match request {
            ControlRequest::Prepare { request, .. } => {
                if let Err(error) = request.validate() {
                    return state.failure(ControlStatus::InvalidRequest, error.to_string());
                }
                if state.records.len() == MAX_CONTROL_RECORDS {
                    let removable = state.records.iter().find_map(|(id, record)| {
                        matches!(
                            record.status,
                            ControlStatus::Prepared | ControlStatus::Completed
                        )
                        .then_some(*id)
                    });
                    match removable {
                        Some(id) => {
                            state.records.remove(&id);
                        }
                        None => {
                            return state.failure(
                                ControlStatus::Busy,
                                "Host control receipt table is full",
                            );
                        }
                    }
                }
                let Some(id) = state.last_ticket.checked_add(1) else {
                    return state.failure(
                        ControlStatus::Busy,
                        "Host control receipt sequence is exhausted",
                    );
                };
                state.last_ticket = id;
                state.records.insert(
                    id,
                    Record {
                        request,
                        status: ControlStatus::Prepared,
                        completion: None,
                    },
                );
                state.record_report(id)
            }
            _ => unreachable!("identify and receipt commands were dispatched above"),
        }
    }

    fn inspect(&self, include_hosts: bool) -> ControlReport {
        // Clone identity under the mailbox lock, then release it before touching
        // the publisher or serializing. Inspection cannot alter receipt state.
        let (incarnation, mut report) = {
            let state = self.0.lock().unwrap_or_else(|p| p.into_inner());
            (
                state.incarnation.clone(),
                state.report(ControlStatus::Inspected, None, None),
            )
        };
        let Some((inspection, hosts)) = self
            .1
            .as_ref()
            .and_then(|publisher| publisher.inspection_components(include_hosts))
        else {
            report.status = ControlStatus::NotReady;
            report.error = Some("The Host inspection publisher has not been bound".into());
            return report;
        };
        if inspection.host_pid != report.host_pid
            || inspection.host_incarnation != incarnation
            || report.registry_scope.as_deref() != Some(inspection.registry_scope.as_str())
        {
            report.status = ControlStatus::StaleHost;
            report.error = Some(
                "Inspection snapshot identity does not match this Host incarnation and registry"
                    .into(),
            );
            return report;
        }
        report.inspection = Some(inspection);
        report.host_inspection = hosts;
        if encode_response(&report).is_err() {
            report.status = ControlStatus::InspectionTooLarge;
            report.inspection = None;
            report.host_inspection = None;
            report.error = Some(format!(
                "Host inspection exceeds the {MAX_CONTROL_RESPONSE_BYTES}-byte response limit"
            ));
        }
        report
    }

    fn handle_ticket(&self, request: ControlRequest) -> ControlReport {
        let (operation_id, submit) = match &request {
            ControlRequest::Submit { operation_id, .. } => (operation_id, true),
            ControlRequest::Result { operation_id, .. } => (operation_id, false),
            _ => unreachable!("only receipt commands reach this handler"),
        };
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if state.stopped {
            return state.failure(ControlStatus::Stopping, "Host control is shutting down");
        }
        let id = match state.resolve(operation_id) {
            Ok(id) => id,
            Err((status, message)) => return state.failure(status, message),
        };
        if submit && state.records[&id].status == ControlStatus::Prepared {
            let pending = state
                .records
                .values()
                .filter(|record| {
                    matches!(
                        record.status,
                        ControlStatus::Queued | ControlStatus::Running
                    )
                })
                .count();
            if pending >= MAX_CONTROL_PENDING {
                return state.failure(
                    ControlStatus::Busy,
                    "Host control queue is full; this receipt was not submitted",
                );
            }
            state.records.get_mut(&id).expect("receipt resolved").status = ControlStatus::Queued;
            state.queue.push_back(id);
        }
        state.record_report(id)
    }

    /// Called by the foreground renderer owner only. No renderer reference is shared.
    pub fn take_next(&self) -> Option<ControlJob> {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if state.stopped {
            return None;
        }
        let id = state.queue.pop_front()?;
        let operation_id = state.ticket(id);
        let record = state
            .records
            .get_mut(&id)
            .expect("queued receipt is retained");
        record.status = ControlStatus::Running;
        Some(ControlJob {
            operation_id,
            request: record.request.clone(),
        })
    }

    pub fn complete(
        &self,
        operation_id: &str,
        result: Result<PluginControlReport, PluginControlError>,
    ) {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let Ok(id) = state.resolve(operation_id) else {
            return;
        };
        let record = state.records.get_mut(&id).expect("receipt resolved");
        if record.status != ControlStatus::Running {
            return;
        }
        let result = match result {
            Ok(report)
                if report.action != record.request.action
                    || report.plugin_id != record.request.plugin_id =>
            {
                Err(PluginControlError::new(
                    "invalid_result",
                    "Lifecycle result does not match the submitted operation",
                ))
            }
            other => other,
        };
        record.status = ControlStatus::Completed;
        record.completion = Some(match result {
            Ok(report) => ControlCompletion::Report { report },
            Err(error) => ControlCompletion::Error { error },
        });
        if encode_response(&state.record_report(id)).is_err() {
            state
                .records
                .get_mut(&id)
                .expect("receipt retained")
                .completion = Some(ControlCompletion::Error {
                error: PluginControlError::new(
                    "result_too_large",
                    "Operation completed, but its detailed report exceeded the IPC limit; inspect runtime status before another operation",
                ),
            });
        }
    }
}

impl BrokerState {
    fn ticket(&self, id: u64) -> String {
        format!("{}-{id:016x}", self.incarnation)
    }
    fn report(
        &self,
        status: ControlStatus,
        operation: Option<ControlOperation>,
        error: Option<String>,
    ) -> ControlReport {
        ControlReport {
            schema_version: CONTROL_SCHEMA_VERSION,
            host_pid: std::process::id(),
            registry_scope: Some(self.scope.clone()),
            status,
            operation,
            error,
            inspection: None,
            host_inspection: None,
        }
    }
    fn failure(&self, status: ControlStatus, error: impl Into<String>) -> ControlReport {
        self.report(status, None, Some(error.into()))
    }
    fn record_report(&self, id: u64) -> ControlReport {
        let record = &self.records[&id];
        self.report(
            record.status,
            Some(ControlOperation {
                operation_id: self.ticket(id),
                request: record.request.clone(),
                completion: record.completion.clone(),
            }),
            None,
        )
    }
    fn resolve(&self, ticket: &str) -> Result<u64, (ControlStatus, &'static str)> {
        let Some((incarnation, id)) = parse_ticket(ticket) else {
            return Err((ControlStatus::InvalidRequest, "Invalid operation receipt"));
        };
        if incarnation != self.incarnation {
            return Err((
                ControlStatus::StaleHost,
                "Receipt belongs to an earlier Host; it will not be executed",
            ));
        }
        if id > self.last_ticket {
            return Err((
                ControlStatus::InvalidRequest,
                "Receipt was never issued by this Host",
            ));
        }
        if !self.records.contains_key(&id) {
            return Err((
                ControlStatus::Expired,
                "Receipt has expired; it will not be executed again",
            ));
        }
        Ok(id)
    }
}

pub fn valid_operation_id(value: &str) -> bool {
    parse_ticket(value).is_some()
}
fn parse_ticket(value: &str) -> Option<(&str, u64)> {
    if value.len() != 49 || !value.is_ascii() || value.as_bytes()[32] != b'-' {
        return None;
    }
    let (incarnation, suffix) = value.split_at(32);
    if !incarnation
        .bytes()
        .chain(suffix.bytes().skip(1))
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    let id = u64::from_str_radix(&suffix[1..], 16).ok()?;
    (id > 0).then_some((incarnation, id))
}

pub(crate) fn encode_response(report: &ControlReport) -> io::Result<Vec<u8>> {
    struct Bounded(Vec<u8>);
    impl Write for Bounded {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.0.len().saturating_add(bytes.len()) > MAX_CONTROL_RESPONSE_BYTES {
                return Err(io::Error::other("control response exceeds frame limit"));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut output = Bounded(Vec::new());
    serde_json::to_writer(&mut output, report).map_err(io::Error::other)?;
    Ok(output.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_control::{PluginControlAction, PluginControlOutcome};

    fn request() -> PluginControlRequest {
        PluginControlRequest {
            action: PluginControlAction::Reload,
            plugin_id: "dev.fixture".into(),
            permission: None,
            cascade: false,
            local_import: None,
        }
    }
    fn broker() -> ControlBroker {
        let broker = ControlBroker::new([3; 16], "a".repeat(64));
        broker.set_ready();
        broker
    }
    fn reserve(broker: &ControlBroker) -> String {
        broker
            .handle(ControlRequest::prepare(request()))
            .operation_id()
            .unwrap()
            .to_owned()
    }
    fn result() -> PluginControlReport {
        PluginControlReport {
            action: PluginControlAction::Reload,
            plugin_id: "dev.fixture".into(),
            outcome: PluginControlOutcome::Applied,
            desired_enabled: true,
            affected_plugin_ids: vec!["dev.fixture".into()],
            generations: Vec::new(),
            target_failures: Vec::new(),
            message: None,
        }
    }

    #[test]
    fn control_contract_is_strict_and_cannot_carry_code_paths_or_unknown_actions() {
        let valid = serde_json::to_vec(&ControlRequest::prepare(request())).unwrap();
        assert!(decode_request(&valid).is_ok());
        assert!(decode_request(&serde_json::to_vec(&ControlRequest::inspect()).unwrap()).is_ok());
        assert!(
            decode_request(&serde_json::to_vec(&ControlRequest::inspect_execution()).unwrap())
                .is_ok()
        );
        for invalid in [
            br#"{"schema_version":1,"command":"eval","js":"process.exit()"}"#.as_slice(),
            br#"{"schema_version":1,"command":"prepare","request":{"action":"reload","plugin_id":"dev.fixture","path":"C:/other"}}"#,
            br#"{"schema_version":1,"command":"prepare","request":{"action":"load","plugin_id":"dev.fixture"}}"#,
            br#"{"schema_version":1,"command":"prepare","request":{"action":"reload","plugin_id":"../plugin"}}"#,
            br#"{"schema_version":1,"command":"identify","extra":true}"#,
            br#"{"schema_version":1,"command":"inspect","js":"1+1"}"#,
            br#"{"schema_version":1,"command":"inspect","path":"C:/another-registry"}"#,
            br#"{"schema_version":1,"command":"inspect_execution","path":"C:/another-registry"}"#,
            br#"{"schema_version":1,"command":"identify","command":"identify"}"#,
            br#"{"schema_version":1,"command":"submit","operation_id":"anything"}"#,
            b"null", b"[]", b"\xff",
        ] { assert_eq!(decode_request(invalid), Err(ControlStatus::InvalidRequest)); }
        assert_eq!(
            decode_request(br#"{"schema_version":99,"command":"future"}"#),
            Err(ControlStatus::Incompatible)
        );
        assert_eq!(
            decode_request(&vec![b' '; MAX_CONTROL_REQUEST_BYTES + 1]),
            Err(ControlStatus::InvalidRequest)
        );
    }

    #[test]
    fn inspections_preserve_receipts_and_legacy_v1_reply_fields_through_shutdown() {
        use crate::runtime_inspection::RendererInspection;
        use crate::runtime_status::{HostState, RendererStatus};
        use std::collections::BTreeSet;

        let publisher = StatusPublisher::new();
        publisher
            .bind_runtime_identity([3; 16], &"a".repeat(64))
            .unwrap();
        let broker = ControlBroker::with_inspection([3; 16], "a".repeat(64), publisher.clone());
        let starting = broker.handle(ControlRequest::inspect());
        assert_eq!(starting.status, ControlStatus::Inspected);
        assert_eq!(starting.inspection.unwrap().state, HostState::Starting);
        assert_eq!(
            broker.handle(ControlRequest::prepare(request())).status,
            ControlStatus::NotReady
        );
        broker.set_ready();
        publisher.set_ready();
        publisher
            .publish_renderer_observation(RendererStatus::default(), RendererInspection::default());
        let ticket = reserve(&broker);
        let queued = broker.handle(ControlRequest::submit(&ticket));
        let sequence = publisher.snapshot().sequence;
        for _ in 0..MAX_CONTROL_RECORDS + 1 {
            let inspected = broker.handle(ControlRequest::inspect());
            assert_eq!(inspected.status, ControlStatus::Inspected);
            assert_eq!(inspected.inspection.unwrap().sequence, sequence);
        }
        assert_eq!(broker.handle(ControlRequest::result(&ticket)), queued);
        let state = broker.0.lock().unwrap();
        assert_eq!(state.last_ticket, 1);
        assert_eq!(state.records.len(), 1);
        assert_eq!(state.queue.len(), 1);
        drop(state);
        let expected_keys: BTreeSet<_> = [
            "schema_version",
            "host_pid",
            "registry_scope",
            "status",
            "operation",
            "error",
        ]
        .into_iter()
        .collect();
        for request in [
            ControlRequest::identify(),
            ControlRequest::prepare(request()),
            ControlRequest::submit(&ticket),
            ControlRequest::result(&ticket),
        ] {
            let reply = broker.handle(request);
            let value = serde_json::to_value(&reply).unwrap();
            assert_eq!(
                value
                    .as_object()
                    .unwrap()
                    .keys()
                    .map(String::as_str)
                    .collect::<BTreeSet<_>>(),
                expected_keys
            );
            assert!(reply.inspection.is_none());
        }
        publisher.terminate("fixture stopped");
        broker.stop();
        let terminated = broker.handle(ControlRequest::inspect());
        assert_eq!(terminated.status, ControlStatus::Inspected);
        assert_eq!(terminated.inspection.unwrap().state, HostState::Terminated);
        assert!(broker.take_next().is_none());
    }

    #[test]
    fn inspection_rejects_missing_or_foreign_publication_identity_and_bounds_large_snapshots() {
        use crate::runtime_status::CodexStatus;

        let publisher = StatusPublisher::new();
        let broker = ControlBroker::with_inspection([3; 16], "a".repeat(64), publisher.clone());
        assert_eq!(
            broker.handle(ControlRequest::inspect()).status,
            ControlStatus::NotReady
        );
        publisher
            .bind_runtime_identity([4; 16], &"a".repeat(64))
            .unwrap();
        assert_eq!(
            broker.handle(ControlRequest::inspect()).status,
            ControlStatus::StaleHost
        );
        let wrong_scope =
            ControlBroker::with_inspection([4; 16], "b".repeat(64), publisher.clone());
        assert_eq!(
            wrong_scope.handle(ControlRequest::inspect()).status,
            ControlStatus::StaleHost
        );
        let matching = ControlBroker::with_inspection([4; 16], "a".repeat(64), publisher.clone());
        publisher.set_codex(CodexStatus {
            pid: 7,
            package_full_name: "fixture".into(),
            package_version: "1.0".into(),
            executable: "x".repeat(MAX_CONTROL_RESPONSE_BYTES),
        });
        let report = matching.handle(ControlRequest::inspect());
        assert_eq!(report.status, ControlStatus::InspectionTooLarge);
        assert!(report.inspection.is_none() && report.operation.is_none());
        assert!(encode_response(&report).unwrap().len() < 4096);
        assert_eq!(matching.0.lock().unwrap().last_ticket, 0);
    }

    #[test]
    fn reservations_are_inert_and_one_receipt_executes_at_most_once() {
        let broker = broker();
        let ticket = reserve(&broker);
        assert!(broker.take_next().is_none());
        assert_eq!(
            broker.handle(ControlRequest::result(&ticket)).status,
            ControlStatus::Prepared
        );
        for _ in 0..20 {
            assert_eq!(
                broker.handle(ControlRequest::submit(&ticket)).status,
                ControlStatus::Queued
            );
        }
        let job = broker.take_next().unwrap();
        assert_eq!(job.operation_id, ticket);
        assert_eq!(job.request, request());
        assert!(broker.take_next().is_none());
        assert_eq!(
            broker.handle(ControlRequest::submit(&ticket)).status,
            ControlStatus::Running
        );
        broker.complete(&ticket, Ok(result()));
        let completed = broker.handle(ControlRequest::result(&ticket));
        assert!(completed.is_success());
        assert_eq!(completed, broker.handle(ControlRequest::submit(&ticket)));
        broker.complete(
            &ticket,
            Err(PluginControlError::new(
                "late",
                "must not replace a terminal result",
            )),
        );
        assert_eq!(completed, broker.handle(ControlRequest::result(&ticket)));
        assert!(broker.take_next().is_none());
    }

    #[test]
    fn admission_and_receipt_retention_are_bounded_without_replaying_evicted_work() {
        let broker = broker();
        let completed = reserve(&broker);
        broker.handle(ControlRequest::submit(&completed));
        broker.take_next().unwrap();
        broker.complete(&completed, Ok(result()));
        let queued: Vec<_> = (0..MAX_CONTROL_PENDING)
            .map(|_| {
                let ticket = reserve(&broker);
                assert_eq!(
                    broker.handle(ControlRequest::submit(&ticket)).status,
                    ControlStatus::Queued
                );
                ticket
            })
            .collect();
        let unsubmitted = reserve(&broker);
        assert_eq!(
            broker.handle(ControlRequest::submit(&unsubmitted)).status,
            ControlStatus::Busy
        );
        assert_eq!(
            broker.handle(ControlRequest::result(&unsubmitted)).status,
            ControlStatus::Prepared
        );
        for _ in 0..MAX_CONTROL_RECORDS * 3 {
            reserve(&broker);
        }
        assert_eq!(broker.0.lock().unwrap().records.len(), MAX_CONTROL_RECORDS);
        for ticket in [&completed, &unsubmitted] {
            assert_eq!(
                broker.handle(ControlRequest::submit(ticket)).status,
                ControlStatus::Expired
            );
        }
        for ticket in queued {
            assert_eq!(
                broker.handle(ControlRequest::result(&ticket)).status,
                ControlStatus::Queued
            );
            assert_eq!(broker.take_next().unwrap().operation_id, ticket);
            broker.complete(&ticket, Ok(result()));
        }
        assert!(broker.take_next().is_none());
        let new_host = ControlBroker::new([4; 16], "a".repeat(64));
        new_host.set_ready();
        assert_eq!(
            new_host.handle(ControlRequest::submit(&completed)).status,
            ControlStatus::StaleHost
        );
        assert!(new_host.take_next().is_none());
    }

    #[test]
    fn stop_and_late_completion_cannot_reopen_admission_or_execute_queued_jobs() {
        let broker = broker();
        let first = reserve(&broker);
        let second = reserve(&broker);
        broker.handle(ControlRequest::submit(&first));
        broker.handle(ControlRequest::submit(&second));
        broker.take_next().unwrap();
        std::thread::scope(|scope| {
            scope.spawn(|| broker.stop());
            scope.spawn(|| broker.complete(&first, Ok(result())));
        });
        broker.set_ready();
        assert!(broker.take_next().is_none());
        for request in [
            ControlRequest::submit(&first),
            ControlRequest::submit(&second),
            ControlRequest::prepare(request()),
        ] {
            assert_eq!(broker.handle(request).status, ControlStatus::Stopping);
        }
    }

    #[test]
    fn oversized_results_remain_terminal_and_keep_their_receipt() {
        let broker = broker();
        let ticket = reserve(&broker);
        broker.handle(ControlRequest::submit(&ticket));
        broker.take_next().unwrap();
        let mut result = result();
        result.message = Some("x".repeat(MAX_CONTROL_RESPONSE_BYTES));
        broker.complete(&ticket, Ok(result));
        let report = broker.handle(ControlRequest::result(&ticket));
        assert_eq!(report.status, ControlStatus::Completed);
        assert_eq!(report.operation_id(), Some(ticket.as_str()));
        assert!(encode_response(&report).unwrap().len() < 4096);
        assert!(matches!(report.operation.unwrap().completion,
            Some(ControlCompletion::Error { error }) if error.code == "result_too_large"));
        assert_eq!(
            broker.handle(ControlRequest::submit(ticket)).status,
            ControlStatus::Completed
        );
        assert!(broker.take_next().is_none());
    }

    #[test]
    fn execution_inspection_is_read_only_and_preserves_legacy_shapes_and_response_bounds() {
        use crate::plugin_execution::{ExecutionState, HostCleanupSnapshot, HostPluginSnapshot};
        let publisher = StatusPublisher::new();
        publisher
            .bind_runtime_identity([3; 16], &"a".repeat(64))
            .unwrap();
        let broker = ControlBroker::with_inspection([3; 16], "a".repeat(64), publisher.clone());
        publisher.set_ready();
        broker.set_ready();
        let mut sample = HostRuntimeSnapshot {
            sequence: 7,
            sampled_at_unix_ms: 10_000,
            owner_alive: true,
            runtime_stopping: false,
            retained_limit: 80,
            history_truncated: false,
            plugins: vec![HostPluginSnapshot {
                id: "dev.raw".into(),
                version: "1".into(),
                generation: 2,
                state: ExecutionState::Active,
                process_id: Some(1234),
                error: None,
                pending_core_requests: 1,
                subscriptions: 1,
                outbox: 0,
                launching: false,
                cleanup: HostCleanupSnapshot::default(),
                exit: None,
            }],
        };
        publisher.publish_host_observation(sample.clone());
        let sequence = publisher.snapshot().sequence;
        let inspected = broker.handle(ControlRequest::inspect_execution());
        assert_eq!(inspected.status, ControlStatus::Inspected);
        assert_eq!(inspected.host_inspection.as_ref(), Some(&sample));
        assert_eq!(inspected.inspection.as_ref().unwrap().sequence, sequence);
        for _ in 0..3 {
            assert_eq!(
                broker.handle(ControlRequest::inspect_execution()),
                inspected
            );
        }
        assert_eq!(publisher.snapshot().sequence, sequence);
        assert!(broker.take_next().is_none());
        let ticket = reserve(&broker);
        assert!(ticket.ends_with("-0000000000000001"));
        for request in [
            ControlRequest::inspect(),
            ControlRequest::identify(),
            ControlRequest::result(&ticket),
        ] {
            let wire = serde_json::to_value(broker.handle(request)).unwrap();
            assert!(wire.get("host_inspection").is_none());
        }
        sample.plugins[0].error = Some("x".repeat(MAX_CONTROL_RESPONSE_BYTES));
        publisher.publish_host_observation(sample);
        let oversized = broker.handle(ControlRequest::inspect_execution());
        assert_eq!(oversized.status, ControlStatus::InspectionTooLarge);
        assert!(oversized.inspection.is_none() && oversized.host_inspection.is_none());
        assert!(encode_response(&oversized).unwrap().len() < 4096);
        assert_eq!(
            broker.handle(ControlRequest::inspect()).status,
            ControlStatus::Inspected
        );
        publisher.terminate("fixture stopped");
        let terminal = broker.handle(ControlRequest::inspect_execution());
        publisher.publish_host_observation(HostRuntimeSnapshot::default());
        assert_eq!(broker.handle(ControlRequest::inspect_execution()), terminal);
        assert!(broker.take_next().is_none());
    }
}
