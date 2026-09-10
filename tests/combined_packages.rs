#![cfg(windows)]

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use codlet::catalog::PluginCatalog;
use codlet::cdp::{CdpClient, TargetController, TargetSession};
use codlet::host_control::HostControl;
use codlet::host_runtime::HostRuntime;
use codlet::js_runtime::JsRuntime;
use codlet::plugin_control::{
    PluginControlAction as Action, PluginControlError, PluginControlOutcome as Outcome,
    PluginControlReport, PluginControlRequest,
};
use codlet::plugin_execution::ExecutionState;
use codlet::plugin_watch::PluginWatcher;
use codlet::plugins::{LocalPluginRegistration, Permission, PluginRegistry};
use codlet::renderer::RendererRuntime;
use codlet::runtime_control::{
    ControlBroker, ControlCompletion, ControlRequest, ControlStatus, MAX_CONTROL_PENDING,
};
use codlet::windows::process::{ChildProcess, launch_with_cdp_pipes};
use serde_json::{Value, json};
use tempfile::{TempDir, tempdir};

const WAIT: Duration = Duration::from_secs(12);
const COMBINED: &str = "dev.combined";
fn cap(name: &str) -> Value {
    json!({"name":name,"api":1,"scope":"target"})
}
fn ordinary_renderer() -> &'static str {
    "// fixture-await-host-capability\nmodule.exports={activate(){},deactivate(){}};"
}

fn host_source(capability: &str, revision: &str) -> String {
    format!(
        r#"
const fs=require('node:fs');
const path=require('node:path');
const revision={revision};
let context;
const record=(event,more={{}})=>fs.appendFileSync(path.join(context.root,'events.jsonl'),JSON.stringify({{event,revision,generation:context.plugin.generation,...more}})+'\n');
module.exports={{
 activate(ctx){{context=ctx;record('activate');ctx.rpc.provide({capability},'inspect',(_params,invocation)=>{{record('inspect',{{caller:invocation.caller}});return {{ready:true,generation:ctx.plugin.generation,revision}};}});}},
 async deactivate(cleanup){{const stats=await cleanup.cdp.request('Fake.stats');record('deactivate',{{remainingWorlds:stats.scripts}});}}
}};
"#,
        revision = serde_json::to_string(revision).unwrap(),
        capability = cap(capability)
    )
}

struct Fixture {
    renderer: RendererRuntime,
    hosts: HostRuntime,
    control: HostControl,
    broker: ControlBroker,
    client: CdpClient,
    child: ChildProcess,
    _targets: TargetController,
    sessions: Vec<TargetSession>,
    directory: TempDir,
    registry_path: PathBuf,
}

impl Fixture {
    fn new(attach: bool) -> Self {
        let directory = tempdir().unwrap();
        let registry_path = directory.path().join("config.json");
        let mut registry = PluginRegistry::load(&registry_path).unwrap();
        registry.set_enabled("codlet-gui", false).unwrap();
        registry.set_enabled("codex.ui.adapter", false).unwrap();
        registry.save().unwrap();
        let mut renderer =
            RendererRuntime::from_catalog(PluginCatalog::load(&registry).unwrap(), registry)
                .unwrap();
        let (child, pipes) = launch_with_cdp_pipes(
            Path::new(env!("CARGO_BIN_EXE_codlet-fake-child")),
            &[OsString::from("--scenario=renderer-control")],
            true,
        )
        .unwrap();
        let (client, events) = CdpClient::spawn(pipes).unwrap();
        let (targets, sessions) = TargetController::discover(client.clone(), events, WAIT).unwrap();
        let js =
            JsRuntime::from_distribution(Path::new(env!("CARGO_BIN_EXE_codlet")).parent().unwrap())
                .unwrap();
        let hosts = HostRuntime::start_with_runtime(Vec::new(), client.clone(), Some(js)).unwrap();
        renderer.set_host_capability_client(hosts.capability_client());
        if attach {
            for session in &sessions {
                renderer.attach(session).unwrap();
            }
        }
        let broker = ControlBroker::new([17; 16], "b".repeat(64));
        broker.set_ready();
        Self {
            renderer,
            hosts,
            control: HostControl::new(registry_path.clone()),
            broker,
            client,
            child,
            _targets: targets,
            sessions,
            directory,
            registry_path,
        }
    }
    fn registry(&self) -> PluginRegistry {
        PluginRegistry::load(&self.registry_path).unwrap()
    }
    fn register(
        &self,
        id: &str,
        host_cap: Option<&str>,
        renderer: bool,
        requirements: Vec<Value>,
    ) -> PathBuf {
        let root = self.directory.path().join(id);
        std::fs::create_dir(&root).unwrap();
        let mut manifest = json!({"schema":1,"id":id,"version":"1","requires":requirements});
        let mut grants = Vec::new();
        if renderer {
            manifest["renderer"] = json!({"entry":"renderer.js","world":"isolated"});
            std::fs::write(root.join("renderer.js"), ordinary_renderer()).unwrap();
            grants.push(Permission::RuntimeManage);
        }
        if let Some(host_cap) = host_cap {
            manifest["host"] = json!({"entry":"host.js"});
            if renderer {
                manifest["host"]["provides"] = json!([cap(host_cap)]);
            } else {
                manifest["provides"] = json!([cap(host_cap)]);
            }
            std::fs::write(root.join("host.js"), host_source(host_cap, "old")).unwrap();
            grants.extend([Permission::HostProcess, Permission::CdpRaw]);
        }
        manifest["permissions"] = json!(grants);
        std::fs::write(root.join("codlet.json"), manifest.to_string()).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let mut registry = self.registry();
        registry
            .register_local(
                id,
                LocalPluginRegistration {
                    broker_policy: Default::default(),
                    path: root.clone(),
                    grants,
                },
            )
            .unwrap();
        registry.set_enabled(id, false).unwrap();
        registry.save().unwrap();
        root
    }
    fn combined(&self) -> PathBuf {
        self.register(
            COMBINED,
            Some("dev.combined.native"),
            true,
            vec![cap("dev.combined.native"), cap("codlet.runtime.manage")],
        )
    }
    fn submit(&self, action: Action, id: &str) -> String {
        let prepared = self
            .broker
            .handle(ControlRequest::prepare(PluginControlRequest {
                action,
                plugin_id: id.into(),
                permission: None,
                cascade: false,
            }));
        assert_eq!(prepared.status, ControlStatus::Prepared);
        let receipt = prepared.operation_id().unwrap().to_owned();
        assert_eq!(
            self.broker.handle(ControlRequest::submit(&receipt)).status,
            ControlStatus::Queued
        );
        receipt
    }
    fn tick(&mut self) {
        self.renderer
            .set_external_observations(self.hosts.observations());
        self.renderer.pump_bindings().unwrap();
        self.control
            .submit_self_disable_requests(&mut self.renderer, &self.broker);
        self.control
            .poll(&mut self.renderer, &self.hosts, &self.broker);
        if !self.control.is_pending()
            && let Some(job) = self.broker.take_next()
        {
            assert!(
                self.control
                    .dispatch(job, &mut self.renderer, &self.hosts, &self.broker)
                    .is_none()
            );
        }
    }
    fn result(&mut self, receipt: &str) -> Result<PluginControlReport, PluginControlError> {
        let end = Instant::now() + WAIT;
        loop {
            self.tick();
            let reply = self.broker.handle(ControlRequest::result(receipt));
            if let Some(operation) = reply.operation
                && let Some(completion) = operation.completion
            {
                return match completion {
                    ControlCompletion::Report { report } => Ok(report),
                    ControlCompletion::Error { error } => Err(error),
                };
            }
            assert!(
                Instant::now() < end,
                "receipt did not complete; targets requested={}; hosts={:?}",
                self.control.needs_renderer_executor(),
                self.hosts.observations()
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    fn apply(&mut self, action: Action, id: &str) -> PluginControlReport {
        let receipt = self.submit(action, id);
        self.result(&receipt).unwrap()
    }
    fn command(&self, method: &str, params: Value) -> Value {
        self.client
            .request(method, Some(params), None, WAIT)
            .unwrap()
            .result
            .unwrap()
    }
    fn assert_generation(&self, id: &str, generation: u64, renderer: bool) {
        assert!(
            self.hosts
                .observations()
                .iter()
                .any(|observation| observation.plugin.manifest.id == id
                    && observation.plugin.generation == generation
                    && observation.state == ExecutionState::Active)
        );
        if renderer {
            for target in self.renderer.status_snapshot().targets {
                assert!(
                    target.plugins.iter().any(|plugin| plugin.id == id
                        && plugin.generation == generation
                        && plugin.active),
                    "{target:?}"
                );
            }
        }
    }
    fn events(root: &Path) -> Vec<Value> {
        std::fs::read_to_string(root.join("events.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for session in &self.sessions {
            let _ = self.renderer.deactivate_target(session.target_id());
        }
        let _ = self.hosts.stop();
        let _ = self.client.request("Fake.finish", None, None, WAIT);
        let _ = self.client.shutdown();
        let _ = self.child.wait(WAIT);
    }
}

#[test]
fn combined_replacement_restores_both_immutable_sources_at_one_fresh_generation() {
    let mut fixture = Fixture::new(true);
    let root = fixture.combined();
    assert_eq!(
        fixture.apply(Action::Enable, COMBINED).outcome,
        Outcome::Applied
    );
    fixture.assert_generation(COMBINED, 1, true);
    std::fs::write(
        root.join("host.js"),
        host_source("dev.combined.native", "candidate"),
    )
    .unwrap();
    std::fs::write(
        root.join("renderer.js"),
        format!("{}\n// fixture-fail-candidate", ordinary_renderer()),
    )
    .unwrap();
    let report = fixture.apply(Action::Reload, COMBINED);
    assert_eq!(report.outcome, Outcome::RolledBack, "{report:?}");
    assert_eq!(report.generations.len(), 1);
    assert_eq!(report.generations[0].generation, 3);
    fixture.assert_generation(COMBINED, 3, true);
    let events = Fixture::events(&root);
    assert!(events.iter().any(|event| event["event"] == "activate"
        && event["generation"] == 2
        && event["revision"] == "candidate"));
    assert!(events.iter().any(|event| event["event"] == "activate"
        && event["generation"] == 3
        && event["revision"] == "old"));
    for event in events.iter().filter(|event| event["event"] == "deactivate") {
        assert_eq!(
            event["remainingWorlds"],
            json!([]),
            "renderer must clean up before native stop: {event}"
        );
    }
    std::fs::write(root.join("codlet.json"), "broken manifest").unwrap();
    let mut registry = fixture.registry();
    registry.remove_local(COMBINED).unwrap();
    registry.save().unwrap();
    assert_eq!(
        fixture.apply(Action::Disable, COMBINED).outcome,
        Outcome::Applied
    );
    assert_eq!(fixture.renderer.plugin_count(), 0);
    assert!(
        fixture
            .hosts
            .observations()
            .iter()
            .all(|observation| observation.state != ExecutionState::Active)
    );
}

#[test]
fn native_provider_reload_restarts_transitive_renderer_and_combined_dependents() {
    let mut fixture = Fixture::new(true);
    fixture.register("dev.provider", Some("dev.provider.api"), false, vec![]);
    fixture.register(
        COMBINED,
        Some("dev.combined.native"),
        true,
        vec![cap("dev.provider.api")],
    );
    fixture.register("dev.consumer", None, true, vec![cap("dev.combined.native")]);
    for id in ["dev.provider", COMBINED, "dev.consumer"] {
        assert_eq!(fixture.apply(Action::Enable, id).outcome, Outcome::Applied);
    }
    let receipt = fixture.submit(Action::Disable, "dev.provider");
    assert_eq!(
        fixture.result(&receipt).unwrap_err().code,
        "dependency_conflict"
    );
    let report = fixture.apply(Action::Reload, "dev.provider");
    assert_eq!(report.outcome, Outcome::Applied, "{report:?}");
    assert_eq!(
        report.affected_plugin_ids,
        vec![COMBINED, "dev.consumer", "dev.provider"]
    );
    assert!(
        report
            .generations
            .iter()
            .all(|generation| generation.generation == 2)
    );
    fixture.assert_generation("dev.provider", 2, false);
    fixture.assert_generation(COMBINED, 2, true);
    assert_eq!(
        fixture.apply(Action::Disable, "dev.consumer").outcome,
        Outcome::Applied
    );
    assert_eq!(
        fixture.apply(Action::Disable, COMBINED).outcome,
        Outcome::Applied
    );
    assert_eq!(
        fixture.apply(Action::Disable, "dev.provider").outcome,
        Outcome::Applied
    );
}

#[test]
fn combined_watch_observes_both_entries_and_keeps_f1_when_either_changes_before_dispatch() {
    let mut fixture = Fixture::new(true);
    let root = fixture.combined();
    fixture.apply(Action::Enable, COMBINED);
    let mut watcher = PluginWatcher::new(fixture.registry_path.clone());
    let now = Instant::now();
    let poll = |watcher: &mut PluginWatcher, fixture: &Fixture, time| {
        let observations = fixture.hosts.observations();
        watcher.poll_guarded(time, &fixture.control.local_watch_sources(&observations))
    };
    assert!(poll(&mut watcher, &fixture, now).is_none());
    std::fs::write(
        root.join("renderer.js"),
        format!("{}\n// renderer edit", ordinary_renderer()),
    )
    .unwrap();
    assert!(poll(&mut watcher, &fixture, now + Duration::from_millis(250)).is_none());
    let selection = poll(&mut watcher, &fixture, now + Duration::from_millis(500)).unwrap();
    assert!(selection.is_host());
    let receipt = fixture
        .control
        .submit_watched(selection, &fixture.broker)
        .unwrap();
    std::fs::write(
        root.join("host.js"),
        host_source("dev.combined.native", "later-host-edit"),
    )
    .unwrap();
    assert_eq!(
        fixture.result(&receipt).unwrap_err().code,
        "watch_source_unsettled"
    );
    let rejected = fixture.control.take_watch_results().pop().unwrap();
    assert!(rejected.not_attempted.is_some());
    watcher.not_attempted(rejected.not_attempted.as_ref().unwrap());
    fixture.assert_generation(COMBINED, 1, true);
    assert!(poll(&mut watcher, &fixture, now + Duration::from_millis(750)).is_none());
    let selection = poll(&mut watcher, &fixture, now + Duration::from_millis(1000)).unwrap();
    let receipt = fixture
        .control
        .submit_watched(selection, &fixture.broker)
        .unwrap();
    assert_eq!(fixture.result(&receipt).unwrap().outcome, Outcome::Applied);
    fixture.assert_generation(COMBINED, 2, true);
}

#[test]
fn combined_enable_receipt_waits_for_a_real_renderer_target_after_native_ready() {
    let mut fixture = Fixture::new(false);
    fixture.combined();
    let receipt = fixture.submit(Action::Enable, COMBINED);
    let end = Instant::now() + WAIT;
    while !fixture.control.needs_renderer_executor() {
        fixture.tick();
        assert!(Instant::now() < end);
        std::thread::sleep(Duration::from_millis(5));
    }
    // The coordinator requests a renderer as soon as Host startup is queued;
    // Host activation may itself await a renderer provider. This independent
    // Host becomes ready while the same receipt still waits for a live target.
    while !fixture
        .hosts
        .observations()
        .iter()
        .any(|observation| observation.state == ExecutionState::Active)
    {
        fixture.tick();
        assert!(
            Instant::now() < end,
            "native entry did not become ready while waiting for its renderer"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        fixture
            .broker
            .handle(ControlRequest::result(&receipt))
            .status,
        ControlStatus::Running
    );
    assert!(
        fixture
            .hosts
            .observations()
            .iter()
            .any(|observation| observation.state == ExecutionState::Active)
    );
    assert!(!fixture.registry().is_enabled(COMBINED));
    for session in &fixture.sessions {
        assert_eq!(fixture.renderer.attach(session).unwrap().plugin_count, 0);
    }
    fixture.control.renderer_executor_result(Ok(()));
    assert_eq!(fixture.result(&receipt).unwrap().outcome, Outcome::Applied);
    fixture.assert_generation(COMBINED, 1, true);
}

#[test]
fn combined_disable_self_preserves_response_and_retries_a_full_receipt_queue() {
    let mut fixture = Fixture::new(true);
    let root = fixture.combined();
    fixture.apply(Action::Enable, COMBINED);
    let reservations = (0..MAX_CONTROL_PENDING)
        .map(|index| {
            fixture
                .broker
                .handle(ControlRequest::prepare(PluginControlRequest {
                    action: Action::Disable,
                    permission: None,
                    cascade: false,
                    plugin_id: format!("dev.absent{index}"),
                }))
                .operation_id()
                .unwrap()
                .to_owned()
        })
        .collect::<Vec<_>>();
    for receipt in reservations {
        assert_eq!(
            fixture
                .broker
                .handle(ControlRequest::submit(receipt))
                .status,
            ControlStatus::Queued
        );
    }
    fixture.command("Fake.emitCapabilityCall",json!({"targetId":"main","pluginId":COMBINED,"requestId":500,"capability":cap("codlet.runtime.manage"),"method":"disableSelf","params":null}));
    let end = Instant::now() + WAIT;
    loop {
        fixture.renderer.pump_bindings().unwrap();
        if fixture
            .command("Fake.capabilityResponses", Value::Null)
            .as_array()
            .unwrap()
            .iter()
            .any(|response| response["response"]["id"] == 500 && response["response"]["ok"] == true)
        {
            break;
        }
        assert!(Instant::now() < end);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(!fixture.registry().is_enabled(COMBINED));
    fixture
        .control
        .submit_self_disable_requests(&mut fixture.renderer, &fixture.broker);
    assert!(
        fixture
            .hosts
            .observations()
            .iter()
            .any(|observation| observation.state == ExecutionState::Active),
        "full broker must retain pending native cleanup"
    );
    while fixture
        .hosts
        .observations()
        .iter()
        .any(|observation| observation.state == ExecutionState::Active)
        || fixture.control.is_pending()
    {
        fixture.tick();
        assert!(Instant::now() < end);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(fixture.renderer.plugin_count(), 0);
    assert!(
        Fixture::events(&root)
            .iter()
            .filter(|event| event["event"] == "deactivate")
            .all(|event| event["remainingWorlds"] == json!([]))
    );
    let stats = fixture.command("Fake.stats", Value::Null);
    let trace = stats["trace"].as_array().unwrap();
    assert!(
        trace
            .iter()
            .position(|event| event["operation"] == "response")
            .unwrap()
            < trace
                .iter()
                .position(|event| event["operation"] == "deactivate")
                .unwrap()
    );
}
