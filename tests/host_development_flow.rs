#![cfg(windows)]

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use codlet::catalog::PluginCatalog;
use codlet::cdp::CdpClient;
use codlet::diagnostics::{
    Check, DoctorInputs, DoctorReport, DoctorRuntimeInput, PackageInfo, ProcessSnapshot,
};
use codlet::host_control::HostControl;
use codlet::host_runtime::HostRuntime;
use codlet::js_runtime::JsRuntime;
use codlet::plugin_control::{
    PluginControlAction, PluginControlOutcome, PluginControlReport, PluginControlRequest,
};
use codlet::plugin_execution::{ExecutionState, HostCleanupPhase, HostPluginSnapshot};
use codlet::plugin_watch::PluginWatcher;
use codlet::plugins::{LocalPluginRegistration, Permission, PluginRegistry};
use codlet::renderer::RendererRuntime;
use codlet::runtime_control::{
    ControlBroker, ControlCompletion, ControlReport, ControlRequest, ControlStatus,
};
use codlet::runtime_status::{HostState, StatusPublisher};
use codlet::windows::process::{ChildProcess, launch_with_cdp_pipes};
use serde_json::{Value, json};
use tempfile::{TempDir, tempdir};

const ID: &str = "example.cleanup-host";
const WAIT: Duration = Duration::from_secs(12);
const ORIGINAL_VALUE: &str = "Codlet cleanup example";
const REVISED_VALUE: &str = "Codlet development revision 2";

struct DevelopmentSession {
    hosts: HostRuntime,
    control: HostControl,
    broker: ControlBroker,
    publisher: StatusPublisher,
    renderer: RendererRuntime,
    watcher: PluginWatcher,
    client: CdpClient,
    child: ChildProcess,
    directory: TempDir,
    registry_path: PathBuf,
    now: Instant,
    watch_tickets: Vec<String>,
}

impl DevelopmentSession {
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
        let js =
            JsRuntime::from_distribution(Path::new(env!("CARGO_BIN_EXE_codlet")).parent().unwrap())
                .unwrap();
        let hosts = HostRuntime::start_with_runtime(Vec::new(), client.clone(), Some(js)).unwrap();
        let publisher = StatusPublisher::new();
        let scope = "d".repeat(64);
        publisher.bind_runtime_identity([13; 16], &scope).unwrap();
        publisher.publish_host_observation(hosts.execution_snapshot());
        publisher.set_ready();
        let broker = ControlBroker::with_inspection([13; 16], scope, publisher.clone());
        broker.set_ready();
        Self {
            hosts,
            control: HostControl::new(registry_path.clone()),
            broker,
            publisher,
            renderer,
            watcher: PluginWatcher::new(registry_path.clone()),
            client,
            child,
            directory,
            registry_path,
            now: Instant::now(),
            watch_tickets: Vec::new(),
        }
    }

    fn copy_and_register_example(&self) -> (PathBuf, String) {
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/cleanup-host");
        let root = self.directory.path().join("cleanup-host");
        for relative in ["codlet.json", "dist/host.js", "README.md"] {
            let target = root.join(relative);
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            std::fs::copy(source.join(relative), target).unwrap();
        }
        std::fs::write(
            root.join("settings.json"),
            json!({"targetId":"arbitrary-worker","report":"flow"}).to_string(),
        )
        .unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(root.join("codlet.json")).unwrap()).unwrap();
        assert_eq!(manifest["id"], ID);
        let original = std::fs::read_to_string(root.join("dist/host.js")).unwrap();
        let mut registry = self.registry();
        registry
            .register_local(
                ID,
                LocalPluginRegistration {
                    broker_policy: Default::default(),
                    path: root.clone(),
                    grants: vec![Permission::HostProcess, Permission::CdpRaw],
                },
            )
            .unwrap();
        registry.set_enabled(ID, false).unwrap();
        registry.save().unwrap();
        (root, original)
    }

    fn registry(&self) -> PluginRegistry {
        PluginRegistry::load(&self.registry_path).unwrap()
    }

    fn tick(&mut self, scan: bool) {
        if scan {
            self.now += Duration::from_millis(250);
        }
        let observations = self.hosts.observations();
        self.renderer
            .set_external_observations(observations.clone());
        self.renderer.pump_bindings().unwrap();
        self.publisher
            .publish_host_observation(self.hosts.execution_snapshot());
        self.control
            .poll(&mut self.renderer, &self.hosts, &self.broker);
        if !self.control.is_pending() {
            if let Some(job) = self.broker.take_next() {
                assert!(
                    self.control
                        .dispatch(job, &mut self.renderer, &self.hosts, &self.broker)
                        .is_none(),
                    "the core-only development fixture must not route to a renderer"
                );
            } else if scan && !self.control.has_watch_receipt() {
                let sources = self.control.local_watch_sources(&observations);
                if let Some(selection) = self.watcher.poll_guarded(self.now, &sources) {
                    assert!(selection.is_host());
                    self.watch_tickets.push(
                        self.control
                            .submit_watched(selection, &self.broker)
                            .unwrap(),
                    );
                }
            }
        }
        for completed in self.control.take_watch_results() {
            if let Some(selection) = &completed.not_attempted {
                self.watcher.not_attempted(selection);
            }
            assert!(
                completed.result.is_ok(),
                "unexpected preflight rejection in the combined flow: {:?}",
                completed.result
            );
        }
        self.publisher
            .publish_host_observation(self.hosts.execution_snapshot());
    }

    fn submit(&self, action: PluginControlAction) -> String {
        let prepared = self
            .broker
            .handle(ControlRequest::prepare(PluginControlRequest {
                action,
                plugin_id: ID.into(),
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

    fn wait(&mut self, ticket: &str) -> PluginControlReport {
        let deadline = Instant::now() + WAIT;
        loop {
            self.tick(false);
            let response = self.broker.handle(ControlRequest::result(ticket));
            if response.status == ControlStatus::Completed {
                let ControlCompletion::Report { report } =
                    response.operation.unwrap().completion.unwrap()
                else {
                    panic!("development operation was rejected");
                };
                return report;
            }
            assert!(
                Instant::now() < deadline,
                "development operation timed out: {:?}",
                self.hosts.execution_snapshot()
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn settle_edit(&mut self) -> String {
        let before = self.watch_tickets.len();
        self.tick(true);
        assert_eq!(self.watch_tickets.len(), before);
        self.tick(true);
        assert_eq!(self.watch_tickets.len(), before + 1);
        self.watch_tickets.last().unwrap().clone()
    }

    fn inspect(&self) -> ControlReport {
        let report = self.broker.handle(ControlRequest::inspect_execution());
        assert_eq!(report.status, ControlStatus::Inspected);
        assert_eq!(report.host_pid, std::process::id());
        assert!(report.operation.is_none() && report.error.is_none());
        report
    }

    fn doctor(&self, inspected: &ControlReport) -> Value {
        let registry = self.registry();
        let catalog = PluginCatalog::load(&registry);
        let report = DoctorReport::from_inputs(DoctorInputs {
            // Only static discovery input is synthetic. Runtime process facts
            // below come from the live publisher and the actual Node executor.
            package: Check::ok(PackageInfo {
                family_name: "fixture".into(),
                full_name: "raw-host-cdp-fixture".into(),
                version: "fixture".into(),
                install_location: self.directory.path().display().to_string(),
            }),
            executable: Check::ok(env!("CARGO_BIN_EXE_codlet-fake-child").into()),
            processes: Check::ok(ProcessSnapshot::new(Vec::new())),
            registry_path: Some(self.registry_path.clone()),
            registry: Ok(registry),
            catalog,
        })
        .with_runtime(DoctorRuntimeInput::ExecutionInspected {
            inspection: Box::new(inspected.inspection.clone().unwrap()),
            hosts: Box::new(inspected.host_inspection.clone().unwrap()),
            queried_at_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis()
                .min(u128::from(u64::MAX)) as u64,
        });
        serde_json::from_str(&report.to_json()).unwrap()
    }

    fn trace(&self) -> Value {
        self.client
            .request("Fixture.trace", None, None, WAIT)
            .unwrap()
            .result
            .unwrap()
    }

    fn terminate(&mut self) {
        self.broker.stop();
        self.hosts.stop().unwrap();
        self.publisher
            .publish_host_observation(self.hosts.execution_snapshot());
        self.publisher.terminate("development-flow-complete");
    }
}

impl Drop for DevelopmentSession {
    fn drop(&mut self) {
        let _ = self.hosts.stop();
        let _ = self.client.shutdown();
        let _ = self.child.wait(WAIT);
    }
}

fn plugin(report: &ControlReport) -> HostPluginSnapshot {
    let sample = report.host_inspection.as_ref().unwrap();
    assert_eq!(sample.plugins.len(), 1);
    let plugin = sample.plugins[0].clone();
    assert_eq!(plugin.id, ID);
    plugin
}

fn example_report(root: &Path, stage: &str) -> Value {
    serde_json::from_slice(&std::fs::read(root.join(format!("flow.{stage}.json"))).unwrap())
        .unwrap()
}

/// The existing CDP peer owns real protocol/session state, but does not evaluate
/// page JavaScript. Verify the exact paired marker commands from the real
/// example and that every detach precedes the next attach, without inventing a
/// second implementation of the host lifecycle or claiming a GUI observation.
fn assert_resource_order(trace: &Value, generations: &[u64], live: bool) {
    let mut session: Option<String> = None;
    let mut marker: Option<String> = None;
    let mut awaiting_assignment = false;
    let mut assignments = 0;
    let mut attaches = 0;
    let mut detaches = 0;
    for request in trace["requests"].as_array().unwrap() {
        match request["method"].as_str().unwrap() {
            "Target.getTargets" => assert!(session.is_none() && marker.is_none()),
            "Target.attachToTarget" => {
                assert!(
                    session.is_none() && marker.is_none() && !awaiting_assignment,
                    "a replacement attached before previous cleanup: {trace}"
                );
                assert_eq!(request["params"]["targetId"], "arbitrary-worker");
                assert_eq!(request["params"]["flatten"], true);
                awaiting_assignment = true;
                attaches += 1;
            }
            "Runtime.evaluate" => {
                let selected = request["sessionId"].as_str().unwrap();
                let expression = request["params"]["expression"].as_str().unwrap();
                if expression.starts_with("delete ") {
                    assert_eq!(session.as_deref(), Some(selected));
                    assert_eq!(
                        expression,
                        format!(
                            "delete globalThis[{}]",
                            serde_json::to_string(
                                &marker
                                    .take()
                                    .expect("cleanup deletes its own established marker")
                            )
                            .unwrap()
                        )
                    );
                } else {
                    assert!(awaiting_assignment && session.is_none() && marker.is_none());
                    let generation = generations[assignments];
                    let owned = format!("__codlet_cleanup_{ID}_{generation}");
                    let value = if generation == 1 {
                        ORIGINAL_VALUE
                    } else {
                        REVISED_VALUE
                    };
                    assert_eq!(
                        expression,
                        format!(
                            "globalThis[{}] = '{value}'",
                            serde_json::to_string(&owned).unwrap()
                        )
                    );
                    marker = Some(owned);
                    session = Some(selected.into());
                    awaiting_assignment = false;
                    assignments += 1;
                }
            }
            "Target.detachFromTarget" => {
                assert!(
                    marker.is_none(),
                    "detach happened before the example deleted its marker: {trace}"
                );
                assert_eq!(
                    session.take().as_deref(),
                    request["params"]["sessionId"].as_str()
                );
                detaches += 1;
            }
            other => panic!("unexpected adapter/renderer or example operation: {other}"),
        }
    }
    assert_eq!(assignments, generations.len());
    assert_eq!(attaches, assignments);
    assert_eq!(detaches, assignments - usize::from(live));
    assert!(!awaiting_assignment);
    assert_eq!(session.is_some(), live);
    assert_eq!(marker.is_some(), live);
    assert_eq!(
        trace["liveSessions"],
        json!(session.into_iter().collect::<Vec<_>>())
    );
    assert_eq!(trace["deferred"], 0);
}

#[test]
fn actual_cleanup_example_completes_enable_watch_inspection_compensation_and_disable_as_one_flow() {
    let mut flow = DevelopmentSession::new();
    let (root, original) = flow.copy_and_register_example();
    assert_eq!(flow.renderer.plugin_count(), 0);
    assert!(
        !flow.registry().is_enabled("codlet-gui")
            && !flow.registry().is_enabled("codex.ui.adapter")
    );

    let enabled = flow.submit(PluginControlAction::Enable);
    let report = flow.wait(&enabled);
    assert_eq!(report.outcome, PluginControlOutcome::Applied);
    assert_eq!(report.generations[0].generation, 1);
    let first = flow.inspect();
    let first_plugin = plugin(&first);
    assert_eq!(first_plugin.state, ExecutionState::Active);
    assert!(first_plugin.process_id.is_some());
    assert_eq!(example_report(&root, "active")["generation"], 1);
    assert_resource_order(&flow.trace(), &[1], true);
    let doctor = flow.doctor(&first);
    assert_eq!(doctor["runtime"]["hostProcesses"]["assessment"], "active");
    assert_eq!(
        doctor["runtime"]["hostProcesses"]["sample"]["plugins"][0]["generation"],
        1
    );
    assert_eq!(doctor["result"]["exitCode"], 0);
    assert!(first.inspection.as_ref().unwrap().renderer.is_none());
    assert_eq!(
        first,
        flow.inspect(),
        "read-only inspection must not create a fresh publication or operation"
    );

    flow.tick(true); // Establish the loaded example as the watch baseline.
    assert_eq!(original.matches(ORIGINAL_VALUE).count(), 1);
    let revision = original.replace(ORIGINAL_VALUE, REVISED_VALUE);
    std::fs::write(root.join("dist/host.js"), &revision).unwrap();
    let watched = flow.settle_edit();
    let reloaded = flow.wait(&watched);
    assert_eq!(reloaded.outcome, PluginControlOutcome::Applied);
    assert_eq!(reloaded.generations[0].generation, 2);
    assert_eq!(example_report(&root, "cleanup")["completed"], true);
    let second = flow.inspect();
    assert_eq!(plugin(&second).generation, 2);
    assert_eq!(plugin(&second).state, ExecutionState::Active);
    assert!(plugin(&second).process_id.is_some());
    assert_eq!(
        plugin(&first).generation,
        1,
        "a previously read sample is immutable"
    );
    assert!(second.host_inspection.as_ref().unwrap().history_truncated);
    assert_resource_order(&flow.trace(), &[1, 2], true);
    let doctor = flow.doctor(&second);
    assert_eq!(
        doctor["runtime"]["hostProcesses"]["sample"]["plugins"][0]["processId"],
        json!(plugin(&second).process_id)
    );
    assert_eq!(doctor["runtime"]["hostProcesses"]["states"]["active"], 1);

    // Inject failure around, not instead of, the actual example. It has already
    // attached and set its marker when this activation rejects; its unchanged
    // real deactivate method must clean that partially initialized generation.
    let broken = format!(
        "{revision}\nconst originalActivate = module.exports.activate;\nmodule.exports.activate = async (context) => {{ await originalActivate(context); throw new Error('development-flow failure after attach'); }};\n"
    );
    std::fs::write(root.join("dist/host.js"), &broken).unwrap();
    let failed = flow.settle_edit();
    let restored = flow.wait(&failed);
    assert_eq!(restored.outcome, PluginControlOutcome::RolledBack);
    assert_eq!(restored.generations[0].generation, 4);
    assert!(restored.target_failures.iter().any(|failure| {
        failure.stage == "activate"
            && failure
                .error
                .contains("development-flow failure after attach")
    }));
    assert!(restored.desired_enabled);
    assert_eq!(example_report(&root, "cleanup")["completed"], true);
    assert_eq!(example_report(&root, "active")["generation"], 4);
    assert_eq!(
        std::fs::read_to_string(root.join("dist/host.js")).unwrap(),
        broken,
        "rollback restores the loaded snapshot, not the editable file"
    );
    assert_resource_order(&flow.trace(), &[1, 2, 3, 4], true);
    let recovered = flow.inspect();
    assert_eq!(plugin(&recovered).state, ExecutionState::Active);
    assert_eq!(plugin(&recovered).generation, 4);
    let recovered_doctor = flow.doctor(&recovered);
    assert_eq!(
        recovered_doctor["runtime"]["hostProcesses"]["assessment"],
        "active"
    );
    assert_eq!(
        recovered_doctor["runtime"]["hostProcesses"]["sample"]["plugins"][0]["generation"],
        4
    );
    let before_quiet = flow.trace();
    for _ in 0..8 {
        flow.tick(true);
    }
    assert_eq!(flow.watch_tickets.len(), 2);
    assert_eq!(
        flow.trace(),
        before_quiet,
        "stable polling must not retry the same failed candidate after compensation"
    );

    let disabled = flow.submit(PluginControlAction::Disable);
    let stopped = flow.wait(&disabled);
    assert_eq!(stopped.outcome, PluginControlOutcome::Applied);
    assert!(!stopped.desired_enabled && stopped.generations.is_empty());
    assert_eq!(example_report(&root, "cleanup")["completed"], true);
    let final_trace = flow.trace();
    assert_resource_order(&final_trace, &[1, 2, 3, 4], false);
    let retired = flow.inspect();
    let retired_plugin = plugin(&retired);
    assert_eq!(retired_plugin.state, ExecutionState::Exited);
    assert_eq!(retired_plugin.generation, 4);
    assert_eq!(retired_plugin.cleanup.phase, HostCleanupPhase::Completed);
    assert_eq!(
        retired_plugin.pending_core_requests
            + retired_plugin.subscriptions
            + retired_plugin.outbox
            + retired_plugin.cleanup.pending_requests,
        0
    );
    assert!(!retired_plugin.launching);
    let exit = retired_plugin.exit.unwrap();
    assert_eq!(Some(exit.process_id), plugin(&recovered).process_id);
    assert!(exit.workers_reaped && !exit.forced && exit.exit_code == 0);
    let retired_doctor = flow.doctor(&retired);
    assert_eq!(
        retired_doctor["runtime"]["hostProcesses"]["assessment"],
        "no_active_hosts"
    );
    assert_eq!(
        retired_doctor["runtime"]["hostProcesses"]["sample"]["plugins"][0]["cleanup"]["phase"],
        "completed"
    );
    assert_eq!(
        retired_doctor["runtime"]["hostProcesses"]["sample"]["plugins"][0]["exit"]["workersReaped"],
        true
    );
    assert_eq!(retired_doctor["result"]["exitCode"], 0);
    for _ in 0..4 {
        flow.tick(true);
    }
    assert_eq!(flow.trace(), final_trace);

    flow.terminate();
    let terminal = flow.inspect();
    assert_eq!(
        terminal.inspection.as_ref().unwrap().state,
        HostState::Terminated
    );
    let hosts = terminal.host_inspection.as_ref().unwrap();
    assert!(!hosts.owner_alive && hosts.runtime_stopping);
    assert_eq!(plugin(&terminal).cleanup.phase, HostCleanupPhase::Completed);
    assert_eq!(
        flow.doctor(&terminal)["runtime"]["hostProcesses"]["assessment"],
        "runtime_terminated"
    );
    assert_eq!(flow.doctor(&terminal)["result"]["exitCode"], 0);
    println!(
        "development-flow: active generations 1 -> 2 -> failed 3 -> restored 4 -> exited; four sessions attached and detached; final pending/subscription/outbox counts=0"
    );
    let sequence: Vec<_> = final_trace["requests"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|request| match request["method"].as_str().unwrap() {
            "Target.attachToTarget" => Some("Attach".to_owned()),
            "Runtime.evaluate" => Some(format!(
                "{} {}",
                if request["params"]["expression"]
                    .as_str()
                    .unwrap()
                    .starts_with("delete ")
                {
                    "Delete"
                } else {
                    "Set"
                },
                request["sessionId"].as_str().unwrap()
            )),
            "Target.detachFromTarget" => Some(format!(
                "Detach {}",
                request["params"]["sessionId"].as_str().unwrap()
            )),
            _ => None,
        })
        .collect();
    println!("development-flow CDP order: {}", sequence.join(" -> "));
}
