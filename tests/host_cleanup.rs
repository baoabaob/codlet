#![cfg(windows)]

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use codlet::cdp::CdpClient;
use codlet::host_runtime::{
    HostCleanupPhase, HostOperation, HostOperationResult, HostPluginSnapshot, HostRuntime,
};
use codlet::js_runtime::JsRuntime;
use codlet::local_plugins::load_local_plugin;
use codlet::plugin_execution::{ExecutionState, HostRuntimeSnapshot};
use codlet::plugin_host::{HostError, HostExitReport};
use codlet::plugins::{LoadedPlugin, Permission};
use codlet::windows::process::{ChildProcess, launch_with_cdp_pipes};
use serde_json::{Value, json};
use tempfile::tempdir;

const WAIT: Duration = Duration::from_secs(8);
const EXAMPLE: &str = include_str!("../examples/cleanup-host/dist/host.js");
const GUARDIAN: &str = r#"
const fs = require('node:fs'); let timer;
module.exports = {
 async activate(context) {
  let count = 0;
  const tick = async () => {
   if(context.signal.aborted) return;
   try { await context.cdp.request('Fixture.ping'); } catch(error) { if(context.signal.aborted) return; throw error; }
   fs.writeFileSync('heartbeat.txt', String(++count));
   if(!context.signal.aborted) timer = setTimeout(tick, 25);
  };
  await tick();
 },
 deactivate() { clearTimeout(timer); }
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
    fn request(&self, method: &str) -> Value {
        self.client
            .request(method, None, None, WAIT)
            .unwrap()
            .result
            .unwrap()
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
    HostRuntime::start_with_runtime(vec![], peer.client.clone(), Some(runtime)).unwrap()
}
fn plugin(directory: &Path, id: &str, generation: u64, raw: bool, source: &str) -> LoadedPlugin {
    let root = directory.join(id);
    std::fs::create_dir_all(root.join("dist")).unwrap();
    std::fs::write(root.join("dist/host.js"), source).unwrap();
    let mut permissions = vec![Permission::HostProcess];
    if raw {
        permissions.push(Permission::CdpRaw);
    }
    std::fs::write(root.join("codlet.json"), json!({"schema":1,"id":id,"version":"1","host":{"entry":"dist/host.js"},"permissions":permissions}).to_string()).unwrap();
    load_local_plugin(id, &root, &permissions, generation).unwrap()
}
fn wait(mut operation: HostOperation) -> Result<HostOperationResult, HostError> {
    let deadline = Instant::now() + WAIT;
    loop {
        if let Some(result) = operation.try_result() {
            return result;
        }
        assert!(Instant::now() < deadline, "operation did not complete");
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn start(runtime: &HostRuntime, plugin: LoadedPlugin) {
    assert!(matches!(
        wait(runtime.begin_start(plugin).unwrap()).unwrap(),
        HostOperationResult::Started { .. }
    ));
}
fn stop(runtime: &HostRuntime, id: &str, generation: u64) -> HostExitReport {
    let HostOperationResult::Stopped { report, .. } =
        wait(runtime.begin_stop(id, generation).unwrap()).unwrap()
    else {
        panic!("expected stop");
    };
    report
}
fn sample(runtime: &HostRuntime, id: &str) -> HostPluginSnapshot {
    runtime
        .execution_snapshot()
        .plugins
        .into_iter()
        .find(|plugin| plugin.id == id)
        .unwrap()
}
fn until(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !condition() {
        assert!(Instant::now() < deadline, "condition did not settle");
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn beats(directory: &Path) -> u64 {
    let mut count = None;
    until(|| {
        count = std::fs::read_to_string(directory.join("dev.guardian/heartbeat.txt"))
            .ok()
            .and_then(|value| value.parse().ok());
        count.is_some()
    });
    count.unwrap()
}

#[test]
fn persistent_raw_example_removes_its_marker_and_detaches_during_online_and_global_stop() {
    let directory = tempdir().unwrap();
    let peer = Peer::start();
    let mut runtime = runtime(&peer);
    for generation in [1, 2] {
        start(
            &runtime,
            plugin(
                directory.path(),
                "dev.cleanup-example",
                generation,
                true,
                EXAMPLE,
            ),
        );
        assert_eq!(
            peer.request("Fixture.trace")["liveSessions"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let before = runtime.execution_snapshot();
        if generation == 1 {
            let report = stop(&runtime, "dev.cleanup-example", generation);
            assert!(report.workers_reaped && !report.forced && report.exit_code == 0);
        } else {
            runtime.stop().unwrap();
        }
        let after = runtime.execution_snapshot();
        assert!(
            after.sequence > before.sequence
                && after.sampled_at_unix_ms >= before.sampled_at_unix_ms
        );
        let plugin = sample(&runtime, "dev.cleanup-example");
        assert_eq!(plugin.cleanup.phase, HostCleanupPhase::Completed);
        assert_eq!(plugin.state, ExecutionState::Exited);
        assert_eq!(
            plugin.pending_core_requests + plugin.subscriptions + plugin.outbox,
            0
        );
        assert!(plugin.exit.unwrap().workers_reaped);
        let trace = peer.request("Fixture.trace");
        assert_eq!(trace["liveSessions"], json!([]));
        assert!(trace["requests"].as_array().unwrap().iter().any(|request| {
            request["method"] == "Runtime.evaluate"
                && request["params"]["expression"]
                    .as_str()
                    .is_some_and(|expression| expression.starts_with("delete globalThis["))
        }));
        let encoded = serde_json::to_string(&after).unwrap();
        assert!(
            !encoded.contains("module.exports")
                && !encoded.contains("host.js")
                && !encoded.contains("LoadedPlugin")
        );
        assert_eq!(
            serde_json::from_str::<HostRuntimeSnapshot>(&encoded).unwrap(),
            after
        );
    }
    assert!(
        !runtime.execution_snapshot().owner_alive && runtime.execution_snapshot().runtime_stopping
    );
    assert!(runtime.execution_snapshot().history_truncated);
}

#[test]
fn initialization_abort_retires_ordinary_requests_but_deactivate_can_detach_the_partial_session() {
    let directory = tempdir().unwrap();
    let peer = Peer::start();
    let mut runtime = runtime(&peer);
    let source = r#"
      const fs = require('node:fs'); let session, ordinary;
      module.exports = {
       async activate(context) {
        ordinary = context;
        ({sessionId:session} = await context.cdp.request('Target.attachToTarget', {targetId:'arbitrary-worker', flatten:true}));
        await context.cdp.subscribe({scope:'session',sessionId:session}, () => {
          if(context.signal.aborted) fs.writeFileSync('late-event.txt','unexpected');
        });
        await context.cdp.request('Runtime.enable',{}, {sessionId:session});
        fs.writeFileSync('entered.txt','yes');
        await context.cdp.request('Fixture.defer');
        await context.cdp.request('Fixture.record',{unexpected:'late activation'});
       },
       async deactivate(cleanup) {
        try { await ordinary.cdp.request('Fixture.record',{unexpected:'ordinary cleanup'}); } catch(error) { fs.writeFileSync('ordinary-error.txt',error.code); }
        await cleanup.cdp.request('Runtime.evaluate',{expression:'cleanup event fixture'}, {sessionId:session});
        await cleanup.cdp.request('Target.detachFromTarget',{sessionId:session});
       }
      };
    "#;
    let starting = runtime
        .begin_start(plugin(directory.path(), "dev.partial", 1, true, source))
        .unwrap();
    until(|| peer.request("Fixture.trace")["deferred"] == 1);
    assert_eq!(sample(&runtime, "dev.partial").subscriptions, 1);
    let report = stop(&runtime, "dev.partial", 1);
    assert_eq!(wait(starting).unwrap_err().code, "initialize_cancelled");
    assert!(report.exit_code == 0 && !report.forced && report.workers_reaped);
    assert_eq!(
        sample(&runtime, "dev.partial").cleanup.phase,
        HostCleanupPhase::Completed
    );
    assert_eq!(peer.request("Fixture.trace")["liveSessions"], json!([]));
    assert!(!directory.path().join("dev.partial/late-event.txt").exists());
    assert_eq!(sample(&runtime, "dev.partial").subscriptions, 0);
    assert_eq!(
        std::fs::read_to_string(directory.path().join("dev.partial/ordinary-error.txt")).unwrap(),
        "host_stopping"
    );
    start(
        &runtime,
        plugin(
            directory.path(),
            "dev.partial",
            2,
            true,
            "module.exports={activate(context){return context.cdp.request('Fixture.record',{generation:2});},deactivate(){}};",
        ),
    );
    assert_eq!(peer.request("Fixture.release")["released"], 1);
    assert_eq!(
        peer.request("Fixture.trace")["recorded"],
        json!([{"generation":2}])
    );
    assert_eq!(
        sample(&runtime, "dev.partial").state,
        ExecutionState::Active
    );
    runtime.stop().unwrap();
}

#[test]
fn cleanup_calls_share_core_deadline_while_other_hosts_run_and_late_responses_cannot_revive_the_generation()
 {
    let directory = tempdir().unwrap();
    let peer = Peer::start();
    let mut runtime = runtime(&peer);
    start(
        &runtime,
        plugin(directory.path(), "dev.guardian", 1, true, GUARDIAN),
    );
    let source = r#"
      module.exports = { activate(){}, async deactivate(cleanup) {
        await cleanup.cdp.request('Fixture.record',{cleanup:'began'});
        await new Promise(resolve=>setTimeout(resolve,850));
        await cleanup.cdp.request('Fixture.defer',{}, {timeoutMs:15000});
        await cleanup.cdp.request('Fixture.record',{unexpected:'late cleanup'});
      }};
    "#;
    start(
        &runtime,
        plugin(directory.path(), "dev.budget", 1, true, source),
    );
    let before = beats(directory.path());
    let started = Instant::now();
    let stopping = runtime.begin_stop("dev.budget", 1).unwrap();
    until(|| {
        sample(&runtime, "dev.budget").cleanup.pending_requests == 1
            && peer.request("Fixture.trace")["deferred"] == 1
    });
    let observed = sample(&runtime, "dev.budget");
    assert_eq!(observed.state, ExecutionState::Stopping);
    assert_eq!(observed.cleanup.phase, HostCleanupPhase::Running);
    assert!(observed.cleanup.remaining_budget_ms.unwrap() < 800);
    assert_eq!(observed.subscriptions, 0);
    let HostOperationResult::Stopped { report, .. } = wait(stopping).unwrap() else {
        panic!("expected stop");
    };
    assert!(started.elapsed() < Duration::from_millis(2300));
    assert!(report.workers_reaped && (report.forced || report.exit_code != 0));
    assert_eq!(
        sample(&runtime, "dev.budget").cleanup.phase,
        HostCleanupPhase::TimedOut
    );
    assert!(beats(directory.path()) > before + 5);
    start(
        &runtime,
        plugin(
            directory.path(),
            "dev.budget",
            2,
            true,
            "module.exports={activate(context){return context.cdp.request('Fixture.record',{generation:2});},deactivate(){}};",
        ),
    );
    peer.request("Fixture.release");
    assert_eq!(
        peer.request("Fixture.trace")["recorded"],
        json!([{"cleanup":"began"},{"generation":2}])
    );
    assert_eq!(peer.request("Fixture.ping")["alive"], true);
    runtime.stop().unwrap();
}

#[test]
fn cleanup_cannot_add_permissions_and_exceptions_or_blocked_js_have_explicit_exit_facts() {
    let directory = tempdir().unwrap();
    let peer = Peer::start();
    let mut runtime = runtime(&peer);
    for (id, raw, body, phase, forced) in [
        (
            "dev.denied",
            false,
            "return cleanup.cdp.request('Fixture.record',{unexpected:'expanded grants'});",
            HostCleanupPhase::Failed,
            false,
        ),
        (
            "dev.error",
            true,
            "throw new Error('deactivate fixture');",
            HostCleanupPhase::Failed,
            false,
        ),
        (
            "dev.blocked",
            true,
            "while(true) {}",
            HostCleanupPhase::TimedOut,
            true,
        ),
        (
            "dev.protocol",
            true,
            "process.stdout.write('{bad-json}\\n'); return new Promise(() => {});",
            HostCleanupPhase::Failed,
            true,
        ),
    ] {
        let source = format!("module.exports={{activate(){{}},deactivate(cleanup){{{body}}}}};");
        start(&runtime, plugin(directory.path(), id, 1, raw, &source));
        let report = stop(&runtime, id, 1);
        assert!(report.workers_reaped && report.exit_code != 0);
        assert_eq!(report.forced, forced);
        let snapshot = sample(&runtime, id);
        assert_eq!(snapshot.cleanup.phase, phase);
        assert_eq!(snapshot.state, ExecutionState::Failed);
        assert!(snapshot.cleanup.error.is_some());
    }
    assert_eq!(peer.request("Fixture.trace")["recorded"], json!([]));
    assert!(
        sample(&runtime, "dev.denied")
            .cleanup
            .error
            .unwrap()
            .contains("permission_denied")
    );
    runtime.stop().unwrap();
}

#[test]
fn runtime_stop_preserves_an_online_cleanup_request_and_its_original_budget() {
    let directory = tempdir().unwrap();
    let peer = Peer::start();
    let mut runtime = runtime(&peer);
    let source = "module.exports={activate(){},async deactivate(cleanup){await cleanup.cdp.request('Fixture.defer');await cleanup.cdp.request('Fixture.record',{cleaned:true});}};";
    start(
        &runtime,
        plugin(directory.path(), "dev.overlapping-stop", 1, true, source),
    );
    let online = runtime.begin_stop("dev.overlapping-stop", 1).unwrap();
    until(|| {
        sample(&runtime, "dev.overlapping-stop")
            .cleanup
            .pending_requests
            == 1
            && peer.request("Fixture.trace")["deferred"] == 1
    });
    let (entered_sender, entered) = std::sync::mpsc::sync_channel(1);
    let stopping = std::thread::spawn(move || {
        entered_sender.send(()).unwrap();
        let reports = runtime.stop().unwrap();
        (runtime, reports)
    });
    entered.recv_timeout(WAIT).unwrap();
    // Allow the owner to observe whole-runtime stop before the remote response;
    // its 10 ms loop must preserve the cleanup already admitted by online stop.
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(peer.request("Fixture.release")["released"], 1);
    let HostOperationResult::Stopped { report, .. } = wait(online).unwrap() else {
        panic!("expected online stop");
    };
    assert!(report.workers_reaped && !report.forced && report.exit_code == 0);
    let (runtime, reports) = stopping.join().unwrap();
    assert!(reports.iter().all(|report| {
        report
            .result
            .as_ref()
            .is_ok_and(|exit| exit.workers_reaped && !exit.forced && exit.exit_code == 0)
    }));
    assert_eq!(
        sample(&runtime, "dev.overlapping-stop").cleanup.phase,
        HostCleanupPhase::Completed
    );
    assert_eq!(
        peer.request("Fixture.trace")["recorded"],
        json!([{"cleaned":true}])
    );
}
