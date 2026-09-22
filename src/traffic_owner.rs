//! Native owner for the fixed traffic worker and its per-client trust files.
//! Launch configuration is private process data; errors never print it.
use crate::core_services::{SharedCoreServices, traffic::Traffic};
use crate::js_runtime::{JsInvocation, JsRuntime};
use crate::platform::host::{OwnedPluginProcess, PluginStdio};
use crate::plugin_host::HostError;
use serde_json::{Value, json};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const START_TIMEOUT: Duration = Duration::from_secs(15);
const TRUST_OUTPUT: &str = "CODEX_CA_CERTIFICATE";

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
        let trust_inputs = selected_trust_inputs(&original)?;
        let traffic = services
            .prepare_traffic()
            .map_err(|e| HostError::new(e.code, e.message))?;
        let endpoint = traffic
            .gateway_endpoint()
            .map_err(|e| HostError::new(e.code, e.message))?;
        let config = json!({"endpoint": endpoint, "directory": directory.path(), "trustInputs": trust_inputs, "trustOutputs": [TRUST_OUTPUT]});
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
                owner.environment =
                    apply_descriptor(original, &descriptor, owner.directory.path())?;
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
        adapter.attach(&endpoint, pid, executable, deadline)?;
        drop(adapter);
        self.check_alive()?;
        self.traffic.set_attached(true);
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
        // private worker job/group and reap it before deleting trust/config files.
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

fn selected_trust_inputs(environment: &[(OsString, OsString)]) -> Result<Vec<PathBuf>, HostError> {
    for name in [TRUST_OUTPUT, "SSL_CERT_FILE"] {
        if let Some((_, value)) = environment.iter().find(|(key, value)| {
            key.to_string_lossy().eq_ignore_ascii_case(name) && !value.is_empty()
        }) {
            let path = PathBuf::from(value);
            if !path.is_absolute() {
                return Err(failure("traffic_trust_input_invalid"));
            }
            return Ok(vec![path]);
        }
    }
    Ok(Vec::new())
}

fn apply_descriptor(
    mut original: Vec<(OsString, OsString)>,
    descriptor: &Value,
    directory: &Path,
) -> Result<Vec<(OsString, OsString)>, HostError> {
    let invalid = || failure("traffic_launch_descriptor_invalid");
    let proxy_text = descriptor["proxyUrl"].as_str().ok_or_else(invalid)?;
    let proxy = url::Url::parse(proxy_text).map_err(|_| invalid())?;
    if proxy.scheme() != "http"
        || proxy.host_str() != Some("127.0.0.1")
        || proxy.port().is_none()
        || proxy.username().is_empty()
        || proxy.password().is_none_or(str::is_empty)
        || proxy.path() != "/"
        || proxy.query().is_some()
        || proxy.fragment().is_some()
    {
        return Err(invalid());
    }
    let bundle = PathBuf::from(descriptor["bundlePath"].as_str().ok_or_else(invalid)?);
    if !bundle.is_absolute()
        || bundle.file_name().is_none_or(|n| n != "ca.pem")
        || !bundle.starts_with(directory)
    {
        return Err(invalid());
    }
    let canonical = bundle.canonicalize().map_err(|_| invalid())?;
    if !canonical.starts_with(directory.canonicalize().map_err(|_| invalid())?)
        || !canonical.is_file()
    {
        return Err(invalid());
    }
    let allowed = [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        TRUST_OUTPUT,
    ];
    let patch = &descriptor["environmentPatch"];
    let set = patch["set"].as_object().ok_or_else(invalid)?;
    let remove = patch["removeCaseInsensitive"]
        .as_array()
        .ok_or_else(invalid)?;
    let expected_remove = [
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "codex_ca_certificate",
    ];
    if set.len() != allowed.len()
        || remove.len() != expected_remove.len()
        || expected_remove
            .iter()
            .any(|name| !remove.iter().any(|v| v.as_str() == Some(name)))
    {
        return Err(invalid());
    }
    for name in allowed {
        let value = set.get(name).and_then(Value::as_str).ok_or_else(invalid)?;
        let expected = if name == TRUST_OUTPUT {
            bundle.to_str().ok_or_else(invalid)?
        } else {
            proxy_text
        };
        if value != expected || value.contains('\0') {
            return Err(invalid());
        }
    }
    if descriptor["trust"]["outputs"] != json!([TRUST_OUTPUT])
        || descriptor["trust"]["inheritedInputsMerged"] != true
        || descriptor["trust"]["systemStoreModified"] != false
        || descriptor["bypass"] != "preserve-original-no-proxy"
    {
        return Err(invalid());
    }
    original.retain(|(key, _)| {
        !expected_remove
            .iter()
            .any(|name| key.to_string_lossy().eq_ignore_ascii_case(name))
    });
    original.extend(
        set.iter()
            .map(|(key, value)| (OsString::from(key), OsString::from(value.as_str().unwrap()))),
    );
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

    fn descriptor(directory: &Path) -> Value {
        let bundle = directory.join("ca.pem");
        std::fs::write(&bundle, b"synthetic public certificate").unwrap();
        let proxy = "http://synthetic:secret@127.0.0.1:49152/";
        json!({"proxyUrl":proxy,"bundlePath":bundle,"environmentPatch":{
            "set":{"HTTP_PROXY":proxy,"HTTPS_PROXY":proxy,"ALL_PROXY":proxy,"http_proxy":proxy,"https_proxy":proxy,"all_proxy":proxy,"CODEX_CA_CERTIFICATE":bundle},
            "removeCaseInsensitive":["http_proxy","https_proxy","all_proxy","codex_ca_certificate"]},
            "trust":{"outputs":[TRUST_OUTPUT],"inheritedInputsMerged":true,"systemStoreModified":false},"bypass":"preserve-original-no-proxy"})
    }

    #[test]
    fn launch_patch_preserves_original_bypass_and_unrelated_environment() {
        let directory = tempfile::tempdir().unwrap();
        let original = [
            ("Http_Proxy", "http://old:password@example.invalid"),
            ("NO_PROXY", "local.test"),
            ("KEEP_UNICODE", "值"),
            (TRUST_OUTPUT, "old-ca.pem"),
        ]
        .into_iter()
        .map(|(k, v)| (OsString::from(k), OsString::from(v)))
        .collect();
        let environment =
            apply_descriptor(original, &descriptor(directory.path()), directory.path()).unwrap();
        assert!(environment.contains(&("NO_PROXY".into(), "local.test".into())));
        assert!(environment.contains(&("KEEP_UNICODE".into(), "值".into())));
        assert!(!environment.iter().any(|(key, _)| key == "Http_Proxy"));
        assert_eq!(
            environment
                .iter()
                .filter(|(key, _)| key == TRUST_OUTPUT)
                .count(),
            1
        );
        assert_eq!(environment.len(), 9);
    }

    #[test]
    fn launch_patch_rejects_extra_variables_remote_proxy_and_escaped_bundle() {
        let directory = tempfile::tempdir().unwrap();
        let valid = descriptor(directory.path());
        let mut extra = valid.clone();
        extra["environmentPatch"]["set"]["NODE_OPTIONS"] = json!("--require attacker");
        assert!(apply_descriptor(Vec::new(), &extra, directory.path()).is_err());
        let mut remote = valid.clone();
        remote["proxyUrl"] = json!("http://u:p@remote.invalid:80/");
        assert!(apply_descriptor(Vec::new(), &remote, directory.path()).is_err());
        let outside = tempfile::tempdir().unwrap();
        let escaped = descriptor(outside.path());
        assert!(apply_descriptor(Vec::new(), &escaped, directory.path()).is_err());
        let mut false_claim = valid;
        false_claim["trust"]["systemStoreModified"] = json!(true);
        assert!(apply_descriptor(Vec::new(), &false_claim, directory.path()).is_err());
    }

    #[test]
    fn official_backend_trust_precedence_is_explicit() {
        let primary = std::env::temp_dir().join("primary.pem");
        let fallback = std::env::temp_dir().join("fallback.pem");
        let environment = vec![
            ("SSL_CERT_FILE".into(), fallback.as_os_str().to_owned()),
            (TRUST_OUTPUT.into(), primary.as_os_str().to_owned()),
        ];
        assert_eq!(selected_trust_inputs(&environment).unwrap(), vec![primary]);
        assert_eq!(
            selected_trust_inputs(&environment[..1]).unwrap(),
            vec![fallback]
        );
        assert!(selected_trust_inputs(&[(TRUST_OUTPUT.into(), "relative.pem".into())]).is_err());
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
        let bundle = owner
            .environment()
            .iter()
            .find(|(key, _)| key == TRUST_OUTPUT)
            .unwrap()
            .1
            .clone();
        assert!(Path::new(&bundle).is_file());
        owner.client_launched().unwrap();
        owner.check_alive().unwrap();
        assert_eq!(std::env::vars_os().collect::<Vec<_>>(), parent_before);
        drop(owner);
        assert!(!owned_directory.exists());
        assert!(!Path::new(&bundle).exists());
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
        let bundle = report["environment"][TRUST_OUTPUT].as_str().unwrap();
        assert!(Path::new(bundle).is_file());
        assert!(
            report["environment"]["HTTPS_PROXY"]
                .as_str()
                .is_some_and(|v| v.starts_with("http://"))
        );
        drop(child); // Simulated failure after spawn; no ambient process lookup.
        assert_eq!(
            unsafe { WaitForSingleObject(handle.as_raw_handle().cast(), 0) },
            WAIT_OBJECT_0
        );
        owner.check_alive().unwrap();
        assert!(Path::new(bundle).is_file());
        assert_eq!(unrelated.wait(Duration::ZERO).unwrap(), None);
        unrelated_client
            .request("Browser.close", None, None, Duration::from_secs(3))
            .unwrap();
        assert_eq!(unrelated.wait(Duration::from_secs(3)).unwrap(), Some(0));
        let _ = client.shutdown();
        unrelated_client.shutdown().unwrap();
        drop(owner);
        assert!(!Path::new(bundle).exists());
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
