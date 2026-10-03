//! Compatibility failure is local to optional startup plugins. Never retry
//! arbitrary process failures or weaken a plugin's interception requirements.
use super::*;
use std::collections::BTreeSet;

fn reason(error: &ProbeError) -> Option<&str> {
    let code = match error {
        ProbeError::Process(ProcessError::ClientBootstrap(message)) => {
            message.strip_prefix("client_launch_adapter_failed: Client launch adapter failed: ")?
        }
        ProbeError::PluginHost(error) if error.code == "client_launch_adapter_failed" => error
            .message
            .strip_prefix("Client launch adapter failed: ")?,
        _ => return None,
    };
    // Legacy launch ABI codes are finite identifiers. Compatibility meanings
    // remain generic; Core does not carry client names, symbols or fingerprints.
    (!code.is_empty()
        && code.len() <= 80
        && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
        && (code.ends_with("_unsupported") || code.ends_with("_unverified")))
    .then_some(code)
}

pub(super) fn attempt<T>(
    mut launch: impl FnMut(Option<&str>) -> Result<T, ProbeError>,
) -> Result<T, ProbeError> {
    match launch(None) {
        Err(error) if reason(&error).is_some() => {
            let reason = reason(&error).unwrap();
            eprintln!(
                "startup-plugin-recovery: reason={reason}; action=suspend-incompatible-plugins"
            );
            // The failed attempt has returned: suspended child/adapter/IPC
            // owners have already unwound before the new ordinary launch.
            launch(Some(reason))
        }
        result => result,
    }
}

pub(super) fn affected(plugins: &[LoadedPlugin]) -> BTreeSet<String> {
    let mut affected = BTreeSet::new();
    for plugin in plugins {
        let provider = plugin.manifest.host_provides().iter().any(|capability| {
            capability.name.as_str() == crate::client_launch::CAPABILITY
                && capability.api.get() == 1
                && capability.scope == crate::capabilities::CapabilityScope::Runtime
        });
        let consumer = crate::traffic_owner::required_for_plugins(std::slice::from_ref(plugin));
        if provider || consumer {
            affected.extend(crate::plugin_lifecycle::dependent_closure(
                plugins,
                &plugin.manifest.id,
            ));
        }
    }
    affected
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::{LocalPluginRegistration, PluginManifest};
    use serde_json::json;

    fn fixture() -> (tempfile::TempDir, PluginRegistry, Vec<LoadedPlugin>) {
        let directory = tempfile::tempdir().unwrap();
        let mut registry = PluginRegistry::load(&directory.path().join("registry.json")).unwrap();
        let declarations = [
            json!({"schema":1,"id":"dev.adapter","version":"1","renderer":{"entry":"renderer.js","world":"isolated"},"host":{"entry":"host.js","provides":[{"name":"codlet.client.launch","api":1,"scope":"runtime"}]},"permissions":["host.process","cdp.raw"],"provides":[{"name":"dev.desktop","api":1,"scope":"target"}]}),
            json!({"schema":1,"id":"dev.traffic","version":"1","host":{"entry":"host.js"},"permissions":["host.process","traffic.intercept"]}),
            json!({"schema":1,"id":"dev.dependent","version":"1","renderer":{"entry":"renderer.js","world":"isolated"},"requires":[{"name":"dev.desktop","api":1,"scope":"target"}]}),
            json!({"schema":1,"id":"dev.unrelated","version":"1","renderer":{"entry":"renderer.js","world":"isolated"}}),
        ];
        let mut plugins = Vec::new();
        for declaration in declarations {
            let manifest = PluginManifest::parse(&declaration.to_string()).unwrap();
            let root = directory.path().join(&manifest.id);
            std::fs::create_dir(&root).unwrap();
            std::fs::write(root.join("codlet.json"), declaration.to_string()).unwrap();
            for name in ["renderer.js", "host.js"] {
                std::fs::write(
                    root.join(name),
                    "module.exports={activate(){},deactivate(){}};",
                )
                .unwrap();
            }
            let registration = LocalPluginRegistration {
                path: root.canonicalize().unwrap(),
                grants: manifest.permissions.clone(),
                ..Default::default()
            };
            registry
                .register_local(&manifest.id, registration.clone())
                .unwrap();
            registry.set_enabled(&manifest.id, true).unwrap();
            plugins.push(
                crate::local_plugins::load_local_plugin_with_registration(
                    &manifest.id,
                    &registration,
                    1,
                )
                .unwrap(),
            );
        }
        registry.save().unwrap();
        (directory, registry, plugins)
    }

    #[test]
    fn compatibility_failure_retries_once_after_the_failed_attempt_has_unwound() {
        let mut calls = Vec::new();
        let value = attempt(|suspension| {
            calls.push(suspension.map(str::to_owned));
            if suspension.is_none() {
                Err(ProbeError::Process(ProcessError::ClientBootstrap(
                    "client_launch_adapter_failed: Client launch adapter failed: client_bootstrap_version_unsupported".into(),
                )))
            } else { Ok(17) }
        }).unwrap();
        assert_eq!(value, 17);
        assert_eq!(
            calls,
            [None, Some("client_bootstrap_version_unsupported".into())]
        );
    }

    #[test]
    fn unknown_process_and_adapter_failures_are_not_retried() {
        for code in [
            "client_launch_adapter_protocol",
            "client_launch_authorization_revoked",
            "backend_config_timeout",
        ] {
            let mut calls = 0;
            let result: Result<(), _> = attempt(|_| {
                calls += 1;
                Err(ProbeError::PluginHost(HostError::new(
                    "client_launch_adapter_failed",
                    format!("Client launch adapter failed: {code}"),
                )))
            });
            assert!(result.is_err());
            assert_eq!(calls, 1);
        }
        let mut calls = 0;
        let result: Result<(), _> = attempt(|_| {
            calls += 1;
            Err(ProbeError::Process(ProcessError::ClientBootstrap("client_launch_adapter_failed: Client launch adapter failed: client_bootstrap_version_unsupported".into())))
        });
        assert!(result.is_err());
        assert_eq!(calls, 2, "recovery never loops");
    }

    #[test]
    fn recovery_excludes_the_launch_provider_traffic_consumers_and_real_dependents() {
        let (_directory, registry, plugins) = fixture();
        let before = std::fs::read(registry.path()).unwrap();
        let suspended = affected(&plugins);
        assert_eq!(
            suspended,
            BTreeSet::from([
                "dev.adapter".into(),
                "dev.traffic".into(),
                "dev.dependent".into()
            ])
        );
        let mut catalog = PluginCatalog::load(&registry).unwrap();
        catalog.suspend_startup(&suspended, "client_bootstrap_version_unsupported");
        let enabled = catalog.enabled_plugins(&registry).unwrap();
        assert_eq!(
            enabled
                .iter()
                .filter(|plugin| plugin.manifest.id.starts_with("dev."))
                .map(|plugin| plugin.manifest.id.as_str())
                .collect::<Vec<_>>(),
            ["dev.unrelated"]
        );
        assert!(!crate::traffic_owner::required_for_plugins(&enabled));
        assert_eq!(std::fs::read(registry.path()).unwrap(), before);
        assert!(registry.is_enabled("dev.adapter"));
        assert_eq!(
            PluginCatalog::load(&registry)
                .unwrap()
                .enabled_plugins(&registry)
                .unwrap()
                .into_iter()
                .filter(|plugin| plugin.manifest.id.starts_with("dev."))
                .collect::<Vec<_>>()
                .len(),
            4,
            "a fresh launch retries original enablement"
        );
    }

    #[test]
    fn suspended_plugins_have_runtime_explanations_and_cannot_activate_without_restart() {
        let (_directory, registry, plugins) = fixture();
        let before = std::fs::read(registry.path()).unwrap();
        let mut catalog = PluginCatalog::load(&registry).unwrap();
        catalog.suspend_startup(&affected(&plugins), "client_bootstrap_version_unsupported");
        let runtime = RendererRuntime::from_catalog(catalog, registry.clone()).unwrap();
        let candidate = &plugins[0];
        assert_eq!(
            runtime.validate_package_shape(candidate).unwrap_err().code,
            "startup_plugin_suspended"
        );
        assert!(runtime.validate_package_shape(&plugins[3]).is_ok());
        assert_eq!(std::fs::read(registry.path()).unwrap(), before);
    }
}
