//! Native consumer of the optional, explicitly granted Host launch ABI.
use crate::capabilities::CapabilityScope;
use crate::js_runtime::{JsInvocation, JsRuntime};
use crate::platform::host::{OwnedPluginProcess, PluginStdio};
use crate::plugin_host::HostError;
use crate::plugins::{LoadedPlugin, Permission, PluginRegistry};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::Path;
use std::time::{Duration, Instant};

pub(crate) const CAPABILITY: &str = "codlet.client.launch";
pub(crate) fn startup_affected(plugins: &[LoadedPlugin]) -> BTreeSet<String> {
    let mut affected = BTreeSet::new();
    for plugin in plugins {
        let provider = plugin.manifest.host_provides().iter().any(|capability| {
            capability.name.as_str() == CAPABILITY
                && capability.api.get() == 1
                && capability.scope == CapabilityScope::Runtime
        });
        // Core's Desktop read/write/event provider is independent of its native
        // traffic source. A traffic permission is also not a required capability:
        // its consumer can inspect availability and keep its other features live.
        // Only an external launch provider's explicit dependents suspend with it.
        if provider && !crate::codex::is_internal_plugin(plugin) {
            affected.extend(crate::plugin_lifecycle::dependent_closure(
                plugins,
                &plugin.manifest.id,
            ));
        }
    }
    affected
}
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
    if crate::codex::is_internal_plugin(provider) {
        return Ok(provider);
    }
    let raw_host = match provider.manifest.host_mode() {
        Some(crate::plugins::HostMode::Sdk) => return Err(error("client_launch_adapter_denied")),
        Some(crate::plugins::HostMode::Node) => Permission::HostRaw,
        None => Permission::HostProcess,
    };
    if provider.host.is_none()
        || ![raw_host, Permission::CdpRaw].iter().all(|permission| {
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

struct SourceLoader {
    process: OwnedPluginProcess,
    stdio: PluginStdio,
    _invocation: JsInvocation,
}

#[derive(Debug)]
pub(crate) struct SourceActivation {
    pub(crate) installed: bool,
    pub(crate) pending: bool,
    pub(crate) activated: Value,
    pub(crate) unsupported: Value,
}

impl SourceLoader {
    fn load(&self, deadline: Instant) -> Result<Value, HostError> {
        let request = b"{\"phase\":\"source\",\"context\":{\"features\":{\"clientBridge\":1}}}\n";
        self.stdio
            .stdin
            .write_all(request, deadline)
            .map_err(|_| error("client_launch_adapter_timeout"))?;
        let mut reply = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let count = self
                .stdio
                .stdout
                .read_some(&mut buffer, Some(deadline))
                .map_err(|_| error("client_launch_adapter_timeout"))?;
            if count == 0 || reply.len() + count > 1024 * 1024 {
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
                    let code = value["code"].as_str().filter(|code| {
                        !code.is_empty()
                            && code.len() <= 80
                            && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
                    });
                    return Err(HostError::new(
                        "client_launch_adapter_failed",
                        format!(
                            "Client launch adapter failed: {}",
                            code.unwrap_or("unspecified")
                        ),
                    ));
                }
                return Ok(value["result"].clone());
            }
        }
    }
}

pub(crate) fn source_snapshot(
    provider: &LoadedPlugin,
    registry: &Path,
    runtime: &JsRuntime,
    directory: &Path,
) -> Result<Value, HostError> {
    validate_source_authority(provider, registry)?;
    if crate::codex::is_internal_plugin(provider) {
        return Ok(serde_json::json!({"code": crate::codex::current_client_source()?}));
    }
    let invocation = runtime.prepare_client_launch(
        provider
            .host
            .as_ref()
            .ok_or_else(|| error("client_launch_adapter_denied"))?,
        directory,
    )?;
    let (process, stdio) = OwnedPluginProcess::spawn(
        &invocation.executable,
        &invocation.arguments,
        &invocation.cwd,
        Some(&invocation.environment),
    )
    .map_err(|_| error("client_launch_adapter_spawn_failed"))?;
    let adapter = SourceLoader {
        process,
        stdio,
        _invocation: invocation,
    };
    let value = adapter.load(Instant::now() + Duration::from_secs(10))?;
    validate_source_authority(provider, registry)?;
    if value.as_object().is_none_or(|record| record.len() != 1)
        || value["code"]
            .as_str()
            .is_none_or(|code| code.is_empty() || code.len() > 1024 * 1024)
    {
        return Err(error("client_launch_adapter_protocol"));
    }
    Ok(value)
}

pub(crate) fn validate_source_authority(
    provider: &LoadedPlugin,
    registry: &Path,
) -> Result<(), HostError> {
    select(std::slice::from_ref(provider))?;
    if crate::codex::is_internal_plugin(provider) {
        return Ok(());
    }
    let current = PluginRegistry::load(registry)
        .map_err(|_| error("client_launch_authorization_unavailable"))?;
    if provider
        .authorization
        .as_ref()
        .is_none_or(|record| current.local_plugins().get(&provider.manifest.id) != Some(record))
    {
        return Err(error("client_launch_authorization_revoked"));
    }
    Ok(())
}

impl Drop for SourceLoader {
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

pub(crate) fn validate_client_source_activation(
    activation: &Value,
    source: &Value,
) -> Result<SourceActivation, HostError> {
    let object = activation
        .as_object()
        .ok_or_else(|| invalid_activation("activation", "expected_object"))?;
    if object.keys().any(|key| {
        ![
            "installed",
            "activatedSources",
            "unsupportedSources",
            "pending",
            "pendingSources",
        ]
        .contains(&key.as_str())
    }) {
        return Err(invalid_activation("activation", "unexpected_field"));
    }
    let installed = activation["installed"]
        .as_bool()
        .ok_or_else(|| invalid_activation("activation.installed", "expected_boolean"))?;
    let activated = activation["activatedSources"]
        .as_array()
        .ok_or_else(|| invalid_activation("activation.activatedSources", "expected_array"))?;
    if installed == activated.is_empty() {
        return Err(invalid_activation(
            "activation.installed",
            "inconsistent_active_sources",
        ));
    }
    validate_activation_metadata(activation, source, installed)
}

fn invalid_activation(field: &'static str, category: &'static str) -> HostError {
    // Static protocol locations/categories only: never include payload values,
    // unknown key names, endpoint credentials or Native source text.
    HostError::new(
        "client_launch_adapter_unconfirmed",
        format!("Client source activation rejected: field={field}; category={category}"),
    )
}

fn validate_activation_metadata(
    reply: &Value,
    source: &Value,
    installed: bool,
) -> Result<SourceActivation, HostError> {
    let activated = reply["activatedSources"]
        .as_array()
        .ok_or_else(|| invalid_activation("activation.activatedSources", "expected_array"))?;
    let unsupported = match reply.get("unsupportedSources") {
        Some(value) => value
            .as_array()
            .ok_or_else(|| invalid_activation("activation.unsupportedSources", "expected_array"))?,
        None => {
            return Err(invalid_activation(
                "activation.unsupportedSources",
                "missing_field",
            ));
        }
    };
    let pending_sources = match (reply.get("pending"), reply.get("pendingSources")) {
        (None, None) => &[][..],
        (Some(pending), Some(sources)) => {
            let pending = pending
                .as_bool()
                .ok_or_else(|| invalid_activation("activation.pending", "expected_boolean"))?;
            let sources = sources
                .as_array()
                .ok_or_else(|| invalid_activation("activation.pendingSources", "expected_array"))?;
            if pending == sources.is_empty() {
                return Err(invalid_activation(
                    "activation.pendingSources",
                    "inconsistent_pending_sources",
                ));
            }
            sources.as_slice()
        }
        (Some(_), None) => {
            return Err(invalid_activation(
                "activation.pendingSources",
                "missing_paired_field",
            ));
        }
        (None, Some(_)) => {
            return Err(invalid_activation(
                "activation.pending",
                "missing_paired_field",
            ));
        }
    };
    if (installed && activated.is_empty()) || activated.len() > 8 {
        return Err(invalid_activation(
            "activation.activatedSources",
            "invalid_count",
        ));
    }
    if unsupported.len() > 8 {
        return Err(invalid_activation(
            "activation.unsupportedSources",
            "invalid_count",
        ));
    }
    let offered_operations = source["operations"]
        .as_array()
        .ok_or_else(|| invalid_activation("source.operations", "expected_array"))?;
    let offered_protocols = source["protocols"]
        .as_array()
        .ok_or_else(|| invalid_activation("source.protocols", "expected_array"))?;
    let mut ids = BTreeSet::new();
    for entry in activated {
        let record = entry.as_object().ok_or_else(|| {
            invalid_activation("activation.activatedSources[]", "expected_object")
        })?;
        if record.len() != 4
            || !record.contains_key("id")
            || !record.contains_key("operations")
            || !record.contains_key("protocols")
            || !record.contains_key("coverage")
        {
            return Err(invalid_activation(
                "activation.activatedSources[]",
                "invalid_fields",
            ));
        }
        let id = entry["id"].as_str().filter(|id| label(id)).ok_or_else(|| {
            invalid_activation("activation.activatedSources[].id", "invalid_identifier")
        })?;
        if !ids.insert(id) {
            return Err(invalid_activation(
                "activation.sourceIds",
                "duplicate_identifier",
            ));
        }
        for (field, offered) in [
            ("operations", offered_operations),
            ("protocols", offered_protocols),
        ] {
            let diagnostic_field = if field == "operations" {
                "activation.activatedSources[].operations"
            } else {
                "activation.activatedSources[].protocols"
            };
            let values = entry[field]
                .as_array()
                .filter(|values| !values.is_empty() && values.len() <= offered.len())
                .ok_or_else(|| invalid_activation(diagnostic_field, "invalid_array"))?;
            let mut seen = BTreeSet::new();
            for value in values {
                let value = value
                    .as_str()
                    .ok_or_else(|| invalid_activation(diagnostic_field, "expected_string"))?;
                if !offered
                    .iter()
                    .any(|allowed| allowed.as_str() == Some(value))
                    || !seen.insert(value)
                {
                    return Err(invalid_activation(
                        diagnostic_field,
                        "unoffered_or_duplicate_value",
                    ));
                }
            }
        }
        let coverage = entry["coverage"]
            .as_array()
            .filter(|values| !values.is_empty() && values.len() <= 8)
            .ok_or_else(|| {
                invalid_activation("activation.activatedSources[].coverage", "invalid_array")
            })?;
        let mut seen = BTreeSet::new();
        for value in coverage {
            let value = value.as_str().filter(|value| label(value)).ok_or_else(|| {
                invalid_activation(
                    "activation.activatedSources[].coverage",
                    "invalid_identifier",
                )
            })?;
            if !seen.insert(value) {
                return Err(invalid_activation(
                    "activation.activatedSources[].coverage",
                    "duplicate_identifier",
                ));
            }
        }
    }
    for entry in unsupported {
        let record = entry.as_object().ok_or_else(|| {
            invalid_activation("activation.unsupportedSources[]", "expected_object")
        })?;
        if record.len() != 2 || !record.contains_key("id") || !record.contains_key("reason") {
            return Err(invalid_activation(
                "activation.unsupportedSources[]",
                "invalid_fields",
            ));
        }
        let id = entry["id"].as_str().filter(|id| label(id)).ok_or_else(|| {
            invalid_activation("activation.unsupportedSources[].id", "invalid_identifier")
        })?;
        if !ids.insert(id) {
            return Err(invalid_activation(
                "activation.sourceIds",
                "duplicate_identifier",
            ));
        }
        if !matches!(
            entry["reason"].as_str(),
            Some(
                "unsupported_build"
                    | "hook_unavailable"
                    | "child_unavailable"
                    | "route_unavailable"
                    | "timeout"
                    | "ambiguous_contract"
                    | "binding_changed"
                    | "contract_unavailable"
            )
        ) {
            return Err(invalid_activation(
                "activation.unsupportedSources[].reason",
                "unrecognized_reason",
            ));
        }
    }
    for entry in pending_sources {
        let record = entry
            .as_object()
            .ok_or_else(|| invalid_activation("activation.pendingSources[]", "expected_object"))?;
        if record.len() != 2 || !record.contains_key("id") || !record.contains_key("reason") {
            return Err(invalid_activation(
                "activation.pendingSources[]",
                "invalid_fields",
            ));
        }
        let id = entry["id"].as_str().filter(|id| label(id)).ok_or_else(|| {
            invalid_activation("activation.pendingSources[].id", "invalid_identifier")
        })?;
        if !ids.insert(id) {
            return Err(invalid_activation(
                "activation.sourceIds",
                "duplicate_identifier",
            ));
        }
        if !matches!(
            entry["reason"].as_str(),
            Some("initializing" | "child_unavailable" | "backend_config_pending")
        ) {
            return Err(invalid_activation(
                "activation.pendingSources[].reason",
                "unrecognized_reason",
            ));
        }
    }
    Ok(SourceActivation {
        installed,
        pending: !pending_sources.is_empty(),
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
    use serde_json::json;
    use std::path::PathBuf;

    #[test]
    fn a_bridge_source_entry_does_not_need_the_legacy_startup_exports() {
        let (directory, registry, provider, runtime) =
            fixture_source("exports.clientSource=()=>({code:'module.exports={};'});");
        assert_eq!(
            source_snapshot(&provider, &registry, &runtime, directory.path()).unwrap()["code"],
            "module.exports={};"
        );
    }

    #[test]
    fn source_activation_rejects_unoffered_protocols_and_inconsistent_availability() {
        let offer = json!({"operations":["http.intercept"],"protocols":["http"]});
        let valid = json!({"installed":true,"activatedSources":[{"id":"test-http","operations":["http.intercept"],"protocols":["http"],"coverage":["test-path"]}],"unsupportedSources":[]});
        assert!(validate_client_source_activation(&valid, &offer).is_ok());
        let mut invalid = valid.clone();
        invalid["activatedSources"][0]["protocols"] = json!(["webSocket"]);
        assert!(validate_client_source_activation(&invalid, &offer).is_err());
        let mut invalid = valid;
        invalid["installed"] = json!(false);
        assert!(validate_client_source_activation(&invalid, &offer).is_err());
        assert!(
            validate_client_source_activation(
                &json!({"installed":false,"activatedSources":[],"unsupportedSources":[]}),
                &offer
            )
            .is_ok()
        );
    }

    #[test]
    fn pending_activation_is_explicit_and_never_relabels_a_contract_failure() {
        let offer = json!({"operations":["http.intercept"],"protocols":["http"]});
        let pending = json!({"installed":false,"activatedSources":[],"unsupportedSources":[],"pending":true,"pendingSources":[{"id":"native-main","reason":"initializing"}]});
        let observed = validate_client_source_activation(&pending, &offer).unwrap();
        assert!(!observed.installed);
        assert!(observed.pending);
        for reason in [
            "ambiguous_contract",
            "binding_changed",
            "contract_unavailable",
        ] {
            let terminal = json!({"installed":false,"activatedSources":[],"unsupportedSources":[{"id":"native-main","reason":reason}],"pending":false,"pendingSources":[]});
            assert!(
                !validate_client_source_activation(&terminal, &offer)
                    .unwrap()
                    .pending
            );
        }
        for invalid in [
            json!({"installed":false,"activatedSources":[],"unsupportedSources":[],"pending":true,"pendingSources":[]}),
            json!({"installed":false,"activatedSources":[],"unsupportedSources":[],"pending":false,"pendingSources":pending["pendingSources"]}),
            json!({"installed":false,"activatedSources":[],"unsupportedSources":[],"pending":true}),
            json!({"installed":false,"activatedSources":[],"unsupportedSources":[],"pendingSources":[]}),
            json!({"installed":false,"activatedSources":[],"unsupportedSources":[],"pending":true,"pendingSources":[{"id":"native-main","reason":"ambiguous_contract"}]}),
            json!({"installed":false,"activatedSources":[],"unsupportedSources":[{"id":"native-main","reason":"binding_changed"}],"pending":true,"pendingSources":pending["pendingSources"]}),
            json!({"installed":false,"activatedSources":[],"unsupportedSources":[],"extra":true}),
        ] {
            assert!(
                validate_client_source_activation(&invalid, &offer).is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn activation_schema_failures_identify_fields_without_logging_payload_values() {
        let offer = json!({"operations":["http.intercept"],"protocols":["http"]});
        let missing = json!({"installed":false,"pending":false,"activatedSources":[],"unsupportedSources":[{"id":"client-source","reason":"backend_route_timeout"}]});
        let failure = validate_client_source_activation(&missing, &offer).unwrap_err();
        assert_eq!(failure.code, "client_launch_adapter_unconfirmed");
        assert!(
            failure
                .message
                .contains("field=activation.pendingSources; category=missing_paired_field")
        );
        let mut invalid = missing;
        invalid["pendingSources"] = json!([]);
        invalid["unsupportedSources"][0]["reason"] = json!("private endpoint/token source payload");
        let failure = validate_client_source_activation(&invalid, &offer).unwrap_err();
        assert!(failure.message.contains(
            "field=activation.unsupportedSources[].reason; category=unrecognized_reason"
        ));
        assert!(!failure.message.contains("private"));
        invalid["unsupportedSources"][0]["reason"] = json!("backend_route_timeout");
        assert!(
            validate_client_source_activation(&invalid, &offer).is_err(),
            "arbitrary safe diagnostic codes are not activation reason enum values"
        );
        invalid["unsupportedSources"][0]["reason"] = json!("contract_unavailable");
        let terminal = validate_client_source_activation(&invalid, &offer).unwrap();
        assert!(!terminal.installed);
        assert!(!terminal.pending);
    }

    const SOURCE: &str = "exports.clientSource=()=>({code:'module.exports={};'});";

    fn fixture() -> (tempfile::TempDir, PathBuf, LoadedPlugin, JsRuntime) {
        fixture_source(SOURCE)
    }

    fn fixture_source(source: &str) -> (tempfile::TempDir, PathBuf, LoadedPlugin, JsRuntime) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        std::fs::write(root.join("host.cjs"), source).unwrap();
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
    fn reload_source_uses_the_trusted_immutable_snapshot_and_accepts_a_large_bounded_bundle() {
        let source = format!("{SOURCE}\nexports.clientSource=()=>({{code:'x'.repeat(65536)}});");
        let (directory, registry, provider, runtime) = fixture_source(&source);
        std::fs::write(
            provider.host.as_ref().unwrap().entry.clone(),
            "throw Error('changed author file');",
        )
        .unwrap();
        let result = source_snapshot(&provider, &registry, &runtime, directory.path()).unwrap();
        assert_eq!(result["code"].as_str().unwrap().len(), 65536);
        let mut changed = PluginRegistry::load(&registry).unwrap();
        changed
            .revoke_permission(&provider.manifest.id, Permission::CdpRaw)
            .unwrap();
        changed.save().unwrap();
        assert_eq!(
            validate_source_authority(&provider, &registry)
                .unwrap_err()
                .code,
            "client_launch_authorization_revoked"
        );
    }

    #[test]
    fn reload_source_can_prepare_an_explicit_enable_without_persisting_enabled_preferences() {
        let source =
            format!("{SOURCE}\nexports.clientSource=()=>({{code:'module.exports={{}};'}});");
        let (directory, registry, provider, runtime) = fixture_source(&source);
        let mut disabled = PluginRegistry::load(&registry).unwrap();
        disabled.set_enabled(&provider.manifest.id, false).unwrap();
        disabled.save().unwrap();
        assert!(source_snapshot(&provider, &registry, &runtime, directory.path()).is_ok());
        assert!(
            !PluginRegistry::load(&registry)
                .unwrap()
                .is_enabled(&provider.manifest.id)
        );
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
    fn source_callback_cannot_publish_after_revoking_its_registration() {
        let (directory, registry, provider, runtime) = fixture_source(
            "exports.clientSource=()=>{const fs=require('node:fs'),p=require('node:path').join(__dirname,'registry.json');const r=JSON.parse(fs.readFileSync(p,'utf8'));r.localPlugins['test.launch-adapter'].grants=[];fs.writeFileSync(p,JSON.stringify(r));return {code:'module.exports={};'};};",
        );
        assert_eq!(
            source_snapshot(&provider, &registry, &runtime, directory.path())
                .unwrap_err()
                .code,
            "client_launch_authorization_revoked"
        );
    }

    #[test]
    fn source_loader_rejects_invalid_and_oversized_results() {
        for source in [
            "exports.clientSource=()=>({code:''});",
            "exports.clientSource=()=>({code:'x',extra:true});",
            "exports.clientSource=()=>({code:'x'.repeat(1024*1024)});",
        ] {
            let (directory, registry, provider, runtime) = fixture_source(source);
            assert!(source_snapshot(&provider, &registry, &runtime, directory.path()).is_err());
        }
    }

    #[test]
    fn activation_requires_explicit_bounded_per_source_coverage() {
        let descriptor = traffic();
        let source = &descriptor["source"];
        let valid = json!({"installed":true,"activatedSources":[{"id":"example-http","operations":["route.register","route.update","route.close","http.intercept"],"protocols":["http","sse"],"coverage":["example-fetch-path"]}],"unsupportedSources":[{"id":"example-backend","reason":"child_unavailable"}]});
        assert_eq!(
            validate_client_source_activation(&valid, source)
                .unwrap()
                .activated
                .as_array()
                .unwrap()
                .len(),
            1
        );
        for change in [
            json!({"installed":true,"activatedSources":[],"unsupportedSources":[]}),
            json!({"installed":true,"configuredSessions":1,"activatedSources":valid["activatedSources"],"unsupportedSources":valid["unsupportedSources"]}),
            json!({"installed":true,"activatedSources":[{"id":"example-http","operations":["tls.bypass"],"protocols":["http"],"coverage":["all"]}],"unsupportedSources":[]}),
            json!({"installed":true,"activatedSources":[{"id":"example-http","operations":["http.intercept"],"protocols":["http2"],"coverage":["all"]}],"unsupportedSources":[]}),
            json!({"installed":true,"activatedSources":valid["activatedSources"],"unsupportedSources":[{"id":"example-http","reason":"child_unavailable"}]}),
            json!({"installed":true,"activatedSources":valid["activatedSources"],"unsupportedSources":[{"id":"example-backend","reason":"arbitrary message"}]}),
        ] {
            assert!(
                validate_client_source_activation(&change, source).is_err(),
                "{change}"
            );
        }
    }
}
