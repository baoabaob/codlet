#![cfg(windows)]

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use codlet::capabilities::{CapabilityDescriptor, CapabilityScope};
use codlet::cdp::CdpClient;
use codlet::host_runtime::{
    HostCapabilityCaller, HostCapabilityOperation, HostCapabilityRequest, HostOperation,
    HostOperationResult, HostRuntime,
};
use codlet::js_runtime::JsRuntime;
use codlet::local_plugins::load_local_plugin;
use codlet::plugin_execution::ExecutionState;
use codlet::plugin_host::HostError;
use codlet::plugins::{LoadedPlugin, Permission};
use codlet::windows::process::{ChildProcess, launch_with_cdp_pipes};
use serde_json::{Value, json};
use tempfile::tempdir;

const WAIT: Duration = Duration::from_secs(8);
const CAP: &str = "dev.host-capability";
const SOURCE: &str = r#"
const cap = {name:'dev.host-capability',api:1,scope:'target'};
let sessions = [];
module.exports = {
 activate(context) {
  context.rpc.provide(cap,'ping',(params,invocation)=>({params,caller:invocation.caller,pluginId:invocation.pluginId,generation:invocation.generation,frozen:Object.isFrozen(invocation)&&Object.isFrozen(invocation.caller)&&Object.isFrozen(invocation.capability)}));
  context.rpc.provide(cap,'raw',()=>context.cdp.request('Target.getTargets'));
  context.rpc.provide(cap,'hold',()=>new Promise(()=>{}));
  context.rpc.provide(cap,'large',()=>'x'.repeat(1024*1024));
  context.rpc.provide(cap,'throw',()=>{throw Object.assign(new Error('provider rejected'),{code:'fixture_rejected'});});
  context.rpc.provide(cap,'attach',async()=>{const result=await context.cdp.request('Target.attachToTarget',{targetId:'arbitrary-worker',flatten:true});sessions.push(result.sessionId);return result;});
  context.rpc.provide(cap,'defer',()=>context.cdp.request('Fixture.defer',{}, {timeoutMs:15000}));
 },
 async deactivate(cleanup){for(const sessionId of sessions)await cleanup.cdp.request('Target.detachFromTarget',{sessionId});}
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

fn plugin(
    directory: &Path,
    id: &str,
    generation: u64,
    combined: bool,
    source: &str,
) -> LoadedPlugin {
    let root = directory.join(id);
    std::fs::create_dir_all(root.join("dist")).unwrap();
    // Independent providers have distinct declarations in the shared M2
    // registry; the isolation tests must not create a capability conflict.
    let name = format!("{CAP}.{id}");
    std::fs::write(root.join("dist/host.js"), source.replace(CAP, &name)).unwrap();
    let capability = json!({"name":name,"api":1,"scope":"target"});
    let grants = [Permission::HostProcess, Permission::CdpRaw];
    let mut manifest = json!({"schema":1,"id":id,"version":"1","host":{"entry":"dist/host.js"},"permissions":grants});
    if combined {
        manifest["host"]["provides"] = json!([capability]);
        manifest["renderer"] = json!({"entry":"dist/renderer.js","world":"isolated"});
        manifest["requires"] = json!([capability]);
        std::fs::write(
            root.join("dist/renderer.js"),
            "module.exports={activate(){},deactivate(){}};",
        )
        .unwrap();
    } else {
        manifest["provides"] = json!([capability]);
    }
    std::fs::write(root.join("codlet.json"), manifest.to_string()).unwrap();
    load_local_plugin(id, &root, &grants, generation).unwrap()
}
fn runtime(peer: &Peer, plugins: Vec<LoadedPlugin>) -> HostRuntime {
    let distribution = Path::new(env!("CARGO_BIN_EXE_codlet")).parent().unwrap();
    let runtime = HostRuntime::start_with_runtime(
        plugins,
        peer.client.clone(),
        Some(JsRuntime::from_distribution(distribution).unwrap()),
    )
    .unwrap();
    until(|| !runtime.is_starting());
    assert!(
        runtime
            .observations()
            .iter()
            .all(|item| item.state == ExecutionState::Active),
        "{:?}",
        runtime.take_diagnostics()
    );
    runtime
}
fn until(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !predicate() {
        assert!(Instant::now() < deadline, "condition did not settle");
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn request(id: &str, generation: u64, method: &str, budget: Duration) -> HostCapabilityRequest {
    HostCapabilityRequest {
        owner_plugin_id: id.into(),
        expected_generation: generation,
        capability: CapabilityDescriptor::new(format!("{CAP}.{id}"), 1, CapabilityScope::Target)
            .unwrap(),
        method: method.into(),
        params: json!({"caller":{"pluginId":"forged"}}),
        caller: HostCapabilityCaller {
            plugin_id: "dev.renderer".into(),
            generation: 3,
            target_id: "worker-target".into(),
            document_epoch: 17,
        },
        deadline: Instant::now() + budget,
    }
}
fn call(runtime: &HostRuntime, id: &str, generation: u64, method: &str) -> HostCapabilityOperation {
    runtime
        .capability_client()
        .begin_request(request(id, generation, method, Duration::from_secs(3)))
        .unwrap()
}
fn result(mut operation: HostCapabilityOperation) -> Result<Value, HostError> {
    let mut answer = None;
    until(|| {
        answer = operation.try_result();
        answer.is_some()
    });
    assert!(
        operation.try_result().is_none(),
        "receipt must yield one result"
    );
    answer.unwrap()
}
fn lifecycle(mut operation: HostOperation) -> HostOperationResult {
    let mut answer = None;
    until(|| {
        answer = operation.try_result();
        answer.is_some()
    });
    answer.unwrap().unwrap()
}
fn pending(runtime: &HostRuntime, id: &str) -> usize {
    runtime
        .execution_snapshot()
        .plugins
        .iter()
        .find(|plugin| plugin.id == id)
        .unwrap()
        .pending_core_requests
}

#[test]
fn managed_provider_round_trip_accepts_combined_snapshot_and_keeps_completed_resources_owned() {
    let directory = tempdir().unwrap();
    let peer = Peer::start();
    let loaded = plugin(directory.path(), "dev.combined", 11, true, SOURCE);
    assert!(loaded.source.is_some());
    let mut runtime = runtime(&peer, vec![loaded]);
    let value = result(call(&runtime, "dev.combined", 11, "ping")).unwrap();
    assert_eq!(
        value["caller"],
        json!({"pluginId":"dev.renderer","generation":3,"targetId":"worker-target","documentEpoch":17})
    );
    assert_eq!(value["frozen"], true);
    assert_eq!(value["pluginId"], "dev.combined");
    assert_eq!(value["generation"], 11);
    let raw = result(call(&runtime, "dev.combined", 11, "raw")).unwrap();
    assert_eq!(raw["targetInfos"][0]["targetId"], "arbitrary-worker");
    let attached = result(call(&runtime, "dev.combined", 11, "attach")).unwrap();
    assert_eq!(
        peer.request("Fixture.trace")["liveSessions"],
        json!([attached["sessionId"]])
    );
    let stopped = runtime.stop().unwrap();
    let exit = stopped[0].result.as_ref().unwrap();
    assert!(exit.workers_reaped && !exit.forced);
    assert_eq!(exit.exit_code, 0);
    assert_eq!(peer.request("Fixture.trace")["liveSessions"], json!([]));
    assert_eq!(peer.request("Fixture.ping")["alive"], true);
}

#[test]
fn cancelling_a_provider_retires_children_and_core_rejects_a_replayed_invocation_token() {
    let source = r#"
const fs=require('node:fs'),cap={name:'dev.host-capability',api:1,scope:'target'};
let timer,retired=false,report={};
module.exports={activate(context){
 timer=setInterval(async()=>{if(!retired)return;retired=false;
  try{await context.core.request('capability.request',{invocationId:2,method:'cdp.request',params:{method:'Fixture.record',params:{forged:true}}});report.forged='accepted';}
  catch(error){report.forged=error.code;}fs.writeFileSync('retired.json',JSON.stringify(report));
 },10);
 context.rpc.provide(cap,'hold',async(params,invocation)=>{
  try{await context.cdp.request('Fixture.defer',{}, {timeoutMs:15000});}
  catch(error){report.aborted=invocation.signal.aborted;report.code=error.code;
   try{await context.cdp.request('Fixture.record',{late:true});}catch(error){report.continuation=error.code;}
   retired=true;
  }return{late:true};
 });context.rpc.provide(cap,'ping',()=>({alive:true}));
},deactivate(){clearInterval(timer);}};
"#;
    let directory = tempdir().unwrap();
    let peer = Peer::start();
    let mut runtime = runtime(
        &peer,
        vec![plugin(directory.path(), "dev.cancel", 11, false, source)],
    );
    let operation = call(&runtime, "dev.cancel", 11, "hold");
    until(|| pending(&runtime, "dev.cancel") == 1);
    operation.cancel();
    assert_eq!(result(operation).unwrap_err().code, "invocation_cancelled");
    until(|| pending(&runtime, "dev.cancel") == 0);
    let report = directory.path().join("dev.cancel/retired.json");
    until(|| report.exists());
    let report: Value = serde_json::from_slice(&std::fs::read(report).unwrap()).unwrap();
    assert_eq!(
        report,
        json!({"aborted":true,"code":"invocation_cancelled","continuation":"invocation_cancelled","forged":"invocation_cancelled"})
    );
    assert_eq!(peer.request("Fixture.trace")["recorded"], json!([]));
    assert_eq!(peer.request("Fixture.release")["released"], 1);
    assert_eq!(
        result(call(&runtime, "dev.cancel", 11, "ping")).unwrap()["alive"],
        true
    );
    assert!(
        runtime.stop().unwrap()[0]
            .result
            .as_ref()
            .unwrap()
            .workers_reaped
    );
}

#[test]
fn chained_managed_children_share_the_original_deadline_and_late_results_cannot_revive_them() {
    let source = r#"const cap={name:'dev.host-capability',api:1,scope:'target'};module.exports={activate(context){
 context.rpc.provide(cap,'chain',async()=>{await context.cdp.request('Fixture.defer');return context.cdp.request('Fixture.defer',{}, {timeoutMs:15000});});
 context.rpc.provide(cap,'ping',()=>({alive:true}));},deactivate(){}};"#;
    let directory = tempdir().unwrap();
    let peer = Peer::start();
    let mut runtime = runtime(
        &peer,
        vec![plugin(directory.path(), "dev.deadline", 11, false, source)],
    );
    let began = Instant::now();
    let operation = runtime
        .capability_client()
        .begin_request(request(
            "dev.deadline",
            11,
            "chain",
            Duration::from_millis(450),
        ))
        .unwrap();
    until(|| peer.request("Fixture.trace")["deferred"] == 1);
    std::thread::sleep(Duration::from_millis(120));
    assert_eq!(peer.request("Fixture.release")["released"], 1);
    until(|| peer.request("Fixture.trace")["deferred"] == 1);
    assert_eq!(result(operation).unwrap_err().code, "request_timeout");
    assert!(
        began.elapsed() < Duration::from_millis(850),
        "child RPC renewed the invocation deadline"
    );
    until(|| pending(&runtime, "dev.deadline") == 0);
    assert_eq!(peer.request("Fixture.release")["released"], 1);
    assert_eq!(
        result(call(&runtime, "dev.deadline", 11, "ping")).unwrap()["alive"],
        true
    );
    runtime.stop().unwrap();
}

#[test]
fn per_host_and_unconsumed_result_bounds_and_provider_errors_preserve_other_hosts() {
    let directory = tempdir().unwrap();
    let peer = Peer::start();
    let mut runtime = runtime(
        &peer,
        vec![
            plugin(directory.path(), "dev.busy", 11, false, SOURCE),
            plugin(directory.path(), "dev.other", 11, false, SOURCE),
        ],
    );
    let active: Vec<_> = (0..4)
        .map(|_| call(&runtime, "dev.busy", 11, "hold"))
        .collect();
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(
        result(call(&runtime, "dev.busy", 11, "hold"))
            .unwrap_err()
            .code,
        "request_limit"
    );
    assert_eq!(
        result(call(&runtime, "dev.other", 11, "ping")).unwrap()["pluginId"],
        "dev.other"
    );
    drop(active);
    std::thread::sleep(Duration::from_millis(100));
    for (method, code) in [
        ("large", "response_too_large"),
        ("missing", "method_not_found"),
        ("throw", "provider_error"),
    ] {
        assert_eq!(
            result(call(&runtime, "dev.other", 11, method))
                .unwrap_err()
                .code,
            code
        );
    }
    let mut retained = Vec::new();
    for _ in 0..16 {
        retained.push(call(&runtime, "dev.other", 11, "ping"));
        std::thread::sleep(Duration::from_millis(30));
    }
    let error = runtime
        .capability_client()
        .begin_request(request("dev.other", 11, "ping", Duration::from_secs(2)))
        .err()
        .unwrap();
    assert_eq!(error.code, "request_limit");
    drop(retained);
    assert_eq!(
        result(call(&runtime, "dev.other", 11, "ping")).unwrap()["pluginId"],
        "dev.other"
    );
    let mut undeclared = request("dev.other", 11, "ping", Duration::from_secs(2));
    undeclared.capability = CapabilityDescriptor::new(CAP, 2, CapabilityScope::Target).unwrap();
    assert_eq!(
        result(
            runtime
                .capability_client()
                .begin_request(undeclared)
                .unwrap()
        )
        .unwrap_err()
        .code,
        "undeclared_capability"
    );
    let mut expired = request("dev.other", 11, "ping", Duration::from_secs(2));
    expired.deadline = Instant::now();
    assert_eq!(
        runtime
            .capability_client()
            .begin_request(expired)
            .err()
            .unwrap()
            .code,
        "request_timeout"
    );
    let mut oversized = request("dev.other", 11, "ping", Duration::from_secs(2));
    oversized.params = json!("x".repeat(1024 * 1024));
    assert_eq!(
        runtime
            .capability_client()
            .begin_request(oversized)
            .err()
            .unwrap()
            .code,
        "request_too_large"
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
fn stop_and_new_generation_retire_old_operations_without_attaching_late_child_replies() {
    let directory = tempdir().unwrap();
    let peer = Peer::start();
    let mut runtime = runtime(
        &peer,
        vec![plugin(directory.path(), "dev.reload", 11, false, SOURCE)],
    );
    let old = call(&runtime, "dev.reload", 11, "defer");
    until(|| pending(&runtime, "dev.reload") == 1);
    let stopped = lifecycle(runtime.begin_stop("dev.reload", 11).unwrap());
    assert!(
        matches!(stopped, HostOperationResult::Stopped { report, .. } if report.workers_reaped && !report.forced && report.exit_code == 0)
    );
    assert_eq!(result(old).unwrap_err().code, "host_stopping");
    let loaded = plugin(directory.path(), "dev.reload", 12, false, SOURCE);
    assert!(matches!(
        lifecycle(runtime.begin_start(loaded).unwrap()),
        HostOperationResult::Started { generation: 12, .. }
    ));
    assert_eq!(
        result(call(&runtime, "dev.reload", 11, "ping"))
            .unwrap_err()
            .code,
        "stale_generation"
    );
    assert_eq!(peer.request("Fixture.release")["released"], 1);
    assert_eq!(
        result(call(&runtime, "dev.reload", 12, "ping")).unwrap()["generation"],
        12
    );
    runtime.stop().unwrap();
}

#[test]
fn provider_process_failure_completes_its_call_and_keeps_other_providers_running() {
    let source = r#"const cap={name:'dev.host-capability',api:1,scope:'target'};
module.exports={activate(context){context.rpc.provide(cap,'exit',()=>{
 setTimeout(()=>process.exit(23),20);return new Promise(()=>{});
});},deactivate(){}};"#;
    let directory = tempdir().unwrap();
    let peer = Peer::start();
    let mut runtime = runtime(
        &peer,
        vec![
            plugin(directory.path(), "dev.crash", 11, false, source),
            plugin(directory.path(), "dev.survivor", 11, false, SOURCE),
        ],
    );
    assert_eq!(
        result(call(&runtime, "dev.crash", 11, "exit"))
            .unwrap_err()
            .code,
        "host_unavailable"
    );
    until(|| {
        runtime.observations().iter().any(|observation| {
            observation.plugin.manifest.id == "dev.crash"
                && observation.state == ExecutionState::Failed
        })
    });
    assert_eq!(
        result(call(&runtime, "dev.survivor", 11, "ping")).unwrap()["pluginId"],
        "dev.survivor"
    );
    assert_eq!(peer.request("Fixture.ping")["alive"], true);
    assert!(
        runtime
            .stop()
            .unwrap()
            .iter()
            .all(|report| report.result.as_ref().is_ok_and(|exit| exit.workers_reaped))
    );
}
