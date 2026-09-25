//! Native consumer of the optional, explicitly granted Host launch ABI.
use crate::capabilities::CapabilityScope;
use crate::js_runtime::{JsInvocation, JsRuntime};
use crate::platform::host::{OwnedPluginProcess, PluginStdio};
use crate::plugin_host::HostError;
use crate::plugins::{LoadedPlugin, Permission, PluginRegistry};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub(crate) const CAPABILITY: &str = "codlet.client.launch";
fn error(code: &'static str) -> HostError {
    HostError::new(
        code,
        "The explicitly authorized client launch adapter could not complete its bounded private handshake",
    )
}

pub(crate) fn select(plugins: &[LoadedPlugin]) -> Result<&LoadedPlugin, HostError> {
    let mut providers = plugins.iter().filter(|plugin| {
        plugin.manifest.host_provides().iter().any(|capability| {
            capability.name.as_str() == CAPABILITY
                && capability.api.get() == 1
                && capability.scope == CapabilityScope::Runtime
        })
    });
    let provider = providers.next().ok_or_else(|| HostError::new("client_launch_adapter_required", "Enable and authorize one matching codlet.client.launch@1 Host adapter before enabling traffic interception"))?;
    if providers.next().is_some() {
        return Err(error("client_launch_adapter_conflict"));
    }
    if provider.host.is_none()
        || ![Permission::HostProcess, Permission::CdpRaw]
            .iter()
            .all(|permission| {
                provider.manifest.permissions.contains(permission)
                    && provider
                        .authorization
                        .as_ref()
                        .is_some_and(|record| record.grants.contains(permission))
            })
    {
        return Err(error("client_launch_adapter_denied"));
    }
    Ok(provider)
}

pub(crate) struct LaunchAdapter {
    provider: LoadedPlugin,
    registry: PathBuf,
    process: OwnedPluginProcess,
    stdio: PluginStdio,
    _invocation: JsInvocation,
    context: Value,
    arguments: Vec<OsString>,
}

pub(crate) struct LaunchAuthorization {
    id: String,
    registration: crate::plugins::LocalPluginRegistration,
    registry: PathBuf,
}

#[derive(Debug)]
pub(crate) struct SourceActivation {
    pub(crate) activated: Value,
    pub(crate) unsupported: Value,
}

impl LaunchAuthorization {
    pub(crate) fn new(provider: &LoadedPlugin, registry: &Path) -> Result<Self, HostError> {
        Ok(Self {
            id: provider.manifest.id.clone(),
            registration: provider
                .authorization
                .clone()
                .ok_or_else(|| error("client_launch_adapter_denied"))?,
            registry: registry.into(),
        })
    }
    pub(crate) fn check(&self) -> Result<(), HostError> {
        let registry = PluginRegistry::load(&self.registry)
            .map_err(|_| error("client_launch_authorization_unavailable"))?;
        if !registry.is_enabled(&self.id)
            || registry.local_plugins().get(&self.id) != Some(&self.registration)
        {
            return Err(error("client_launch_authorization_revoked"));
        }
        Ok(())
    }
}

impl LaunchAdapter {
    pub(crate) fn start(
        provider: &LoadedPlugin,
        registry: &Path,
        runtime: &JsRuntime,
        directory: &Path,
        traffic: Value,
        original: &[(OsString, OsString)],
    ) -> Result<Self, HostError> {
        revalidate(provider, registry)?;
        let invocation = runtime.prepare_client_launch(
            provider
                .host
                .as_ref()
                .ok_or_else(|| error("client_launch_adapter_denied"))?,
            directory,
        )?;
        let original: serde_json::Map<String, Value> = original
            .iter()
            .map(|(key, value)| {
                Ok((
                    key.to_str()
                        .ok_or_else(|| error("client_launch_environment_invalid"))?
                        .to_owned(),
                    Value::String(
                        value
                            .to_str()
                            .ok_or_else(|| error("client_launch_environment_invalid"))?
                            .to_owned(),
                    ),
                ))
            })
            .collect::<Result<_, HostError>>()?;
        let context = json!({"traffic": traffic, "originalEnvironment": original});
        let (process, stdio) = OwnedPluginProcess::spawn(
            &invocation.executable,
            &invocation.arguments,
            &invocation.cwd,
            Some(&invocation.environment),
        )
        .map_err(|cause| {
            #[cfg(target_os = "macos")]
            {
                crate::macos::host::spawn_failure("client_launch_adapter_spawn_failed", &cause)
            }
            #[cfg(windows)]
            {
                let _ = cause;
                error("client_launch_adapter_spawn_failed")
            }
        })?;
        let mut adapter = Self {
            provider: provider.clone(),
            registry: registry.into(),
            process,
            stdio,
            _invocation: invocation,
            context,
            arguments: Vec::new(),
        };
        let plan = adapter.call(
            "prepare",
            adapter.context.clone(),
            Instant::now() + Duration::from_secs(10),
        )?;
        adapter.arguments = validate_arguments(&plan)?;
        revalidate(&adapter.provider, &adapter.registry)?;
        Ok(adapter)
    }

    pub(crate) fn arguments(&self) -> &[OsString] {
        &self.arguments
    }

    pub(crate) fn attach(
        &self,
        inspector_url: &str,
        pid: u32,
        executable: &Path,
        deadline: Instant,
    ) -> Result<SourceActivation, HostError> {
        revalidate(&self.provider, &self.registry)?;
        let mut context = self.context.clone();
        context["inspectorUrl"] = json!(inspector_url);
        context["expectedPid"] = json!(pid);
        context["executable"] = json!(executable);
        let reply = self.call("attach", context, deadline)?;
        let activation = validate_activation(&reply, &self.context["traffic"]["source"])?;
        revalidate(&self.provider, &self.registry)?;
        Ok(activation)
    }

    fn call(&self, phase: &str, context: Value, deadline: Instant) -> Result<Value, HostError> {
        let mut request = serde_json::to_vec(&json!({"phase":phase,"context":context}))
            .map_err(|_| error("client_launch_adapter_protocol"))?;
        if request.len() >= 512 * 1024 {
            return Err(error("client_launch_adapter_protocol"));
        }
        request.push(b'\n');
        self.stdio
            .stdin
            .write_all(&request, deadline)
            .map_err(|_| error("client_launch_adapter_timeout"))?;
        let mut reply = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let count = self
                .stdio
                .stdout
                .read_some(&mut buffer, Some(deadline))
                .map_err(|_| error("client_launch_adapter_timeout"))?;
            if count == 0 || reply.len() + count > 16 * 1024 {
                return Err(error("client_launch_adapter_protocol"));
            }
            reply.extend_from_slice(&buffer[..count]);
            if let Some(end) = reply.iter().position(|b| *b == b'\n') {
                if end != reply.len() - 1 {
                    return Err(error("client_launch_adapter_protocol"));
                }
                let value: Value = serde_json::from_slice(&reply[..end])
                    .map_err(|_| error("client_launch_adapter_protocol"))?;
                if value["ok"] != true {
                    return Err(error("client_launch_adapter_failed"));
                }
                return Ok(value["result"].clone());
            }
        }
    }
}

impl Drop for LaunchAdapter {
    fn drop(&mut self) {
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
            "client_launch_cleanup_incomplete",
            "Private launch adapter process-scope retirement was not confirmed within its cleanup budget",
        );
    }
}

pub(crate) fn revalidate(provider: &LoadedPlugin, registry: &Path) -> Result<(), HostError> {
    let registry = PluginRegistry::load(registry)
        .map_err(|_| error("client_launch_authorization_unavailable"))?;
    if !registry.is_enabled(&provider.manifest.id)
        || provider.authorization.as_ref().is_none_or(|record| {
            registry.local_plugins().get(&provider.manifest.id) != Some(record)
        })
    {
        return Err(error("client_launch_authorization_revoked"));
    }
    Ok(())
}

fn validate_arguments(plan: &Value) -> Result<Vec<OsString>, HostError> {
    const INSPECTOR: &str = "--inspect-brk=127.0.0.1:0";
    let arguments = plan["arguments"]
        .as_array()
        .ok_or_else(|| error("client_launch_arguments_denied"))?;
    if arguments.len() != 1 || arguments[0].as_str() != Some(INSPECTOR) {
        return Err(error("client_launch_arguments_denied"));
    }
    Ok(vec![OsString::from(INSPECTOR)])
}

fn validate_activation(reply: &Value, source: &Value) -> Result<SourceActivation, HostError> {
    let invalid = || error("client_launch_adapter_unconfirmed");
    let object = reply.as_object().ok_or_else(invalid)?;
    if reply["installed"] != true
        || reply["exactChildVerified"] != true
        || object.keys().any(|key| {
            ![
                "installed",
                "exactChildVerified",
                "activatedSources",
                "unsupportedSources",
            ]
            .contains(&key.as_str())
        })
    {
        return Err(invalid());
    }
    let activated = reply["activatedSources"].as_array().ok_or_else(invalid)?;
    let unsupported = match reply.get("unsupportedSources") {
        Some(value) => value.as_array().ok_or_else(invalid)?,
        None => return Err(invalid()),
    };
    if activated.is_empty() || activated.len() > 8 || unsupported.len() > 8 {
        return Err(invalid());
    }
    let offered_operations = source["operations"].as_array().ok_or_else(invalid)?;
    let offered_protocols = source["protocols"].as_array().ok_or_else(invalid)?;
    let mut ids = BTreeSet::new();
    for entry in activated {
        let record = entry.as_object().ok_or_else(invalid)?;
        if record.len() != 4
            || !record.contains_key("id")
            || !record.contains_key("operations")
            || !record.contains_key("protocols")
            || !record.contains_key("coverage")
        {
            return Err(invalid());
        }
        let id = entry["id"]
            .as_str()
            .filter(|id| label(id))
            .ok_or_else(invalid)?;
        if !ids.insert(id) {
            return Err(invalid());
        }
        for (field, offered) in [
            ("operations", offered_operations),
            ("protocols", offered_protocols),
        ] {
            let values = entry[field]
                .as_array()
                .filter(|values| !values.is_empty() && values.len() <= offered.len())
                .ok_or_else(invalid)?;
            let mut seen = BTreeSet::new();
            for value in values {
                let value = value.as_str().ok_or_else(invalid)?;
                if !offered
                    .iter()
                    .any(|allowed| allowed.as_str() == Some(value))
                    || !seen.insert(value)
                {
                    return Err(invalid());
                }
            }
        }
        let coverage = entry["coverage"]
            .as_array()
            .filter(|values| !values.is_empty() && values.len() <= 8)
            .ok_or_else(invalid)?;
        let mut seen = BTreeSet::new();
        for value in coverage {
            let value = value
                .as_str()
                .filter(|value| label(value))
                .ok_or_else(invalid)?;
            if !seen.insert(value) {
                return Err(invalid());
            }
        }
    }
    for entry in unsupported {
        let record = entry.as_object().ok_or_else(invalid)?;
        if record.len() != 2 || !record.contains_key("id") || !record.contains_key("reason") {
            return Err(invalid());
        }
        let id = entry["id"]
            .as_str()
            .filter(|id| label(id))
            .ok_or_else(invalid)?;
        if !ids.insert(id)
            || !matches!(
                entry["reason"].as_str(),
                Some(
                    "unsupported_build"
                        | "hook_unavailable"
                        | "child_unavailable"
                        | "route_unavailable"
                        | "timeout"
                )
            )
        {
            return Err(invalid());
        }
    }
    Ok(SourceActivation {
        activated: Value::Array(activated.clone()),
        unsupported: Value::Array(unsupported.clone()),
    })
}

fn label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::LocalPluginRegistration;

    const SOURCE: &str = r#"
exports.prepareClientLaunch = () => ({arguments:['--inspect-brk=127.0.0.1:0']});
exports.attachClientLaunch = ({expectedPid, executable, inspectorUrl}) => {
 if (!Number.isInteger(expectedPid) || expectedPid < 1 || !executable || !inspectorUrl.startsWith('ws://127.0.0.1:')) throw Error('identity');
 return {installed:true,exactChildVerified:true,activatedSources:[{id:'test-http',operations:['http.intercept'],protocols:['http'],coverage:['test-http-path']}],unsupportedSources:[{id:'test-ws',reason:'hook_unavailable'}]};
};
"#;

    fn fixture() -> (tempfile::TempDir, PathBuf, LoadedPlugin, JsRuntime) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        std::fs::write(root.join("host.cjs"), SOURCE).unwrap();
        std::fs::write(root.join("codlet.json"), json!({"schema":1,"id":"test.launch-adapter","version":"1","host":{"entry":"host.cjs"},"permissions":["host.process","cdp.raw"],"provides":[{"name":CAPABILITY,"api":1,"scope":"runtime"}]}).to_string()).unwrap();
        let registry_path = root.join("registry.json");
        let mut registry = PluginRegistry::load(&registry_path).unwrap();
        let registration = LocalPluginRegistration {
            path: root,
            grants: vec![Permission::HostProcess, Permission::CdpRaw],
            ..Default::default()
        };
        registry
            .register_local("test.launch-adapter", registration.clone())
            .unwrap();
        registry.set_enabled("test.launch-adapter", true).unwrap();
        registry.save().unwrap();
        let provider = crate::local_plugins::load_local_plugin_with_registration(
            "test.launch-adapter",
            &registration,
            1,
        )
        .unwrap();
        let distribution = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_owned();
        let runtime = JsRuntime::from_distribution(&distribution).unwrap();
        (directory, registry_path, provider, runtime)
    }

    fn traffic() -> Value {
        json!({"source":{"version":1,"kind":"plaintext","operations":["route.register","route.update","route.close","http.intercept"],"protocols":["http","sse","webSocket"],"endpoint":{"host":"127.0.0.1","port":49152,"token":"0123456789abcdef0123456789abcdef"},"routeBaseUrl":"http://127.0.0.1:49153/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"},"environmentPatch":{"set":{},"removeCaseInsensitive":[]}})
    }

    #[test]
    fn provider_uses_existing_host_grants_and_rejects_ambiguity() {
        let (_, _, provider, _) = fixture();
        assert!(select(&[]).is_err());
        assert!(select(std::slice::from_ref(&provider)).is_ok());
        assert!(select(&[provider.clone(), provider.clone()]).is_err());
        let mut revoked = provider;
        revoked
            .authorization
            .as_mut()
            .unwrap()
            .grants
            .retain(|p| *p != Permission::CdpRaw);
        assert!(select(&[revoked]).is_err());
    }

    #[test]
    fn launch_plan_requires_only_the_exact_private_inspector_flag() {
        let accepted =
            validate_arguments(&json!({"arguments":["--inspect-brk=127.0.0.1:0"]})).unwrap();
        assert_eq!(accepted, vec![OsString::from("--inspect-brk=127.0.0.1:0")]);
        assert!(validate_arguments(&json!({"arguments":[]})).is_err());
        assert!(validate_arguments(
            &json!({"arguments":["--inspect-brk=127.0.0.1:0","--proxy-bypass-list=<-loopback>"]})
        )
        .is_err());
    }

    #[test]
    fn launch_plan_rejects_ambient_inspectors_and_unsafe_flags() {
        for args in [
            vec!["--ignore-certificate-errors"],
            vec!["--inspect-brk=0.0.0.0:9229"],
            vec!["--inspect=127.0.0.1:9229"],
            vec!["--no-sandbox"],
        ] {
            assert!(validate_arguments(&json!({"arguments":args})).is_err());
        }
    }

    #[test]
    fn activation_requires_explicit_bounded_per_source_coverage() {
        let descriptor = traffic();
        let source = &descriptor["source"];
        let valid = json!({"installed":true,"exactChildVerified":true,"activatedSources":[{"id":"example-http","operations":["route.register","route.update","route.close","http.intercept"],"protocols":["http","sse"],"coverage":["example-fetch-path"]}],"unsupportedSources":[{"id":"example-backend","reason":"child_unavailable"}]});
        assert_eq!(
            validate_activation(&valid, source)
                .unwrap()
                .activated
                .as_array()
                .unwrap()
                .len(),
            1
        );
        for change in [
            json!({"installed":true,"exactChildVerified":true,"activatedSources":[],"unsupportedSources":[]}),
            json!({"installed":true,"exactChildVerified":true,"configuredSessions":1,"activatedSources":valid["activatedSources"],"unsupportedSources":valid["unsupportedSources"]}),
            json!({"installed":true,"exactChildVerified":true,"activatedSources":[{"id":"example-http","operations":["tls.bypass"],"protocols":["http"],"coverage":["all"]}],"unsupportedSources":[]}),
            json!({"installed":true,"exactChildVerified":true,"activatedSources":[{"id":"example-http","operations":["http.intercept"],"protocols":["http2"],"coverage":["all"]}],"unsupportedSources":[]}),
            json!({"installed":true,"exactChildVerified":true,"activatedSources":valid["activatedSources"],"unsupportedSources":[{"id":"example-http","reason":"child_unavailable"}]}),
            json!({"installed":true,"exactChildVerified":true,"activatedSources":valid["activatedSources"],"unsupportedSources":[{"id":"example-backend","reason":"arbitrary message"}]}),
        ] {
            assert!(validate_activation(&change, source).is_err(), "{change}");
        }
    }

    #[test]
    fn fixed_wrapper_executes_snapshot_and_rechecks_full_registration_between_phases() {
        let (directory, registry, provider, runtime) = fixture();
        // On-disk edits do not replace the checked generation's source.
        std::fs::write(
            provider.host.as_ref().unwrap().entry.clone(),
            "throw Error('edited');",
        )
        .unwrap();
        let adapter = LaunchAdapter::start(
            &provider,
            &registry,
            &runtime,
            directory.path(),
            traffic(),
            &[],
        )
        .unwrap();
        assert_eq!(adapter.arguments().len(), 1);
        adapter
            .attach(
                "ws://127.0.0.1:49152/12345678-abcd-1234-abcd-123456789abc",
                123,
                &std::env::current_exe().unwrap(),
                Instant::now() + Duration::from_secs(2),
            )
            .unwrap();
        drop(adapter);
        let adapter = LaunchAdapter::start(
            &provider,
            &registry,
            &runtime,
            directory.path(),
            traffic(),
            &[],
        )
        .unwrap();
        let mut changed = PluginRegistry::load(&registry).unwrap();
        changed.set_enabled(&provider.manifest.id, false).unwrap();
        changed.save().unwrap();
        assert_eq!(
            adapter
                .attach(
                    "ws://127.0.0.1:49152/12345678-abcd-1234-abcd-123456789abc",
                    123,
                    &std::env::current_exe().unwrap(),
                    Instant::now() + Duration::from_secs(2)
                )
                .unwrap_err()
                .code,
            "client_launch_authorization_revoked"
        );
    }

    #[cfg(windows)]
    #[test]
    fn native_owner_completes_private_handshake_and_reaps_temporary_adapter() {
        use crate::core_services::SharedCoreServices;
        use crate::traffic_owner::TrafficOwner;
        use crate::windows::{
            environment::ChildEnvironment, process::launch_with_owned_traffic_capture,
        };
        let (directory, registry, provider, runtime) = fixture();
        let services = SharedCoreServices::new(&registry).unwrap();
        let mut owner = TrafficOwner::start(&services).unwrap();
        owner
            .prepare_adapter(&provider, &registry, &runtime)
            .unwrap();
        let executable = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("codlet-fake-child.exe");
        // A synthetic endpoint exercises transport and owner lifetime. It does
        // not count as Electron protocol or real-request acceptance evidence.
        let (child, pipes) = launch_with_owned_traffic_capture(
            &executable,
            &["--scenario=lab-inspector".into()],
            &ChildEnvironment::from_entries(owner.environment().iter().cloned()).unwrap(),
            owner.stderr(),
        )
        .unwrap();
        owner
            .attach_client(child.process_id(), &executable, || false)
            .unwrap();
        owner.check_alive().unwrap();
        assert!(!std::fs::read_dir(directory.path()).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("launch-adapter-")
        }));
        let (client, _) = crate::cdp::CdpClient::spawn(pipes).unwrap();
        client
            .request("Fake.environment", None, None, Duration::from_secs(2))
            .unwrap();
        client
            .request("Browser.close", None, None, Duration::from_secs(2))
            .unwrap();
        assert_eq!(child.wait(Duration::from_secs(2)).unwrap(), Some(0));
        client.shutdown().unwrap();
        let mut changed = PluginRegistry::load(&registry).unwrap();
        changed.set_enabled(&provider.manifest.id, false).unwrap();
        changed.save().unwrap();
        std::thread::sleep(Duration::from_millis(1050));
        assert_eq!(
            owner.check_alive().unwrap_err().code,
            "client_launch_authorization_revoked"
        );
    }
}
