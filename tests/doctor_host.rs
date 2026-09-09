use codlet::catalog::PluginCatalog;
use codlet::diagnostics::{
    Check, DoctorInputs, DoctorReport, DoctorRuntimeInput, PackageInfo, ProcessSnapshot,
};
use codlet::plugin_execution::{
    ExecutionState, HostCleanupPhase, HostCleanupSnapshot, HostPluginSnapshot,
    HostProcessExitSnapshot, HostRuntimeSnapshot,
};
use codlet::plugins::{PluginRegistry, bundled_plugins};
use codlet::runtime_inspection::{RendererInspection, RuntimeInspection};
use codlet::runtime_status::HostState;
use serde_json::Value;

fn static_report() -> DoctorReport {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("missing-config.json");
    DoctorReport::from_inputs(DoctorInputs {
        package: Check::ok(PackageInfo {
            family_name: "fixture".into(),
            full_name: "fixture_1".into(),
            version: "1".into(),
            install_location: "C:/fixture".into(),
        }),
        executable: Check::ok("C:/fixture/Codex.exe".into()),
        processes: Check::ok(ProcessSnapshot::new(Vec::new())),
        registry_path: Some(path.clone()),
        registry: PluginRegistry::load(&path),
        catalog: bundled_plugins().map(PluginCatalog::from_bundled),
    })
}

fn runtime() -> RuntimeInspection {
    RuntimeInspection {
        host_incarnation: "1".repeat(32),
        registry_scope: "a".repeat(64),
        host_pid: 42,
        codlet_version: "fixture".into(),
        state: HostState::Ready,
        sequence: 20,
        sampled_at_unix_ms: 10_000,
        codex: None,
        renderer: Some(RendererInspection::default()),
        termination: None,
    }
}

fn plugin(id: &str, state: ExecutionState) -> HostPluginSnapshot {
    HostPluginSnapshot {
        id: id.into(),
        version: "1".into(),
        generation: 3,
        state,
        process_id: Some(1234),
        error: None,
        pending_core_requests: 0,
        subscriptions: 0,
        outbox: 0,
        launching: false,
        cleanup: HostCleanupSnapshot::default(),
        exit: None,
    }
}

fn hosts() -> HostRuntimeSnapshot {
    HostRuntimeSnapshot {
        sequence: 12,
        sampled_at_unix_ms: 9_980,
        runtime_stopping: false,
        owner_alive: true,
        retained_limit: 80,
        history_truncated: true,
        plugins: vec![plugin("dev.raw", ExecutionState::Active)],
    }
}

fn report(runtime: RuntimeInspection, hosts: HostRuntimeSnapshot) -> DoctorReport {
    static_report().with_runtime(DoctorRuntimeInput::ExecutionInspected {
        inspection: Box::new(runtime),
        hosts: Box::new(hosts),
        queried_at_unix_ms: 10_020,
    })
}

fn as_json(report: &DoctorReport) -> Value {
    serde_json::from_str(&report.to_json()).unwrap()
}

#[test]
fn actual_host_inventory_does_not_invent_renderer_providers_or_current_failures_from_retained_history()
 {
    let mut hosts = hosts();
    let mut failed = plugin("dev.retired", ExecutionState::Failed);
    failed.error = Some("activation fixture failure".into());
    failed.exit = Some(HostProcessExitSnapshot {
        process_id: 1234,
        exit_code: 1,
        forced: false,
        workers_reaped: true,
    });
    hosts.plugins.push(failed);
    let report = report(runtime(), hosts);
    let json = as_json(&report);
    let processes = &json["runtime"]["hostProcesses"];
    assert_eq!(json["result"]["exitCode"], 0);
    assert_eq!(processes["assessment"], "active");
    assert_eq!(processes["ageMs"], 40);
    assert_eq!(processes["sample"]["sequence"], 12);
    assert_eq!(processes["sample"]["historyTruncated"], true);
    assert_eq!(processes["states"]["active"], 1);
    assert_eq!(processes["states"]["failed"], 1);
    assert_eq!(processes["findings"][0]["pluginId"], "dev.retired");
    assert_eq!(processes["findings"][0]["terminal"], true);
    assert!(
        json["runtime"]["providerReady"]["data"]["providers"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        json["runtime"]["targets"]["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        json["plugins"]["data"]
            .as_array()
            .unwrap()
            .iter()
            .all(|plugin| plugin["id"] != "dev.raw")
    );
    let text = report.to_human_readable();
    assert!(text.contains("host-plugin: dev.raw") && text.contains("confirmed-exit: pid=1234"));
    assert!(text.contains("terminal=true"));
}

#[test]
fn host_source_freshness_is_independent_of_newer_renderer_publication() {
    for (timestamp, sequence, expected) in [
        (1, 12, "stale"),
        (11_000, 12, "clock_skew"),
        (0, 0, "not_sampled"),
    ] {
        let mut hosts = hosts();
        hosts.sampled_at_unix_ms = timestamp;
        hosts.sequence = sequence;
        hosts.owner_alive = false;
        let json = as_json(&report(runtime(), hosts));
        assert_eq!(json["runtime"]["sample"]["freshness"], "fresh");
        assert_eq!(json["runtime"]["hostProcesses"]["freshness"], expected);
        assert_eq!(json["runtime"]["hostProcesses"]["assessment"], expected);
        assert_eq!(json["result"]["exitCode"], 0);
    }
    let legacy = static_report().with_runtime(DoctorRuntimeInput::Inspected {
        inspection: Box::new(runtime()),
        queried_at_unix_ms: 10_020,
    });
    assert!(as_json(&legacy)["runtime"].get("hostProcesses").is_none());
}

#[test]
fn a_stopped_process_owner_is_a_current_failure_only_while_the_runtime_is_ready_and_not_stopping() {
    let mut stopped = hosts();
    stopped.owner_alive = false;
    let json = as_json(&report(runtime(), stopped.clone()));
    assert_eq!(json["result"]["exitCode"], 1);
    assert_eq!(
        json["runtime"]["issues"][0]["code"],
        "runtime_host_owner_stopped"
    );
    stopped.runtime_stopping = true;
    assert_eq!(
        as_json(&report(runtime(), stopped.clone()))["result"]["exitCode"],
        0
    );
    let mut terminated = runtime();
    terminated.state = HostState::Terminated;
    let report = as_json(&report(terminated, stopped));
    assert_eq!(
        report["runtime"]["hostProcesses"]["assessment"],
        "runtime_terminated"
    );
    assert_eq!(report["result"]["exitCode"], 0);
}

#[test]
fn cleanup_progress_and_retired_cleanup_failures_keep_their_actual_generation_and_exit_facts() {
    let mut hosts = hosts();
    let running = &mut hosts.plugins[0];
    running.state = ExecutionState::Stopping;
    running.cleanup = HostCleanupSnapshot {
        phase: HostCleanupPhase::Running,
        remaining_budget_ms: Some(250),
        pending_requests: 1,
        error: None,
    };
    let json = as_json(&report(runtime(), hosts.clone()));
    assert_eq!(
        json["runtime"]["hostProcesses"]["assessment"],
        "lifecycle_busy"
    );
    assert_eq!(
        json["runtime"]["hostProcesses"]["sample"]["plugins"][0]["cleanup"]["pendingRequests"],
        1
    );
    hosts.plugins[0].state = ExecutionState::Failed;
    hosts.plugins[0].cleanup = HostCleanupSnapshot {
        phase: HostCleanupPhase::TimedOut,
        remaining_budget_ms: Some(0),
        pending_requests: 0,
        error: Some("cleanup budget expired".into()),
    };
    hosts.plugins[0].exit = Some(HostProcessExitSnapshot {
        process_id: 1234,
        exit_code: 1,
        forced: true,
        workers_reaped: true,
    });
    let json = as_json(&report(runtime(), hosts));
    assert_eq!(
        json["runtime"]["hostProcesses"]["assessment"],
        "no_active_hosts"
    );
    assert_eq!(
        json["runtime"]["hostProcesses"]["findings"][0]["code"],
        "cleanup_timed_out"
    );
    assert_eq!(
        json["runtime"]["hostProcesses"]["findings"][0]["terminal"],
        true
    );
    assert_eq!(json["result"]["exitCode"], 0);
}
