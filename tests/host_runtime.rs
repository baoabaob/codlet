#![cfg(windows)]

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use codlet::cdp::CdpClient;
use codlet::host_runtime::HostRuntime;
use codlet::js_runtime::JsRuntime;
use codlet::local_plugins::load_local_plugin;
use codlet::plugin_execution::ExecutionState;
use codlet::plugins::{LoadedPlugin, Permission};
use codlet::windows::process::{ChildProcess, launch_with_cdp_pipes};
use serde_json::{Value, json};
use tempfile::tempdir;

const WAIT: Duration = Duration::from_secs(8);
const EXAMPLE: &str = include_str!("../examples/raw-host/dist/host.js");

struct CdpPeer {
    client: CdpClient,
    child: ChildProcess,
}
impl CdpPeer {
    fn start(scenario: &str) -> Self {
        let (child, pipes) = launch_with_cdp_pipes(
            &PathBuf::from(env!("CARGO_BIN_EXE_codlet-fake-child")),
            &[OsString::from(format!("--scenario={scenario}"))],
            true,
        )
        .unwrap();
        let (client, events) = CdpClient::spawn(pipes).unwrap();
        drop(events);
        Self { client, child }
    }
    fn request(&self, method: &str) -> Value {
        self.client
            .request(method, None, None, WAIT)
            .unwrap()
            .result
            .unwrap()
    }
}
impl Drop for CdpPeer {
    fn drop(&mut self) {
        let _ = self.client.shutdown();
        let _ = self.child.wait(WAIT);
    }
}

fn js_runtime() -> JsRuntime {
    JsRuntime::from_distribution(Path::new(env!("CARGO_BIN_EXE_codlet")).parent().unwrap()).expect(
        "stage the pinned runtime with scripts/Install-JsRuntime.ps1 -Destination <target/debug>",
    )
}

fn plugin(directory: &Path, id: &str, raw: bool, source: &str) -> (LoadedPlugin, PathBuf) {
    let root = directory.join(id);
    std::fs::create_dir_all(root.join("dist")).unwrap();
    std::fs::write(root.join("dist/host.js"), source).unwrap();
    let mut grants = vec![Permission::HostProcess];
    if raw {
        grants.push(Permission::CdpRaw);
    }
    std::fs::write(root.join("codlet.json"), json!({"schema":1,"id":id,"version":"1","host":{"entry":"dist/host.js"},"permissions":grants}).to_string()).unwrap();
    std::fs::write(
        root.join("settings.json"),
        json!({"report":"report.json","expression":"'literal host expression'"}).to_string(),
    )
    .unwrap();
    let loaded = load_local_plugin(id, &root, &grants, 11).unwrap();
    assert!(loaded.source.is_none() && loaded.manifest.renderer.is_none());
    (loaded, root.join("report.json"))
}

fn until(runtime: &HostRuntime, settled: impl Fn(&HostRuntime) -> bool) {
    let deadline = Instant::now() + WAIT;
    while !settled(runtime) {
        assert!(
            Instant::now() < deadline,
            "host runtime did not settle: {:?}",
            runtime.take_diagnostics()
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn state(runtime: &HostRuntime, id: &str) -> Option<ExecutionState> {
    runtime
        .observations()
        .iter()
        .find(|item| item.plugin.manifest.id == id)
        .map(|item| item.state)
}
fn read_report(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

#[test]
fn js_host_uses_raw_sessions_events_and_delayed_targets_without_a_renderer_or_official_plugin() {
    let directory = tempdir().unwrap();
    let peer = CdpPeer::start("raw-host-cdp-delayed");
    let (loaded, report_path) = plugin(directory.path(), "dev.js-good", true, EXAMPLE);
    // A changed entry on disk cannot silently replace an already loaded source.
    std::fs::write(
        directory.path().join("dev.js-good/dist/host.js"),
        "throw new Error('wrong generation');",
    )
    .unwrap();
    let mut runtime =
        HostRuntime::start_with_runtime(vec![loaded], peer.client.clone(), Some(js_runtime()))
            .unwrap();
    until(&runtime, |runtime| {
        state(runtime, "dev.js-good") == Some(ExecutionState::Active)
    });
    let report = read_report(&report_path);
    assert_eq!(report["ready"], true);
    assert_eq!(report["targetId"], "arbitrary-worker");
    assert_eq!(report["sessionId"], "raw-session-1");
    assert_eq!(report["evaluation"]["result"]["value"], "raw-host-title");
    assert_eq!(
        report["evaluation"]["observedExpression"],
        "'literal host expression'"
    );
    let events = report["events"].as_array().unwrap();
    assert!(
        events
            .iter()
            .any(|event| event["method"] == "Runtime.executionContextCreated")
    );
    assert!(
        events
            .iter()
            .all(|event| event["sessionId"] == "raw-session-1")
    );
    let trace = peer.request("Fixture.trace");
    assert_eq!(
        trace["requests"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|request| request["method"] == "Target.getTargets")
            .count(),
        3
    );
    assert_eq!(trace["liveSessions"], json!([]));
    let stopped = runtime.stop().unwrap();
    let exit = stopped[0].result.as_ref().unwrap();
    assert_eq!(exit.exit_code, 0);
    assert!(exit.workers_reaped && !exit.forced);
    assert_eq!(peer.request("Fixture.ping")["alive"], true);
}

#[test]
fn denied_core_permission_and_bad_js_protocol_leave_other_plugins_and_cdp_alive() {
    let directory = tempdir().unwrap();
    let peer = CdpPeer::start("raw-host-cdp");
    let (denied, denied_report) = plugin(directory.path(), "dev.js-denied", false, EXAMPLE);
    let (bad, _) = plugin(
        directory.path(),
        "dev.js-bad",
        true,
        "module.exports = { activate() { process.stdout.write('{bad-json}\\n'); }, deactivate() {} };",
    );
    let (good, report) = plugin(directory.path(), "dev.js-good", true, EXAMPLE);
    let mut runtime = HostRuntime::start_with_runtime(
        vec![denied, bad, good],
        peer.client.clone(),
        Some(js_runtime()),
    )
    .unwrap();
    until(&runtime, |runtime| {
        state(runtime, "dev.js-denied") == Some(ExecutionState::Failed)
            && state(runtime, "dev.js-bad") == Some(ExecutionState::Failed)
            && state(runtime, "dev.js-good") == Some(ExecutionState::Active)
    });
    assert_eq!(
        read_report(&denied_report)["error"]["code"],
        "permission_denied"
    );
    assert_eq!(read_report(&report)["ready"], true);
    assert_eq!(
        peer.request("Fixture.trace")["requests"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|request| request["method"] == "Target.getTargets")
            .count(),
        1
    );
    assert!(
        runtime
            .stop()
            .unwrap()
            .iter()
            .all(|report| report.result.as_ref().is_ok_and(|exit| exit.workers_reaped))
    );
    assert_eq!(peer.request("Fixture.ping")["alive"], true);
}

#[test]
fn managed_js_disables_native_addons_and_runtime_ts_and_preserves_package_modules_and_cleanup() {
    let directory = tempdir().unwrap();
    let peer = CdpPeer::start("raw-host-cdp");
    let source = r#"
        const fs = require('node:fs'); const path = require('node:path');
        const helper = require('./helper.js');
        let root;
        module.exports = {
            activate(context) {
                root = context.root;
                let addonError, tsError;
                try { require('./native.node'); } catch (error) { addonError = error.code; }
                try { require('./source.ts'); } catch (error) { tsError = error.name; }
                console.log('this is stderr, not JSONL');
                fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({
                    addonError, tsError, helper, root, version: process.version,
                    nodeOptions: process.env.NODE_OPTIONS ?? null,
                    nodePath: process.env.NODE_PATH ?? null,
                    id: context.plugin.id, generation: context.plugin.generation
                }));
            },
            deactivate() { fs.writeFileSync(path.join(root, 'deactivated.txt'), 'done'); }
        };
    "#;
    let (loaded, report_path) = plugin(directory.path(), "dev.js-abi", false, source);
    let root = directory.path().join("dev.js-abi");
    std::fs::write(
        root.join("dist/helper.js"),
        "module.exports = 'pure-js-dependency';",
    )
    .unwrap();
    std::fs::write(root.join("dist/native.node"), b"MZ").unwrap();
    std::fs::write(
        root.join("dist/source.ts"),
        "export const value: number = 3;",
    )
    .unwrap();
    let mut runtime =
        HostRuntime::start_with_runtime(vec![loaded], peer.client.clone(), Some(js_runtime()))
            .unwrap();
    until(&runtime, |runtime| {
        state(runtime, "dev.js-abi") == Some(ExecutionState::Active)
    });
    let report = read_report(&report_path);
    assert_eq!(report["addonError"], "ERR_DLOPEN_DISABLED");
    assert_eq!(report["tsError"], "SyntaxError");
    assert_eq!(report["helper"], "pure-js-dependency");
    assert_eq!(report["version"], "v24.21.0");
    assert_eq!(report["nodeOptions"], Value::Null);
    assert_eq!(report["nodePath"], Value::Null);
    assert_eq!(report["id"], "dev.js-abi");
    assert_eq!(report["generation"], 11);
    assert!(
        runtime.stop().unwrap()[0]
            .result
            .as_ref()
            .is_ok_and(|exit| !exit.forced && exit.exit_code == 0 && exit.workers_reaped)
    );
    assert_eq!(
        std::fs::read_to_string(root.join("deactivated.txt")).unwrap(),
        "done"
    );
}

#[test]
fn missing_or_replaced_managed_runtime_is_rejected_without_a_path_fallback() {
    let directory = tempdir().unwrap();
    assert_eq!(
        JsRuntime::from_distribution(directory.path())
            .err()
            .unwrap()
            .code,
        "js_runtime_missing"
    );
    let runtime = directory.path().join("runtime/node-v24.21.0-win-x64");
    std::fs::create_dir_all(&runtime).unwrap();
    std::fs::write(runtime.join("node.exe"), b"MZ-not-the-pinned-runtime").unwrap();
    std::fs::write(runtime.join("LICENSE"), b"not-the-pinned-license").unwrap();
    assert_eq!(
        JsRuntime::from_distribution(directory.path())
            .err()
            .unwrap()
            .code,
        "js_runtime_mismatch"
    );
}
