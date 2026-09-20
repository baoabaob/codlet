#![cfg(windows)]

use std::ffi::OsString;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use codlet::capabilities::{CapabilityDescriptor, CapabilityScope};
use codlet::cdp::CdpClient;
use codlet::host_runtime::{
    HostCapabilityCaller, HostCapabilityRequest, HostCoreServices, HostRuntime,
};
use codlet::js_runtime::JsRuntime;
use codlet::local_plugins::load_local_plugin_with_registration;
use codlet::os_broker::{
    MAX_OS_BYTES, MAX_OS_OPERATIONS, OsAuthorization, OsBroker, OsBrokerClient, OsBrokerError,
    OsBrokerOperation,
};
use codlet::plugin_execution::ExecutionState;
use codlet::plugin_permissions::BrokerPolicy;
use codlet::plugins::{LoadedPlugin, LocalPluginRegistration, Permission, PluginRegistry};
use codlet::windows::process::{ChildProcess, launch_with_cdp_pipes};
use serde_json::{Value, json};
use tempfile::{TempDir, tempdir};
use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
};

const WAIT: Duration = Duration::from_secs(8);
const ID: &str = "dev.os-fixture";

fn node() -> PathBuf {
    Path::new(env!("CARGO_BIN_EXE_codlet"))
        .parent()
        .unwrap()
        .join("runtime/node-v24.21.0-win-x64/node.exe")
        .canonicalize()
        .unwrap()
}

struct Fixture {
    broker: OsBroker,
    client: OsBrokerClient,
    authorization: OsAuthorization,
    plugin: LoadedPlugin,
    root: PathBuf,
    data: PathBuf,
    registry_path: PathBuf,
    _directory: TempDir,
}

struct NativePeer {
    client: CdpClient,
    child: ChildProcess,
}
impl Drop for NativePeer {
    fn drop(&mut self) {
        let _ = self.client.shutdown();
        let _ = self.child.wait(WAIT);
    }
}
impl Fixture {
    fn new(origins: Vec<String>) -> Self {
        Self::with_permissions(
            vec![
                Permission::HostProcess,
                Permission::HostFs,
                Permission::HostNetwork,
                Permission::HostSystem,
                Permission::CdpRaw,
            ],
            None,
            origins,
        )
    }
    fn with_permissions(
        declared: Vec<Permission>,
        grants: Option<Vec<Permission>>,
        origins: Vec<String>,
    ) -> Self {
        let directory = tempdir().unwrap();
        let root = directory.path().join("plugin");
        let data = directory.path().join("allowed");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&data).unwrap();
        let root = root.canonicalize().unwrap();
        let data = data.canonicalize().unwrap();
        fs::write(
            root.join("host.js"),
            "module.exports={activate(){},deactivate(){}};",
        )
        .unwrap();
        fs::write(root.join("codlet.json"), json!({"schema":1,"id":ID,"version":"1","host":{"entry":"host.js"},"permissions":declared}).to_string()).unwrap();
        let grants = grants.unwrap_or_else(|| declared.clone());
        let policy = BrokerPolicy {
            read_roots: grants
                .contains(&Permission::HostFs)
                .then(|| data.clone())
                .into_iter()
                .collect(),
            network_origins: origins,
            executables: vec![node()],
            ..Default::default()
        };
        let registration = LocalPluginRegistration {
            path: root.clone(),
            grants,
            broker_policy: policy,
        };
        let registry_path = directory.path().join("config.json");
        let mut registry = PluginRegistry::load(&registry_path).unwrap();
        registry.register_local(ID, registration.clone()).unwrap();
        registry.save().unwrap();
        let plugin = load_local_plugin_with_registration(ID, &registration, 1).unwrap();
        let broker = OsBroker::for_registry(registry_path.clone()).unwrap();
        let client = broker.client();
        let authorization = client.authorize(&plugin).unwrap();
        Self {
            broker,
            client,
            authorization,
            plugin,
            root,
            data,
            registry_path,
            _directory: directory,
        }
    }
    fn begin(
        &self,
        endpoint: &str,
        params: Value,
        budget: Duration,
    ) -> Result<OsBrokerOperation, OsBrokerError> {
        self.client.begin_request(
            &self.authorization,
            endpoint,
            params,
            Instant::now() + budget,
        )
    }
    fn call(&self, endpoint: &str, params: Value) -> Result<Value, OsBrokerError> {
        result(self.begin(endpoint, params, WAIT)?)
    }
    fn registry(&self) -> PluginRegistry {
        PluginRegistry::load(&self.registry_path).unwrap()
    }
}

fn result(mut operation: OsBrokerOperation) -> Result<Value, OsBrokerError> {
    let end = Instant::now() + WAIT + Duration::from_secs(3);
    loop {
        if let Some(result) = operation.try_result() {
            assert!(operation.try_result().is_none());
            return result;
        }
        assert!(Instant::now() < end, "OS operation failed to terminate");
        thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn file_endpoints_are_bounded_and_do_not_follow_ungranted_or_linked_paths() {
    let fixture = Fixture::new(vec![]);
    fs::write(fixture.data.join("readme.txt"), "fixture ✓").unwrap();
    fs::write(fixture.root.join("private.txt"), "outside scope").unwrap();
    assert_eq!(
        fixture
            .call(
                "host.fs.readText",
                json!({"path":fixture.data.join("readme.txt")})
            )
            .unwrap()["text"],
        "fixture ✓"
    );
    assert_eq!(
        fixture
            .call(
                "host.fs.stat",
                json!({"path":fixture.data.join("readme.txt")})
            )
            .unwrap()["bytes"],
        "fixture ✓".len()
    );
    assert_eq!(
        fixture
            .call("host.fs.readDir", json!({"path":fixture.data}))
            .unwrap()["entries"][0]["name"],
        "readme.txt"
    );
    assert_eq!(
        fixture
            .call(
                "host.fs.readText",
                json!({"path":fixture.root.join("private.txt")})
            )
            .unwrap_err()
            .code,
        "policy_denied"
    );
    assert_eq!(
        fixture
            .call(
                "host.fs.stat",
                json!({"path":fixture.root.join("ungranted-missing-file")})
            )
            .unwrap_err()
            .code,
        "policy_denied",
        "ungranted paths must be rejected before filesystem lookup"
    );
    let differently_cased_root = fixture.data.with_file_name("ALLOWED");
    assert_eq!(
        fixture
            .call(
                "host.fs.stat",
                json!({"path":differently_cased_root.join("readme.txt")})
            )
            .unwrap_err()
            .code,
        "policy_denied",
        "case-distinct scope spellings must never expand an exact grant"
    );
    assert_eq!(
        fixture
            .call(
                "host.fs.stat",
                json!({"path":fixture.data.join("README.txt")})
            )
            .unwrap_err()
            .code,
        "policy_denied",
        "the final handle spelling must match the requested path"
    );
    assert_eq!(
        fixture
            .call(
                "host.fs.readText",
                json!({"path":fixture.data.join("readme.txt"),"maxBytes":2})
            )
            .unwrap_err()
            .code,
        "response_too_large"
    );
    assert_eq!(
        fixture
            .call(
                "host.fs.readText",
                json!({"path":format!("{}\\..\\plugin\\private.txt",fixture.data.display())})
            )
            .unwrap_err()
            .code,
        "invalid_params"
    );
    assert_eq!(
        fixture
            .call("host.fs.stat", json!({"path":fixture.data.join("NUL.txt")}))
            .unwrap_err()
            .code,
        "invalid_params"
    );
    fs::hard_link(
        fixture.root.join("private.txt"),
        fixture.data.join("hardlink.txt"),
    )
    .unwrap();
    assert_eq!(
        fixture
            .call(
                "host.fs.readText",
                json!({"path":fixture.data.join("hardlink.txt")})
            )
            .unwrap_err()
            .code,
        "policy_denied"
    );
    fs::write(fixture.data.join("other.txt"), "other").unwrap();
    let listing = fixture
        .call(
            "host.fs.readDir",
            json!({"path":fixture.data,"maxEntries":1}),
        )
        .unwrap();
    assert_eq!(listing["entries"].as_array().unwrap().len(), 1);
    assert_eq!(listing["truncated"], true);
    fs::write(fixture.data.join("invalid.txt"), [0xff_u8, 0xfe]).unwrap();
    assert_eq!(
        fixture
            .call(
                "host.fs.readText",
                json!({"path":fixture.data.join("invalid.txt")})
            )
            .unwrap_err()
            .code,
        "invalid_utf8"
    );
}

#[test]
fn a_dangling_junction_is_rejected_before_its_target_is_resolved() {
    use std::os::windows::process::CommandExt;
    let fixture = Fixture::new(vec![]);
    let target = fixture.root.join("link-target");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("private.txt"), "ungranted").unwrap();
    let link = fixture.data.join("redirect");
    let output=std::process::Command::new("powershell.exe").args(["-NoProfile","-NonInteractive","-Command","$ErrorActionPreference = 'Stop'; New-Item -ItemType Junction -Path $env:CODLET_OS_LINK -Target $env:CODLET_OS_TARGET | Out-Null"]).env("CODLET_OS_LINK",&link).env("CODLET_OS_TARGET",&target).creation_flags(0x0800_0000).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    fs::rename(&target, fixture.root.join("target-moved-within-fixture")).unwrap();
    let error = fixture
        .call("host.fs.readText", json!({"path":link.join("private.txt")}))
        .unwrap_err();
    fs::remove_dir(&link).unwrap();
    assert_eq!(
        error.code, "policy_denied",
        "must reject the reparse handle itself, before looking up its now-missing target"
    );
}

#[test]
fn declared_and_granted_permissions_are_both_required_and_generations_never_reactivate() {
    let fixture = Fixture::with_permissions(
        vec![Permission::HostProcess],
        Some(vec![Permission::HostProcess, Permission::HostSystem]),
        vec![],
    );
    assert_eq!(
        fixture
            .call("host.system.info", json!({}))
            .unwrap_err()
            .code,
        "permission_denied"
    );
    assert_eq!(
        fixture
            .call("host.fs.readText", json!({"path":fixture.data}))
            .unwrap_err()
            .code,
        "permission_denied"
    );
    assert_eq!(
        fixture
            .call("host.network.fetch", json!({"url":"http://127.0.0.1:1"}))
            .unwrap_err()
            .code,
        "permission_denied"
    );
    assert_eq!(
        fixture
            .call("host.network.authorizeChannel", json!({}))
            .unwrap_err()
            .code,
        "permission_denied"
    );
    let mut next = fixture.plugin.clone();
    next.generation = 2;
    let current = fixture.client.authorize(&next).unwrap();
    assert!(!fixture.authorization.is_current());
    assert!(current.is_current());
    assert!(!fixture.client.revoke_owner(ID, 1));
    assert!(current.is_current());
    assert!(fixture.client.authorize(&next).is_err());
    let other = OsBroker::new().unwrap();
    assert_eq!(
        other
            .client()
            .begin_request(
                &current,
                "host.process.run",
                json!({}),
                Instant::now() + WAIT
            )
            .err()
            .unwrap()
            .code,
        "invalid_owner"
    );
    assert!(fixture.client.revoke_owner(ID, 2));
    assert!(!current.is_current());
}

#[test]
fn current_full_record_guard_revokes_ready_results_and_preserves_only_still_granted_cleanup() {
    let fixture = Fixture::new(vec![]);
    fs::write(fixture.data.join("message.txt"), "approved result").unwrap();
    let operation = fixture
        .begin(
            "host.fs.readText",
            json!({"path":fixture.data.join("message.txt")}),
            WAIT,
        )
        .unwrap();
    let mut registry = fixture.registry();
    registry.revoke_permission(ID, Permission::HostFs).unwrap();
    registry.save().unwrap();
    assert_eq!(result(operation).unwrap_err().code, "permission_revoked");
    assert!(!fixture.authorization.is_current());
    assert!(
        fixture
            .authorization
            .cleanup_permission_current(Permission::CdpRaw)
    );
    assert!(
        !fixture
            .authorization
            .cleanup_permission_current(Permission::HostFs)
    );
    assert_eq!(
        fixture.client.revoke_changed(&registry),
        vec![(ID.into(), 1)]
    );
    assert!(fixture.client.revoke_changed(&registry).is_empty());
    registry.revoke_permission(ID, Permission::CdpRaw).unwrap();
    registry.save().unwrap();
    assert!(
        !fixture
            .authorization
            .cleanup_permission_current(Permission::CdpRaw)
    );
    assert_eq!(
        fixture
            .call("host.system.info", json!({}))
            .unwrap_err()
            .code,
        "permission_revoked"
    );
}

struct Server {
    origin: String,
    stop: Arc<AtomicBool>,
    calls: Arc<AtomicUsize>,
    worker: Option<JoinHandle<()>>,
}
impl Server {
    fn new(redirect: Option<String>) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let calls = Arc::new(AtomicUsize::new(0));
        let done = stop.clone();
        let count = calls.clone();
        let worker = thread::spawn(move || {
            let mut held: Vec<TcpStream> = Vec::new();
            while !done.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        // Windows accept can inherit the listener's nonblocking mode;
                        // the fixture's bounded header read intentionally blocks.
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        stream
                            .set_write_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        let mut bytes = Vec::new();
                        let mut chunk = [0; 2048];
                        while bytes.len() < 16384
                            && !bytes.windows(4).any(|window| window == b"\r\n\r\n")
                        {
                            match stream.read(&mut chunk) {
                                Ok(0) | Err(_) => break,
                                Ok(size) => bytes.extend_from_slice(&chunk[..size]),
                            }
                        }
                        if !bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                            continue;
                        }
                        count.fetch_add(1, Ordering::AcqRel);
                        let request = String::from_utf8_lossy(&bytes);
                        if request.contains(" /slow ") {
                            held.push(stream);
                            continue;
                        }
                        let response = if request.contains(" /redirect ") {
                            format!(
                                "HTTP/1.1 302 Found\r\nLocation: {}/never\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                                redirect.as_deref().unwrap()
                            )
                        } else if request.contains(" /large ") {
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                MAX_OS_BYTES + 1
                            )
                        } else if request.contains(" /chunked ") {
                            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\ntest\r\n4\r\ndata\r\n0\r\n\r\n".into()
                        } else {
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: 7\r\nX-Fixture: local\r\nConnection: close\r\n\r\n{}",
                                if request.starts_with("HEAD ") {
                                    ""
                                } else {
                                    "fixture"
                                }
                            )
                        };
                        let _ = stream.write_all(response.as_bytes());
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            origin,
            stop,
            calls,
            worker: Some(worker),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}

#[test]
fn network_fetch_honors_exact_origins_limits_cancellation_and_redirect_boundaries() {
    let destination = Server::new(None);
    let server = Server::new(Some(destination.origin.clone()));
    let fixture = Fixture::new(vec![server.origin.clone()]);
    assert_eq!(
        fixture
            .call("host.network.authorizeChannel", json!({}))
            .unwrap()["coverage"],
        "explicit-endpoint"
    );
    let authorized = fixture
        .call(
            "host.network.authorizeForward",
            json!({"url":format!("{}/binary?q=1",server.origin)}),
        )
        .unwrap();
    assert_eq!(authorized["origin"], server.origin);
    assert_eq!(authorized["url"], format!("{}/binary?q=1", server.origin));
    let websocket_url = format!(
        "ws://{}/realtime",
        server.origin.trim_start_matches("http://")
    );
    let websocket = fixture
        .call(
            "host.network.authorizeForward",
            json!({"url":websocket_url}),
        )
        .unwrap();
    assert_eq!(websocket["origin"], server.origin);
    assert_eq!(websocket["url"], websocket_url);
    let secure = Fixture::new(vec!["https://example.test".into()]);
    assert_eq!(
        secure
            .call(
                "host.network.authorizeForward",
                json!({"url":"wss://example.test/realtime"}),
            )
            .unwrap()["origin"],
        "https://example.test"
    );
    assert_eq!(
        fixture
            .call(
                "host.network.authorizeForward",
                json!({"url":format!("{}#fragment",server.origin)}),
            )
            .unwrap_err()
            .code,
        "invalid_params"
    );
    assert_eq!(
        fixture
            .call(
                "host.network.authorizeForward",
                json!({"url":destination.origin}),
            )
            .unwrap_err()
            .code,
        "policy_denied"
    );
    assert_eq!(
        fixture
            .call(
                "host.network.fetch",
                json!({"url":format!("{}/text",server.origin)})
            )
            .unwrap()["body"],
        "fixture"
    );
    assert_eq!(
        fixture
            .call(
                "host.network.fetch",
                json!({"url":format!("{}/text",server.origin),"method":"HEAD","maxBytes":1})
            )
            .unwrap()["body"],
        ""
    );
    assert_eq!(
        fixture
            .call(
                "host.network.fetch",
                json!({"url":format!("{}/chunked",server.origin),"maxBytes":3})
            )
            .unwrap_err()
            .code,
        "response_too_large"
    );
    assert_eq!(
        fixture
            .call(
                "host.network.fetch",
                json!({"url":format!("{}/large",server.origin)})
            )
            .unwrap_err()
            .code,
        "response_too_large"
    );
    assert_eq!(
        fixture
            .call(
                "host.network.fetch",
                json!({"url":format!("{}/redirect",server.origin)})
            )
            .unwrap()["status"],
        302
    );
    assert_eq!(
        destination.calls.load(Ordering::Acquire),
        0,
        "broker must not follow a redirect to another origin"
    );
    assert_eq!(
        fixture
            .call("host.network.fetch", json!({"url":destination.origin}))
            .unwrap_err()
            .code,
        "policy_denied"
    );
    assert_eq!(
        fixture
            .call(
                "host.network.fetch",
                json!({"url":server.origin,"headers":{"Host":"another-host"}})
            )
            .unwrap_err()
            .code,
        "invalid_params"
    );
    let operation = fixture
        .begin(
            "host.network.fetch",
            json!({"url":format!("{}/slow",server.origin)}),
            Duration::from_millis(200),
        )
        .unwrap();
    assert_eq!(result(operation).unwrap_err().code, "deadline_exceeded");
    let operation = fixture
        .begin(
            "host.network.fetch",
            json!({"url":format!("{}/slow",server.origin)}),
            WAIT,
        )
        .unwrap();
    operation.cancel();
    assert_eq!(result(operation).unwrap_err().code, "cancelled");
    let info = fixture.call("host.system.info", json!({})).unwrap();
    assert_eq!(info["os"], "windows");
    assert!(info["logicalCpus"].as_u64().unwrap() > 0);
}

#[test]
fn process_run_passes_an_argument_array_without_shell_and_enforces_output_and_executable_policy() {
    let fixture = Fixture::new(vec![]);
    let arguments = vec![
        "spaces stay together",
        "literal \"quote\"",
        "$(not-a-command)",
    ];
    let mut args=vec!["-e".to_owned(),"process.stdout.write(JSON.stringify(process.argv.slice(1)));process.stderr.write('fixture stderr');".to_owned(),"--".to_owned()];
    args.extend(arguments.iter().map(|argument| argument.to_string()));
    let reply = fixture
        .call("host.process.run", json!({"executable":node(),"args":args}))
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(reply["stdout"].as_str().unwrap()).unwrap(),
        json!(arguments)
    );
    assert_eq!(reply["stderr"], "fixture stderr");
    assert_eq!(reply["jobReaped"], true);
    assert_eq!(reply["exitCode"], 0);
    assert_eq!(
        fixture
            .call(
                "host.process.run",
                json!({"executable":std::env::current_exe().unwrap(),"args":[]})
            )
            .unwrap_err()
            .code,
        "policy_denied"
    );
    assert_eq!(
        fixture
            .call(
                "host.process.run",
                json!({"executable":node().with_file_name("NODE.EXE"),"args":[]})
            )
            .unwrap_err()
            .code,
        "policy_denied",
        "an executable with a different case is not the exact grant"
    );
    assert_eq!(fixture.call("host.process.run",json!({"executable":node(),"args":["-e","process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000);"],"maxOutputBytes":32})).unwrap_err().code,"response_too_large");
}

fn process_handle(pid: u32) -> OwnedHandle {
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    assert!(!handle.is_null(), "failed to retain fixture process {pid}");
    unsafe { OwnedHandle::from_raw_handle(handle.cast()) }
}
fn assert_exited(handle: &OwnedHandle) {
    assert_eq!(
        unsafe { WaitForSingleObject(handle.as_raw_handle().cast(), 0) },
        WAIT_OBJECT_0,
        "operation completed before exact child process exited"
    );
}

#[test]
fn process_cancel_and_revoke_complete_only_after_the_owned_descendant_job_is_empty() {
    for revoke in [false, true] {
        let fixture = Fixture::new(vec![]);
        let source = "const fs=require('node:fs');const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});fs.writeFileSync('pids.json',JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000);";
        let operation = fixture
            .begin(
                "host.process.run",
                json!({"executable":node(),"args":["-e",source]}),
                WAIT,
            )
            .unwrap();
        let end = Instant::now() + WAIT;
        let pids: Value = loop {
            if let Some(pids) = fs::read(fixture.root.join("pids.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            {
                break pids;
            }
            assert!(Instant::now() < end);
            thread::sleep(Duration::from_millis(5));
        };
        let parent = process_handle(pids["parent"].as_u64().unwrap() as u32);
        let child = process_handle(pids["child"].as_u64().unwrap() as u32);
        if revoke {
            fixture.authorization.revoke();
        } else {
            operation.cancel();
        }
        assert_eq!(
            result(operation).unwrap_err().code,
            if revoke {
                "permission_revoked"
            } else {
                "cancelled"
            }
        );
        assert_exited(&parent);
        assert_exited(&child);
    }
}

#[test]
fn retained_results_keep_a_bounded_capacity_and_stop_retires_active_workers() {
    let fixture = Fixture::new(vec![]);
    let mut operations = Vec::new();
    let end = Instant::now() + WAIT;
    while operations.len() < MAX_OS_OPERATIONS {
        match fixture.begin("host.system.info", json!({}), WAIT) {
            Ok(operation) => operations.push(operation),
            Err(error) if error.code == "broker_busy" => thread::sleep(Duration::from_millis(5)),
            Err(error) => panic!("{error}"),
        }
        assert!(Instant::now() < end);
    }
    assert_eq!(
        fixture
            .begin("host.system.info", json!({}), WAIT)
            .err()
            .unwrap()
            .code,
        "broker_busy"
    );
    let first = operations.remove(0);
    assert!(result(first).unwrap().is_object());
    assert!(
        fixture
            .call("host.system.info", json!({}))
            .unwrap()
            .is_object()
    );
    drop(operations);
    let server = Server::new(None);
    let mut blocked = Fixture::new(vec![server.origin.clone()]);
    let operation = blocked
        .begin(
            "host.network.fetch",
            json!({"url":format!("{}/slow",server.origin)}),
            WAIT,
        )
        .unwrap();
    blocked.broker.stop().unwrap();
    assert!(matches!(
        result(operation).unwrap_err().code,
        "permission_revoked" | "broker_stopped"
    ));
}

#[test]
fn actual_host_os_example_uses_public_sdk_and_its_old_generation_is_denied_after_revocation() {
    let server = Server::new(None);
    let directory = tempdir().unwrap();
    let root = directory.path().join("example");
    fs::create_dir(&root).unwrap();
    fs::create_dir(root.join("approved-data")).unwrap();
    fs::write(
        root.join("codlet.json"),
        include_str!("../examples/host-os-broker/codlet.json"),
    )
    .unwrap();
    fs::write(
        root.join("host.js"),
        include_str!("../examples/host-os-broker/host.js"),
    )
    .unwrap();
    fs::write(
        root.join("approved-data/message.txt"),
        include_str!("../examples/host-os-broker/approved-data/message.txt"),
    )
    .unwrap();
    fs::write(
        root.join("approved-data/settings.json"),
        json!({"url":format!("{}/message",server.origin)}).to_string(),
    )
    .unwrap();
    let root = root.canonicalize().unwrap();
    let registry_path = directory.path().join("config.json");
    let mut registry = PluginRegistry::load(&registry_path).unwrap();
    let registration = LocalPluginRegistration {
        path: root.clone(),
        grants: vec![
            Permission::HostProcess,
            Permission::HostFs,
            Permission::HostNetwork,
            Permission::HostSystem,
        ],
        broker_policy: BrokerPolicy {
            read_roots: vec![root.join("approved-data").canonicalize().unwrap()],
            network_origins: vec![server.origin.clone()],
            executables: vec![],
            ..Default::default()
        },
    };
    registry
        .register_local("example.os-broker", registration.clone())
        .unwrap();
    registry.save().unwrap();
    let plugin =
        load_local_plugin_with_registration("example.os-broker", &registration, 1).unwrap();
    let mut broker = OsBroker::for_registry(registry_path.clone()).unwrap();
    let (child, pipes) = launch_with_cdp_pipes(
        Path::new(env!("CARGO_BIN_EXE_codlet-fake-child")),
        &[OsString::from("--scenario=raw-host-cdp")],
        true,
    )
    .unwrap();
    let (client, events) = CdpClient::spawn(pipes).unwrap();
    drop(events);
    let peer = NativePeer { client, child };
    let runtime =
        JsRuntime::from_distribution(Path::new(env!("CARGO_BIN_EXE_codlet")).parent().unwrap())
            .unwrap();
    let mut hosts = HostRuntime::start_with_services(
        vec![plugin],
        peer.client.clone(),
        Some(runtime),
        HostCoreServices {
            os_broker: Some(broker.client()),
            runtime_manage: None,
            plugin_services: None,
        },
    )
    .unwrap();
    let end = Instant::now() + WAIT;
    while hosts.is_starting() {
        assert!(Instant::now() < end);
        thread::sleep(Duration::from_millis(5));
    }
    let observation = hosts.observations().into_iter().next().unwrap();
    assert_eq!(
        observation.state,
        ExecutionState::Active,
        "{:?}; report={:?}",
        observation,
        fs::read_to_string(root.join("broker-report.json"))
    );
    let report: Value =
        serde_json::from_slice(&fs::read(root.join("broker-report.json")).unwrap()).unwrap();
    assert_eq!(report["ready"], true);
    assert_eq!(report["network"]["body"], "fixture");
    assert_eq!(report["system"]["os"], "windows");
    assert!(
        report["file"]["text"]
            .as_str()
            .unwrap()
            .contains("explicitly granted")
    );
    let request = || HostCapabilityRequest {
        owner_plugin_id: "example.os-broker".into(),
        expected_generation: 1,
        capability: CapabilityDescriptor::new(
            "example.os-broker.inspect",
            1,
            CapabilityScope::Target,
        )
        .unwrap(),
        method: "readAgain".into(),
        params: Value::Null,
        caller: HostCapabilityCaller {
            plugin_id: "dev.os-consumer".into(),
            generation: 1,
            target_id: "fixture-target".into(),
            document_epoch: 1,
        },
        deadline: Instant::now() + WAIT,
    };
    let mut operation = hosts.capability_client().begin_request(request()).unwrap();
    let read = loop {
        if let Some(result) = operation.try_result() {
            break result.unwrap();
        }
        assert!(Instant::now() < end);
        thread::sleep(Duration::from_millis(5));
    };
    assert_eq!(read["text"], report["file"]["text"]);
    registry
        .revoke_permission("example.os-broker", Permission::HostFs)
        .unwrap();
    registry.save().unwrap();
    let mut operation = hosts.capability_client().begin_request(request()).unwrap();
    let error = loop {
        if let Some(result) = operation.try_result() {
            break result.unwrap_err();
        }
        assert!(Instant::now() < end);
        thread::sleep(Duration::from_millis(5));
    };
    assert_eq!(error.code, "authorization_revoked");
    assert_eq!(
        broker.client().revoke_changed(&registry),
        vec![("example.os-broker".into(), 1)]
    );
    for report in hosts.stop().unwrap() {
        assert!(report.result.unwrap().workers_reaped);
    }
    broker.stop().unwrap();
    peer.client.shutdown().unwrap();
    assert_eq!(peer.child.wait(WAIT).unwrap(), Some(0));
}

#[test]
fn short_os_budget_reaps_the_child_while_the_host_javascript_event_loop_is_blocked() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("blocked-host");
    fs::create_dir(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let id = "dev.os-deadline";
    fs::write(
        root.join("codlet.json"),
        json!({
            "schema":1,"id":id,"version":"1","host":{"entry":"host.js"},
            "permissions":["host.process"]
        })
        .to_string(),
    )
    .unwrap();
    let child = format!(
        "const fs=require('node:fs');fs.writeFileSync({},String(process.pid));setTimeout(()=>fs.writeFileSync({},'too late'),900);setInterval(()=>{{}},1000);",
        json!(root.join("child.pid")),
        json!(root.join("late-effect"))
    );
    let source = format!(
        r#"
const fs=require('node:fs'),path=require('node:path');
module.exports={{
 async activate(context){{
   const result=context.process.run({{executable:process.execPath,args:['-e',{child}]}},{{timeoutMs:600}}).then(()=>({{ok:true}}),error=>({{code:error.code}}));
   const end=Date.now()+1400;
   while(Date.now()<end){{}}
   fs.writeFileSync(path.join(context.root,'host-unblocked'),'done');
   fs.writeFileSync(path.join(context.root,'result.json'),JSON.stringify(await result));
 }},deactivate(){{}}
}};
"#,
        child = json!(child)
    );
    fs::write(root.join("host.js"), source).unwrap();
    let registration = LocalPluginRegistration {
        path: root.clone(),
        grants: vec![Permission::HostProcess],
        broker_policy: BrokerPolicy {
            executables: vec![node()],
            ..Default::default()
        },
    };
    let registry_path = directory.path().join("config.json");
    let mut registry = PluginRegistry::load(&registry_path).unwrap();
    registry.register_local(id, registration.clone()).unwrap();
    registry.save().unwrap();
    let plugin = load_local_plugin_with_registration(id, &registration, 1).unwrap();
    let mut broker = OsBroker::for_registry(registry_path).unwrap();
    let (child, pipes) = launch_with_cdp_pipes(
        Path::new(env!("CARGO_BIN_EXE_codlet-fake-child")),
        &[OsString::from("--scenario=raw-host-cdp")],
        true,
    )
    .unwrap();
    let (client, events) = CdpClient::spawn(pipes).unwrap();
    drop(events);
    let peer = NativePeer { client, child };
    let runtime =
        JsRuntime::from_distribution(Path::new(env!("CARGO_BIN_EXE_codlet")).parent().unwrap())
            .unwrap();
    let mut hosts = HostRuntime::start_with_services(
        vec![plugin],
        peer.client.clone(),
        Some(runtime),
        HostCoreServices {
            os_broker: Some(broker.client()),
            runtime_manage: None,
            plugin_services: None,
        },
    )
    .unwrap();
    let end = Instant::now() + WAIT;
    let pid = loop {
        if let Ok(text) = fs::read_to_string(root.join("child.pid"))
            && let Ok(pid) = text.parse::<u32>()
        {
            break pid;
        }
        assert!(
            Instant::now() < end,
            "approved child never started: {:?}",
            hosts.observations()
        );
        thread::sleep(Duration::from_millis(5));
    };
    let raw = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    assert!(
        !raw.is_null(),
        "retain the actual running child's process handle"
    );
    let owned = unsafe { OwnedHandle::from_raw_handle(raw.cast()) };
    assert_eq!(
        unsafe { WaitForSingleObject(owned.as_raw_handle().cast(), 1000) },
        WAIT_OBJECT_0,
        "Core must end the child without waiting for blocked JS to send request.cancel"
    );
    assert!(
        !root.join("host-unblocked").exists(),
        "the child must exit while Host JS is still blocked"
    );
    assert!(
        !root.join("late-effect").exists(),
        "the child exceeded the requested native deadline"
    );
    while hosts.is_starting() {
        assert!(Instant::now() < end);
        thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        hosts.observations()[0].state,
        ExecutionState::Active,
        "{:?}",
        hosts.observations()
    );
    let result: Value =
        serde_json::from_slice(&fs::read(root.join("result.json")).unwrap()).unwrap();
    assert!(
        matches!(
            result["code"].as_str(),
            Some("request_timeout" | "deadline_exceeded")
        ),
        "{result}"
    );
    assert!(!root.join("late-effect").exists());
    for report in hosts.stop().unwrap() {
        assert!(report.result.unwrap().workers_reaped);
    }
    broker.stop().unwrap();
    peer.client.shutdown().unwrap();
    assert_eq!(peer.child.wait(WAIT).unwrap(), Some(0));
}
