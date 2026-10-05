//! Compatibility failure is local to optional startup plugins. Never retry
//! arbitrary process failures or weaken a plugin's interception requirements.
use super::*;
use std::collections::BTreeSet;

fn reason(error: &ProbeError) -> Option<&str> {
    if let ProbeError::PluginHost(error) = error
        && error.code == "client_bridge_lease_timeout"
    {
        return Some(error.code);
    }
    let code = match error {
        ProbeError::Process(ProcessError::ClientBootstrap(message)) => message
            .strip_prefix("client_launch_adapter_failed: Client launch adapter failed: ")
            .or_else(|| {
                message.strip_prefix(
                    "client_bridge_bootstrap_failed: Client bridge bootstrap failed: ",
                )
            })?,
        ProbeError::PluginHost(error) if error.code == "client_launch_adapter_failed" => error
            .message
            .strip_prefix("Client launch adapter failed: ")?,
        ProbeError::PluginHost(error) if error.code == "client_bridge_bootstrap_failed" => error
            .message
            .strip_prefix("Client bridge bootstrap failed: ")?,
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

pub(super) fn without_bridge(reason: &str) -> bool {
    matches!(
        reason,
        "client_bridge_fuse_unsupported" | "client_bridge_lease_timeout"
    )
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
    crate::client_launch::startup_affected(plugins)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::{LocalPluginRegistration, PluginManifest};
    use serde_json::json;

    fn fixture() -> (tempfile::TempDir, PluginRegistry, Vec<LoadedPlugin>) {
        let directory = tempfile::tempdir().unwrap();
        let mut registry = PluginRegistry::load(directory.path().join("registry.json")).unwrap();
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
    fn only_the_bounded_lease_timeout_retries_without_the_optional_bridge() {
        let mut calls = Vec::new();
        let result = attempt(|reason| {
            calls.push(reason.map(str::to_owned));
            if let Some(reason) = reason {
                assert!(without_bridge(reason));
                Ok(())
            } else {
                Err(ProbeError::PluginHost(HostError::new(
                    "client_bridge_lease_timeout",
                    "bounded wait expired",
                )))
            }
        });
        assert!(result.is_ok());
        assert_eq!(
            calls,
            vec![None, Some("client_bridge_lease_timeout".to_owned())]
        );
        for code in [
            "client_bridge_protocol",
            "client_bridge_identity_invalid",
            "client_bridge_lease_unavailable",
        ] {
            assert!(!without_bridge(code));
            assert!(reason(&ProbeError::PluginHost(HostError::new(code, "rejected"))).is_none());
        }
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
