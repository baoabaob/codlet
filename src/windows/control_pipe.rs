//! Authenticated local management transport. Both listeners perform bounded IO
//! and mailbox operations only; renderer execution stays on its foreground owner.
use std::ffi::OsStr;
use std::os::windows::io::OwnedHandle;
use std::path::Path;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    ERROR_FILE_NOT_FOUND, ERROR_NO_DATA, ERROR_PIPE_BUSY, ERROR_PIPE_NOT_CONNECTED,
};
use windows_sys::Win32::System::Pipes::DisconnectNamedPipe;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, SetEvent};

pub use super::control_scope::{RegistryScope, RegistryScopeGuard};
use super::control_scope::{discovery_pipe_name, random_incarnation};
pub use super::local_ipc::LocalIpcError as ControlPipeError;
use super::local_ipc::{
    Channel, ServerIdentity, create_event, create_server_pipe, open_client, process_image_path, raw,
};
use crate::runtime_control::{
    CONTROL_SCHEMA_VERSION, ControlBroker, ControlCompletion, ControlReport, ControlRequest,
    ControlStatus, MAX_CONTROL_REQUEST_BYTES, MAX_CONTROL_RESPONSE_BYTES, decode_request,
    encode_response,
};

pub const CONTROL_QUERY_TIMEOUT: Duration = Duration::from_millis(1500);
const SERVER_TRANSACTION_TIMEOUT: Duration = Duration::from_millis(750);
const RESPONSE_ACK: u8 = 6;

pub struct ControlServer {
    // Listeners are stopped before releasing the lease, so an offline writer
    // cannot enter while this Host still accepts work for its registry.
    workers: Vec<PipeWorker>,
    broker: ControlBroker,
    lease: RegistryScopeGuard,
}

impl ControlServer {
    /// Bind only after launch-conflict checks. Acquire the lease before loading
    /// runtime configuration and keep it through the complete Host lifetime.
    pub fn bind_current_user(lease: RegistryScopeGuard) -> Result<Self, ControlPipeError> {
        let discovery = discovery_pipe_name()?;
        Self::bind(lease, Some(&discovery))
    }

    fn bind(
        lease: RegistryScopeGuard,
        discovery: Option<&OsStr>,
    ) -> Result<Self, ControlPipeError> {
        let broker = ControlBroker::new(random_incarnation()?, lease.scope().id().to_owned());
        let mut workers = vec![PipeWorker::bind(
            lease.scope().pipe_name(),
            broker.clone(),
            false,
        )?];
        if let Some(name) = discovery {
            workers.push(PipeWorker::bind(name, broker.clone(), true)?);
        }
        Ok(Self {
            workers,
            broker,
            lease,
        })
    }

    pub fn broker(&self) -> ControlBroker {
        self.broker.clone()
    }
    pub fn scope(&self) -> &RegistryScope {
        self.lease.scope()
    }
}

impl Drop for ControlServer {
    fn drop(&mut self) {
        self.broker.stop();
        // Explicit clearing also documents drop ordering if fields are rearranged.
        self.workers.clear();
    }
}

struct PipeWorker {
    stop: Arc<OwnedHandle>,
    worker: Option<JoinHandle<()>>,
}

impl PipeWorker {
    fn bind(
        name: &OsStr,
        broker: ControlBroker,
        discovery_only: bool,
    ) -> Result<Self, ControlPipeError> {
        let pipe = create_server_pipe(name)?;
        let stop = Arc::new(create_event()?);
        let channel = Channel {
            pipe,
            event: create_event()?,
            stop: Arc::clone(&stop),
        };
        let executable = process_image_path(unsafe { GetCurrentProcess() })?;
        let worker = thread::Builder::new()
            .name(
                if discovery_only {
                    "codlet-control-discovery"
                } else {
                    "codlet-control"
                }
                .into(),
            )
            .spawn(move || {
                while !channel.is_stopping() {
                    match channel.connect() {
                        Ok(()) => {}
                        Err(ControlPipeError::Stopping) => break,
                        Err(ControlPipeError::Win32 {
                            code: ERROR_NO_DATA | ERROR_PIPE_NOT_CONNECTED,
                            ..
                        }) => {
                            unsafe {
                                DisconnectNamedPipe(raw(&channel.pipe));
                            }
                            continue;
                        }
                        Err(error) => {
                            eprintln!("codlet: control IPC listener stopped: {error}");
                            break;
                        }
                    }
                    let deadline = Instant::now() + SERVER_TRANSACTION_TIMEOUT;
                    let _ =
                        serve_transaction(&channel, &broker, &executable, discovery_only, deadline);
                    // ACK replaces FlushFileBuffers; a client cannot stall shutdown.
                    unsafe {
                        DisconnectNamedPipe(raw(&channel.pipe));
                    }
                }
            })?;
        Ok(Self {
            stop,
            worker: Some(worker),
        })
    }
}

impl Drop for PipeWorker {
    fn drop(&mut self) {
        unsafe {
            SetEvent(raw(&self.stop));
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn serve_transaction(
    channel: &Channel,
    broker: &ControlBroker,
    executable: &Path,
    discovery_only: bool,
    deadline: Instant,
) -> Result<(), ControlPipeError> {
    // Unlike read-only status, management authenticates the connecting process too.
    let identity = ServerIdentity::verify_client(&channel.pipe, executable)?;
    let bytes = channel.read_frame(MAX_CONTROL_REQUEST_BYTES, deadline)?;
    let request = decode_request(&bytes);
    identity.check_live(&channel.pipe)?;
    let report = match request {
        Ok(request) if !discovery_only || matches!(request, ControlRequest::Identify { .. }) => {
            broker.handle(request)
        }
        Ok(_) => server_failure(
            broker,
            ControlStatus::InvalidRequest,
            "Discovery accepts identify only",
        ),
        Err(status) => server_failure(
            broker,
            status,
            "Expected a bounded versioned control command and no extra fields",
        ),
    };
    channel.write_frame(&encode_response(&report)?, deadline)?;
    let mut ack = [0];
    channel.read_exact(&mut ack, deadline)?;
    if ack != [RESPONSE_ACK] {
        return Err(ControlPipeError::Invalid(
            "invalid control response ACK".into(),
        ));
    }
    Ok(())
}

fn server_failure(broker: &ControlBroker, status: ControlStatus, message: &str) -> ControlReport {
    let mut report = broker.handle(ControlRequest::identify());
    report.status = status;
    report.error = Some(message.into());
    report
}

pub fn query(scope: &RegistryScope, request: &ControlRequest) -> ControlReport {
    exchange(
        scope.pipe_name(),
        Some(scope.id()),
        request,
        CONTROL_QUERY_TIMEOUT,
    )
}

pub fn discover() -> ControlReport {
    let name = match discovery_pipe_name() {
        Ok(name) => name,
        Err(error) => return failure(ControlStatus::CommunicationError, error),
    };
    exchange(
        &name,
        None,
        &ControlRequest::identify(),
        CONTROL_QUERY_TIMEOUT,
    )
}

fn exchange(
    name: &OsStr,
    scope: Option<&str>,
    request: &ControlRequest,
    timeout: Duration,
) -> ControlReport {
    let executable = match process_image_path(unsafe { GetCurrentProcess() }) {
        Ok(path) => path,
        Err(error) => return failure(ControlStatus::UntrustedServer, error),
    };
    exchange_expected(name, scope, request, timeout, &executable)
}

fn exchange_expected(
    name: &OsStr,
    scope: Option<&str>,
    request: &ControlRequest,
    timeout: Duration,
    executable: &Path,
) -> ControlReport {
    let deadline = Instant::now() + timeout;
    let bytes = match serde_json::to_vec(request) {
        Ok(bytes) if bytes.len() <= MAX_CONTROL_REQUEST_BYTES => bytes,
        _ => {
            return failure(
                ControlStatus::InvalidRequest,
                "control request exceeds its frame limit",
            );
        }
    };
    let pipe = match open_client(name) {
        Ok(pipe) => pipe,
        Err(ControlPipeError::Win32 {
            code: ERROR_FILE_NOT_FOUND,
            ..
        }) => {
            return failure(
                ControlStatus::NotRunning,
                "No control endpoint for this registry",
            );
        }
        Err(ControlPipeError::Win32 {
            code: ERROR_PIPE_BUSY,
            ..
        }) => {
            return failure(
                ControlStatus::Busy,
                "Host control endpoint is serving another client",
            );
        }
        Err(error) => return failure(ControlStatus::CommunicationError, error),
    };
    // Never send a management body before verifying the live Host executable/SID.
    let identity = match ServerIdentity::verify(&pipe, executable) {
        Ok(identity) => identity,
        Err(error) => return failure(ControlStatus::UntrustedServer, error),
    };
    let event = match create_event() {
        Ok(event) => event,
        Err(error) => return failure(ControlStatus::CommunicationError, error),
    };
    let stop = match create_event() {
        Ok(event) => Arc::new(event),
        Err(error) => return failure(ControlStatus::CommunicationError, error),
    };
    let channel = Channel { pipe, event, stop };
    let exchange = (|| {
        channel.write_frame(&bytes, deadline)?;
        channel.read_frame(MAX_CONTROL_RESPONSE_BYTES, deadline)
    })();
    let response = match exchange {
        Ok(response) => response,
        Err(ControlPipeError::Timeout) => {
            return failure(ControlStatus::Timeout, "Host control transaction timed out");
        }
        Err(error) => return failure(ControlStatus::CommunicationError, error),
    };
    if let Err(error) = identity.check_live(&channel.pipe) {
        return failure(ControlStatus::UntrustedServer, error);
    }
    let report = decode_response(&response, identity.pid, scope, request);
    if let Err(error) = channel.write_all(&[RESPONSE_ACK], deadline) {
        return failure(
            if matches!(error, ControlPipeError::Timeout) {
                ControlStatus::Timeout
            } else {
                ControlStatus::CommunicationError
            },
            error,
        );
    }
    if let Err(error) = identity.check_live(&channel.pipe) {
        return failure(ControlStatus::UntrustedServer, error);
    }
    report
}

fn decode_response(
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
    let valid_shape = match report.status {
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
    };
    if !valid_shape {
        return failure(
            ControlStatus::CommunicationError,
            "Unexpected control response state or shape",
        );
    }
    report
}

fn failure(status: ControlStatus, message: impl std::fmt::Display) -> ControlReport {
    ControlReport::failure(status, message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_control::{
        PluginControlAction, PluginControlOutcome, PluginControlReport, PluginControlRequest,
    };
    use std::ffi::OsString;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn request() -> PluginControlRequest {
        PluginControlRequest {
            action: PluginControlAction::Reload,
            plugin_id: "dev.fixture".into(),
        }
    }
    fn report() -> PluginControlReport {
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
    fn fixture() -> (tempfile::TempDir, RegistryScope, ControlServer) {
        let directory = tempfile::tempdir().unwrap();
        let scope = RegistryScope::for_path(&directory.path().join("config.json")).unwrap();
        let server = ControlServer::bind(scope.acquire(Duration::ZERO).unwrap(), None).unwrap();
        server.broker().set_ready();
        (directory, scope, server)
    }
    fn name() -> OsString {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        OsString::from(format!(
            r"\\.\pipe\Codlet.ControlTest.{}.{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }
    fn channel(name: &OsStr) -> Channel {
        let deadline = Instant::now() + Duration::from_secs(3);
        let pipe = loop {
            match open_client(name) {
                Ok(pipe) => break pipe,
                Err(ControlPipeError::Win32 {
                    code: ERROR_PIPE_BUSY,
                    ..
                }) if Instant::now() < deadline => thread::sleep(Duration::from_millis(2)),
                Err(error) => panic!("open test control client: {error}"),
            }
        };
        Channel {
            pipe,
            event: create_event().unwrap(),
            stop: Arc::new(create_event().unwrap()),
        }
    }
    fn get(scope: &RegistryScope, request: &ControlRequest) -> ControlReport {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let report = query(scope, request);
            if report.status != ControlStatus::Busy || Instant::now() >= deadline {
                return report;
            }
            thread::sleep(Duration::from_millis(2));
        }
    }
    fn raw_request(name: &OsStr, bytes: &[u8]) -> ControlReport {
        let channel = channel(name);
        let deadline = Instant::now() + CONTROL_QUERY_TIMEOUT;
        channel.write_frame(bytes, deadline).unwrap();
        let response = channel
            .read_frame(MAX_CONTROL_RESPONSE_BYTES, deadline)
            .unwrap();
        channel.write_all(&[RESPONSE_ACK], deadline).unwrap();
        serde_json::from_slice(&response).unwrap()
    }

    #[test]
    fn real_pipe_only_enqueues_and_receipt_survives_a_lost_submit_response() {
        let (_directory, scope, server) = fixture();
        let broker = server.broker();
        let prepared = get(&scope, &ControlRequest::prepare(request()));
        assert_eq!(prepared.status, ControlStatus::Prepared, "{prepared:?}");
        assert!(broker.take_next().is_none());
        let ticket = prepared.operation_id().unwrap();
        let client = channel(scope.pipe_name());
        client
            .write_frame(
                &serde_json::to_vec(&ControlRequest::submit(ticket)).unwrap(),
                Instant::now() + CONTROL_QUERY_TIMEOUT,
            )
            .unwrap();
        // Wait only for the mailbox transition, then lose the connection without
        // consuming the response or ACK. No renderer is owned by the pipe thread.
        let deadline = Instant::now() + CONTROL_QUERY_TIMEOUT;
        while broker.handle(ControlRequest::result(ticket)).status == ControlStatus::Prepared {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(2));
        }
        drop(client);
        assert_eq!(
            get(&scope, &ControlRequest::result(ticket)).status,
            ControlStatus::Queued
        );
        let job = broker.take_next().unwrap();
        assert_eq!(job.operation_id, ticket);
        assert_eq!(
            get(&scope, &ControlRequest::submit(ticket)).status,
            ControlStatus::Running
        );
        assert!(broker.take_next().is_none());
        broker.complete(ticket, Ok(report()));
        let completed = get(&scope, &ControlRequest::result(ticket));
        assert!(completed.is_success());
        assert_eq!(completed, get(&scope, &ControlRequest::submit(ticket)));
        assert!(broker.take_next().is_none());
    }

    #[test]
    fn discovery_is_read_only_and_registry_scopes_cannot_cross() {
        let directory = tempfile::tempdir().unwrap();
        let scope = RegistryScope::for_path(&directory.path().join("one/config.json")).unwrap();
        let discovery_name = name();
        let server = ControlServer::bind(
            scope.acquire(Duration::ZERO).unwrap(),
            Some(&discovery_name),
        )
        .unwrap();
        server.broker().set_ready();
        let identified = exchange(
            &discovery_name,
            None,
            &ControlRequest::identify(),
            CONTROL_QUERY_TIMEOUT,
        );
        assert_eq!(identified.status, ControlStatus::Identified);
        assert_eq!(identified.registry_scope.as_deref(), Some(scope.id()));
        let rejected = raw_request(
            &discovery_name,
            &serde_json::to_vec(&ControlRequest::prepare(request())).unwrap(),
        );
        assert_eq!(rejected.status, ControlStatus::InvalidRequest);
        assert!(server.broker().take_next().is_none());
        let other = RegistryScope::for_path(&directory.path().join("two/config.json")).unwrap();
        assert_eq!(
            get(&other, &ControlRequest::prepare(request())).status,
            ControlStatus::NotRunning
        );
        let wrong_scope = exchange(
            scope.pipe_name(),
            Some(other.id()),
            &ControlRequest::identify(),
            CONTROL_QUERY_TIMEOUT,
        );
        assert_eq!(wrong_scope.status, ControlStatus::UntrustedServer);
        assert!(server.broker().take_next().is_none());
    }

    #[test]
    fn invalid_future_and_oversized_commands_leave_listener_available() {
        let (_directory, scope, server) = fixture();
        for bytes in [
            br#"{"schema_version":1,"command":"eval","source":"process.exit()"}"#.as_slice(),
            br#"{"schema_version":1,"command":"prepare","request":{"action":"reload","plugin_id":"dev.fixture"},"path":"x"}"#,
            b"null", b"\xff",
        ] { assert_eq!(raw_request(scope.pipe_name(), bytes).status, ControlStatus::InvalidRequest); }
        assert_eq!(
            raw_request(
                scope.pipe_name(),
                br#"{"schema_version":99,"command":"future"}"#
            )
            .status,
            ControlStatus::Incompatible
        );
        for size in [0_u32, MAX_CONTROL_REQUEST_BYTES as u32 + 1, u32::MAX] {
            let client = channel(scope.pipe_name());
            let deadline = Instant::now() + CONTROL_QUERY_TIMEOUT;
            client.write_all(&size.to_le_bytes(), deadline).unwrap();
            let mut byte = [0];
            assert!(client.read_exact(&mut byte, deadline).is_err());
            drop(client);
        }
        assert_eq!(
            get(&scope, &ControlRequest::identify()).status,
            ControlStatus::Identified
        );
        assert!(server.broker().take_next().is_none());
    }

    #[test]
    fn both_directions_require_the_expected_live_executable() {
        let (directory, scope, server) = fixture();
        let other_executable = directory.path().join("different-build.exe");
        let rejected = exchange_expected(
            scope.pipe_name(),
            Some(scope.id()),
            &ControlRequest::prepare(request()),
            CONTROL_QUERY_TIMEOUT,
            &other_executable,
        );
        assert_eq!(rejected.status, ControlStatus::UntrustedServer);
        assert!(server.broker().take_next().is_none());

        let name = name();
        let raw_server = Channel {
            pipe: create_server_pipe(&name).unwrap(),
            event: create_event().unwrap(),
            stop: Arc::new(create_event().unwrap()),
        };
        let broker = server.broker();
        let worker = thread::spawn(move || {
            raw_server.connect().unwrap();
            serve_transaction(
                &raw_server,
                &broker,
                &other_executable,
                false,
                Instant::now() + CONTROL_QUERY_TIMEOUT,
            )
        });
        let client = channel(&name);
        // The server rejects the caller identity before reading or enqueueing a body.
        assert!(worker.join().unwrap().is_err());
        drop(client);
        assert!(server.broker().take_next().is_none());
        assert_eq!(
            get(&scope, &ControlRequest::identify()).status,
            ControlStatus::Identified
        );
    }

    #[test]
    fn drop_cancels_stalled_reads_and_releases_endpoint_and_scope_lease() {
        let (_directory, scope, server) = fixture();
        let client = channel(scope.pipe_name());
        client
            .write_all(&[10], Instant::now() + CONTROL_QUERY_TIMEOUT)
            .unwrap();
        let broker = server.broker();
        assert_eq!(
            query(&scope, &ControlRequest::identify()).status,
            ControlStatus::Busy
        );
        let started = Instant::now();
        drop(server);
        assert!(started.elapsed() < Duration::from_millis(500));
        drop(client);
        assert_eq!(
            get(&scope, &ControlRequest::identify()).status,
            ControlStatus::NotRunning
        );
        assert!(broker.take_next().is_none());
        assert_eq!(
            broker.handle(ControlRequest::prepare(request())).status,
            ControlStatus::Stopping
        );
        thread::spawn(move || drop(scope.acquire(Duration::ZERO).unwrap()))
            .join()
            .unwrap();
    }

    #[test]
    fn client_rejects_spoofed_pid_scope_receipt_and_invalid_terminal_shape() {
        let broker = ControlBroker::new([7; 16], "a".repeat(64));
        broker.set_ready();
        let request = ControlRequest::prepare(request());
        let valid = broker.handle(request.clone());
        assert_eq!(
            decode_response(
                &encode_response(&valid).unwrap(),
                std::process::id(),
                Some(&"a".repeat(64)),
                &request
            ),
            valid
        );
        let mut spoofed = valid.clone();
        spoofed.host_pid = 0;
        assert_eq!(
            decode_response(
                &encode_response(&spoofed).unwrap(),
                std::process::id(),
                None,
                &request
            )
            .status,
            ControlStatus::UntrustedServer
        );
        spoofed = valid.clone();
        spoofed.status = ControlStatus::Completed;
        assert_eq!(
            decode_response(
                &encode_response(&spoofed).unwrap(),
                std::process::id(),
                None,
                &request
            )
            .status,
            ControlStatus::CommunicationError
        );
        let different = ControlRequest::result("07070707070707070707070707070707-0000000000000099");
        assert_eq!(
            decode_response(
                &encode_response(&valid).unwrap(),
                std::process::id(),
                None,
                &different
            )
            .status,
            ControlStatus::CommunicationError
        );
    }
}
