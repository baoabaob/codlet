//! A real Node Host cancels an attach after the peer already created the
//! session but before delivering its response. Core must retain that receipt.

use super::host_renderer_vm_tests::VmPeer;
use super::*;
use crate::capabilities::{CapabilityDescriptor, CapabilityScope};
use crate::host_runtime::{
    HostCapabilityCaller, HostCapabilityOperation, HostCapabilityRequest, HostOperation,
    HostOperationResult, HostRuntime,
};
use crate::local_plugins::load_local_plugin;
use crate::plugin_execution::ExecutionState;
use crate::plugin_host::HostError;
use crate::plugins::Permission;
use serde_json::json;
use tempfile::{TempDir, tempdir};

const ID: &str = "dev.attachment-retirement";
const WAIT: Duration = Duration::from_secs(6);

struct Fixture {
    hosts: HostRuntime,
    peer: VmPeer,
    _directory: TempDir,
    stopped: bool,
}
impl Fixture {
    fn new() -> Self {
        let directory = tempdir().unwrap();
        std::fs::write(directory.path().join("codlet.json"), json!({"schema":1,"id":ID,"version":"1","host":{"entry":"host.js"},"permissions":["host.process","cdp.raw"],"provides":[{"name":"dev.attachment-retirement","api":1,"scope":"runtime"}]}).to_string()).unwrap();
        std::fs::write(directory.path().join("host.js"), r#"module.exports = { activate(context) {
          const cap={name:'dev.attachment-retirement',api:1,scope:'runtime'};
          context.rpc.provide(cap,'attach',params=>context.cdp.request('Target.attachToTarget',{targetId:'window-a',flatten:true},{timeoutMs:params.timeoutMs??15000}));
          context.rpc.provide(cap,'ping',()=>({alive:true}));
          context.rpc.provide(cap,'batch',async()=>{for(let index=0;index<128;index++)await context.cdp.request('Target.attachToTarget',{targetId:'window-a',flatten:true});return {attached:128};});
        }, deactivate() {} };"#).unwrap();
        let plugin = load_local_plugin(
            ID,
            directory.path(),
            &[Permission::HostProcess, Permission::CdpRaw],
            1,
        )
        .unwrap();
        let (peer, events) = VmPeer::start();
        drop(events);
        let hosts = HostRuntime::start_with_runtime(
            vec![plugin],
            peer.client.clone(),
            Some(peer.runtime.clone()),
        )
        .unwrap();
        until(|| !hosts.is_starting());
        assert_eq!(hosts.observations()[0].state, ExecutionState::Active);
        Self {
            hosts,
            peer,
            _directory: directory,
            stopped: false,
        }
    }
    fn call(&self, method: &str, params: Value) -> HostCapabilityOperation {
        self.hosts
            .capability_client()
            .begin_request(HostCapabilityRequest {
                owner_plugin_id: ID.into(),
                expected_generation: 1,
                capability: CapabilityDescriptor::new(ID, 1, CapabilityScope::Runtime).unwrap(),
                method: method.into(),
                params,
                caller: HostCapabilityCaller {
                    plugin_id: "dev.caller".into(),
                    generation: 1,
                    target_id: String::new(),
                    document_epoch: 0,
                },
                deadline: Instant::now() + Duration::from_secs(6),
            })
            .unwrap()
    }
    fn hold(&self, timeout: Option<u64>) -> HostCapabilityOperation {
        self.peer.request("Fixture.holdNextAttach", json!({}));
        let call = self.call(
            "attach",
            timeout.map_or_else(|| json!({}), |timeout| json!({"timeoutMs":timeout})),
        );
        until(|| self.inspect()["heldAttachments"] == 1);
        assert_eq!(self.inspect()["sessions"].as_array().unwrap().len(), 1);
        call
    }
    fn inspect(&self) -> Value {
        self.peer.request("Fixture.inspect", json!({}))
    }
    fn release_and_assert_retired(&self) {
        assert_eq!(
            self.peer.request("Fixture.releaseAttaches", json!({}))["released"],
            1
        );
        until(|| self.inspect()["sessions"].as_array().unwrap().is_empty());
        assert_eq!(self.peer.request("Fixture.ping", json!({}))["alive"], true);
    }
    fn close(&mut self) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        let reports = self.hosts.stop().unwrap();
        if !thread::panicking() {
            for report in reports {
                let report = report.result.unwrap();
                assert!(report.workers_reaped && !report.forced && report.exit_code == 0);
            }
            assert_eq!(self.inspect()["sessions"], json!([]));
        }
        self.peer.close();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if thread::panicking() {
            let _ = self.hosts.stop();
            self.peer.close();
        } else {
            self.close();
        }
    }
}
fn until(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !predicate() {
        assert!(Instant::now() < deadline, "attachment state did not settle");
        thread::sleep(Duration::from_millis(5));
    }
}
fn result(mut operation: HostCapabilityOperation) -> Result<Value, HostError> {
    let mut result = None;
    until(|| {
        result = operation.try_result();
        result.is_some()
    });
    result.unwrap()
}
fn lifecycle(mut operation: HostOperation) -> Result<HostOperationResult, HostError> {
    let mut result = None;
    until(|| {
        result = operation.try_result();
        result.is_some()
    });
    result.unwrap()
}

#[test]
fn cancelled_host_caller_still_retires_a_late_successful_raw_attachment() {
    let mut fixture = Fixture::new();
    let operation = fixture.hold(None);
    operation.cancel();
    assert_eq!(result(operation).unwrap_err().code, "invocation_cancelled");
    fixture.release_and_assert_retired();
    assert_eq!(
        result(fixture.call("ping", json!({}))).unwrap()["alive"],
        true
    );
    fixture.close();
}

#[test]
fn short_sdk_deadline_does_not_discard_the_attachment_retirement_receipt() {
    let mut fixture = Fixture::new();
    let operation = fixture.hold(Some(100));
    assert_eq!(result(operation).unwrap_err().code, "request_timeout");
    fixture.release_and_assert_retired();
    fixture.close();
}

#[test]
fn stop_receipt_waits_for_late_attach_and_core_detach_after_node_exit() {
    let mut fixture = Fixture::new();
    let operation = fixture.hold(None);
    let mut stop = fixture.hosts.begin_stop(ID, 1).unwrap();
    until(|| {
        matches!(
            fixture.hosts.observations()[0].state,
            ExecutionState::Exited | ExecutionState::Failed
        )
    });
    assert!(
        stop.try_result().is_none(),
        "Node exit cannot stand in for raw session retirement"
    );
    fixture.release_and_assert_retired();
    match lifecycle(stop).unwrap() {
        HostOperationResult::Stopped { report, .. } => {
            assert!(report.workers_reaped && !report.forced && report.exit_code == 0)
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(result(operation).unwrap_err().code, "host_stopping");
    fixture.close();
}

#[test]
fn unknown_attachment_result_quarantines_the_generation_and_closes_the_shared_pipe() {
    let mut fixture = Fixture::new();
    let _operation = fixture.hold(None);
    let stop = fixture.hosts.begin_stop(ID, 1).unwrap();
    assert_eq!(lifecycle(stop).unwrap_err().code, "cleanup_incomplete");
    assert!(
        fixture.peer.client.closed_reason().is_some(),
        "an unknown remote attachment must not outlive an open shared pipe"
    );
    let reports = fixture.hosts.stop().unwrap();
    assert!(reports.iter().all(|report| {
        report
            .result
            .as_ref()
            .is_err_and(|error| error.code == "cleanup_incomplete")
    }));
    fixture.stopped = true;
    fixture.peer.close();
}

#[test]
fn all_128_known_sessions_are_detached_through_a_bounded_cleanup_queue() {
    let mut fixture = Fixture::new();
    fixture
        .peer
        .request("Fixture.sessionLimit", json!({"value":128}));
    assert_eq!(
        result(fixture.call("batch", json!({}))).unwrap()["attached"],
        128
    );
    assert_eq!(fixture.inspect()["sessions"].as_array().unwrap().len(), 128);
    assert!(
        result(fixture.call("attach", json!({}))).is_err(),
        "the full quota must reject before another remote attach"
    );
    let stopped = lifecycle(fixture.hosts.begin_stop(ID, 1).unwrap()).unwrap();
    assert!(
        matches!(stopped,HostOperationResult::Stopped{report,..} if report.workers_reaped && !report.forced && report.exit_code==0)
    );
    assert_eq!(fixture.inspect()["sessions"], json!([]));
    assert_eq!(
        fixture.peer.request("Fixture.ping", json!({}))["alive"],
        true
    );
    fixture.close();
}
