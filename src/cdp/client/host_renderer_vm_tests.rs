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

pub(crate) struct VmPeer {
    pub(crate) client: CdpClient,
    child: ChildGuard,
    pub(crate) runtime: JsRuntime,
    log: PathBuf,
    _directory: TempDir,
    closed: bool,
}

impl VmPeer {
    pub(crate) fn start() -> (Self, CdpEventStream) {
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

    pub(crate) fn request(&self, method: &str, params: Value) -> Value {
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

    pub(crate) fn close(&mut self) {
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

#[test]
fn async_renderer_cleanup_finishes_its_host_rpc_during_reload_and_before_combined_host_stop() {
    let mut fixture = Fixture::new();
    let source = EXAMPLE_RENDERER.replace(
        "globalThis.__codletCombinedExample = result;",
        "globalThis.__codletCombinedExample = result; context.onCleanup(async ({signal}) => { const restored = await context.rpc.request(capability, 'describe', null); if(signal.aborted || !restored.ready) throw new Error('restoration unconfirmed'); globalThis.__vmCleanupCount = 1; });",
    ).replace("delete globalThis.__codletCombinedExample;", "if(globalThis.__vmCleanupCount !== 1) throw new Error('route closed before restoration'); delete globalThis.__codletCombinedExample;");
    std::fs::write(fixture.root.join("renderer.js"), source).unwrap();
    assert_eq!(
        fixture.command(PluginControlAction::Enable).outcome,
        PluginControlOutcome::Applied
    );
    assert_eq!(
        fixture.command(PluginControlAction::Reload).outcome,
        PluginControlOutcome::Applied
    );
    assert_eq!(
        fixture.inspect(&[])["contexts"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|context| context["globals"]["__vmCleanupCount"] == 1)
            .count(),
        2
    );
    assert_eq!(
        fixture.command(PluginControlAction::Disable).outcome,
        PluginControlOutcome::Applied
    );
    let snapshot = fixture.inspect(&[]);
    assert_eq!(
        snapshot["contexts"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|context| context["globals"]["__vmCleanupCount"] == 1)
            .count(),
        4
    );
    fixture.close();
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
                remove_source: None,
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

fn stateful_sources() -> (String, String) {
    let host = EXAMPLE_HOST
        .replace("const owned = new Map();", "const owned = new Map(); let count = 7;")
        .replace("activate(context) {", "saveState() { return {schema:1,value:{count}}; }, restoreState(snapshot) { count = snapshot.value.count; }, activate(context) {")
        .replace("const targetId = invocation.caller.targetId;", "if(Number.isInteger(_params?.count)) count = _params.count; const targetId = invocation.caller.targetId;")
        .replace("ready: true,", "ready: true, count,");
    let renderer = EXAMPLE_RENDERER
        .replace("async activate(context) {", "saveState() { return {schema:1,value:{localCount:globalThis.__codletCombinedExample.localCount}}; }, restoreState(snapshot) { globalThis.__codletCombinedExample.localCount = snapshot.value.localCount; }, async activate(context) {")
        .replace("globalThis.__codletCombinedExample = result;", "globalThis.__codletCombinedExample = {...result,localCount:11}; globalThis.__codletCombinedExample.setHostCount = async (count,delay=false) => { const result = await context.rpc.request(capability,'describe',{count,delay}); globalThis.__codletCombinedExample.count = result.count; };");
    (host, renderer)
}

impl Fixture {
    fn change_state(&mut self, host_count: u64, renderer_count: u64) {
        let contexts = self.inspect(&[])["contexts"].as_array().unwrap().clone();
        for context in contexts
            .iter()
            .filter(|context| context["globals"].get(RESULT).is_some())
        {
            let session = self
                .initial_sessions
                .iter()
                .find(|session| session.target_id() == context["targetId"].as_str().unwrap())
                .unwrap();
            let expression = format!(
                "globalThis.{RESULT}.localCount={renderer_count}; globalThis.{RESULT}.setHostCount({host_count})"
            );
            let mut request = session
                .start_evaluate_in_context(&expression, context["id"].as_u64())
                .unwrap();
            let deadline = Instant::now() + WAIT;
            loop {
                self.tick();
                if let Some(response) = request.try_response().unwrap() {
                    assert!(response.error.is_none(), "{response:?}");
                    assert!(
                        response
                            .result
                            .as_ref()
                            .unwrap()
                            .get("exceptionDetails")
                            .is_none(),
                        "{response:?}"
                    );
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "state write did not reach its original renderer"
                );
                thread::sleep(Duration::from_millis(5));
            }
        }
    }
    fn assert_state(&self, host_count: u64, renderer_count: u64) {
        let values = self.values();
        assert_eq!(values.len(), 2);
        for value in values {
            assert_eq!(value["count"], host_count, "{value}");
            assert_eq!(value["localCount"], renderer_count, "{value}");
        }
    }
}

#[test]
fn standalone_renderer_snapshot_error_reports_failed_resume_and_retains_old_state() {
    let mut fixture = Fixture::new();
    let (host, renderer) = stateful_sources();
    let renderer = renderer.replace(
        "return {schema:1,value:{localCount:globalThis.__codletCombinedExample.localCount}};",
        "throw new Error('Renderer state refused');",
    );
    std::fs::write(fixture.root.join("host.js"), host).unwrap();
    std::fs::write(fixture.root.join("renderer.js"), renderer).unwrap();
    assert_eq!(
        fixture.command(PluginControlAction::Enable).outcome,
        PluginControlOutcome::Applied
    );
    fixture.change_state(37, 41);
    let previous = fixture.active_generation();
    fixture.peer.request("Fixture.failNextResume", json!({}));
    let affected = BTreeSet::from([PLUGIN.to_owned()]);
    let error = fixture
        .renderer
        .capture_package_state(&affected)
        .unwrap_err();
    assert_eq!(error.code, "plugin_snapshot_failed");
    assert!(error.message.contains("Renderer state refused"), "{error}");
    assert!(
        error.message.contains("admission resume unconfirmed"),
        "{error}"
    );
    assert!(
        error.message.contains("example.combined in window-")
            && error.message.contains("CDP method Runtime.evaluate")
            && error.message.contains("fixture resume refused"),
        "{error}"
    );
    assert_eq!(fixture.active_generation(), previous);
    fixture.assert_state(37, 41);
    assert!(fixture.renderer.resume_package_state(&affected).is_empty());
    fixture.change_state(38, 42);
    fixture.assert_state(38, 42);
    assert_eq!(
        fixture.command(PluginControlAction::Disable).outcome,
        PluginControlOutcome::Applied
    );
    fixture.close();
}

#[test]
fn combined_snapshot_drains_accepted_host_write_into_old_renderer_before_saving() {
    let mut fixture = Fixture::new();
    let (host, renderer) = stateful_sources();
    let host = host.replace("return {\n", "if(_params?.delay) await context.cdp.request('Runtime.evaluate',{expression:'new Promise(resolve=>setTimeout(()=>resolve({accepted:true}),200))',awaitPromise:true,returnByValue:true},{sessionId:resource.sessionId}); return {\n");
    std::fs::write(fixture.root.join("host.js"), host).unwrap();
    std::fs::write(fixture.root.join("renderer.js"), renderer).unwrap();
    assert_eq!(
        fixture.command(PluginControlAction::Enable).outcome,
        PluginControlOutcome::Applied
    );
    fixture.change_state(37, 41);
    let context = fixture.inspect(&[])["contexts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|context| {
            context["targetId"] == "window-a" && context["globals"].get(RESULT).is_some()
        })
        .unwrap()
        .clone();
    let session = fixture
        .initial_sessions
        .iter()
        .find(|session| session.target_id() == "window-a")
        .unwrap();
    let mut accepted = session
        .start_evaluate_in_context(
            &format!("globalThis.{RESULT}.setHostCount(43,true)"),
            context["id"].as_u64(),
        )
        .unwrap();
    let deadline = Instant::now() + WAIT;
    while fixture.inspect(&[])["evaluations"].as_u64().unwrap() < 2 {
        fixture.tick();
        assert!(
            Instant::now() < deadline,
            "the bounded Host child never entered CDP"
        );
        thread::sleep(Duration::from_millis(5));
    }
    let report = fixture.command(PluginControlAction::Reload);
    assert_eq!(report.outcome, PluginControlOutcome::Applied, "{report:?}");
    let response = accepted
        .try_response()
        .unwrap()
        .expect("accepted old write completed before its renderer retired");
    assert!(
        response.error.is_none()
            && response
                .result
                .as_ref()
                .unwrap()
                .get("exceptionDetails")
                .is_none(),
        "{response:?}"
    );
    fixture.assert_state(43, 41);
    assert_eq!(
        fixture.command(PluginControlAction::Disable).outcome,
        PluginControlOutcome::Applied
    );
    fixture.close();
}

#[test]
fn combined_reload_preserves_explicit_host_and_per_window_renderer_state() {
    let mut fixture = Fixture::new();
    let (host, renderer) = stateful_sources();
    std::fs::write(fixture.root.join("host.js"), host).unwrap();
    std::fs::write(fixture.root.join("renderer.js"), renderer).unwrap();
    assert_eq!(
        fixture.command(PluginControlAction::Enable).outcome,
        PluginControlOutcome::Applied
    );
    fixture.change_state(37, 41);
    fixture.assert_state(37, 41);
    let previous = fixture.active_generation();
    let report = fixture.command(PluginControlAction::Reload);
    assert_eq!(report.outcome, PluginControlOutcome::Applied, "{report:?}");
    assert!(fixture.active_generation() > previous);
    fixture.assert_active(generation(&report));
    fixture.assert_state(37, 41);
    assert_eq!(
        fixture.command(PluginControlAction::Disable).outcome,
        PluginControlOutcome::Applied
    );
    fixture.close();
}

#[test]
fn combined_snapshot_failure_resumes_same_old_owner_and_keeps_state_writable() {
    for host_failure in [false, true] {
        let mut fixture = Fixture::new();
        let (mut host, mut renderer) = stateful_sources();
        if host_failure {
            host = host.replace(
                "return {schema:1,value:{count}};",
                "throw new Error('Host state refused');",
            );
        } else {
            renderer = renderer.replace("return {schema:1,value:{localCount:globalThis.__codletCombinedExample.localCount}};", "throw new Error('Renderer state refused');");
        }
        std::fs::write(fixture.root.join("host.js"), host).unwrap();
        std::fs::write(fixture.root.join("renderer.js"), renderer).unwrap();
        assert_eq!(
            fixture.command(PluginControlAction::Enable).outcome,
            PluginControlOutcome::Applied
        );
        fixture.change_state(37, 41);
        let previous = fixture.active_generation();
        let pid = fixture.hosts.observations()[0].process_id;
        let report = fixture.command(PluginControlAction::Reload);
        assert_eq!(
            report.outcome,
            PluginControlOutcome::RolledBack,
            "{report:?}"
        );
        assert!(!report.target_failures.is_empty(), "{report:?}");
        assert_eq!(fixture.active_generation(), previous);
        assert_eq!(fixture.hosts.observations()[0].process_id, pid);
        fixture.assert_state(37, 41);
        fixture.change_state(38, 42);
        fixture.assert_state(38, 42);
        assert_eq!(
            fixture.command(PluginControlAction::Disable).outcome,
            PluginControlOutcome::Applied
        );
        fixture.close();
    }
}

#[test]
fn combined_candidate_restore_failure_rolls_back_original_host_and_renderer_state() {
    for host_failure in [false, true] {
        let mut fixture = Fixture::new();
        let (host, renderer) = stateful_sources();
        std::fs::write(fixture.root.join("host.js"), &host).unwrap();
        std::fs::write(fixture.root.join("renderer.js"), &renderer).unwrap();
        assert_eq!(
            fixture.command(PluginControlAction::Enable).outcome,
            PluginControlOutcome::Applied
        );
        fixture.change_state(37, 41);
        let previous = fixture.active_generation();
        if host_failure {
            std::fs::write(
                fixture.root.join("host.js"),
                host.replace(
                    "count = snapshot.value.count;",
                    "throw new Error('candidate Host restore refused');",
                ),
            )
            .unwrap();
        } else {
            std::fs::write(
                fixture.root.join("renderer.js"),
                renderer.replace(
                    "globalThis.__codletCombinedExample.localCount = snapshot.value.localCount;",
                    "throw new Error('candidate renderer restore refused');",
                ),
            )
            .unwrap();
        }
        let report = fixture.command(PluginControlAction::Reload);
        assert_eq!(
            report.outcome,
            PluginControlOutcome::RolledBack,
            "{report:?}"
        );
        assert!(
            report
                .target_failures
                .iter()
                .any(|failure| failure.error.contains("restore refused")),
            "{report:?}"
        );
        assert!(fixture.active_generation() > previous);
        fixture.assert_active(generation(&report));
        fixture.assert_state(37, 41);
        fixture.change_state(38, 42);
        fixture.assert_state(38, 42);
        assert_eq!(
            fixture.command(PluginControlAction::Disable).outcome,
            PluginControlOutcome::Applied
        );
        fixture.close();
    }
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
            "new document did not activate: {values:?}; renderer={:?}; host={:?}",
            fixture.renderer.status_snapshot(),
            fixture.hosts.take_diagnostics()
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

// Exercise Core's real CDP admission coordinator with a deliberately small main
// world provider. The gate stub models only the private lifecycle contract; the
// production forwarding queue/Native canonical guards have separate JS tests.
fn ingress_vm() -> (RendererRuntime, VmPeer, TargetController, TempDir) {
    let directory = tempdir().unwrap();
    let registry = PluginRegistry::load(directory.path().join("config.json")).unwrap();
    let plugin = crate::plugins::LoadedPlugin {
        authorization: None,
        manifest: crate::plugins::PluginManifest::parse(&json!({"schema":1,"id":crate::codex::DESKTOP_PROVIDER_ID,"version":"1","renderer":{"entry":"gate.js","world":"main"},"permissions":["ui.mainWorld"]}).to_string()).unwrap(),
        source: Some(r#"
          module.exports = {
            activate(){
              let held=null;
              const epoch='fixture-document';
              globalThis[Symbol.for('codlet.core.native-ingress.v1')]=Object.freeze({
                api:1,documentEpoch:epoch,
                pause(id){held=id;return {ok:true,held:true,documentEpoch:epoch};},
                resume(id){if(held!==id)return {ok:false,message:'stale operation'};held=null;globalThis.__vmIngressResumed=(globalThis.__vmIngressResumed??0)+1;return {ok:true,resumed:true,documentEpoch:epoch};}
              });
            },
            deactivate(){delete globalThis[Symbol.for('codlet.core.native-ingress.v1')];}
          };
        "#.into()),
        host: None,
        generation: 1,
    };
    let mut renderer = RendererRuntime::new(vec![plugin], registry).unwrap();
    let (peer, events) = VmPeer::start();
    let (controller, sessions) =
        TargetController::discover(peer.client.clone(), events, Duration::from_secs(3)).unwrap();
    for session in sessions {
        renderer.attach(&session).unwrap();
    }
    (renderer, peer, controller, directory)
}

#[test]
fn core_ingress_cdp_target_addition_rejects_forward_work_and_resumes_only_the_original_owned_set() {
    let (mut renderer, mut peer, mut controller, _directory) = ingress_vm();
    let (held, failures) = renderer.pause_core_ingress("fixture-update");
    assert!(failures.is_empty(), "{failures:?}");
    assert_eq!(held.len(), 2);
    assert!(renderer.validate_core_ingress_targets(&held).is_ok());
    peer.request("Fixture.addTarget", json!({"targetId":"window-c"}));
    let deadline = Instant::now() + WAIT;
    while renderer.session_count() != 3 {
        for change in controller.pump(Duration::ZERO).unwrap() {
            renderer.apply_target_change(change).unwrap();
        }
        assert!(Instant::now() < deadline, "new CDP target did not attach");
        thread::sleep(Duration::from_millis(5));
    }
    assert!(
        renderer
            .validate_core_ingress_targets(&held)
            .unwrap_err()
            .contains("document set changed")
    );
    peer.request("Fixture.destroyTarget", json!({"targetId":"window-c"}));
    while renderer.session_count() != 2 {
        for change in controller.pump(Duration::ZERO).unwrap() {
            renderer.apply_target_change(change).unwrap();
        }
        renderer.pump_bindings().unwrap();
        assert!(Instant::now() < deadline, "new CDP target did not retire");
        thread::sleep(Duration::from_millis(5));
    }
    assert!(renderer.validate_core_ingress_targets(&held).is_ok());
    assert!(
        renderer
            .resume_core_ingress("fixture-update", &held, false)
            .is_empty()
    );
    let inspected = peer.request("Fixture.inspect", json!({"keys":["__vmIngressResumed"]}));
    assert_eq!(
        inspected["contexts"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|context| context["globals"]["__vmIngressResumed"] == 1)
            .count(),
        2
    );
    peer.close();
}

#[test]
fn core_ingress_cdp_document_recovery_rejects_old_epoch_and_never_resumes_the_new_document_by_old_receipt()
 {
    let (mut renderer, mut peer, mut controller, _directory) = ingress_vm();
    let (held, failures) = renderer.pause_core_ingress("original-operation");
    assert!(failures.is_empty(), "{failures:?}");
    peer.request("Fixture.navigate", json!({"targetId":"window-a"}));
    // The existing helper sends real frame/context retirement events. Pump the
    // production recovery path until its document identity changes.
    let deadline = Instant::now() + WAIT;
    loop {
        for change in controller.pump(Duration::ZERO).unwrap() {
            renderer.apply_target_change(change).unwrap();
        }
        renderer.pump_bindings().unwrap();
        if renderer.validate_core_ingress_targets(&held).is_err() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "document recovery never changed its epoch"
        );
        thread::sleep(Duration::from_millis(5));
    }
    let failures = renderer.resume_core_ingress("original-operation", &held, false);
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert_eq!(failures[0].target_id, "window-a");
    assert!(
        failures[0]
            .error
            .contains("Original Native document retired"),
        "{failures:?}"
    );
    let inspected = peer.request("Fixture.inspect", json!({"keys":["__vmIngressResumed"]}));
    assert!(
        inspected["contexts"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|context| context["targetId"] == "window-a")
            .all(|context| context["globals"].get("__vmIngressResumed").is_none())
    );
    assert_eq!(
        inspected["contexts"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|context| context["targetId"] == "window-b"
                && context["globals"]["__vmIngressResumed"] == 1)
            .count(),
        1
    );
    peer.close();
}
