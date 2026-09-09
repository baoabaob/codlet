#![cfg(windows)]

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use codlet::cdp::CdpClient;
use codlet::host_runtime::{HostOperation, HostOperationResult, HostRuntime};
use codlet::js_runtime::JsRuntime;
use codlet::local_plugins::load_local_plugin;
use codlet::plugin_execution::{ExecutionState, HostRuntimeSnapshot};
use codlet::plugins::Permission;
use codlet::runtime_control::{ControlBroker, ControlReport, ControlRequest, ControlStatus};
use codlet::runtime_status::{HostState, StatusPublisher};
use codlet::windows::process::{ChildProcess, launch_with_cdp_pipes};
use serde_json::json;

const WAIT: Duration = Duration::from_secs(8);
const ID: &str = "dev.inspected-host";

struct Fixture {
    hosts: HostRuntime,
    client: CdpClient,
    child: ChildProcess,
    status: StatusPublisher,
    broker: ControlBroker,
}

impl Fixture {
    fn new() -> Self {
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
                .unwrap();
        let hosts =
            HostRuntime::start_with_runtime(Vec::new(), client.clone(), Some(runtime)).unwrap();
        let status = StatusPublisher::new();
        status
            .bind_runtime_identity([5; 16], &"a".repeat(64))
            .unwrap();
        status.set_ready();
        let broker = ControlBroker::with_inspection([5; 16], "a".repeat(64), status.clone());
        broker.set_ready();
        Self {
            hosts,
            client,
            child,
            status,
            broker,
        }
    }

    fn wait_sample(&self, predicate: impl Fn(&HostRuntimeSnapshot) -> bool) -> HostRuntimeSnapshot {
        let deadline = Instant::now() + WAIT;
        loop {
            let sample = self.hosts.execution_snapshot();
            if predicate(&sample) {
                return sample;
            }
            assert!(
                Instant::now() < deadline,
                "did not observe requested process state: {sample:?}"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn inspect(&self) -> ControlReport {
        self.status
            .publish_host_observation(self.hosts.execution_snapshot());
        let report = self.broker.handle(ControlRequest::inspect_execution());
        assert_eq!(report.status, ControlStatus::Inspected, "{report:?}");
        report
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.hosts.stop();
        let _ = self.client.shutdown();
        let _ = self.child.wait(WAIT);
    }
}

fn operation(operation: &mut HostOperation) -> HostOperationResult {
    let deadline = Instant::now() + WAIT;
    loop {
        if let Some(result) = operation.try_result() {
            return result.unwrap();
        }
        assert!(
            Instant::now() < deadline,
            "lifecycle receipt did not complete"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn real_host_execution_publications_follow_start_stop_and_replacement_without_exposing_source() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let grants = [Permission::HostProcess, Permission::CdpRaw];
    std::fs::write(
        root.join("codlet.json"),
        json!({"schema":1,"id":ID,"version":"1","host":{"entry":"host.js"},"permissions":grants})
            .to_string(),
    )
    .unwrap();
    std::fs::write(root.join("host.js"), r#"
const fs = require('node:fs');
const sourceMarker = 'SOURCE_IS_NOT_A_DIAGNOSTIC_FIELD_123';
module.exports = {
  async activate(context) {
    await context.cdp.request('Fixture.ping');
    while (!fs.existsSync('continue') && !context.signal.aborted) await new Promise(resolve => setTimeout(resolve, 10));
  },
  async deactivate() { await new Promise(resolve => setTimeout(resolve, 150)); }
};
"#).unwrap();
    let mut fixture = Fixture::new();
    let empty = fixture.inspect();
    assert!(empty.host_inspection.unwrap().plugins.is_empty());
    let plugin = load_local_plugin(ID, root, &grants, 1).unwrap();
    let mut starting = fixture.hosts.begin_start(plugin).unwrap();
    fixture.wait_sample(|sample| {
        sample.plugins.iter().any(|plugin| {
            plugin.id == ID
                && plugin.state == ExecutionState::Starting
                && plugin.process_id.is_some()
        })
    });
    let pending = fixture.inspect();
    assert_eq!(
        pending.host_inspection.as_ref().unwrap().plugins[0].state,
        ExecutionState::Starting
    );
    assert!(starting.try_result().is_none());
    std::fs::write(root.join("continue"), "ready").unwrap();
    let HostOperationResult::Started { process_id, .. } = operation(&mut starting) else {
        panic!("expected Started");
    };
    let active = fixture.inspect();
    let first = active.host_inspection.as_ref().unwrap();
    assert_eq!(first.plugins[0].process_id, Some(process_id));
    assert_eq!(first.plugins[0].state, ExecutionState::Active);
    assert_eq!(first.plugins[0].generation, 1);
    let encoded = serde_json::to_vec(&active).unwrap();
    assert!(!String::from_utf8_lossy(&encoded).contains("SOURCE_IS_NOT_A_DIAGNOSTIC_FIELD_123"));
    assert!(!String::from_utf8_lossy(&encoded).contains(&root.to_string_lossy().to_string()));
    assert_eq!(
        serde_json::from_slice::<ControlReport>(&encoded).unwrap(),
        active
    );
    let sequence = fixture.status.snapshot().sequence;
    for _ in 0..4 {
        assert_eq!(
            fixture.broker.handle(ControlRequest::inspect_execution()),
            active
        );
    }
    assert_eq!(fixture.status.snapshot().sequence, sequence);
    assert!(fixture.broker.take_next().is_none());
    assert!(
        fixture
            .broker
            .handle(ControlRequest::inspect())
            .host_inspection
            .is_none()
    );

    let mut stopping = fixture.hosts.begin_stop(ID, 1).unwrap();
    fixture.wait_sample(|sample| sample.plugins[0].state == ExecutionState::Stopping);
    assert_eq!(
        fixture.inspect().host_inspection.unwrap().plugins[0].state,
        ExecutionState::Stopping
    );
    let HostOperationResult::Stopped { report, .. } = operation(&mut stopping) else {
        panic!("expected Stopped");
    };
    assert!(report.workers_reaped && !report.forced);
    let retired = fixture.inspect().host_inspection.unwrap();
    assert_eq!(retired.plugins[0].state, ExecutionState::Exited);
    assert_eq!(
        retired.plugins[0].exit.as_ref().unwrap().process_id,
        process_id
    );
    assert!(retired.plugins[0].exit.as_ref().unwrap().workers_reaped);
    assert_eq!(
        retired.plugins[0].pending_core_requests
            + retired.plugins[0].subscriptions
            + retired.plugins[0].outbox,
        0
    );

    std::fs::write(
        root.join("host.js"),
        "module.exports={activate(){},deactivate(){}};",
    )
    .unwrap();
    operation(
        &mut fixture
            .hosts
            .begin_start(load_local_plugin(ID, root, &grants, 2).unwrap())
            .unwrap(),
    );
    let replacement = fixture.inspect().host_inspection.unwrap();
    assert_eq!(replacement.plugins.len(), 1);
    assert_eq!(replacement.plugins[0].generation, 2);
    assert!(replacement.sequence > first.sequence && replacement.history_truncated);
    assert_eq!(active.host_inspection.unwrap().plugins[0].generation, 1);
    fixture.hosts.stop().unwrap();
    fixture
        .status
        .publish_host_observation(fixture.hosts.execution_snapshot());
    fixture.status.terminate("fixture completed");
    let terminal = fixture.broker.handle(ControlRequest::inspect_execution());
    assert_eq!(terminal.inspection.unwrap().state, HostState::Terminated);
    let terminal = terminal.host_inspection.unwrap();
    assert!(!terminal.owner_alive && terminal.runtime_stopping);
    assert_eq!(terminal.plugins[0].state, ExecutionState::Exited);
}
