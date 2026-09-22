use super::*;
use crate::plugins::{LocalPluginRegistration, Permission};
use std::io::{Read, Write};
use std::net::TcpStream;

struct Fixture {
    services: SharedCoreServices,
    traffic: Traffic,
    registry: PathBuf,
    _directory: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let registry_path = directory.path().join("registry.json");
        let mut registry = PluginRegistry::load(&registry_path).unwrap();
        let mut plugins = Vec::new();
        for (id, sensitive) in [("test.traffic-a", false), ("test.traffic-b", true)] {
            let root = directory.path().join(id);
            std::fs::create_dir(&root).unwrap();
            let root = root.canonicalize().unwrap();
            let mut permissions = vec![
                Permission::HostProcess,
                Permission::HostNetwork,
                Permission::TrafficIntercept,
            ];
            if sensitive {
                permissions.extend([
                    Permission::TrafficSensitiveHeaders,
                    Permission::TrafficRedirect,
                ]);
            }
            std::fs::write(root.join("host.js"), "exports.activate=()=>{};").unwrap();
            std::fs::write(root.join("codlet.json"), json!({"schema":1,"id":id,"version":"1","host":{"entry":"host.js"},"permissions":permissions,"requires":[{"name":"codlet.core.services","api":1,"scope":"runtime"}]}).to_string()).unwrap();
            let registration = LocalPluginRegistration {
                path: root,
                grants: permissions,
                broker_policy: crate::plugin_permissions::BrokerPolicy {
                    network_origins: vec![
                        "https://allowed.invalid".into(),
                        "https://alternate.invalid".into(),
                    ],
                    ..Default::default()
                },
            };
            registry.register_local(id, registration.clone()).unwrap();
            registry.set_enabled(id, true).unwrap();
            plugins.push(
                crate::local_plugins::load_local_plugin_with_registration(id, &registration, 1)
                    .unwrap(),
            );
        }
        registry.save().unwrap();
        let services = SharedCoreServices::new(&registry_path).unwrap();
        services.register(&plugins).unwrap();
        let traffic = services.prepare_traffic().unwrap();
        Self {
            services,
            traffic,
            registry: registry_path,
            _directory: directory,
        }
    }
    fn invoke(&self, id: &str, method: &str, params: Value, host: bool) -> Result<Value> {
        let principal = self
            .services
            .0
            .owners
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| error("stale_generation", "owner retired"))?;
        self.services
            .check(&principal, &format!("traffic.{method}"), host, &params)?;
        let weak = Arc::downgrade(&self.services.0);
        let captured = principal.clone();
        self.traffic.invoke(
            &principal,
            method,
            params,
            Arc::new(move |action, target| {
                SharedCoreServices(
                    weak.upgrade()
                        .ok_or_else(|| error("runtime_stopped", "Core stopped"))?,
                )
                .traffic_check(&captured, action, target)
            }),
        )
    }
    fn host(&self, id: &str) -> Wire {
        Wire::new(self.invoke(id, "connect", json!({}), true).unwrap())
    }
    fn registration(&self, id: &str) -> String {
        self.invoke(id,"register",json!({"id":"fixture","origins":["https://allowed.invalid"],"handlers":["request"],"timeoutMs":1000}),true).unwrap()["registration"].as_str().unwrap().into()
    }
    fn gateway(&self) -> Wire {
        let mut peer = Wire::new(self.traffic.gateway_endpoint().unwrap());
        assert!(
            peer.call("ready", json!({}))["result"]["ready"]
                .as_bool()
                .unwrap()
        );
        peer
    }
}
struct Wire {
    socket: TcpStream,
    next: u64,
}
impl Wire {
    fn new(endpoint: Value) -> Self {
        let socket =
            TcpStream::connect(("127.0.0.1", endpoint["port"].as_u64().unwrap() as u16)).unwrap();
        socket.set_nodelay(true).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        socket
            .set_write_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut wire = Self { socket, next: 0 };
        wire.send(json!({"token":endpoint["token"],"role":"gateway"}));
        assert_eq!(wire.read()["event"], "connected");
        wire
    }
    fn send(&mut self, value: Value) {
        let bytes = serde_json::to_vec(&value).unwrap();
        self.socket
            .write_all(&(bytes.len() as u32).to_be_bytes())
            .unwrap();
        self.socket.write_all(&bytes).unwrap();
    }
    fn read(&mut self) -> Value {
        let mut prefix = [0; 4];
        self.socket.read_exact(&mut prefix).unwrap();
        let length = u32::from_be_bytes(prefix) as usize;
        assert!(length <= MAX_FRAME);
        let mut bytes = vec![0; length];
        self.socket.read_exact(&mut bytes).unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }
    fn until(&mut self, predicate: impl Fn(&Value) -> bool) -> Value {
        loop {
            let value = self.read();
            if predicate(&value) {
                return value;
            }
        }
    }
    fn request(&mut self, method: &str, params: Value) -> u64 {
        self.next += 1;
        let id = self.next;
        self.send(json!({"id":id,"method":method,"params":params}));
        id
    }
    fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.request(method, params);
        self.until(|v| v["id"] == id)
    }
}

#[test]
fn native_authority_rejects_renderer_forgery_ungranted_scopes_and_cross_owner_leases() {
    let fixture = Fixture::new();
    let mut gateway = fixture.gateway();
    let mut a = fixture.host("test.traffic-a");
    let mut b = fixture.host("test.traffic-b");
    assert_eq!(
        fixture
            .invoke("test.traffic-a", "connect", json!({}), false)
            .unwrap_err()
            .code,
        "permission_denied"
    );
    assert_eq!(
        fixture
            .invoke(
                "test.traffic-a",
                "register",
                json!({"id":"fake","pluginId":"test.traffic-b"}),
                true
            )
            .unwrap_err()
            .code,
        "invalid_params"
    );
    assert_eq!(
        fixture
            .invoke(
                "test.traffic-a",
                "register",
                json!({"id":"fake","origins":["https://denied.invalid"],"handlers":["request"]}),
                true
            )
            .unwrap_err()
            .code,
        "policy_denied"
    );
    let key = fixture.registration("test.traffic-a");
    assert!(
        gateway.call("snapshot", json!({}))["result"]["registrations"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        b.call("activate", json!({"registration":key}))["error"]["code"],
        "permission_denied"
    );
    assert_eq!(
        a.call("activate", json!({"registration":key}))["result"]["activated"],
        true
    );
    assert_eq!(
        a.call("snapshot", json!({}))["error"]["code"],
        "permission_denied",
        "a caller-provided gateway role never upgrades its authenticated ticket"
    );
    assert_eq!(gateway.call("authorize",json!({"registration":key,"action":"sensitiveHeaders","url":"https://allowed.invalid/private?token=fixture"}))["result"]["allowed"],false);
    assert_eq!(
        gateway.call(
            "authorize",
            json!({"registration":key,"action":"redirect","url":"https://alternate.invalid/"})
        )["result"]["allowed"],
        false
    );
    let lease = gateway.call(
        "open",
        json!({"registration":key,"url":"wss://allowed.invalid/private?token=fixture"}),
    )["result"]["lease"]
        .clone();
    assert_eq!(
        fixture.traffic.hub.state.lock().unwrap().leases[lease.as_str().unwrap()].url,
        "https://allowed.invalid"
    );
    assert_eq!(
        b.call(
            "relay",
            json!({"lease":lease,"operation":"stream.read","payload":{"stream":"not-owned"}})
        )["error"]["code"],
        "permission_denied"
    );
    assert_eq!(
        fixture
            .invoke("test.traffic-a", "status", json!({}), true)
            .unwrap()["available"],
        false
    );
    fixture.traffic.set_attached(true);
    assert_eq!(
        fixture
            .invoke("test.traffic-a", "status", json!({}), true)
            .unwrap()["available"],
        true
    );
    let ca = gateway.call("certificateAuthority", json!({}));
    assert!(
        ca["result"]["caPem"]
            .as_str()
            .unwrap()
            .contains("BEGIN CERTIFICATE")
    );
    let leaf = gateway.call("certificate", json!({"url":"https://allowed.invalid/"}));
    assert!(
        leaf["result"]["cert"]
            .as_str()
            .unwrap()
            .contains("BEGIN CERTIFICATE")
    );
}

#[test]
fn native_revocation_retires_pending_data_and_cannot_deliver_a_late_plugin_reply() {
    let fixture = Fixture::new();
    let mut gateway = fixture.gateway();
    let mut host = fixture.host("test.traffic-a");
    let key = fixture.registration("test.traffic-a");
    host.call("activate", json!({"registration":key}));
    let lease = gateway.call(
        "open",
        json!({"registration":key,"url":"https://allowed.invalid/responses"}),
    )["result"]["lease"]
        .clone();
    let pending=gateway.request("relay",json!({"lease":lease,"operation":"invoke","payload":{"kind":"request","value":{"body":null}}}));
    let invoke = host.until(|v| v["method"] == "invoke");
    let mut registry = PluginRegistry::load(&fixture.registry).unwrap();
    registry.set_enabled("test.traffic-a", false).unwrap();
    registry.save().unwrap();
    host.send(
        json!({"id":invoke["id"],"result":{"respond":{"status":200,"body":"must-not-arrive"}}}),
    );
    let result = gateway.until(|v| v["id"] == pending);
    assert_eq!(result["error"]["code"], "stream_retired");
    assert!(result.get("result").is_none());
    let resources = fixture.traffic.resources();
    assert_eq!(resources["leases"], 0);
    assert_eq!(resources["pending"], 0);
    assert_eq!(resources["registrations"], 0);
}

#[test]
fn native_interceptor_disable_closes_streams_but_keeps_the_other_owners_registration() {
    let fixture = Fixture::new();
    let mut gateway = fixture.gateway();
    let mut a = fixture.host("test.traffic-a");
    let mut b = fixture.host("test.traffic-b");
    let ka = fixture.registration("test.traffic-a");
    let kb = fixture.registration("test.traffic-b");
    a.call("activate", json!({"registration":ka}));
    b.call("activate", json!({"registration":kb}));
    let lease = gateway.call(
        "open",
        json!({"registration":ka,"url":"https://allowed.invalid/"}),
    )["result"]["lease"]
        .clone();
    assert_eq!(
        a.call("setEnabled", json!({"registration":ka,"enabled":false}))["result"]["activated"],
        false
    );
    assert_eq!(
        gateway.call(
            "relay",
            json!({"lease":lease,"operation":"stream.read","payload":{"stream":"expired"}})
        )["error"]["code"],
        "stream_retired"
    );
    let snapshot = gateway.call("snapshot", json!({}));
    assert_eq!(
        snapshot["result"]["registrations"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(snapshot["result"]["registrations"][0]["registration"], kb);
    a.call("setEnabled", json!({"registration":ka,"enabled":true}));
    assert_eq!(
        gateway.call("snapshot", json!({}))["result"]["registrations"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn native_data_plane_round_trips_host_callbacks_streams_and_websocket_frames() {
    use std::io::{BufRead, BufReader};
    let Some(node) = std::env::var_os("CODLET_TRAFFIC_TEST_NODE") else {
        return;
    };
    let fixture = Fixture::new();
    let mut child = std::process::Command::new(node)
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/traffic-native-peer.cjs"))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    writeln!(input,"{}",json!({"gateway":fixture.traffic.gateway_endpoint().unwrap(),"host":fixture.invoke("test.traffic-a","connect",json!({}),true).unwrap()})).unwrap();
    let mut line = String::new();
    output.read_line(&mut line).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&line).unwrap()["ready"],
        true,
        "{line}"
    );
    let registration=fixture.invoke("test.traffic-a","register",json!({"id":"roundtrip","origins":["https://allowed.invalid"],"handlers":["request","response","webSocket"],"timeoutMs":2000}),true).unwrap();
    writeln!(input, "{registration}").unwrap();
    line.clear();
    output.read_line(&mut line).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&line).unwrap()["completed"],
        true,
        "{line}"
    );
    assert!(child.wait().unwrap().success());
    let resources = fixture.traffic.resources();
    assert_eq!(resources["leases"], 0);
    assert_eq!(resources["pending"], 0);
}
