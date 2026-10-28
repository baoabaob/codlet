use super::*;
use crate::plugins::PluginRegistry;
use crate::renderer::RendererRuntime;

fn renderer() -> (tempfile::TempDir, RendererRuntime) {
    let directory = tempfile::tempdir().unwrap();
    let registry = PluginRegistry::load(directory.path().join("config.json")).unwrap();
    let renderer = RendererRuntime::bundled(registry).unwrap();
    (directory, renderer)
}

fn query_and_attach(reader: &mut File, writer: &mut File, session: &str) {
    let discover = receive(reader, "Target.setDiscoverTargets");
    reply(writer, &discover, json!({}));
    let targets = receive(reader, "Target.getTargets");
    reply(
        writer,
        &targets,
        json!({"targetInfos":[
            {"targetId":"main","type":"page","url":"app://-/index.html"}
        ]}),
    );
    let attach = receive(reader, "Target.attachToTarget");
    assert_eq!(attach["params"]["targetId"], "main");
    reply(writer, &attach, json!({"sessionId":session}));
}

fn enable(reader: &mut File, writer: &mut File, session: &str) {
    for method in ["Runtime.enable", "Page.enable"] {
        let request = receive(reader, method);
        assert_eq!(request["sessionId"], session);
        reply(writer, &request, json!({}));
    }
}

fn finish(client: &CdpClient, remote: thread::JoinHandle<()>) {
    client
        .request("Fake.finish", None, None, Duration::from_secs(2))
        .unwrap();
    client.shutdown().unwrap();
    remote.join().unwrap();
}

fn assert_no_frame(reader: &File) {
    use std::os::windows::io::AsRawHandle;
    let mut available = 0;
    // SAFETY: the live pipe read end is retained; PeekNamedPipe consumes no data.
    assert_ne!(
        unsafe {
            windows_sys::Win32::System::Pipes::PeekNamedPipe(
                reader.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        },
        0
    );
    assert_eq!(
        available, 0,
        "an unconfirmed session must block rediscovery"
    );
}

fn recovers_only_after_confirmation(method: &'static str, ended_event: bool) {
    let _serial = super::super::super::tests::SPAWN_TEST_LOCK.lock().unwrap();
    let (client, events, mut reader, mut writer) = peer();
    let healthy = client.track_session("external", "healthy");
    let (retiring, retired) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let remote = thread::spawn(move || {
        query_and_attach(&mut reader, &mut writer, "first");
        let runtime = receive(&mut reader, "Runtime.enable");
        let failed = if method == "Page.enable" {
            reply(&mut writer, &runtime, json!({}));
            receive(&mut reader, "Page.enable")
        } else {
            runtime
        };
        let detach = receive(&mut reader, "Target.detachFromTarget");
        assert_eq!(detach["params"]["sessionId"], "first");
        retiring.send(()).unwrap();
        released.recv().unwrap();
        assert_no_frame(&reader);
        // A late enable response must not replace the detach confirmation.
        reply(&mut writer, &failed, json!({}));
        if ended_event {
            send(
                &mut writer,
                json!({"method":"Target.detachedFromTarget","params":{"sessionId":"first"}}),
            );
        } else {
            reply(&mut writer, &detach, json!({}));
        }
        query_and_attach(&mut reader, &mut writer, "second");
        enable(&mut reader, &mut writer, "second");
        // A duplicate ACK or old teardown cannot retire the new session.
        reply(&mut writer, &detach, json!({}));
        send(
            &mut writer,
            json!({"method":"Target.detachedFromTarget","params":{"sessionId":"first"}}),
        );
        let ping = receive(&mut reader, "Fake.healthy");
        assert_eq!(ping["sessionId"], "healthy");
        reply(&mut writer, &ping, json!({}));
        let finish = receive(&mut reader, "Fake.finish");
        reply(&mut writer, &finish, json!({}));
    });
    let (directory, mut renderer) = renderer();
    let before = std::fs::read(directory.path().join("config.json")).ok();
    let release = Mutex::new(Some(release));
    let gate_client = client.clone();
    let (targets, sessions) = crate::probe::discover_runtime_targets_for_test(
        &mut renderer,
        client.clone(),
        events,
        Duration::from_millis(500),
        || {
            if let Some(release) = release.lock().unwrap().take() {
                retired.recv_timeout(Duration::from_secs(2)).unwrap();
                let state = gate_client.inner.runtime.shared.state.lock().unwrap();
                assert!(state.retiring_sessions.contains_key("first"));
                assert!(state.pending.is_empty());
                drop(state);
                release.send(()).unwrap();
            }
            true
        },
    );
    assert!(targets.is_some());
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session_id(), "second");
    client
        .request(
            "Fake.healthy",
            None,
            Some("healthy"),
            Duration::from_secs(2),
        )
        .unwrap();
    assert!(sessions[0].is_live());
    assert!(healthy.load(Ordering::Acquire));
    assert_eq!(
        std::fs::read(directory.path().join("config.json")).ok(),
        before
    );
    let state = client.inner.runtime.shared.state.lock().unwrap();
    assert!(state.retiring_sessions.is_empty());
    assert!(state.retirement_requests.is_empty());
    assert!(state.pending.is_empty());
    drop(state);
    finish(&client, remote);
}

#[test]
fn initial_runtime_timeout_recovers_after_exact_detach_ack() {
    recovers_only_after_confirmation("Runtime.enable", false);
}

#[test]
fn initial_page_timeout_recovers_after_exact_session_ended() {
    recovers_only_after_confirmation("Page.enable", true);
}

#[test]
fn missing_or_failed_retirement_never_grants_recovery() {
    let _serial = super::super::super::tests::SPAWN_TEST_LOCK.lock().unwrap();
    for remote_error in [false, true] {
        let (client, events, mut reader, mut writer) = peer();
        let remote = thread::spawn(move || {
            query_and_attach(&mut reader, &mut writer, "first");
            let runtime = receive(&mut reader, "Runtime.enable");
            let detach = receive(&mut reader, "Target.detachFromTarget");
            // The timed-out enable's late success is not a detach receipt.
            reply(&mut writer, &runtime, json!({}));
            if remote_error {
                send(
                    &mut writer,
                    json!({"id":detach["id"],"error":{"code":-32000,"message":"detach_failed"}}),
                );
            }
            send(
                &mut writer,
                json!({"method":"Target.detachedFromTarget","params":{"sessionId":"unrelated"}}),
            );
            // The original failure must return with no second discovery frame.
            let finish = receive(&mut reader, "Fake.finish");
            reply(&mut writer, &finish, json!({}));
        });
        let (_directory, mut renderer) = renderer();
        let status = crate::runtime_status::StatusPublisher::new();
        renderer.set_status_publisher(status.clone());
        let (targets, sessions) = crate::probe::discover_runtime_targets_for_test(
            &mut renderer,
            client.clone(),
            events,
            Duration::from_millis(100),
            || true,
        );
        assert!(targets.is_none());
        assert!(sessions.is_empty());
        assert!(client.target_is_retiring("main"));
        assert!(client.closed_reason().is_none());
        assert!(
            status
                .snapshot()
                .renderer
                .recent_events
                .iter()
                .any(|event| event.code == "renderer_executor_unavailable"
                    && event.message.contains("Runtime.enable")
                    && event.message.contains("exceeded its deadline"))
        );
        finish(&client, remote);
    }
}

#[test]
fn map_absence_and_connection_end_are_not_retirement_proofs() {
    let _serial = super::super::super::tests::SPAWN_TEST_LOCK.lock().unwrap();
    let (client, _events, _reader, _writer) = peer();
    let live = client.track_session("main", "first");
    let retirement = client.session_retirement("first", &live);
    assert!(!client.target_is_retiring("main"));
    assert!(
        !client.wait_for_session_retirements(std::slice::from_ref(&retirement), Instant::now())
    );
    client.retire_failed_session("main", "first", &live, Duration::from_secs(2));
    client.inner.runtime.stop(Arc::new(ConnectionError::Eof));
    assert!(!client.target_is_retiring("main"));
    assert!(
        !client
            .wait_for_session_retirements(&[retirement], Instant::now() + Duration::from_secs(1))
    );
    client.shutdown().unwrap();
}

#[test]
fn native_exit_during_retirement_wait_stops_before_new_discovery() {
    let _serial = super::super::super::tests::SPAWN_TEST_LOCK.lock().unwrap();
    let (client, events, mut reader, mut writer) = peer();
    let (ended, end) = mpsc::channel();
    let remote = thread::spawn(move || {
        query_and_attach(&mut reader, &mut writer, "first");
        let _runtime = receive(&mut reader, "Runtime.enable");
        let detach = receive(&mut reader, "Target.detachFromTarget");
        ended.send(()).unwrap();
        // Keep the connection and pending detach open after the Native owner
        // dies: pipe liveness alone must not authorize another attachment.
        let finish = receive(&mut reader, "Fake.finish");
        reply(&mut writer, &finish, json!({}));
        assert_eq!(detach["params"]["sessionId"], "first");
    });
    let (_directory, mut renderer) = renderer();
    let (targets, sessions) = crate::probe::discover_runtime_targets_for_test(
        &mut renderer,
        client.clone(),
        events,
        Duration::from_millis(100),
        || {
            end.recv_timeout(Duration::from_secs(2)).unwrap();
            false
        },
    );
    assert!(targets.is_none());
    assert!(sessions.is_empty());
    assert!(client.closed_reason().is_none());
    assert!(client.target_is_retiring("main"));
    finish(&client, remote);
}

#[test]
fn exited_original_child_blocks_recovery_even_with_an_open_cdp_connection() {
    let _serial = super::super::super::tests::SPAWN_TEST_LOCK.lock().unwrap();
    let runtime = crate::js_runtime::JsRuntime::discover().unwrap();
    let (child, unused_pipes) = crate::windows::process::launch_with_cdp_pipes(
        runtime.executable_path(),
        // The real launcher appends Native CDP flags. Keep them in script argv,
        // rather than treating them as Node options or a shell command suffix.
        &["--eval".into(), "process.exit(0)".into(), "--".into()],
        true,
    )
    .unwrap();
    assert_eq!(child.wait(Duration::from_secs(5)).unwrap(), Some(0));
    drop(unused_pipes);
    let (client, events, mut reader, mut writer) = peer();
    let remote = thread::spawn(move || {
        query_and_attach(&mut reader, &mut writer, "first");
        let _runtime = receive(&mut reader, "Runtime.enable");
        let detach = receive(&mut reader, "Target.detachFromTarget");
        reply(&mut writer, &detach, json!({}));
        let finish = receive(&mut reader, "Fake.finish");
        reply(&mut writer, &finish, json!({}));
    });
    let (_directory, mut renderer) = renderer();
    let (targets, sessions) = crate::probe::discover_runtime_targets_for_test(
        &mut renderer,
        client.clone(),
        events,
        Duration::from_millis(100),
        || child.wait(Duration::ZERO).unwrap().is_none(),
    );
    assert!(targets.is_none());
    assert!(sessions.is_empty());
    assert!(client.closed_reason().is_none());
    finish(&client, remote);
}

#[test]
fn owner_exit_after_new_enable_acks_retires_the_unpublished_session() {
    let _serial = super::super::super::tests::SPAWN_TEST_LOCK.lock().unwrap();
    let (client, events, mut reader, mut writer) = peer();
    let owner_live = Arc::new(AtomicBool::new(true));
    let remote_live = Arc::clone(&owner_live);
    let remote = thread::spawn(move || {
        query_and_attach(&mut reader, &mut writer, "first");
        let _runtime = receive(&mut reader, "Runtime.enable");
        let detach = receive(&mut reader, "Target.detachFromTarget");
        reply(&mut writer, &detach, json!({}));
        query_and_attach(&mut reader, &mut writer, "second");
        let runtime = receive(&mut reader, "Runtime.enable");
        reply(&mut writer, &runtime, json!({}));
        let page = receive(&mut reader, "Page.enable");
        // The owner's exit is causally before the final successful CDP ACK.
        remote_live.store(false, Ordering::Release);
        reply(&mut writer, &page, json!({}));
        let detach = receive(&mut reader, "Target.detachFromTarget");
        assert_eq!(detach["params"]["sessionId"], "second");
        reply(&mut writer, &detach, json!({}));
        let finish = receive(&mut reader, "Fake.finish");
        reply(&mut writer, &finish, json!({}));
    });
    let (_directory, mut renderer) = renderer();
    let (targets, sessions) = crate::probe::discover_runtime_targets_for_test(
        &mut renderer,
        client.clone(),
        events,
        Duration::from_millis(100),
        || owner_live.load(Ordering::Acquire),
    );
    assert!(targets.is_none());
    assert!(sessions.is_empty());
    assert!(client.closed_reason().is_none());
    finish(&client, remote);
    let state = client.inner.runtime.shared.state.lock().unwrap();
    assert!(state.retiring_sessions.is_empty());
    assert!(state.pending.is_empty());
}

#[test]
fn connection_close_while_retiring_cannot_start_another_discovery() {
    let _serial = super::super::super::tests::SPAWN_TEST_LOCK.lock().unwrap();
    let (client, events, mut reader, mut writer) = peer();
    let remote = thread::spawn(move || {
        query_and_attach(&mut reader, &mut writer, "first");
        let _runtime = receive(&mut reader, "Runtime.enable");
        let detach = receive(&mut reader, "Target.detachFromTarget");
        assert_eq!(detach["params"]["sessionId"], "first");
        // EOF is an owner-release event, not a confirmed reusable session.
    });
    let (_directory, mut renderer) = renderer();
    let (targets, sessions) = crate::probe::discover_runtime_targets_for_test(
        &mut renderer,
        client.clone(),
        events,
        Duration::from_millis(100),
        || true,
    );
    assert!(targets.is_none());
    assert!(sessions.is_empty());
    remote.join().unwrap();
    client.shutdown().unwrap();
    let state = client.inner.runtime.shared.state.lock().unwrap();
    assert_eq!(state.last_issued_id, 5);
    assert!(state.retiring_sessions.is_empty());
    assert!(state.retirement_requests.is_empty());
    assert!(state.pending.is_empty());
}

#[test]
fn enable_remote_error_remains_terminal_after_successful_detach() {
    let _serial = super::super::super::tests::SPAWN_TEST_LOCK.lock().unwrap();
    let (client, events, mut reader, mut writer) = peer();
    let remote = thread::spawn(move || {
        query_and_attach(&mut reader, &mut writer, "first");
        let runtime = receive(&mut reader, "Runtime.enable");
        send(
            &mut writer,
            json!({"id":runtime["id"],"sessionId":"first","error":{"code":-32601,"message":"contract_changed"}}),
        );
        let detach = receive(&mut reader, "Target.detachFromTarget");
        reply(&mut writer, &detach, json!({}));
        let finish = receive(&mut reader, "Fake.finish");
        reply(&mut writer, &finish, json!({}));
    });
    let (_directory, mut renderer) = renderer();
    let (targets, sessions) = crate::probe::discover_runtime_targets_for_test(
        &mut renderer,
        client.clone(),
        events,
        Duration::from_secs(1),
        || panic!("contract errors cannot request recovery"),
    );
    assert!(targets.is_none());
    assert!(sessions.is_empty());
    finish(&client, remote);
}

#[test]
fn repeated_enable_timeouts_use_at_most_the_original_three_slots() {
    let _serial = super::super::super::tests::SPAWN_TEST_LOCK.lock().unwrap();
    let (client, events, mut reader, mut writer) = peer();
    let remote = thread::spawn(move || {
        for index in 0..3 {
            query_and_attach(&mut reader, &mut writer, &format!("session-{index}"));
            let _runtime = receive(&mut reader, "Runtime.enable");
            let detach = receive(&mut reader, "Target.detachFromTarget");
            assert_eq!(detach["params"]["sessionId"], format!("session-{index}"));
            reply(&mut writer, &detach, json!({}));
        }
        let finish = receive(&mut reader, "Fake.finish");
        reply(&mut writer, &finish, json!({}));
    });
    let (_directory, mut renderer) = renderer();
    let (targets, sessions) = crate::probe::discover_runtime_targets_for_test(
        &mut renderer,
        client.clone(),
        events,
        Duration::from_millis(100),
        || true,
    );
    assert!(targets.is_none());
    assert!(sessions.is_empty());
    finish(&client, remote);
}

#[test]
fn recovery_waits_for_every_undelivered_sibling_and_preserves_external_owner() {
    let _serial = super::super::super::tests::SPAWN_TEST_LOCK.lock().unwrap();
    let (client, events, mut reader, mut writer) = peer();
    let healthy = client.track_session("external", "healthy");
    let (ready, received) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let remote = thread::spawn(move || {
        let discover = receive(&mut reader, "Target.setDiscoverTargets");
        reply(&mut writer, &discover, json!({}));
        let targets = receive(&mut reader, "Target.getTargets");
        reply(
            &mut writer,
            &targets,
            json!({"targetInfos":[
                {"targetId":"main","type":"page","url":"app://-/index.html"},
                {"targetId":"sibling","type":"page","url":"app://-/index.html"}
            ]}),
        );
        let attach = receive(&mut reader, "Target.attachToTarget");
        reply(&mut writer, &attach, json!({"sessionId":"first"}));
        enable(&mut reader, &mut writer, "first");
        let attach = receive(&mut reader, "Target.attachToTarget");
        reply(&mut writer, &attach, json!({"sessionId":"sibling"}));
        let _failed = receive(&mut reader, "Runtime.enable");
        let failed_detach = receive(&mut reader, "Target.detachFromTarget");
        assert_eq!(failed_detach["params"]["sessionId"], "sibling");
        let first_detach = receive(&mut reader, "Target.detachFromTarget");
        assert_eq!(first_detach["params"]["sessionId"], "first");
        reply(&mut writer, &failed_detach, json!({}));
        ready.send(()).unwrap();
        released.recv().unwrap();
        assert_no_frame(&reader);
        reply(&mut writer, &first_detach, json!({}));
        query_and_attach(&mut reader, &mut writer, "recovered");
        enable(&mut reader, &mut writer, "recovered");
        let ping = receive(&mut reader, "Fake.healthy");
        assert_eq!(ping["sessionId"], "healthy");
        reply(&mut writer, &ping, json!({}));
        let finish = receive(&mut reader, "Fake.finish");
        reply(&mut writer, &finish, json!({}));
    });
    let (_directory, mut renderer) = renderer();
    let mut release = Some(release);
    let gate_client = client.clone();
    let (targets, sessions) = crate::probe::discover_runtime_targets_for_test(
        &mut renderer,
        client.clone(),
        events,
        Duration::from_millis(500),
        || {
            if let Some(release) = release.take() {
                received.recv_timeout(Duration::from_secs(2)).unwrap();
                let (first, sibling) = {
                    let state = gate_client.inner.runtime.shared.state.lock().unwrap();
                    (
                        state.sessions["first"].retirement.clone(),
                        state.sessions["sibling"].retirement.clone(),
                    )
                };
                assert!(gate_client.wait_for_session_retirements(
                    &[sibling],
                    Instant::now() + Duration::from_secs(2)
                ));
                assert!(!gate_client.wait_for_session_retirements(&[first], Instant::now()));
                release.send(()).unwrap();
            }
            true
        },
    );
    assert!(targets.is_some());
    assert_eq!(sessions[0].session_id(), "recovered");
    client
        .request(
            "Fake.healthy",
            None,
            Some("healthy"),
            Duration::from_secs(2),
        )
        .unwrap();
    assert!(healthy.load(Ordering::Acquire));
    assert!(
        client
            .inner
            .runtime
            .shared
            .state
            .lock()
            .unwrap()
            .retiring_sessions
            .is_empty()
    );
    finish(&client, remote);
}

#[test]
fn confirmed_retirement_does_not_refresh_an_expired_discovery_deadline() {
    let _serial = super::super::super::tests::SPAWN_TEST_LOCK.lock().unwrap();
    let (client, events, reader, _writer) = peer();
    let live = client.track_session("main", "first");
    let retirement = client.session_retirement("first", &live);
    let expires_at = Instant::now();
    route_message(
        &client.inner.runtime.shared,
        json!({"method":"Target.detachedFromTarget","params":{"sessionId":"first"}}),
    )
    .unwrap();
    assert!(client.wait_for_session_retirements(&[retirement], expires_at));
    let failure = match TargetController::discover_until(
        client.clone(),
        events,
        expires_at,
        Duration::from_secs(15),
    ) {
        Err(failure) => failure,
        Ok(_) => panic!("the original absolute slot deadline must remain expired"),
    };
    assert!(matches!(failure.error,
        TargetError::Client(ClientError::RequestTimedOut { ref method, .. })
            if method == "Target.setDiscoverTargets"));
    assert!(failure.retirements.is_empty());
    assert_no_frame(&reader);
    let state = client.inner.runtime.shared.state.lock().unwrap();
    assert!(state.pending.is_empty());
    assert_eq!(state.last_issued_id, 0);
    drop(state);
    client.shutdown().unwrap();
}
