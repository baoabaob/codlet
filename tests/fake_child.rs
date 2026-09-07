#![cfg(windows)]

use std::ffi::OsString;
use std::fs::File;
use std::io::Write;
use std::mem::size_of;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::PathBuf;
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};

use codlet::cdp::{
    CdpClient, ClientError, ConnectionError, EventStreamError, FramingError, MAX_CDP_FRAME_BYTES,
    TargetChange, TargetController, TargetError, TargetObservation, TargetSession,
};
use codlet::plugins::PluginRegistry;
use codlet::probe::{MarkerFailure, ProbeError, hold_cdp_until_child_exit, probe_marker};
use codlet::renderer::{RendererError, RendererRuntime};
use codlet::runtime_status::{PluginLifecycle, StatusPublisher};
use codlet::windows::process::{ChildProcess, launch_with_cdp_pipes};
use serde_json::json;
use tempfile::{TempDir, tempdir};
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::Pipes::CreatePipe;

const DEADLINE: Duration = Duration::from_secs(5);

fn launch(
    scenario: &str,
    extra_arguments: &[OsString],
) -> (ChildProcess, CdpClient, codlet::cdp::CdpEventStream) {
    let executable = PathBuf::from(env!("CARGO_BIN_EXE_codlet-fake-child"));
    let mut arguments = vec![OsString::from(format!("--scenario={scenario}"))];
    arguments.extend_from_slice(extra_arguments);
    let (child, pipes) = launch_with_cdp_pipes(&executable, &arguments, true).unwrap();
    let (client, events) = CdpClient::spawn(pipes).unwrap();
    (child, client, events)
}

fn bundled_runtime() -> (TempDir, RendererRuntime) {
    let directory = tempdir().unwrap();
    let registry = PluginRegistry::load(directory.path().join("config.json")).unwrap();
    let runtime = RendererRuntime::bundled(registry).unwrap();
    (directory, runtime)
}

fn assert_child_success(child: &ChildProcess) {
    assert_eq!(child.wait(DEADLINE).unwrap(), Some(0));
}

fn discover_targets(
    client: CdpClient,
    events: codlet::cdp::CdpEventStream,
    deadline: Duration,
) -> (TargetController, Vec<TargetSession>) {
    TargetController::discover(client, events, deadline).unwrap()
}

fn pump_until_new_target(targets: &mut TargetController) -> Vec<TargetSession> {
    let expires_at = Instant::now() + DEADLINE;
    loop {
        let sessions: Vec<_> = targets
            .pump(expires_at.saturating_duration_since(Instant::now()))
            .unwrap()
            .into_iter()
            .filter_map(|change| match change {
                TargetChange::Attached(session) => Some(session),
                TargetChange::NavigatedAway(_) | TargetChange::SessionEnded { .. } => None,
            })
            .collect();
        if !sessions.is_empty() {
            return sessions;
        }
        assert!(Instant::now() < expires_at, "new target was not attached");
    }
}

#[test]
fn routes_coalesced_events_and_out_of_order_responses() {
    let (child, client, events) = launch("routing", &[]);
    let barrier = Arc::new(Barrier::new(3));
    let requests: Vec<_> = ["Fake.first", "Fake.second"]
        .into_iter()
        .map(|method| {
            let client = client.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                let response = client.request(method, None, None, DEADLINE).unwrap();
                response.result.unwrap()["method"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
        })
        .collect();
    barrier.wait();

    let event = events.recv_timeout(DEADLINE).unwrap();
    assert_eq!(event.method, "Fake.ready");
    let mut methods: Vec<_> = requests
        .into_iter()
        .map(|request| request.join().unwrap())
        .collect();
    methods.sort();
    assert_eq!(methods, ["Fake.first", "Fake.second"]);
    assert_child_success(&child);
    assert_eq!(*client.wait_closed(DEADLINE).unwrap(), ConnectionError::Eof);
}

#[test]
fn eof_tears_down_every_pending_request() {
    let (child, client, _events) = launch("eof", &[]);
    let barrier = Arc::new(Barrier::new(3));
    let requests: Vec<_> = ["Fake.one", "Fake.two"]
        .into_iter()
        .map(|method| {
            let client = client.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                client.request(method, None, None, DEADLINE).unwrap_err()
            })
        })
        .collect();
    barrier.wait();

    for request in requests {
        let error = request.join().unwrap();
        assert!(matches!(
            error,
            codlet::cdp::ClientError::Connection(reason)
                if *reason == ConnectionError::Eof
        ));
    }
    assert_child_success(&child);
}

#[test]
fn inherited_control_pipe_keeps_child_alive_until_parent_eof() {
    let (child, client, events) = launch("pipe-lifetime", &[]);
    assert_eq!(
        events.recv_timeout(DEADLINE).unwrap().method,
        "Fake.pipeHeld"
    );
    assert_eq!(child.wait(Duration::from_millis(150)).unwrap(), None);

    client.shutdown().unwrap();
    assert_child_success(&child);
}

#[test]
fn malformed_frame_closes_connection_and_pending_request() {
    let (child, client, events) = launch("malformed", &[]);
    let error = client
        .request("Fake.break", None, None, DEADLINE)
        .unwrap_err();
    assert!(matches!(
        error,
        codlet::cdp::ClientError::Connection(reason)
            if matches!(&*reason, ConnectionError::Framing(FramingError::InvalidJson { .. }))
    ));
    assert!(matches!(
        events.recv_timeout(DEADLINE),
        Err(EventStreamError::Connection(reason))
            if matches!(&*reason, ConnectionError::Framing(FramingError::InvalidJson { .. }))
    ));
    assert_child_success(&child);
}

#[test]
fn late_response_beyond_previous_tombstone_capacity_keeps_connection_usable() {
    const RETIRED_REQUEST_COUNT: usize = 300;

    let (child, client, _events) = launch("late-retired", &[]);
    let errors = std::thread::scope(|scope| {
        let requests = (0..RETIRED_REQUEST_COUNT)
            .map(|index| {
                let client = client.clone();
                scope.spawn(move || {
                    client
                        .request(
                            &format!("Fake.retire{index}"),
                            None,
                            None,
                            Duration::from_secs(2),
                        )
                        .unwrap_err()
                })
            })
            .collect::<Vec<_>>();

        requests
            .into_iter()
            .map(|request| request.join().unwrap())
            .collect::<Vec<_>>()
    });
    for error in errors {
        assert!(matches!(error, ClientError::RequestTimedOut { .. }));
    }

    let response = client
        .request("Fake.afterLate", None, None, DEADLINE)
        .unwrap();
    assert_eq!(response.result.unwrap()["continued"], "Fake.afterLate");
    assert_child_success(&child);
}

#[test]
fn future_never_issued_response_closes_connection() {
    let (child, client, _events) = launch("future-response", &[]);
    let error = client
        .request("Fake.future", None, None, DEADLINE)
        .unwrap_err();
    assert!(matches!(
        error,
        ClientError::Connection(reason)
            if matches!(&*reason, ConnectionError::UnexpectedResponseId(2))
    ));
    assert_child_success(&child);
}

#[test]
fn rejected_outbound_frame_does_not_consume_a_request_id() {
    let (child, client, _events) = launch("first-issued-id", &[]);
    let error = client
        .request(
            "Fake.oversized",
            Some(json!({"payload": "x".repeat(MAX_CDP_FRAME_BYTES)})),
            None,
            DEADLINE,
        )
        .unwrap_err();
    assert!(matches!(
        error,
        ClientError::RequestFrameTooLarge {
            max_bytes: MAX_CDP_FRAME_BYTES
        }
    ));

    let response = client
        .request("Fake.firstIssued", None, None, DEADLINE)
        .unwrap();
    assert_eq!(response.result.unwrap()["method"], "Fake.firstIssued");
    assert_child_success(&child);
}

#[test]
fn target_discovery_and_stateful_marker_probe_are_automatic() {
    let (child, client, events) = launch("probe", &[]);
    let (_targets, sessions) = discover_targets(client, events, DEADLINE);
    let session = &sessions[0];
    assert_eq!(session.target_id(), "main");
    assert_eq!(session.session_id(), "session-main");
    let report = probe_marker(session, "codlet-fake-stateful-marker").unwrap();
    assert!(report.inserted);
    assert!(report.removed);
    assert_child_success(&child);
}

#[test]
fn foreground_runtime_holds_after_marker_then_reaps_after_child_exit() {
    let (child, client, events) = launch("probe-runtime", &[]);
    let (_targets, sessions) = discover_targets(client.clone(), events, DEADLINE);
    let session = &sessions[0];
    let marker = probe_marker(session, "codlet-fake-runtime-marker").unwrap();
    assert!(marker.inserted);
    assert!(marker.removed);
    assert_eq!(child.wait(Duration::from_millis(150)).unwrap(), None);
    assert!(client.closed_reason().is_none());

    let response = client
        .request("Fake.exit", None, Some(session.session_id()), DEADLINE)
        .unwrap();
    assert_eq!(response.result.unwrap()["exitCode"], 0);

    assert_eq!(hold_cdp_until_child_exit(&child, &client).unwrap(), 0);
    assert!(client.closed_reason().is_some());
    client.shutdown().unwrap();
}

#[test]
fn foreground_runtime_reports_nonzero_child_exit_after_reaping_workers() {
    let (child, client, events) = launch("probe-runtime-nonzero", &[]);
    let (_targets, sessions) = discover_targets(client.clone(), events, DEADLINE);
    let session = &sessions[0];
    let marker = probe_marker(session, "codlet-fake-runtime-nonzero-marker").unwrap();
    assert!(marker.inserted);
    assert!(marker.removed);
    assert_eq!(child.wait(Duration::from_millis(150)).unwrap(), None);
    assert!(client.closed_reason().is_none());

    let response = client
        .request("Fake.exit", None, Some(session.session_id()), DEADLINE)
        .unwrap();
    assert_eq!(response.result.unwrap()["exitCode"], 23);

    assert!(matches!(
        hold_cdp_until_child_exit(&child, &client),
        Err(ProbeError::CodexExit { exit_code: 23 })
    ));
    assert!(client.closed_reason().is_some());
    client.shutdown().unwrap();
}

#[test]
fn target_discovery_retries_one_non_match_then_uses_the_exact_second_round() {
    let (child, client, events) = launch("target-delayed", &[]);
    let (_targets, sessions) = discover_targets(client, events, Duration::from_secs(1));
    let session = &sessions[0];

    assert_eq!(session.target_id(), "main");
    assert_eq!(session.session_id(), "session-main");
    assert_child_success(&child);
}

#[test]
fn target_controller_bootstraps_existing_and_new_browser_windows_once() {
    let (child, client, events) = launch("target-lifecycle", &[]);
    let (mut targets, initial) = discover_targets(client.clone(), events, DEADLINE);
    assert_eq!(
        initial
            .iter()
            .map(TargetSession::target_id)
            .collect::<Vec<_>>(),
        ["initial-a", "initial-b"]
    );
    for session in &initial {
        let marker = probe_marker(session, "codlet-target-lifecycle").unwrap();
        assert!(marker.inserted && marker.removed);
    }
    assert_eq!(targets.session_count(), 2);

    client
        .request("Fake.emitCreated", None, None, DEADLINE)
        .unwrap();
    let created = pump_until_new_target(&mut targets);
    assert_eq!(created.len(), 1);
    assert_eq!(created[0].target_id(), "created");
    probe_marker(&created[0], "codlet-target-lifecycle").unwrap();
    assert_eq!(targets.session_count(), 3);

    client
        .request("Fake.emitInfoChanged", None, None, DEADLINE)
        .unwrap();
    let navigated = pump_until_new_target(&mut targets);
    assert_eq!(navigated.len(), 1);
    assert_eq!(navigated[0].target_id(), "later");
    probe_marker(&navigated[0], "codlet-target-lifecycle").unwrap();
    assert_eq!(targets.session_count(), 4);

    client
        .request("Fake.emitDestroyed", None, None, DEADLINE)
        .unwrap();
    let changes = targets.pump(DEADLINE).unwrap();
    assert!(matches!(
        changes.as_slice(),
        [TargetChange::SessionEnded { target_id, session_id }]
            if target_id == "created" && session_id == "session-created"
    ));
    assert!(!targets.contains_target("created"));
    assert_eq!(targets.session_count(), 3);

    client
        .request("Fake.emitRecreated", None, None, DEADLINE)
        .unwrap();
    let recreated = pump_until_new_target(&mut targets);
    assert_eq!(recreated.len(), 1);
    assert_eq!(recreated[0].target_id(), "created");
    probe_marker(&recreated[0], "codlet-target-lifecycle").unwrap();
    assert_eq!(targets.session_count(), 4);

    client.request("Fake.finish", None, None, DEADLINE).unwrap();
    assert_child_success(&child);
}

#[test]
fn renderer_runtime_installs_and_deactivates_the_bundled_codlet() {
    let (child, client, events) = launch("renderer-runtime", &[]);
    let (_targets, sessions) = discover_targets(client.clone(), events, DEADLINE);
    let (_registry_directory, mut runtime) = bundled_runtime();

    let report = runtime.attach(&sessions[0]).unwrap();
    assert_eq!(report.target_id, "main");
    assert_eq!(report.plugin_count, 2);
    assert_eq!(runtime.session_count(), 1);
    runtime.deactivate_target("main").unwrap();
    assert_eq!(runtime.session_count(), 0);
    client.request("Fake.finish", None, None, DEADLINE).unwrap();
    assert_child_success(&child);
}

#[test]
fn renderer_activation_pumps_host_and_provider_rpc_until_ready() {
    let (child, client, events) = launch("renderer-ready-handshake", &[]);
    let (_targets, sessions) = discover_targets(client.clone(), events, DEADLINE);
    let (_registry_directory, mut runtime) = bundled_runtime();

    let report = runtime.attach(&sessions[0]).unwrap();
    assert_eq!(report.target_id, "main");
    assert_eq!(report.plugin_count, 2);
    assert!(runtime.take_diagnostics().is_empty());
    runtime.deactivate_target("main").unwrap();
    client.request("Fake.finish", None, None, DEADLINE).unwrap();
    assert_child_success(&child);
}

fn reentrant_runtime() -> (TempDir, RendererRuntime) {
    let directory = tempdir().unwrap();
    let registry = PluginRegistry::load(directory.path().join("config.json")).unwrap();
    let mut plugins = codlet::plugins::bundled_plugins().unwrap();
    plugins[0].manifest.requires.push(
        codlet::capabilities::CapabilityDescriptor::new(
            "codlet.runtime.ping",
            1,
            codlet::capabilities::CapabilityScope::Target,
        )
        .unwrap(),
    );
    (directory, RendererRuntime::new(plugins, registry).unwrap())
}

#[test]
fn renderer_reentrant_activation_provider_and_deactivate_complete_only_after_nested_rpc() {
    run_reentrant_scenario("renderer-reentrant", false);
}

#[test]
fn renderer_reentrant_wait_depth_is_bounded_and_host_remains_usable() {
    run_reentrant_scenario("renderer-reentrant-depth", false);
}

#[test]
fn renderer_reentrant_plain_response_failure_is_diagnostic_and_does_not_end_host() {
    run_reentrant_scenario("renderer-reentrant-response-failure", true);
}

fn run_reentrant_scenario(mode: &str, response_failure: bool) {
    let (child, client, events) = launch(mode, &[]);
    let (_targets, sessions) = discover_targets(client.clone(), events, DEADLINE);
    let (directory, mut runtime) = reentrant_runtime();
    assert_eq!(runtime.attach(&sessions[0]).unwrap().plugin_count, 2);
    client
        .request("Fake.beginNested", None, None, DEADLINE)
        .unwrap();
    runtime.pump_bindings_with_timeout(DEADLINE).unwrap();
    let diagnostics = runtime.take_diagnostics();
    assert_eq!(diagnostics.len(), usize::from(response_failure));
    if response_failure {
        assert!(diagnostics[0].message.contains("response delivery failed"));
    }
    client
        .request("Fake.hostStillAlive", None, None, DEADLINE)
        .unwrap();
    runtime.deactivate_target("main").unwrap();
    assert_eq!(runtime.session_count(), 0);
    assert!(!directory.path().join("config.json").exists());
    client.request("Fake.finish", None, None, DEADLINE).unwrap();
    assert_child_success(&child);
}

#[test]
fn renderer_reentrant_nested_wait_uses_original_absolute_deadline() {
    let (child, client, events) = launch("renderer-reentrant-deadline", &[]);
    let (_targets, sessions) = discover_targets(client.clone(), events, Duration::from_millis(500));
    let (_directory, mut runtime) = reentrant_runtime();
    let start = Instant::now();
    assert!(
        runtime
            .attach(&sessions[0])
            .unwrap_err()
            .to_string()
            .contains("deadline")
    );
    assert!(start.elapsed() < Duration::from_millis(750));
    assert_eq!(runtime.session_count(), 0);
    client
        .request("Fake.hostStillAlive", None, None, DEADLINE)
        .unwrap();
    client.request("Fake.finish", None, None, DEADLINE).unwrap();
    assert_child_success(&child);
}

#[test]
fn renderer_reentrant_destruction_revokes_during_activation_provider_and_deactivate() {
    for phase in ["activation", "provider", "deactivate"] {
        let (child, client, events) = launch(&format!("renderer-reentrant-destroy-{phase}"), &[]);
        let (_targets, sessions) = discover_targets(client.clone(), events, DEADLINE);
        let (directory, mut runtime) = reentrant_runtime();
        if phase == "activation" {
            assert!(runtime.attach(&sessions[0]).is_err());
        } else {
            runtime.attach(&sessions[0]).unwrap();
            client
                .request("Fake.beginNested", None, None, DEADLINE)
                .unwrap();
            runtime.pump_bindings_with_timeout(DEADLINE).unwrap();
            if phase == "deactivate" {
                client
                    .request("Fake.hostStillAlive", None, None, DEADLINE)
                    .unwrap();
                assert!(runtime.deactivate_target("main").is_err());
            }
        }
        assert_eq!(runtime.session_count(), 0);
        assert!(!directory.path().join("config.json").exists());
        assert!(matches!(
            sessions[0].evaluate("1"),
            Err(TargetError::Client(ClientError::SessionEnded(_)))
        ));
        client
            .request("Fake.hostStillAlive", None, None, DEADLINE)
            .unwrap();
        client.request("Fake.finish", None, None, DEADLINE).unwrap();
        assert_child_success(&child);
    }
}

#[test]
fn activating_plugin_cannot_commit_runtime_management_actions() {
    let (child, client, events) = launch("renderer-ready-rejection", &[]);
    let (_targets, sessions) = discover_targets(client.clone(), events, DEADLINE);
    let registry_directory = tempdir().unwrap();
    let registry_path = registry_directory.path().join("config.json");
    let registry = PluginRegistry::load(&registry_path).unwrap();
    let mut runtime = RendererRuntime::bundled(registry).unwrap();

    let error = runtime.attach(&sessions[0]).unwrap_err();
    assert!(matches!(
        error,
        RendererError::PluginRejected { plugin_id, message }
            if plugin_id == "codlet" && message == "activation self-disable rejected"
    ));
    assert_eq!(runtime.session_count(), 0);
    assert!(!registry_path.exists());
    client
        .request("Fake.hostStillAlive", None, None, DEADLINE)
        .unwrap();
    client.request("Fake.finish", None, None, DEADLINE).unwrap();
    assert_child_success(&child);
}

#[test]
fn renderer_activation_timeout_is_bounded_and_rolls_back_the_candidate() {
    let (child, client, events) = launch("renderer-ready-timeout", &[]);
    let (_targets, sessions) = discover_targets(client.clone(), events, Duration::from_millis(250));
    let (_registry_directory, mut runtime) = bundled_runtime();
    let publisher = StatusPublisher::new();
    runtime.set_status_publisher(publisher.clone());
    let reader = {
        let publisher = publisher.clone();
        std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline {
                let snapshot = publisher.snapshot();
                if let Some(plugin) = snapshot
                    .renderer
                    .targets
                    .iter()
                    .flat_map(|target| &target.plugins)
                    .find(|plugin| {
                        plugin.id == "codlet" && plugin.lifecycle == PluginLifecycle::Activating
                    })
                {
                    assert!(!plugin.active);
                    assert!(snapshot.sampled_at_unix_ms > 0);
                    return;
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            panic!("activation wait did not publish an observable live snapshot");
        })
    };

    let started = Instant::now();
    let error = runtime.attach(&sessions[0]).unwrap_err();
    assert!(matches!(
        error,
        RendererError::PluginRejected { plugin_id, message }
            if plugin_id == "codlet"
                && message.contains("Runtime.evaluate")
                && message.contains("exceeded its deadline")
    ));
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(runtime.session_count(), 0);

    reader.join().unwrap();
    let snapshot = publisher.snapshot();
    assert!(snapshot.renderer.targets.is_empty());
    assert!(
        snapshot
            .renderer
            .recent_events
            .iter()
            .any(|event| event.code == "attach_failed")
    );

    client
        .request("Fake.hostStillAlive", None, None, DEADLINE)
        .unwrap();
    client.request("Fake.finish", None, None, DEADLINE).unwrap();
    assert_child_success(&child);
}

#[test]
fn renderer_binding_round_trip_rejects_stale_unknown_and_revoked_calls() {
    let (child, client, events) = launch("renderer-rpc", &[]);
    let (mut targets, sessions) = discover_targets(client.clone(), events, DEADLINE);
    let (_registry_directory, mut runtime) = bundled_runtime();
    runtime.attach(&sessions[0]).unwrap();
    assert_eq!(runtime.pump_bindings_with_timeout(DEADLINE).unwrap(), 1);

    client
        .request("Fake.emitRendererRequest", None, None, DEADLINE)
        .unwrap();
    assert_eq!(runtime.pump_bindings_with_timeout(DEADLINE).unwrap(), 1);

    client
        .request("Fake.emitDuplicateRequest", None, None, DEADLINE)
        .unwrap();
    assert_eq!(runtime.pump_bindings_with_timeout(DEADLINE).unwrap(), 1);

    client
        .request("Fake.emitStale", None, None, DEADLINE)
        .unwrap();
    assert_eq!(runtime.pump_bindings_with_timeout(DEADLINE).unwrap(), 1);

    client
        .request("Fake.emitUnknownBinding", None, None, DEADLINE)
        .unwrap();
    assert_eq!(runtime.pump_bindings_with_timeout(DEADLINE).unwrap(), 1);

    client
        .request("Fake.emitWrongBindingSession", None, None, DEADLINE)
        .unwrap();
    assert_eq!(runtime.pump_bindings().unwrap(), 0);

    let destroyed = targets.pump(Duration::ZERO).unwrap();
    assert!(destroyed.is_empty());
    runtime.deactivate_target("main").unwrap();
    assert_eq!(runtime.pump_bindings().unwrap(), 0);
    client.request("Fake.finish", None, None, DEADLINE).unwrap();
    assert_child_success(&child);
}

#[test]
fn runtime_manage_persists_isolates_cleanup_failure_and_filters_future_targets() {
    let (child, client, events) = launch("renderer-manage", &[]);
    let (mut targets, sessions) = discover_targets(client.clone(), events, DEADLINE);
    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions[0].target_id(), "main");
    assert_eq!(sessions[1].target_id(), "cleanup-failure");
    let registry_directory = tempdir().unwrap();
    let registry_path = registry_directory.path().join("config.json");
    let registry = PluginRegistry::load(&registry_path).unwrap();
    let mut runtime = RendererRuntime::bundled(registry).unwrap();
    let publisher = StatusPublisher::new();
    runtime.set_status_publisher(publisher.clone());
    assert!(publisher.snapshot().renderer.targets.is_empty());
    for session in &sessions {
        assert_eq!(runtime.attach(session).unwrap().plugin_count, 2);
    }
    let snapshot = publisher.snapshot();
    assert_eq!(snapshot.renderer.targets.len(), 2);
    assert!(snapshot.renderer.targets.iter().all(|target| {
        target.plugins.len() == 2
            && target.plugins.iter().all(|plugin| {
                plugin.active
                    && plugin.activation_confirmed
                    && plugin.lifecycle == PluginLifecycle::Active
            })
    }));

    client
        .request("Fake.emitDisableSelf", None, None, DEADLINE)
        .unwrap();
    assert_eq!(runtime.pump_bindings_with_timeout(DEADLINE).unwrap(), 1);
    assert_eq!(runtime.plugin_count(), 1);
    assert!(
        publisher
            .snapshot()
            .renderer
            .targets
            .iter()
            .all(|target| target.plugins.len() == 1 && target.plugins[0].id == "codex.ui.adapter")
    );
    assert!(
        publisher
            .snapshot()
            .renderer
            .recent_events
            .iter()
            .any(|event| event.code == "cleanup_failed")
    );
    let diagnostics = runtime.take_diagnostics();
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].target_id, "cleanup-failure");
    assert_eq!(diagnostics[0].plugin_id, "codlet");
    assert!(
        diagnostics[0]
            .message
            .contains("simulated codlet cleanup failure")
    );
    assert!(
        !PluginRegistry::load(&registry_path)
            .unwrap()
            .is_enabled("codlet")
    );

    client
        .request("Fake.createTargetAfterDisable", None, None, DEADLINE)
        .unwrap();
    let created = pump_until_new_target(&mut targets);
    assert_eq!(created.len(), 1);
    assert_eq!(created[0].target_id(), "after-disable");
    let report = runtime.attach(&created[0]).unwrap();
    assert_eq!(report.plugin_count, 1);
    assert_eq!(publisher.snapshot().renderer.targets.len(), 3);

    runtime.deactivate_target("after-disable").unwrap();
    runtime.deactivate_target("main").unwrap();
    runtime.deactivate_target("cleanup-failure").unwrap();
    assert!(publisher.snapshot().renderer.targets.is_empty());
    client.request("Fake.finish", None, None, DEADLINE).unwrap();
    assert_child_success(&child);
}

#[test]
fn status_does_not_infer_activation_from_a_recreated_context() {
    let (child, client, events) = launch("renderer-status-context", &[]);
    let (_targets, sessions) = discover_targets(client.clone(), events, DEADLINE);
    let (_directory, mut runtime) = bundled_runtime();
    let publisher = StatusPublisher::new();
    runtime.set_status_publisher(publisher.clone());
    runtime.attach(&sessions[0]).unwrap();
    assert!(
        publisher.snapshot().renderer.targets[0]
            .plugins
            .iter()
            .all(|p| p.active)
    );
    client
        .request("Fake.clearContexts", None, None, DEADLINE)
        .unwrap();
    runtime.pump_bindings_with_timeout(DEADLINE).unwrap();
    assert!(
        publisher.snapshot().renderer.targets[0]
            .plugins
            .iter()
            .all(|plugin| !plugin.context_present
                && !plugin.active
                && !plugin.activation_confirmed)
    );
    client
        .request("Fake.restoreContexts", None, None, DEADLINE)
        .unwrap();
    let deadline = Instant::now() + DEADLINE;
    while !publisher.snapshot().renderer.targets[0]
        .plugins
        .iter()
        .all(|p| p.context_present)
    {
        runtime
            .pump_bindings_with_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap();
        assert!(Instant::now() < deadline);
    }
    assert!(
        publisher.snapshot().renderer.targets[0]
            .plugins
            .iter()
            .all(|plugin| !plugin.active && !plugin.activation_confirmed)
    );
    runtime.deactivate_target("main").unwrap();
    client.request("Fake.finish", None, None, DEADLINE).unwrap();
    assert_child_success(&child);
}

#[test]
fn local_runtime_management_uses_launch_snapshot_and_preserves_concurrent_registry_edits() {
    local_runtime_management_case(true);
}

#[test]
fn local_runtime_management_without_grant_cannot_list_or_persist() {
    local_runtime_management_case(false);
}

fn local_runtime_management_case(has_grant: bool) {
    use codlet::catalog::PluginCatalog;
    use codlet::plugins::{LocalPluginRegistration, Permission};

    let directory = tempdir().unwrap();
    let root = directory.path().join("local-plugin");
    std::fs::create_dir(&root).unwrap();
    let grants = if has_grant {
        vec![Permission::RuntimeManage]
    } else {
        vec![]
    };
    let manifest = json!({"schema":1,"id":"dev.local","version":"1", "renderer":{"entry":"renderer.js","world":"isolated"},
    "permissions":grants, "requires":[
        {"name":"codex.ui.titlebar.afterMenu","api":1,"scope":"target"},
        {"name":"codlet.runtime.manage","api":1,"scope":"target"}
    ]});
    std::fs::write(root.join("plugin.json"), manifest.to_string()).unwrap();
    std::fs::write(
        root.join("renderer.js"),
        "// fixture-local-source\nmodule.exports = { activate() {}, deactivate() {} };",
    )
    .unwrap();
    let registry_path = directory.path().join("config.json");
    let mut registry = PluginRegistry::load(&registry_path).unwrap();
    let registration = LocalPluginRegistration {
        path: root.clone(),
        grants,
    };
    registry
        .register_local("dev.local", registration.clone())
        .unwrap();
    registry
        .register_local(
            "dev.broken",
            LocalPluginRegistration {
                path: directory.path().join("missing"),
                grants: vec![],
            },
        )
        .unwrap();
    registry.set_enabled("dev.broken", false).unwrap();
    registry.save().unwrap();
    let initial_registry = std::fs::read(&registry_path).unwrap();
    let catalog = PluginCatalog::load(&registry).unwrap();
    let mut runtime = RendererRuntime::from_catalog(catalog, registry).unwrap();

    let changed_source = "throw new Error('this disk revision must not be read');";
    std::fs::write(root.join("renderer.js"), changed_source).unwrap();
    std::fs::write(
        root.join("plugin.json"),
        "invalid manifest after launch snapshot",
    )
    .unwrap();
    let scenario = if has_grant {
        "renderer-local-manage"
    } else {
        "renderer-local-manage-denied"
    };
    let (child, client, events) = launch(scenario, &[]);
    let (_targets, sessions) = discover_targets(client.clone(), events, DEADLINE);
    assert_eq!(runtime.attach(&sessions[0]).unwrap().plugin_count, 3);
    client
        .request("Fake.emitLocalList", None, None, DEADLINE)
        .unwrap();
    runtime.pump_bindings_with_timeout(DEADLINE).unwrap();

    if has_grant {
        let mut cli_registry = PluginRegistry::load(&registry_path).unwrap();
        cli_registry.set_enabled("codlet", false).unwrap();
        cli_registry
            .register_local(
                "dev.later",
                LocalPluginRegistration {
                    path: directory.path().join("registered-after-launch"),
                    grants: vec![],
                },
            )
            .unwrap();
        cli_registry.save().unwrap();
    }
    client
        .request("Fake.emitLocalDisable", None, None, DEADLINE)
        .unwrap();
    runtime.pump_bindings_with_timeout(DEADLINE).unwrap();
    assert_eq!(runtime.plugin_count(), if has_grant { 2 } else { 3 });
    assert!(runtime.take_diagnostics().is_empty());
    let saved = PluginRegistry::load(&registry_path).unwrap();
    assert_eq!(saved.is_enabled("dev.local"), !has_grant);
    assert_eq!(saved.is_enabled("codlet"), !has_grant);
    assert_eq!(saved.local_plugins()["dev.local"].path, registration.path);
    assert_eq!(
        saved.local_plugins()["dev.local"].grants,
        registration.grants
    );
    assert!(saved.local_plugins().contains_key("dev.broken"));
    assert_eq!(saved.local_plugins().contains_key("dev.later"), has_grant);
    if !has_grant {
        assert_eq!(std::fs::read(&registry_path).unwrap(), initial_registry);
        client
            .request("Fake.hostStillAlive", None, None, DEADLINE)
            .unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(root.join("renderer.js")).unwrap(),
        changed_source
    );
    runtime.deactivate_target("main").unwrap();
    client.request("Fake.finish", None, None, DEADLINE).unwrap();
    assert_child_success(&child);
}

#[test]
fn persisted_runtime_action_survives_renderer_response_delivery_failure() {
    let (child, client, events) = launch("renderer-manage-response-failure", &[]);
    let (_targets, sessions) = discover_targets(client.clone(), events, DEADLINE);
    let registry_directory = tempdir().unwrap();
    let registry_path = registry_directory.path().join("config.json");
    let registry = PluginRegistry::load(&registry_path).unwrap();
    let mut runtime = RendererRuntime::bundled(registry).unwrap();
    runtime.attach(&sessions[0]).unwrap();

    client
        .request("Fake.emitDisableSelf", None, None, DEADLINE)
        .unwrap();
    assert_eq!(runtime.pump_bindings_with_timeout(DEADLINE).unwrap(), 1);
    assert_eq!(runtime.plugin_count(), 1);
    assert!(
        !PluginRegistry::load(&registry_path)
            .unwrap()
            .is_enabled("codlet")
    );
    let diagnostics = runtime.take_diagnostics();
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].target_id, "main");
    assert_eq!(diagnostics[0].plugin_id, "codlet");
    assert!(diagnostics[0].message.contains("response delivery failed"));

    client
        .request("Fake.hostStillAlive", None, None, DEADLINE)
        .unwrap();
    runtime.deactivate_target("main").unwrap();
    client.request("Fake.finish", None, None, DEADLINE).unwrap();
    assert_child_success(&child);
}

#[test]
fn renderer_target_replacement_does_not_touch_the_dead_session() {
    let (child, client, events) = launch("renderer-target-replacement", &[]);
    let (mut targets, sessions) = discover_targets(client.clone(), events, DEADLINE);
    let (_registry_directory, mut runtime) = bundled_runtime();
    runtime.attach(&sessions[0]).unwrap();
    client
        .request("Fake.replaceTarget", None, None, DEADLINE)
        .unwrap();
    let destroyed = targets.pump(DEADLINE).unwrap();
    let [
        TargetChange::SessionEnded {
            target_id,
            session_id,
        },
    ] = destroyed.as_slice()
    else {
        panic!("target destruction did not surface before replacement attach");
    };
    assert_eq!(target_id, "main");
    assert_eq!(session_id, "session-main-1");
    runtime
        .apply_target_change(destroyed.into_iter().next().unwrap())
        .unwrap();
    assert_eq!(runtime.pump_bindings().unwrap(), 0);

    let recreated = targets.pump(DEADLINE).unwrap();
    let [TargetChange::Attached(session)] = recreated.as_slice() else {
        panic!("same target id was not attached as a new session");
    };
    assert_eq!(session.target_id(), "main");
    assert_eq!(session.session_id(), "session-main-2");
    let report = runtime
        .apply_target_change(recreated.into_iter().next().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(report.target_id, "main");

    client
        .request("Fake.emitLateDetach", None, None, DEADLINE)
        .unwrap();
    assert!(targets.pump(DEADLINE).unwrap().is_empty());
    assert!(targets.contains_target("main"));

    runtime.deactivate_target("main").unwrap();
    client.request("Fake.finish", None, None, DEADLINE).unwrap();
    assert_child_success(&child);
}

#[test]
fn renderer_navigation_cleans_live_session_and_detaches_exactly_once() {
    let (child, client, events) = launch("renderer-navigation", &[]);
    let (mut targets, sessions) = discover_targets(client.clone(), events, DEADLINE);
    let (_registry_directory, mut runtime) = bundled_runtime();
    runtime.attach(&sessions[0]).unwrap();

    client
        .request("Fake.navigateAway", None, None, DEADLINE)
        .unwrap();
    let changes = targets.pump(DEADLINE).unwrap();
    let [TargetChange::NavigatedAway(session)] = changes.as_slice() else {
        panic!("navigation away did not surface as a live-session transition");
    };
    assert_eq!(session.target_id(), "main");
    assert_eq!(session.session_id(), "session-main-nav-1");
    runtime
        .apply_target_change(changes.into_iter().next().unwrap())
        .unwrap();
    assert_eq!(runtime.session_count(), 0);

    // The browser-level detach notification for the old session must be a no-op.
    assert!(targets.pump(DEADLINE).unwrap().is_empty());

    client
        .request("Fake.recreateAfterNavigation", None, None, DEADLINE)
        .unwrap();
    let changes = targets.pump(DEADLINE).unwrap();
    let [TargetChange::Attached(session)] = changes.as_slice() else {
        panic!("navigation recreation did not attach a fresh session");
    };
    assert_eq!(session.session_id(), "session-main-nav-2");
    runtime
        .apply_target_change(changes.into_iter().next().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(runtime.session_count(), 1);

    runtime.deactivate_target("main").unwrap();
    client.request("Fake.finish", None, None, DEADLINE).unwrap();
    assert_child_success(&child);
}

#[test]
fn target_discovery_deadline_is_bounded_and_reports_only_last_observations() {
    let (child, client, events) = launch("target-never", &[]);
    let started = Instant::now();
    let error = match TargetController::discover(client, events, Duration::from_millis(250)) {
        Ok(_) => panic!("non-matching targets unexpectedly produced a session"),
        Err(error) => error,
    };
    let wall_elapsed = started.elapsed();

    let TargetError::MainTargetNotFound {
        attempts,
        elapsed_ms,
        observations,
    } = &error
    else {
        panic!("unexpected target discovery error: {error:?}");
    };
    assert!((2..=5).contains(attempts));
    assert!(*elapsed_ms <= 1_000);
    assert_eq!(
        observations,
        &vec![
            TargetObservation {
                target_id: format!("starting-{attempts}"),
                target_type: "page".to_owned(),
                url: "about:blank".to_owned(),
                title: Some("Codex".to_owned()),
                attached: Some(false),
            },
            TargetObservation {
                target_id: format!("worker-{attempts}"),
                target_type: "worker".to_owned(),
                url: "app://-/index.html".to_owned(),
                title: Some("Codex".to_owned()),
                attached: Some(true),
            },
        ]
    );
    let rendered = error.to_string();
    assert!(rendered.contains(&format!("attempts={attempts}")));
    assert!(rendered.contains(&format!("elapsed_ms={elapsed_ms}")));
    assert!(rendered.contains("targetId"));
    assert!(rendered.contains("about:blank"));
    assert!(wall_elapsed < Duration::from_secs(2));
    assert_child_success(&child);
}

#[test]
fn fake_probe_rejects_arbitrary_runtime_evaluate() {
    let (child, client, events) = launch("probe-reject-arbitrary", &[]);
    let (_targets, sessions) = discover_targets(client, events, DEADLINE);
    let session = &sessions[0];
    let result = session.evaluate("true").unwrap();
    assert!(result.get("exceptionDetails").is_some());
    assert_ne!(
        result
            .pointer("/result/value")
            .and_then(|value| value.as_bool()),
        Some(true)
    );
    assert_child_success(&child);
}

#[test]
fn marker_cleanup_runs_after_insert_response_is_lost() {
    let (child, client, events) = launch("probe-insert-response-lost", &[]);
    let (_targets, sessions) = discover_targets(client, events, Duration::from_millis(750));
    let error = probe_marker(&sessions[0], "codlet-lost-response-marker").unwrap_err();
    assert!(matches!(
        error,
        ProbeError::Marker(MarkerFailure::Request {
            phase: "insert",
            source: TargetError::Client(ClientError::RequestTimedOut { .. }),
        })
    ));
    assert_child_success(&child);
}

#[test]
fn marker_probe_reports_remove_exception_after_cleanup_attempt() {
    let (child, client, events) = launch("probe-remove-error", &[]);
    let (_targets, sessions) = discover_targets(client, events, DEADLINE);
    let error = probe_marker(&sessions[0], "codlet-remove-error-marker").unwrap_err();
    assert!(matches!(
        error,
        ProbeError::Marker(MarkerFailure::Invalid { phase: "remove" })
    ));
    assert_child_success(&child);
}

#[test]
fn target_session_rejects_wrong_response_session_id() {
    let (child, client, events) = launch("wrong-session", &[]);
    let error = match TargetController::discover(client, events, DEADLINE) {
        Ok(_) => panic!("wrong-session response unexpectedly succeeded"),
        Err(error) => error,
    };
    assert!(matches!(
        error,
        TargetError::Client(ClientError::Connection(reason))
            if matches!(&*reason, ConnectionError::ResponseSessionMismatch {
                expected: Some(expected),
                actual: Some(actual),
                ..
            } if expected == "session-main" && actual == "session-other")
    ));
    assert_child_success(&child);
}

#[test]
fn process_attribute_list_does_not_inherit_unlisted_handle() {
    const TOKEN: &str = "codlet-unlisted-sentinel";
    let sentinel = inheritable_pipe_read_handle(TOKEN.as_bytes());
    let raw = sentinel.as_raw_handle() as usize;
    let (child, _client, events) = launch(
        "whitelist",
        &[
            OsString::from(format!("--sentinel-handle={raw}")),
            OsString::from(format!("--sentinel-token={TOKEN}")),
        ],
    );
    let event = events.recv_timeout(DEADLINE).unwrap();
    assert_eq!(event.method, "Fake.sentinel");
    assert_eq!(event.params.as_ref().unwrap()["inherited"], false);
    assert_child_success(&child);
}

fn inheritable_pipe_read_handle(token: &[u8]) -> OwnedHandle {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: 1,
    };
    let mut read: HANDLE = std::ptr::null_mut();
    let mut write: HANDLE = std::ptr::null_mut();
    // SAFETY: output pointers and SECURITY_ATTRIBUTES are valid for the call.
    assert_ne!(
        unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) },
        0
    );
    // SAFETY: CreatePipe returned two independently owned handles.
    unsafe {
        let mut writer = File::from_raw_handle(write.cast());
        writer.write_all(token).unwrap();
        drop(writer);
        OwnedHandle::from_raw_handle(read.cast())
    }
}
