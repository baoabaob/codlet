#![cfg(windows)]

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use codlet::cdp::CdpClient;
use codlet::host_runtime::HostRuntime;
use codlet::local_plugins::load_local_plugin;
use codlet::plugin_execution::ExecutionState;
use codlet::plugin_host::{HostEvent, HostIdentity, HostRpcError, HostSupervisor};
use codlet::plugins::{LoadedPlugin, Permission};
use codlet::windows::process::{ChildProcess, launch_with_cdp_pipes};
use serde_json::{Value, json};
use tempfile::tempdir;

const WAIT: Duration = Duration::from_secs(7);

struct CdpPeer {
    client: CdpClient,
    child: ChildProcess,
}
impl CdpPeer {
    fn start() -> Self {
        Self::scenario("raw-host-cdp")
    }

    fn scenario(scenario: &str) -> Self {
        let (child, pipes) = launch_with_cdp_pipes(
            &PathBuf::from(env!("CARGO_BIN_EXE_codlet-fake-child")),
            &[OsString::from(format!("--scenario={scenario}"))],
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
impl Drop for CdpPeer {
    fn drop(&mut self) {
        let _ = self.client.shutdown();
        let _ = self.child.wait(WAIT);
    }
}

fn plugin(directory: &Path, id: &str, raw_grant: bool, malformed: bool) -> (LoadedPlugin, PathBuf) {
    let root = directory.join(id);
    std::fs::create_dir(&root).unwrap();
    let source = if malformed {
        env!("CARGO_BIN_EXE_codlet-fake-host")
    } else {
        env!("CARGO_BIN_EXE_codlet-raw-host-example")
    };
    std::fs::copy(source, root.join("host.exe")).unwrap();
    let report = root.join("report.json");
    let command = if malformed {
        json!(["host.exe", "malformed"])
    } else {
        json!([
            "host.exe",
            "--report",
            "report.json",
            "--expression",
            "'literal host expression'"
        ])
    };
    let mut grants = vec![Permission::HostProcess];
    if raw_grant {
        grants.push(Permission::CdpRaw);
    }
    let manifest = json!({"schema":1,"id":id,"version":"1","host":{"command":command,"protocol":"jsonl"},"permissions":grants});
    std::fs::write(
        root.join("plugin.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let loaded = load_local_plugin(id, &root, &grants, 11).unwrap();
    assert!(loaded.source.is_none() && loaded.manifest.renderer.is_none());
    assert!(loaded.manifest.provides.is_empty() && loaded.manifest.requires.is_empty());
    (loaded, report)
}

fn until(runtime: &HostRuntime, settled: impl Fn(&HostRuntime) -> bool) {
    let deadline = Instant::now() + WAIT;
    while !settled(runtime) {
        assert!(
            Instant::now() < deadline,
            "host runtime did not settle: {:?}",
            runtime.take_diagnostics()
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn state(runtime: &HostRuntime, id: &str) -> Option<ExecutionState> {
    runtime
        .observations()
        .iter()
        .find(|item| item.plugin.manifest.id == id)
        .map(|item| item.state)
}

fn read_report(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

#[test]
fn standalone_host_initializes_through_raw_sessions_and_events_without_a_renderer() {
    let directory = tempdir().unwrap();
    let peer = CdpPeer::start();
    let (plugin, report) = plugin(directory.path(), "dev.raw-good", true, false);
    let mut runtime = HostRuntime::start(vec![plugin], peer.client.clone()).unwrap();
    until(&runtime, |runtime| {
        state(runtime, "dev.raw-good") == Some(ExecutionState::Active)
    });
    let report = read_report(&report);
    assert_eq!(report["ready"], true);
    assert_eq!(report["targetId"], "arbitrary-worker");
    assert_eq!(report["sessionId"], "raw-session-1");
    assert_eq!(report["evaluation"]["result"]["value"], "raw-host-title");
    assert_eq!(
        report["evaluation"]["observedExpression"],
        "'literal host expression'"
    );
    assert_eq!(report["unsubscribed"], true);
    assert_eq!(report["detached"], true);
    assert_eq!(report["eventsTruncated"], false);
    let events = report["events"].as_array().unwrap();
    assert!(
        !events.is_empty(),
        "the host received no raw CDP event: {report}"
    );
    assert!(
        events
            .iter()
            .all(|entry| entry["event"]["sessionId"] == "raw-session-1"),
        "session filter admitted a root or different-session event: {events:?}"
    );
    assert!(
        events
            .iter()
            .any(|entry| entry["event"]["method"] == "Runtime.executionContextCreated")
    );
    let trace = peer.request("Fixture.trace");
    let methods: Vec<_> = trace["requests"]
        .as_array()
        .unwrap()
        .iter()
        .map(|request| request["method"].as_str().unwrap())
        .collect();
    assert_eq!(
        methods,
        [
            "Target.getTargets",
            "Target.attachToTarget",
            "Runtime.enable",
            "Runtime.evaluate",
            "Target.detachFromTarget"
        ]
    );
    assert_eq!(trace["liveSessions"], json!([]));
    let stopped = runtime.stop().unwrap();
    assert_eq!(stopped.len(), 1);
    let stopped = stopped[0].result.as_ref().unwrap();
    assert_eq!(stopped.exit_code, 0);
    assert!(stopped.workers_reaped && !stopped.forced);
    assert_eq!(
        peer.request("Fixture.ping")["alive"],
        true,
        "stopping a plugin closed the shared CDP client"
    );
}

#[test]
fn denied_raw_permission_and_malformed_host_leave_the_other_host_and_cdp_alive() {
    let directory = tempdir().unwrap();
    let peer = CdpPeer::start();
    let (denied, denied_report) = plugin(directory.path(), "dev.raw-denied", false, false);
    let (malformed, _) = plugin(directory.path(), "dev.raw-malformed", true, true);
    let (good, report) = plugin(directory.path(), "dev.raw-good", true, false);
    let mut runtime =
        HostRuntime::start(vec![denied, malformed, good], peer.client.clone()).unwrap();
    until(&runtime, |runtime| {
        state(runtime, "dev.raw-denied") == Some(ExecutionState::Failed)
            && state(runtime, "dev.raw-malformed") == Some(ExecutionState::Failed)
            && state(runtime, "dev.raw-good") == Some(ExecutionState::Active)
    });
    assert_eq!(
        read_report(&denied_report)["error"]["code"],
        "permission_denied"
    );
    assert_eq!(read_report(&report)["ready"], true);
    let observations = runtime.observations();
    assert!(
        observations
            .iter()
            .find(|item| item.plugin.manifest.id == "dev.raw-malformed")
            .unwrap()
            .error
            .as_deref()
            .unwrap()
            .contains("protocol_error")
    );
    let trace = peer.request("Fixture.trace");
    assert_eq!(
        trace["requests"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|request| request["method"] == "Target.getTargets")
            .count(),
        1,
        "an ungranted or malformed Host issued a raw command"
    );
    assert_eq!(peer.request("Fixture.ping")["alive"], true);
    let stopped = runtime.stop().unwrap();
    assert_eq!(stopped.len(), 3);
    assert!(stopped.iter().all(|report| {
        report
            .result
            .as_ref()
            .is_ok_and(|result| result.workers_reaped)
    }));
    assert_eq!(peer.request("Fixture.ping")["alive"], true);
}

#[test]
fn example_waits_for_a_target_that_appears_after_initial_empty_queries() {
    let directory = tempdir().unwrap();
    let peer = CdpPeer::scenario("raw-host-cdp-delayed");
    let (plugin, report) = plugin(directory.path(), "dev.raw-delayed", true, false);
    let mut runtime = HostRuntime::start(vec![plugin], peer.client.clone()).unwrap();
    until(&runtime, |runtime| {
        state(runtime, "dev.raw-delayed") == Some(ExecutionState::Active)
    });
    assert_eq!(read_report(&report)["ready"], true);
    let trace = peer.request("Fixture.trace");
    let requests = trace["requests"].as_array().unwrap();
    assert_eq!(
        requests
            .iter()
            .take_while(|request| request["method"] == "Target.getTargets")
            .count(),
        3
    );
    assert_eq!(trace["liveSessions"], json!([]));
    assert!(runtime.stop().unwrap().iter().all(|report| {
        report
            .result
            .as_ref()
            .is_ok_and(|result| result.workers_reaped)
    }));
}

#[test]
fn example_cleans_up_early_failures_and_makes_no_callbacks_after_shutdown() {
    for point in ["subscribe", "enable", "shutdown", "cleanup-shutdown"] {
        let directory = tempdir().unwrap();
        let mut host = HostSupervisor::spawn(
            HostIdentity {
                plugin_id: "dev.raw-cleanup".into(),
                generation: 1,
            },
            &PathBuf::from(env!("CARGO_BIN_EXE_codlet-raw-host-example")),
            &["--report".into(), "report.json".into()],
            directory.path(),
        )
        .unwrap();
        let initialize = host
            .send_request(
                "initialize",
                json!({"protocolVersion":1}),
                Duration::from_secs(5),
            )
            .unwrap();
        let deadline = Instant::now() + WAIT;
        let mut trace = Vec::new();
        let mut initialization_error = None;
        let mut sent_shutdown = false;
        let mut exited = false;
        while initialization_error.is_none() && !exited {
            for event in host.poll() {
                match event {
                    HostEvent::Request { id, method, params } => {
                        assert!(
                            !sent_shutdown,
                            "example called Core after shutdown: {method}, {params}"
                        );
                        let operation = if method == "cdp.request" {
                            params["method"].as_str().unwrap()
                        } else {
                            method.as_str()
                        };
                        trace.push(operation.to_owned());
                        if (operation == "Runtime.enable" && point == "shutdown")
                            || (operation == "cdp.unsubscribe" && point == "cleanup-shutdown")
                        {
                            host.send_request("shutdown", Value::Null, Duration::from_secs(1))
                                .unwrap();
                            sent_shutdown = true;
                            continue;
                        }
                        let result = match operation {
                            "Target.getTargets" => {
                                Ok(json!({"targetInfos":[{"targetId":"worker","type":"worker"}]}))
                            }
                            "Target.attachToTarget" => Ok(json!({"sessionId":"test-session"})),
                            "cdp.subscribe" if point != "subscribe" => {
                                Ok(json!({"subscriptionId":1}))
                            }
                            "cdp.subscribe" | "Runtime.enable" => Err(HostRpcError::new(
                                "primary_failure",
                                format!("{point} first failure"),
                            )),
                            "cdp.unsubscribe" | "Target.detachFromTarget" => {
                                Err(HostRpcError::new("cleanup_failure", "cleanup also failed"))
                            }
                            other => panic!("unexpected example call in {point}: {other}"),
                        };
                        host.respond(id, result).unwrap();
                    }
                    HostEvent::Response { id, result } if id == initialize => {
                        initialization_error =
                            Some(result.expect_err("failure fixture unexpectedly became ready"));
                    }
                    HostEvent::Exited { exit_code } => {
                        assert_eq!(exit_code, 0);
                        exited = true;
                    }
                    HostEvent::Failed { error } => {
                        panic!("native example failed its transport: {error}")
                    }
                    _ => {}
                }
            }
            assert!(
                Instant::now() < deadline,
                "example did not complete {point}: {trace:?}"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
        if sent_shutdown {
            assert!(exited);
            assert!(
                !trace
                    .iter()
                    .any(|method| method == "Target.detachFromTarget")
            );
            if point == "shutdown" {
                assert!(!trace.iter().any(|method| method == "cdp.unsubscribe"));
            }
        } else {
            let error = initialization_error.unwrap();
            assert_eq!(error.code, "primary_failure");
            assert_eq!(error.message, format!("{point} first failure"));
            assert_eq!(trace.last().unwrap(), "Target.detachFromTarget");
            assert_eq!(
                trace.iter().any(|method| method == "cdp.unsubscribe"),
                point == "enable"
            );
            assert_eq!(
                read_report(&directory.path().join("report.json"))["error"]["code"],
                "primary_failure"
            );
        }
        let stopped = host.stop().unwrap();
        assert!(stopped.workers_reaped && !stopped.forced);
    }
}
