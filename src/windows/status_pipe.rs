//! One local pipe instance, one worker, one bounded read-only transaction at a time.
use std::ffi::{OsStr, OsString};
use std::io::{self, Write};
use std::os::windows::io::OwnedHandle;
use std::path::Path;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::System::Pipes::DisconnectNamedPipe;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, SetEvent, WaitForSingleObject};

use super::launch_mutex::current_user_sid_bytes;
#[cfg(test)]
use super::local_ipc::LocalAllocation;
pub use super::local_ipc::LocalIpcError as StatusPipeError;
use super::local_ipc::{
    Channel, ServerIdentity, create_event, create_server_pipe, open_client, process_image_path, raw,
};
use crate::runtime_status::{
    MAX_STATUS_REQUEST_BYTES, MAX_STATUS_RESPONSE_BYTES, STATUS_SCHEMA_VERSION, StatusCode,
    StatusPublisher, StatusReport, validate_request,
};

const PIPE_PREFIX: &str = r"\\.\pipe\Codlet.RuntimeStatus.";
pub const STATUS_QUERY_TIMEOUT: Duration = Duration::from_millis(1500);
const SERVER_TRANSACTION_TIMEOUT: Duration = Duration::from_millis(750);
const RESPONSE_ACK: u8 = 6;
const REQUEST: &[u8] = br#"{"schema_version":1,"command":"status"}"#;

pub struct StatusServer {
    publisher: StatusPublisher,
    stop: Arc<OwnedHandle>,
    worker: Option<JoinHandle<()>>,
}

impl StatusServer {
    /// Call only after configuration and instance-conflict checks, before spawning Codex.
    /// All pipe/event/thread allocations finish before this returns.
    pub fn bind_current_user(publisher: StatusPublisher) -> Result<Self, StatusPipeError> {
        Self::bind(&current_user_pipe_name()?, publisher)
    }

    fn bind(name: &OsStr, publisher: StatusPublisher) -> Result<Self, StatusPipeError> {
        let pipe = create_server_pipe(name)?;
        let stop = Arc::new(create_event()?);
        let io_event = create_event()?;
        let worker_stop = Arc::clone(&stop);
        let worker_publisher = publisher.clone();
        let worker = thread::Builder::new()
            .name("codlet-status".to_owned())
            .spawn(move || {
                let channel = Channel {
                    pipe,
                    event: io_event,
                    stop: worker_stop,
                };
                while !channel.is_stopping() {
                    // No deadline while listening. The stop event cancels this overlapped wait.
                    match channel.connect() {
                        Ok(()) => {}
                        Err(StatusPipeError::Stopping) => break,
                        Err(StatusPipeError::Win32 {
                            code: ERROR_NO_DATA | ERROR_PIPE_NOT_CONNECTED,
                            ..
                        }) => {
                            unsafe {
                                DisconnectNamedPipe(raw(&channel.pipe));
                            }
                            continue;
                        }
                        Err(error) => {
                            eprintln!("codlet: status IPC listener stopped: {error}");
                            break;
                        }
                    }
                    let deadline = Instant::now() + SERVER_TRANSACTION_TIMEOUT;
                    let _ = serve_transaction(&channel, &worker_publisher, deadline);
                    // The client ACK proves it consumed the response. Never FlushFileBuffers:
                    // that would let a client that stops reading block worker shutdown.
                    unsafe {
                        DisconnectNamedPipe(raw(&channel.pipe));
                    }
                }
            })?;
        Ok(Self {
            publisher,
            stop,
            worker: Some(worker),
        })
    }
}

impl Drop for StatusServer {
    fn drop(&mut self) {
        self.publisher.terminate("host_dropped");
        // SAFETY: the shared event outlives the worker and this signal.
        unsafe {
            SetEvent(raw(&self.stop));
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

pub fn query_current_user() -> StatusReport {
    let name = match current_user_pipe_name() {
        Ok(name) => name,
        Err(error) => return failure(StatusCode::CommunicationError, error),
    };
    let executable = match process_image_path(unsafe { GetCurrentProcess() }) {
        Ok(path) => path,
        Err(error) => return failure(StatusCode::UntrustedServer, error),
    };
    query(&name, &executable, STATUS_QUERY_TIMEOUT)
}

fn query(name: &OsStr, expected_executable: &Path, timeout: Duration) -> StatusReport {
    let deadline = Instant::now() + timeout;
    let pipe = match open_client(name) {
        Ok(pipe) => pipe,
        Err(StatusPipeError::Win32 {
            code: ERROR_FILE_NOT_FOUND,
            ..
        }) => {
            return StatusReport::outcome(StatusCode::NotRunning, None);
        }
        Err(StatusPipeError::Win32 {
            code: ERROR_PIPE_BUSY,
            ..
        }) => {
            return failure(
                StatusCode::Busy,
                "Host status pipe is serving another client",
            );
        }
        Err(error) => return failure(StatusCode::CommunicationError, error),
    };
    // Retain the process handle through the complete exchange, including final liveness
    // and PID checks. A PID-only comparison is not a process identity check.
    let identity = match ServerIdentity::verify(&pipe, expected_executable) {
        Ok(identity) => identity,
        Err(error) => return failure(StatusCode::UntrustedServer, error),
    };
    let event = match create_event() {
        Ok(event) => event,
        Err(error) => return failure(StatusCode::CommunicationError, error),
    };
    let stop = match create_event() {
        Ok(event) => Arc::new(event),
        Err(error) => return failure(StatusCode::CommunicationError, error),
    };
    let channel = Channel { pipe, event, stop };
    let exchange = (|| {
        channel.write_frame(REQUEST, deadline)?;
        let bytes = channel.read_frame(MAX_STATUS_RESPONSE_BYTES, deadline)?;
        Ok::<_, StatusPipeError>(bytes)
    })();
    let bytes = match exchange {
        Ok(bytes) => bytes,
        Err(StatusPipeError::Timeout) => {
            return failure(StatusCode::Timeout, "Host status transaction timed out");
        }
        Err(error) => return failure(StatusCode::CommunicationError, error),
    };
    if let Err(error) = identity.check_live(&channel.pipe) {
        return failure(StatusCode::UntrustedServer, error);
    }
    if let Err(error) = channel.write_all(&[RESPONSE_ACK], deadline) {
        return failure(
            if matches!(error, StatusPipeError::Timeout) {
                StatusCode::Timeout
            } else {
                StatusCode::CommunicationError
            },
            error,
        );
    }
    if unsafe { WaitForSingleObject(raw(&identity.process), 0) } != WAIT_TIMEOUT {
        return failure(
            StatusCode::UntrustedServer,
            "pipe server process ended during the query",
        );
    }
    decode_response(&bytes, identity.pid)
}

fn decode_response(bytes: &[u8], server_pid: u32) -> StatusReport {
    // Read the version before decoding the v1 shape so future schemas remain
    // distinguishable from malformed v1 responses.
    let value: serde_json::Value = match serde_json::from_slice(bytes) {
        Ok(value) => value,
        Err(error) => return failure(StatusCode::CommunicationError, error),
    };
    match value
        .get("schema_version")
        .and_then(serde_json::Value::as_u64)
    {
        Some(version) if version != u64::from(STATUS_SCHEMA_VERSION) => {
            return failure(
                StatusCode::Incompatible,
                format!("Host schema {version}; client supports {STATUS_SCHEMA_VERSION}"),
            );
        }
        None => {
            return failure(
                StatusCode::CommunicationError,
                "Host response has no schema_version",
            );
        }
        _ => {}
    }
    let report: StatusReport = match serde_json::from_slice(bytes) {
        Ok(report) => report,
        Err(error) => return failure(StatusCode::CommunicationError, error),
    };
    if report.status == StatusCode::Running {
        match &report.snapshot {
            Some(snapshot) if snapshot.host_pid == server_pid && report.error.is_none() => {}
            Some(snapshot) if snapshot.host_pid != server_pid => {
                return failure(
                    StatusCode::UntrustedServer,
                    "Host response PID does not match the pipe server",
                );
            }
            _ => {
                return failure(
                    StatusCode::CommunicationError,
                    "running response requires a snapshot and no error",
                );
            }
        }
    } else if !matches!(
        report.status,
        StatusCode::Incompatible | StatusCode::InvalidRequest | StatusCode::SnapshotTooLarge
    ) || report.snapshot.is_some()
        || report.error.is_none()
    {
        return failure(
            StatusCode::CommunicationError,
            "unexpected Host response status or shape",
        );
    }
    report
}

fn serve_transaction(
    channel: &Channel,
    publisher: &StatusPublisher,
    deadline: Instant,
) -> Result<(), StatusPipeError> {
    let request = channel.read_frame(MAX_STATUS_REQUEST_BYTES, deadline)?;
    let report = match validate_request(&request) {
        Ok(()) => StatusReport {
            schema_version: STATUS_SCHEMA_VERSION,
            status: StatusCode::Running,
            snapshot: Some((*publisher.snapshot()).clone()),
            error: None,
        },
        Err(code) => failure(
            code,
            "expected {schema_version:1,command:status} and no other fields",
        ),
    };
    let bytes = encode_response(&report);
    channel.write_frame(&bytes, deadline)?;
    let mut ack = [0];
    channel.read_exact(&mut ack, deadline)?;
    if ack != [RESPONSE_ACK] {
        return Err(StatusPipeError::Invalid("invalid response ACK".to_owned()));
    }
    Ok(())
}

fn encode_response(report: &StatusReport) -> Vec<u8> {
    struct Bounded(Vec<u8>);
    impl Write for Bounded {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.0.len().saturating_add(bytes.len()) > MAX_STATUS_RESPONSE_BYTES {
                return Err(io::Error::other("status response exceeds frame limit"));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut buffer = Bounded(Vec::new());
    if serde_json::to_writer(&mut buffer, report).is_err() {
        return serde_json::to_vec(&failure(
            StatusCode::SnapshotTooLarge,
            "Host snapshot exceeds 262144 bytes",
        ))
        .expect("small error response is serializable");
    }
    buffer.0
}

fn failure(code: StatusCode, error: impl std::fmt::Display) -> StatusReport {
    StatusReport::outcome(code, Some(error.to_string()))
}

fn current_user_pipe_name() -> Result<OsString, StatusPipeError> {
    let sid =
        current_user_sid_bytes().map_err(|error| StatusPipeError::Invalid(error.to_string()))?;
    let suffix: String = sid.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(OsString::from(format!("{PIPE_PREFIX}{suffix}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_status::{CodexStatus, HostState, RendererStatus};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn name() -> OsString {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        OsString::from(format!(
            r"\\.\pipe\Codlet.StatusTest.{}.{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn channel(name: &OsStr) -> Channel {
        let deadline = Instant::now() + Duration::from_secs(3);
        let pipe = loop {
            match open_client(name) {
                Ok(pipe) => break pipe,
                Err(StatusPipeError::Win32 {
                    code: ERROR_PIPE_BUSY,
                    ..
                }) if Instant::now() < deadline => thread::sleep(Duration::from_millis(2)),
                Err(error) => panic!("open test client: {error}"),
            }
        };
        Channel {
            pipe,
            event: create_event().unwrap(),
            stop: Arc::new(create_event().unwrap()),
        }
    }

    fn get(name: &OsStr) -> StatusReport {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let report = query(
                name,
                &std::env::current_exe().unwrap(),
                STATUS_QUERY_TIMEOUT,
            );
            if report.status != StatusCode::Busy || Instant::now() >= deadline {
                return report;
            }
            thread::sleep(Duration::from_millis(2));
        }
    }

    fn request(name: &OsStr, bytes: &[u8]) -> StatusReport {
        let channel = channel(name);
        let deadline = Instant::now() + STATUS_QUERY_TIMEOUT;
        channel.write_frame(bytes, deadline).unwrap();
        let response = channel
            .read_frame(MAX_STATUS_RESPONSE_BYTES, deadline)
            .unwrap();
        channel.write_all(&[RESPONSE_ACK], deadline).unwrap();
        serde_json::from_slice(&response).unwrap()
    }

    #[test]
    fn no_host_is_versioned_and_sid_name_is_stable() {
        let report = get(&name());
        assert_eq!(report.status, StatusCode::NotRunning);
        assert_eq!(report.schema_version, 1);
        assert!(report.snapshot.is_none());
        let scoped = current_user_pipe_name().unwrap();
        assert_eq!(scoped, current_user_pipe_name().unwrap());
        assert!(scoped.to_string_lossy().starts_with(PIPE_PREFIX));
    }

    #[test]
    fn preconnect_disconnect_recovers_and_preconnected_client_needs_no_overlapped_result() {
        let name = name();
        let server = Channel {
            pipe: create_server_pipe(&name).unwrap(),
            event: create_event().unwrap(),
            stop: Arc::new(create_event().unwrap()),
        };
        drop(open_client(&name).unwrap());
        assert!(matches!(
            server.connect(),
            Err(StatusPipeError::Win32 {
                code: ERROR_NO_DATA,
                ..
            })
        ));
        unsafe {
            DisconnectNamedPipe(raw(&server.pipe));
        }
        let publisher = StatusPublisher::new();
        let worker = thread::spawn(move || {
            server.connect().unwrap();
            serve_transaction(&server, &publisher, Instant::now() + STATUS_QUERY_TIMEOUT)
        });
        let client = channel(&name);
        let deadline = Instant::now() + STATUS_QUERY_TIMEOUT;
        client.write_frame(REQUEST, deadline).unwrap();
        let report: StatusReport = serde_json::from_slice(
            &client
                .read_frame(MAX_STATUS_RESPONSE_BYTES, deadline)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(report.status, StatusCode::Running);
        client.write_all(&[RESPONSE_ACK], deadline).unwrap();
        worker.join().unwrap().unwrap();

        let fresh_name = super::tests::name();
        let server = Channel {
            pipe: create_server_pipe(&fresh_name).unwrap(),
            event: create_event().unwrap(),
            stop: Arc::new(create_event().unwrap()),
        };
        let _preconnected = open_client(&fresh_name).unwrap();
        server.connect().unwrap();
    }

    #[test]
    fn real_pipe_serves_starting_ready_and_terminated_snapshots_then_cleans_up() {
        let name = name();
        let publisher = StatusPublisher::new();
        let server = StatusServer::bind(&name, publisher.clone()).unwrap();
        let starting = get(&name);
        assert_eq!(starting.status, StatusCode::Running, "{starting:?}");
        let starting = starting.snapshot.unwrap();
        assert_eq!(starting.state, HostState::Starting);
        assert!(starting.codex.is_none());
        publisher.set_codex(CodexStatus {
            pid: 12345,
            package_full_name: "fixture_1.2.3.4_x64".into(),
            package_version: "1.2.3.4".into(),
            executable: "fixture.exe".into(),
        });
        publisher.set_ready();
        for _ in 0..30 {
            let report = get(&name);
            assert_eq!(report.status, StatusCode::Running, "{report:?}");
            let snapshot = report.snapshot.unwrap();
            assert_eq!(snapshot.state, HostState::Ready);
            assert_eq!(snapshot.codex.unwrap().pid, 12345);
            assert_eq!(snapshot.host_pid, std::process::id());
            assert!(snapshot.sampled_at_unix_ms >= starting.sampled_at_unix_ms);
        }
        publisher.terminate("fixture_exited");
        assert_eq!(get(&name).snapshot.unwrap().state, HostState::Terminated);
        drop(server);
        assert_eq!(get(&name).status, StatusCode::NotRunning);
        drop(StatusServer::bind(&name, StatusPublisher::new()).unwrap());
    }

    #[test]
    fn first_instance_and_executable_identity_are_enforced() {
        let name = name();
        let server = StatusServer::bind(&name, StatusPublisher::new()).unwrap();
        assert!(StatusServer::bind(&name, StatusPublisher::new()).is_err());
        let directory = tempfile::tempdir().unwrap();
        let other_build = directory.path().join("other-build.exe");
        std::fs::write(&other_build, b"fixture path").unwrap();
        let report = query(&name, &other_build, STATUS_QUERY_TIMEOUT);
        assert_eq!(report.status, StatusCode::UntrustedServer, "{report:?}");
        assert!(
            report
                .error
                .unwrap()
                .contains("differs from this Codlet build")
        );
        // Failed identity checks disconnect without sending any request.
        assert_eq!(get(&name).status, StatusCode::Running);
        drop(server);
    }

    #[test]
    fn pipe_dacl_is_protected_and_grants_only_the_current_user() {
        use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_KERNEL_OBJECT};
        use windows_sys::Win32::Security::{
            ACCESS_ALLOWED_ACE, DACL_SECURITY_INFORMATION, EqualSid, GetAce,
            GetSecurityDescriptorControl, SE_DACL_PROTECTED,
        };
        let pipe = create_server_pipe(&name()).unwrap();
        let mut descriptor = std::ptr::null_mut();
        let mut acl = std::ptr::null_mut();
        assert_eq!(
            unsafe {
                GetSecurityInfo(
                    raw(&pipe),
                    SE_KERNEL_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &mut acl,
                    std::ptr::null_mut(),
                    &mut descriptor,
                )
            },
            0
        );
        let descriptor = LocalAllocation(descriptor);
        let mut control = 0;
        let mut revision = 0;
        assert_ne!(
            unsafe { GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) },
            0
        );
        assert_ne!(control & SE_DACL_PROTECTED, 0);
        assert!(!acl.is_null());
        assert_eq!(unsafe { (*acl).AceCount }, 1);
        let mut ace = std::ptr::null_mut();
        assert_ne!(unsafe { GetAce(acl, 0, &mut ace) }, 0);
        let ace = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
        assert_eq!(ace.Header.AceType, 0); // ACCESS_ALLOWED_ACE_TYPE
        let mut sid = current_user_sid_bytes().unwrap();
        assert_ne!(
            unsafe {
                EqualSid(
                    (&ace.SidStart as *const u32).cast_mut().cast(),
                    sid.as_mut_ptr().cast(),
                )
            },
            0
        );
    }

    #[test]
    fn invalid_and_future_requests_do_not_poison_listener() {
        let name = name();
        let _server = StatusServer::bind(&name, StatusPublisher::new()).unwrap();
        for bytes in [
            b"null".as_slice(),
            b"\xff",
            br#"{"schema_version":1,"command":"evaluate","js":"process.exit()"}"#,
            br#"{"schema_version":1,"command":"status","extra":true}"#,
        ] {
            assert_eq!(request(&name, bytes).status, StatusCode::InvalidRequest);
        }
        assert_eq!(
            request(&name, br#"{"schema_version":99,"command":"status"}"#).status,
            StatusCode::Incompatible
        );
        assert_eq!(get(&name).status, StatusCode::Running);
    }

    #[test]
    fn huge_frames_zero_frames_and_immediate_disconnects_leave_server_usable() {
        let name = name();
        let _server = StatusServer::bind(&name, StatusPublisher::new()).unwrap();
        for size in [0_u32, 1025, u32::MAX] {
            let channel = channel(&name);
            let deadline = Instant::now() + STATUS_QUERY_TIMEOUT;
            channel.write_all(&size.to_le_bytes(), deadline).unwrap();
            let mut byte = [0];
            assert!(channel.read_exact(&mut byte, deadline).is_err());
            drop(channel);
            assert_eq!(get(&name).status, StatusCode::Running);
        }
        for _ in 0..30 {
            drop(channel(&name));
        }
        assert_eq!(get(&name).status, StatusCode::Running);
    }

    #[test]
    fn hung_client_is_bounded_and_busy_does_not_block_publication() {
        let name = name();
        let publisher = StatusPublisher::new();
        let _server = StatusServer::bind(&name, publisher.clone()).unwrap();
        let channel = channel(&name);
        let start = Instant::now();
        // One prefix byte must not renew the absolute server deadline.
        channel
            .write_all(&[10], start + STATUS_QUERY_TIMEOUT)
            .unwrap();
        let busy = query(
            &name,
            &std::env::current_exe().unwrap(),
            STATUS_QUERY_TIMEOUT,
        );
        assert_eq!(busy.status, StatusCode::Busy);
        for _ in 0..100 {
            publisher.publish_renderer(RendererStatus::default());
        }
        assert!(start.elapsed() < Duration::from_millis(500));
        let mut byte = [0];
        assert!(
            channel
                .read_exact(&mut byte, start + Duration::from_secs(2))
                .is_err()
        );
        assert!(start.elapsed() < Duration::from_secs(2));
        drop(channel);
        assert_eq!(get(&name).status, StatusCode::Running);
    }

    #[test]
    fn drop_cancels_listen_read_write_and_ack_waits_and_releases_name() {
        for phase in ["listen", "read", "write", "ack"] {
            let name = name();
            let publisher = StatusPublisher::new();
            if phase == "write" {
                let mut renderer = RendererStatus::default();
                renderer
                    .recent_events
                    .push(crate::runtime_status::StatusEvent {
                        target_id: "target".into(),
                        code: "test".into(),
                        message: "x".repeat(128 * 1024),
                    });
                publisher.publish_renderer(renderer);
            }
            let server = StatusServer::bind(&name, publisher).unwrap();
            let held_client = if phase == "listen" {
                None
            } else {
                let channel = channel(&name);
                if phase != "read" {
                    channel
                        .write_frame(REQUEST, Instant::now() + STATUS_QUERY_TIMEOUT)
                        .unwrap();
                }
                if phase == "ack" {
                    channel
                        .read_frame(
                            MAX_STATUS_RESPONSE_BYTES,
                            Instant::now() + STATUS_QUERY_TIMEOUT,
                        )
                        .unwrap();
                }
                Some(channel)
            };
            thread::sleep(Duration::from_millis(10));
            let start = Instant::now();
            drop(server);
            assert!(
                start.elapsed() < Duration::from_millis(500),
                "Drop hung in {phase}"
            );
            drop(held_client);
            assert_eq!(get(&name).status, StatusCode::NotRunning);
            drop(StatusServer::bind(&name, StatusPublisher::new()).unwrap());
        }
    }

    fn raw_server(name: &OsStr, serve: impl FnOnce(Channel) + Send + 'static) -> JoinHandle<()> {
        let channel = Channel {
            pipe: create_server_pipe(name).unwrap(),
            event: create_event().unwrap(),
            stop: Arc::new(create_event().unwrap()),
        };
        thread::spawn(move || {
            channel.connect().unwrap();
            serve(channel);
        })
    }

    #[test]
    fn client_distinguishes_timeout_incompatible_and_broken_responses() {
        for mode in ["timeout", "future", "oversize", "malformed", "pid_mismatch"] {
            let name = name();
            let worker = raw_server(&name, move |channel| {
                let deadline = Instant::now() + Duration::from_secs(2);
                channel
                    .read_frame(MAX_STATUS_REQUEST_BYTES, deadline)
                    .unwrap();
                if mode == "timeout" {
                    let mut byte = [0];
                    let _ = channel.read_exact(&mut byte, deadline);
                    return;
                }
                if mode == "oversize" {
                    channel
                        .write_all(&u32::MAX.to_le_bytes(), deadline)
                        .unwrap();
                } else {
                    let bytes = match mode {
                        "future" => br#"{"schema_version":42,"future_shape":{}}"#.to_vec(),
                        "pid_mismatch" => {
                            let mut snapshot = (*StatusPublisher::new().snapshot()).clone();
                            snapshot.host_pid = 1;
                            encode_response(&StatusReport {
                                schema_version: 1,
                                status: StatusCode::Running,
                                snapshot: Some(snapshot),
                                error: None,
                            })
                        }
                        _ => b"bad JSON".to_vec(),
                    };
                    channel.write_frame(&bytes, deadline).unwrap();
                }
                let mut ack = [0];
                let _ = channel.read_exact(&mut ack, deadline);
            });
            let start = Instant::now();
            let result = query(
                &name,
                &std::env::current_exe().unwrap(),
                Duration::from_millis(100),
            );
            let expected = match mode {
                "timeout" => StatusCode::Timeout,
                "future" => StatusCode::Incompatible,
                "pid_mismatch" => StatusCode::UntrustedServer,
                _ => StatusCode::CommunicationError,
            };
            assert_eq!(result.status, expected, "mode={mode}; {result:?}");
            worker.join().unwrap();
            assert!(start.elapsed() < Duration::from_secs(2));
        }
    }

    #[test]
    fn oversized_snapshot_returns_bounded_explicit_error() {
        let publisher = StatusPublisher::new();
        let mut renderer = RendererStatus::default();
        renderer
            .recent_events
            .push(crate::runtime_status::StatusEvent {
                target_id: "target".into(),
                code: "test".into(),
                message: "x".repeat(MAX_STATUS_RESPONSE_BYTES),
            });
        publisher.publish_renderer(renderer);
        let name = name();
        let _server = StatusServer::bind(&name, publisher).unwrap();
        assert_eq!(get(&name).status, StatusCode::SnapshotTooLarge);
    }
}
