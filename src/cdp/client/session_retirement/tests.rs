use super::*;
use crate::cdp::{TargetController, TargetError};
use serde_json::json;
use std::fs::File;

fn peer() -> (CdpClient, CdpEventStream, File, File) {
    let (reader, writer_peer) = super::super::tests::blocking_pipe_reader();
    let (writer, reader_peer) = super::super::tests::blocking_pipe_writer();
    let (client, events) = CdpClient::spawn_io(reader, writer, SpawnConfig::default()).unwrap();
    (
        client,
        events,
        File::from(reader_peer),
        File::from(writer_peer),
    )
}

fn receive(reader: &mut File, method: &str) -> Value {
    let mut bytes = Vec::new();
    loop {
        let mut byte = [0];
        reader.read_exact(&mut byte).unwrap();
        if byte[0] == 0 {
            break;
        }
        bytes.push(byte[0]);
    }
    let request: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(request["method"], method, "{request}");
    request
}

fn send(writer: &mut File, value: Value) {
    writer
        .write_all(&encode_json_frame(&value).unwrap())
        .unwrap();
    writer.flush().unwrap();
}

fn reply(writer: &mut File, request: &Value, result: Value) {
    let mut response = json!({"id":request["id"],"result":result});
    if let Some(session) = request.get("sessionId") {
        response["sessionId"] = session.clone();
    }
    send(writer, response);
}

fn wait_retired(client: &CdpClient, target: &str) {
    let until = Instant::now() + Duration::from_secs(2);
    while client.target_is_retiring(target) {
        assert!(Instant::now() < until, "session retirement did not settle");
        thread::sleep(Duration::from_millis(1));
    }
}

fn failed_initialization(method: &'static str) {
    let _serial = super::super::tests::SPAWN_TEST_LOCK.lock().unwrap();
    let (client, events, mut reader, mut writer) = peer();
    let healthy = client.track_session("healthy-target", "healthy-session");
    let remote = thread::spawn(move || {
        let discover = receive(&mut reader, "Target.setDiscoverTargets");
        reply(&mut writer, &discover, json!({}));
        let targets = receive(&mut reader, "Target.getTargets");
        reply(
            &mut writer,
            &targets,
            json!({"targetInfos":[{"targetId":"failed-target","type":"page","url":"app://-/index.html"}]}),
        );
        let attach = receive(&mut reader, "Target.attachToTarget");
        assert_eq!(attach["params"]["targetId"], "failed-target");
        reply(&mut writer, &attach, json!({"sessionId":"failed-session"}));
        let runtime = receive(&mut reader, "Runtime.enable");
        assert_eq!(runtime["sessionId"], "failed-session");
        let failed = if method == "Page.enable" {
            reply(&mut writer, &runtime, json!({}));
            receive(&mut reader, "Page.enable")
        } else {
            runtime
        };
        send(
            &mut writer,
            json!({"id":failed["id"],"sessionId":"failed-session","error":{"code":-32000,"message":"initialization_failed"}}),
        );
        let detach = receive(&mut reader, "Target.detachFromTarget");
        assert_eq!(detach["params"], json!({"sessionId":"failed-session"}));
        assert!(detach.get("sessionId").is_none());
        reply(&mut writer, &detach, json!({}));
        let ping = receive(&mut reader, "Fake.healthy");
        assert_eq!(ping["sessionId"], "healthy-session");
        reply(&mut writer, &ping, json!({"healthy":true}));
        // Stay connected until the test has checked the successful ACK. EOF is
        // not allowed to provide the retirement proof instead.
        let finish = receive(&mut reader, "Fake.finish");
        reply(&mut writer, &finish, json!({}));
    });
    let error = match TargetController::discover(client.clone(), events, Duration::from_secs(2)) {
        Err(error) => error,
        Ok(_) => panic!("initialization unexpectedly succeeded"),
    };
    assert!(
        matches!(error, TargetError::Client(ClientError::Remote { method: ref actual, error_code: -32000, ref message, .. }) if actual == method && message == "initialization_failed")
    );
    assert_eq!(
        client
            .request(
                "Fake.healthy",
                None,
                Some("healthy-session"),
                Duration::from_secs(2)
            )
            .unwrap()
            .result,
        Some(json!({"healthy":true}))
    );
    assert!(healthy.load(Ordering::Acquire));
    assert!(client.closed_reason().is_none());
    let state = client.inner.runtime.shared.state.lock().unwrap();
    assert!(state.retiring_sessions.is_empty());
    assert!(state.retirement_requests.is_empty());
    assert!(state.pending.is_empty());
    drop(state);
    client
        .request("Fake.finish", None, None, Duration::from_secs(2))
        .unwrap();
    client.shutdown().unwrap();
    remote.join().unwrap();
}

#[test]
fn runtime_enable_failure_retires_the_acknowledged_session_and_preserves_error() {
    failed_initialization("Runtime.enable");
}

#[test]
fn page_enable_failure_retires_the_acknowledged_session_and_preserves_error() {
    failed_initialization("Page.enable");
}

fn aborted_discovery(already_ended: bool) {
    let _serial = super::super::tests::SPAWN_TEST_LOCK.lock().unwrap();
    let (client, events, mut reader, mut writer) = peer();
    let healthy = client.track_session("other-owner", "healthy-session");
    let remote = thread::spawn(move || {
        let discover = receive(&mut reader, "Target.setDiscoverTargets");
        reply(&mut writer, &discover, json!({}));
        let targets = receive(&mut reader, "Target.getTargets");
        reply(
            &mut writer,
            &targets,
            json!({"targetInfos":[
                {"targetId":"first","type":"page","url":"app://-/index.html"},
                {"targetId":"second","type":"page","url":"app://-/index.html"}
            ]}),
        );
        let first = receive(&mut reader, "Target.attachToTarget");
        reply(&mut writer, &first, json!({"sessionId":"first-session"}));
        let runtime = receive(&mut reader, "Runtime.enable");
        reply(&mut writer, &runtime, json!({}));
        let page = receive(&mut reader, "Page.enable");
        reply(&mut writer, &page, json!({}));
        let second = receive(&mut reader, "Target.attachToTarget");
        reply(&mut writer, &second, json!({"sessionId":"second-session"}));
        let runtime = receive(&mut reader, "Runtime.enable");
        if already_ended {
            send(
                &mut writer,
                json!({"method":"Target.detachedFromTarget","params":{"sessionId":"first-session"}}),
            );
        }
        send(
            &mut writer,
            json!({"id":runtime["id"],"sessionId":"second-session","error":{"code":-32000,"message":"initialization_failed"}}),
        );
        let mut sessions = Vec::new();
        for _ in 0..if already_ended { 1 } else { 2 } {
            let detach = receive(&mut reader, "Target.detachFromTarget");
            sessions.push(detach["params"]["sessionId"].as_str().unwrap().to_owned());
            reply(&mut writer, &detach, json!({}));
        }
        sessions.sort();
        if already_ended {
            assert_eq!(sessions, ["second-session"]);
        } else {
            assert_eq!(sessions, ["first-session", "second-session"]);
        }
        let ping = receive(&mut reader, "Fake.healthy");
        reply(&mut writer, &ping, json!({}));
        let finish = receive(&mut reader, "Fake.finish");
        reply(&mut writer, &finish, json!({}));
    });
    let result = TargetController::discover(client.clone(), events, Duration::from_secs(2));
    assert!(
        matches!(result, Err(TargetError::Client(ClientError::Remote { ref method, error_code: -32000, .. })) if method == "Runtime.enable")
    );
    client
        .request(
            "Fake.healthy",
            None,
            Some("healthy-session"),
            Duration::from_secs(2),
        )
        .unwrap();
    assert!(healthy.load(Ordering::Acquire));
    assert!(client.closed_reason().is_none());
    {
        let state = client.inner.runtime.shared.state.lock().unwrap();
        assert!(state.retiring_sessions.is_empty());
        assert!(state.retirement_requests.is_empty());
        assert!(state.pending.is_empty());
    }
    client
        .request("Fake.finish", None, None, Duration::from_secs(2))
        .unwrap();
    client.shutdown().unwrap();
    remote.join().unwrap();
}

#[test]
fn aborted_discovery_retires_undelivered_siblings_but_not_ended_or_external_owners() {
    aborted_discovery(false);
    aborted_discovery(true);
}

#[test]
fn runtime_timeout_preserves_the_original_error_and_detaches_without_replaying_enable() {
    let _serial = super::super::tests::SPAWN_TEST_LOCK.lock().unwrap();
    let (client, events, mut reader, mut writer) = peer();
    #[cfg(feature = "desktop-acceptance")]
    let transport_events = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
    #[cfg(feature = "desktop-acceptance")]
    {
        let recorded = Arc::clone(&transport_events);
        client.set_acceptance_trace(Some(Arc::new(move |event, details| {
            recorded.lock().unwrap().push((event.to_owned(), details));
        })));
    }
    let remote = thread::spawn(move || {
        let discover = receive(&mut reader, "Target.setDiscoverTargets");
        reply(&mut writer, &discover, json!({}));
        let targets = receive(&mut reader, "Target.getTargets");
        reply(
            &mut writer,
            &targets,
            json!({"targetInfos":[{"targetId":"failed-target","type":"page","url":"app://-/index.html"}]}),
        );
        let attach = receive(&mut reader, "Target.attachToTarget");
        reply(&mut writer, &attach, json!({"sessionId":"failed-session"}));
        let runtime = receive(&mut reader, "Runtime.enable");
        // Its original request remains unanswered until discovery's one shared
        // budget expires. The next frame must be detach, never another enable.
        let detach = receive(&mut reader, "Target.detachFromTarget");
        reply(&mut writer, &runtime, json!({}));
        reply(&mut writer, &detach, json!({}));
        let ping = receive(&mut reader, "Fake.healthy");
        reply(&mut writer, &ping, json!({}));
        let finish = receive(&mut reader, "Fake.finish");
        reply(&mut writer, &finish, json!({}));
    });
    let result = TargetController::discover(client.clone(), events, Duration::from_secs(1));
    assert!(
        matches!(result, Err(TargetError::Client(ClientError::RequestTimedOut { id: 4, ref method })) if method == "Runtime.enable")
    );
    client
        .request("Fake.healthy", None, None, Duration::from_secs(2))
        .unwrap();
    assert!(!client.target_is_retiring("failed-target"));
    assert!(client.closed_reason().is_none());
    assert!(
        client
            .inner
            .runtime
            .shared
            .state
            .lock()
            .unwrap()
            .pending
            .is_empty()
    );
    #[cfg(feature = "desktop-acceptance")]
    {
        let recorded = transport_events.lock().unwrap();
        for event in [
            "transport.enqueue",
            "transport.written",
            "transport.expiry",
            "transport.response",
        ] {
            assert!(
                recorded.iter().any(|(name, value)| name == event
                    && value["id"] == 4
                    && value["sessionId"] == "failed-session"
                    && value["targetId"] == "failed-target"),
                "missing {event}: {recorded:?}"
            );
        }
        assert!(
            recorded
                .iter()
                .any(|(name, value)| name == "transport.response"
                    && value["id"] == 3
                    && value["attachedSessionId"] == "failed-session")
        );
    }
    client
        .request("Fake.finish", None, None, Duration::from_secs(2))
        .unwrap();
    client.shutdown().unwrap();
    remote.join().unwrap();
}

#[test]
fn late_detach_ack_settles_the_original_owner_without_replay_or_other_session_loss() {
    let _serial = super::super::tests::SPAWN_TEST_LOCK.lock().unwrap();
    let (client, _events, mut reader, mut writer) = peer();
    let healthy = client.track_session("healthy-target", "healthy-session");
    let failed = client.track_session("failed-target", "failed-session");
    let weak = Arc::downgrade(&failed);
    let (received, receipt) = mpsc::channel();
    let (allow_ack, ack) = mpsc::channel();
    let remote = thread::spawn(move || {
        let detach = receive(&mut reader, "Target.detachFromTarget");
        received.send(detach["id"].as_u64().unwrap()).unwrap();
        let ping = receive(&mut reader, "Fake.healthy");
        reply(&mut writer, &ping, json!({}));
        ack.recv().unwrap();
        reply(&mut writer, &detach, json!({}));
        let finish = receive(&mut reader, "Fake.finish");
        reply(&mut writer, &finish, json!({}));
    });
    client.retire_failed_session(
        "failed-target",
        "failed-session",
        &failed,
        Duration::from_millis(30),
    );
    let id = receipt.recv_timeout(Duration::from_secs(2)).unwrap();
    // A duplicate failure must not create another cleanup request.
    client.retire_failed_session(
        "failed-target",
        "failed-session",
        &failed,
        Duration::from_secs(2),
    );
    drop(failed);
    thread::sleep(Duration::from_millis(40));
    assert!(client.closed_reason().is_none());
    {
        let state = client.inner.runtime.shared.state.lock().unwrap();
        assert_eq!(
            state.retiring_sessions["failed-session"].phase,
            "unknown_receipt"
        );
        assert_eq!(
            state.retiring_sessions["failed-session"].request_id,
            Some(id)
        );
        assert_eq!(
            state.retirement_requests.get(&id).map(String::as_str),
            Some("failed-session")
        );
        assert!(state.pending.is_empty());
    }
    assert!(
        weak.upgrade().is_some(),
        "the unresolved owner must retain its actual session"
    );
    client
        .request(
            "Fake.healthy",
            None,
            Some("healthy-session"),
            Duration::from_secs(2),
        )
        .unwrap();
    assert!(healthy.load(Ordering::Acquire));
    allow_ack.send(()).unwrap();
    wait_retired(&client, "failed-target");
    assert!(weak.upgrade().is_none());
    assert!(
        client
            .inner
            .runtime
            .shared
            .state
            .lock()
            .unwrap()
            .pending
            .is_empty()
    );
    client
        .request("Fake.finish", None, None, Duration::from_secs(2))
        .unwrap();
    client.shutdown().unwrap();
    remote.join().unwrap();
}

#[test]
fn teardown_or_connection_end_during_owner_publication_cannot_leave_an_entry() {
    let _serial = super::super::tests::SPAWN_TEST_LOCK.lock().unwrap();
    for closed in [false, true] {
        let (reader, _remote_writer) = super::super::tests::blocking_pipe_reader();
        let (client, _events) =
            CdpClient::spawn_io(reader, io::sink(), SpawnConfig::default()).unwrap();
        let failed = client.track_session("failed-target", "failed-session");
        let weak = Arc::downgrade(&failed);
        // Publication precedes enqueue. Freeze the issuer to deterministically
        // deliver teardown in that exact interval.
        let issuer = client.inner.next_id.lock().unwrap();
        let retiring = client.clone();
        let worker = thread::spawn(move || {
            retiring.retire_failed_session(
                "failed-target",
                "failed-session",
                &failed,
                Duration::from_secs(2),
            )
        });
        let until = Instant::now() + Duration::from_secs(2);
        while !client.target_is_retiring("failed-target") {
            assert!(Instant::now() < until);
            thread::yield_now();
        }
        if closed {
            client.inner.runtime.stop(Arc::new(ConnectionError::Eof));
        } else {
            route_message(&client.inner.runtime.shared, json!({"method":"Target.detachedFromTarget","params":{"sessionId":"failed-session"}})).unwrap();
        }
        drop(issuer);
        worker.join().unwrap();
        let state = client.inner.runtime.shared.state.lock().unwrap();
        assert!(state.retiring_sessions.is_empty());
        assert!(state.retirement_requests.is_empty());
        assert!(state.pending.is_empty());
        assert_eq!(state.last_issued_id, 0);
        drop(state);
        assert!(weak.upgrade().is_none());
        client.shutdown().unwrap();
    }
}

#[test]
fn expired_before_enqueue_retains_the_session_until_actual_teardown() {
    let _serial = super::super::tests::SPAWN_TEST_LOCK.lock().unwrap();
    let (reader, _remote_writer) = super::super::tests::blocking_pipe_reader();
    let (client, _events) =
        CdpClient::spawn_io(reader, io::sink(), SpawnConfig::default()).unwrap();
    let failed = client.track_session("failed-target", "failed-session");
    client.retire_failed_session("failed-target", "failed-session", &failed, Duration::ZERO);
    drop(failed);
    {
        let state = client.inner.runtime.shared.state.lock().unwrap();
        assert_eq!(
            state.retiring_sessions["failed-session"].phase,
            "unknown_not_dispatched"
        );
        assert_eq!(state.last_issued_id, 0);
        assert!(state.pending.is_empty());
        assert!(state.retirement_requests.is_empty());
    }
    assert!(client.closed_reason().is_none());
    route_message(
        &client.inner.runtime.shared,
        json!({"method":"Target.targetDestroyed","params":{"targetId":"failed-target"}}),
    )
    .unwrap();
    assert!(!client.target_is_retiring("failed-target"));
    client.shutdown().unwrap();
}

struct GateWriter {
    writer: File,
    entered: Option<mpsc::Sender<()>>,
    release: mpsc::Receiver<()>,
}

impl Write for GateWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if let Some(entered) = self.entered.take() {
            entered.send(()).unwrap();
            self.release.recv().unwrap();
        }
        self.writer.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }
}

#[test]
fn queued_retirement_expiry_skips_only_its_frame_and_keeps_the_owner() {
    let _serial = super::super::tests::SPAWN_TEST_LOCK.lock().unwrap();
    let (reader, writer_peer) = super::super::tests::blocking_pipe_reader();
    let (writer, reader_peer) = super::super::tests::blocking_pipe_writer();
    let (entered, blocked) = mpsc::channel();
    let (release, gate) = mpsc::channel();
    let (client, _events) = CdpClient::spawn_io(
        reader,
        GateWriter {
            writer,
            entered: Some(entered),
            release: gate,
        },
        SpawnConfig::default(),
    )
    .unwrap();
    let mut reader = File::from(reader_peer);
    let mut writer = File::from(writer_peer);
    let (allow_end, end) = mpsc::channel();
    let remote = thread::spawn(move || {
        let first = receive(&mut reader, "Fake.blocked");
        reply(&mut writer, &first, json!({}));
        // The expired cleanup frame must never enter the pipe.
        let healthy = receive(&mut reader, "Fake.healthy");
        reply(&mut writer, &healthy, json!({}));
        end.recv().unwrap();
        send(
            &mut writer,
            json!({"method":"Target.detachedFromTarget","params":{"sessionId":"failed-session"}}),
        );
        let finish = receive(&mut reader, "Fake.finish");
        reply(&mut writer, &finish, json!({}));
    });
    let first = client.clone();
    let request = thread::spawn(move || {
        first
            .request("Fake.blocked", None, None, Duration::from_secs(2))
            .unwrap()
    });
    blocked.recv_timeout(Duration::from_secs(2)).unwrap();
    let failed = client.track_session("failed-target", "failed-session");
    let mut plugin_requests = Vec::new();
    for _ in 0..16 {
        plugin_requests.push(
            client
                .begin_raw_request(
                    "Fake.cancelled-plugin",
                    None,
                    None,
                    Instant::now() + Duration::from_secs(2),
                )
                .unwrap(),
        );
    }
    assert!(matches!(
        client.begin_raw_request(
            "Fake.plugin-overflow",
            None,
            None,
            Instant::now() + Duration::from_secs(2)
        ),
        Err(ClientError::RequestQueueFull)
    ));
    client.retire_failed_session(
        "failed-target",
        "failed-session",
        &failed,
        Duration::from_millis(20),
    );
    {
        let state = client.inner.runtime.shared.state.lock().unwrap();
        assert_eq!(state.retiring_sessions["failed-session"].phase, "queued");
        assert!(
            state.retiring_sessions["failed-session"]
                .request_id
                .is_some()
        );
        assert_eq!(client.inner.raw_writes.load(Ordering::Acquire), 16);
    }
    drop(failed);
    // Cleanup was admitted while the plugin queue was full. Cancel the plugin
    // frames before releasing the writer; they must never reach the Native peer.
    drop(plugin_requests);
    thread::sleep(Duration::from_millis(30));
    release.send(()).unwrap();
    request.join().unwrap();
    client
        .request("Fake.healthy", None, None, Duration::from_secs(2))
        .unwrap();
    {
        let state = client.inner.runtime.shared.state.lock().unwrap();
        assert_eq!(
            state.retiring_sessions["failed-session"].phase,
            "unknown_not_written"
        );
        assert!(state.retirement_requests.is_empty());
        assert!(state.pending.is_empty());
    }
    assert!(client.closed_reason().is_none());
    allow_end.send(()).unwrap();
    wait_retired(&client, "failed-target");
    client
        .request("Fake.finish", None, None, Duration::from_secs(2))
        .unwrap();
    client.shutdown().unwrap();
    remote.join().unwrap();
}

#[test]
fn detach_remote_error_remains_unknown_until_exact_session_teardown() {
    let _serial = super::super::tests::SPAWN_TEST_LOCK.lock().unwrap();
    let (client, _events, mut reader, mut writer) = peer();
    let healthy = client.track_session("healthy-target", "healthy-session");
    let failed = client.track_session("failed-target", "failed-session");
    let remote = thread::spawn(move || {
        let detach = receive(&mut reader, "Target.detachFromTarget");
        send(
            &mut writer,
            json!({"id":detach["id"],"error":{"code":-32000,"message":"detach_failed"}}),
        );
        let healthy = receive(&mut reader, "Fake.healthy");
        reply(&mut writer, &healthy, json!({}));
        let finish = receive(&mut reader, "Fake.finish");
        reply(&mut writer, &finish, json!({}));
    });
    client.retire_failed_session(
        "failed-target",
        "failed-session",
        &failed,
        Duration::from_secs(2),
    );
    client
        .request(
            "Fake.healthy",
            None,
            Some("healthy-session"),
            Duration::from_secs(2),
        )
        .unwrap();
    assert_eq!(
        client
            .inner
            .runtime
            .shared
            .state
            .lock()
            .unwrap()
            .retiring_sessions["failed-session"]
            .phase,
        "unknown_detach_failed"
    );
    route_message(
        &client.inner.runtime.shared,
        json!({"method":"Target.detachedFromTarget","params":{"sessionId":"other-session"}}),
    )
    .unwrap();
    assert!(client.target_is_retiring("failed-target"));
    route_message(
        &client.inner.runtime.shared,
        json!({"method":"Target.detachedFromTarget","params":{"sessionId":"failed-session"}}),
    )
    .unwrap();
    assert!(!client.target_is_retiring("failed-target"));
    assert!(healthy.load(Ordering::Acquire));
    assert!(client.closed_reason().is_none());
    client
        .request("Fake.finish", None, None, Duration::from_secs(2))
        .unwrap();
    client.shutdown().unwrap();
    remote.join().unwrap();
}

struct ObservedPipeWriter {
    writer: File,
    started: Option<mpsc::Sender<u32>>,
    returned: Arc<AtomicBool>,
}

impl Write for ObservedPipeWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if let Some(started) = self.started.take() {
            // SAFETY: GetCurrentThreadId has no preconditions.
            started
                .send(unsafe { windows_sys::Win32::System::Threading::GetCurrentThreadId() })
                .unwrap();
        }
        let result = self.writer.write(bytes);
        self.returned.store(true, Ordering::Release);
        result
    }
    fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }
}

#[test]
fn shutdown_cancels_and_reaps_a_retirement_write_confirmed_pending_by_windows() {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::System::Pipes::{GetNamedPipeInfo, PeekNamedPipe};
    use windows_sys::Win32::System::Threading::{
        GetThreadIOPendingFlag, OpenThread, THREAD_QUERY_INFORMATION,
    };
    let _serial = super::super::tests::SPAWN_TEST_LOCK.lock().unwrap();
    let (reader, _input_open) = super::super::tests::blocking_pipe_reader();
    let (mut writer, remote_reader) = super::super::tests::blocking_pipe_writer();
    let mut quota = 0;
    // SAFETY: this live owned anonymous pipe handle supports pipe information;
    // quota points to initialized writable storage, other outputs are optional.
    assert_ne!(
        unsafe {
            GetNamedPipeInfo(
                writer.as_raw_handle(),
                std::ptr::null_mut(),
                &mut quota,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        },
        0
    );
    assert!(quota > 0);
    writer.write_all(&vec![0; quota as usize]).unwrap();
    let mut available = 0;
    // SAFETY: the retained read end is live. No data is consumed by this peek.
    assert_ne!(
        unsafe {
            PeekNamedPipe(
                remote_reader.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        },
        0
    );
    assert_eq!(available, quota);
    let returned = Arc::new(AtomicBool::new(false));
    let (started, entering) = mpsc::channel();
    let (client, _events) = CdpClient::spawn_io(
        reader,
        ObservedPipeWriter {
            writer,
            started: Some(started),
            returned: Arc::clone(&returned),
        },
        SpawnConfig::default(),
    )
    .unwrap();
    let failed = client.track_session("failed-target", "failed-session");
    let weak = Arc::downgrade(&failed);
    client.retire_failed_session(
        "failed-target",
        "failed-session",
        &failed,
        Duration::from_secs(1),
    );
    drop(failed);
    let thread_id = entering.recv_timeout(Duration::from_secs(2)).unwrap();
    // SAFETY: the writer supplied its actual live thread ID. This call returns a
    // new query-only handle, transferred to OwnedHandle after checking success.
    let query = unsafe { OpenThread(THREAD_QUERY_INFORMATION, 0, thread_id) };
    assert!(!query.is_null());
    // SAFETY: OpenThread returned a new non-null owned thread handle.
    let query = unsafe { OwnedHandle::from_raw_handle(query) };
    let query_pending = || {
        let mut pending = 0;
        // SAFETY: query owns a live writer-thread handle and pending is writable.
        assert_ne!(
            unsafe { GetThreadIOPendingFlag(query.as_raw_handle(), &mut pending) },
            0
        );
        pending != 0
    };
    let until = Instant::now() + Duration::from_secs(2);
    while !query_pending() {
        assert!(
            Instant::now() < until,
            "Windows did not confirm the writer's pending I/O"
        );
        thread::yield_now();
    }
    assert!(!returned.load(Ordering::Acquire));
    let expires_at = client
        .inner
        .runtime
        .shared
        .state
        .lock()
        .unwrap()
        .retiring_sessions["failed-session"]
        .expires_at
        .unwrap();
    while Instant::now() < expires_at {
        thread::yield_now();
    }
    assert!(
        query_pending(),
        "the exact pipe write must remain pending until shutdown"
    );
    assert!(
        client.closed_reason().is_none(),
        "a cleanup observation expiry must not close the transport"
    );
    assert_eq!(
        client
            .inner
            .runtime
            .shared
            .state
            .lock()
            .unwrap()
            .retiring_sessions["failed-session"]
            .phase,
        "unknown_writing"
    );
    assert!(weak.upgrade().is_some());
    client.shutdown().unwrap();
    assert!(
        returned.load(Ordering::Acquire),
        "shutdown must return from the actual blocked WriteFile"
    );
    assert!(weak.upgrade().is_none());
    let state = client.inner.runtime.shared.state.lock().unwrap();
    assert!(state.retiring_sessions.is_empty());
    assert!(state.retirement_requests.is_empty());
    assert!(state.pending.is_empty());
    drop(state);
    TEST_WORKERS.with(|counts| {
        assert_eq!(counts.readers.load(Ordering::SeqCst), 0);
        assert_eq!(counts.writers.load(Ordering::SeqCst), 0);
    });
}
