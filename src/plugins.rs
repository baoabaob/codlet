use std::collections::BTreeMap;
use std::env;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::capabilities::CapabilityDescriptor;

const MANIFEST_SCHEMA: u32 = 1;
const REGISTRY_SCHEMA: u32 = 1;
const MAX_PLUGIN_ID_BYTES: usize = 128;
const MAX_VERSION_BYTES: usize = 64;
const REGISTRY_LOCK_TIMEOUT: Duration = Duration::from_secs(2);
const REGISTRY_LOCK_POLL: Duration = Duration::from_millis(10);
const TEMP_FILE_ATTEMPTS: usize = 128;
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
    pending: BTreeMap<String, PluginPreference>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct RegistryDocument {
    schema: u32,
    #[serde(default, deserialize_with = "deserialize_preferences")]
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
    #[error("plugin registry is busy after waiting {timeout:?} for lock {path}; retry the save")]
    Busy { path: PathBuf, timeout: Duration },
    #[error("{primary}; also failed to remove temporary registry {path}: {source}")]
    TemporaryCleanup {
        primary: Box<PluginRegistryError>,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
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
        let document = RegistryDocument::read(&path)?;
        Ok(Self {
            path,
            document,
            pending: BTreeMap::new(),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Includes staged edits; persistence is confirmed only by a successful `save`.
    pub fn is_enabled(&self, plugin_id: &str) -> bool {
        self.pending
            .get(plugin_id)
            .or_else(|| self.document.plugins.get(plugin_id))
            .map(|preference| preference.enabled)
            .unwrap_or(true)
    }

    /// Stage an explicit assignment, even when it matches the loaded value.
    pub fn set_enabled(
        &mut self,
        plugin_id: &str,
        enabled: bool,
    ) -> Result<(), PluginRegistryError> {
        if !valid_plugin_id(plugin_id) {
            return Err(PluginRegistryError::PluginId(plugin_id.to_owned()));
        }
        self.pending
            .insert(plugin_id.to_owned(), PluginPreference { enabled });
        Ok(())
    }

    /// Merge only staged assignments into the latest strictly validated document.
    /// Writers serialize on a persistent sidecar lock; the last committed assignment
    /// to the same ID wins. Success refreshes this snapshot and clears staged edits.
    /// Failure leaves this snapshot and its staged edits intact for an explicit retry.
    pub fn save(&mut self) -> Result<(), PluginRegistryError> {
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

        let _lock = lock_registry(&self.path, REGISTRY_LOCK_TIMEOUT)?;
        let mut latest = RegistryDocument::read(&self.path)?;
        if !self.pending.is_empty() {
            latest.plugins.extend(self.pending.clone());
            let mut bytes = serde_json::to_vec_pretty(&latest)
                .expect("the typed plugin registry is always serializable");
            bytes.push(b'\n');
            TemporaryRegistry::create(&self.path)?.replace(&self.path, &bytes)?;
        }
        self.document = latest;
        self.pending.clear();
        Ok(())
    }
}

fn lock_registry(path: &Path, timeout: Duration) -> Result<File, PluginRegistryError> {
    let mut lock_path = path.as_os_str().to_owned();
    lock_path.push(".lock");
    let lock_path = PathBuf::from(lock_path);
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_SHARE_READ | FILE_SHARE_WRITE: keep the lock identity from being deleted.
        options.share_mode(0x1 | 0x2);
    }
    let lock = options
        .open(&lock_path)
        .map_err(|source| PluginRegistryError::Io {
            operation: "open lock for",
            path: lock_path.clone(),
            source,
        })?;
    let started = Instant::now();
    loop {
        match lock.try_lock() {
            // Never unlink the sidecar: waiters must keep locking the same file.
            // Closing the handle, including on process exit, releases the OS lock.
            Ok(()) => return Ok(lock),
            Err(TryLockError::WouldBlock) => {
                let remaining = timeout.saturating_sub(started.elapsed());
                if remaining.is_zero() {
                    return Err(PluginRegistryError::Busy {
                        path: lock_path,
                        timeout,
                    });
                }
                thread::sleep(REGISTRY_LOCK_POLL.min(remaining));
            }
            Err(TryLockError::Error(source)) => {
                return Err(PluginRegistryError::Io {
                    operation: "lock",
                    path: lock_path,
                    source,
                });
            }
        }
    }
}

struct TemporaryRegistry {
    path: PathBuf,
    file: Option<File>,
    remove_on_drop: bool,
}

impl TemporaryRegistry {
    fn create(path: &Path) -> Result<Self, PluginRegistryError> {
        for _ in 0..TEMP_FILE_ATTEMPTS {
            let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let mut name = path.as_os_str().to_owned();
            name.push(format!(".{}.{}.tmp", std::process::id(), sequence));
            let temporary = PathBuf::from(name);
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
            {
                Ok(file) => {
                    return Ok(Self {
                        path: temporary,
                        file: Some(file),
                        remove_on_drop: true,
                    });
                }
                // A previous process with a reused PID may have left this name behind.
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(source) => {
                    return Err(PluginRegistryError::Io {
                        operation: "create temporary for",
                        path: temporary,
                        source,
                    });
                }
            }
        }
        Err(PluginRegistryError::Io {
            operation: "create temporary for",
            path: path.to_owned(),
            source: io::Error::new(
                io::ErrorKind::AlreadyExists,
                "temporary name attempts exhausted",
            ),
        })
    }

    fn replace(mut self, path: &Path, bytes: &[u8]) -> Result<(), PluginRegistryError> {
        let result = (|| {
            let file = self
                .file
                .as_mut()
                .expect("temporary file is open until replacement");
            file.write_all(bytes)
                .and_then(|()| file.sync_all())
                .map_err(|source| PluginRegistryError::Io {
                    operation: "write temporary",
                    path: self.path.clone(),
                    source,
                })?;
            self.file.take();
            fs::rename(&self.path, path).map_err(|source| PluginRegistryError::Io {
                operation: "replace",
                path: path.to_owned(),
                source,
            })
        })();
        self.file.take();
        if let Err(primary) = result {
            match fs::remove_file(&self.path) {
                Ok(()) => self.remove_on_drop = false,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    self.remove_on_drop = false
                }
                Err(source) => {
                    return Err(PluginRegistryError::TemporaryCleanup {
                        primary: Box::new(primary),
                        path: self.path.clone(),
                        source,
                    });
                }
            }
            return Err(primary);
        }
        self.remove_on_drop = false;
        Ok(())
    }
}

impl Drop for TemporaryRegistry {
    fn drop(&mut self) {
        self.file.take();
        if self.remove_on_drop {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn deserialize_preferences<'de, D>(
    deserializer: D,
) -> Result<BTreeMap<String, PluginPreference>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct PreferencesVisitor;

    impl<'de> serde::de::Visitor<'de> for PreferencesVisitor {
        type Value = BTreeMap<String, PluginPreference>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("an object with unique plugin IDs")
        }

        fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
        where
            M: serde::de::MapAccess<'de>,
        {
            let mut preferences = BTreeMap::new();
            while let Some((id, preference)) = map.next_entry::<String, PluginPreference>()? {
                if preferences.insert(id.clone(), preference).is_some() {
                    return Err(serde::de::Error::custom(format!(
                        "duplicate plugin id: {id}"
                    )));
                }
            }
            Ok(preferences)
        }
    }

    deserializer.deserialize_map(PreferencesVisitor)
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
    fn read(path: &Path) -> Result<Self, PluginRegistryError> {
        let document = match fs::read_to_string(path) {
            Ok(json) => serde_json::from_str(&json).map_err(|error| PluginRegistryError::Json {
                path: path.to_owned(),
                message: error.to_string(),
            })?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Self::default(),
            Err(source) => {
                return Err(PluginRegistryError::Io {
                    operation: "read",
                    path: path.to_owned(),
                    source,
                });
            }
        };
        document.validate()?;
        Ok(document)
    }

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
        assert_eq!(path.parent().unwrap().read_dir().unwrap().count(), 2);
        assert!(path.with_extension("json.lock").exists());
    }

    #[test]
    fn stale_registries_preserve_independent_updates() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        let mut first = PluginRegistry::load(&path).unwrap();
        let mut second = PluginRegistry::load(&path).unwrap();

        first.set_enabled("codlet", false).unwrap();
        second.set_enabled("codex.ui.adapter", false).unwrap();
        first.save().unwrap();
        second.save().unwrap();

        let committed = PluginRegistry::load(&path).unwrap();
        assert!(!committed.is_enabled("codlet"));
        assert!(!committed.is_enabled("codex.ui.adapter"));
        assert_eq!(second.document, committed.document);
        assert!(second.pending.is_empty());
    }

    #[test]
    fn stale_clone_preserves_unknown_ids_and_does_not_replay_committed_edits() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        let mut first = PluginRegistry::load(&path).unwrap();
        first.set_enabled("future.plugin", false).unwrap();
        first.save().unwrap();
        let mut stale = first.clone();

        first.set_enabled("future.plugin", true).unwrap();
        first.set_enabled("another.future-plugin", false).unwrap();
        first.save().unwrap();
        stale.set_enabled("codlet", false).unwrap();
        stale.save().unwrap();

        assert!(stale.is_enabled("future.plugin"));
        assert!(!stale.is_enabled("another.future-plugin"));
        assert!(!stale.is_enabled("codlet"));
        assert_eq!(
            stale.document,
            PluginRegistry::load(&path).unwrap().document
        );

        first.save().unwrap();
        assert_eq!(first.document, stale.document);
    }

    #[test]
    fn same_id_uses_commit_order_even_when_assignment_matches_the_stale_value() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        let mut first = PluginRegistry::load(&path).unwrap();
        let mut second = first.clone();
        second.set_enabled("codlet", true).unwrap();
        first.set_enabled("codlet", false).unwrap();
        first.save().unwrap();
        second.save().unwrap();
        assert!(PluginRegistry::load(&path).unwrap().is_enabled("codlet"));

        // Saving again without an assignment refreshes, never replays the old disable.
        first.save().unwrap();
        assert!(first.is_enabled("codlet"));
        assert!(PluginRegistry::load(&path).unwrap().is_enabled("codlet"));
    }

    #[test]
    fn save_revalidates_latest_bytes_and_retains_staged_edits_on_failure() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        let mut registry = PluginRegistry::load(&path).unwrap();
        registry.set_enabled("codlet", false).unwrap();
        let previous = registry.clone();

        for bytes in [
            b"{truncated".as_slice(),
            b"\xff",
            br#"{"schema":2,"plugins":{}}"#,
            br#"{"schema":1,"plugins":{},"extra":true}"#,
            br#"{"schema":1,"plugins":{"Bad Id":{"enabled":true}}}"#,
            br#"{"schema":1,"plugins":{"future.plugin":{"enabled":false,"extra":0}}}"#,
            br#"{"schema":1,"plugins":{"future.plugin":{"enabled":"false"}}}"#,
            br#"{"schema":1,"plugins":{"future.plugin":{"enabled":false,"enabled":true}}}"#,
            br#"{"schema":1,"schema":1,"plugins":{}}"#,
            br#"{"schema":1,"plugins":{"future.plugin":{"enabled":false},"future.plugin":{"enabled":true}}}"#,
        ] {
            fs::write(&path, bytes).unwrap();
            assert!(PluginRegistry::load(&path).is_err());
            assert!(registry.save().is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
            assert_eq!(registry.document, previous.document);
            assert_eq!(registry.pending, previous.pending);
            assert_eq!(directory.path().read_dir().unwrap().count(), 2);
        }

        fs::write(
            &path,
            br#"{"schema":1,"plugins":{"future.plugin":{"enabled":false}}}"#,
        )
        .unwrap();
        registry.save().unwrap();
        assert!(!registry.is_enabled("codlet"));
        assert!(!registry.is_enabled("future.plugin"));
        assert!(registry.pending.is_empty());
    }

    #[test]
    fn temporary_write_failure_removes_only_its_owned_file() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        fs::write(&path, b"original bytes").unwrap();
        let mut temporary = TemporaryRegistry::create(&path).unwrap();
        let temporary_path = temporary.path.clone();
        temporary.file.take();
        temporary.file = Some(File::open(&temporary_path).unwrap());

        assert!(matches!(
            temporary.replace(&path, b"replacement bytes"),
            Err(PluginRegistryError::Io {
                operation: "write temporary",
                ..
            })
        ));
        assert_eq!(fs::read(&path).unwrap(), b"original bytes");
        assert!(!temporary_path.exists());
    }

    #[cfg(windows)]
    #[test]
    fn replacement_failure_keeps_disk_and_snapshot_then_retry_merges_latest() {
        use std::os::windows::fs::OpenOptionsExt;

        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        let mut registry = PluginRegistry::load(&path).unwrap();
        registry.set_enabled("future.plugin", false).unwrap();
        registry.save().unwrap();
        let original = fs::read(&path).unwrap();
        registry.set_enabled("codlet", false).unwrap();
        let previous = registry.clone();
        let blocker = OpenOptions::new()
            .read(true)
            .share_mode(0x1 | 0x2)
            .open(&path)
            .unwrap();

        assert!(matches!(
            registry.save(),
            Err(PluginRegistryError::Io {
                operation: "replace",
                ..
            })
        ));
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(registry.document, previous.document);
        assert_eq!(registry.pending, previous.pending);
        assert_eq!(directory.path().read_dir().unwrap().count(), 2);
        drop(blocker);

        let mut another = PluginRegistry::load(&path).unwrap();
        another.set_enabled("future.plugin", true).unwrap();
        another.save().unwrap();
        registry.save().unwrap();
        assert!(!registry.is_enabled("codlet"));
        assert!(registry.is_enabled("future.plugin"));
        assert_eq!(
            registry.document,
            PluginRegistry::load(&path).unwrap().document
        );
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
