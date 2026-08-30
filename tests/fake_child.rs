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
    TargetError, TargetObservation, TargetSession,
};
use codlet::probe::{MarkerFailure, ProbeError, hold_cdp_until_child_exit, probe_marker};
use codlet::windows::process::{ChildProcess, launch_with_cdp_pipes};
use serde_json::json;
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

fn assert_child_success(child: &ChildProcess) {
    assert_eq!(child.wait(DEADLINE).unwrap(), Some(0));
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
    for index in 0..RETIRED_REQUEST_COUNT {
        let error = client
            .request(
                &format!("Fake.retire{index}"),
                None,
                None,
                Duration::from_millis(5),
            )
            .unwrap_err();
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
    let (child, client, _events) = launch("probe", &[]);
    let session = TargetSession::discover(client, DEADLINE).unwrap();
    assert_eq!(session.target_id(), "main");
    assert_eq!(session.session_id(), "session-main");
    let report = probe_marker(&session, "codlet-fake-stateful-marker").unwrap();
    assert!(report.inserted);
    assert!(report.removed);
    assert_child_success(&child);
}

#[test]
fn foreground_runtime_holds_after_marker_then_reaps_after_child_exit() {
    let (child, client, _events) = launch("probe-runtime", &[]);
    let session = TargetSession::discover(client.clone(), DEADLINE).unwrap();
    let marker = probe_marker(&session, "codlet-fake-runtime-marker").unwrap();
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
    let (child, client, _events) = launch("probe-runtime-nonzero", &[]);
    let session = TargetSession::discover(client.clone(), DEADLINE).unwrap();
    let marker = probe_marker(&session, "codlet-fake-runtime-nonzero-marker").unwrap();
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
    let (child, client, _events) = launch("target-delayed", &[]);
    let session = TargetSession::discover(client, Duration::from_secs(1)).unwrap();

    assert_eq!(session.target_id(), "main");
    assert_eq!(session.session_id(), "session-main");
    assert_child_success(&child);
}

#[test]
fn target_discovery_deadline_is_bounded_and_reports_only_last_observations() {
    let (child, client, _events) = launch("target-never", &[]);
    let started = Instant::now();
    let error = match TargetSession::discover(client, Duration::from_millis(250)) {
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
    let (child, client, _events) = launch("probe-reject-arbitrary", &[]);
    let session = TargetSession::discover(client, DEADLINE).unwrap();
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
    let (child, client, _events) = launch("probe-insert-response-lost", &[]);
    let session = TargetSession::discover(client, Duration::from_millis(750)).unwrap();
    let error = probe_marker(&session, "codlet-lost-response-marker").unwrap_err();
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
    let (child, client, _events) = launch("probe-remove-error", &[]);
    let session = TargetSession::discover(client, DEADLINE).unwrap();
    let error = probe_marker(&session, "codlet-remove-error-marker").unwrap_err();
    assert!(matches!(
        error,
        ProbeError::Marker(MarkerFailure::Invalid { phase: "remove" })
    ));
    assert_child_success(&child);
}

#[test]
fn target_session_rejects_wrong_response_session_id() {
    let (child, client, _events) = launch("wrong-session", &[]);
    let error = match TargetSession::discover(client, DEADLINE) {
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
