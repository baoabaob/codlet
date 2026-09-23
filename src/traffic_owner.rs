//! Native owner for the fixed plaintext traffic worker and private launch data.
//! Launch configuration is private process data; errors never print it.
use crate::core_services::{SharedCoreServices, traffic::Traffic};
use crate::js_runtime::{JsInvocation, JsRuntime};
use crate::platform::host::{OwnedPluginProcess, PluginStdio};
use crate::plugin_host::HostError;
use serde_json::{Value, json};
use std::ffi::OsString;
use std::path::Path;
use std::time::{Duration, Instant};

const START_TIMEOUT: Duration = Duration::from_secs(15);

/// Input is the launch catalog's enabled plugins, after normal validation.
pub(crate) fn required_for_plugins(plugins: &[crate::plugins::LoadedPlugin]) -> bool {
    use crate::plugins::Permission::TrafficIntercept;
    plugins.iter().any(|plugin| {
        plugin.manifest.host.is_some()
            && plugin.manifest.permissions.contains(&TrafficIntercept)
            && plugin
                .authorization
                .as_ref()
                .is_some_and(|record| record.grants.contains(&TrafficIntercept))
    })
}

pub(crate) struct TrafficOwner {
    traffic: Traffic,
    process: OwnedPluginProcess,
    _stdio: PluginStdio,
    _invocation: JsInvocation,
    directory: tempfile::TempDir,
    environment: Vec<(OsString, OsString)>,
    original_environment: Vec<(OsString, OsString)>,
    descriptor: Value,
    adapter: std::cell::RefCell<Option<crate::client_launch::LaunchAdapter>>,
    launch_arguments: Vec<OsString>,
    launch_provider: Option<crate::client_launch::LaunchAuthorization>,
    last_authorization_check: std::cell::Cell<Option<Instant>>,
    stderr: Option<crate::client_stderr::ClientStderr>,
}

fn failure(code: &'static str) -> HostError {
    HostError::new(
        code,
        "Native traffic launch could not complete; private launch configuration was omitted",
    )
}

impl TrafficOwner {
    #[cfg(any(windows, test))]
    pub(crate) fn start(
        services: &SharedCoreServices,
        runtime: &JsRuntime,
    ) -> Result<Self, HostError> {
        Self::start_cancellable(services, runtime, || false)
    }

    pub(crate) fn start_cancellable(
        services: &SharedCoreServices,
        runtime: &JsRuntime,
        cancelled: impl Fn() -> bool,
    ) -> Result<Self, HostError> {
        if cancelled() {
            return Err(failure("traffic_launch_cancelled"));
        }
        let directory = tempfile::Builder::new()
            .prefix("codlet-traffic-")
            .tempdir()
            .map_err(|_| failure("traffic_directory_failed"))?;
        secure_directory(directory.path())?;
        let original = original_environment()?;
        let traffic = services
            .prepare_traffic()
            .map_err(|e| HostError::new(e.code, e.message))?;
        let endpoint = traffic
            .gateway_endpoint()
            .map_err(|e| HostError::new(e.code, e.message))?;
        let config = json!({"endpoint": endpoint, "directory": directory.path()});
        let invocation = runtime.prepare_traffic_worker(&config, directory.path())?;
        let (process, stdio) = OwnedPluginProcess::spawn(
            &invocation.executable,
            &invocation.arguments,
            &invocation.cwd,
            Some(&invocation.environment),
        )
        .map_err(|error| {
            #[cfg(target_os = "macos")]
            {
                crate::macos::host::spawn_failure("traffic_worker_spawn_failed", &error)
            }
            #[cfg(windows)]
            {
                let _ = error;
                failure("traffic_worker_spawn_failed")
            }
        })?;
        let mut owner = Self {
            traffic,
            process,
            _stdio: stdio,
            _invocation: invocation,
            directory,
            environment: Vec::new(),
            original_environment: original.clone(),
            descriptor: Value::Null,
            adapter: std::cell::RefCell::new(None),
            launch_arguments: Vec::new(),
            launch_provider: None,
            last_authorization_check: std::cell::Cell::new(None),
            stderr: None,
        };
        let deadline = Instant::now() + START_TIMEOUT;
        loop {
            if cancelled() {
                return Err(failure("traffic_launch_cancelled"));
            }
            owner.check_alive()?;
            if let Some(descriptor) = owner.traffic.launch_descriptor() {
                owner.environment = apply_descriptor(original, &descriptor)?;
                owner.descriptor = descriptor;
                return Ok(owner);
            }
            if Instant::now() >= deadline {
                return Err(failure("traffic_worker_timeout"));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub(crate) fn environment(&self) -> &[(OsString, OsString)] {
        &self.environment
    }

    pub(crate) fn prepare_adapter(
        &mut self,
        provider: &crate::plugins::LoadedPlugin,
        registry: &Path,
        runtime: &JsRuntime,
    ) -> Result<(), HostError> {
        let adapter = crate::client_launch::LaunchAdapter::start(
            provider,
            registry,
            runtime,
            self.directory.path(),
            self.descriptor.clone(),
            &self.original_environment,
        )?;
        self.launch_arguments = adapter.arguments().to_vec();
        self.adapter = std::cell::RefCell::new(Some(adapter));
        self.launch_provider = Some(crate::client_launch::LaunchAuthorization::new(
            provider, registry,
        )?);
        self.original_environment.clear();
        self.descriptor = Value::Null;
        self.stderr = Some(crate::client_stderr::ClientStderr::new()?);
        Ok(())
    }

    pub(crate) fn arguments(&self) -> &[OsString] {
        &self.launch_arguments
    }
    pub(crate) fn stderr(&self) -> &crate::client_stderr::ClientStderr {
        self.stderr
            .as_ref()
            .expect("private stderr prepared before spawning")
    }

    pub(crate) fn attach_client(
        &self,
        pid: u32,
        executable: &Path,
        cancelled: impl Fn() -> bool,
    ) -> Result<(), HostError> {
        self.check_alive()?;
        let deadline = Instant::now() + Duration::from_secs(10);
        let endpoint = self.stderr().endpoint(deadline, &cancelled)?;
        if cancelled() {
            return Err(failure("traffic_launch_cancelled"));
        }
        let adapter = self
            .adapter
            .borrow_mut()
            .take()
            .ok_or_else(|| failure("client_launch_adapter_required"))?;
        let activation = adapter.attach(&endpoint, pid, executable, deadline)?;
        drop(adapter);
        self.check_alive()?;
        self.traffic
            .set_source_activation(activation.activated, activation.unsupported);
        Ok(())
    }

    /// This records installation of the backend's launch configuration only.
    /// Electron net and NO_PROXY bypasses are not covered by environment routing.
    #[cfg(test)]
    pub(crate) fn client_launched(&self) -> Result<(), HostError> {
        self.check_alive()?;
        self.traffic.set_attached(true);
        Ok(())
    }

    pub(crate) fn check_alive(&self) -> Result<(), HostError> {
        if let Some(provider) = &self.launch_provider
            && self
                .last_authorization_check
                .get()
                .is_none_or(|last| last.elapsed() >= Duration::from_secs(1))
        {
            provider.check()?;
            self.last_authorization_check.set(Some(Instant::now()));
        }
        if self
            .process
            .wait(Duration::ZERO)
            .map_err(|_| failure("traffic_worker_wait_failed"))?
            .is_some()
        {
            self.traffic.set_attached(false);
            return Err(failure("traffic_worker_exited"));
        }
        Ok(())
    }
}

impl Drop for TrafficOwner {
    fn drop(&mut self) {
        self.traffic.set_attached(false);
        // The official client owner must retire before this owner. Terminate the
        // private worker job/group and reap it before deleting launch files.
        let _ = self.process.terminate();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if self.process.process_scope_is_empty().unwrap_or(false) {
                return;
            }
            let _ = self.process.wait(Duration::from_millis(10));
            std::thread::sleep(Duration::from_millis(10));
        }
        crate::runtime_log::error(
            "traffic_cleanup_incomplete",
            "The private traffic worker did not confirm process-scope retirement within its cleanup budget",
        );
    }
}

fn original_environment() -> Result<Vec<(OsString, OsString)>, HostError> {
    #[cfg(windows)]
    {
        crate::windows::environment::ChildEnvironment::inherited()
            .map(|e| e.entries_os())
            .map_err(|_| failure("traffic_environment_failed"))
    }
    #[cfg(target_os = "macos")]
    {
        Ok(std::env::vars_os().collect())
    }
}

fn apply_descriptor(
    original: Vec<(OsString, OsString)>,
    descriptor: &Value,
) -> Result<Vec<(OsString, OsString)>, HostError> {
    let invalid = || failure("traffic_launch_descriptor_invalid");
    let top = descriptor.as_object().ok_or_else(invalid)?;
    if top.len() != 2 || !top.contains_key("source") || !top.contains_key("environmentPatch") {
        return Err(invalid());
    }
    let source = descriptor["source"].as_object().ok_or_else(invalid)?;
    if source.len() != 6
        || source.get("version") != Some(&json!(1))
        || source.get("kind") != Some(&json!("plaintext"))
        || source.get("protocols") != Some(&json!(["http", "sse", "webSocket"]))
        || source.get("operations")
            != Some(&json!([
                "route.register",
                "route.update",
                "route.close",
                "http.intercept"
            ]))
    {
        return Err(invalid());
    }
    let endpoint = source["endpoint"].as_object().ok_or_else(invalid)?;
    let token = endpoint
        .get("token")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    if endpoint.len() != 3
        || endpoint.get("host") != Some(&json!("127.0.0.1"))
        || !endpoint
            .get("port")
            .and_then(Value::as_u64)
            .is_some_and(|port| (1..=65535).contains(&port))
        || !(32..=256).contains(&token.len())
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err(invalid());
    }
    let route_base = url::Url::parse(source["routeBaseUrl"].as_str().ok_or_else(invalid)?)
        .map_err(|_| invalid())?;
    let route_prefix = route_base.path().strip_prefix('/').ok_or_else(invalid)?;
    if route_base.scheme() != "http"
        || route_base.host_str() != Some("127.0.0.1")
        || route_base.port().is_none_or(|port| port == 0)
        || !route_base.username().is_empty()
        || route_base.password().is_some()
        || route_base.query().is_some()
        || route_base.fragment().is_some()
        || route_prefix.len() != 43
        || !route_prefix
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err(invalid());
    }
    let patch = &descriptor["environmentPatch"];
    if patch.as_object().is_none_or(|patch| patch.len() != 2) {
        return Err(invalid());
    }
    let set = patch["set"].as_object().ok_or_else(invalid)?;
    let remove = patch["removeCaseInsensitive"]
        .as_array()
        .ok_or_else(invalid)?;
    if !set.is_empty() || !remove.is_empty() {
        return Err(invalid());
    }
    Ok(original)
}

#[cfg(target_os = "macos")]
fn secure_directory(path: &Path) -> Result<(), HostError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
        .map_err(|_| failure("traffic_directory_failed"))
}

#[cfg(windows)]
fn secure_directory(path: &Path) -> Result<(), HostError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{
        DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, SetFileSecurityW,
    };
    let mut sid = crate::windows::launch_mutex::current_user_sid_bytes()
        .map_err(|_| failure("traffic_directory_failed"))?;
    let mut sid_text = std::ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(sid.as_mut_ptr().cast(), &mut sid_text) } == 0 {
        return Err(failure("traffic_directory_failed"));
    }
    let text = unsafe {
        let length = (0..).take_while(|i| *sid_text.add(*i) != 0).count();
        let text = String::from_utf16_lossy(std::slice::from_raw_parts(sid_text, length));
        LocalFree(sid_text.cast());
        text
    };
    let sddl: Vec<u16> = format!("D:P(A;OICI;FA;;;{text})")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut descriptor = std::ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(failure("traffic_directory_failed"));
    }
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let result = unsafe {
        SetFileSecurityW(
            path.as_ptr(),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor,
        )
    };
    unsafe {
        LocalFree(descriptor);
    }
    if result == 0 {
        Err(failure("traffic_directory_failed"))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entrance_requires_an_enabled_host_with_declared_and_explicitly_granted_interception() {
        use crate::plugins::{LoadedPlugin, LocalPluginRegistration, Permission};
        let mut plugin = LoadedPlugin {
            manifest: serde_json::from_value(json!({"schema":1,"id":"traffic-test","version":"1","host":{"entry":"host.js"},"permissions":["host.process","traffic.intercept"]})).unwrap(),
            authorization: None, source: None, host: None, generation: 1,
        };
        assert!(!required_for_plugins(&[]));
        assert!(!required_for_plugins(&[plugin.clone()]));
        plugin.authorization = Some(LocalPluginRegistration {
            grants: vec![Permission::HostProcess],
            ..Default::default()
        });
        assert!(!required_for_plugins(&[plugin.clone()]));
        plugin
            .authorization
            .as_mut()
            .unwrap()
            .grants
            .push(Permission::TrafficIntercept);
        assert!(required_for_plugins(&[plugin.clone()]));
        plugin
            .manifest
            .permissions
            .retain(|permission| *permission != Permission::TrafficIntercept);
        assert!(!required_for_plugins(&[plugin.clone()]));
        plugin
            .manifest
            .permissions
            .push(Permission::TrafficIntercept);
        plugin.manifest.host = None;
        assert!(!required_for_plugins(&[plugin]));
    }

    fn descriptor() -> Value {
        json!({"source":{"version":1,"kind":"plaintext","protocols":["http","sse","webSocket"],
            "operations":["route.register","route.update","route.close","http.intercept"],
            "endpoint":{"host":"127.0.0.1","port":49152,"token":"0123456789abcdef0123456789abcdef"},
            "routeBaseUrl":"http://127.0.0.1:49153/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"},
            "environmentPatch":{"set":{},"removeCaseInsensitive":[]}})
    }

    #[test]
    fn plaintext_descriptor_preserves_the_exact_original_environment() {
        let original: Vec<_> = [
            ("Http_Proxy", "http://old:password@example.invalid"),
            ("NO_PROXY", "local.test"),
            ("KEEP_UNICODE", "值"),
            ("CODEX_CA_CERTIFICATE", "old-ca.pem"),
        ]
        .into_iter()
        .map(|(k, v)| (OsString::from(k), OsString::from(v)))
        .collect();
        let environment = apply_descriptor(original.clone(), &descriptor()).unwrap();
        assert_eq!(environment, original);
    }

    #[test]
    fn plaintext_descriptor_rejects_environment_modification_or_remote_source() {
        let valid = descriptor();
        let mut extra = valid.clone();
        extra["environmentPatch"]["set"]["NODE_OPTIONS"] = json!("--require attacker");
        assert!(apply_descriptor(Vec::new(), &extra).is_err());
        let mut remove = valid.clone();
        remove["environmentPatch"]["removeCaseInsensitive"] = json!(["https_proxy"]);
        assert!(apply_descriptor(Vec::new(), &remove).is_err());
        let mut remote = valid.clone();
        remote["source"]["endpoint"]["host"] = json!("remote.invalid");
        assert!(apply_descriptor(Vec::new(), &remote).is_err());
        let mut remote_route = valid.clone();
        remote_route["source"]["routeBaseUrl"] =
            json!("http://remote.invalid:49153/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ");
        assert!(apply_descriptor(Vec::new(), &remote_route).is_err());
        let mut legacy = valid.clone();
        legacy["proxyUrl"] = json!("http://u:p@127.0.0.1:49152/");
        assert!(apply_descriptor(Vec::new(), &legacy).is_err());
        let mut false_coverage = valid;
        false_coverage["source"]["protocols"] = json!(["http", "sse", "webSocket", "http2"]);
        assert!(apply_descriptor(Vec::new(), &false_coverage).is_err());
    }

    #[test]
    fn fixed_worker_handshake_owns_environment_and_cleans_private_files() {
        let distribution = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_owned();
        let runtime = JsRuntime::from_distribution(&distribution)
            .expect("stage pinned runtime beside target/debug/codlet.exe");
        let directory = tempfile::tempdir().unwrap();
        let services = SharedCoreServices::new(&directory.path().join("plugins.json")).unwrap();
        let parent_before: Vec<_> = std::env::vars_os().collect();
        let owner = TrafficOwner::start(&services, &runtime).unwrap();
        let owned_directory = owner.directory.path().to_owned();
        assert_eq!(owner.environment(), owner.original_environment.as_slice());
        assert!(
            owner.descriptor["source"]["endpoint"]["token"]
                .as_str()
                .is_some()
        );
        owner.client_launched().unwrap();
        owner.check_alive().unwrap();
        assert_eq!(std::env::vars_os().collect::<Vec<_>>(), parent_before);
        drop(owner);
        assert!(!owned_directory.exists());
    }

    #[test]
    fn cancelled_start_and_dead_worker_never_report_a_live_attachment() {
        let distribution = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_owned();
        let runtime = JsRuntime::from_distribution(&distribution).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let services = SharedCoreServices::new(&directory.path().join("plugins.json")).unwrap();
        assert_eq!(
            TrafficOwner::start_cancellable(&services, &runtime, || true)
                .err()
                .unwrap()
                .code,
            "traffic_launch_cancelled"
        );
        let owner = TrafficOwner::start(&services, &runtime).unwrap();
        owner.process.terminate().unwrap();
        assert!(
            owner
                .process
                .wait(Duration::from_secs(2))
                .unwrap()
                .is_some()
        );
        assert_eq!(
            owner.client_launched().unwrap_err().code,
            "traffic_worker_exited"
        );
        let owned = owner.directory.path().to_owned();
        drop(owner);
        assert!(!owned.exists());
    }

    #[cfg(windows)]
    #[test]
    fn owned_fake_client_failure_retires_exact_handle_and_keeps_worker_until_exit() {
        use crate::cdp::CdpClient;
        use crate::windows::environment::ChildEnvironment;
        use crate::windows::process::{
            launch_with_cdp_pipes, launch_with_owned_traffic_environment,
        };
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{
            Foundation::WAIT_OBJECT_0, System::Threading::WaitForSingleObject,
        };
        let distribution = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_owned();
        let runtime = JsRuntime::from_distribution(&distribution).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let services = SharedCoreServices::new(&directory.path().join("plugins.json")).unwrap();
        let owner = TrafficOwner::start(&services, &runtime).unwrap();
        let executable = distribution.join("codlet-fake-child.exe");
        let arguments = [OsString::from("--scenario=lab-environment")];
        let (unrelated, unrelated_pipes) =
            launch_with_cdp_pipes(&executable, &arguments, true).unwrap();
        let (unrelated_client, _) = CdpClient::spawn(unrelated_pipes).unwrap();
        unrelated_client
            .request("Fake.environment", None, None, Duration::from_secs(3))
            .unwrap();
        let environment =
            ChildEnvironment::from_entries(owner.environment().iter().cloned()).unwrap();
        let (child, pipes) =
            launch_with_owned_traffic_environment(&executable, &arguments, &environment).unwrap();
        owner.client_launched().unwrap();
        let handle = child.owned_handle().try_clone().unwrap();
        let (client, _) = CdpClient::spawn(pipes).unwrap();
        let report = client
            .request("Fake.environment", None, None, Duration::from_secs(3))
            .unwrap()
            .result
            .unwrap();
        for name in [
            "HTTPS_PROXY",
            "HTTP_PROXY",
            "NO_PROXY",
            "CODEX_CA_CERTIFICATE",
        ] {
            let inherited = owner
                .environment()
                .iter()
                .find(|(key, _)| key.to_string_lossy().eq_ignore_ascii_case(name));
            let actual = report["environment"]
                .as_object()
                .unwrap()
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .and_then(|(_, value)| value.as_str());
            assert_eq!(
                actual,
                inherited.and_then(|(_, value)| value.to_str()),
                "{name}"
            );
        }
        drop(child); // Simulated failure after spawn; no ambient process lookup.
        assert_eq!(
            unsafe { WaitForSingleObject(handle.as_raw_handle().cast(), 0) },
            WAIT_OBJECT_0
        );
        owner.check_alive().unwrap();
        assert!(owner.directory.path().exists());
        assert_eq!(unrelated.wait(Duration::ZERO).unwrap(), None);
        unrelated_client
            .request("Browser.close", None, None, Duration::from_secs(3))
            .unwrap();
        assert_eq!(unrelated.wait(Duration::from_secs(3)).unwrap(), Some(0));
        let _ = client.shutdown();
        unrelated_client.shutdown().unwrap();
        let owned_directory = owner.directory.path().to_owned();
        drop(owner);
        assert!(!owned_directory.exists());
    }

    #[cfg(windows)]
    #[test]
    fn normally_exited_owned_client_does_not_kill_independent_updater_descendant() {
        use crate::cdp::CdpClient;
        use crate::windows::environment::ChildEnvironment;
        use crate::windows::process::launch_with_owned_traffic_environment;
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::{
            Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
            System::Threading::{
                OpenProcess, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, TerminateProcess,
                WaitForSingleObject,
            },
        };
        struct Updater(OwnedHandle);
        impl Drop for Updater {
            fn drop(&mut self) {
                unsafe {
                    TerminateProcess(self.0.as_raw_handle().cast(), 0);
                    WaitForSingleObject(self.0.as_raw_handle().cast(), 2000);
                }
            }
        }
        let distribution = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_owned();
        let (child, pipes) = launch_with_owned_traffic_environment(
            &distribution.join("codlet-fake-child.exe"),
            &["--scenario=lab-environment-updater".into()],
            &ChildEnvironment::inherited().unwrap(),
        )
        .unwrap();
        let (client, _) = CdpClient::spawn(pipes).unwrap();
        let report = client
            .request("Fake.environment", None, None, Duration::from_secs(3))
            .unwrap()
            .result
            .unwrap();
        let pid = report["updaterPid"].as_u64().unwrap() as u32;
        let raw = unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, pid) };
        assert!(!raw.is_null());
        let updater = Updater(unsafe { OwnedHandle::from_raw_handle(raw.cast()) });
        let client_handle = child.owned_handle().try_clone().unwrap();
        client
            .request("Browser.close", None, None, Duration::from_secs(3))
            .unwrap();
        assert_eq!(child.wait(Duration::from_secs(3)).unwrap(), Some(0));
        drop(child);
        assert_eq!(
            unsafe { WaitForSingleObject(client_handle.as_raw_handle().cast(), 0) },
            WAIT_OBJECT_0
        );
        assert_eq!(
            unsafe { WaitForSingleObject(updater.0.as_raw_handle().cast(), 0) },
            WAIT_TIMEOUT
        );
        client.shutdown().unwrap();
        drop(updater);
    }
}
