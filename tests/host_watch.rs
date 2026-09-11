#![cfg(windows)]

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use codlet::catalog::PluginCatalog;
use codlet::cdp::CdpClient;
use codlet::host_control::{HostControl, HostWatchResult};
use codlet::host_runtime::HostRuntime;
use codlet::js_runtime::JsRuntime;
use codlet::plugin_control::{
    PluginControlAction, PluginControlOutcome, PluginControlReport, PluginControlRequest,
};
use codlet::plugin_execution::{ExecutionState, PluginExecutionObservation};
use codlet::plugin_watch::{PluginWatcher, WatchDiagnostic, WatchedReload};
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
    watcher: PluginWatcher,
    client: CdpClient,
    child: ChildProcess,
    directory: TempDir,
    registry_path: PathBuf,
    now: Instant,
    watch_tickets: Vec<String>,
    watch_results: Vec<HostWatchResult>,
    diagnostics: Vec<WatchDiagnostic>,
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
        let runtime = js_runtime();
        let hosts =
            HostRuntime::start_with_runtime(Vec::new(), client.clone(), Some(runtime)).unwrap();
        let broker = ControlBroker::new([6; 16], "f".repeat(64));
        broker.set_ready();
        Self {
            hosts,
            control: HostControl::new(registry_path.clone()),
            broker,
            renderer,
            watcher: PluginWatcher::new(registry_path.clone()),
            client,
            child,
            directory,
            registry_path,
            now: Instant::now(),
            watch_tickets: Vec::new(),
            watch_results: Vec::new(),
            diagnostics: Vec::new(),
        }
    }

    fn registry(&self) -> PluginRegistry {
        PluginRegistry::load(&self.registry_path).unwrap()
    }

    fn register(&self, id: &str, text: &str, raw: bool) -> PathBuf {
        let root = self.directory.path().join(id);
        std::fs::create_dir_all(root.join("dist")).unwrap();
        std::fs::write(root.join("dist/host.js"), text).unwrap();
        write_manifest(&root, id, raw, "dist/host.js");
        let root = std::fs::canonicalize(root).unwrap();
        let mut registry = self.registry();
        let mut grants = vec![Permission::HostProcess];
        if raw {
            grants.push(Permission::CdpRaw);
        }
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

    fn start(&mut self, id: &str, text: &str, raw: bool) -> PathBuf {
        let root = self.register(id, text, raw);
        let report = self.command(PluginControlAction::Enable, id);
        assert_eq!(report.outcome, PluginControlOutcome::Applied);
        root
    }

    fn submit_cli(&self, action: PluginControlAction, id: &str) -> String {
        let prepared = self
            .broker
            .handle(ControlRequest::prepare(PluginControlRequest {
                action,
                plugin_id: id.into(),
                permission: None,
                cascade: false,
                local_import: None,
            }));
        let ticket = prepared.operation_id().unwrap().to_owned();
        assert_eq!(
            self.broker.handle(ControlRequest::submit(&ticket)).status,
            ControlStatus::Queued
        );
        ticket
    }

    fn enqueue_watch(&mut self, selection: WatchedReload) -> String {
        let ticket = self
            .control
            .submit_watched(selection, &self.broker)
            .unwrap();
        self.watch_tickets.push(ticket.clone());
        ticket
    }

    // Mirrors the production owner-loop ordering: a pending host transaction
    // blocks only another lifecycle action; an existing receipt always precedes
    // a new watch scan. Controlled scan time avoids sleeps for debounce tests.
    fn tick(&mut self, scan_elapsed_ms: Option<u64>) {
        if let Some(elapsed) = scan_elapsed_ms {
            self.now += Duration::from_millis(elapsed);
        }
        let observations = self.hosts.observations();
        self.renderer
            .set_external_observations(observations.clone());
        self.renderer.pump_bindings().unwrap();
        self.control
            .poll(&mut self.renderer, &self.hosts, &self.broker);
        if !self.control.is_pending() {
            if let Some(job) = self.broker.take_next() {
                if let Some(job) =
                    self.control
                        .dispatch(job, &mut self.renderer, &self.hosts, &self.broker)
                {
                    self.broker
                        .complete(&job.operation_id, self.renderer.manage_plugin(job.request));
                }
            } else if scan_elapsed_ms.is_some() && !self.control.has_watch_receipt() {
                let mut sources = self.renderer.local_watch_sources();
                sources.extend(self.control.local_watch_sources(&observations));
                let selected = self.watcher.poll_guarded(self.now, &sources);
                self.diagnostics.extend(self.watcher.take_diagnostics());
                if let Some(selected) = selected {
                    assert!(selected.is_host());
                    self.enqueue_watch(selected);
                }
            }
        }
        for result in self.control.take_watch_results() {
            if let Some(selection) = &result.not_attempted {
                self.watcher.not_attempted(selection);
            }
            self.watch_results.push(result);
        }
    }

    fn select_without_enqueue(&mut self, elapsed_ms: u64) -> Option<WatchedReload> {
        self.now += Duration::from_millis(elapsed_ms);
        let observations = self.hosts.observations();
        let sources = self.control.local_watch_sources(&observations);
        self.watcher.poll_guarded(self.now, &sources)
    }

    fn wait(&mut self, ticket: &str) -> ControlReport {
        let deadline = Instant::now() + WAIT;
        loop {
            self.tick(None);
            let report = self.broker.handle(ControlRequest::result(ticket));
            if report.status == ControlStatus::Completed {
                return report;
            }
            assert!(
                Instant::now() < deadline,
                "receipt did not complete: {:?}; observations={:?}",
                report.status,
                self.hosts.observations()
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn command(&mut self, action: PluginControlAction, id: &str) -> PluginControlReport {
        let ticket = self.submit_cli(action, id);
        lifecycle_report(self.wait(&ticket))
    }

    fn changed(&mut self) -> String {
        let before = self.watch_tickets.len();
        self.tick(Some(250));
        assert_eq!(self.watch_tickets.len(), before);
        self.tick(Some(250));
        assert_eq!(self.watch_tickets.len(), before + 1);
        self.watch_tickets.last().unwrap().clone()
    }

    fn until(&mut self, predicate: impl Fn(&Self) -> bool) {
        let deadline = Instant::now() + WAIT;
        while !predicate(self) {
            self.tick(None);
            assert!(
                Instant::now() < deadline,
                "host state did not settle: {:?}",
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

fn write_manifest(root: &Path, id: &str, raw: bool, entry: &str) {
    let mut permissions = vec!["host.process"];
    if raw {
        permissions.push("cdp.raw");
    }
    std::fs::write(
        root.join("codlet.json"),
        json!({"schema":1,"id":id,"version":"1","host":{"entry":entry},"permissions":permissions})
            .to_string(),
    )
    .unwrap();
}

fn js_runtime() -> JsRuntime {
    JsRuntime::from_distribution(Path::new(env!("CARGO_BIN_EXE_codlet")).parent().unwrap())
        .expect("stage the pinned Node runtime beside target/debug/codlet.exe")
}

fn source(label: &str, initialize: &str) -> String {
    source_mode(label, initialize, true)
}
fn source_mode(label: &str, initialize: &str, raw: bool) -> String {
    format!(
        r#"
const fs = require('node:fs'); const path = require('node:path');
let context; let timer; let counter = 0;
function record(event) {{ fs.appendFileSync(path.join(context.root, 'events.jsonl'), JSON.stringify({{event,label:{label:?},generation:context.plugin.generation,pid:process.pid}}) + '\n'); }}
module.exports = {{
  async activate(value) {{ context = value; record('starting'); if ({raw}) await context.cdp.request('Fixture.ping'); {initialize} record('active'); }},
  deactivate() {{ clearInterval(timer); record('deactivate'); }}
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
        other => panic!("expected lifecycle rejection, got {other:?}"),
    }
}

#[test]
fn online_enabled_host_joins_watch_coalesces_writes_and_follows_only_the_declared_entry() {
    let mut fixture = Fixture::new();
    let id = "dev.watch-live";
    let root = fixture.register(id, &source("original", ""), true);
    fixture.tick(Some(0));
    fixture.tick(Some(250));
    assert!(fixture.watch_tickets.is_empty() && fixture.hosts.observations().is_empty());
    fixture.command(PluginControlAction::Enable, id);
    fixture.tick(Some(250));
    std::fs::write(root.join("dist/host.js"), source("transient", "")).unwrap();
    fixture.tick(Some(250));
    std::fs::write(root.join("dist/host.js"), source("settled", "")).unwrap();
    fixture.tick(Some(250));
    fixture.tick(Some(249));
    assert!(fixture.watch_tickets.is_empty());
    fixture.tick(Some(1));
    let ticket = fixture.watch_tickets.last().unwrap().clone();
    let completed = fixture.wait(&ticket);
    assert_eq!(
        lifecycle_report(completed.clone()).generations[0].generation,
        2
    );
    assert_eq!(
        fixture.broker.handle(ControlRequest::submit(&ticket)),
        completed
    );
    assert!(
        !events(&root)
            .iter()
            .any(|event| event["label"] == "transient")
    );
    assert_eq!(fixture.renderer.plugin_count(), 0);

    std::fs::write(
        root.join("dist/replacement.js"),
        source("entry-changed", ""),
    )
    .unwrap();
    write_manifest(&root, id, true, "dist/replacement.js");
    let ticket = fixture.changed();
    assert_eq!(
        lifecycle_report(fixture.wait(&ticket)).generations[0].generation,
        3
    );
    let count = fixture.watch_tickets.len();
    std::fs::write(
        root.join("dist/host.js"),
        "throw new Error('old entry is no longer watched');",
    )
    .unwrap();
    std::fs::write(
        root.join("settings.json"),
        "resource changes require explicit reload",
    )
    .unwrap();
    std::fs::write(
        root.join("dist/helper.js"),
        "module.exports = 'dependency';",
    )
    .unwrap();
    for _ in 0..4 {
        fixture.tick(Some(250));
    }
    assert_eq!(fixture.watch_tickets.len(), count);
    assert_eq!(fixture.observation(id).plugin.generation, 3);
    fixture.ping();
}

#[test]
fn invalid_missing_locked_and_kind_changed_sources_leave_the_active_generation_and_report_once() {
    use std::os::windows::fs::OpenOptionsExt;
    let mut fixture = Fixture::new();
    let id = "dev.watch-invalid";
    let root = fixture.start(id, &source("original", ""), true);
    let original = fixture.observation(id);
    fixture.tick(Some(0));
    std::fs::write(root.join("codlet.json"), "{incomplete").unwrap();
    let ticket = fixture.changed();
    assert_eq!(error_code(fixture.wait(&ticket)), "local_plugin_invalid");
    for _ in 0..5 {
        fixture.tick(Some(250));
    }
    assert_eq!(fixture.watch_tickets.len(), 1);
    assert_eq!(fixture.watch_results.len(), 1);

    write_manifest(&root, id, true, "dist/host.js");
    std::fs::remove_file(root.join("dist/host.js")).unwrap();
    let ticket = fixture.changed();
    assert_eq!(error_code(fixture.wait(&ticket)), "local_plugin_invalid");
    std::fs::write(root.join("dist/host.js"), b"\xffpartial JS").unwrap();
    let ticket = fixture.changed();
    assert_eq!(error_code(fixture.wait(&ticket)), "local_plugin_invalid");
    std::fs::write(root.join("dist/host.js"), source("writing", "")).unwrap();
    let writer = std::fs::OpenOptions::new()
        .write(true)
        .share_mode(0)
        .open(root.join("dist/host.js"))
        .unwrap();
    let ticket = fixture.changed();
    assert_eq!(error_code(fixture.wait(&ticket)), "local_plugin_invalid");
    drop(writer);
    std::fs::write(root.join("codlet.json"), json!({"schema":1,"id":id,"version":"1","renderer":{"entry":"dist/host.js","world":"isolated"},"permissions":[]}).to_string()).unwrap();
    let ticket = fixture.changed();
    assert_eq!(error_code(fixture.wait(&ticket)), "local_plugin_invalid");
    assert_eq!(fixture.observation(id).process_id, original.process_id);
    assert_eq!(fixture.observation(id).plugin.generation, 1);
    assert!(
        !events(&root)
            .iter()
            .any(|event| event["event"] == "deactivate")
    );

    write_manifest(&root, id, true, "dist/host.js");
    std::fs::write(root.join("dist/host.js"), source("repaired", "")).unwrap();
    let ticket = fixture.changed();
    assert_eq!(
        lifecycle_report(fixture.wait(&ticket)).generations[0].generation,
        2
    );
    fixture.ping();
}

#[test]
fn failed_watch_activation_restores_old_snapshot_once_and_a_new_edit_recovers() {
    let mut fixture = Fixture::new();
    let id = "dev.watch-rollback";
    let root = fixture.start(id, &source("original", ""), true);
    fixture.tick(Some(0));
    std::fs::write(
        root.join("dist/host.js"),
        source("failed", "throw new Error('watch initialization failed');"),
    )
    .unwrap();
    let ticket = fixture.changed();
    let report = lifecycle_report(fixture.wait(&ticket));
    assert_eq!(report.outcome, PluginControlOutcome::RolledBack);
    assert_eq!(report.generations[0].generation, 3);
    assert!(events(&root).iter().any(|event| event["event"] == "active"
        && event["label"] == "original"
        && event["generation"] == 3));
    for _ in 0..8 {
        fixture.tick(Some(250));
    }
    assert_eq!(fixture.watch_tickets.len(), 1);
    assert_eq!(fixture.observation(id).plugin.generation, 3);
    assert_eq!(
        events(&root)
            .iter()
            .filter(|event| event["label"] == "failed" && event["event"] == "starting")
            .count(),
        1
    );
    std::fs::write(root.join("dist/host.js"), source("repaired", "")).unwrap();
    let ticket = fixture.changed();
    assert_eq!(
        lifecycle_report(fixture.wait(&ticket)).generations[0].generation,
        4
    );
    fixture.ping();
}

#[test]
fn host_watch_pins_full_grants_and_root_and_stops_observing_removed_or_disabled_plugins() {
    let mut fixture = Fixture::new();
    let id = "dev.watch-trust";
    let root = fixture.start(id, &source_mode("original", "", false), false);
    fixture.tick(Some(0));
    std::fs::write(root.join("dist/host.js"), source_mode("changed", "", false)).unwrap();
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
    for _ in 0..5 {
        fixture.tick(Some(250));
    }
    assert!(fixture.watch_tickets.is_empty());
    assert_eq!(
        fixture
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code == "watch_grants_changed")
            .count(),
        1
    );
    assert_eq!(
        fixture.command(PluginControlAction::Enable, id).outcome,
        PluginControlOutcome::Unchanged
    );
    let ticket = fixture.changed();
    assert_eq!(
        lifecycle_report(fixture.wait(&ticket)).generations[0].generation,
        2
    );

    let mut registry = fixture.registry();
    registry.remove_local(id).unwrap();
    registry.save().unwrap();
    fixture.tick(Some(250));
    fixture.tick(Some(250));
    assert!(
        fixture
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "watch_registration_removed")
    );
    let replacement = fixture.directory.path().join("replacement");
    std::fs::create_dir(&replacement).unwrap();
    let replacement = std::fs::canonicalize(replacement).unwrap();
    registry
        .register_local(
            id,
            LocalPluginRegistration {
                broker_policy: Default::default(),
                path: replacement.clone(),
                grants: vec![Permission::HostProcess, Permission::CdpRaw],
            },
        )
        .unwrap();
    registry
        .register_local(
            "dev.never-loaded",
            LocalPluginRegistration {
                broker_policy: Default::default(),
                path: fixture.directory.path().join("must-not-be-read"),
                grants: vec![Permission::HostProcess],
            },
        )
        .unwrap();
    registry.save().unwrap();
    for _ in 0..5 {
        fixture.tick(Some(250));
    }
    assert_eq!(fixture.watch_tickets.len(), 1);
    assert_eq!(fixture.observation(id).plugin.generation, 2);
    assert!(
        fixture
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "watch_registration_path_changed")
    );
    assert!(
        fixture
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.plugin_id != "dev.never-loaded")
    );
    assert!(!replacement.join("codlet.json").exists());
    fixture.command(PluginControlAction::Disable, id);
    for _ in 0..4 {
        fixture.tick(Some(250));
    }
    assert!(
        fixture
            .control
            .local_watch_sources(&fixture.hosts.observations())
            .is_empty()
    );
    assert_eq!(fixture.watch_tickets.len(), 1);
    assert_eq!(fixture.observation(id).state, ExecutionState::Exited);
}

#[test]
fn source_changes_after_the_stable_selection_are_rejected_before_retirement() {
    let mut fixture = Fixture::new();
    let id = "dev.watch-stable-guard";
    let root = fixture.start(id, &source("original", ""), true);
    fixture.tick(Some(0));
    std::fs::write(root.join("dist/host.js"), source("selected", "")).unwrap();
    assert!(fixture.select_without_enqueue(250).is_none());
    let selected = fixture.select_without_enqueue(250).unwrap();
    std::fs::write(root.join("dist/host.js"), source("saved-later", "")).unwrap();
    let ticket = fixture.enqueue_watch(selected);
    assert_eq!(error_code(fixture.wait(&ticket)), "watch_source_unsettled");
    assert_eq!(fixture.observation(id).plugin.generation, 1);
    assert!(
        !events(&root)
            .iter()
            .any(|event| event["event"] == "deactivate")
    );
    // Restore F1 after the guard saw F2. F1 was never executed, so the old
    // selected signature must not suppress a fresh stable attempt forever.
    std::fs::write(root.join("dist/host.js"), source("selected", "")).unwrap();
    let ticket = fixture.changed();
    assert_eq!(
        lifecycle_report(fixture.wait(&ticket)).generations[0].generation,
        2
    );
    assert_eq!(
        events(&root)
            .iter()
            .filter(|event| event["label"] == "selected" && event["event"] == "active")
            .count(),
        1
    );
    assert!(
        !events(&root)
            .iter()
            .any(|event| event["label"] == "saved-later")
    );
    for _ in 0..4 {
        fixture.tick(Some(250));
    }
    assert_eq!(fixture.watch_tickets.len(), 2);
}

#[test]
fn queued_cli_precedes_watch_and_generation_or_grant_changes_reject_the_stale_receipt() {
    let mut fixture = Fixture::new();
    let id = "dev.watch-queue";
    let root = fixture.start(id, &source("original", ""), true);
    fixture.tick(Some(0));
    std::fs::write(root.join("dist/host.js"), source("selected", "")).unwrap();
    assert!(fixture.select_without_enqueue(250).is_none());
    let selection = fixture.select_without_enqueue(250).unwrap();
    // A CLI request can arrive while file observation runs. Queue it before the
    // watch receipt, as the production mailbox does, and preserve that order.
    let cli = fixture.submit_cli(PluginControlAction::Reload, id);
    let watched = fixture.enqueue_watch(selection);
    assert_eq!(
        lifecycle_report(fixture.wait(&cli)).generations[0].generation,
        2
    );
    assert_eq!(
        error_code(fixture.wait(&watched)),
        "watch_generation_changed"
    );
    assert_eq!(
        events(&root)
            .iter()
            .filter(|event| event["event"] == "active" && event["label"] == "selected")
            .count(),
        1
    );

    std::fs::write(root.join("dist/host.js"), source("next", "")).unwrap();
    assert!(fixture.select_without_enqueue(250).is_none());
    let selection = fixture.select_without_enqueue(250).unwrap();
    let watched = fixture.enqueue_watch(selection);
    let mut registry = fixture.registry();
    registry
        .register_local(
            id,
            LocalPluginRegistration {
                broker_policy: Default::default(),
                path: root.clone(),
                grants: vec![Permission::CdpRaw, Permission::HostProcess],
            },
        )
        .unwrap();
    registry.save().unwrap();
    assert_eq!(error_code(fixture.wait(&watched)), "watch_source_changed");
    for _ in 0..3 {
        fixture.tick(Some(250));
    }
    assert_eq!(fixture.observation(id).plugin.generation, 2);
    assert_eq!(fixture.watch_tickets.len(), 2);
    fixture.command(PluginControlAction::Enable, id);
    let ticket = fixture.changed();
    assert_eq!(
        lifecycle_report(fixture.wait(&ticket)).generations[0].generation,
        3
    );
}

#[test]
fn pending_watch_keeps_other_host_rpc_alive_and_serializes_cli_without_sampling_a_second_edit() {
    let mut fixture = Fixture::new();
    let id = "dev.watch-slow";
    let root = fixture.start(id, &source("original", ""), true);
    let buddy_id = "dev.watch-buddy";
    let buddy = fixture.start(buddy_id, &source("buddy", "timer = setInterval(() => context.cdp.request('Fixture.ping').then(() => fs.writeFileSync(path.join(context.root, 'heartbeat'), String(++counter))).catch(() => {}), 20);"), true);
    fixture.tick(Some(0));
    std::fs::write(root.join("dist/host.js"), source("waiting", "while (!fs.existsSync(path.join(context.root, 'continue'))) await new Promise(resolve => setTimeout(resolve, 10));")).unwrap();
    let watched = fixture.changed();
    fixture.until(|fixture| {
        fixture.control.is_pending()
            && events(&root)
                .iter()
                .any(|event| event["label"] == "waiting" && event["event"] == "starting")
    });
    let heartbeat = || {
        std::fs::read_to_string(buddy.join("heartbeat"))
            .ok()
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(0)
    };
    let before = heartbeat();
    std::fs::write(buddy.join("dist/host.js"), source("must-not-run", "")).unwrap();
    let disable = fixture.submit_cli(PluginControlAction::Disable, buddy_id);
    for _ in 0..6 {
        let started = Instant::now();
        fixture.tick(Some(250));
        assert!(started.elapsed() < Duration::from_millis(250));
        assert_eq!(
            fixture
                .broker
                .handle(ControlRequest::result(&disable))
                .status,
            ControlStatus::Queued
        );
        assert_eq!(fixture.watch_tickets.len(), 1);
        fixture.ping();
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(heartbeat() > before);
    std::fs::write(root.join("continue"), "go").unwrap();
    assert_eq!(
        lifecycle_report(fixture.wait(&watched)).generations[0].generation,
        2
    );
    assert_eq!(
        lifecycle_report(fixture.wait(&disable)).outcome,
        PluginControlOutcome::Applied
    );
    for _ in 0..3 {
        fixture.tick(Some(250));
    }
    assert_eq!(fixture.watch_tickets.len(), 1);
    assert!(
        !events(&buddy)
            .iter()
            .any(|event| event["label"] == "must-not-run")
    );
}

#[test]
fn an_initially_loaded_failed_host_keeps_its_source_anchor_and_watch_can_recover_a_fix() {
    let mut fixture = Fixture::new();
    let id = "dev.watch-startup";
    let root = fixture.register(
        id,
        &source("startup-failed", "throw new Error('startup failure');"),
        true,
    );
    let mut registry = fixture.registry();
    registry.set_enabled(id, true).unwrap();
    registry.save().unwrap();
    let catalog = PluginCatalog::load(&registry).unwrap();
    let plugins = catalog.enabled_plugins(&registry).unwrap();
    fixture.renderer = RendererRuntime::from_catalog(catalog, registry).unwrap();
    fixture
        .control
        .seed_watch_sources(&fixture.renderer, &plugins);
    fixture.hosts.stop().unwrap();
    fixture.hosts =
        HostRuntime::start_with_runtime(plugins, fixture.client.clone(), Some(js_runtime()))
            .unwrap();
    fixture.until(|fixture| {
        fixture.hosts.observations().iter().any(|observation| {
            observation.plugin.manifest.id == id && observation.state == ExecutionState::Failed
        })
    });
    fixture.tick(Some(0));
    assert!(fixture.watch_tickets.is_empty());
    std::fs::write(root.join("dist/host.js"), source("startup-repaired", "")).unwrap();
    let ticket = fixture.changed();
    let report = lifecycle_report(fixture.wait(&ticket));
    assert_eq!(report.outcome, PluginControlOutcome::Applied);
    assert_eq!(report.generations[0].generation, 2);
    assert_eq!(fixture.observation(id).state, ExecutionState::Active);
}

/// Every path is resolved inside this test's own tempdir before moving a
/// directory or creating a junction. Teardown removes only the junction entry,
/// then restores the parked original; it never recursively follows a link.
struct ParkedWatchRoot {
    boundary: PathBuf,
    root: PathBuf,
    parked: PathBuf,
    restored: bool,
}

impl ParkedWatchRoot {
    fn new(boundary: &Path, root: &Path) -> Self {
        let boundary = std::fs::canonicalize(boundary).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let parked = boundary.join("parked-watch-root");
        assert!(root.starts_with(&boundary) && root != boundary);
        assert!(parked.starts_with(&boundary) && !parked.exists());
        std::fs::rename(&root, &parked).unwrap();
        Self {
            boundary,
            root,
            parked,
            restored: false,
        }
    }

    fn redirect_to(&self, target: &Path) {
        use std::os::windows::process::CommandExt;
        let target = std::fs::canonicalize(target).unwrap();
        assert!(target.starts_with(&self.boundary) && target != self.boundary);
        assert!(!self.root.exists() && self.root.starts_with(&self.boundary));
        // Windows PowerShell's Junction provider mishandles verbatim prefixes.
        // Pass equivalent DOS paths via environment only, after resolving their
        // target and parent back to the same checked tempdir boundary.
        let root_text = self.root.to_str().unwrap();
        let target_text = target.to_str().unwrap();
        let link_path = Path::new(root_text.strip_prefix(r"\\?\").unwrap_or(root_text));
        let target_path = Path::new(target_text.strip_prefix(r"\\?\").unwrap_or(target_text));
        assert_eq!(std::fs::canonicalize(target_path).unwrap(), target);
        assert!(
            std::fs::canonicalize(link_path.parent().unwrap())
                .unwrap()
                .starts_with(&self.boundary)
        );
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; New-Item -ItemType Junction -Path $env:CODLET_WATCH_JUNCTION_LINK -Target $env:CODLET_WATCH_JUNCTION_TARGET | Out-Null"])
            .env("CODLET_WATCH_JUNCTION_LINK", link_path)
            .env("CODLET_WATCH_JUNCTION_TARGET", target_path)
            .creation_flags(0x0800_0000)
            .output().unwrap();
        assert!(
            output.status.success(),
            "junction fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(std::fs::canonicalize(&self.root).unwrap(), target);
    }

    fn restore(&mut self) -> std::io::Result<()> {
        use std::os::windows::fs::MetadataExt;
        if self.restored {
            return Ok(());
        }
        match std::fs::symlink_metadata(&self.root) {
            Ok(metadata) => {
                if metadata.file_attributes() & 0x400 == 0 {
                    return Err(std::io::Error::other(
                        "fixture root was replaced by an unexpected ordinary directory",
                    ));
                }
                std::fs::remove_dir(&self.root)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        std::fs::rename(&self.parked, &self.root)?;
        self.restored = true;
        Ok(())
    }
}

impl Drop for ParkedWatchRoot {
    fn drop(&mut self) {
        let _ = self.restore();
    }
}

#[test]
fn a_missing_or_junction_redirected_loaded_host_root_is_paused_before_reads_and_queued_execution() {
    use std::os::windows::fs::OpenOptionsExt;
    let mut fixture = Fixture::new();
    let id = "dev.watch-root";
    let root = fixture.register(
        id,
        &source(
            "retired-original",
            "throw new Error('retire before moving the fixture cwd');",
        ),
        true,
    );
    let mut registry = fixture.registry();
    registry.set_enabled(id, true).unwrap();
    registry.save().unwrap();
    let catalog = PluginCatalog::load(&registry).unwrap();
    let plugins = catalog.enabled_plugins(&registry).unwrap();
    fixture.renderer = RendererRuntime::from_catalog(catalog, registry).unwrap();
    fixture
        .control
        .seed_watch_sources(&fixture.renderer, &plugins);
    fixture.hosts.stop().unwrap();
    fixture.hosts =
        HostRuntime::start_with_runtime(plugins, fixture.client.clone(), Some(js_runtime()))
            .unwrap();
    fixture.until(|fixture| {
        fixture.hosts.observations().iter().any(|observation| {
            observation.plugin.manifest.id == id && observation.state == ExecutionState::Failed
        })
    });
    let old = fixture.observation(id);
    assert!(
        fixture.hosts.execution_snapshot().plugins[0]
            .exit
            .as_ref()
            .is_some_and(|exit| exit.workers_reaped)
    );
    fixture.tick(Some(0));

    let repaired = source("repaired-original", "");
    std::fs::write(root.join("dist/host.js"), &repaired).unwrap();
    assert!(fixture.select_without_enqueue(250).is_none());
    let selection = fixture.select_without_enqueue(250).unwrap();
    {
        let mut missing = ParkedWatchRoot::new(fixture.directory.path(), &root);
        let ticket = fixture.enqueue_watch(selection);
        assert_eq!(error_code(fixture.wait(&ticket)), "watch_root_unavailable");
        for _ in 0..6 {
            fixture.tick(Some(250));
        }
        assert_eq!(fixture.watch_tickets.len(), 1);
        assert_eq!(
            fixture
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code == "watch_root_unavailable")
                .count(),
            1
        );
        assert_eq!(fixture.observation(id).plugin.generation, 1);
        missing.restore().unwrap();
    }

    // Build a byte-identical substitute. A fingerprint-only guard could accept
    // it; the canonical root must be rejected before reading its locked manifest.
    let replacement = fixture.directory.path().join("redirected-watch-root");
    std::fs::create_dir_all(replacement.join("dist")).unwrap();
    std::fs::copy(root.join("codlet.json"), replacement.join("codlet.json")).unwrap();
    std::fs::write(replacement.join("dist/host.js"), &repaired).unwrap();
    let replacement = std::fs::canonicalize(replacement).unwrap();
    assert!(fixture.select_without_enqueue(250).is_none());
    let selection = fixture.select_without_enqueue(250).unwrap();
    {
        let mut redirected = ParkedWatchRoot::new(fixture.directory.path(), &root);
        redirected.redirect_to(&replacement);
        let locked = std::fs::OpenOptions::new()
            .write(true)
            .share_mode(0)
            .open(replacement.join("codlet.json"))
            .unwrap();
        let ticket = fixture.enqueue_watch(selection);
        assert_eq!(error_code(fixture.wait(&ticket)), "watch_root_changed");
        for _ in 0..6 {
            fixture.tick(Some(250));
        }
        assert_eq!(fixture.watch_tickets.len(), 2);
        assert_eq!(
            fixture
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code == "watch_root_changed")
                .count(),
            1
        );
        assert_eq!(fixture.observation(id).plugin.generation, 1);
        assert_eq!(fixture.observation(id).process_id, old.process_id);
        assert!(!replacement.join("events.jsonl").exists());
        drop(locked);
        redirected.restore().unwrap();
    }

    let repaired_ticket = fixture.changed();
    let repaired_report = lifecycle_report(fixture.wait(&repaired_ticket));
    assert_eq!(repaired_report.outcome, PluginControlOutcome::Applied);
    assert_eq!(repaired_report.generations[0].generation, 2);
    assert_eq!(fixture.observation(id).plugin.host.unwrap().root, root);
    assert!(!replacement.join("events.jsonl").exists());
    assert!(
        events(&root)
            .iter()
            .any(|event| event["event"] == "active" && event["label"] == "repaired-original")
    );
}
