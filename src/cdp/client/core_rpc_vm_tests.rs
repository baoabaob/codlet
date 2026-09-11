//! Actual managed Node + actual production renderer JS for all managed RPC
//! directions. Each fixture owns its registry, OS workers and bounded VM peer.

use std::path::PathBuf;

use super::host_renderer_vm_tests::VmPeer;
use super::*;
use crate::catalog::PluginCatalog;
use crate::cdp::{TargetController, TargetSession};
use crate::host_control::HostControl;
use crate::host_runtime::{HostCoreServices, HostRuntime};
use crate::os_broker::OsBroker;
use crate::plugin_control::{
    PluginControlAction, PluginControlOutcome, PluginControlReport, PluginControlRequest,
};
use crate::plugin_execution::ExecutionState;
use crate::plugins::{LocalPluginRegistration, Permission, PluginRegistry, bundled_plugins};
use crate::renderer::RendererRuntime;
use crate::runtime_control::{ControlBroker, ControlCompletion, ControlRequest, ControlStatus};
use serde_json::json;
use tempfile::{TempDir, tempdir};

const ASSETS: [(&str, &str, &str, bool); 4] = [
    (
        "service",
        include_str!("../../../examples/core-rpc/service/codlet.json"),
        include_str!("../../../examples/core-rpc/service/host.js"),
        true,
    ),
    (
        "view",
        include_str!("../../../examples/core-rpc/view/codlet.json"),
        include_str!("../../../examples/core-rpc/view/renderer.js"),
        false,
    ),
    (
        "coordinator",
        include_str!("../../../examples/core-rpc/coordinator/codlet.json"),
        include_str!("../../../examples/core-rpc/coordinator/host.js"),
        true,
    ),
    (
        "consumer",
        include_str!("../../../examples/core-rpc/consumer/codlet.json"),
        include_str!("../../../examples/core-rpc/consumer/renderer.js"),
        false,
    ),
];
const WAIT: Duration = Duration::from_secs(15);

struct Fixture {
    renderer: RendererRuntime,
    hosts: HostRuntime,
    os: OsBroker,
    controller: TargetController,
    sessions: Vec<TargetSession>,
    control: HostControl,
    broker: ControlBroker,
    peer: VmPeer,
    root: PathBuf,
    _directory: TempDir,
    closed: bool,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempdir().unwrap();
        let root = directory.path().join("core-rpc");
        let registry_path = directory.path().join("config.json");
        let mut registry = PluginRegistry::load(&registry_path).unwrap();
        for plugin in bundled_plugins().unwrap() {
            registry.set_enabled(&plugin.manifest.id, false).unwrap();
        }
        for (name, manifest, source, host) in ASSETS {
            let path = root.join(name);
            std::fs::create_dir_all(&path).unwrap();
            std::fs::write(path.join("codlet.json"), manifest).unwrap();
            std::fs::write(
                path.join(if host { "host.js" } else { "renderer.js" }),
                source,
            )
            .unwrap();
            let id = format!("example.rpc.{name}");
            let grants = if name == "coordinator" {
                vec![Permission::HostProcess, Permission::CdpRaw]
            } else if host {
                vec![Permission::HostProcess]
            } else {
                vec![]
            };
            registry
                .register_local(
                    &id,
                    LocalPluginRegistration {
                        path: std::fs::canonicalize(&path).unwrap(),
                        grants,
                        broker_policy: Default::default(),
                    },
                )
                .unwrap();
            registry.set_enabled(&id, true).unwrap();
        }
        registry.save().unwrap();
        let catalog = PluginCatalog::load(&registry).unwrap();
        let loaded = catalog.enabled_plugins(&registry).unwrap();
        let os = OsBroker::for_registry(registry_path.clone()).unwrap();
        let (peer, events) = VmPeer::start();
        let hosts = HostRuntime::start_with_services(
            loaded,
            peer.client.clone(),
            Some(peer.runtime.clone()),
            HostCoreServices {
                os_broker: Some(os.client()),
                runtime_manage: None,
            },
        )
        .unwrap();
        let mut renderer = RendererRuntime::from_catalog(catalog, registry).unwrap();
        renderer.set_host_capability_client(hosts.capability_client());
        renderer.set_external_observations(hosts.observations());
        let (controller, sessions) =
            TargetController::discover(peer.client.clone(), events, Duration::from_secs(5))
                .unwrap();
        let reports = renderer.attach_all(&sessions);
        assert_eq!(reports.len(), 2);
        assert!(
            reports.iter().all(|(_, result)| result.is_ok()),
            "entry-ordered startup failed: {reports:?}; {:?}",
            hosts.take_diagnostics()
        );
        let broker = ControlBroker::new([65; 16], "r".repeat(64));
        broker.set_ready();
        Self {
            renderer,
            hosts,
            os,
            controller,
            sessions,
            control: HostControl::new(registry_path),
            broker,
            peer,
            root,
            _directory: directory,
            closed: false,
        }
    }

    fn tick(&mut self) {
        for change in self.controller.pump(Duration::ZERO).unwrap() {
            self.renderer.apply_target_change(change).unwrap();
        }
        self.renderer.pump_bindings().unwrap();
        self.renderer
            .set_external_observations(self.hosts.observations());
        self.control
            .poll(&mut self.renderer, &self.hosts, &self.broker);
        if !self.control.is_pending()
            && let Some(job) = self.broker.take_next()
            && let Some(job) =
                self.control
                    .dispatch(job, &mut self.renderer, &self.hosts, &self.broker)
        {
            self.broker
                .complete(&job.operation_id, self.renderer.manage_plugin(job.request));
        }
    }

    fn inspect(&self) -> Value {
        self.peer.request(
            "Fixture.inspect",
            json!({"keys":["__rpcConsumerState","__rpcViewState"]}),
        )
    }

    fn eval(&mut self, target: &str, expression: &str) -> Value {
        let snapshot = self.inspect();
        let context = snapshot["contexts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|context| {
                context["targetId"] == target
                    && context["plugins"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|plugin| plugin["id"] == "example.rpc.consumer")
            })
            .expect("current consumer realm");
        let session = self
            .sessions
            .iter()
            .find(|session| session.target_id() == target && session.is_live())
            .unwrap();
        let deadline = Instant::now() + WAIT;
        let mut request = session
            .until(deadline)
            .start_evaluate_in_context(expression, context["id"].as_u64())
            .unwrap();
        loop {
            self.tick();
            if let Some(response) = request.try_response().unwrap() {
                let result = response.result.unwrap();
                assert!(
                    result.get("exceptionDetails").is_none(),
                    "renderer exception: {result}"
                );
                return result
                    .pointer("/result/value")
                    .cloned()
                    .unwrap_or(Value::Null);
            }
            assert!(
                Instant::now() < deadline,
                "actual renderer call did not settle: {:?}",
                self.hosts.take_diagnostics()
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn reload(&mut self, id: &str) -> PluginControlReport {
        let prepared = self
            .broker
            .handle(ControlRequest::prepare(PluginControlRequest {
                action: PluginControlAction::Reload,
                plugin_id: id.into(),
                permission: None,
                cascade: false,
                local_import: None,
            }));
        let id = prepared.operation_id().unwrap().to_owned();
        assert_eq!(
            self.broker.handle(ControlRequest::submit(&id)).status,
            ControlStatus::Queued
        );
        let deadline = Instant::now() + WAIT;
        loop {
            self.tick();
            let status = self.broker.handle(ControlRequest::result(&id));
            if status.status == ControlStatus::Completed {
                return match status.operation.unwrap().completion.unwrap() {
                    ControlCompletion::Report { report } => report,
                    other => panic!("RPC reload rejected: {other:?}"),
                };
            }
            assert!(
                Instant::now() < deadline,
                "RPC reload did not settle: {status:?}; {:?}",
                self.hosts.take_diagnostics()
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        for session in &self.sessions {
            let _ = self.renderer.deactivate_target(session.target_id());
        }
        let reports = self.hosts.stop();
        let os = self.os.stop();
        if !thread::panicking() {
            let reports = reports.unwrap();
            assert_eq!(reports.len(), 2);
            for report in reports {
                let result = report.result.unwrap();
                assert!(result.workers_reaped && !result.forced && result.exit_code == 0);
            }
            os.unwrap();
            let snapshot = self.inspect();
            assert_eq!(
                snapshot["sessions"].as_array().unwrap().len(),
                2,
                "Core must detach the Host-owned raw session after deactivate"
            );
            for context in snapshot["contexts"].as_array().unwrap() {
                assert_eq!(context["plugins"], json!([]));
                assert_eq!(context["timers"], 0);
                assert_eq!(context["globals"], json!({}));
            }
        }
        self.peer.close();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.close();
    }
}

#[test]
fn host_initialization_awaits_both_executor_directions_in_the_second_window() {
    let mut fixture = Fixture::new();
    assert!(
        fixture
            .hosts
            .observations()
            .iter()
            .all(|owner| owner.state == ExecutionState::Active)
    );
    let snapshot = fixture.inspect();
    let states = snapshot["contexts"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|context| context["globals"].get("__rpcConsumerState"))
        .collect::<Vec<_>>();
    assert_eq!(states.len(), 2);
    for state in states {
        assert_eq!(state["initial"]["selected"], "window-b");
        assert_eq!(
            state["initial"]["runtimeResult"]["scope"]["kind"],
            "runtime"
        );
        assert_eq!(
            state["initial"]["runtimeResult"]["caller"]["pluginId"],
            "example.rpc.coordinator"
        );
        assert_eq!(
            state["initial"]["targetResult"]["scope"]["targetId"],
            "window-b"
        );
        assert_eq!(state["initial"]["reverseResult"]["nested"]["value"], 14);
        assert_eq!(
            state["initial"]["reverseResult"]["nested"]["caller"]["pluginId"],
            "example.rpc.view"
        );
        assert_eq!(state["caller"]["pluginId"], "example.rpc.consumer");
    }
    let result = fixture.eval(
        "window-a",
        "globalThis.__rpcRoundTrip({value:11,caller:{pluginId:'forged'}})",
    );
    assert_eq!(result["result"]["nested"]["value"], 22);
    assert_eq!(result["caller"]["pluginId"], "example.rpc.consumer");
    assert_eq!(
        result["result"]["caller"]["pluginId"],
        "example.rpc.coordinator"
    );
    assert_eq!(
        result["result"]["nested"]["caller"]["pluginId"],
        "example.rpc.view"
    );
    assert_eq!(result["result"]["scope"]["targetId"], "window-a");
    assert_eq!(result["result"]["nested"]["depth"], 3);
    assert_eq!(
        fixture.eval("window-a", "globalThis.__rpcStats()")["notifications"],
        1
    );
    fixture.eval("window-a", "globalThis.__rpcNotify(); null");
    let deadline = Instant::now() + WAIT;
    loop {
        fixture.tick();
        let snapshot = fixture.inspect();
        if snapshot["contexts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|context| {
                context["targetId"] == "window-a"
                    && context["globals"]["__rpcViewState"]["notifications"] == 1
            })
        {
            break;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(5));
    }
    fixture.close();
}

#[test]
fn nested_deadline_signal_and_target_handle_retirement_reach_real_js_children() {
    let mut fixture = Fixture::new();
    let finished = fixture.eval("window-a", "globalThis.__rpcStats()")["finished"]
        .as_u64()
        .unwrap();
    let timed = fixture.eval("window-a", "globalThis.__rpcRoundTrip({value:9,delayMs:900},{timeoutMs:160}).catch(error=>({code:error.code}))");
    assert!(
        matches!(
            timed["code"].as_str(),
            Some("rpc_timeout" | "request_timeout")
        ),
        "{timed}"
    );
    let cancelled = fixture.eval("window-a", "(()=>{const signal=new AbortController(); const result=globalThis.__rpcRoundTrip({value:9,delayMs:900},{signal:signal.signal}).catch(error=>({code:error.code})); setTimeout(()=>signal.abort(),60); return result;})()");
    assert_eq!(cancelled["code"], "invocation_cancelled");
    let deadline = Instant::now() + WAIT;
    loop {
        let stats = fixture.eval("window-a", "globalThis.__rpcStats()");
        if stats["aborted"].as_u64().unwrap() >= 2 {
            assert_eq!(stats["finished"], finished);
            break;
        }
        assert!(
            Instant::now() < deadline,
            "nested Host handler did not receive cancellation: {stats}"
        );
    }
    let before = fixture.eval("window-a", "globalThis.__rpcProbe()");
    assert_eq!(before["scope"]["targetId"], "window-b");
    fixture
        .peer
        .request("Fixture.navigate", json!({"targetId":"window-b"}));
    for _ in 0..10 {
        fixture.tick();
        thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        fixture.eval("window-a", "globalThis.__rpcProbe()")["error"],
        "scope_denied"
    );
    assert_eq!(
        fixture.eval("window-a", "globalThis.__rpcRefresh()")["kind"],
        "target"
    );
    let refreshed = fixture.eval("window-a", "globalThis.__rpcProbe()");
    assert_ne!(refreshed["scope"]["epoch"], before["scope"]["epoch"]);
    assert_eq!(
        fixture.eval("window-a", "globalThis.__rpcClose()")["closed"],
        true
    );
    assert_eq!(
        fixture.eval("window-a", "globalThis.__rpcProbe()")["error"],
        "scope_denied"
    );
    fixture.close();
}

#[test]
fn bidirectional_entry_closure_reloads_and_compensates_with_fresh_generations() {
    let mut fixture = Fixture::new();
    std::fs::write(
        fixture.root.join("service/host.js"),
        ASSETS[0].2.replace("service-v1", "service-v2"),
    )
    .unwrap();
    let report = fixture.reload("example.rpc.service");
    assert_eq!(report.outcome, PluginControlOutcome::Applied, "{report:?}");
    assert_eq!(report.affected_plugin_ids.len(), 4);
    assert!(report.generations.iter().all(|entry| entry.generation == 2));
    assert_eq!(
        fixture.eval("window-a", "globalThis.__rpcStats()")["revision"],
        "service-v2"
    );
    let failed = ASSETS[1].2.replace("    context.rpc.provide(view, 'calculate'", "    if (initial.caller.targetId === 'window-b') throw new Error('candidate renderer failure');\n    context.rpc.provide(view, 'calculate'");
    std::fs::write(fixture.root.join("view/renderer.js"), failed).unwrap();
    let report = fixture.reload("example.rpc.view");
    assert_eq!(
        report.outcome,
        PluginControlOutcome::RolledBack,
        "{report:?}"
    );
    assert_eq!(report.affected_plugin_ids.len(), 3);
    assert!(report.generations.iter().all(|entry| entry.generation == 4));
    let restored = fixture.eval("window-b", "globalThis.__rpcRoundTrip({value:4})");
    assert_eq!(restored["result"]["nested"]["value"], 8);
    assert_eq!(restored["caller"]["generation"], 4);
    assert_eq!(restored["result"]["nested"]["revision"], "service-v2");
    assert_eq!(fixture.inspect()["sessions"].as_array().unwrap().len(), 3);
    fixture.close();
}
