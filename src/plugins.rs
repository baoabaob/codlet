use std::path::Path;

use serde::Deserialize;
use thiserror::Error;

use crate::capabilities::CapabilityDescriptor;

const MANIFEST_SCHEMA: u32 = 1;
const MAX_PLUGIN_ID_BYTES: usize = 128;
const MAX_VERSION_BYTES: usize = 64;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PluginManifest {
    pub schema: u32,
    pub id: String,
    pub version: String,
    pub renderer: RendererManifest,
    #[serde(default)]
    pub permissions: Vec<Permission>,
    #[serde(default)]
    pub provides: Vec<CapabilityDescriptor>,
    #[serde(default)]
    pub requires: Vec<CapabilityDescriptor>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RendererManifest {
    pub entry: String,
    pub world: RendererWorld,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RendererWorld {
    Isolated,
    Main,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
pub enum Permission {
    #[serde(rename = "ui.dom")]
    UiDom,
    #[serde(rename = "ui.mainWorld")]
    UiMainWorld,
    #[serde(rename = "cdp.raw")]
    CdpRaw,
    #[serde(rename = "host.process")]
    HostProcess,
    #[serde(rename = "runtime.manage")]
    RuntimeManage,
}

impl Permission {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UiDom => "ui.dom",
            Self::UiMainWorld => "ui.mainWorld",
            Self::CdpRaw => "cdp.raw",
            Self::HostProcess => "host.process",
            Self::RuntimeManage => "runtime.manage",
        }
    }
}

#[derive(Debug, Clone)]
pub struct LoadedPlugin {
    pub manifest: PluginManifest,
    pub source: String,
    pub generation: u64,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ManifestError {
    #[error("plugin manifest is not valid JSON: {0}")]
    Json(String),
    #[error("plugin manifest schema must be {MANIFEST_SCHEMA}, got {0}")]
    Schema(u32),
    #[error("plugin id is invalid: {0}")]
    Id(String),
    #[error("plugin version is invalid: {0}")]
    Version(String),
    #[error("renderer entry must be a normalized relative path: {0}")]
    RendererEntry(String),
    #[error("permission ui.mainWorld is required when renderer.world is main")]
    MainWorldPermissionRequired,
}

impl PluginManifest {
    pub fn parse(json: &str) -> Result<Self, ManifestError> {
        let manifest: Self =
            serde_json::from_str(json).map_err(|error| ManifestError::Json(error.to_string()))?;
        manifest.validate()?;
        Ok(manifest)
    }

    fn validate(&self) -> Result<(), ManifestError> {
        if self.schema != MANIFEST_SCHEMA {
            return Err(ManifestError::Schema(self.schema));
        }
        if !valid_plugin_id(&self.id) {
            return Err(ManifestError::Id(self.id.clone()));
        }
        if self.version.is_empty()
            || self.version.len() > MAX_VERSION_BYTES
            || !self.version.is_ascii()
            || self.version.chars().any(char::is_whitespace)
        {
            return Err(ManifestError::Version(self.version.clone()));
        }
        if !valid_relative_entry(&self.renderer.entry) {
            return Err(ManifestError::RendererEntry(self.renderer.entry.clone()));
        }
        if self.renderer.world == RendererWorld::Main
            && !self.permissions.contains(&Permission::UiMainWorld)
        {
            return Err(ManifestError::MainWorldPermissionRequired);
        }
        Ok(())
    }
}

pub fn bundled_codlet() -> Result<LoadedPlugin, ManifestError> {
    Ok(LoadedPlugin {
        manifest: PluginManifest::parse(include_str!("../bundled/codlet/plugin.json"))?,
        source: include_str!("../bundled/codlet/dist/renderer.js").to_owned(),
        generation: 1,
    })
}

pub fn bundled_codex_ui_adapter() -> Result<LoadedPlugin, ManifestError> {
    Ok(LoadedPlugin {
        manifest: PluginManifest::parse(include_str!("../bundled/codex-ui-adapter/plugin.json"))?,
        source: include_str!("../bundled/codex-ui-adapter/dist/renderer.js").to_owned(),
        generation: 1,
    })
}

pub fn bundled_plugins() -> Result<Vec<LoadedPlugin>, ManifestError> {
    Ok(vec![bundled_codex_ui_adapter()?, bundled_codlet()?])
}

fn valid_plugin_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_PLUGIN_ID_BYTES
        && id.is_ascii()
        && id.split('.').all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}

fn valid_relative_entry(entry: &str) -> bool {
    !entry.is_empty()
        && entry.is_ascii()
        && Path::new(entry).is_relative()
        && !entry.contains('\\')
        && !entry.contains(':')
        && entry.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || byte == b'/'
                || byte == b'.'
                || byte == b'_'
                || byte == b'-'
        })
        && entry
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capabilities::CapabilityScope;

    #[test]
    fn bundled_codlet_uses_the_public_manifest_contract() {
        let plugin = bundled_codlet().unwrap();
        assert_eq!(plugin.manifest.id, "codlet");
        assert_eq!(plugin.manifest.renderer.world, RendererWorld::Isolated);
        assert_eq!(plugin.manifest.permissions, [Permission::UiDom]);
        assert_eq!(plugin.manifest.requires.len(), 2);
        assert_eq!(
            plugin.manifest.requires[0],
            CapabilityDescriptor::new("codex.ui.titlebar.afterMenu", 1, CapabilityScope::Target)
                .unwrap()
        );
        assert_eq!(
            plugin.manifest.requires[1],
            CapabilityDescriptor::new("codlet.runtime.ping", 1, CapabilityScope::Target).unwrap()
        );
        assert!(plugin.source.contains("module.exports"));
        assert!(plugin.source.contains("codex.ui.titlebar.afterMenu@1"));
        assert!(plugin.source.contains("context.rpc.request"));
        assert!(plugin.source.contains("capability?.available"));
        assert!(plugin.source.contains("codlet.runtime.ping"));
        assert!(!plugin.source.contains("data-app-shell-header-layout"));
        assert!(
            !plugin
                .source
                .contains("app-shell-header-context-menu-surface")
        );
    }

    #[test]
    fn bundled_ui_adapter_provides_the_gui_mount_capability() {
        let plugin = bundled_codex_ui_adapter().unwrap();
        assert_eq!(plugin.manifest.id, "codex.ui.adapter");
        assert_eq!(plugin.manifest.renderer.world, RendererWorld::Isolated);
        assert_eq!(plugin.manifest.permissions, [Permission::UiDom]);
        assert_eq!(plugin.manifest.provides.len(), 1);
        assert_eq!(
            plugin.manifest.provides[0],
            CapabilityDescriptor::new("codex.ui.titlebar.afterMenu", 1, CapabilityScope::Target)
                .unwrap()
        );
        assert!(plugin.manifest.requires.is_empty());
        assert!(plugin.source.contains("HEADER_SELECTOR"));
        assert!(plugin.source.contains("data-app-shell-header-layout"));
        assert!(plugin.source.contains("codex.ui.titlebar.afterMenu@1"));
    }

    #[test]
    fn manifest_parses_structured_provides_and_requires() {
        let manifest = PluginManifest::parse(
            r#"{
                "schema": 1,
                "id": "dev.consumer",
                "version": "1",
                "renderer": {"entry": "dist/renderer.js", "world": "isolated"},
                "provides": [
                    {"name": "runtime.commands", "api": 2, "scope": "runtime"}
                ],
                "requires": [
                    {"name": "renderer.dom", "api": 1, "scope": "target"}
                ]
            }"#,
        )
        .unwrap();

        assert_eq!(manifest.provides[0].name.as_str(), "runtime.commands");
        assert_eq!(manifest.provides[0].api.get(), 2);
        assert_eq!(manifest.requires[0].name.as_str(), "renderer.dom");
        assert_eq!(manifest.requires[0].scope, CapabilityScope::Target);
    }

    #[test]
    fn manifest_rejects_legacy_string_requirements() {
        let legacy = r#"{
            "schema": 1,
            "id": "dev.consumer",
            "version": "1",
            "renderer": {"entry": "dist/renderer.js", "world": "isolated"},
            "requires": ["renderer.dom"]
        }"#;

        assert!(matches!(
            PluginManifest::parse(legacy),
            Err(ManifestError::Json(_))
        ));
    }

    #[test]
    fn manifest_rejects_unknown_fields_and_unsafe_entries() {
        let base = r#"{
            "schema": 1,
            "id": "dev.example",
            "version": "0.1.0",
            "renderer": {"entry": "dist/renderer.js", "world": "isolated"}
        }"#;
        assert!(PluginManifest::parse(base).is_ok());

        let unknown = base.replace(
            "\"version\": \"0.1.0\"",
            "\"version\": \"0.1.0\", \"extra\": true",
        );
        assert!(matches!(
            PluginManifest::parse(&unknown),
            Err(ManifestError::Json(_))
        ));

        for entry in [
            "../renderer.js",
            "/renderer.js",
            "dist\\renderer.js",
            "C:/x.js",
        ] {
            let json = base.replace("dist/renderer.js", entry);
            assert!(matches!(
                PluginManifest::parse(&json),
                Err(ManifestError::RendererEntry(_))
            ));
        }
    }

    #[test]
    fn main_world_requires_its_explicit_permission() {
        let json = r#"{
            "schema": 1,
            "id": "dev.example",
            "version": "0.1.0",
            "renderer": {"entry": "dist/renderer.js", "world": "main"},
            "permissions": ["ui.dom"]
        }"#;
        assert_eq!(
            PluginManifest::parse(json),
            Err(ManifestError::MainWorldPermissionRequired)
        );
    }
}
