//! Authenticated local management transport. Both listeners perform bounded IO
//! and mailbox operations only; renderer execution stays on its foreground owner.
use std::ffi::OsStr;
use std::os::windows::io::OwnedHandle;
use std::path::Path;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    ERROR_FILE_NOT_FOUND, ERROR_NO_DATA, ERROR_PIPE_BUSY, ERROR_PIPE_NOT_CONNECTED, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Pipes::DisconnectNamedPipe;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, SetEvent, WaitForSingleObject};

pub use super::control_scope::{RegistryScope, RegistryScopeGuard};
use super::control_scope::{discovery_pipe_name, random_incarnation};
pub use super::local_ipc::LocalIpcError as ControlPipeError;
use super::local_ipc::{
    Channel, ServerIdentity, create_event, create_server_pipe, open_client, process_image_path, raw,
};
use crate::runtime_control::{
    ControlBroker, ControlReport, ControlRequest, ControlStatus, MAX_CONTROL_REQUEST_BYTES,
    MAX_CONTROL_RESPONSE_BYTES, decode_request, encode_response,
};
use crate::runtime_status::StatusPublisher;

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
    pub fn bind_current_user(
        lease: RegistryScopeGuard,
        publisher: StatusPublisher,
    ) -> Result<Self, ControlPipeError> {
        let discovery = discovery_pipe_name()?;
        Self::bind(lease, Some(&discovery), publisher)
    }

    /// An explicit isolated lab has no production discovery/status listener.
    /// The normal executable/SID authentication still applies in both directions.
    pub(crate) fn bind_isolated(
        lease: RegistryScopeGuard,
        publisher: StatusPublisher,
    ) -> Result<Self, ControlPipeError> {
        Self::bind(lease, None, publisher)
    }

    fn bind(
        lease: RegistryScopeGuard,
        discovery: Option<&OsStr>,
        publisher: StatusPublisher,
    ) -> Result<Self, ControlPipeError> {
        let incarnation = random_incarnation()?;
        publisher
            .bind_runtime_identity(incarnation, lease.scope().id())
            .map_err(|error| {
                ControlPipeError::Invalid(format!("inspection identity binding failed: {error}"))
            })?;
        let broker =
            ControlBroker::with_inspection(incarnation, lease.scope().id().to_owned(), publisher);
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

/// Prefer process-aware inspection, falling back only after an authenticated
/// older Host explicitly rejects the new read-only command. Both reads share
/// one deadline; transport errors never trigger a second probe or a mutation.
pub fn query_execution_inspection(scope: &RegistryScope) -> ControlReport {
    query_inspection_with(scope.id(), |request, timeout| {
        exchange(scope.pipe_name(), Some(scope.id()), request, timeout)
    })
}

fn query_inspection_with(
    scope: &str,
    mut query: impl FnMut(&ControlRequest, Duration) -> ControlReport,
) -> ControlReport {
    let deadline = Instant::now() + CONTROL_QUERY_TIMEOUT;
    let report = query(&ControlRequest::inspect_execution(), CONTROL_QUERY_TIMEOUT);
    if matches!(
        report.status,
        ControlStatus::InvalidRequest | ControlStatus::Incompatible
    ) && report.host_pid != 0
        && report.registry_scope.as_deref() == Some(scope)
    {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return failure(
                ControlStatus::Timeout,
                "Runtime inspection compatibility read exceeded its deadline",
            );
        }
        return query(&ControlRequest::inspect(), remaining);
    }
    report
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
    finish_acknowledged_response(report, &identity)
}

fn finish_acknowledged_response(report: ControlReport, identity: &ServerIdentity) -> ControlReport {
    // The response and connected pipe identity were checked before sending ACK.
    // ACK permits the server to disconnect immediately, so querying that pipe's
    // peer PID here can reject a valid response with ERROR_PIPE_NOT_CONNECTED.
    // The retained process handle still identifies the exact authenticated Host.
    if unsafe { WaitForSingleObject(raw(&identity.process), 0) } != WAIT_TIMEOUT {
        return failure(
            ControlStatus::UntrustedServer,
            "pipe server process ended during the query",
        );
    }
    report
}

use crate::control_validation::decode_response;
#[cfg(test)]
use crate::control_validation::valid_incarnation;

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
            permission: None,
            cascade: false,
            remove_source: None,
            local_import: None,
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
        let server = ControlServer::bind(
            scope.acquire(Duration::ZERO).unwrap(),
            None,
            StatusPublisher::new(),
        )
        .unwrap();
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
        assert!(completed.is_success(), "{completed:?}");
        assert_eq!(completed, get(&scope, &ControlRequest::submit(ticket)));
        assert!(broker.take_next().is_none());
    }

    #[test]
    fn real_pipe_preserves_permission_revocation_and_submits_it_only_once() {
        let (_directory, scope, server) = fixture();
        let broker = server.broker();
        let request = PluginControlRequest {
            action: PluginControlAction::Revoke,
            plugin_id: "dev.fixture".into(),
            permission: Some(crate::plugins::Permission::HostFs),
            cascade: false,
            remove_source: None,
            local_import: None,
        };
        let prepared = get(&scope, &ControlRequest::prepare(request.clone()));
        assert_eq!(prepared.status, ControlStatus::Prepared, "{prepared:?}");
        assert!(broker.take_next().is_none());
        let ticket = prepared.operation_id().unwrap();
        assert_eq!(
            get(&scope, &ControlRequest::submit(ticket)).status,
            ControlStatus::Queued
        );
        assert_eq!(
            get(&scope, &ControlRequest::submit(ticket)).status,
            ControlStatus::Queued
        );
        let job = broker.take_next().unwrap();
        assert_eq!(job.request, request);
        assert!(broker.take_next().is_none());
        let mut applied = report();
        applied.action = PluginControlAction::Revoke;
        broker.complete(ticket, Ok(applied));
        let completed = get(&scope, &ControlRequest::result(ticket));
        assert!(completed.is_success(), "{completed:?}");
        assert_eq!(get(&scope, &ControlRequest::submit(ticket)), completed);
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
            StatusPublisher::new(),
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
        let inspected = raw_request(
            &discovery_name,
            &serde_json::to_vec(&ControlRequest::inspect()).unwrap(),
        );
        assert_eq!(inspected.status, ControlStatus::InvalidRequest);
        assert!(inspected.inspection.is_none());
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

    #[test]
    fn scoped_inspection_reads_one_publication_without_config_io_or_receipt_work() {
        use crate::runtime_inspection::RendererInspection;
        use crate::runtime_status::{HostState, RendererStatus};

        let directory = tempfile::tempdir().unwrap();
        let scope = RegistryScope::for_path(&directory.path().join("config.json")).unwrap();
        let publisher = StatusPublisher::new();
        let server = ControlServer::bind(
            scope.acquire(Duration::ZERO).unwrap(),
            None,
            publisher.clone(),
        )
        .unwrap();
        let broker = server.broker();
        let starting = get(&scope, &ControlRequest::inspect());
        assert_eq!(starting.status, ControlStatus::Inspected, "{starting:?}");
        let starting = starting.inspection.unwrap();
        assert_eq!(starting.state, HostState::Starting);
        assert_eq!(starting.host_pid, std::process::id());
        assert_eq!(starting.registry_scope, scope.id());
        assert!(valid_incarnation(&starting.host_incarnation));
        assert!(broker.take_next().is_none());
        // Deliberately invalid disk declarations cannot poison this cached view.
        let invalid = b"{ invalid configuration and invented provider claims";
        std::fs::write(scope.path(), invalid).unwrap();
        publisher.set_ready();
        publisher
            .publish_renderer_observation(RendererStatus::default(), RendererInspection::default());
        broker.set_ready();
        let ready = get(&scope, &ControlRequest::inspect());
        assert_eq!(ready.status, ControlStatus::Inspected);
        let inspection = ready.inspection.as_ref().unwrap();
        assert_eq!(inspection.state, HostState::Ready);
        assert_eq!(inspection.sequence, publisher.snapshot().sequence);
        assert_eq!(
            inspection.sampled_at_unix_ms,
            publisher.snapshot().sampled_at_unix_ms
        );
        assert_eq!(inspection.host_incarnation, starting.host_incarnation);
        assert!(inspection.renderer.as_ref().unwrap().providers.is_empty());
        assert_eq!(std::fs::read(scope.path()).unwrap(), invalid);
        assert_eq!(directory.path().read_dir().unwrap().count(), 1);

        let prepared = get(&scope, &ControlRequest::prepare(request()));
        assert!(
            prepared
                .operation_id()
                .unwrap()
                .ends_with("-0000000000000001")
        );
        assert!(prepared.inspection.is_none());
        let mut leaked = broker.handle(ControlRequest::identify());
        let mut null_extension = serde_json::to_value(&leaked).unwrap();
        null_extension["inspection"] = serde_json::Value::Null;
        assert_eq!(
            decode_response(
                &serde_json::to_vec(&null_extension).unwrap(),
                std::process::id(),
                Some(scope.id()),
                &ControlRequest::identify()
            )
            .status,
            ControlStatus::CommunicationError
        );
        leaked.inspection = ready.inspection.clone();
        assert_eq!(
            decode_response(
                &encode_response(&leaked).unwrap(),
                std::process::id(),
                Some(scope.id()),
                &ControlRequest::identify()
            )
            .status,
            ControlStatus::CommunicationError
        );
        for mode in ["pid", "scope", "incarnation"] {
            let mut forged = ready.clone();
            let inspection = forged.inspection.as_mut().unwrap();
            match mode {
                "pid" => inspection.host_pid = 0,
                "scope" => inspection.registry_scope = "b".repeat(64),
                _ => inspection.host_incarnation = "invalid-epoch".into(),
            }
            assert_eq!(
                decode_response(
                    &encode_response(&forged).unwrap(),
                    std::process::id(),
                    Some(scope.id()),
                    &ControlRequest::inspect()
                )
                .status,
                ControlStatus::UntrustedServer,
                "mode={mode}"
            );
        }
        publisher.terminate("fixture stopped");
        broker.stop();
        let terminated = get(&scope, &ControlRequest::inspect());
        assert_eq!(terminated.status, ControlStatus::Inspected);
        assert_eq!(terminated.inspection.unwrap().state, HostState::Terminated);
        assert!(broker.take_next().is_none());
    }

    #[test]
    fn old_host_inspect_rejection_is_readable_and_foreign_snapshot_incarnation_is_refused() {
        let scope = "a".repeat(64);
        let old_name = name();
        let server = Channel {
            pipe: create_server_pipe(&old_name).unwrap(),
            event: create_event().unwrap(),
            stop: Arc::new(create_event().unwrap()),
        };
        let old_broker = ControlBroker::new([1; 16], scope.clone());
        let worker = thread::spawn(move || {
            server.connect().unwrap();
            let deadline = Instant::now() + CONTROL_QUERY_TIMEOUT;
            let body = server
                .read_frame(MAX_CONTROL_REQUEST_BYTES, deadline)
                .unwrap();
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&body).unwrap()["command"],
                "inspect"
            );
            let rejected = server_failure(
                &old_broker,
                ControlStatus::InvalidRequest,
                "This older Host recognizes identify/prepare/submit/result only",
            );
            assert!(
                serde_json::to_value(&rejected)
                    .unwrap()
                    .get("inspection")
                    .is_none()
            );
            server
                .write_frame(&encode_response(&rejected).unwrap(), deadline)
                .unwrap();
            let mut ack = [0];
            server.read_exact(&mut ack, deadline).unwrap();
            assert_eq!(ack, [RESPONSE_ACK]);
            assert!(old_broker.take_next().is_none());
        });
        let rejected = exchange(
            &old_name,
            Some(&scope),
            &ControlRequest::inspect(),
            CONTROL_QUERY_TIMEOUT,
        );
        assert_eq!(
            rejected.status,
            ControlStatus::InvalidRequest,
            "{rejected:?}"
        );
        assert!(rejected.inspection.is_none());
        worker.join().unwrap();

        let publisher = StatusPublisher::new();
        publisher.bind_runtime_identity([1; 16], &scope).unwrap();
        let foreign = ControlBroker::with_inspection([2; 16], scope.clone(), publisher);
        let foreign_name = name();
        let _worker = PipeWorker::bind(&foreign_name, foreign, false).unwrap();
        let rejected = exchange(
            &foreign_name,
            Some(&scope),
            &ControlRequest::inspect(),
            CONTROL_QUERY_TIMEOUT,
        );
        assert_eq!(rejected.status, ControlStatus::StaleHost, "{rejected:?}");
        assert!(rejected.inspection.is_none());
    }

    #[test]
    fn scoped_execution_inspection_transports_process_facts_without_legacy_field_leaks() {
        use crate::plugin_execution::HostRuntimeSnapshot;
        let directory = tempfile::tempdir().unwrap();
        let scope = RegistryScope::for_path(&directory.path().join("not-created.json")).unwrap();
        let publisher = StatusPublisher::new();
        let server = ControlServer::bind(
            scope.acquire(Duration::from_millis(100)).unwrap(),
            None,
            publisher.clone(),
        )
        .unwrap();
        let hosts = HostRuntimeSnapshot {
            sequence: 12,
            sampled_at_unix_ms: 5000,
            owner_alive: true,
            runtime_stopping: false,
            retained_limit: 80,
            history_truncated: true,
            plugins: Vec::new(),
        };
        publisher.publish_host_observation(hosts.clone());
        publisher.set_ready();
        server.broker().set_ready();
        let reply = get(&scope, &ControlRequest::inspect_execution());
        assert_eq!(reply.status, ControlStatus::Inspected, "{reply:?}");
        assert_eq!(reply.host_inspection.as_ref(), Some(&hosts));
        assert_eq!(
            reply.inspection.as_ref().unwrap().host_pid,
            std::process::id()
        );
        assert_eq!(
            reply.inspection.as_ref().unwrap().registry_scope,
            scope.id()
        );
        assert!(!scope.path().exists());
        assert!(server.broker().take_next().is_none());

        for request in [ControlRequest::inspect(), ControlRequest::identify()] {
            let mut leaked = server.broker().handle(request.clone());
            assert!(
                serde_json::to_value(&leaked)
                    .unwrap()
                    .get("host_inspection")
                    .is_none()
            );
            leaked.host_inspection = Some(hosts.clone());
            assert_eq!(
                decode_response(
                    &encode_response(&leaked).unwrap(),
                    std::process::id(),
                    Some(scope.id()),
                    &request
                )
                .status,
                ControlStatus::CommunicationError
            );
            let mut null_extension =
                serde_json::to_value(server.broker().handle(request.clone())).unwrap();
            null_extension["host_inspection"] = serde_json::Value::Null;
            assert_eq!(
                decode_response(
                    &serde_json::to_vec(&null_extension).unwrap(),
                    std::process::id(),
                    Some(scope.id()),
                    &request
                )
                .status,
                ControlStatus::CommunicationError
            );
        }
        let mut missing_identity = reply;
        missing_identity.inspection = None;
        assert_eq!(
            decode_response(
                &encode_response(&missing_identity).unwrap(),
                std::process::id(),
                Some(scope.id()),
                &ControlRequest::inspect_execution()
            )
            .status,
            ControlStatus::CommunicationError
        );
    }

    #[test]
    fn execution_inspection_falls_back_only_on_authenticated_compatibility_rejection() {
        let scope = "a".repeat(64);
        let publisher = StatusPublisher::new();
        publisher.bind_runtime_identity([8; 16], &scope).unwrap();
        let broker = ControlBroker::with_inspection([8; 16], scope.clone(), publisher);
        let mut calls = Vec::new();
        let reply = query_inspection_with(&scope, |request, timeout| {
            assert!(timeout <= CONTROL_QUERY_TIMEOUT && !timeout.is_zero());
            calls.push(request.clone());
            if matches!(request, ControlRequest::InspectExecution { .. }) {
                server_failure(
                    &broker,
                    ControlStatus::InvalidRequest,
                    "older Host has no inspect_execution command",
                )
            } else {
                broker.handle(request.clone())
            }
        });
        assert_eq!(reply.status, ControlStatus::Inspected);
        assert_eq!(
            calls,
            [
                ControlRequest::inspect_execution(),
                ControlRequest::inspect()
            ]
        );
        assert!(reply.host_inspection.is_none() && reply.inspection.is_some());
        assert!(broker.take_next().is_none());
        for status in [
            ControlStatus::Timeout,
            ControlStatus::Busy,
            ControlStatus::UntrustedServer,
            ControlStatus::CommunicationError,
            ControlStatus::StaleHost,
        ] {
            let mut calls = 0;
            let reply = query_inspection_with(&scope, |request, _| {
                calls += 1;
                assert!(matches!(request, ControlRequest::InspectExecution { .. }));
                server_failure(&broker, status, "fixture transport failure")
            });
            assert_eq!(reply.status, status);
            assert_eq!(calls, 1);
        }
        for authenticated in [false, true] {
            let mut calls = 0;
            query_inspection_with(&scope, |_, _| {
                calls += 1;
                let mut reply =
                    server_failure(&broker, ControlStatus::InvalidRequest, "fixture rejection");
                if authenticated {
                    reply.registry_scope = Some("b".repeat(64));
                } else {
                    reply.host_pid = 0;
                }
                reply
            });
            assert_eq!(calls, 1);
        }
    }

    #[test]
    fn acknowledged_response_survives_server_disconnect_before_final_liveness_check() {
        let name = name();
        let server = Channel {
            pipe: create_server_pipe(&name).unwrap(),
            event: create_event().unwrap(),
            stop: Arc::new(create_event().unwrap()),
        };
        let broker = ControlBroker::new([1; 16], "a".repeat(64));
        let expected = broker.handle(ControlRequest::identify());
        let (disconnected_tx, disconnected_rx) = std::sync::mpsc::sync_channel(1);
        let bytes = encode_response(&expected).unwrap();
        let worker = thread::spawn(move || {
            server.connect().unwrap();
            let deadline = Instant::now() + CONTROL_QUERY_TIMEOUT;
            server
                .read_frame(MAX_CONTROL_REQUEST_BYTES, deadline)
                .unwrap();
            server.write_frame(&bytes, deadline).unwrap();
            let mut ack = [0];
            server.read_exact(&mut ack, deadline).unwrap();
            assert_eq!(ack, [RESPONSE_ACK]);
            assert_ne!(unsafe { DisconnectNamedPipe(raw(&server.pipe)) }, 0);
            disconnected_tx.send(()).unwrap();
        });
        let client = channel(&name);
        let identity =
            ServerIdentity::verify(&client.pipe, &std::env::current_exe().unwrap()).unwrap();
        let deadline = Instant::now() + CONTROL_QUERY_TIMEOUT;
        client
            .write_frame(
                &serde_json::to_vec(&ControlRequest::identify()).unwrap(),
                deadline,
            )
            .unwrap();
        let bytes = client
            .read_frame(MAX_CONTROL_RESPONSE_BYTES, deadline)
            .unwrap();
        identity.check_live(&client.pipe).unwrap();
        let report = decode_response(
            &bytes,
            identity.pid,
            Some(&"a".repeat(64)),
            &ControlRequest::identify(),
        );
        client.write_all(&[RESPONSE_ACK], deadline).unwrap();
        disconnected_rx.recv_timeout(CONTROL_QUERY_TIMEOUT).unwrap();
        worker.join().unwrap();
        let completed = finish_acknowledged_response(report, &identity);
        assert_eq!(completed, expected, "post-ACK result: {completed:?}");
    }
}
