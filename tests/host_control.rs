#![cfg(windows)]

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use codlet::catalog::PluginCatalog;
use codlet::cdp::CdpClient;
use codlet::host_control::HostControl;
use codlet::host_runtime::HostRuntime;
use codlet::js_runtime::JsRuntime;
use codlet::plugin_control::{
    PluginControlAction, PluginControlOutcome, PluginControlReport, PluginControlRequest,
};
use codlet::plugin_execution::{ExecutionState, PluginExecutionObservation};
use codlet::plugins::{LocalPluginRegistration, Permission, PluginRegistry};
use codlet::renderer::RendererRuntime;
use codlet::runtime_control::{
    ControlBroker, ControlCompletion, ControlReport, ControlRequest, ControlStatus,
};
use codlet::windows::process::{ChildProcess, launch_with_cdp_pipes};
use serde_json::{Value, json};
use tempfile::{TempDir, tempdir};

const WAIT: Duration = Duration::from_secs(12);

struct Fixture {
    hosts: HostRuntime,
    control: HostControl,
    broker: ControlBroker,
    renderer: RendererRuntime,
    client: CdpClient,
    child: ChildProcess,
    directory: TempDir,
    registry_path: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempdir().unwrap();
        let registry_path = directory.path().join("config.json");
        let mut registry = PluginRegistry::load(&registry_path).unwrap();
        for id in ["codlet-gui", "codex.ui.adapter"] {
            registry.set_enabled(id, false).unwrap();
        }
        registry.save().unwrap();
        let renderer =
            RendererRuntime::from_catalog(PluginCatalog::load(&registry).unwrap(), registry)
                .unwrap();
        let (child, pipes) = launch_with_cdp_pipes(
            &PathBuf::from(env!("CARGO_BIN_EXE_codlet-fake-child")),
            &[OsString::from("--scenario=raw-host-cdp")],
            true,
        )
        .unwrap();
        let (client, events) = CdpClient::spawn(pipes).unwrap();
        drop(events);
        let runtime =
            JsRuntime::from_distribution(Path::new(env!("CARGO_BIN_EXE_codlet")).parent().unwrap())
                .expect("stage the pinned Node distribution beside target/debug/codlet.exe");
        // The production path must also accept online registrations when no host
        // existed at launch. No renderer/adapter is enabled in this fixture.
        let hosts =
            HostRuntime::start_with_runtime(Vec::new(), client.clone(), Some(runtime)).unwrap();
        let broker = ControlBroker::new([4; 16], "e".repeat(64));
        broker.set_ready();
        Self {
            hosts,
            control: HostControl::new(registry_path.clone()),
            broker,
            renderer,
            client,
            child,
            directory,
            registry_path,
        }
    }

    fn registry(&self) -> PluginRegistry {
        PluginRegistry::load(&self.registry_path).unwrap()
    }

    fn register(&self, id: &str, source: &str) -> PathBuf {
        let root = self.directory.path().join(id);
        std::fs::create_dir_all(root.join("dist")).unwrap();
        std::fs::write(root.join("dist/host.js"), source).unwrap();
        write_manifest(&root, id);
        let root = std::fs::canonicalize(root).unwrap();
        let mut registry = self.registry();
        registry
            .register_local(
                id,
                LocalPluginRegistration {
                    broker_policy: Default::default(),
                    path: root.clone(),
                    grants: vec![Permission::HostProcess, Permission::CdpRaw],
                },
            )
            .unwrap();
        registry.set_enabled(id, false).unwrap();
        registry.save().unwrap();
        root
    }

    fn submit(&self, action: PluginControlAction, id: &str) -> String {
        self.submit_request(PluginControlRequest {
            action,
            plugin_id: id.into(),
            permission: None,
            cascade: false,
            local_import: None,
        })
    }

    fn submit_request(&self, request: PluginControlRequest) -> String {
        let prepared = self.broker.handle(ControlRequest::prepare(request));
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

    fn wait(&mut self, receipt: &str) -> ControlReport {
        let deadline = Instant::now() + WAIT;
        loop {
            self.tick();
            let report = self.broker.handle(ControlRequest::result(receipt));
            if report.status == ControlStatus::Completed {
                return report;
            }
            assert!(
                Instant::now() < deadline,
                "receipt remained {:?}; observations={:?}",
                report.status,
                self.hosts.observations()
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn command(&mut self, action: PluginControlAction, id: &str) -> PluginControlReport {
        let receipt = self.submit(action, id);
        lifecycle_report(self.wait(&receipt))
    }

    fn until(&mut self, predicate: impl Fn(&Self) -> bool) {
        let deadline = Instant::now() + WAIT;
        while !predicate(self) {
            self.tick();
            assert!(
                Instant::now() < deadline,
                "fixture did not reach the requested state: {:?}",
                self.hosts.observations()
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn observation(&self, id: &str) -> PluginExecutionObservation {
        self.hosts
            .observations()
            .into_iter()
            .find(|observation| observation.plugin.manifest.id == id)
            .unwrap()
    }

    fn ping(&self) {
        assert_eq!(
            self.client
                .request("Fixture.ping", None, None, Duration::from_secs(1))
                .unwrap()
                .result
                .unwrap()["alive"],
            true
        );
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.hosts.stop();
        let _ = self.client.shutdown();
        let _ = self.child.wait(WAIT);
    }
}

fn write_manifest(root: &Path, id: &str) {
    std::fs::write(root.join("codlet.json"), json!({
        "schema":1,"id":id,"version":"1","host":{"entry":"dist/host.js"},"permissions":["host.process","cdp.raw"]
    }).to_string()).unwrap();
}

fn source(label: &str, initialize: &str) -> String {
    format!(
        r#"
const fs = require('node:fs'); const path = require('node:path');
let context;
function record(event) {{ fs.appendFileSync(path.join(context.root, 'events.jsonl'), JSON.stringify({{event, label:{label:?}, generation:context.plugin.generation, pid:process.pid}}) + '\n'); }}
module.exports = {{
  async activate(value) {{
    context = value; record('starting');
    await context.cdp.request('Fixture.ping');
    {initialize}
    record('active');
  }},
  deactivate() {{ record('deactivate'); }}
}};
"#
    )
}

fn events(root: &Path) -> Vec<Value> {
    std::fs::read_to_string(root.join("events.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

fn lifecycle_report(report: ControlReport) -> PluginControlReport {
    match report.operation.unwrap().completion.unwrap() {
        ControlCompletion::Report { report } => report,
        other => panic!("expected lifecycle report, got {other:?}"),
    }
}

fn error_code(report: ControlReport) -> String {
    match report.operation.unwrap().completion.unwrap() {
        ControlCompletion::Error { error } => error.code,
        other => panic!("expected rejected request, got {other:?}"),
    }
}

#[test]
fn confirmed_adapter_disable_persists_the_gui_closure_without_reactivation() {
    let mut fixture = Fixture::new();
    let mut registry = fixture.registry();
    registry.set_enabled("codex.ui.adapter", true).unwrap();
    registry.set_enabled("codlet-gui", true).unwrap();
    registry.save().unwrap();
    fixture.renderer =
        RendererRuntime::from_catalog(PluginCatalog::load(&registry).unwrap(), registry).unwrap();
    assert_eq!(fixture.renderer.plugin_count(), 2);
    // Legacy calls still refuse silent cascading.
    let ordinary = fixture.submit(PluginControlAction::Disable, "codex.ui.adapter");
    assert_eq!(error_code(fixture.wait(&ordinary)), "dependency_conflict");
    assert_eq!(fixture.renderer.plugin_count(), 2);
    let prepared = fixture
        .broker
        .handle(ControlRequest::prepare(PluginControlRequest {
            action: PluginControlAction::Disable,
            plugin_id: "codex.ui.adapter".into(),
            permission: None,
            cascade: true,
            local_import: None,
        }));
    let receipt = prepared.operation_id().unwrap().to_owned();
    fixture.broker.handle(ControlRequest::submit(&receipt));
    let result = lifecycle_report(fixture.wait(&receipt));
    assert_eq!(result.outcome, PluginControlOutcome::Applied);
    assert_eq!(
        result.affected_plugin_ids,
        ["codex.ui.adapter", "codlet-gui"]
    );
    assert!(result.generations.is_empty());
    assert!(!fixture.registry().is_enabled("codex.ui.adapter"));
    assert!(!fixture.registry().is_enabled("codlet-gui"));
    for _ in 0..4 {
        fixture.tick();
    }
    assert_eq!(fixture.renderer.plugin_count(), 0);
    // New document/launch plans use the persisted disabled state.
    let registry = fixture.registry();
    let restarted =
        RendererRuntime::from_catalog(PluginCatalog::load(&registry).unwrap(), registry).unwrap();
    assert_eq!(restarted.plugin_count(), 0);
    fixture.ping();
}

#[test]
fn newly_registered_host_hot_management_reuses_receipts_and_keeps_generation_high_water() {
    let mut fixture = Fixture::new();
    let id = "dev.host-control";
    let root = fixture.register(id, &source("first", ""));
    let reload_before_enable = fixture.submit(PluginControlAction::Reload, id);
    assert_eq!(
        error_code(fixture.wait(&reload_before_enable)),
        "plugin_not_enabled"
    );
    let enabled = fixture.command(PluginControlAction::Enable, id);
    assert_eq!(enabled.outcome, PluginControlOutcome::Applied);
    assert_eq!(enabled.generations[0].generation, 1);
    assert!(fixture.registry().is_enabled(id));
    assert_eq!(fixture.renderer.plugin_count(), 0);
    fixture.ping();

    std::fs::write(root.join("dist/host.js"), source("second", "")).unwrap();
    let receipt = fixture.submit(PluginControlAction::Reload, id);
    let reloaded = fixture.wait(&receipt);
    assert_eq!(
        lifecycle_report(reloaded.clone()).generations[0].generation,
        2
    );
    for _ in 0..4 {
        assert_eq!(
            fixture.broker.handle(ControlRequest::submit(&receipt)),
            reloaded
        );
        fixture.tick();
    }
    assert_eq!(
        events(&root)
            .iter()
            .filter(|event| event["event"] == "active" && event["label"] == "second")
            .count(),
        1
    );
    let disabled = fixture.command(PluginControlAction::Disable, id);
    assert_eq!(disabled.outcome, PluginControlOutcome::Applied);
    assert!(disabled.generations.is_empty() && !disabled.desired_enabled);
    let starts_before = events(&root)
        .iter()
        .filter(|event| event["event"] == "starting")
        .count();
    let disabled_reload = fixture.submit(PluginControlAction::Reload, id);
    assert_eq!(
        error_code(fixture.wait(&disabled_reload)),
        "plugin_not_enabled"
    );
    assert_eq!(
        events(&root)
            .iter()
            .filter(|event| event["event"] == "starting")
            .count(),
        starts_before
    );
    let enabled = fixture.command(PluginControlAction::Enable, id);
    assert_eq!(enabled.generations[0].generation, 3);

    // Removal is registration intent, not an implicit stop. Corrupt source and
    // missing registration cannot prevent cleanup of the actual loaded owner.
    let mut registry = fixture.registry();
    registry.remove_local(id).unwrap();
    registry.save().unwrap();
    std::fs::write(root.join("codlet.json"), "broken").unwrap();
    let disabled = fixture.command(PluginControlAction::Disable, id);
    assert_eq!(disabled.outcome, PluginControlOutcome::Applied);
    assert!(!disabled.desired_enabled && disabled.generations.is_empty());
    assert_eq!(fixture.observation(id).state, ExecutionState::Exited);
    assert!(!fixture.registry().local_plugins().contains_key(id));
    fixture.ping();
}

#[test]
fn validation_and_executor_switch_preserve_old_owner_then_failed_initialization_restores_snapshot()
{
    let mut fixture = Fixture::new();
    let id = "dev.host-rollback";
    let root = fixture.register(id, &source("original", ""));
    fixture.command(PluginControlAction::Enable, id);
    let original = fixture.observation(id);
    std::fs::write(root.join("codlet.json"), "invalid manifest").unwrap();
    let receipt = fixture.submit(PluginControlAction::Reload, id);
    assert_eq!(error_code(fixture.wait(&receipt)), "local_plugin_invalid");
    assert_eq!(fixture.observation(id).process_id, original.process_id);
    assert_eq!(
        events(&root)
            .iter()
            .filter(|event| event["event"] == "deactivate")
            .count(),
        0
    );

    std::fs::write(root.join("codlet.json"), json!({"schema":1,"id":id,"version":"1","renderer":{"entry":"dist/host.js","world":"isolated"},"permissions":[]}).to_string()).unwrap();
    let mut registry = fixture.registry();
    registry
        .register_local(
            id,
            LocalPluginRegistration {
                broker_policy: Default::default(),
                path: root.clone(),
                grants: vec![],
            },
        )
        .unwrap();
    registry.save().unwrap();
    let receipt = fixture.submit(PluginControlAction::Reload, id);
    assert_eq!(error_code(fixture.wait(&receipt)), "executor_kind_changed");
    assert_eq!(fixture.observation(id).process_id, original.process_id);
    write_manifest(&root, id);
    let mut registry = fixture.registry();
    registry
        .register_local(
            id,
            LocalPluginRegistration {
                broker_policy: Default::default(),
                path: root.clone(),
                grants: vec![Permission::HostProcess, Permission::CdpRaw],
            },
        )
        .unwrap();
    registry.save().unwrap();
    std::fs::write(
        root.join("dist/host.js"),
        source(
            "rejected",
            "throw new Error('fixture initialization failed');",
        ),
    )
    .unwrap();
    let rollback = fixture.command(PluginControlAction::Reload, id);
    assert_eq!(rollback.outcome, PluginControlOutcome::RolledBack);
    assert_eq!(rollback.generations[0].generation, 3);
    assert!(rollback.desired_enabled);
    assert_eq!(fixture.observation(id).state, ExecutionState::Active);
    assert_ne!(fixture.observation(id).process_id, original.process_id);
    assert!(events(&root).iter().any(|event| event["event"] == "active"
        && event["label"] == "original"
        && event["generation"] == 3));
    assert!(
        std::fs::read_to_string(root.join("dist/host.js"))
            .unwrap()
            .contains("rejected")
    );
    std::fs::write(root.join("dist/host.js"), source("repaired", "")).unwrap();
    assert_eq!(
        fixture.command(PluginControlAction::Reload, id).generations[0].generation,
        4
    );
    fixture.ping();
}

#[test]
fn revoked_grants_or_disable_during_replacement_prevent_unauthorized_compensation() {
    for revoke_grant in [true, false] {
        let mut fixture = Fixture::new();
        let id = "dev.host-trust";
        let root = fixture.register(id, &source("original", ""));
        fixture.command(PluginControlAction::Enable, id);
        std::fs::write(root.join("dist/host.js"), source("replacement", "while (!fs.existsSync(path.join(context.root, 'continue'))) { await new Promise(resolve => setTimeout(resolve, 10)); }")).unwrap();
        let receipt = fixture.submit(PluginControlAction::Reload, id);
        fixture.until(|_| {
            events(&root)
                .iter()
                .any(|event| event["label"] == "replacement" && event["event"] == "starting")
        });
        let mut registry = fixture.registry();
        if revoke_grant {
            registry
                .register_local(
                    id,
                    LocalPluginRegistration {
                        broker_policy: Default::default(),
                        path: root.clone(),
                        grants: vec![Permission::HostProcess],
                    },
                )
                .unwrap();
        } else {
            registry.set_enabled(id, false).unwrap();
        }
        registry.save().unwrap();
        std::fs::write(root.join("continue"), "go").unwrap();
        let report = lifecycle_report(fixture.wait(&receipt));
        assert_eq!(report.outcome, PluginControlOutcome::Degraded);
        assert!(report.generations.is_empty());
        assert!(
            report
                .target_failures
                .iter()
                .any(|failure| failure.stage == "rollback_validate")
        );
        assert!(!matches!(
            fixture.observation(id).state,
            ExecutionState::Starting | ExecutionState::Active | ExecutionState::Stopping
        ));
        assert!(
            !events(&root)
                .iter()
                .any(|event| event["label"] == "original" && event["generation"] == 3)
        );
        if revoke_grant {
            assert_eq!(
                fixture.registry().local_plugins()[id].grants,
                vec![Permission::HostProcess]
            );
        } else {
            assert!(!fixture.registry().is_enabled(id));
            assert!(!report.desired_enabled);
        }
        fixture.ping();
    }
}

#[test]
fn pending_host_receipt_leaves_foreground_and_cdp_available_and_serializes_the_next_control() {
    let mut fixture = Fixture::new();
    let id = "dev.host-pending";
    let root = fixture.register(id, &source("slow", "while (!fs.existsSync(path.join(context.root, 'continue'))) { await new Promise(resolve => setTimeout(resolve, 10)); }"));
    let enable = fixture.submit(PluginControlAction::Enable, id);
    fixture.until(|fixture| fixture.control.is_pending() && !events(&root).is_empty());
    let disable = fixture.submit(PluginControlAction::Disable, id);
    for _ in 0..5 {
        let started = Instant::now();
        fixture.tick();
        assert!(started.elapsed() < Duration::from_millis(250));
        assert_eq!(
            fixture
                .broker
                .handle(ControlRequest::result(&enable))
                .status,
            ControlStatus::Running
        );
        assert_eq!(
            fixture
                .broker
                .handle(ControlRequest::result(&disable))
                .status,
            ControlStatus::Queued
        );
        fixture.ping();
    }
    // A caller can stop waiting and later read the same receipt. Its pending
    // action remains the one originally admitted by the broker.
    std::fs::write(root.join("continue"), "go").unwrap();
    assert_eq!(
        lifecycle_report(fixture.wait(&enable)).outcome,
        PluginControlOutcome::Applied
    );
    assert_eq!(
        lifecycle_report(fixture.wait(&disable)).outcome,
        PluginControlOutcome::Applied
    );
    assert_eq!(
        events(&root)
            .iter()
            .filter(|event| event["event"] == "active")
            .count(),
        1
    );
    assert_eq!(fixture.observation(id).state, ExecutionState::Exited);
}

#[test]
fn broken_new_registration_can_be_disabled_without_loading_an_executor() {
    let mut fixture = Fixture::new();
    let id = "dev.host-broken";
    let root = fixture.register(id, &source("unused", ""));
    let mut registry = fixture.registry();
    registry.set_enabled(id, true).unwrap();
    registry.save().unwrap();
    std::fs::write(root.join("codlet.json"), "invalid").unwrap();
    let report = fixture.command(PluginControlAction::Disable, id);
    assert_eq!(report.outcome, PluginControlOutcome::Applied);
    assert!(!report.desired_enabled && report.generations.is_empty());
    assert!(fixture.hosts.observations().is_empty());
    assert!(events(&root).is_empty());
}

#[test]
fn known_failed_host_that_remains_enabled_can_reload_to_recover() {
    let mut fixture = Fixture::new();
    let id = "dev.host-recover";
    let root = fixture.register(id, &source("failed", "throw new Error('initial failure');"));
    let mut registry = fixture.registry();
    registry.set_enabled(id, true).unwrap();
    registry.save().unwrap();
    let plugin = codlet::local_plugins::load_local_plugin(
        id,
        &root,
        &registry.local_plugins()[id].grants,
        1,
    )
    .unwrap();
    let mut startup = fixture.hosts.begin_start(plugin).unwrap();
    let deadline = Instant::now() + WAIT;
    loop {
        if let Some(result) = startup.try_result() {
            assert!(result.is_err());
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(fixture.observation(id).state, ExecutionState::Failed);
    std::fs::write(root.join("dist/host.js"), source("recovered", "")).unwrap();
    let report = fixture.command(PluginControlAction::Reload, id);
    assert_eq!(report.outcome, PluginControlOutcome::Applied);
    assert_eq!(report.generations[0].generation, 2);
    assert_eq!(fixture.observation(id).state, ExecutionState::Active);
}

#[test]
fn enabled_host_can_reload_after_its_retired_observation_is_evicted() {
    let mut fixture = Fixture::new();
    let id = "dev.host-history";
    let root = fixture.register(id, &source("failed", "throw new Error('history fixture');"));
    let mut registry = fixture.registry();
    registry.set_enabled(id, true).unwrap();
    registry.save().unwrap();
    assert_eq!(
        fixture.command(PluginControlAction::Enable, id).outcome,
        PluginControlOutcome::Degraded
    );
    let snapshot = fixture.observation(id).plugin;

    // Retired observations retain only 64 identities. Reuse a validated source
    // snapshot under fixture identities to exercise real executor retirement.
    for index in 0..65 {
        let mut plugin = snapshot.clone();
        plugin.manifest.id = format!("dev.host-history-{index}");
        let mut operation = fixture.hosts.begin_start(plugin).unwrap();
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(result) = operation.try_result() {
                assert_eq!(result.unwrap_err().code, "initialize_failed");
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    fixture.until(|fixture| {
        !fixture
            .hosts
            .observations()
            .iter()
            .any(|observation| observation.plugin.manifest.id == id)
    });
    std::fs::write(root.join("dist/host.js"), source("recovered", "")).unwrap();
    let report = fixture.command(PluginControlAction::Reload, id);
    assert_eq!(report.outcome, PluginControlOutcome::Applied);
    assert_eq!(report.generations[0].generation, 2);
    assert_eq!(fixture.observation(id).state, ExecutionState::Active);
}

fn import_request(fixture: &Fixture, root: &Path, enable: bool) -> PluginControlRequest {
    let preview = codlet::local_import::preview(&fixture.registry(), root).unwrap();
    PluginControlRequest {
        action: PluginControlAction::Import,
        plugin_id: preview.manifest.id.clone(),
        permission: None,
        cascade: false,
        local_import: Some(preview.request(
            vec![Permission::HostProcess, Permission::CdpRaw],
            Default::default(),
            enable,
        )),
    }
}

#[test]
fn local_import_then_enable_and_remove_use_receipts_and_preserve_author_files() {
    let mut fixture = Fixture::new();
    let id = "dev.local-import";
    let root = fixture.register(id, &source("imported", ""));
    let mut registry = fixture.registry();
    registry.remove_local(id).unwrap();
    registry.save().unwrap();
    let original_source = std::fs::read(root.join("dist/host.js")).unwrap();
    let original_manifest = std::fs::read(root.join("codlet.json")).unwrap();
    let receipt = fixture.submit_request(import_request(&fixture, &root, false));
    let imported = fixture.wait(&receipt);
    assert_eq!(
        lifecycle_report(imported.clone()).action,
        PluginControlAction::Import
    );
    assert!(imported.is_success());
    assert!(!fixture.registry().is_enabled(id));
    assert!(fixture.hosts.observations().is_empty());
    assert!(events(&root).is_empty());
    assert_eq!(
        fixture.broker.handle(ControlRequest::submit(&receipt)),
        imported
    );
    let receipt = fixture.submit_request(import_request(&fixture, &root, true));
    let enabled = fixture.wait(&receipt);
    assert!(enabled.is_success(), "{enabled:?}");
    assert!(fixture.registry().is_enabled(id));
    assert_eq!(fixture.observation(id).state, ExecutionState::Active);
    assert_eq!(
        fixture.broker.handle(ControlRequest::submit(&receipt)),
        enabled
    );
    let running_import = fixture.submit_request(import_request(&fixture, &root, true));
    assert_eq!(error_code(fixture.wait(&running_import)), "plugin_active");
    let receipt = fixture.submit(PluginControlAction::Remove, id);
    let removed = fixture.wait(&receipt);
    assert!(removed.is_success(), "{removed:?}");
    assert_eq!(
        lifecycle_report(removed.clone()).action,
        PluginControlAction::Remove
    );
    assert!(!fixture.registry().local_plugins().contains_key(id));
    assert!(!fixture.registry().is_enabled(id));
    assert!(matches!(
        fixture.observation(id).state,
        ExecutionState::Exited | ExecutionState::Failed
    ));
    assert_eq!(
        fixture.broker.handle(ControlRequest::submit(&receipt)),
        removed
    );
    assert_eq!(
        std::fs::read(root.join("dist/host.js")).unwrap(),
        original_source
    );
    assert_eq!(
        std::fs::read(root.join("codlet.json")).unwrap(),
        original_manifest
    );
    assert_eq!(
        events(&root)
            .iter()
            .filter(|event| event["event"] == "active")
            .count(),
        1
    );
    fixture.ping();
}

#[test]
fn changed_import_and_failed_initial_activation_leave_no_running_authority() {
    let mut fixture = Fixture::new();
    let id = "dev.import-failure";
    let root = fixture.register(id, &source("old", ""));
    let mut registry = fixture.registry();
    registry.remove_local(id).unwrap();
    registry.save().unwrap();
    let receipt = fixture.submit_request(import_request(&fixture, &root, true));
    std::fs::write(
        root.join("dist/host.js"),
        source("bad", "throw new Error('import activation failed');"),
    )
    .unwrap();
    assert_eq!(error_code(fixture.wait(&receipt)), "import_content_changed");
    assert!(!fixture.registry().local_plugins().contains_key(id));
    assert!(fixture.hosts.observations().is_empty());
    let receipt = fixture.submit_request(import_request(&fixture, &root, true));
    let failed = lifecycle_report(fixture.wait(&receipt));
    assert_eq!(failed.action, PluginControlAction::Import);
    assert_eq!(failed.outcome, PluginControlOutcome::Degraded);
    assert!(!failed.desired_enabled);
    assert!(fixture.registry().local_plugins().contains_key(id));
    assert!(!fixture.registry().is_enabled(id));
    assert!(matches!(
        fixture.observation(id).state,
        ExecutionState::Failed | ExecutionState::Exited
    ));
    fixture.ping();
}

#[test]
fn remove_requires_confirmation_for_dependents_and_disables_the_closure_atomically() {
    let mut fixture = Fixture::new();
    let provider = "dev.remove-provider";
    let consumer = "dev.remove-consumer";
    let provider_root = fixture.register(provider, &source("provider", ""));
    let consumer_root = fixture.register(consumer, &source("consumer", ""));
    let cap = json!({"name":"dev.remove-service","api":1,"scope":"runtime"});
    for (id, root, key) in [
        (provider, &provider_root, "provides"),
        (consumer, &consumer_root, "requires"),
    ] {
        let mut manifest: Value =
            serde_json::from_slice(&std::fs::read(root.join("codlet.json")).unwrap()).unwrap();
        manifest[key] = json!([cap]);
        std::fs::write(root.join("codlet.json"), manifest.to_string()).unwrap();
        assert_eq!(
            fixture.command(PluginControlAction::Enable, id).outcome,
            PluginControlOutcome::Applied
        );
    }
    let refused = fixture.submit(PluginControlAction::Remove, provider);
    assert_eq!(error_code(fixture.wait(&refused)), "dependency_conflict");
    assert!(fixture.registry().is_enabled(provider) && fixture.registry().is_enabled(consumer));
    let receipt = fixture.submit_request(PluginControlRequest {
        action: PluginControlAction::Remove,
        plugin_id: provider.into(),
        permission: None,
        cascade: true,
        local_import: None,
    });
    let removed = lifecycle_report(fixture.wait(&receipt));
    assert_eq!(removed.outcome, PluginControlOutcome::Applied);
    assert_eq!(removed.affected_plugin_ids.len(), 2);
    let registry = fixture.registry();
    assert!(!registry.is_enabled(provider) && !registry.is_enabled(consumer));
    assert!(!registry.local_plugins().contains_key(provider));
    assert!(registry.local_plugins().contains_key(consumer));
    // Withdrawing a provider lease may retire its dependent as Failed; both
    // terminal states require confirmed process exit and supervisor cleanup.
    for id in [provider, consumer] {
        assert!(matches!(
            fixture.observation(id).state,
            ExecutionState::Exited | ExecutionState::Failed
        ));
    }
    assert!(
        provider_root.join("dist/host.js").is_file()
            && consumer_root.join("dist/host.js").is_file()
    );
    fixture.ping();
}
