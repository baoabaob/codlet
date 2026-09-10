#![cfg(windows)]

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use codlet::catalog::PluginCatalog;
use codlet::cdp::{CdpClient, TargetController, TargetSession};
use codlet::host_runtime::{HostOperation, HostRuntime};
use codlet::js_runtime::JsRuntime;
use codlet::plugin_execution::ExecutionState;
use codlet::plugins::{LoadedPlugin, LocalPluginRegistration, Permission, PluginRegistry};
use codlet::renderer::RendererRuntime;
use codlet::runtime_inspection::ProviderKind;
use codlet::runtime_status::StatusPublisher;
use codlet::windows::process::{ChildProcess, launch_with_cdp_pipes};
use serde_json::{Value, json};
use tempfile::{TempDir, tempdir};

const HOST: &str = "dev.rpc-host";
const CONSUMER: &str = "dev.rpc-consumer";
const WAIT: Duration = Duration::from_secs(8);

fn capability() -> Value {
    json!({"name":"dev.host.api","api":1,"scope":"target"})
}

const HOST_SOURCE: &str = r#"
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cap = { name: 'dev.host.api', api: 1, scope: 'target' };
let context;
const record = (event, details = {}) => fs.appendFileSync(path.join(context.root, 'calls.jsonl'), JSON.stringify({event, generation: context.plugin.generation, ...details}) + '\n');
module.exports = {
  activate(ctx) {
    context = ctx;
    record('activate');
    ctx.rpc.provide(cap, 'inspect', async (params, invocation) => {
      record('invoke', {method: 'inspect', params, caller: invocation.caller});
      await new Promise(resolve => setTimeout(resolve, 25));
      return {params, caller: invocation.caller, providerGeneration: ctx.plugin.generation,
        frozen: Object.isFrozen(invocation) && Object.isFrozen(invocation.caller)};
    });
    ctx.rpc.provide(cap, 'null', () => null);
    ctx.rpc.provide(cap, 'fail', () => { throw new Error('intentional provider error'); });
    ctx.rpc.provide(cap, 'nested', async (params, invocation) => {
      const result = await ctx.cdp.request('Fake.hostStillAlive');
      return {nested: true, result, caller: invocation.caller};
    });
    ctx.rpc.provide(cap, 'slow', async (params, invocation) => {
      record('begin', {label: params.label, caller: invocation.caller});
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, params.delayMs);
        invocation.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          record('cancelled', {label: params.label});
          reject(invocation.signal.reason);
        }, {once: true});
      });
      record('finish', {label: params.label});
      return params.label;
    });
  },
  deactivate() { record('deactivate'); },
};
"#;

struct Fixture {
    renderer: RendererRuntime,
    hosts: HostRuntime,
    client: CdpClient,
    child: ChildProcess,
    _targets: TargetController,
    sessions: Vec<TargetSession>,
    host_plugin: LoadedPlugin,
    host_root: PathBuf,
    _directory: TempDir,
    finished: bool,
}

impl Fixture {
    fn new(budget: Duration, held_activation: bool) -> Self {
        let directory = tempdir().unwrap();
        let mut registry = PluginRegistry::load(directory.path().join("config.json")).unwrap();
        registry.set_enabled("codlet-gui", false).unwrap();
        registry.set_enabled("codex.ui.adapter", false).unwrap();
        let host_root = directory.path().join("host");
        let consumer_root = directory.path().join("consumer");
        std::fs::create_dir(&host_root).unwrap();
        std::fs::create_dir(&consumer_root).unwrap();
        std::fs::write(host_root.join("codlet.json"), json!({"schema":1,"id":HOST,"version":"1","host":{"entry":"host.js"},"permissions":["host.process","cdp.raw"],"provides":[capability()]}).to_string()).unwrap();
        std::fs::write(host_root.join("host.js"), HOST_SOURCE).unwrap();
        std::fs::write(consumer_root.join("codlet.json"), json!({"schema":1,"id":CONSUMER,"version":"1","renderer":{"entry":"renderer.js","world":"isolated"},"requires":[capability()]}).to_string()).unwrap();
        let source = if held_activation {
            "// fixture-await-host-capability\nmodule.exports = { async activate(context) { await context.rpc.request('inspect', {heldActivation:true}); }, deactivate() {} };"
        } else {
            "module.exports = { activate() {}, deactivate() {} };"
        };
        std::fs::write(consumer_root.join("renderer.js"), source).unwrap();
        registry
            .register_local(
                HOST,
                LocalPluginRegistration {
                    broker_policy: Default::default(),
                    path: std::fs::canonicalize(&host_root).unwrap(),
                    grants: vec![Permission::HostProcess, Permission::CdpRaw],
                },
            )
            .unwrap();
        registry
            .register_local(
                CONSUMER,
                LocalPluginRegistration {
                    broker_policy: Default::default(),
                    path: std::fs::canonicalize(&consumer_root).unwrap(),
                    grants: vec![],
                },
            )
            .unwrap();
        registry.save().unwrap();
        let catalog = PluginCatalog::load(&registry).unwrap();
        let host_plugin = catalog
            .enabled_plugins(&registry)
            .unwrap()
            .into_iter()
            .find(|plugin| plugin.manifest.id == HOST)
            .unwrap();
        let (child, pipes) = launch_with_cdp_pipes(
            Path::new(env!("CARGO_BIN_EXE_codlet-fake-child")),
            &[OsString::from("--scenario=renderer-control")],
            true,
        )
        .unwrap();
        let (client, events) = CdpClient::spawn(pipes).unwrap();
        let (targets, sessions) =
            TargetController::discover(client.clone(), events, budget).unwrap();
        let js =
            JsRuntime::from_distribution(Path::new(env!("CARGO_BIN_EXE_codlet")).parent().unwrap())
                .unwrap();
        let hosts =
            HostRuntime::start_with_runtime(vec![host_plugin.clone()], client.clone(), Some(js))
                .unwrap();
        let deadline = Instant::now() + WAIT;
        while hosts.is_starting() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            hosts.observations()[0].state,
            ExecutionState::Active,
            "{:?}",
            hosts.observations()
        );
        let mut renderer = RendererRuntime::from_catalog(catalog, registry).unwrap();
        renderer.set_host_capability_client(hosts.capability_client());
        renderer.set_external_observations(hosts.observations());
        Self {
            renderer,
            hosts,
            client,
            child,
            _targets: targets,
            sessions,
            host_plugin,
            host_root,
            _directory: directory,
            finished: false,
        }
    }

    fn attach(&mut self, index: usize) {
        assert_eq!(
            self.renderer
                .attach(&self.sessions[index])
                .unwrap()
                .plugin_count,
            1
        );
    }

    fn command(&self, method: &str, params: Value) -> Value {
        self.client
            .request(method, Some(params), None, WAIT)
            .unwrap()
            .result
            .unwrap()
    }

    fn emit(&self, target: &str, id: u64, method: &str, params: Value) {
        self.command("Fake.emitCapabilityCall", json!({"targetId":target,"pluginId":CONSUMER,"requestId":id,"capability":capability(),"method":method,"params":params}));
    }

    fn responses(&self) -> Vec<Value> {
        self.command("Fake.capabilityResponses", Value::Null)
            .as_array()
            .unwrap()
            .clone()
    }

    fn wait_response(&mut self, id: u64) -> Value {
        let deadline = Instant::now() + WAIT;
        loop {
            self.renderer.pump_bindings().unwrap();
            if let Some(response) = self
                .responses()
                .into_iter()
                .rev()
                .find(|entry| entry["response"]["id"] == id)
            {
                return response;
            }
            assert!(
                Instant::now() < deadline,
                "no response for {id}; {:?}",
                self.renderer.take_diagnostics()
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn until(&mut self, predicate: impl Fn(&Self) -> bool) {
        let deadline = Instant::now() + WAIT;
        loop {
            self.renderer.pump_bindings().unwrap();
            if predicate(self) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "bridge progress timed out; {:?}",
                self.renderer.take_diagnostics()
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn events(&self) -> Vec<Value> {
        std::fs::read_to_string(self.host_root.join("calls.jsonl"))
            .unwrap_or_default()
            .split_inclusive('\n')
            .filter(|line| line.ends_with('\n'))
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn wait_native(&mut self, mut operation: HostOperation) {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(result) = operation.try_result() {
                result.unwrap();
                return;
            }
            self.renderer.pump_bindings().unwrap();
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn finish(&mut self) {
        for target in ["main", "second"] {
            self.renderer.deactivate_target(target).unwrap();
        }
        assert_eq!(self.renderer.pending_host_call_count(), 0);
        self.hosts.stop().unwrap();
        self.command("Fake.finish", Value::Null);
        assert_eq!(self.child.wait(WAIT).unwrap(), Some(0));
        self.client.shutdown().unwrap();
        self.finished = true;
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        for target in ["main", "second"] {
            let _ = self.renderer.deactivate_target(target);
        }
        let _ = self.hosts.stop();
        let _ = self.client.shutdown();
        let _ = self.child.wait(WAIT);
    }
}

#[test]
fn host_completion_wakes_renderer_activation_without_cdp_traffic_and_preserves_rpc_values() {
    let mut fixture = Fixture::new(Duration::from_secs(3), true);
    let publisher = StatusPublisher::new();
    publisher
        .bind_runtime_identity([41; 16], &"a".repeat(64))
        .unwrap();
    fixture.renderer.set_status_publisher(publisher.clone());
    let began = Instant::now();
    fixture.attach(0);
    assert!(
        began.elapsed() < Duration::from_secs(2),
        "the local Host completion did not wake the CDP evaluation drive"
    );
    let reply = fixture.wait_response(1);
    assert_eq!(reply["response"]["ok"], true);
    assert_eq!(
        reply["response"]["result"]["caller"],
        json!({"pluginId":CONSUMER,"generation":1,"targetId":"main","documentEpoch":1})
    );
    assert_eq!(reply["response"]["result"]["frozen"], true);
    let inspection = publisher.inspection_snapshot().unwrap().renderer.unwrap();
    assert!(
        inspection
            .providers
            .iter()
            .any(|provider| provider.id == format!("{HOST}:host")
                && provider.kind == ProviderKind::Host
                && provider.generation == 1)
    );
    fixture.emit("main", 100, "null", Value::Null);
    let reply = fixture.wait_response(100);
    assert_eq!(reply["response"]["ok"], true);
    assert_eq!(reply["response"].get("result"), Some(&Value::Null));
    fixture.emit("main", 101, "fail", Value::Null);
    let reply = fixture.wait_response(101);
    assert_eq!(reply["response"]["ok"], false);
    assert!(
        reply["response"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("intentional provider error")
    );
    fixture.emit("main", 102, "nested", Value::Null);
    assert_eq!(
        fixture.wait_response(102)["response"]["result"]["nested"],
        true
    );
    let before = fixture.responses().len();
    fixture.command("Fake.emitCapabilityCall", json!({"targetId":"main","pluginId":CONSUMER,"notification":true,"capability":capability(),"method":"inspect","params":{"notify":true}}));
    fixture.until(|fixture| {
        fixture
            .events()
            .iter()
            .any(|event| event["params"]["notify"] == true)
            && fixture.renderer.pending_host_call_count() == 0
    });
    assert_eq!(fixture.responses().len(), before);
    fixture.finish();
}

#[test]
fn pending_host_calls_leave_other_targets_and_nested_cdp_responsive() {
    let mut fixture = Fixture::new(Duration::from_secs(3), false);
    fixture.attach(0);
    fixture.attach(1);
    fixture.emit(
        "main",
        100,
        "slow",
        json!({"label":"slow-main","delayMs":600}),
    );
    let began = Instant::now();
    fixture.renderer.pump_bindings().unwrap();
    assert!(
        began.elapsed() < Duration::from_millis(150),
        "Host dispatch blocked the foreground loop"
    );
    fixture.until(|fixture| {
        fixture
            .events()
            .iter()
            .any(|event| event["event"] == "begin")
    });
    fixture.emit("second", 200, "nested", Value::Null);
    let fast = fixture.wait_response(200);
    assert_eq!(fast["sessionId"], "session-second");
    assert_eq!(fast["response"]["result"]["caller"]["targetId"], "second");
    assert!(
        !fixture
            .responses()
            .iter()
            .any(|response| response["response"]["id"] == 100)
    );
    assert_eq!(
        fixture.wait_response(100)["response"]["result"],
        "slow-main"
    );
    fixture.finish();
}

#[test]
fn renderer_authentication_and_old_provider_leases_cannot_upgrade_to_a_new_host_generation() {
    let mut fixture = Fixture::new(Duration::from_secs(3), false);
    fixture.attach(0);
    fixture.command("Fake.emitCapabilityCall", json!({"targetId":"main","pluginId":CONSUMER,"payload":{
        "v":1,"type":"request","pluginId":CONSUMER,"generation":1,"id":100,"capability":capability(),"method":"inspect","params":null,"caller":{"pluginId":"forged"}
    }}));
    assert_eq!(
        fixture.wait_response(100)["response"]["error"]["code"],
        "invalid_request"
    );
    fixture.command("Fake.emitCapabilityCall", json!({"targetId":"main","pluginId":CONSUMER,"requestId":101,"capability":{"name":"dev.undeclared","api":1,"scope":"target"},"method":"inspect","params":null}));
    assert_eq!(
        fixture.wait_response(101)["response"]["error"]["code"],
        "capability_denied"
    );
    fixture.command("Fake.emitCapabilityCall", json!({"targetId":"main","pluginId":CONSUMER,"requestId":102,"contextId":999999,"capability":capability(),"method":"inspect","params":null}));
    assert_eq!(
        fixture.wait_response(102)["response"]["error"]["code"],
        "context_mismatch"
    );
    assert!(
        !fixture
            .events()
            .iter()
            .any(|event| event["event"] == "invoke")
    );

    fixture.emit(
        "main",
        103,
        "inspect",
        json!({"caller":{"pluginId":"forged"}}),
    );
    assert_eq!(
        fixture.wait_response(103)["response"]["result"]["caller"]["pluginId"],
        CONSUMER
    );
    let invocations = fixture
        .events()
        .iter()
        .filter(|event| event["event"] == "invoke")
        .count();
    fixture.wait_native(fixture.hosts.begin_stop(HOST, 1).unwrap());
    let mut next = fixture.host_plugin.clone();
    next.generation = 2;
    fixture.wait_native(fixture.hosts.begin_start(next).unwrap());
    fixture
        .renderer
        .set_external_observations(fixture.hosts.observations());
    fixture.emit("main", 104, "inspect", json!({"mustNotUpgrade":true}));
    let reply = fixture.wait_response(104);
    assert_eq!(reply["response"]["ok"], false);
    assert!(matches!(
        reply["response"]["error"]["code"].as_str(),
        Some("stale_generation" | "capability_denied")
    ));
    assert_eq!(
        fixture
            .events()
            .iter()
            .filter(|event| event["event"] == "invoke")
            .count(),
        invocations
    );
    fixture.finish();
}

#[test]
fn retiring_a_renderer_context_cancels_its_host_call_and_never_delivers_the_late_reply() {
    let mut fixture = Fixture::new(Duration::from_secs(3), false);
    fixture.attach(0);
    fixture.emit(
        "main",
        100,
        "slow",
        json!({"label":"retired","delayMs":2000}),
    );
    fixture.until(|fixture| {
        fixture
            .events()
            .iter()
            .any(|event| event["event"] == "begin")
    });
    fixture.command(
        "Fake.unconfirmContext",
        json!({"targetId":"main","world":format!("codlet.plugin.{CONSUMER}.g1")}),
    );
    fixture.until(|fixture| {
        fixture.renderer.pending_host_call_count() == 0
            && fixture
                .events()
                .iter()
                .any(|event| event["event"] == "cancelled" && event["label"] == "retired")
    });
    assert!(
        !fixture
            .responses()
            .iter()
            .any(|response| response["response"]["id"] == 100)
    );
    assert!(
        !fixture
            .events()
            .iter()
            .any(|event| event["event"] == "finish" && event["label"] == "retired")
    );
    fixture.finish();
}

#[test]
fn bridge_quotas_and_original_deadline_bound_unanswered_provider_calls() {
    let mut fixture = Fixture::new(Duration::from_millis(300), false);
    fixture.attach(0);
    for id in 100..105 {
        fixture.emit(
            "main",
            id,
            "slow",
            json!({"label":format!("pending-{id}"),"delayMs":5000}),
        );
    }
    let began = Instant::now();
    let reply = fixture.wait_response(104);
    assert_eq!(reply["response"]["error"]["code"], "request_limit");
    assert!(fixture.renderer.pending_host_call_count() <= 4);
    fixture.until(|fixture| fixture.renderer.pending_host_call_count() == 0);
    assert!(began.elapsed() < Duration::from_secs(2));
    fixture.until(|fixture| {
        fixture
            .events()
            .iter()
            .any(|event| event["event"] == "cancelled")
    });
    assert!(
        !fixture
            .events()
            .iter()
            .any(|event| event["event"] == "finish")
    );
    fixture.command("Fake.hostStillAlive", Value::Null);
    fixture.finish();
}
