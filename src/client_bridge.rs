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
            context: json!({"traffic":traffic,"selection":selection}),
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
}
impl ClientSourceRuntime {
    pub(crate) fn new(
        endpoint: Endpoint,
        runtime: JsRuntime,
        registry: PathBuf,
        configuration: Value,
        provider: Option<LoadedPlugin>,
        traffic: crate::core_services::traffic::Traffic,
    ) -> Result<Self, HostError> {
        let directory = tempfile::Builder::new()
            .prefix("codlet-client-source-")
            .tempdir()
            .map_err(|_| error("client_bridge_directory"))?;
        crate::traffic_owner::secure_directory(directory.path())?;
        let mut lease = TcpStream::connect_timeout(
            &SocketAddrV4::new(Ipv4Addr::LOCALHOST, endpoint.port).into(),
            Duration::from_secs(2),
        )
        .map_err(|_| error("client_bridge_disconnected"))?;
        lease
            .set_read_timeout(Some(Duration::from_secs(2)))
            .map_err(|_| error("client_bridge_disconnected"))?;
        let mut bytes = serde_json::to_vec(&json!({"op":"lease","token":endpoint.token}))
            .map_err(|_| error("client_bridge_protocol"))?;
        bytes.push(b'\n');
        lease
            .write_all(&bytes)
            .map_err(|_| error("client_bridge_disconnected"))?;
        let mut response = Vec::new();
        let mut byte = [0];
        while response.len() < 65536 {
            lease
                .read_exact(&mut byte)
                .map_err(|_| error("client_bridge_disconnected"))?;
            if byte[0] == b'\n' {
                break;
            }
            response.push(byte[0]);
        }
        let result: Value =
            serde_json::from_slice(&response).map_err(|_| error("client_bridge_protocol"))?;
        if result["ok"] != true
            || result["result"]["leased"] != true
            || result["result"]["pid"] != endpoint.pid
        {
            return Err(error("client_bridge_identity_invalid"));
        }
        Ok(Self(Arc::new(SourceOwner {
            endpoint,
            runtime,
            registry,
            directory,
            configuration,
            state: Mutex::new(State { epoch: 0, provider }),
            traffic,
            _lease: lease,
        })))
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
    fn request(&self, mut command: Value) -> Result<Value, HostError> {
        command["token"] = json!(self.0.endpoint.token);
        let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, self.0.endpoint.port);
        let mut stream = TcpStream::connect_timeout(&address.into(), Duration::from_secs(2))
            .map_err(|_| error("client_bridge_disconnected"))?;
        stream
            .set_read_timeout(Some(Duration::from_secs(12)))
            .map_err(|_| error("client_bridge_disconnected"))?;
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
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
        stream
            .take(65537)
            .read_to_end(&mut reply)
            .map_err(|_| error("client_bridge_uncertain"))?;
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
