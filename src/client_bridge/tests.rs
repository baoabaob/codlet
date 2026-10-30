//! Real scoped Host receipts with an owned Node main-process transport fixture.
//! No installed client, sandbox setup, model request or daily registry is used.
use super::*;
use crate::catalog::PluginCatalog;
use crate::cdp::CdpClient;
use crate::host_control::HostControl;
use crate::host_runtime::HostRuntime;
use crate::plugin_control::{
    PluginControlAction as Action, PluginControlOutcome as Outcome, PluginControlReport,
    PluginControlRequest,
};
use crate::plugins::{LocalPluginRegistration, Permission, PluginRegistry};
use crate::renderer::RendererRuntime;
use crate::runtime_control::{ControlBroker, ControlCompletion, ControlRequest, ControlStatus};
use crate::windows::process::{ChildProcess, launch_with_cdp_pipes};
use std::collections::BTreeSet;
use std::ffi::OsString;

const SOURCE: &str = "dev.fixture.source";
const DEPENDENT: &str = "dev.fixture.dependent";
const WAIT: Duration = Duration::from_secs(15);

fn protocol_source(port: u16, configuration: Value) -> (ClientSourceRuntime, TcpStream) {
    let directory = tempfile::tempdir().unwrap();
    let registry = directory.path().join("config.json");
    let services = crate::core_services::SharedCoreServices::new(&registry).unwrap();
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let lease = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let (retained, _) = listener.accept().unwrap();
    let source = ClientSourceRuntime(Arc::new(SourceOwner {
        endpoint: Endpoint {
            version: 1,
            host: "127.0.0.1".into(),
            port,
            token: "a".repeat(48),
            pid: 42,
            executable: "fixture".into(),
            kind: "browser".into(),
        },
        runtime: JsRuntime::discover().unwrap(),
        registry,
        directory,
        configuration,
        state: Mutex::new(State {
            epoch: 0,
            provider: None,
            startup_provider: None,
            admission: None,
            core_pending: None,
            #[cfg(all(windows, feature = "desktop-acceptance"))]
            fixture_route: None,
        }),
        startup: Mutex::new(None),
        startup_unsettled: AtomicBool::new(false),
        startup_observation: AtomicU8::new(0),
        retired: AtomicBool::new(false),
        lifecycle: Mutex::new(()),
        traffic: services.prepare_traffic().unwrap(),
        _lease: lease,
    }));
    (source, retained)
}

fn read_command(socket: &mut TcpStream) -> Value {
    socket.set_read_timeout(Some(WAIT)).unwrap();
    let mut bytes = Vec::new();
    let mut byte = [0];
    while byte[0] != b'\n' {
        socket.read_exact(&mut byte).unwrap();
        bytes.push(byte[0]);
    }
    serde_json::from_slice(&bytes).unwrap()
}

#[test]
fn skill_root_observation_pages_large_native_paths_and_rejects_mixed_authority() {
    let long_path = format!("C:/{}", "原生😀/".repeat(20_000));
    let chars: Vec<_> = long_path.chars().collect();
    let pieces: Vec<String> = chars
        .chunks(5000)
        .map(|part| part.iter().collect())
        .collect();
    let mut pages = Vec::new();
    for (index, text) in pieces.iter().enumerate() {
        pages.push(json!({"pid":42,"status":"observed","authorityId":"actual-child","revision":"7","provenance":"confirmed","rootCount":1,"fragments":[{"index":0,"text":text,"complete":index+1==pieces.len()}],"cursor":if index+1==pieces.len(){Value::Null}else{json!(format!("page.{}",index+1))}}));
    }
    let first = json!({"pid":42,"status":"observed","authorityId":"actual-child","revision":"7","provenance":"confirmed","rootCount":1,"fragments":[{"index":0,"text":"C:/","complete":false}],"cursor":"changed"});
    let second = json!({"pid":42,"status":"observed","authorityId":"different-child","revision":"7","provenance":"confirmed","rootCount":1,"fragments":[{"index":0,"text":"root","complete":true}],"cursor":null});
    let page_count = pages.len();
    pages.extend([first, second]);
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let peer = std::thread::spawn(move || {
        for response in pages {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(WAIT)).unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while byte[0] != b'\n' {
                socket.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            let command: Value = serde_json::from_slice(&request).unwrap();
            assert_eq!(command["op"], "skillRoots");
            assert_eq!(command["anchors"][0]["id"], "pending-native-request");
            let bytes = serde_json::to_vec(&json!({"ok":true,"result":response})).unwrap();
            assert!(bytes.len() < 65536);
            socket.write_all(&bytes).unwrap();
        }
        page_count
    });
    let (source, _retained_lease) = protocol_source(port, json!({}));
    let anchors = json!([{"id":"pending-native-request","method":"skills/list"}]);
    let observed = source
        .skill_roots_snapshot("current-client", 3, &anchors, None)
        .unwrap();
    assert_eq!(observed["roots"], json!([long_path]));
    assert_eq!(observed["provenance"], "confirmed");
    assert_eq!(
        source
            .skill_roots_snapshot("current-client", 3, &anchors, None)
            .unwrap_err()
            .code,
        "skill_roots_observation_changed"
    );
    assert!(peer.join().unwrap() > 16);
}

// Exercise the maintained Node control server and real ChildProcess stdio. In
// particular, do not manufacture the pid field as protocol_source() does.
struct NodeTransportFixture {
    source: ClientSourceRuntime,
    startup_provider: Option<LoadedPlugin>,
    peer: OwnedPluginProcess,
    stdio: PluginStdio,
    control_id: u64,
    stopped: bool,
    _directory: tempfile::TempDir,
}

impl NodeTransportFixture {
    fn new() -> Self {
        Self::with_ready_mode(false)
    }

    fn with_ready_mode(reject_ready: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let runtime = JsRuntime::discover().unwrap();
        let script = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/client-bridge-skill-roots.cjs");
        let (peer, stdio) = OwnedPluginProcess::spawn(
            runtime.executable_path(),
            &[
                script.to_string_lossy().into_owned(),
                "bundle".into(),
                if reject_ready {
                    "ready-reject".into()
                } else {
                    "normal".into()
                },
            ],
            directory.path(),
            None,
        )
        .unwrap();
        let observed = Self::read_line(&stdio);
        assert_eq!(observed["kind"], "endpoint");
        assert_eq!(observed["pid"], peer.pid());
        assert!(observed["childPid"].as_u64().is_some_and(|pid| pid > 0));
        let endpoint: Endpoint = serde_json::from_value(json!({
            "version":observed["version"],"host":observed["host"],"port":observed["port"],
            "token":observed["token"],"pid":observed["pid"],
            "executable":observed["executable"],"type":observed["type"]
        }))
        .unwrap();
        endpoint
            .validate(peer.pid(), runtime.executable_path())
            .unwrap();
        let registry = directory.path().join("registry.json");
        let startup_provider = reject_ready.then(|| {
            let root = directory.path().join("adapter");
            std::fs::create_dir(&root).unwrap();
            std::fs::write(root.join("codlet.json"), json!({"schema":1,"id":"dev.transport.fixture","version":"1","host":{"entry":"host.cjs"},"permissions":["host.process","cdp.raw"],"provides":[{"name":"codlet.client.launch","api":1,"scope":"runtime"}]}).to_string()).unwrap();
            std::fs::write(root.join("host.cjs"), "module.exports={clientSource(){return {code:'controlled'};}};").unwrap();
            let registration = LocalPluginRegistration { path: root.canonicalize().unwrap(), grants:vec![Permission::HostProcess, Permission::CdpRaw], ..Default::default() };
            let mut registry_data = PluginRegistry::load(&registry).unwrap();
            registry_data.register_local("dev.transport.fixture", registration.clone()).unwrap();
            registry_data.set_enabled("dev.transport.fixture", true).unwrap();
            registry_data.save().unwrap();
            crate::local_plugins::load_local_plugin_with_registration("dev.transport.fixture", &registration, 1).unwrap()
        });
        let services = crate::core_services::SharedCoreServices::new(&registry).unwrap();
        let source = ClientSourceRuntime::new(
            endpoint,
            runtime,
            registry,
            if reject_ready {
                json!({"source":{"operations":["http.intercept"],"protocols":["http"]}})
            } else {
                json!({})
            },
            startup_provider.clone(),
            services.prepare_traffic().unwrap(),
            Instant::now() + WAIT,
        )
        .unwrap();
        Self {
            source,
            startup_provider,
            peer,
            stdio,
            control_id: 0,
            stopped: false,
            _directory: directory,
        }
    }

    fn read_line(stdio: &PluginStdio) -> Value {
        let until = Instant::now() + WAIT;
        let mut bytes = Vec::new();
        loop {
            let mut byte = [0];
            assert_eq!(stdio.stdout.read_some(&mut byte, Some(until)).unwrap(), 1);
            if byte[0] == b'\n' {
                break;
            }
            bytes.push(byte[0]);
        }
        serde_json::from_slice(&bytes).unwrap()
    }

    fn control(&mut self, mut command: Value) {
        self.control_id += 1;
        command["id"] = json!(self.control_id);
        let action = command["action"].clone();
        let mut bytes = serde_json::to_vec(&command).unwrap();
        bytes.push(b'\n');
        self.stdio
            .stdin
            .write_all(&bytes, Instant::now() + WAIT)
            .unwrap();
        let reply = Self::read_line(&self.stdio);
        assert_eq!(reply["kind"], "control");
        assert_eq!(reply["id"], self.control_id);
        assert_eq!(reply["action"], action);
    }

    fn roots(&self, authority: Option<&str>) -> Result<Value, HostError> {
        self.source
            .skill_roots_snapshot("actual-rust-client", 1, &json!([]), authority)
    }

    fn close(mut self) {
        self.control(json!({"action":"stop"}));
        assert_eq!(self.peer.wait(WAIT).unwrap(), Some(0));
        self.source.retire();
        self.stopped = true;
    }
}

#[test]
fn actual_node_ready_rejection_is_a_valid_terminal_source_failure() {
    let fixture = NodeTransportFixture::with_ready_mode(true);
    assert_eq!(
        fixture
            .source
            .complete_startup(fixture.startup_provider.as_ref())
            .unwrap(),
        StartupObservation::Ready(false)
    );
    assert_eq!(
        fixture.source.cached_startup_observation(),
        StartupObservation::Ready(false)
    );
    let receipt = fixture
        .source
        .request(json!({"op":"status","operationId":STARTUP_OPERATION}))
        .unwrap();
    assert_eq!(receipt["outcome"], "applied");
    assert_eq!(receipt["sourceError"], "backend_route_timeout");
    assert_eq!(
        receipt["activation"],
        json!({"installed":false,"pending":false,"pendingSources":[],"activatedSources":[],"unsupportedSources":[{"id":"client-source","reason":"contract_unavailable"}]})
    );
    assert!(receipt["owner"].is_null());
    assert!(
        !serde_json::to_string(&receipt)
            .unwrap()
            .contains("private source payload")
    );
    assert_eq!(
        fixture
            .source
            .complete_startup(fixture.startup_provider.as_ref())
            .unwrap(),
        StartupObservation::Ready(false)
    );
    assert_eq!(
        fixture
            .source
            .request(json!({"op":"status","operationId":STARTUP_OPERATION}))
            .unwrap(),
        receipt
    );
    assert!(
        fixture.source.0.state.lock().unwrap().provider.is_none(),
        "the failed source must release its selected owner"
    );
    assert!(
        fixture
            .source
            .0
            .startup
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .failure
            .is_none(),
        "valid terminal metadata must not become an identity/schema rejection"
    );
    fixture.source.retire();
    assert_eq!(
        fixture.source.refresh_startup().unwrap_err().code,
        "client_bridge_retired"
    );
    assert_eq!(
        fixture.source.cached_startup_observation(),
        StartupObservation::Ready(false)
    );
    fixture.close();
}

#[test]
fn activation_diagnostics_report_static_fields_and_only_safe_source_error_codes() {
    let offer = json!({"operations":[],"protocols":[]});
    let invalid =
        json!({"installed":false,"activatedSources":[],"unsupportedSources":[],"pending":false});
    let failure =
        crate::client_launch::validate_client_source_activation(&invalid, &offer).unwrap_err();
    let diagnostic = activation_failure_diagnostic(
        &failure,
        &json!({"sourceError":"backend_route_timeout","endpoint":{"token":"private token"},"code":"private source"}),
    );
    assert!(diagnostic.contains("field=activation.pendingSources"));
    assert!(diagnostic.contains("category=missing_paired_field"));
    assert!(diagnostic.contains("sourceError=backend_route_timeout"));
    assert!(!diagnostic.contains("private"));
    for value in [
        json!("unsafe/path?token=private"),
        json!("line\nprivate"),
        json!("x".repeat(81)),
        json!({"private":true}),
    ] {
        let diagnostic = activation_failure_diagnostic(&failure, &json!({"sourceError":value}));
        assert!(diagnostic.contains("sourceError=redacted_invalid_code"));
        assert!(!diagnostic.contains("private"));
    }
}

impl Drop for NodeTransportFixture {
    fn drop(&mut self) {
        self.source.retire();
        if !self.stopped {
            let _ = self.peer.terminate();
            let _ = self.peer.wait(Duration::from_secs(2));
        }
    }
}

#[test]
fn actual_node_skill_facts_cross_the_authenticated_rust_boundary_without_losing_state() {
    let mut fixture = NodeTransportFixture::new();
    let absent = fixture.roots(None).unwrap();
    assert_eq!(absent["status"], "unobserved");
    assert_eq!(absent["reason"], "no_anchor");
    assert_eq!(absent["pid"], fixture.peer.pid());
    for fault in ["wrongIdentity", "missingIdentity"] {
        fixture.control(json!({"action":fault,"enabled":true}));
        assert_eq!(
            fixture.roots(None).unwrap_err().code,
            "client_bridge_identity_invalid"
        );
        fixture.control(json!({"action":fault,"enabled":false}));
    }
    fixture.control(json!({"action":"owner","disposed":false}));
    let fresh = fixture.roots(None).unwrap();
    assert_eq!(fresh["status"], "observed");
    assert_eq!(fresh["provenance"], "fresh");
    assert_eq!(fresh["roots"], json!([]));
    let authority = fresh["authorityId"].as_str().unwrap().to_owned();
    let long_root = format!("C:/{}", "Native原生😀/".repeat(20_000));
    let expected = json!([long_root, "C:/existing Native root"]);
    fixture.control(json!({"action":"set","requestId":"original-set","roots":expected}));
    let pending = fixture.roots(Some(&authority)).unwrap();
    assert_eq!(pending["status"], "unknown");
    assert_eq!(pending["reason"], "root_write_pending");
    assert_eq!(pending["pid"], fixture.peer.pid());
    fixture.control(json!({"action":"reply","requestId":"original-set"}));
    let confirmed = fixture.roots(Some(&authority)).unwrap();
    assert_eq!(confirmed["status"], "observed");
    assert_eq!(confirmed["provenance"], "confirmed");
    assert_eq!(confirmed["authorityId"], authority);
    assert_eq!(confirmed["roots"], expected);
    assert_ne!(confirmed["revision"], fresh["revision"]);
    for fault in ["wrongIdentity", "missingIdentity"] {
        fixture.control(json!({"action":fault,"enabled":true}));
        assert_eq!(
            fixture.roots(Some(&authority)).unwrap_err().code,
            "client_bridge_identity_invalid"
        );
        fixture.control(json!({"action":fault,"enabled":false}));
    }
    fixture.control(json!({"action":"set","requestId":"overlap-one","roots":["C:/one"]}));
    fixture.control(json!({"action":"set","requestId":"overlap-two","roots":["C:/two"]}));
    fixture.control(json!({"action":"reply","requestId":"overlap-one"}));
    fixture.control(json!({"action":"reply","requestId":"overlap-two"}));
    let unknown = fixture.roots(Some(&authority)).unwrap();
    assert_eq!(unknown["status"], "unknown");
    assert_eq!(unknown["reason"], "root_write_unknown");
    assert_eq!(unknown["pid"], fixture.peer.pid());
    fixture.control(json!({"action":"owner","disposed":true}));
    let stale_owner = fixture.roots(Some(&authority)).unwrap();
    assert_eq!(stale_owner["status"], "unobserved");
    assert_eq!(stale_owner["reason"], "owner_not_current");
    fixture.control(json!({"action":"retire"}));
    let retired = fixture.roots(Some(&authority)).unwrap();
    assert_eq!(retired["status"], "retired");
    assert_eq!(retired["authorityId"], authority);
    fixture.close();
}

#[test]
fn actual_node_official_update_receipts_keep_server_identity_and_one_controlled_install() {
    let mut fixture = NodeTransportFixture::new();
    let target = fixture.source.official_update_target().unwrap();
    assert_eq!(
        target["target"],
        json!({"id":"c".repeat(64),"version":"0.0.0"})
    );
    assert!(target["reason"].is_null());
    assert!(target["installation"].is_null());
    assert_eq!(target["fixtureCalls"], 0);
    assert_eq!(target["pid"], fixture.peer.pid());
    assert_eq!(target["executable"], fixture.source.0.endpoint.executable);
    assert_eq!(target["type"], "browser");
    for fault in ["wrongIdentity", "missingIdentity"] {
        fixture.control(json!({"action":fault,"enabled":true}));
        assert_eq!(
            fixture.source.official_update_target().unwrap_err().code,
            "client_bridge_identity_invalid"
        );
        fixture.control(json!({"action":fault,"enabled":false}));
    }
    let operation = "controlled-original-install";
    let unknown = fixture
        .source
        .request(json!({"op":"status","operationId":operation}))
        .unwrap();
    assert_eq!(unknown["unknown"], true);
    assert_eq!(unknown["pending"], false);
    let source = fixture.source.clone();
    let installing =
        std::thread::spawn(move || source.install_official_update(operation, &"c".repeat(64)));
    let until = Instant::now() + WAIT;
    loop {
        let receipt = fixture
            .source
            .request(json!({"op":"status","operationId":operation}))
            .unwrap();
        if receipt["pending"] == true {
            break;
        }
        assert_eq!(receipt["unknown"], true);
        assert!(
            Instant::now() < until,
            "the controlled install did not enter its original operation"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let duplicate = fixture
        .source
        .request(
            json!({"op":"officialUpdateInstall","operationId":operation,"targetId":"c".repeat(64)}),
        )
        .unwrap();
    assert_eq!(duplicate["pending"], true);
    assert_eq!(duplicate["pid"], fixture.peer.pid());
    assert_eq!(
        fixture.source.official_update_target().unwrap()["fixtureCalls"],
        1
    );
    fixture.control(json!({"action":"finishUpdate"}));
    let installed = installing.join().unwrap().unwrap();
    assert_eq!(installed["accepted"], true);
    assert_eq!(installed["target"], target["target"]);
    assert_eq!(installed["pid"], fixture.peer.pid());
    let repeated = fixture
        .source
        .install_official_update(operation, &"c".repeat(64))
        .unwrap();
    assert_eq!(repeated["accepted"], true);
    assert_eq!(repeated["target"], target["target"]);
    assert_eq!(
        fixture.source.official_update_target().unwrap()["fixtureCalls"],
        1
    );
    fixture.close();
}

#[test]
fn startup_connection_loss_preserves_the_original_operation_and_lease() {
    for code in ["client_bridge_disconnected", "client_bridge_uncertain"] {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let (source, mut lease) = protocol_source(
            listener.local_addr().unwrap().port(),
            json!({"source":{"operations":[],"protocols":[]}}),
        );
        source.0.startup_unsettled.store(true, Ordering::Release);
        {
            let mut guard = source.0.startup.lock().unwrap();
            let startup = guard.insert(Startup {
                provider: None,
                dispatched: true,
                receipt: None,
                failure: None,
            });
            assert_eq!(
                source
                    .observe_startup(startup, Instant::now() + WAIT, Some(Err(error(code))))
                    .unwrap(),
                StartupObservation::Pending
            );
            assert!(startup.dispatched);
            assert!(startup.failure.is_none());
        }
        assert_eq!(
            source.cached_startup_observation(),
            StartupObservation::Pending
        );
        lease.set_nonblocking(true).unwrap();
        assert_eq!(
            lease.read(&mut [0]).unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock,
            "an uncertain observation must retain the Native lease"
        );
        lease.set_nonblocking(false).unwrap();
        let peer = std::thread::spawn(move || {
            for operation_id in [Some(STARTUP_OPERATION), None] {
                let (mut socket, _) = listener.accept().unwrap();
                let command = read_command(&mut socket);
                assert_eq!(command["op"], "status", "readiness must not be replayed");
                assert_eq!(command["operationId"].as_str(), operation_id);
                socket.write_all(serde_json::to_string(&json!({"ok":true,"result":{"pid":42,"outcome":"applied","epoch":0,"owner":null,"generation":null,"activation":{"installed":false,"activatedSources":[],"unsupportedSources":[]}}})).unwrap().as_bytes()).unwrap();
            }
        });
        assert_eq!(
            source.complete_startup(None).unwrap(),
            StartupObservation::Ready(false)
        );
        assert!(!source.0.startup_unsettled.load(Ordering::Acquire));
        assert!(!source.0.retired.load(Ordering::Acquire));
        source.retire();
        lease.set_read_timeout(Some(WAIT)).unwrap();
        assert_eq!(lease.read(&mut [0]).unwrap(), 0);
        peer.join().unwrap();
    }
}

#[test]
fn malformed_startup_contract_is_terminal_and_never_replays_ready() {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let (source, mut lease) = protocol_source(
        listener.local_addr().unwrap().port(),
        json!({"source":{"operations":["http.intercept"],"protocols":["http"]}}),
    );
    let peer = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let command = read_command(&mut socket);
        assert_eq!(command["op"], "ready");
        assert_eq!(command["operationId"], STARTUP_OPERATION);
        socket.write_all(serde_json::to_string(&json!({"ok":true,"result":{"pid":42,"outcome":"applied","epoch":0,"owner":null,"generation":null,"activation":{"installed":true,"activatedSources":[{"id":"unowned","operations":["http.intercept"],"protocols":["http"],"coverage":["unowned"]}],"unsupportedSources":[]}}})).unwrap().as_bytes()).unwrap();
    });
    assert_eq!(
        source.complete_startup(None).unwrap_err().code,
        "client_bridge_protocol"
    );
    assert_eq!(
        source.complete_startup(None).unwrap_err().code,
        "client_bridge_protocol"
    );
    assert_eq!(
        source.refresh_startup().unwrap_err().code,
        "client_bridge_protocol"
    );
    assert_eq!(
        source.cached_startup_observation(),
        StartupObservation::Ready(false)
    );
    lease.set_read_timeout(Some(WAIT)).unwrap();
    assert_eq!(lease.read(&mut [0]).unwrap(), 0);
    peer.join().unwrap();
}

#[test]
fn retiring_the_native_owner_rejects_an_inflight_late_startup_observation() {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let (source, mut lease) = protocol_source(
        listener.local_addr().unwrap().port(),
        json!({"source":{"operations":[],"protocols":[]}}),
    );
    let (observing, observed) = std::sync::mpsc::channel();
    let (resume, resumed) = std::sync::mpsc::channel();
    let peer = std::thread::spawn(move || {
        for operation in ["ready", "status"] {
            let (mut socket, _) = listener.accept().unwrap();
            assert_eq!(read_command(&mut socket)["op"], operation);
            if operation == "status" {
                observing.send(()).unwrap();
                resumed.recv_timeout(WAIT).unwrap();
            }
            socket.write_all(serde_json::to_string(&json!({"ok":true,"result":{"pid":42,"outcome":"applied","epoch":0,"owner":null,"generation":null,"activation":{"installed":false,"activatedSources":[],"unsupportedSources":[]}}})).unwrap().as_bytes()).unwrap();
        }
    });
    let completing = source.clone();
    let completion = std::thread::spawn(move || completing.complete_startup(None));
    observed.recv_timeout(WAIT).unwrap();
    source.retire();
    resume.send(()).unwrap();
    assert_eq!(
        completion.join().unwrap().unwrap_err().code,
        "client_bridge_retired"
    );
    assert_eq!(
        source.cached_startup_observation(),
        StartupObservation::Ready(false)
    );
    assert!(
        source
            .0
            .startup
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .receipt
            .is_some()
    );
    lease.set_read_timeout(Some(WAIT)).unwrap();
    assert_eq!(lease.read(&mut [0]).unwrap(), 0);
    peer.join().unwrap();
}

#[test]
fn core_module_preflight_checks_factory_syntax_without_evaluating_candidate_code() {
    let fixture = Fixture::new(false);
    let root = fixture.directory.path();
    let expression = root.join("renderer-bootstrap.js");
    let commonjs = root.join("host-bootstrap.cjs");
    let marker = root.join("preflight-executed.marker");
    let effect = format!(
        "require('node:fs').writeFileSync({},'executed')",
        serde_json::to_string(&marker.to_string_lossy()).unwrap()
    );
    std::fs::write(
        &expression,
        format!("(()=>{{{effect};return()=>{{}};}})()\n// no final newline"),
    )
    .unwrap();
    std::fs::write(&commonjs, format!("{effect};module.exports={{}};")).unwrap();
    fixture
        .source
        .check_core_module_syntax(&[expression.clone(), commonjs])
        .unwrap();
    assert!(
        !marker.exists(),
        "preflight must only compile candidate bytes"
    );
    // Valid standalone JS, invalid where a renderer factory value is required.
    std::fs::write(&expression, "const factory=()=>{};module.exports=factory;").unwrap();
    assert_eq!(
        fixture
            .source
            .check_core_module_syntax(&[expression])
            .unwrap_err()
            .code,
        "core_module_syntax_invalid"
    );
    assert!(!marker.exists());
}

fn source_host(revision: &str, fail: bool) -> String {
    let code = format!(
        r#"module.exports={{installElectronTraffic(){{
        {}
        return {{ready:async()=>({{installed:true,activatedSources:[{{id:'fixture-main',operations:['http.intercept'],protocols:['http'],coverage:[{}]}}],unsupportedSources:[]}}),close(){{}}}};
    }}}};"#,
        if fail {
            "throw Object.assign(Error(),{code:'fixture_activation_failed'});"
        } else {
            ""
        },
        serde_json::to_string(revision).unwrap()
    );
    host_for_code(&code)
}
fn host_for_code(code: &str) -> String {
    format!(
        r#"module.exports={{
      prepareClientLaunch:()=>({{arguments:['--inspect-brk=127.0.0.1:0']}}),
      attachClientLaunch:()=>({{}}),
      clientSource:()=>({{code:{}}}),
      activate(ctx){{ctx.rpc.provide({{name:'dev.fixture.desktop',api:1,scope:'runtime'}},'inspect',()=>({{ready:true}}));}},
      deactivate(){{}}
    }};"#,
        serde_json::to_string(code).unwrap()
    )
}

struct Fixture {
    hosts: HostRuntime,
    control: HostControl,
    broker: ControlBroker,
    renderer: RendererRuntime,
    source: ClientSourceRuntime,
    peer: OwnedPluginProcess,
    client: CdpClient,
    child: ChildProcess,
    _services: crate::core_services::SharedCoreServices,
    directory: tempfile::TempDir,
    registry: PathBuf,
}
impl Fixture {
    fn new(suspended: bool) -> Self {
        Self::new_with_lease_delay(suspended, 0)
    }
    fn new_with_lease_delay(suspended: bool, lease_delay_ms: u64) -> Self {
        Self::new_with_options(suspended, lease_delay_ms, false)
    }
    fn new_with_options(suspended: bool, lease_delay_ms: u64, initial_source: bool) -> Self {
        Self::new_with_reply_stall(suspended, lease_delay_ms, initial_source, 0)
    }
    fn new_with_reply_stall(
        suspended: bool,
        lease_delay_ms: u64,
        initial_source: bool,
        ready_stall_ms: u64,
    ) -> Self {
        Self::new_with_startup_mode(
            suspended,
            lease_delay_ms,
            initial_source,
            ready_stall_ms,
            false,
        )
    }
    fn new_with_startup_mode(
        suspended: bool,
        lease_delay_ms: u64,
        initial_source: bool,
        ready_stall_ms: u64,
        late_activation: bool,
    ) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let registry_path = directory.path().join("state/config.json");
        let mut registry = PluginRegistry::load(&registry_path).unwrap();
        for id in ["codlet-gui", "codex.ui.adapter"] {
            registry.set_enabled(id, false).unwrap();
        }
        for id in [SOURCE, DEPENDENT] {
            let root = directory.path().join(id);
            std::fs::create_dir(&root).unwrap();
            let declaration = if id == SOURCE {
                json!({"schema":1,"id":id,"version":"1","host":{"entry":"host.cjs"},"permissions":["host.process","cdp.raw"],"provides":[{"name":"codlet.client.launch","api":1,"scope":"runtime"},{"name":"dev.fixture.desktop","api":1,"scope":"runtime"}]})
            } else {
                json!({"schema":1,"id":id,"version":"1","host":{"entry":"host.cjs"},"permissions":["host.process","cdp.raw"],"requires":[{"name":"dev.fixture.desktop","api":1,"scope":"runtime"}]})
            };
            std::fs::write(root.join("codlet.json"), declaration.to_string()).unwrap();
            std::fs::write(
                root.join("host.cjs"),
                if id == SOURCE {
                    source_host("fixture-one", false)
                } else {
                    "module.exports={activate(){},deactivate(){}};".into()
                },
            )
            .unwrap();
            registry
                .register_local(
                    id,
                    LocalPluginRegistration {
                        path: root.canonicalize().unwrap(),
                        grants: vec![Permission::HostProcess, Permission::CdpRaw],
                        ..Default::default()
                    },
                )
                .unwrap();
            registry.set_enabled(id, suspended).unwrap();
        }
        registry.save().unwrap();
        let mut catalog = PluginCatalog::load(&registry).unwrap();
        if suspended {
            catalog.suspend_startup(
                &BTreeSet::from([SOURCE.into(), DEPENDENT.into()]),
                "client_source_build_unverified",
            );
        }
        let mut renderer = RendererRuntime::from_catalog(catalog, registry).unwrap();
        let distribution = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_owned();
        let runtime = JsRuntime::from_distribution(&distribution).unwrap();
        let (child, pipes) = launch_with_cdp_pipes(
            &distribution.join("codlet-fake-child.exe"),
            &[OsString::from("--scenario=raw-host-cdp")],
            true,
        )
        .unwrap();
        let (client, events) = CdpClient::spawn(pipes).unwrap();
        drop(events);
        let hosts =
            HostRuntime::start_with_runtime(Vec::new(), client.clone(), Some(runtime.clone()))
                .unwrap();
        renderer.set_host_capability_client(hosts.capability_client());

        std::fs::write(
            directory.path().join("bridge.cjs"),
            include_str!("../../runtime/client-bridge-bundle.cjs"),
        )
        .unwrap();
        let peer_file = directory.path().join("peer.cjs");
        std::fs::write(&peer_file, format!(r#"
          process.type='browser';let ready=false,replyStalled=false;
          const socket=require('node:net').Socket.prototype,write=socket.write,end=socket.end;
          socket.write=function(bytes,...args){{
            let value;try{{value=JSON.parse(bytes);}}catch{{}}
            if(value?.result?.leased===true&&{lease_delay_ms}>0){{setTimeout(()=>write.call(this,bytes,...args),{lease_delay_ms});return true;}}
            return write.call(this,bytes,...args);
          }};
          socket.end=function(bytes,...args){{
            let value;try{{value=JSON.parse(bytes);}}catch{{}}
            if(value?.result?.outcome==='applied'&&value.result.epoch===0&&{ready_stall_ms}>0&&!replyStalled){{replyStalled=true;require('node:fs').writeFileSync(require('node:path').join(__dirname,'startup-stall.marker'),'applied');const until=Date.now()+{ready_stall_ms};while(Date.now()<until){{}}}}
            return end.call(this,bytes,...args);
          }};
          const bridge=require('./bridge.cjs').startClientBridge({{app:{{isReady:()=>ready,getAppPath:()=>__dirname}}}},{{token:'a'.repeat(48)}});
          if({initial_source}){{
            const file=require('node:path').join(__dirname,'connected.marker');
            let code=require('./dev.fixture.source/host.cjs').clientSource().code;
            const calls=require('node:path').join(__dirname,'startup-ready.calls');
            if({late_activation}){{
              code='const fs=require("node:fs"),file='+JSON.stringify(file)+',calls='+JSON.stringify(calls)+';const activation=()=>fs.existsSync(file)?{{installed:true,activatedSources:[{{id:"fixture-main",operations:["http.intercept"],protocols:["http"],coverage:["late-native-hook"]}}],unsupportedSources:[],pending:false,pendingSources:[]}}:{{installed:false,activatedSources:[],unsupportedSources:[],pending:true,pendingSources:[{{id:"fixture-main",reason:"initializing"}}]}};module.exports={{installElectronTraffic(){{return {{ready:async()=>{{fs.appendFileSync(calls,"ready\\n");return activation();}},inspect:()=>({{activation:activation()}}),close(){{}}}};}}}};';
            }}else{{
              code+='\nconst original=module.exports.installElectronTraffic;module.exports.installElectronTraffic=(...args)=>{{const runtime=original(...args);return {{...runtime,ready:async()=>{{const fs=require("node:fs");fs.appendFileSync('+JSON.stringify(calls)+',"ready\\n");while(!fs.existsSync('+JSON.stringify(file)+'))await new Promise(resolve=>setTimeout(resolve,10));return runtime.ready();}}}};}};';
            }}
            bridge.installInitial({{owner:'dev.fixture.source',generation:1,code,configuration:{{}}}}).catch(()=>{{}});
          }}
          ready=true;bridge.endpoint().then(endpoint=>process.stdout.write(JSON.stringify(endpoint)+'\n'));
        "#)).unwrap();
        let (peer, stdio) = OwnedPluginProcess::spawn(
            runtime.executable_path(),
            &[peer_file.to_string_lossy().into_owned()],
            directory.path(),
            None,
        )
        .unwrap();
        let mut data = Vec::new();
        let mut buffer = [0; 4096];
        let until = Instant::now() + WAIT;
        while data.last() != Some(&b'\n') {
            let count = stdio.stdout.read_some(&mut buffer, Some(until)).unwrap();
            assert!(count > 0 && data.len() + count < 65536);
            data.extend_from_slice(&buffer[..count]);
        }
        let endpoint: Endpoint = serde_json::from_slice(&data).unwrap();
        endpoint
            .validate(peer.pid(), runtime.executable_path())
            .unwrap();
        let services = crate::core_services::SharedCoreServices::new(&registry_path).unwrap();
        let source = ClientSourceRuntime::new(
            endpoint,
            runtime,
            registry_path.clone(),
            json!({"source":{"operations":["http.intercept"],"protocols":["http"]}}),
            None,
            services.prepare_traffic().unwrap(),
            Instant::now() + WAIT,
        )
        .unwrap();
        renderer.set_client_source(Some(source.clone()));
        let broker = ControlBroker::new([31; 16], "f".repeat(64));
        broker.set_ready();
        Self {
            hosts,
            control: HostControl::new(registry_path.clone()),
            broker,
            renderer,
            source,
            peer,
            client,
            child,
            _services: services,
            directory,
            registry: registry_path,
        }
    }
    fn rewrite(&self, revision: &str, fail: bool) {
        std::fs::write(
            self.directory.path().join(SOURCE).join("host.cjs"),
            source_host(revision, fail),
        )
        .unwrap();
    }
    fn inspect(&self) -> Value {
        self.source.request(json!({"op":"status"})).unwrap()
    }
    fn command(&mut self, action: Action, permission: Option<Permission>) -> PluginControlReport {
        let prepared = self
            .broker
            .handle(ControlRequest::prepare(PluginControlRequest {
                action,
                plugin_id: SOURCE.into(),
                permission,
                cascade: action == Action::Disable,
                remove_source: None,
                local_import: None,
            }));
        assert_eq!(prepared.status, ControlStatus::Prepared);
        let receipt = prepared.operation_id().unwrap().to_owned();
        assert_eq!(
            self.broker.handle(ControlRequest::submit(&receipt)).status,
            ControlStatus::Queued
        );
        let until = Instant::now() + WAIT;
        loop {
            self.renderer
                .set_external_observations(self.hosts.observations());
            self.renderer.pump_bindings().unwrap();
            self.control
                .poll(&mut self.renderer, &self.hosts, &self.broker);
            if !self.control.is_pending()
                && let Some(job) = self.broker.take_next()
            {
                assert!(
                    self.control
                        .dispatch(job, &mut self.renderer, &self.hosts, &self.broker)
                        .is_none()
                );
            }
            let result = self.broker.handle(ControlRequest::result(&receipt));
            if result.status == ControlStatus::Completed {
                return match result.operation.unwrap().completion.unwrap() {
                    ControlCompletion::Report { report } => report,
                    ControlCompletion::Error { error } => panic!("receipt failed: {error:?}"),
                };
            }
            assert!(
                Instant::now() < until,
                "pending lifecycle: {:?}",
                self.hosts.observations()
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.hosts.stop();
        let _ = self.client.shutdown();
        let _ = self.child.wait(WAIT);
        let _ = self.peer.terminate();
        let _ = self.peer.wait(Duration::from_secs(2));
    }
}

#[test]
fn startup_ready_recovers_the_original_receipt_after_a_slow_native_main_loop() {
    let fixture = Fixture::new_with_reply_stall(false, 0, false, 35_000);
    let pid = fixture.peer.pid();
    let result = fixture.source.complete_startup(None);
    assert!(
        fixture
            .directory
            .path()
            .join("startup-stall.marker")
            .is_file()
    );
    assert_eq!(result.unwrap(), StartupObservation::Ready(false));
    let receipt = fixture
        .source
        .request(json!({"op":"status","operationId":"startup-ready"}))
        .unwrap();
    assert_eq!(receipt["outcome"], "applied");
    assert_eq!(receipt["pid"], pid);
    assert_eq!(receipt["epoch"], 0);
}

#[test]
fn bridge_request_honors_the_total_deadline_while_native_is_stalled() {
    let fixture = Fixture::new_with_reply_stall(false, 0, false, 35_000);
    let started = Instant::now();
    let failure = fixture
        .source
        .request_until(
            json!({"op":"ready","operationId":"bounded-startup","expectedEpoch":0}),
            started + Duration::from_millis(200),
        )
        .unwrap_err();
    assert_eq!(failure.code, "client_bridge_uncertain");
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(
        fixture
            .directory
            .path()
            .join("startup-stall.marker")
            .is_file()
    );
}

#[test]
fn main_entry_follows_enable_reload_rollback_disable_and_permission_revocation_receipts() {
    let mut f = Fixture::new(false);
    let pid = f.peer.pid();
    assert_eq!(f.command(Action::Enable, None).outcome, Outcome::Applied);
    assert_eq!(f.inspect()["owner"], SOURCE);
    f.rewrite("fixture-two", false);
    assert_eq!(f.command(Action::Reload, None).outcome, Outcome::Applied);
    assert_eq!(
        f.inspect()["activation"]["activatedSources"][0]["coverage"],
        json!(["fixture-two"])
    );
    f.rewrite("fixture-broken", true);
    let failed = f.command(Action::Reload, None);
    assert_eq!(failed.outcome, Outcome::RolledBack, "{failed:?}");
    assert_eq!(
        f.inspect()["activation"]["activatedSources"][0]["coverage"],
        json!(["fixture-two"])
    );
    assert_eq!(f.command(Action::Disable, None).outcome, Outcome::Applied);
    assert!(f.inspect()["owner"].is_null());
    f.rewrite("fixture-three", false);
    assert_eq!(f.command(Action::Enable, None).outcome, Outcome::Applied);
    assert_eq!(
        f.command(Action::Revoke, Some(Permission::CdpRaw)).outcome,
        Outcome::Applied
    );
    assert!(f.inspect()["owner"].is_null());
    assert_eq!(f.inspect()["pid"], pid);
    assert!(
        !PluginRegistry::load(&f.registry).unwrap().local_plugins()[SOURCE]
            .grants
            .contains(&Permission::CdpRaw)
    );
}

#[test]
fn a_degraded_startup_recovers_the_source_and_dependent_closure_in_the_same_client() {
    let mut f = Fixture::new(true);
    let before = std::fs::read(&f.registry).unwrap();
    let pid = f.peer.pid();
    assert!(f.renderer.logical_plugins().is_empty());
    let report = f.command(Action::Reload, None);
    assert_eq!(report.outcome, Outcome::Applied, "{report:?}");
    assert_eq!(
        report.affected_plugin_ids,
        BTreeSet::from([SOURCE.to_owned(), DEPENDENT.to_owned()])
            .into_iter()
            .collect::<Vec<_>>()
    );
    assert_eq!(f.renderer.logical_plugins().len(), 2);
    assert!(!f.renderer.startup_suspended(SOURCE));
    assert!(!f.renderer.startup_suspended(DEPENDENT));
    assert_eq!(std::fs::read(&f.registry).unwrap(), before);
    assert_eq!(f.inspect()["pid"], pid);
}

#[test]
fn authority_changed_during_activation_retires_the_main_entry_and_preserves_the_bridge() {
    let f = Fixture::new(false);
    let code = format!(
        r#"module.exports={{installElectronTraffic(){{
      const fs=require('node:fs'),file={};const registry=JSON.parse(fs.readFileSync(file,'utf8'));
      registry.localPlugins[{}].grants=registry.localPlugins[{}].grants.filter(grant=>grant!=='cdp.raw');
      fs.writeFileSync(file,JSON.stringify(registry));
      return {{ready:async()=>({{installed:true,activatedSources:[{{id:'fixture-main',operations:['http.intercept'],protocols:['http'],coverage:['fixture-revoked']}}],unsupportedSources:[]}}),close(){{}}}};
    }}}};"#,
        serde_json::to_string(&f.registry).unwrap(),
        serde_json::to_string(SOURCE).unwrap(),
        serde_json::to_string(SOURCE).unwrap()
    );
    let root = f.directory.path().join(SOURCE);
    std::fs::write(root.join("host.cjs"), host_for_code(&code)).unwrap();
    let registry = PluginRegistry::load(&f.registry).unwrap();
    let provider = crate::local_plugins::load_local_plugin_with_registration(
        SOURCE,
        &registry.local_plugins()[SOURCE],
        1,
    )
    .unwrap();
    assert_eq!(
        f.source.replace(Some(&provider)).unwrap_err().code,
        "client_launch_authorization_revoked"
    );
    assert!(f.inspect()["owner"].is_null());
    assert_eq!(f.inspect()["pid"], f.peer.pid());
    assert_eq!(f.inspect()["activation"]["installed"], false);
}

#[test]
fn startup_lease_survives_a_native_reply_delayed_beyond_two_seconds() {
    let f = Fixture::new_with_lease_delay(false, 2300);
    assert_eq!(f.inspect()["pid"], f.peer.pid());
    assert!(f.inspect()["owner"].is_null());
}

#[test]
fn startup_source_is_confirmed_only_after_the_native_connection_can_initialize() {
    let f = Fixture::new_with_options(true, 0, true);
    assert_eq!(f.inspect()["owner"], SOURCE);
    assert_eq!(f.inspect()["activation"]["installed"], false);
    std::fs::write(
        f.directory.path().join("connected.marker"),
        "native-connected",
    )
    .unwrap();
    let registry = PluginRegistry::load(&f.registry).unwrap();
    let provider = crate::local_plugins::load_local_plugin_with_registration(
        SOURCE,
        &registry.local_plugins()[SOURCE],
        1,
    )
    .unwrap();
    assert_eq!(
        f.source.complete_startup(Some(&provider)).unwrap(),
        StartupObservation::Ready(true)
    );
    assert_eq!(f.inspect()["activation"]["installed"], true);
    assert_eq!(f.inspect()["pid"], f.peer.pid());
    f.source.replace(None).unwrap();
    assert!(f.inspect()["owner"].is_null());
}

#[test]
fn pending_startup_keeps_one_ready_invocation_and_later_confirms_the_same_native_owner() {
    startup_pending_case(false);
}

#[test]
fn a_terminal_ready_receipt_tracks_late_activation_without_reinitializing_native() {
    startup_pending_case(true);
}

fn startup_pending_case(late_activation: bool) {
    let f = Fixture::new_with_startup_mode(true, 0, true, 0, late_activation);
    let registry = PluginRegistry::load(&f.registry).unwrap();
    let provider = crate::local_plugins::load_local_plugin_with_registration(
        SOURCE,
        &registry.local_plugins()[SOURCE],
        1,
    )
    .unwrap();
    let pid = f.peer.pid();
    let first = f
        .source
        .complete_startup_until(Some(&provider), Instant::now() + Duration::from_millis(200))
        .unwrap();
    assert_eq!(first, StartupObservation::Pending);
    assert_eq!(
        f.source.cached_startup_observation(),
        StartupObservation::Pending
    );
    assert!(
        f.source
            .0
            .startup
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .dispatched
    );
    assert_eq!(
        f.source
            .0
            .startup
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .receipt
            .is_some(),
        late_activation
    );
    let before = Instant::now();
    assert_eq!(
        f.source.complete_startup(Some(&provider)).unwrap(),
        StartupObservation::Pending
    );
    assert!(
        before.elapsed() < Duration::from_secs(1),
        "repeated completion only observes the original receipt"
    );
    let calls = f.directory.path().join("startup-ready.calls");
    assert_eq!(std::fs::read_to_string(&calls).unwrap().lines().count(), 1);
    std::fs::write(f.directory.path().join("connected.marker"), "connected").unwrap();
    let until = Instant::now() + WAIT;
    loop {
        match f.source.refresh_startup().unwrap() {
            StartupObservation::Ready(true) => break,
            StartupObservation::Pending => {}
            other => panic!("unexpected startup observation: {other:?}"),
        }
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        f.source.cached_startup_observation(),
        StartupObservation::Ready(true)
    );
    assert_eq!(std::fs::read_to_string(calls).unwrap().lines().count(), 1);
    assert_eq!(f.inspect()["pid"], pid);
    assert_eq!(f.inspect()["owner"], SOURCE);
    f.source.retire();
    assert_eq!(
        f.source.cached_startup_observation(),
        StartupObservation::Ready(false)
    );
    assert_eq!(
        f.source.refresh_startup().unwrap_err().code,
        "client_bridge_retired"
    );
}

#[test]
fn startup_lease_deadline_is_total_and_malformed_or_wrong_identity_replies_are_rejected() {
    for (drip, response, expected) in [
        (
            true,
            "{\"ok\":true,\"result\":{\"leased\":true,\"pid\":42}}\n",
            "client_bridge_lease_timeout",
        ),
        (false, "invalid\n", "client_bridge_protocol"),
        (
            false,
            "{\"ok\":true,\"result\":{\"leased\":true,\"pid\":43}}\n",
            "client_bridge_identity_invalid",
        ),
    ] {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let endpoint = Endpoint {
            version: 1,
            host: "127.0.0.1".into(),
            port: listener.local_addr().unwrap().port(),
            token: "a".repeat(48),
            pid: 42,
            executable: "owned-fixture".into(),
            kind: "browser".into(),
        };
        let peer = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut byte = [0];
            loop {
                socket.read_exact(&mut byte).unwrap();
                if byte[0] == b'\n' {
                    break;
                }
            }
            if drip {
                for byte in response.as_bytes() {
                    if socket.write_all(&[*byte]).is_err() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
            } else {
                let _ = socket.write_all(response.as_bytes());
            }
        });
        let started = Instant::now();
        let failure = acquire_lease(&endpoint, started + Duration::from_millis(150)).unwrap_err();
        assert_eq!(failure.code, expected);
        assert!(started.elapsed() < Duration::from_secs(1));
        peer.join().unwrap();
    }
}
