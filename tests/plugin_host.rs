#![cfg(windows)]

use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use codlet::plugin_host::{
    HostEvent, HostIdentity, HostState, HostSupervisor, MAX_HOST_FRAME_BYTES,
};
use serde_json::{Value, json};
use tempfile::tempdir;
use windows_sys::Win32::Foundation::{HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CreateEventW, OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
};

const TEST_WAIT: Duration = Duration::from_secs(5);

fn executable() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_codlet-fake-host"))
}

fn launch(mode: &str, cwd: &Path) -> HostSupervisor {
    HostSupervisor::spawn(
        HostIdentity {
            plugin_id: "dev.host-fixture".into(),
            generation: 7,
        },
        &executable(),
        &[mode.into()],
        cwd,
    )
    .unwrap()
}

fn initialize(host: &mut HostSupervisor) -> u64 {
    host.send_request("initialize", json!({"protocol":1}), TEST_WAIT)
        .unwrap()
}

fn until(
    host: &mut HostSupervisor,
    timeout: Duration,
    ready: impl Fn(&[HostEvent]) -> bool,
) -> Vec<HostEvent> {
    let deadline = Instant::now() + timeout;
    let mut events = Vec::new();
    loop {
        events.extend(host.poll());
        if ready(&events) {
            return events;
        }
        assert!(
            Instant::now() < deadline,
            "event deadline exceeded: state={:?}, events={events:?}, stderr={:?}",
            host.state(),
            String::from_utf8_lossy(&host.stderr_tail())
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn response(events: &[HostEvent], wanted: u64) -> Option<Value> {
    events.iter().find_map(|event| match event {
        HostEvent::Response { id, result } if *id == wanted => Some(result.clone().unwrap()),
        _ => None,
    })
}

fn ready(host: &mut HostSupervisor) {
    let id = initialize(host);
    until(host, TEST_WAIT, |events| response(events, id).is_some());
    host.mark_ready().unwrap();
}

#[test]
fn native_stdio_supports_nested_initialize_and_strict_handle_inheritance() {
    let directory = tempdir().unwrap();
    let cwd = directory.path().join("插件 host working directory");
    std::fs::create_dir(&cwd).unwrap();
    let copied_executable = cwd.join("native host fixture.exe");
    std::fs::copy(executable(), &copied_executable).unwrap();
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: 1,
    };
    let event = unsafe { CreateEventW(&attributes, 1, 0, std::ptr::null()) };
    assert!(!event.is_null());
    let event = unsafe { OwnedHandle::from_raw_handle(event.cast()) };
    let argument = "quoted \"value\" ending with \\";
    let mut host = HostSupervisor::spawn(
        HostIdentity {
            plugin_id: "dev.host-fixture".into(),
            generation: 7,
        },
        &copied_executable,
        &[
            "nested".into(),
            (event.as_raw_handle() as usize).to_string(),
            argument.into(),
        ],
        &cwd,
    )
    .unwrap();
    let too_large = host
        .send_request(
            "initialize",
            json!("x".repeat(MAX_HOST_FRAME_BYTES)),
            TEST_WAIT,
        )
        .unwrap_err();
    assert_eq!(too_large.code, "frame_too_large");
    let id = initialize(&mut host);
    assert_eq!(id, 1, "a rejected frame must not allocate a request id");
    let events = until(&mut host, TEST_WAIT, |events| {
        events.iter().any(
            |event| matches!(event, HostEvent::Request { method, .. } if method == "fixture.core"),
        )
    });
    assert_eq!(host.state(), HostState::Starting);
    let request_id = events
        .iter()
        .find_map(|event| match event {
            HostEvent::Request { id, .. } => Some(*id),
            _ => None,
        })
        .unwrap();
    let original_deadline = host.incoming_deadline(request_id).unwrap();
    assert!(original_deadline > Instant::now());
    assert_eq!(host.incoming_deadline(request_id), Some(original_deadline));
    host.respond(request_id, Ok(json!({"availableBeforeReady":true})))
        .unwrap();
    assert_eq!(host.incoming_deadline(request_id), None);
    let events = until(&mut host, TEST_WAIT, |events| {
        response(events, id).is_some()
    });
    let result = response(&events, id).unwrap();
    assert_eq!(result["coreResult"]["availableBeforeReady"], true);
    assert_eq!(
        std::fs::canonicalize(result["cwd"].as_str().unwrap()).unwrap(),
        std::fs::canonicalize(&cwd).unwrap()
    );
    assert_eq!(result["args"], json!([argument]));
    assert_eq!(
        unsafe { WaitForSingleObject(event.as_raw_handle().cast(), 0) },
        WAIT_TIMEOUT,
        "an unrelated inheritable parent handle crossed the explicit whitelist"
    );
    assert_eq!(host.stderr_tail(), vec![b'd'; 64 * 1024]);
    host.mark_ready().unwrap();
    host.notify("fixture.note", json!({"count":1})).unwrap();
    until(&mut host, TEST_WAIT, |events| {
        events.iter().any(|event| matches!(event, HostEvent::Notification { method, params } if method == "fixture.note" && params["count"] == 1))
    });

    let late = host
        .send_request("fixture.slow", Value::Null, Duration::from_secs(1))
        .unwrap();
    let events = until(&mut host, TEST_WAIT, |events| {
        events
            .iter()
            .any(|event| matches!(event, HostEvent::RequestTimedOut { id } if *id == late))
    });
    assert!(events.iter().any(|event| matches!(event, HostEvent::Notification { method, .. } if method == "fixture.waiting")));
    host.notify("fixture.release", Value::Null).unwrap();
    let after = host
        .send_request("fixture.echo", json!({"afterTimeout":true}), TEST_WAIT)
        .unwrap();
    let events = until(&mut host, TEST_WAIT, |events| {
        response(events, after).is_some()
    });
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, HostEvent::Response { id, .. } if *id == late))
    );
    assert_eq!(response(&events, after).unwrap()["afterTimeout"], true);
    let report = host.stop().unwrap();
    assert_eq!(report.exit_code, 0);
    assert!(!report.forced);
    assert!(report.workers_reaped);
    assert_eq!(
        host.stop().unwrap(),
        report,
        "stopping twice must be idempotent"
    );
}

#[test]
fn malformed_stale_truncated_duplicate_and_flooded_stdout_retire_only_that_host() {
    let directory = tempdir().unwrap();
    for mode in [
        "malformed",
        "wrong-generation",
        "truncated",
        "flood",
        "duplicate",
    ] {
        let mut host = launch(
            if mode == "duplicate" {
                "cooperative"
            } else {
                mode
            },
            directory.path(),
        );
        if mode == "duplicate" {
            ready(&mut host);
            host.send_request("fixture.repeat", Value::Null, TEST_WAIT)
                .unwrap();
        } else {
            initialize(&mut host);
        }
        // Let the intentionally flooding child fill its four-frame buffer before
        // owner dispatch. This is not a request deadline or an IPC timing guard.
        if mode == "flood" {
            std::thread::sleep(Duration::from_millis(100));
        }
        let events = until(&mut host, TEST_WAIT, |events| {
            events
                .iter()
                .any(|event| matches!(event, HostEvent::Failed { .. }))
        });
        let error = events
            .iter()
            .find_map(|event| match event {
                HostEvent::Failed { error } => Some(error),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            error.code,
            if mode == "flood" {
                "incoming_queue_full"
            } else {
                "protocol_error"
            },
            "mode={mode}, events={events:?}"
        );
        assert_eq!(host.state(), HostState::Failed);
        assert!(
            host.send_request("fixture.echo", Value::Null, TEST_WAIT)
                .is_err()
        );
        assert!(host.stop().unwrap().workers_reaped);
    }
}

#[test]
fn a_child_that_never_reads_stdin_cannot_hold_a_write_or_shutdown_open() {
    let directory = tempdir().unwrap();
    let mut host = launch("refuse-stdin", directory.path());
    host.send_request(
        "initialize",
        json!({"padding":"x".repeat(128 * 1024)}),
        Duration::from_millis(150),
    )
    .unwrap();
    let events = until(&mut host, TEST_WAIT, |events| {
        events
            .iter()
            .any(|event| matches!(event, HostEvent::Failed { .. }))
    });
    assert!(events.iter().any(|event| matches!(event, HostEvent::Failed { error } if matches!(error.code, "write_timeout" | "stdin_write_failed"))), "{events:?}");
    let started = Instant::now();
    let report = host.stop().unwrap();
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(report.forced && report.workers_reaped);
}

#[test]
fn an_incomplete_live_stdout_frame_has_an_absolute_deadline() {
    let directory = tempdir().unwrap();
    let mut host = launch("partial-hang", directory.path());
    ready(&mut host);
    let started = Instant::now();
    let events = until(&mut host, Duration::from_secs(17), |events| {
        events
            .iter()
            .any(|event| matches!(event, HostEvent::Failed { .. }))
    });
    assert!(
        started.elapsed() >= Duration::from_secs(14),
        "the frame must retain its 15-second absolute deadline"
    );
    assert!(
        events.iter().any(
            |event| matches!(event, HostEvent::Failed { error } if error.code == "frame_timeout")
        ),
        "{events:?}"
    );
    assert!(host.stop().unwrap().workers_reaped);
}

#[test]
fn shutdown_reaps_the_owned_descendant_tree_and_preserves_an_unrelated_fixture() {
    let directory = tempdir().unwrap();
    let mut witness = Witness(
        Command::new(executable())
            .arg("sleep")
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let mut host = launch("descendant", directory.path());
    let id = initialize(&mut host);
    let events = until(&mut host, TEST_WAIT, |events| {
        response(events, id).is_some()
        && events.iter().any(|event| matches!(event, HostEvent::Notification { method, .. } if method == "fixture.descendant"))
    });
    host.mark_ready().unwrap();
    let descendant_pid = events
        .iter()
        .find_map(|event| match event {
            HostEvent::Notification { method, params } if method == "fixture.descendant" => {
                Some(params["pid"].as_u64().unwrap() as u32)
            }
            _ => None,
        })
        .unwrap();
    let descendant = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, descendant_pid) };
    assert!(!descendant.is_null());
    let descendant = unsafe { OwnedHandle::from_raw_handle(descendant.cast()) };
    assert_eq!(
        unsafe { WaitForSingleObject(raw(&descendant), 0) },
        WAIT_TIMEOUT
    );
    let started = Instant::now();
    let report = host.stop().unwrap();
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(report.forced && report.workers_reaped);
    let descendant_wait = unsafe { WaitForSingleObject(raw(&descendant), 0) };
    assert_eq!(
        descendant_wait, WAIT_OBJECT_0,
        "stop returned {report:?}, but owned descendant {descendant_pid} remained nonsignaled with wait result {descendant_wait}"
    );
    assert!(
        witness.0.try_wait().unwrap().is_none(),
        "shutdown reached an unrelated process"
    );
}

struct Witness(Child);
impl Drop for Witness {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn raw(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle().cast()
}
