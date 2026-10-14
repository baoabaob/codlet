//! Core-owned Codex UI, Desktop and launch implementations.
//!
//! The historical IDs are capability routing aliases. These snapshots are not
//! user installed packages; catalog admission must give them Core ownership.
use crate::plugins::{LoadedHost, LoadedPlugin, ManifestError, PluginManifest};
use std::path::PathBuf;

pub const UI_PROVIDER_ID: &str = "codex.ui.adapter";
pub const DESKTOP_PROVIDER_ID: &str = "codex.desktop.adapter";
pub const CLIENT_SOURCE: &str = include_str!("../codex/bundled/codex-desktop-adapter/host.cjs");
pub const CLIENT_RUNTIME_SOURCE: &str = include_str!("../runtime/core-modules/client-source.cjs");
const UI_SOURCE: &str = include_str!("../codex/bundled/codex-ui-adapter/dist/renderer.js");
const DESKTOP_SOURCE: &str = include_str!("../codex/bundled/codex-desktop-adapter/renderer.js");

/// Only updater-pinned, protocol-compatible Core modules may replace the
/// embedded source on a subsequent launch. An unpinned adjacent .cjs is ignored.
pub(crate) fn current_client_source() -> Result<String, crate::plugin_host::HostError> {
    if let Some(source) = crate::runtime_update::core_module_override("client-source") {
        return Ok(source);
    }
    let root = std::env::current_exe().map_err(|_| {
        crate::plugin_host::HostError::new(
            "core_source_location_unavailable",
            "Cannot resolve the installed Core directory",
        )
    })?;
    let root = root.parent().ok_or_else(|| {
        crate::plugin_host::HostError::new(
            "core_source_location_unavailable",
            "Cannot resolve the installed Core directory",
        )
    })?;
    let source = crate::runtime_update::installed_online_source(root).map_err(|error| {
        crate::plugin_host::HostError::new("core_source_pin_invalid", error.to_string())
    })?;
    Ok(source.unwrap_or_else(|| CLIENT_RUNTIME_SOURCE.to_owned()))
}

pub fn is_internal_id(id: &str) -> bool {
    matches!(id, UI_PROVIDER_ID | DESKTOP_PROVIDER_ID)
}

/// These registry records may still hold user grants and storage. Core
/// supersedes their execution; migration must not delete or rewrite them.
pub fn is_legacy_adapter_id(id: &str) -> bool {
    is_internal_id(id)
}

/// Trusted ownership is bound to the complete immutable embedded snapshots.
/// An external package with a historical ID cannot acquire Core authority.
pub fn is_internal_plugin(plugin: &LoadedPlugin) -> bool {
    if plugin.authorization.is_some() || !is_internal_id(&plugin.manifest.id) {
        return false;
    }
    internal_plugins().is_ok_and(|plugins| {
        plugins.into_iter().any(|internal| {
            let (component, embedded_source) = match internal.manifest.id.as_str() {
                UI_PROVIDER_ID => ("core-ui-provider", UI_SOURCE),
                DESKTOP_PROVIDER_ID => ("core-desktop-provider", DESKTOP_SOURCE),
                _ => return false,
            };
            plugin.manifest == internal.manifest
                && plugin.source.as_deref().is_some_and(|source| {
                    crate::runtime_update::core_module_source_trusted(
                        component,
                        source,
                        embedded_source,
                    )
                })
                && match (&plugin.host, &internal.host) {
                    (None, None) => true,
                    (Some(host), Some(expected)) => {
                        host.authorization.is_none()
                            && host.source == expected.source
                            && host.root == expected.root
                            && host.entry == expected.entry
                    }
                    _ => false,
                }
        })
    })
}

pub fn internal_plugins() -> Result<Vec<LoadedPlugin>, ManifestError> {
    // The source is embedded and fully bundled. The installed executable's
    // directory supplies an existing cwd and a synthetic module filename; no
    // build-machine checkout or adapter directory is needed at runtime.
    let root = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
        .unwrap_or_else(std::env::temp_dir);
    Ok(vec![
        LoadedPlugin {
            authorization: None,
            manifest: PluginManifest::parse(include_str!(
                "../codex/bundled/codex-ui-adapter/codlet.json"
            ))?,
            source: Some(
                crate::runtime_update::core_module_source("core-ui-provider", UI_SOURCE).into(),
            ),
            host: None,
            generation: 1,
        },
        LoadedPlugin {
            authorization: None,
            manifest: PluginManifest::parse(include_str!(
                "../codex/bundled/codex-desktop-adapter/codlet.json"
            ))?,
            source: Some(
                crate::runtime_update::core_module_source("core-desktop-provider", DESKTOP_SOURCE)
                    .into(),
            ),
            host: Some(LoadedHost {
                entry: root.join("codlet-core-codex-launch.cjs"),
                root,
                source: CLIENT_SOURCE.into(),
                authorization: None,
            }),
            generation: 1,
        },
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn internal_snapshots_own_the_complete_legacy_contract() {
        let providers = internal_plugins().unwrap();
        assert_eq!(providers.len(), 2);
        let ui = &providers[0];
        let desktop = &providers[1];
        assert_eq!(ui.manifest.provides.len(), 3);
        assert_eq!(desktop.manifest.provides.len(), 5);
        assert!(ui.authorization.is_none() && desktop.authorization.is_none());
        assert!(desktop.manifest.native_launch_only());
        assert!(
            desktop
                .host
                .as_ref()
                .unwrap()
                .source
                .contains("attachClientLaunch")
        );
        assert!(ui.source.as_ref().unwrap().contains("mountTranscript"));
        assert!(desktop.source.as_ref().unwrap().contains("threads.loaded"));
        assert!(is_internal_id(&ui.manifest.id));
        assert!(is_legacy_adapter_id(&desktop.manifest.id));
        assert!(!is_internal_id("dev.consumer"));
        assert!(is_internal_plugin(ui) && is_internal_plugin(desktop));
        let mut impersonator = desktop.clone();
        impersonator.host.as_mut().unwrap().source = "module.exports = {};".into();
        assert!(!is_internal_plugin(&impersonator));
        let mut impersonator = ui.clone();
        impersonator.manifest.version = "different".into();
        assert!(!is_internal_plugin(&impersonator));
        let mut impersonator = desktop.clone();
        impersonator.host.as_mut().unwrap().root = std::env::temp_dir().join("external-provider");
        assert!(!is_internal_plugin(&impersonator));
    }
}
