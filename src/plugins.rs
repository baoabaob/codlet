use std::collections::BTreeMap;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::capabilities::CapabilityDescriptor;

const MANIFEST_SCHEMA: u32 = 1;
const REGISTRY_SCHEMA: u32 = 1;
const MAX_PLUGIN_ID_BYTES: usize = 128;
const MAX_VERSION_BYTES: usize = 64;
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

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

#[derive(Debug, Clone)]
pub struct PluginRegistry {
    path: PathBuf,
    document: RegistryDocument,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct RegistryDocument {
    schema: u32,
    #[serde(default)]
    plugins: BTreeMap<String, PluginPreference>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct PluginPreference {
    enabled: bool,
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

#[derive(Debug, Error)]
pub enum PluginRegistryError {
    #[error("LOCALAPPDATA is unavailable; the Codlet plugin registry path cannot be resolved")]
    LocalAppDataUnavailable,
    #[error("plugin registry path has no parent directory: {0}")]
    MissingParent(PathBuf),
    #[error("failed to {operation} plugin registry path {path}: {source}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("plugin registry {path} is not valid JSON: {message}")]
    Json { path: PathBuf, message: String },
    #[error("plugin registry schema must be {REGISTRY_SCHEMA}, got {0}")]
    Schema(u32),
    #[error("plugin registry contains an invalid plugin id: {0}")]
    PluginId(String),
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

impl PluginRegistry {
    pub fn load_default() -> Result<Self, PluginRegistryError> {
        Self::load(default_registry_path()?)
    }

    pub fn load(path: impl Into<PathBuf>) -> Result<Self, PluginRegistryError> {
        let path = path.into();
        let document = match fs::read_to_string(&path) {
            Ok(json) => serde_json::from_str(&json).map_err(|error| PluginRegistryError::Json {
                path: path.clone(),
                message: error.to_string(),
            })?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => RegistryDocument::default(),
            Err(source) => {
                return Err(PluginRegistryError::Io {
                    operation: "read",
                    path,
                    source,
                });
            }
        };
        document.validate()?;
        Ok(Self { path, document })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn is_enabled(&self, plugin_id: &str) -> bool {
        self.document
            .plugins
            .get(plugin_id)
            .map(|preference| preference.enabled)
            .unwrap_or(true)
    }

    pub fn set_enabled(
        &mut self,
        plugin_id: &str,
        enabled: bool,
    ) -> Result<(), PluginRegistryError> {
        if !valid_plugin_id(plugin_id) {
            return Err(PluginRegistryError::PluginId(plugin_id.to_owned()));
        }
        self.document
            .plugins
            .insert(plugin_id.to_owned(), PluginPreference { enabled });
        Ok(())
    }

    pub fn save(&self) -> Result<(), PluginRegistryError> {
        let parent = self
            .path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .ok_or_else(|| PluginRegistryError::MissingParent(self.path.clone()))?;
        fs::create_dir_all(parent).map_err(|source| PluginRegistryError::Io {
            operation: "create parent directory for",
            path: parent.to_owned(),
            source,
        })?;

        let file_name = self
            .path
            .file_name()
            .expect("a registry path with a parent has a file name")
            .to_string_lossy();
        let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temporary = parent.join(format!(
            ".{file_name}.{}.{}.tmp",
            std::process::id(),
            sequence
        ));
        let mut bytes = serde_json::to_vec_pretty(&self.document)
            .expect("the typed plugin registry is always serializable");
        bytes.push(b'\n');

        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|source| PluginRegistryError::Io {
                    operation: "create temporary",
                    path: temporary.clone(),
                    source,
                })?;
            file.write_all(&bytes)
                .and_then(|()| file.sync_all())
                .map_err(|source| PluginRegistryError::Io {
                    operation: "write temporary",
                    path: temporary.clone(),
                    source,
                })?;
            drop(file);
            fs::rename(&temporary, &self.path).map_err(|source| PluginRegistryError::Io {
                operation: "replace",
                path: self.path.clone(),
                source,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

impl Default for RegistryDocument {
    fn default() -> Self {
        Self {
            schema: REGISTRY_SCHEMA,
            plugins: BTreeMap::new(),
        }
    }
}

impl RegistryDocument {
    fn validate(&self) -> Result<(), PluginRegistryError> {
        if self.schema != REGISTRY_SCHEMA {
            return Err(PluginRegistryError::Schema(self.schema));
        }
        if let Some(plugin_id) = self.plugins.keys().find(|id| !valid_plugin_id(id)) {
            return Err(PluginRegistryError::PluginId(plugin_id.clone()));
        }
        Ok(())
    }
}

pub fn default_registry_path() -> Result<PathBuf, PluginRegistryError> {
    let local_app_data = env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .ok_or(PluginRegistryError::LocalAppDataUnavailable)?;
    Ok(PathBuf::from(local_app_data)
        .join("Codlet")
        .join("config.json"))
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

pub fn enabled_bundled_plugins(
    registry: &PluginRegistry,
) -> Result<Vec<LoadedPlugin>, ManifestError> {
    Ok(bundled_plugins()?
        .into_iter()
        .filter(|plugin| registry.is_enabled(&plugin.manifest.id))
        .collect())
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
    use tempfile::tempdir;

    #[test]
    fn bundled_codlet_uses_the_public_manifest_contract() {
        let plugin = bundled_codlet().unwrap();
        assert_eq!(plugin.manifest.id, "codlet");
        assert_eq!(plugin.manifest.renderer.world, RendererWorld::Isolated);
        assert_eq!(
            plugin.manifest.permissions,
            [Permission::UiDom, Permission::RuntimeManage]
        );
        assert_eq!(plugin.manifest.requires.len(), 3);
        assert_eq!(
            plugin.manifest.requires[0],
            CapabilityDescriptor::new("codex.ui.titlebar.afterMenu", 1, CapabilityScope::Target)
                .unwrap()
        );
        assert_eq!(
            plugin.manifest.requires[1],
            CapabilityDescriptor::new("codlet.runtime.ping", 1, CapabilityScope::Target).unwrap()
        );
        assert_eq!(
            plugin.manifest.requires[2],
            CapabilityDescriptor::new("codlet.runtime.manage", 1, CapabilityScope::Target).unwrap()
        );
        assert!(plugin.source.contains("module.exports"));
        assert!(plugin.source.contains("codex.ui.titlebar.afterMenu@1"));
        assert!(plugin.source.contains("context.rpc.request"));
        assert!(plugin.source.contains("capability?.available"));
        assert!(plugin.source.contains("codlet.runtime.ping"));
        assert!(plugin.source.contains("disableSelf"));
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

    #[test]
    fn missing_registry_uses_defaults_without_creating_a_file() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        let registry = PluginRegistry::load(&path).unwrap();

        assert!(registry.is_enabled("codlet"));
        assert!(registry.is_enabled("codex.ui.adapter"));
        assert_eq!(registry.path(), path);
        assert!(!path.exists());
    }

    #[test]
    fn registry_round_trip_atomically_replaces_the_previous_state() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("state").join("config.json");
        let mut registry = PluginRegistry::load(&path).unwrap();

        registry.set_enabled("codlet", false).unwrap();
        registry.save().unwrap();
        assert!(!PluginRegistry::load(&path).unwrap().is_enabled("codlet"));

        registry.set_enabled("codlet", true).unwrap();
        registry.save().unwrap();
        assert!(PluginRegistry::load(&path).unwrap().is_enabled("codlet"));
        assert_eq!(directory.path().read_dir().unwrap().count(), 1);
        assert_eq!(path.parent().unwrap().read_dir().unwrap().count(), 1);
    }

    #[test]
    fn registry_rejects_invalid_schema_unknown_fields_and_plugin_ids() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");

        for json in [
            r#"{"schema":2,"plugins":{}}"#,
            r#"{"schema":1,"plugins":{},"extra":true}"#,
            r#"{"schema":1,"plugins":{"Bad Id":{"enabled":true}}}"#,
        ] {
            fs::write(&path, json).unwrap();
            assert!(PluginRegistry::load(&path).is_err());
        }
    }

    #[test]
    fn disabled_bundled_plugins_are_excluded_from_the_launch_catalog() {
        let directory = tempdir().unwrap();
        let mut registry = PluginRegistry::load(directory.path().join("config.json")).unwrap();
        registry.set_enabled("codlet", false).unwrap();

        let plugins = enabled_bundled_plugins(&registry).unwrap();
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].manifest.id, "codex.ui.adapter");
    }
}
