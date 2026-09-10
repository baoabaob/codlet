//! Actual production renderer/bootstrap + managed Host JS acceptance. The peer
//! runs JS in bounded VM worlds, without pretending to be a browser DOM.

use std::collections::BTreeSet;
use std::fs::File;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

use serde_json::json;
use tempfile::{TempDir, tempdir};

use super::*;
use crate::catalog::PluginCatalog;
use crate::cdp::{TargetController, TargetSession};
use crate::host_control::HostControl;
use crate::host_runtime::HostRuntime;
use crate::js_runtime::JsRuntime;
use crate::plugin_control::{
    PluginControlAction, PluginControlOutcome, PluginControlReport, PluginControlRequest,
};
use crate::plugin_execution::ExecutionState;
use crate::plugins::{LocalPluginRegistration, Permission, PluginRegistry, bundled_plugins};
use crate::renderer::RendererRuntime;
use crate::runtime_control::{ControlBroker, ControlCompletion, ControlRequest, ControlStatus};

const WAIT: Duration = Duration::from_secs(12);
const PLUGIN: &str = "example.combined";
const RESULT: &str = "__codletCombinedExample";
const EXAMPLE_MANIFEST: &str =
    include_str!("../../../examples/local-host-renderer-capability/codlet.json");
const EXAMPLE_HOST: &str = include_str!("../../../examples/local-host-renderer-capability/host.js");
const EXAMPLE_RENDERER: &str =
    include_str!("../../../examples/local-host-renderer-capability/renderer.js");

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

pub(super) struct VmPeer {
    pub(super) client: CdpClient,
    child: ChildGuard,
    pub(super) runtime: JsRuntime,
    log: PathBuf,
    _directory: TempDir,
    closed: bool,
}

impl VmPeer {
    pub(super) fn start() -> (Self, CdpEventStream) {
        // discover verifies the checked-in executable digest and holds the pin
        // against replacement. Derive exactly the same distribution path; never
        // invoke a PATH Node or expose a production transport constructor.
        let runtime = JsRuntime::discover().expect(
            "stage the pinned Node distribution beside the unit-test binary in target/debug/deps",
        );
        let pin: Value =
            serde_json::from_str(include_str!("../../../runtime/node-runtime.json")).unwrap();
        let platform = match std::env::consts::ARCH {
            "x86_64" => "win-x64",
            "aarch64" => "win-arm64",
            other => panic!("unsupported pinned platform {other}"),
        };
        let executable = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .join("runtime")
            .join(format!(
                "node-v{}-{platform}",
                pin["version"].as_str().unwrap()
            ))
            .join("node.exe");
        let directory = tempdir().unwrap();
        let log = directory.path().join("peer-stderr.log");
        let stderr = File::create(&log).unwrap();
        let mut command = Command::new(executable);
        command
            .args([
                "--no-addons",
                "--no-experimental-strip-types",
                "--no-global-search-paths",
                "--max-old-space-size=128",
            ])
            .arg(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/fixtures/renderer-cdp-peer.cjs"),
            )
            .current_dir(directory.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(stderr)
            .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        for (key, _) in std::env::vars_os() {
            let name = key.to_string_lossy().to_ascii_uppercase();
            if name.starts_with("NODE_")
                || name.starts_with("OPENSSL_")
                || name == "ELECTRON_RUN_AS_NODE"
            {
                command.env_remove(key);
            }
        }
        let mut child = ChildGuard(command.spawn().unwrap());
        let reader = child.0.stdout.take().unwrap();
        let writer = child.0.stdin.take().unwrap();
        let (client, events) = CdpClient::spawn_io(reader, writer, SpawnConfig::default()).unwrap();
        (
            Self {
                client,
                child,
                runtime,
                log,
                _directory: directory,
                closed: false,
            },
            events,
        )
    }

    pub(super) fn request(&self, method: &str, params: Value) -> Value {
        self.client
            .request(method, Some(params), None, Duration::from_secs(3))
            .unwrap_or_else(|error| {
                panic!(
                    "VM peer {method}: {error}; stderr={}",
                    std::fs::read_to_string(&self.log).unwrap_or_default()
                )
            })
            .result
            .unwrap()
    }

    pub(super) fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        let workers = self.client.shutdown();
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut forced = false;
        let status = loop {
            if let Some(status) = self.child.0.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= deadline {
                forced = true;
                let _ = self.child.0.kill();
                break self.child.0.wait().unwrap();
            }
            thread::sleep(Duration::from_millis(5));
        };
        if !thread::panicking() {
            workers.expect("VM CDP workers must be reaped");
            assert!(
                !forced && status.success(),
                "VM peer did not close normally: {status}; {}",
                std::fs::read_to_string(&self.log).unwrap_or_default()
            );
        }
    }
}

impl Drop for VmPeer {
    fn drop(&mut self) {
        self.close();
    }
}

struct Fixture {
    renderer: RendererRuntime,
    hosts: HostRuntime,
    control: HostControl,
    broker: ControlBroker,
    controller: TargetController,
    initial_sessions: Vec<TargetSession>,
    peer: VmPeer,
    root: PathBuf,
    registry_path: PathBuf,
    _directory: TempDir,
    closed: bool,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempdir().unwrap();
        let root = directory.path().join("combined-example");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("codlet.json"), EXAMPLE_MANIFEST).unwrap();
        std::fs::write(root.join("host.js"), EXAMPLE_HOST).unwrap();
        std::fs::write(root.join("renderer.js"), EXAMPLE_RENDERER).unwrap();
        let registry_path = directory.path().join("config.json");
        let mut registry = PluginRegistry::load(&registry_path).unwrap();
        for plugin in bundled_plugins().unwrap() {
            registry.set_enabled(&plugin.manifest.id, false).unwrap();
        }
        registry
            .register_local(
                PLUGIN,
                LocalPluginRegistration {
                    broker_policy: Default::default(),
                    path: std::fs::canonicalize(&root).unwrap(),
                    grants: vec![Permission::HostProcess, Permission::CdpRaw],
                },
            )
            .unwrap();
        registry.set_enabled(PLUGIN, false).unwrap();
        registry.save().unwrap();
        let mut renderer =
            RendererRuntime::from_catalog(PluginCatalog::load(&registry).unwrap(), registry)
                .unwrap();
        assert_eq!(
            renderer.plugin_count(),
            0,
            "all optional bundled code is disabled"
        );
        let (peer, events) = VmPeer::start();
        let hosts = HostRuntime::start_with_runtime(
            vec![],
            peer.client.clone(),
            Some(peer.runtime.clone()),
        )
        .unwrap();
        renderer.set_host_capability_client(hosts.capability_client());
        renderer.set_external_observations(hosts.observations());
        let (controller, initial_sessions) =
            TargetController::discover(peer.client.clone(), events, Duration::from_secs(3))
                .unwrap();
        assert_eq!(initial_sessions.len(), 2);
        let broker = ControlBroker::new([31; 16], "v".repeat(64));
        broker.set_ready();
        Self {
            renderer,
            hosts,
            control: HostControl::new(registry_path.clone()),
            broker,
            controller,
            initial_sessions,
            peer,
            root,
            registry_path,
            _directory: directory,
            closed: false,
        }
    }

    fn tick(&mut self) {
        self.renderer
            .set_external_observations(self.hosts.observations());
        for change in self.controller.pump(Duration::ZERO).unwrap() {
            self.renderer.apply_target_change(change).unwrap();
        }
        self.renderer.pump_bindings().unwrap();
        self.control
            .poll(&mut self.renderer, &self.hosts, &self.broker);
        if self.control.needs_renderer_executor() {
            let result = self
                .initial_sessions
                .iter()
                .filter(|session| session.is_live())
                .try_for_each(|session| {
                    self.renderer
                        .attach(session)
                        .map(|_| ())
                        .map_err(|error| error.to_string())
                });
            self.control.renderer_executor_result(result);
        }
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

    fn command(&mut self, action: PluginControlAction) -> PluginControlReport {
        let prepared = self
            .broker
            .handle(ControlRequest::prepare(PluginControlRequest {
                action,
                plugin_id: PLUGIN.into(),
                permission: None,
                cascade: false,
            }));
        let id = prepared.operation_id().unwrap().to_owned();
        assert_eq!(
            self.broker.handle(ControlRequest::submit(&id)).status,
            ControlStatus::Queued
        );
        let deadline = Instant::now() + WAIT;
        loop {
            self.tick();
            let report = self.broker.handle(ControlRequest::result(&id));
            if report.status == ControlStatus::Completed {
                return match report.operation.unwrap().completion.unwrap() {
                    ControlCompletion::Report { report } => report,
                    other => panic!("combined VM command rejected: {other:?}"),
                };
            }
            assert!(
                Instant::now() < deadline,
                "combined VM command did not settle: {report:?}; {:?}",
                self.hosts.take_diagnostics()
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn inspect(&self, additional_keys: &[String]) -> Value {
        let mut keys = vec![
            RESULT.to_string(),
            "__vmPartial".into(),
            "__vmCleanupCount".into(),
            "__vmHostPartial".into(),
        ];
        keys.extend(additional_keys.iter().cloned());
        self.peer.request("Fixture.inspect", json!({"keys":keys}))
    }

    fn values(&self) -> Vec<Value> {
        self.inspect(&[])["contexts"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|context| context["globals"].get(RESULT).cloned())
            .collect()
    }

    fn active_generation(&self) -> u64 {
        self.hosts
            .observations()
            .into_iter()
            .find(|observation| {
                observation.plugin.manifest.id == PLUGIN
                    && observation.state == ExecutionState::Active
            })
            .expect("combined Host is active")
            .plugin
            .generation
    }

    fn assert_active(&self, generation: u64) {
        let values = self.values();
        assert_eq!(values.len(), 2, "{values:?}");
        let targets: BTreeSet<_> = values
            .iter()
            .map(|value| value["targetId"].as_str().unwrap())
            .collect();
        assert_eq!(targets, BTreeSet::from(["window-a", "window-b"]));
        for value in values {
            assert_eq!(value["ready"], true);
            assert_eq!(value["pluginId"], PLUGIN);
            assert_eq!(value["generation"], generation);
            assert_eq!(value["caller"]["generation"], generation);
            assert_eq!(value["caller"]["pluginId"], PLUGIN);
            assert_eq!(value["caller"]["targetId"], value["targetId"]);
        }
        assert_eq!(self.active_generation(), generation);
        assert!(
            generation <= 12,
            "this bounded acceptance allocates at most twelve generations"
        );
        let markers = (1..=generation)
            .map(|generation| format!("__codletCombinedHost_{generation}"))
            .collect::<Vec<_>>();
        let snapshot = self.inspect(&markers);
        assert_eq!(
            snapshot["sessions"].as_array().unwrap().len(),
            4,
            "two renderer sessions and two Host-owned raw sessions"
        );
        for context in snapshot["contexts"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|context| context["name"] == "")
        {
            assert_eq!(
                context["globals"][format!("__codletCombinedHost_{generation}")],
                true
            );
        }
        for context in snapshot["contexts"].as_array().unwrap() {
            for retired in 1..generation {
                assert!(
                    context["globals"]
                        .get(format!("__codletCombinedHost_{retired}"))
                        .is_none(),
                    "retired candidate resource leaked: {context}"
                );
            }
        }
    }

    fn assert_disabled(&self, generations: &[u64]) {
        assert!(self.values().is_empty());
        let last = *generations.iter().max().unwrap();
        assert!(last <= 12);
        let markers = (1..=last)
            .map(|generation| format!("__codletCombinedHost_{generation}"))
            .collect::<Vec<_>>();
        let snapshot = self.inspect(&markers);
        for context in snapshot["contexts"].as_array().unwrap() {
            assert!(context["plugins"].as_array().unwrap().is_empty());
            assert!(
                context["globals"]
                    .as_object()
                    .unwrap()
                    .keys()
                    .all(|key| key == "__vmCleanupCount"),
                "{context}"
            );
            assert_eq!(context["bindings"], json!([]));
            assert_eq!(context["timers"], 0);
        }
        assert_eq!(snapshot["sessions"].as_array().unwrap().len(), 2);
        assert!(
            snapshot["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .all(|session| session["scripts"] == 0 && session["bindings"] == 0)
        );
        assert_eq!(snapshot["evaluations"], 0);
        assert!(
            !PluginRegistry::load(&self.registry_path)
                .unwrap()
                .is_enabled(PLUGIN)
        );
        assert!(
            self.hosts
                .execution_snapshot()
                .plugins
                .iter()
                .filter(|plugin| plugin.id == PLUGIN)
                .all(|plugin| {
                    plugin.state == ExecutionState::Exited
                        && plugin.exit.as_ref().is_some_and(|exit| {
                            exit.workers_reaped && !exit.forced && exit.exit_code == 0
                        })
                })
        );
    }

    fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        for session in &self.initial_sessions {
            let _ = self.renderer.deactivate_target(session.target_id());
        }
        let stopped = self.hosts.stop();
        if !thread::panicking() {
            assert!(
                stopped
                    .unwrap()
                    .iter()
                    .all(|report| report.result.as_ref().is_ok_and(|exit| exit.workers_reaped))
            );
        }
        self.peer.close();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.close();
    }
}

fn generation(report: &PluginControlReport) -> u64 {
    report
        .generations
        .iter()
        .find(|generation| generation.plugin_id == PLUGIN)
        .unwrap()
        .generation
}

#[test]
fn actual_javascript_combined_example_awaits_host_in_both_windows_reloads_and_disables() {
    let mut fixture = Fixture::new();
    let enabled = fixture.command(PluginControlAction::Enable);
    assert_eq!(
        enabled.outcome,
        PluginControlOutcome::Applied,
        "{enabled:?}"
    );
    let first = generation(&enabled);
    fixture.assert_active(first);
    for value in fixture.values() {
        assert_eq!(value["caller"]["documentEpoch"], 1);
    }
    let old_pid = fixture.hosts.observations()[0].process_id.unwrap();
    std::fs::write(
        fixture.root.join("host.js"),
        EXAMPLE_HOST.replace("ready: true,", "ready: true, revision: 'host-v2',"),
    )
    .unwrap();
    std::fs::write(
        fixture.root.join("renderer.js"),
        EXAMPLE_RENDERER.replace(
            "globalThis.__codletCombinedExample = result;",
            "globalThis.__codletCombinedExample = {...result, rendererRevision:'renderer-v2'};",
        ),
    )
    .unwrap();
    let reloaded = fixture.command(PluginControlAction::Reload);
    assert_eq!(
        reloaded.outcome,
        PluginControlOutcome::Applied,
        "{reloaded:?}"
    );
    let second = generation(&reloaded);
    assert!(second > first);
    fixture.assert_active(second);
    assert_ne!(fixture.hosts.observations()[0].process_id.unwrap(), old_pid);
    for value in fixture.values() {
        assert_eq!(value["revision"], "host-v2");
        assert_eq!(value["rendererRevision"], "renderer-v2");
    }
    let snapshot = fixture.inspect(&[format!("__codletCombinedHost_{first}")]);
    assert!(
        snapshot["contexts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|context| context["globals"]
                .get(format!("__codletCombinedHost_{first}"))
                .is_none())
    );
    let disabled = fixture.command(PluginControlAction::Disable);
    assert_eq!(
        disabled.outcome,
        PluginControlOutcome::Applied,
        "{disabled:?}"
    );
    fixture.assert_disabled(&[first, second]);
    assert!(
        fixture.inspect(&[])["methods"]["Runtime.evaluate"]
            .as_u64()
            .unwrap()
            > 20
    );
    fixture.close();
}

#[test]
fn actual_javascript_document_replacement_retires_old_world_and_preserves_other_window_identity() {
    let mut fixture = Fixture::new();
    let enabled = fixture.command(PluginControlAction::Enable);
    assert_eq!(
        enabled.outcome,
        PluginControlOutcome::Applied,
        "{enabled:?}"
    );
    let generation = generation(&enabled);
    let before = fixture.inspect(&[]);
    let old_worlds = before["contexts"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|context| context["targetId"] == "window-a")
        .map(|context| context["id"].as_u64().unwrap())
        .collect::<BTreeSet<_>>();
    fixture
        .peer
        .request("Fixture.navigate", json!({"targetId":"window-a"}));
    let deadline = Instant::now() + WAIT;
    loop {
        fixture.tick();
        let values = fixture.values();
        if values.len() == 2
            && values.iter().any(|value| {
                value["targetId"] == "window-a" && value["caller"]["documentEpoch"] == 2
            })
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "new document did not activate: {values:?}"
        );
        thread::sleep(Duration::from_millis(5));
    }
    for value in fixture.values() {
        assert_eq!(value["generation"], generation);
        assert_eq!(
            value["caller"]["documentEpoch"],
            if value["targetId"] == "window-a" {
                2
            } else {
                1
            }
        );
    }
    assert!(
        fixture.inspect(&[])["contexts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|context| !old_worlds.contains(&context["id"].as_u64().unwrap()))
    );
    assert_eq!(
        fixture.command(PluginControlAction::Disable).outcome,
        PluginControlOutcome::Applied
    );
    fixture.assert_disabled(&[generation]);
    fixture.close();
}

#[test]
fn actual_javascript_partial_failures_clean_resources_and_compensate_both_entries() {
    let mut fixture = Fixture::new();
    let enabled = fixture.command(PluginControlAction::Enable);
    assert_eq!(
        enabled.outcome,
        PluginControlOutcome::Applied,
        "{enabled:?}"
    );
    let first = generation(&enabled);
    // The failing renderer executes a real partial effect and a Host request
    // before throwing. Its actual deactivate function must remove that effect.
    let renderer_failure = EXAMPLE_RENDERER.replace(
        "const result = await context.rpc.request(capability, 'describe', null);",
        "globalThis.__vmPartial = true; const result = await context.rpc.request(capability, 'describe', null); if(result.targetId === 'window-b') throw new Error('VM candidate renderer failure');",
    ).replace("delete globalThis.__codletCombinedExample;", "delete globalThis.__codletCombinedExample; delete globalThis.__vmPartial; globalThis.__vmCleanupCount = (globalThis.__vmCleanupCount ?? 0) + 1;");
    std::fs::write(fixture.root.join("renderer.js"), renderer_failure).unwrap();
    let rolled_back = fixture.command(PluginControlAction::Reload);
    assert_eq!(
        rolled_back.outcome,
        PluginControlOutcome::RolledBack,
        "{rolled_back:?}"
    );
    assert!(
        rolled_back
            .target_failures
            .iter()
            .any(|failure| failure.error.contains("VM candidate renderer failure")),
        "{rolled_back:?}"
    );
    let second = generation(&rolled_back);
    assert!(second > first);
    fixture.assert_active(second);
    let snapshot = fixture.inspect(&[]);
    assert!(
        snapshot["contexts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|context| context["globals"].get("__vmPartial").is_none())
    );
    assert!(
        snapshot["contexts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|context| context["globals"]["__vmCleanupCount"]
                .as_u64()
                .is_some_and(|count| count > 0))
    );
    // Candidate native activation has already attached and modified an actual
    // VM global when it fails. Its separate managed cleanup must undo that
    // known fixture effect and detach before prior snapshots can be restarted.
    std::fs::write(fixture.root.join("renderer.js"), EXAMPLE_RENDERER).unwrap();
    std::fs::write(fixture.root.join("host.js"), r#"let sessionId; module.exports={
 async activate(context){
  ({sessionId}=await context.cdp.request('Target.attachToTarget',{targetId:'window-a',flatten:true}));
  await context.cdp.request('Runtime.evaluate',{expression:'globalThis.__vmHostPartial=true',returnByValue:true},{sessionId});
  throw new Error('VM candidate Host failure');
 }, async deactivate(cleanup){if(sessionId){
  await cleanup.cdp.request('Runtime.evaluate',{expression:'delete globalThis.__vmHostPartial',returnByValue:true},{sessionId});
  await cleanup.cdp.request('Target.detachFromTarget',{sessionId});
 }} };
"#).unwrap();
    let host_rollback = fixture.command(PluginControlAction::Reload);
    assert_eq!(
        host_rollback.outcome,
        PluginControlOutcome::RolledBack,
        "{host_rollback:?}"
    );
    assert!(
        host_rollback
            .target_failures
            .iter()
            .any(|failure| failure.error.contains("VM candidate Host failure")),
        "{host_rollback:?}"
    );
    let third = generation(&host_rollback);
    assert!(third > second);
    fixture.assert_active(third);
    assert!(
        fixture.inspect(&[])["contexts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|context| context["globals"].get("__vmHostPartial").is_none())
    );
    assert_eq!(
        fixture.command(PluginControlAction::Disable).outcome,
        PluginControlOutcome::Applied
    );
    fixture.assert_disabled(&[first, second, third]);
    fixture.close();
}

#[test]
fn vm_peer_target_retirement_cancels_pending_evaluation_and_keeps_other_target_live() {
    let (mut peer, events) = VmPeer::start();
    let (mut controller, sessions) =
        TargetController::discover(peer.client.clone(), events, Duration::from_secs(3)).unwrap();
    let first = sessions
        .iter()
        .find(|session| session.target_id() == "window-a")
        .unwrap();
    let second = sessions
        .iter()
        .find(|session| session.target_id() == "window-b")
        .unwrap();
    let pending = first
        .start_evaluate_in_context("new Promise(() => {})", None)
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while peer.request("Fixture.inspect", json!({}))["evaluations"] != 1 {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(5));
    }
    peer.request("Fixture.destroyTarget", json!({"targetId":"window-a"}));
    assert!(
        pending
            .wait()
            .unwrap_err()
            .to_string()
            .contains("execution context destroyed")
    );
    while controller.session_count() != 1 {
        controller.pump(Duration::ZERO).unwrap();
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(5));
    }
    let value = second
        .evaluate("globalThis.__vmPeerSurvivor = 6 * 7; ({executed:globalThis.__vmPeerSurvivor})")
        .unwrap();
    assert_eq!(value["result"]["value"]["executed"], 42);
    let snapshot = peer.request("Fixture.inspect", json!({"keys":["__vmPeerSurvivor"]}));
    assert_eq!(snapshot["evaluations"], 0);
    assert_eq!(snapshot["sessions"].as_array().unwrap().len(), 1);
    assert!(
        snapshot["contexts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|context| context["targetId"] == "window-b")
    );
    peer.close();
}
