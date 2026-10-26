//! Client-owned transport. Plugin source participates in package transactions.
use crate::js_runtime::{JsInvocation, JsRuntime};
use crate::platform::host::{OwnedPluginProcess, PluginStdio};
use crate::plugin_host::HostError;
use crate::plugins::LoadedPlugin;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
#[cfg(all(test, windows))]
mod tests;
fn error(code: &'static str) -> HostError {
    HostError::new(
        code,
        "The owned client bridge could not complete its bounded operation",
    )
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Endpoint {
    version: u32,
    host: String,
    port: u16,
    token: String,
    pid: u32,
    executable: String,
    #[serde(rename = "type")]
    kind: String,
}
impl Endpoint {
    fn validate(&self, pid: u32, executable: &Path) -> Result<(), HostError> {
        let expected = executable
            .canonicalize()
            .map_err(|_| error("client_bridge_identity_invalid"))?;
        let observed = Path::new(&self.executable)
            .canonicalize()
            .map_err(|_| error("client_bridge_identity_invalid"))?;
        if self.version != 1
            || self.host != "127.0.0.1"
            || self.port == 0
            || self.token.len() != 48
            || !self.token.bytes().all(|b| b.is_ascii_hexdigit())
            || self.pid != pid
            || self.kind != "browser"
            || observed != expected
        {
            return Err(error("client_bridge_identity_invalid"));
        }
        Ok(())
    }
}
pub(crate) struct Bootstrap {
    process: OwnedPluginProcess,
    stdio: PluginStdio,
    _invocation: JsInvocation,
    context: Value,
}
impl Bootstrap {
    pub(crate) fn start(
        runtime: &JsRuntime,
        directory: &Path,
        traffic: Value,
        selection: Option<Value>,
        owned_fixture_routes: bool,
    ) -> Result<Self, HostError> {
        let invocation = runtime.prepare_client_bridge(directory)?;
        let (process, stdio) = OwnedPluginProcess::spawn(
            &invocation.executable,
            &invocation.arguments,
            &invocation.cwd,
            Some(&invocation.environment),
        )
        .map_err(|_| error("client_bridge_spawn_failed"))?;
        let bootstrap = Self {
            process,
            stdio,
            _invocation: invocation,
            context: json!({"traffic":traffic,"selection":selection,"ownedFixtureRoutes":owned_fixture_routes}),
        };
        bootstrap.call(
            "prepare",
            bootstrap.context.clone(),
            Instant::now() + Duration::from_secs(10),
        )?;
        Ok(bootstrap)
    }
    #[cfg(windows)]
    pub(crate) fn before_resume(
        &self,
        pid: u32,
        executable: &Path,
        deadline: Instant,
    ) -> Result<Option<crate::windows::client_bootstrap::ModuleDataPlan>, HostError> {
        let mut context = self.context.clone();
        context["expectedPid"] = json!(pid);
        context["executable"] = json!(executable);
        let result = self.call("beforeResume", context, deadline)?;
        if result["moduleData"].is_null() {
            return Ok(None);
        }
        crate::windows::client_bootstrap::ModuleDataPlan::parse(result["moduleData"].clone())
            .map(Some)
            .map_err(|e| error(e.code))
    }
    pub(crate) fn attach(
        &self,
        url: &str,
        pid: u32,
        executable: &Path,
        deadline: Instant,
    ) -> Result<(Endpoint, Value), HostError> {
        let mut context = self.context.clone();
        context["inspectorUrl"] = json!(url);
        context["expectedPid"] = json!(pid);
        context["executable"] = json!(executable);
        let result = self.call("attach", context, deadline)?;
        if result["installed"] != true || result["exactChildVerified"] != true {
            return Err(error("client_bridge_unconfirmed"));
        }
        let endpoint: Endpoint = serde_json::from_value(result["bridge"].clone())
            .map_err(|_| error("client_bridge_identity_invalid"))?;
        endpoint.validate(pid, executable)?;
        if let Some(code) = result["sourceError"].as_str().filter(|code| {
            !code.is_empty()
                && code.len() <= 80
                && code
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
        }) {
            crate::runtime_log::error("client_source_not_ready", code);
            eprintln!("client-source-not-ready: reason={code}");
        }
        Ok((endpoint, result["activation"].clone()))
    }
    fn call(&self, phase: &str, context: Value, deadline: Instant) -> Result<Value, HostError> {
        let mut data = serde_json::to_vec(&json!({"phase":phase,"context":context}))
            .map_err(|_| error("client_bridge_protocol"))?;
        data.push(b'\n');
        self.stdio
            .stdin
            .write_all(&data, deadline)
            .map_err(|_| error("client_bridge_timeout"))?;
        let mut result = Vec::new();
        let mut buffer = [0; 4096];
        loop {
            let n = self
                .stdio
                .stdout
                .read_some(&mut buffer, Some(deadline))
                .map_err(|_| error("client_bridge_timeout"))?;
            if n == 0 || result.len() + n > 64 * 1024 {
                return Err(error("client_bridge_protocol"));
            }
            result.extend_from_slice(&buffer[..n]);
            if result.last() == Some(&b'\n') {
                let reply: Value =
                    serde_json::from_slice(&result).map_err(|_| error("client_bridge_protocol"))?;
                if reply["ok"] != true {
                    let code = reply["code"].as_str().filter(|code| {
                        !code.is_empty()
                            && code.len() <= 80
                            && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
                    });
                    return Err(HostError::new(
                        "client_bridge_bootstrap_failed",
                        format!(
                            "Client bridge bootstrap failed: {}",
                            code.unwrap_or("unspecified")
                        ),
                    ));
                }
                return Ok(reply["result"].clone());
            }
        }
    }
}
impl Drop for Bootstrap {
    fn drop(&mut self) {
        let _ = self.process.terminate();
        let _ = self.process.wait(Duration::from_secs(2));
    }
}

#[derive(Clone)]
pub(crate) struct ClientSourceRuntime(Arc<SourceOwner>);
struct SourceOwner {
    endpoint: Endpoint,
    runtime: JsRuntime,
    registry: PathBuf,
    directory: tempfile::TempDir,
    configuration: Value,
    state: Mutex<State>,
    traffic: crate::core_services::traffic::Traffic,
    _lease: TcpStream,
}
struct State {
    epoch: u64,
    provider: Option<LoadedPlugin>,
    admission: Option<CoreAdmission>,
    core_pending: Option<(String, u64)>,
    #[cfg(all(windows, feature = "desktop-acceptance"))]
    fixture_route: Option<(String, String)>,
}
struct CoreAdmission {
    id: String,
    begin_operation: String,
    epoch: u64,
    token: Option<String>,
    release: Option<CoreAdmissionOutcome>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum CoreAdmissionOutcome {
    Applied,
    RolledBack,
}

fn acquire_lease(endpoint: &Endpoint, deadline: Instant) -> Result<TcpStream, HostError> {
    // Native can still be synchronously loading its entry modules when the
    // private listener is created. Honor the caller's startup deadline instead
    // of imposing a shorter lease deadline while that same startup is in flight.
    let remaining = || {
        let wait = deadline.saturating_duration_since(Instant::now());
        if wait.is_zero() {
            Err(error("client_bridge_lease_timeout"))
        } else {
            Ok(wait)
        }
    };
    let io_error = |failure: std::io::Error| {
        error(
            if matches!(
                failure.kind(),
                std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
            ) {
                "client_bridge_lease_timeout"
            } else {
                "client_bridge_lease_unavailable"
            },
        )
    };
    let mut lease = TcpStream::connect_timeout(
        &SocketAddrV4::new(Ipv4Addr::LOCALHOST, endpoint.port).into(),
        remaining()?.min(Duration::from_secs(2)),
    )
    .map_err(io_error)?;
    lease
        .set_write_timeout(Some(remaining()?))
        .map_err(io_error)?;
    let mut bytes = serde_json::to_vec(&json!({"op":"lease","token":endpoint.token}))
        .map_err(|_| error("client_bridge_protocol"))?;
    bytes.push(b'\n');
    lease.write_all(&bytes).map_err(io_error)?;
    let mut response = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        lease
            .set_read_timeout(Some(remaining()?))
            .map_err(io_error)?;
        let count = lease.read(&mut buffer).map_err(io_error)?;
        if count == 0 {
            return Err(error("client_bridge_lease_unavailable"));
        }
        if response.len() + count > 65536 {
            return Err(error("client_bridge_protocol"));
        }
        response.extend_from_slice(&buffer[..count]);
        if let Some(end) = response.iter().position(|byte| *byte == b'\n') {
            if end != response.len() - 1 {
                return Err(error("client_bridge_protocol"));
            }
            response.pop();
            break;
        }
    }
    let result: Value =
        serde_json::from_slice(&response).map_err(|_| error("client_bridge_protocol"))?;
    if result["ok"] != true
        || result["result"]["leased"] != true
        || result["result"]["pid"] != endpoint.pid
    {
        return Err(error("client_bridge_identity_invalid"));
    }
    lease.set_read_timeout(None).map_err(io_error)?;
    Ok(lease)
}

impl ClientSourceRuntime {
    #[cfg(windows)]
    pub(crate) fn official_update_target(&self) -> Result<Value, HostError> {
        self.request(json!({"op":"officialUpdateTarget"}))
    }
    #[cfg(windows)]
    pub(crate) fn install_official_update(
        &self,
        operation: &str,
        target: &str,
    ) -> Result<Value, HostError> {
        self.operation_receipt(
            operation,
            Some(json!({"op":"officialUpdateInstall","operationId":operation,"targetId":target})),
        )
    }
    pub(crate) fn same_owner(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
    #[cfg(all(windows, feature = "desktop-acceptance"))]
    pub(crate) fn install_owned_fixture_route(
        &self,
        id: &str,
        upstream: &str,
    ) -> Result<Value, HostError> {
        let mut state = self
            .0
            .state
            .lock()
            .map_err(|_| error("client_bridge_owner_poisoned"))?;
        let operation = format!("fixture-route.{id}");
        let command = if let Some((previous, base)) = &state.fixture_route {
            if previous != &operation || base != upstream {
                return Err(error("core_fixture_route_already_used"));
            }
            None
        } else {
            state.fixture_route = Some((operation.clone(), upstream.into()));
            Some(
                json!({"op":"ownedFixtureRoute","operationId":operation,"expectedEpoch":state.epoch,"upstreamBaseUrl":upstream}),
            )
        };
        let receipt = self
            .operation_receipt(&operation, command)
            .map_err(|_| error("client_bridge_uncertain"))?;
        if receipt["outcome"] != "fixture_route_registered" {
            return Err(error("core_fixture_route_rejected"));
        }
        Ok(receipt)
    }
    fn operation_receipt(
        &self,
        operation: &str,
        command: Option<Value>,
    ) -> Result<Value, HostError> {
        let mut result = match command {
            Some(command) => match self.request(command) {
                Ok(result) => result,
                Err(failure) if failure.code == "client_bridge_uncertain" => {
                    self.request(json!({"op":"status","operationId":operation}))?
                }
                Err(failure) => return Err(failure),
            },
            None => self.request(json!({"op":"status","operationId":operation}))?,
        };
        let deadline = Instant::now() + Duration::from_secs(12);
        while result["pending"] == true && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
            result = self.request(json!({"op":"status","operationId":operation}))?;
        }
        if result["pending"] == true || result["unknown"] == true {
            return Err(error("client_bridge_uncertain"));
        }
        Ok(result)
    }
    /// Hold the retained Native transport before renderer/Host snapshots. On
    /// uncertainty the ID remains reserved; callers query it instead of replay.
    pub(crate) fn begin_core_admission(&self, operation_id: &str) -> Result<Value, HostError> {
        if operation_id.is_empty()
            || operation_id.len() > 96
            || !operation_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
        {
            return Err(error("core_admission_id_invalid"));
        }
        let mut state = self
            .0
            .state
            .lock()
            .map_err(|_| error("client_bridge_owner_poisoned"))?;
        let command = if let Some(held) = &state.admission {
            if held.id != operation_id {
                return Err(error("core_admission_owner_busy"));
            }
            None
        } else {
            let observed = self.request(json!({"op":"status"}))?;
            if observed["epoch"].as_u64() != Some(state.epoch)
                || observed["onlineUpdate"]["admissionVersion"] != 1
            {
                return Err(error("core_admission_unavailable"));
            }
            let operation = format!("admission.{operation_id}");
            state.admission = Some(CoreAdmission {
                id: operation_id.into(),
                begin_operation: operation.clone(),
                epoch: state.epoch,
                token: None,
                release: None,
            });
            Some(json!({"op":"beginAdmission","operationId":operation,"expectedEpoch":state.epoch}))
        };
        let operation = state
            .admission
            .as_ref()
            .expect("held admission")
            .begin_operation
            .clone();
        let mut result = self.operation_receipt(&operation, command)?;
        self.remember_admission(&mut state, &result)?;
        if result["outcome"] != "held" {
            return Err(error("core_admission_writes_unsettled"));
        }
        if let Some(receipt) = result.as_object_mut() {
            receipt.remove("admissionToken");
        }
        if let Some(held) = result
            .pointer_mut("/onlineUpdate/admission")
            .and_then(Value::as_object_mut)
        {
            held.remove("token");
            held.remove("admissionToken");
        }
        Ok(result)
    }
    fn remember_admission(&self, state: &mut State, result: &Value) -> Result<(), HostError> {
        let held = state
            .admission
            .as_mut()
            .ok_or_else(|| error("core_admission_owner_changed"))?;
        let observed = self.request(json!({"op":"status"}))?;
        if observed["onlineUpdate"]["admission"]["operationId"] != held.begin_operation {
            state.admission = None;
            return Err(error("core_admission_owner_changed"));
        }
        let token = result["admissionToken"]
            .as_str()
            .filter(|token| {
                token.len() == 36
                    && token
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
            })
            .ok_or_else(|| error("client_bridge_uncertain"))?;
        if result["epoch"].as_u64() != Some(held.epoch)
            || !["held", "blocked"].contains(&result["outcome"].as_str().unwrap_or_default())
        {
            return Err(error("client_bridge_uncertain"));
        }
        held.token = Some(token.into());
        Ok(())
    }
    /// Resume only after the coordinator confirms all selected renderer/Host
    /// owners. Unknown outcomes keep this exact lease for Core-owned writes.
    pub(crate) fn finish_core_admission(
        &self,
        operation_id: &str,
        outcome: CoreAdmissionOutcome,
    ) -> Result<Value, HostError> {
        let mut state = self
            .0
            .state
            .lock()
            .map_err(|_| error("client_bridge_owner_poisoned"))?;
        let held = state
            .admission
            .as_ref()
            .filter(|held| held.id == operation_id)
            .ok_or_else(|| error("core_admission_owner_changed"))?;
        if held.token.is_none() {
            let operation = held.begin_operation.clone();
            let receipt = self.operation_receipt(&operation, None)?;
            self.remember_admission(&mut state, &receipt)?;
        }
        if let Some((operation, before)) = state.core_pending.clone() {
            let result = self.operation_receipt(&operation, None)?;
            self.settle_core_receipt(&mut state, before, result)?;
        }
        let current_epoch = state.epoch;
        let held = state.admission.as_mut().expect("checked admission");
        let operation = format!("release.{}", held.id);
        let command = if let Some(previous) = held.release {
            if previous != outcome {
                return Err(error("core_admission_disposition_changed"));
            }
            None
        } else {
            held.release = Some(outcome);
            Some(
                json!({"op":"finishAdmission","operationId":operation,"expectedEpoch":current_epoch,"admissionId":held.begin_operation,"admissionToken":held.token,"disposition":match outcome{CoreAdmissionOutcome::Applied=>"applied",CoreAdmissionOutcome::RolledBack=>"rolled_back"}}),
            )
        };
        let result = self
            .operation_receipt(&operation, command)
            .map_err(|_| error("client_bridge_uncertain"))?;
        if result["outcome"] != "admission_resumed" || result["epoch"].as_u64() != Some(state.epoch)
        {
            return Err(error("core_admission_release_unconfirmed"));
        }
        state.admission = None;
        Ok(result)
    }
    /// Query the original admission release once. This never issues a release.
    /// If finish is still waiting for begin/source, the coordinator may advance
    /// finish with the same ID and disposition to issue its first release.
    pub(crate) fn poll_core_admission_release(
        &self,
        operation_id: &str,
    ) -> Result<Option<Value>, HostError> {
        let mut state = self
            .0
            .state
            .lock()
            .map_err(|_| error("client_bridge_owner_poisoned"))?;
        let held = state
            .admission
            .as_ref()
            .filter(|held| held.id == operation_id)
            .ok_or_else(|| error("core_admission_owner_changed"))?;
        if held.release.is_none() {
            return Err(error("core_admission_release_not_started"));
        }
        let Some(result) = self.query_original_receipt(&format!("release.{}", held.id)) else {
            return Ok(None);
        };
        if result["outcome"] != "admission_resumed" || result["epoch"].as_u64() != Some(state.epoch)
        {
            return Err(error("client_bridge_uncertain"));
        }
        state.admission = None;
        Ok(Some(result))
    }
    fn query_original_receipt(&self, operation: &str) -> Option<Value> {
        let result = self
            .request(json!({"op":"status","operationId":operation}))
            .ok()?;
        (result["pending"] != true && result["unknown"] != true).then_some(result)
    }
    /// Query the saved source replacement once, without evaluating or sending
    /// candidate code again. The retained lease survives pending/late replies.
    pub(crate) fn poll_core_code_receipt(&self) -> Result<Option<Value>, HostError> {
        let mut state = self
            .0
            .state
            .lock()
            .map_err(|_| error("client_bridge_owner_poisoned"))?;
        let (operation, before) = state
            .core_pending
            .clone()
            .ok_or_else(|| error("core_receipt_missing"))?;
        let Some(result) = self.query_original_receipt(&operation) else {
            return Ok(None);
        };
        self.settle_core_receipt(&mut state, before, result)
            .map(Some)
    }
    fn settle_core_receipt(
        &self,
        state: &mut State,
        before: u64,
        result: Value,
    ) -> Result<Value, HostError> {
        let expected = match result["outcome"].as_str() {
            Some("rejected") => Some(before),
            Some("applied" | "rolled_back" | "degraded") => before.checked_add(1),
            _ => None,
        };
        if expected.is_none() || result["epoch"].as_u64() != expected {
            return Err(error("client_bridge_uncertain"));
        }
        if result["outcome"] == "applied" {
            let activation = crate::client_launch::validate_client_source_activation(
                &result["activation"],
                &self.0.configuration["source"],
            )
            .map_err(|_| error("client_bridge_uncertain"))?;
            self.0
                .traffic
                .set_source_activation(activation.activated, activation.unsupported);
        }
        state.epoch = expected.expect("checked epoch");
        state.core_pending = None;
        Ok(result)
    }
    pub(crate) fn confirm_core_code(&self, code: &str) -> Result<Value, HostError> {
        use sha2::{Digest, Sha256};
        let observed = self.request(json!({"op":"status"}))?;
        if observed["sourceSha256"] != format!("{:x}", Sha256::digest(code.as_bytes())) {
            return Err(error("core_source_takeover_unconfirmed"));
        }
        Ok(observed)
    }
    pub(crate) fn preflight_core_source(&self, code: &str) -> Result<(), HostError> {
        let state = self
            .0
            .state
            .lock()
            .map_err(|_| error("client_bridge_owner_poisoned"))?;
        let result =
            self.request(json!({"op":"preflightCore","expectedEpoch":state.epoch,"code":code}))?;
        if result["outcome"] != "preflight_passed" || result["epoch"].as_u64() != Some(state.epoch)
        {
            return Err(error("core_update_preflight_failed"));
        }
        Ok(())
    }
    pub(crate) fn check_core_module_syntax(&self, paths: &[PathBuf]) -> Result<(), HostError> {
        use std::ffi::OsString;
        // Compile only: expression modules are inserted as factory values by
        // the renderer bootstrap; CommonJS modules use the Node wrapper.
        // A standalone statement can parse yet fail at the factory boundary.
        const CHECK: &str = "const fs=require('node:fs'),vm=require('node:vm'),Module=require('node:module');const file=process.argv[1],source=fs.readFileSync(file,'utf8');new vm.Script(file.endsWith('.js')?'(\\n'+source+'\\n)':Module.wrap(source),{filename:file});";
        let environment: Vec<(OsString, OsString)> = std::env::vars_os()
            .filter(|(key, _)| {
                let name = key.to_string_lossy().to_ascii_uppercase();
                !name.starts_with("NODE_")
                    && !name.starts_with("OPENSSL_")
                    && !name.starts_with("DYLD_")
                    && name != "ELECTRON_RUN_AS_NODE"
            })
            .collect();
        for path in paths {
            let (process, _stdio) = OwnedPluginProcess::spawn(
                self.0.runtime.executable_path(),
                &[
                    "--no-addons".into(),
                    "--no-global-search-paths".into(),
                    "-e".into(),
                    CHECK.into(),
                    "--".into(),
                    path.to_string_lossy().into_owned(),
                ],
                self.0.directory.path(),
                Some(&environment),
            )
            .map_err(|_| error("core_module_preflight_unavailable"))?;
            match process.wait(Duration::from_secs(5)) {
                Ok(Some(0)) => {}
                _ => {
                    let _ = process.terminate();
                    let _ = process.wait(Duration::from_secs(2));
                    return Err(error("core_module_syntax_invalid"));
                }
            }
        }
        Ok(())
    }
    /// Apply a verified Core-owned JS component without closing the Native
    /// transport lease or its Rust traffic owner. The old owner remains live on
    /// preflight failure; uncertain mutations are resolved by receipt lookup.
    pub(crate) fn replace_core_code(&self, code: &str, version: &str) -> Result<Value, HostError> {
        let mut state = self
            .0
            .state
            .lock()
            .map_err(|_| error("client_bridge_owner_poisoned"))?;
        if state.core_pending.is_some() {
            return Err(error("client_bridge_uncertain"));
        }
        let observed = self.request(json!({"op":"status"}))?;
        if observed["epoch"].as_u64() != Some(state.epoch) {
            return Err(error("client_bridge_stale_epoch"));
        }
        static CORE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let operation = format!(
            "core-update-{}-{}",
            std::process::id(),
            CORE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        let owner = observed["owner"].as_str().unwrap_or("codlet.core");
        let generation = observed["generation"].as_u64().unwrap_or(1);
        let mut command = json!({"op":"replace","operationId":operation,"expectedEpoch":state.epoch,
            "previousOwner":observed["owner"],"owner":owner,"generation":generation,"code":code,
            "configuration":self.0.configuration,"compatibleUpdate":true,"coreVersion":version});
        if let Some(held) = &state.admission {
            let token = held
                .token
                .as_ref()
                .ok_or_else(|| error("client_bridge_uncertain"))?;
            command["admissionId"] = json!(held.begin_operation);
            command["admissionToken"] = json!(token);
        }
        state.core_pending = Some((operation.clone(), state.epoch));
        let result = self
            .operation_receipt(&operation, Some(command))
            .map_err(|_| error("client_bridge_uncertain"))?;
        let before = state.epoch;
        let result = self.settle_core_receipt(&mut state, before, result)?;
        Ok(result)
    }

    pub(crate) fn new(
        endpoint: Endpoint,
        runtime: JsRuntime,
        registry: PathBuf,
        configuration: Value,
        provider: Option<LoadedPlugin>,
        traffic: crate::core_services::traffic::Traffic,
        deadline: Instant,
    ) -> Result<Self, HostError> {
        let directory = tempfile::Builder::new()
            .prefix("codlet-client-source-")
            .tempdir()
            .map_err(|_| error("client_bridge_directory"))?;
        crate::traffic_owner::secure_directory(directory.path())?;
        let lease = acquire_lease(&endpoint, deadline)?;
        Ok(Self(Arc::new(SourceOwner {
            endpoint,
            runtime,
            registry,
            directory,
            configuration,
            state: Mutex::new(State {
                epoch: 0,
                provider,
                admission: None,
                core_pending: None,
                #[cfg(all(windows, feature = "desktop-acceptance"))]
                fixture_route: None,
            }),
            traffic,
            _lease: lease,
        })))
    }
    pub(crate) fn complete_startup(
        &self,
        provider: Option<&LoadedPlugin>,
    ) -> Result<bool, HostError> {
        let until = Instant::now() + Duration::from_secs(45);
        let mut observed = match self.request_until(
            json!({"op":"ready","operationId":"startup-ready","expectedEpoch":0}),
            until,
        ) {
            Ok(result) => Some(result),
            Err(error) if error.code == "client_bridge_uncertain" => None,
            Err(error) => return Err(error),
        };
        let result = loop {
            if let Some(result) = observed.take()
                && result["pending"] != true
                && result["unknown"] != true
            {
                break result;
            }
            let remaining = until.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(error("client_bridge_uncertain"));
            }
            // Native can synchronously provision its first-run runtime after
            // accepting readiness. Query that receipt through transient pauses;
            // never replay the initializer or discard its still-owned lease.
            std::thread::sleep(remaining.min(Duration::from_millis(25)));
            observed = match self
                .request_until(json!({"op":"status","operationId":"startup-ready"}), until)
            {
                Ok(result) => Some(result),
                Err(error) if error.code == "client_bridge_uncertain" => None,
                Err(error) => return Err(error),
            };
        };
        if result["outcome"] != "applied" || result["epoch"] != 0 {
            return Err(error("client_bridge_protocol"));
        }
        let selected = if result["owner"].is_null() {
            None
        } else {
            Some(
                provider
                    .filter(|provider| {
                        result["owner"] == provider.manifest.id
                            && result["generation"] == provider.generation
                    })
                    .ok_or_else(|| error("client_bridge_identity_invalid"))?,
            )
        };
        let activation = crate::client_launch::validate_client_source_activation(
            &result["activation"],
            &self.0.configuration["source"],
        )?;
        let supported = result["activation"]["installed"] == true;
        if supported != selected.is_some() {
            return Err(error("client_bridge_protocol"));
        }
        self.0
            .state
            .lock()
            .map_err(|_| error("client_bridge_owner_poisoned"))?
            .provider = selected.cloned();
        if let Some(provider) = selected
            && let Err(authority) =
                crate::client_launch::validate_source_authority(provider, &self.0.registry)
        {
            self.replace(None)?;
            return Err(authority);
        }
        if let Some(code) = result["sourceError"].as_str().filter(|code| {
            !code.is_empty()
                && code.len() <= 80
                && code
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
        }) {
            crate::runtime_log::error("client_source_not_ready", code);
            eprintln!("client-source-not-ready: reason={code}");
        }
        self.0
            .traffic
            .set_source_activation(activation.activated, activation.unsupported);
        Ok(supported)
    }
    pub(crate) fn replace(&self, plugin: Option<&LoadedPlugin>) -> Result<Value, HostError> {
        let mut state = self
            .0
            .state
            .lock()
            .map_err(|_| error("client_bridge_owner_poisoned"))?;
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let operation = crate::local_import::digest(&(
            self.0.endpoint.pid,
            state.epoch,
            plugin.map(|p| (&p.manifest.id, p.generation)),
            SEQUENCE.fetch_add(1, Ordering::Relaxed),
        ));
        let mut command = json!({"op":if plugin.is_some(){"replace"}else{"clear"},"operationId":operation,"expectedEpoch":state.epoch,"previousOwner":state.provider.as_ref().map(|p|&p.manifest.id)});
        if let Some(plugin) = plugin {
            let code = crate::client_launch::source_snapshot(
                plugin,
                &self.0.registry,
                &self.0.runtime,
                self.0.directory.path(),
            )?;
            command["owner"] = json!(plugin.manifest.id);
            command["generation"] = json!(plugin.generation);
            command["code"] = code["code"].clone();
            command["configuration"] = self.0.configuration.clone();
            command["configuration"]["deadlineUnixMs"] = json!(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64
                    + 10000
            );
        }
        let result = match self.request(command) {
            Ok(result) => result,
            Err(uncertain) if uncertain.code == "client_bridge_uncertain" => {
                let until = Instant::now() + Duration::from_secs(3);
                loop {
                    let observed = self.request(json!({"op":"status","operationId":operation}));
                    match observed {
                        Ok(result) if result["pending"] != true && result["unknown"] != true => {
                            break result;
                        }
                        Ok(result) if result["pending"] == true && Instant::now() < until => {
                            std::thread::sleep(Duration::from_millis(25));
                        }
                        _ => {
                            self.invalidate();
                            state.provider = None;
                            return Err(uncertain);
                        }
                    }
                }
            }
            Err(failure) => {
                if matches!(
                    failure.code,
                    "client_bridge_protocol" | "client_bridge_identity_invalid"
                ) {
                    self.invalidate();
                    state.provider = None;
                }
                return Err(failure);
            }
        };
        let outcome = result["outcome"].as_str().unwrap_or_default();
        let valid_epoch = match outcome {
            "rejected" => Some(state.epoch),
            "applied" | "rolled_back" | "degraded" => state.epoch.checked_add(1),
            _ => None,
        };
        let observed_provider = if result["owner"].is_null() {
            Some(None)
        } else {
            plugin
                .into_iter()
                .chain(state.provider.iter())
                .find(|provider| {
                    result["owner"] == provider.manifest.id
                        && result["generation"] == provider.generation
                })
                .cloned()
                .map(Some)
        };
        let activation = crate::client_launch::validate_client_source_activation(
            &result["activation"],
            &self.0.configuration["source"],
        );
        if valid_epoch.is_none()
            || result["epoch"].as_u64() != valid_epoch
            || observed_provider.is_none()
            || activation.is_err()
        {
            self.invalidate();
            state.provider = None;
            return Err(error("client_bridge_protocol"));
        }
        state.epoch = valid_epoch.expect("checked epoch");
        state.provider = observed_provider.expect("checked provider");
        let activation = activation.expect("checked activation");
        self.0
            .traffic
            .set_source_activation(activation.activated, activation.unsupported);
        if let Some(provider) = state.provider.clone()
            && let Err(authority) =
                crate::client_launch::validate_source_authority(&provider, &self.0.registry)
        {
            let cleared = self.request(json!({"op":"clear","operationId":format!("revoke-{operation}"),"expectedEpoch":state.epoch,"previousOwner":provider.manifest.id}));
            if let Ok(cleared) = cleared
                && cleared["outcome"] == "applied"
                && cleared["owner"].is_null()
                && cleared["epoch"].as_u64() == state.epoch.checked_add(1)
            {
                state.epoch += 1;
            } else {
                self.invalidate();
            }
            state.provider = None;
            self.0.traffic.set_source_activation(json!([]), json!([]));
            return Err(authority);
        }
        if outcome != "applied" {
            let code = result["error"].as_str().filter(|code| {
                !code.is_empty()
                    && code.len() <= 80
                    && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
            });
            return Err(HostError::new(
                "client_bridge_activation_failed",
                format!(
                    "Client source change failed: {}",
                    code.unwrap_or("unspecified")
                ),
            ));
        }
        if state
            .provider
            .as_ref()
            .map(|provider| (&provider.manifest.id, provider.generation))
            != plugin.map(|provider| (&provider.manifest.id, provider.generation))
        {
            self.invalidate();
            state.provider = None;
            return Err(error("client_bridge_protocol"));
        }
        let activation = result["activation"].clone();
        Ok(activation)
    }
    fn invalidate(&self) {
        let _ = self.0._lease.shutdown(std::net::Shutdown::Both);
        self.0.traffic.set_source_activation(json!([]), json!([]));
    }
    pub(crate) fn affects(&self, affected: &std::collections::BTreeSet<String>) -> bool {
        self.0.state.lock().is_ok_and(|state| {
            state
                .provider
                .as_ref()
                .is_some_and(|plugin| affected.contains(&plugin.manifest.id))
        })
    }
    pub(crate) fn retire_if_affected(
        &self,
        affected: &std::collections::BTreeSet<String>,
    ) -> Result<Value, HostError> {
        if self.affects(affected) {
            self.replace(None)
        } else {
            Ok(Value::Null)
        }
    }
    fn request(&self, command: Value) -> Result<Value, HostError> {
        self.request_until(command, Instant::now() + Duration::from_secs(16))
    }
    fn request_until(&self, mut command: Value, deadline: Instant) -> Result<Value, HostError> {
        let remaining = |limit: Duration| {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                Err(error("client_bridge_uncertain"))
            } else {
                Ok(remaining.min(limit))
            }
        };
        command["token"] = json!(self.0.endpoint.token);
        let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, self.0.endpoint.port);
        let mut stream =
            TcpStream::connect_timeout(&address.into(), remaining(Duration::from_secs(2))?)
                .map_err(|_| error("client_bridge_disconnected"))?;
        stream
            .set_write_timeout(Some(remaining(Duration::from_secs(2))?))
            .map_err(|_| error("client_bridge_disconnected"))?;
        let mut bytes =
            serde_json::to_vec(&command).map_err(|_| error("client_bridge_protocol"))?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err(error("client_bridge_protocol"));
        }
        bytes.push(b'\n');
        stream
            .write_all(&bytes)
            .map_err(|_| error("client_bridge_uncertain"))?;
        let mut reply = Vec::new();
        let mut stream = stream.take(65537);
        let mut buffer = [0; 4096];
        loop {
            stream
                .get_ref()
                .set_read_timeout(Some(remaining(Duration::from_secs(12))?))
                .map_err(|_| error("client_bridge_disconnected"))?;
            let count = stream
                .read(&mut buffer)
                .map_err(|_| error("client_bridge_uncertain"))?;
            if count == 0 {
                break;
            }
            reply.extend_from_slice(&buffer[..count]);
        }
        let result: Value =
            serde_json::from_slice(&reply).map_err(|_| error("client_bridge_uncertain"))?;
        if result["ok"] != true {
            return Err(error("client_bridge_operation_failed"));
        }
        if result["result"]["pending"] != true
            && result["result"]["unknown"] != true
            && result["result"]["pid"] != self.0.endpoint.pid
        {
            return Err(error("client_bridge_identity_invalid"));
        }
        Ok(result["result"].clone())
    }
}
