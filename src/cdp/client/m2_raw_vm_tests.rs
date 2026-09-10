//! One third-party Host supplies its own injection, navigation and message ABI.
//! This fixture deliberately never constructs RendererRuntime or TargetController.
use super::host_renderer_vm_tests::VmPeer;
use super::*;
use crate::catalog::PluginCatalog;
use crate::host_runtime::{HostCoreServices, HostRuntime};
use crate::os_broker::OsBroker;
use crate::plugin_execution::{ExecutionState, HostCleanupPhase};
use crate::plugins::{LocalPluginRegistration, Permission, PluginRegistry, bundled_plugins};
use serde_json::json;
use tempfile::{TempDir, tempdir};

const ID: &str = "example.raw-m2";
const KEY: &str = "__codletRawM2";
const WAIT: Duration = Duration::from_secs(8);
const MANIFEST: &str = include_str!("../../../examples/raw-m2/codlet.json");
const HOST: &str = include_str!("../../../examples/raw-m2/host.js");

struct RawFixture {
    hosts: HostRuntime,
    os: OsBroker,
    peer: VmPeer,
    _directory: TempDir,
    stopped: bool,
}

impl RawFixture {
    fn start(failed_cleanup: bool) -> Self {
        let directory = tempdir().unwrap();
        let root = directory.path().join("raw");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("codlet.json"), MANIFEST).unwrap();
        let source = if failed_cleanup {
            format!(
                "{HOST}\nmodule.exports.deactivate = () => {{ throw new Error('intentional raw cleanup failure'); }};"
            )
        } else {
            HOST.to_owned()
        };
        std::fs::write(root.join("host.js"), source).unwrap();
        let path = directory.path().join("registry.json");
        let mut registry = PluginRegistry::load(&path).unwrap();
        for plugin in bundled_plugins().unwrap() {
            registry.set_enabled(&plugin.manifest.id, false).unwrap();
        }
        registry
            .register_local(
                ID,
                LocalPluginRegistration {
                    path: std::fs::canonicalize(&root).unwrap(),
                    grants: vec![Permission::HostProcess, Permission::CdpRaw],
                    broker_policy: Default::default(),
                },
            )
            .unwrap();
        registry.save().unwrap();
        let catalog = PluginCatalog::load(&registry).unwrap();
        let plugins = catalog.enabled_plugins(&registry).unwrap();
        assert_eq!(plugins.len(), 1);
        assert!(plugins[0].manifest.renderer.is_none());
        assert!(plugins[0].manifest.requires.is_empty());
        assert!(plugins[0].manifest.provides.is_empty());
        let (peer, events) = VmPeer::start();
        drop(events); // no managed renderer sink or official target selection
        let os = OsBroker::for_registry(path).unwrap();
        let hosts = HostRuntime::start_with_services(
            plugins,
            peer.client.clone(),
            Some(peer.runtime.clone()),
            HostCoreServices {
                os_broker: Some(os.client()),
                runtime_manage: None,
            },
        )
        .unwrap();
        let deadline = Instant::now() + WAIT;
        while hosts.is_starting() {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(5));
        }
        assert!(
            hosts
                .observations()
                .iter()
                .all(|owner| owner.state == ExecutionState::Active),
            "{:?}",
            hosts.observations()
        );
        let mut fixture = Self {
            hosts,
            os,
            peer,
            _directory: directory,
            stopped: false,
        };
        fixture.until(|value| raw_contexts(value).len() == 2);
        fixture
    }
    fn inspect(&self) -> Value {
        self.peer.request(
            "Fixture.inspect",
            json!({"keys":[KEY,"__codletRendererV1"]}),
        )
    }
    fn until(&mut self, predicate: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + WAIT;
        loop {
            let state = self.inspect();
            if predicate(&state) {
                return state;
            }
            assert!(
                Instant::now() < deadline,
                "raw state never settled: {state}"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn session(&self, target: &str) -> String {
        self.inspect()["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|session| session["targetId"] == target)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .into()
    }
    fn call(&self, target: &str, value: Value) -> Value {
        let session = self.session(target);
        let expression = format!("globalThis.__codletRawM2.request({value})");
        self.peer
            .client
            .request(
                "Runtime.evaluate",
                Some(json!({"expression":expression,"returnByValue":true,"awaitPromise":true})),
                Some(&session),
                WAIT,
            )
            .unwrap()
            .result
            .unwrap()["result"]["value"]
            .clone()
    }
    fn pending(&self, target: &str) -> crate::cdp::QueuedCdpRequest {
        let session = self.session(target);
        self.peer
            .client
            .begin_raw_request(
                "Runtime.evaluate",
                Some(json!({
                    "expression":"globalThis.__codletRawM2.request('old document', {delayMs:250})",
                    "returnByValue":true,"awaitPromise":true,
                })),
                Some(&session),
                Instant::now() + WAIT,
            )
            .unwrap()
    }
    fn stop(&mut self, allow_cleanup_failure: bool) -> Value {
        let reports = self.hosts.stop().unwrap();
        assert!(
            reports
                .iter()
                .all(|report| report.result.as_ref().is_ok_and(|exit| exit.workers_reaped)),
            "{reports:?}"
        );
        if !allow_cleanup_failure {
            assert!(
                reports.iter().all(|report| report
                    .result
                    .as_ref()
                    .is_ok_and(|exit| !exit.forced && exit.exit_code == 0)),
                "{reports:?}"
            );
        }
        assert!(
            self.hosts.observations().iter().all(|owner| matches!(
                owner.state,
                ExecutionState::Exited | ExecutionState::Failed
            ))
        );
        let state = self.until(|state| state["sessions"].as_array().unwrap().is_empty());
        assert_eq!(state["evaluations"], 0);
        for context in state["contexts"].as_array().unwrap() {
            assert_eq!(context["bindings"], json!([]));
            assert_eq!(context["timers"], 0);
            assert_eq!(context["plugins"], json!([]));
        }
        self.os.stop().unwrap();
        self.stopped = true;
        state
    }
}
impl Drop for RawFixture {
    fn drop(&mut self) {
        if !self.stopped {
            let _ = self.hosts.stop();
            let _ = self.os.stop();
        }
        self.peer.close();
    }
}
fn raw_contexts(state: &Value) -> Vec<&Value> {
    state["contexts"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|context| context["globals"].get(KEY).is_some())
        .collect()
}
fn token(state: &Value, target: &str) -> String {
    raw_contexts(state)
        .into_iter()
        .find(|context| context["targetId"] == target)
        .unwrap()["globals"][KEY]["documentToken"]
        .as_str()
        .unwrap()
        .into()
}
fn await_failed(request: &mut crate::cdp::QueuedCdpRequest) -> String {
    let deadline = Instant::now() + WAIT;
    loop {
        match request.try_response() {
            Err(error) => return error.to_string(),
            Ok(Some(result)) => panic!("retired page evaluation succeeded: {result:?}"),
            Ok(None) => {
                assert!(Instant::now() < deadline);
                thread::sleep(Duration::from_millis(5));
            }
        }
    }
}

#[test]
fn single_raw_host_owns_two_windows_navigation_new_targets_and_its_own_messages() {
    let mut f = RawFixture::start(false);
    let initial = f.inspect();
    assert_eq!(initial["sessions"].as_array().unwrap().len(), 2);
    assert!(initial["methods"].get("Page.createIsolatedWorld").is_none());
    assert!(
        initial["contexts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|context| context["name"] == ""
                && context["globals"].get("__codletRendererV1").is_none())
    );
    let a = token(&initial, "window-a");
    let b = token(&initial, "window-b");
    assert_eq!(
        f.call("window-a", json!({"message":"a"})),
        json!({"echo":{"message":"a"},"targetId":"window-a","generation":1})
    );
    assert_eq!(
        f.call("window-b", json!({"message":"b"}))["targetId"],
        "window-b"
    );
    f.peer
        .request("Fixture.navigate", json!({"targetId":"window-a"}));
    let navigated =
        f.until(|state| raw_contexts(state).len() == 2 && token(state, "window-a") != a);
    assert_eq!(token(&navigated, "window-b"), b);
    assert_eq!(f.call("window-a", json!("fresh"))["echo"], "fresh");
    f.peer
        .request("Fixture.addTarget", json!({"targetId":"window-c"}));
    f.until(|state| raw_contexts(state).len() == 3);
    assert_eq!(f.call("window-c", json!(3))["targetId"], "window-c");
    f.peer
        .request("Fixture.destroyTarget", json!({"targetId":"window-b"}));
    f.until(|state| state["sessions"].as_array().unwrap().len() == 2);
    assert_eq!(f.call("window-a", json!("survives"))["echo"], "survives");
    let stopped = f.stop(false);
    assert!(
        raw_contexts(&stopped).is_empty(),
        "normal plugin cleanup must dispose its page globals"
    );
}

#[test]
fn old_raw_page_waits_fail_on_document_retirement_and_stop_without_new_document_delivery() {
    let mut f = RawFixture::start(false);
    let old = token(&f.inspect(), "window-a");
    let mut pending = f.pending("window-a");
    f.until(|state| state["evaluations"] == 1);
    f.peer
        .request("Fixture.navigate", json!({"targetId":"window-a"}));
    assert!(await_failed(&mut pending).contains("destroyed"));
    f.until(|state| raw_contexts(state).len() == 2 && token(state, "window-a") != old);
    assert_eq!(
        f.call("window-a", json!("new request"))["echo"],
        "new request"
    );
    let mut pending = f.pending("window-b");
    f.until(|state| state["evaluations"] == 1);
    let state = f.stop(false);
    let error = await_failed(&mut pending);
    assert!(
        error.contains("closed") || error.contains("destroyed") || error.contains("ended"),
        "{error}"
    );
    assert!(raw_contexts(&state).is_empty());
}

#[test]
fn core_retires_owned_raw_sessions_even_when_plugin_cleanup_fails_without_claiming_page_rollback() {
    let mut f = RawFixture::start(true);
    assert_eq!(
        f.call("window-a", json!("before stop"))["echo"],
        "before stop"
    );
    let state = f.stop(true);
    let snapshot = f.hosts.execution_snapshot();
    assert!(
        snapshot
            .plugins
            .iter()
            .any(|plugin| plugin.cleanup.phase == HostCleanupPhase::Failed
                || plugin.exit.as_ref().is_some_and(|exit| exit.exit_code != 0))
    );
    assert_eq!(
        state["sessions"],
        json!([]),
        "Core must retire the raw sessions it recorded"
    );
    assert_eq!(
        raw_contexts(&state).len(),
        2,
        "failed plugin cleanup leaves its page effects; session retirement does not fabricate rollback"
    );
}
