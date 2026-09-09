#![cfg(windows)]

use std::ffi::OsString;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use codlet::cdp::CdpClient;
use codlet::host_runtime::{HostOperation, HostOperationResult, HostRuntime};
use codlet::js_runtime::JsRuntime;
use codlet::local_plugins::load_local_plugin;
use codlet::plugin_execution::ExecutionState;
use codlet::plugin_host::{HostError, HostExitReport};
use codlet::plugins::{LoadedPlugin, Permission};
use codlet::windows::process::{ChildProcess, launch_with_cdp_pipes};
use serde_json::{Value, json};
use tempfile::tempdir;
use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
};

const WAIT: Duration = Duration::from_secs(9);
const HEARTBEAT: &str = r#"
const fs = require('node:fs');
let timer;
module.exports = {
  async activate(context) {
    let count = 0;
    const tick = async () => {
      if (context.signal.aborted) return;
      await context.cdp.request('Fixture.ping');
      fs.writeFileSync('heartbeat.txt', String(++count));
      if (!context.signal.aborted) timer = setTimeout(tick, 25);
    };
    await tick();
  },
  deactivate() { clearTimeout(timer); }
};
"#;
const ORDINARY: &str = r#"
const fs = require('node:fs');
module.exports = {
  async activate(context) {
    await context.cdp.request('Fixture.ping');
    fs.writeFileSync('report.json', JSON.stringify({ pid:process.pid, snapshot:process.argv[2], generation:context.plugin.generation }));
  },
  async deactivate() {
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.writeFileSync('deactivated.txt', 'done');
  }
};
"#;

struct Peer {
    client: CdpClient,
    child: ChildProcess,
}

impl Peer {
    fn start() -> Self {
        let (child, pipes) = launch_with_cdp_pipes(
            &PathBuf::from(env!("CARGO_BIN_EXE_codlet-fake-child")),
            &[OsString::from("--scenario=raw-host-cdp")],
            true,
        )
        .unwrap();
        let (client, events) = CdpClient::spawn(pipes).unwrap();
        drop(events);
        Self { client, child }
    }

    fn ping(&self) {
        assert_eq!(
            self.client
                .request("Fixture.ping", None, None, WAIT)
                .unwrap()
                .result
                .unwrap()["alive"],
            true
        );
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        let _ = self.client.shutdown();
        let _ = self.child.wait(WAIT);
    }
}

fn runtime(peer: &Peer) -> HostRuntime {
    let runtime =
        JsRuntime::from_distribution(Path::new(env!("CARGO_BIN_EXE_codlet")).parent().unwrap())
            .unwrap();
    HostRuntime::start_with_runtime(Vec::new(), peer.client.clone(), Some(runtime)).unwrap()
}

fn plugin(directory: &Path, id: &str, generation: u64, source: &str) -> LoadedPlugin {
    let root = directory.join(id);
    std::fs::create_dir_all(root.join("dist")).unwrap();
    std::fs::write(root.join("dist/host.js"), source).unwrap();
    let grants = [Permission::HostProcess, Permission::CdpRaw];
    std::fs::write(root.join("codlet.json"), json!({"schema":1,"id":id,"version":"1","host":{"entry":"dist/host.js"},"permissions":grants}).to_string()).unwrap();
    load_local_plugin(id, &root, &grants, generation).unwrap()
}

fn result(operation: &mut HostOperation) -> Result<HostOperationResult, HostError> {
    let deadline = Instant::now() + WAIT;
    loop {
        if let Some(result) = operation.try_result() {
            assert!(
                operation.try_result().is_none(),
                "a lifecycle receipt may complete only once"
            );
            return result;
        }
        assert!(
            Instant::now() < deadline,
            "host operation did not reach a terminal result"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn started(runtime: &HostRuntime, plugin: LoadedPlugin) -> u32 {
    match result(&mut runtime.begin_start(plugin).unwrap()).unwrap() {
        HostOperationResult::Started { process_id, .. } => process_id,
        other => panic!("expected Started, got {other:?}"),
    }
}

fn stopped(runtime: &HostRuntime, id: &str, generation: u64) -> HostExitReport {
    match result(&mut runtime.begin_stop(id, generation).unwrap()).unwrap() {
        HostOperationResult::Stopped { report, .. } => report,
        other => panic!("expected Stopped, got {other:?}"),
    }
}

fn report(directory: &Path, id: &str) -> Value {
    serde_json::from_slice(&std::fs::read(directory.join(id).join("report.json")).unwrap()).unwrap()
}

fn heartbeat(directory: &Path) -> u64 {
    let deadline = Instant::now() + WAIT;
    loop {
        if let Ok(source) = std::fs::read_to_string(directory.join("dev.guardian/heartbeat.txt"))
            && let Ok(count) = source.parse()
        {
            return count;
        }
        assert!(
            Instant::now() < deadline,
            "guardian did not answer Core requests"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn wait_report(directory: &Path, id: &str) -> Value {
    let deadline = Instant::now() + WAIT;
    loop {
        if let Ok(bytes) = std::fs::read(directory.join(id).join("report.json"))
            && let Ok(value) = serde_json::from_slice(&bytes)
        {
            return value;
        }
        assert!(Instant::now() < deadline, "plugin did not enter activation");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn process_handle(pid: u32) -> OwnedHandle {
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    assert!(
        !handle.is_null(),
        "test process should still be alive: {}",
        std::io::Error::last_os_error()
    );
    let handle = unsafe { OwnedHandle::from_raw_handle(handle.cast()) };
    assert_eq!(
        unsafe { WaitForSingleObject(handle.as_raw_handle().cast(), 0) },
        WAIT_TIMEOUT
    );
    handle
}

fn retired(handle: &OwnedHandle, snapshot: &Path) {
    assert_eq!(
        unsafe { WaitForSingleObject(handle.as_raw_handle().cast(), 0) },
        WAIT_OBJECT_0
    );
    assert!(
        !snapshot.exists(),
        "retired generation left its source snapshot behind"
    );
}

#[test]
fn online_enable_reload_disable_and_reenable_preserve_other_hosts_and_release_each_generation() {
    let directory = tempdir().unwrap();
    let peer = Peer::start();
    let mut runtime = runtime(&peer);
    assert!(runtime.observations().is_empty());
    started(
        &runtime,
        plugin(directory.path(), "dev.guardian", 1, HEARTBEAT),
    );
    started(
        &runtime,
        plugin(directory.path(), "dev.target", 1, ORDINARY),
    );
    let first = report(directory.path(), "dev.target");
    let first_handle = process_handle(first["pid"].as_u64().unwrap() as u32);
    let first_snapshot = PathBuf::from(first["snapshot"].as_str().unwrap());
    assert!(first_snapshot.exists());
    let initial_heartbeat = heartbeat(directory.path());
    assert_eq!(
        result(
            &mut runtime
                .begin_start(plugin(directory.path(), "dev.target", 2, ORDINARY))
                .unwrap()
        )
        .unwrap_err()
        .code,
        "host_busy"
    );
    let mut retiring = runtime.begin_stop("dev.target", 1).unwrap();
    assert_eq!(
        result(
            &mut runtime
                .begin_start(plugin(directory.path(), "dev.target", 2, ORDINARY))
                .unwrap()
        )
        .unwrap_err()
        .code,
        "host_busy"
    );
    let HostOperationResult::Stopped { report: exit, .. } = result(&mut retiring).unwrap() else {
        panic!("expected stop");
    };
    assert!(exit.workers_reaped && !exit.forced && exit.exit_code == 0);
    retired(&first_handle, &first_snapshot);
    assert!(heartbeat(directory.path()) > initial_heartbeat);
    for generation in 2..=6 {
        started(
            &runtime,
            plugin(directory.path(), "dev.target", generation, ORDINARY),
        );
        let current = report(directory.path(), "dev.target");
        let handle = process_handle(current["pid"].as_u64().unwrap() as u32);
        assert_eq!(current["generation"], generation);
        assert_eq!(
            result(&mut runtime.begin_stop("dev.target", generation - 1).unwrap())
                .unwrap_err()
                .code,
            "stale_generation"
        );
        assert!(
            runtime
                .observations()
                .iter()
                .any(|item| item.plugin.manifest.id == "dev.target"
                    && item.plugin.generation == generation
                    && item.state == ExecutionState::Active)
        );
        let exit = stopped(&runtime, "dev.target", generation);
        assert!(exit.workers_reaped && !exit.forced);
        retired(&handle, Path::new(current["snapshot"].as_str().unwrap()));
        assert_eq!(
            runtime.observations().len(),
            2,
            "old generations must not accumulate"
        );
        peer.ping();
    }
    stopped(&runtime, "dev.guardian", 1);
    started(
        &runtime,
        plugin(directory.path(), "dev.target", 7, ORDINARY),
    );
    assert!(!stopped(&runtime, "dev.target", 7).forced);
    assert_eq!(
        result(
            &mut runtime
                .begin_start(plugin(directory.path(), "dev.target", 7, ORDINARY))
                .unwrap()
        )
        .unwrap_err()
        .code,
        "stale_generation"
    );
    assert!(
        runtime
            .stop()
            .unwrap()
            .iter()
            .all(|report| report.result.as_ref().is_ok_and(|exit| exit.workers_reaped))
    );
}

#[test]
fn failed_and_timed_out_starts_retire_before_completion_and_never_reuse_their_generation() {
    let directory = tempdir().unwrap();
    let peer = Peer::start();
    let mut runtime = runtime(&peer);
    started(
        &runtime,
        plugin(directory.path(), "dev.guardian", 1, HEARTBEAT),
    );
    for (generation, behavior, expected) in [
        (
            1,
            "throw new Error('activation fixture');",
            "initialize_failed",
        ),
        (2, "return new Promise(() => {});", "startup_timeout"),
    ] {
        let source = format!(
            "const fs = require('node:fs'); module.exports = {{ activate() {{ fs.writeFileSync('report.json', JSON.stringify({{snapshot:process.argv[2], pid:process.pid}})); {behavior} }}, deactivate() {{}} }};"
        );
        let before = heartbeat(directory.path());
        let mut operation = runtime
            .begin_start(plugin(directory.path(), "dev.failure", generation, &source))
            .unwrap();
        let error = result(&mut operation).unwrap_err();
        assert_eq!(error.code, expected);
        let current = report(directory.path(), "dev.failure");
        assert!(!Path::new(current["snapshot"].as_str().unwrap()).exists());
        assert!(
            runtime
                .observations()
                .iter()
                .any(|item| item.plugin.manifest.id == "dev.failure"
                    && item.state == ExecutionState::Failed)
        );
        assert_eq!(
            result(
                &mut runtime
                    .begin_start(plugin(
                        directory.path(),
                        "dev.failure",
                        generation,
                        ORDINARY
                    ))
                    .unwrap()
            )
            .unwrap_err()
            .code,
            "stale_generation"
        );
        assert!(stopped(&runtime, "dev.failure", generation).workers_reaped);
        assert!(heartbeat(directory.path()) > before);
        peer.ping();
    }
    started(
        &runtime,
        plugin(directory.path(), "dev.failure", 3, ORDINARY),
    );
    stopped(&runtime, "dev.failure", 3);
    runtime.stop().unwrap();
}

#[test]
fn forced_stop_confirms_the_plugin_job_is_empty_while_another_host_keeps_serving_core() {
    let directory = tempdir().unwrap();
    let peer = Peer::start();
    let mut runtime = runtime(&peer);
    started(
        &runtime,
        plugin(directory.path(), "dev.guardian", 1, HEARTBEAT),
    );
    let source = r#"
        const fs = require('node:fs'); const {spawn} = require('node:child_process');
        module.exports = {
            activate() {
                const child = spawn(process.execPath, ['--no-addons', '--no-experimental-strip-types', '--eval', 'setInterval(()=>{},1000)'], {windowsHide:true, stdio:'ignore'});
                fs.writeFileSync('report.json', JSON.stringify({pid:process.pid, descendant:child.pid, snapshot:process.argv[2]}));
            },
            deactivate() { return new Promise(() => {}); }
        };
    "#;
    started(
        &runtime,
        plugin(directory.path(), "dev.stubborn", 1, source),
    );
    let current = report(directory.path(), "dev.stubborn");
    let parent = process_handle(current["pid"].as_u64().unwrap() as u32);
    let descendant = process_handle(current["descendant"].as_u64().unwrap() as u32);
    let before = heartbeat(directory.path());
    let mut operation = runtime.begin_stop("dev.stubborn", 1).unwrap();
    assert_eq!(
        result(&mut runtime.begin_stop("dev.stubborn", 1).unwrap())
            .unwrap_err()
            .code,
        "host_busy"
    );
    let HostOperationResult::Stopped { report: exit, .. } = result(&mut operation).unwrap() else {
        panic!("expected stop");
    };
    assert!(exit.forced && exit.workers_reaped);
    retired(&parent, Path::new(current["snapshot"].as_str().unwrap()));
    assert_eq!(
        unsafe { WaitForSingleObject(descendant.as_raw_handle().cast(), 0) },
        WAIT_OBJECT_0
    );
    assert!(heartbeat(directory.path()) >= before + 5);
    peer.ping();
    started(
        &runtime,
        plugin(directory.path(), "dev.stubborn", 2, ORDINARY),
    );
    runtime.stop().unwrap();
}

#[test]
fn stop_cancels_initialization_and_an_old_receipt_cannot_touch_the_replacement() {
    let directory = tempdir().unwrap();
    let peer = Peer::start();
    let mut runtime = runtime(&peer);
    let source = r#"
        const fs = require('node:fs');
        module.exports = {
            activate(context) {
                fs.writeFileSync('report.json', JSON.stringify({pid:process.pid, snapshot:process.argv[2]}));
                return new Promise(resolve => context.signal.addEventListener('abort', resolve, {once:true}));
            },
            deactivate() { fs.writeFileSync('deactivated.txt', 'cancelled'); }
        };
    "#;
    let mut starting = runtime
        .begin_start(plugin(directory.path(), "dev.cancelled", 1, source))
        .unwrap();
    let current = wait_report(directory.path(), "dev.cancelled");
    let process = process_handle(current["pid"].as_u64().unwrap() as u32);
    let mut stopping = runtime.begin_stop("dev.cancelled", 1).unwrap();
    assert_eq!(
        result(&mut starting).unwrap_err().code,
        "initialize_cancelled"
    );
    let HostOperationResult::Stopped { report: exit, .. } = result(&mut stopping).unwrap() else {
        panic!("expected stop");
    };
    assert!(!exit.forced && exit.workers_reaped && exit.exit_code == 0);
    retired(&process, Path::new(current["snapshot"].as_str().unwrap()));
    assert_eq!(
        std::fs::read_to_string(directory.path().join("dev.cancelled/deactivated.txt")).unwrap(),
        "cancelled"
    );
    started(
        &runtime,
        plugin(directory.path(), "dev.cancelled", 2, ORDINARY),
    );
    assert!(starting.try_result().is_none() && stopping.try_result().is_none());
    assert_eq!(
        result(&mut runtime.begin_stop("dev.cancelled", 1).unwrap())
            .unwrap_err()
            .code,
        "stale_generation"
    );
    peer.ping();
    runtime.stop().unwrap();
}

#[test]
fn a_session_with_no_js_runtime_discovers_it_on_first_enable_and_can_enable_again() {
    let directory = tempdir().unwrap();
    let peer = Peer::start();
    // The test executable uses its own distribution directory, exercising the
    // same current_exe-based discovery as a production session with zero hosts.
    let mut runtime = HostRuntime::start(Vec::new(), peer.client.clone()).unwrap();
    assert!(runtime.observations().is_empty());
    for generation in [1, 2] {
        started(
            &runtime,
            plugin(directory.path(), "dev.lazy-runtime", generation, ORDINARY),
        );
        let current = report(directory.path(), "dev.lazy-runtime");
        let handle = process_handle(current["pid"].as_u64().unwrap() as u32);
        let exit = stopped(&runtime, "dev.lazy-runtime", generation);
        assert!(exit.workers_reaped && !exit.forced && exit.exit_code == 0);
        retired(&handle, Path::new(current["snapshot"].as_str().unwrap()));
        peer.ping();
    }
    runtime.stop().unwrap();
}
