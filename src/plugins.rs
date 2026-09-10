use std::collections::BTreeMap;
use std::env;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::capabilities::CapabilityDescriptor;

const MANIFEST_SCHEMA: u32 = 1;
const REGISTRY_SCHEMA: u32 = 2;
pub const GUI_PLUGIN_ID: &str = "codlet-gui";
const LEGACY_GUI_PLUGIN_ID: &str = "codlet";
pub const MAX_REGISTRY_BYTES: usize = 1024 * 1024;
const MAX_PLUGIN_ID_BYTES: usize = 128;
const MAX_VERSION_BYTES: usize = 64;
const REGISTRY_LOCK_TIMEOUT: Duration = Duration::from_secs(2);
const REGISTRY_LOCK_POLL: Duration = Duration::from_millis(10);
const TEMP_FILE_ATTEMPTS: usize = 128;
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PluginManifest {
    pub schema: u32,
    pub id: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub renderer: Option<RendererManifest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<HostManifest>,
    #[serde(default)]
    pub permissions: Vec<Permission>,
    #[serde(default)]
    pub provides: Vec<CapabilityDescriptor>,
    #[serde(default)]
    pub requires: Vec<CapabilityDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RendererManifest {
    pub entry: String,
    pub world: RendererWorld,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HostManifest {
    /// Built JavaScript relative to the same directory package as renderer.entry.
    /// Codlet owns the JS executable, bootstrap and transport; plugins choose none.
    pub entry: String,
    /// A combined package's native half owns these declarations. Host-only
    /// packages retain the existing top-level provides field.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provides: Vec<CapabilityDescriptor>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RendererWorld {
    Isolated,
    Main,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LocalPluginRegistration {
    #[serde(deserialize_with = "deserialize_local_path")]
    pub path: PathBuf,
    #[serde(deserialize_with = "deserialize_grants")]
    pub grants: Vec<Permission>,
}

#[derive(Debug, Clone)]
pub struct LoadedPlugin {
    pub manifest: PluginManifest,
    /// The unchanged renderer source, absent for a host-only plugin.
    pub source: Option<String>,
    pub host: Option<LoadedHost>,
    pub generation: u64,
}

#[derive(Debug, Clone)]
pub struct LoadedHost {
    pub root: PathBuf,
    pub entry: PathBuf,
    /// The validated source snapshot, just like the renderer source. Editing the
    /// original directory does not alter this generation or lock developer files.
    pub source: Arc<str>,
}

#[derive(Debug, Clone)]
pub struct PluginRegistry {
    path: PathBuf,
    document: RegistryDocument,
    pending: BTreeMap<String, PluginPreference>,
    local_plugins: BTreeMap<String, LocalPluginRegistration>,
    pending_local: BTreeMap<String, LocalPluginEdit>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RegistryDocument {
    schema: u32,
    plugins: BTreeMap<String, PluginPreference>,
    local_plugins: BTreeMap<String, LocalPluginRegistration>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RegistryInput {
    schema: u32,
    #[serde(default, deserialize_with = "deserialize_unique_ids")]
    plugins: BTreeMap<String, PluginPreference>,
    #[serde(default, deserialize_with = "deserialize_local_plugins")]
    local_plugins: Option<BTreeMap<String, LocalPluginRegistration>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LocalPluginEdit {
    expected: Option<LocalPluginRegistration>,
    desired: Option<LocalPluginRegistration>,
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
    #[error("plugin manifest must declare a renderer or host entry")]
    EntryRequired,
    #[error(
        "renderer entry must be a normalized relative path to .js or .cjs; compile TypeScript before loading: {0}"
    )]
    RendererEntry(String),
    #[error("permission ui.mainWorld is required when renderer.world is main")]
    MainWorldPermissionRequired,
    #[error(
        "host entry must be a normalized relative path to .js or .cjs; compile TypeScript before loading: {0}"
    )]
    HostEntry(String),
    #[error("permission host.process is required when a host entry is declared")]
    HostProcessPermissionRequired,
    #[error(
        "host-only plugins declare provides at the top level; host.provides belongs to combined entries"
    )]
    AmbiguousHostProvides,
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
    #[error(
        "plugin registry {path} exceeds the {MAX_REGISTRY_BYTES}-byte limit; reduce its size before retrying"
    )]
    TooLarge { path: PathBuf },
    #[error("plugin registry schema must be 1 or {REGISTRY_SCHEMA}, got {0}")]
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
    pub fn host_provides(&self) -> &[CapabilityDescriptor] {
        match (&self.host, &self.renderer) {
            (Some(host), Some(_)) => &host.provides,
            (Some(_), None) => &self.provides,
            _ => &[],
        }
    }

    pub fn renderer_provides(&self) -> &[CapabilityDescriptor] {
        if self.renderer.is_some() {
            &self.provides
        } else {
            &[]
        }
    }

    pub fn renderer_requires(&self) -> &[CapabilityDescriptor] {
        if self.renderer.is_some() {
            &self.requires
        } else {
            &[]
        }
    }

    pub fn all_provides(&self) -> impl Iterator<Item = &CapabilityDescriptor> {
        self.renderer_provides().iter().chain(self.host_provides())
    }

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
        if self.renderer.is_none() && self.host.is_none() {
            return Err(ManifestError::EntryRequired);
        }
        if let Some(renderer) = &self.renderer {
            if !valid_javascript_entry(&renderer.entry) {
                return Err(ManifestError::RendererEntry(renderer.entry.clone()));
            }
            if renderer.world == RendererWorld::Main
                && !self.permissions.contains(&Permission::UiMainWorld)
            {
                return Err(ManifestError::MainWorldPermissionRequired);
            }
        }
        if let Some(host) = &self.host {
            if !valid_javascript_entry(&host.entry) {
                return Err(ManifestError::HostEntry(host.entry.clone()));
            }
            if !self.permissions.contains(&Permission::HostProcess) {
                return Err(ManifestError::HostProcessPermissionRequired);
            }
            if self.renderer.is_none() && !host.provides.is_empty() {
                return Err(ManifestError::AmbiguousHostProvides);
            }
        }
        Ok(())
    }
}

fn valid_javascript_entry(entry: &str) -> bool {
    valid_relative_entry(entry) && (entry.ends_with(".js") || entry.ends_with(".cjs"))
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
            local_plugins: document.local_plugins.clone(),
            document,
            pending: BTreeMap::new(),
            pending_local: BTreeMap::new(),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Includes staged edits; persistence is confirmed only by a successful `save`.
    pub fn is_enabled(&self, plugin_id: &str) -> bool {
        let plugin_id = canonical_plugin_id(plugin_id);
        self.pending
            .get(plugin_id)
            .or_else(|| self.document.plugins.get(plugin_id))
            .or_else(|| {
                (plugin_id == GUI_PLUGIN_ID)
                    .then(|| self.document.plugins.get(LEGACY_GUI_PLUGIN_ID))
                    .flatten()
            })
            .map(|preference| preference.enabled)
            .unwrap_or(true)
    }

    /// Includes staged registrations, grants, and removals. Only `save` persists them.
    pub fn local_plugins(&self) -> &BTreeMap<String, LocalPluginRegistration> {
        &self.local_plugins
    }

    /// Stage an explicitly trusted registration without reading its directory.
    /// An existing ID must use the same path; grants are an explicit replacement,
    /// including when they equal the loaded grants. Paths must already be canonicalized
    /// by the caller; the registry checks their storage contract without filesystem I/O.
    /// Enablement preferences are independent and are never changed here.
    pub fn register_local(
        &mut self,
        plugin_id: &str,
        registration: LocalPluginRegistration,
    ) -> Result<(), PluginRegistryError> {
        self.validate_local_id(plugin_id)?;
        validate_local_registration(&registration)
            .map_err(|message| self.local_error(plugin_id, io::ErrorKind::InvalidInput, message))?;
        if self
            .local_plugins
            .get(plugin_id)
            .is_some_and(|previous| previous.path != registration.path)
        {
            return Err(self.local_error(
                plugin_id,
                io::ErrorKind::AlreadyExists,
                "already registered at a different path; remove it explicitly first",
            ));
        }
        if self
            .local_plugins
            .iter()
            .any(|(id, existing)| id != plugin_id && existing.path == registration.path)
        {
            return Err(self.local_error(
                plugin_id,
                io::ErrorKind::AlreadyExists,
                "path is already registered under another plugin id",
            ));
        }
        self.stage_local(plugin_id, Some(registration));
        Ok(())
    }

    /// Forget a registration without touching its files or enablement preference.
    pub fn remove_local(&mut self, plugin_id: &str) -> Result<(), PluginRegistryError> {
        self.validate_local_id(plugin_id)?;
        if !self.local_plugins.contains_key(plugin_id) {
            return Err(self.local_error(plugin_id, io::ErrorKind::NotFound, "is not registered"));
        }
        self.stage_local(plugin_id, None);
        Ok(())
    }

    fn validate_local_id(&self, plugin_id: &str) -> Result<(), PluginRegistryError> {
        if !valid_plugin_id(plugin_id) {
            return Err(PluginRegistryError::PluginId(plugin_id.to_owned()));
        }
        if reserved_plugin_id(plugin_id) {
            return Err(self.local_error(
                plugin_id,
                io::ErrorKind::InvalidInput,
                "is reserved for a built-in plugin or provider",
            ));
        }
        Ok(())
    }

    fn local_error(
        &self,
        plugin_id: &str,
        kind: io::ErrorKind,
        message: &str,
    ) -> PluginRegistryError {
        PluginRegistryError::Io {
            operation: "apply local plugin edit to",
            path: self.path.clone(),
            source: io::Error::new(kind, format!("local plugin {plugin_id}: {message}")),
        }
    }

    fn stage_local(&mut self, plugin_id: &str, desired: Option<LocalPluginRegistration>) {
        let edit = self
            .pending_local
            .entry(plugin_id.to_owned())
            .or_insert_with(|| LocalPluginEdit {
                expected: self.document.local_plugins.get(plugin_id).cloned(),
                desired: None,
            });
        edit.desired = desired.clone();
        // Adding and then removing a new registration cancels only that local edit.
        if edit.expected.is_none() && edit.desired.is_none() {
            self.pending_local.remove(plugin_id);
        }
        if let Some(registration) = desired {
            self.local_plugins
                .insert(plugin_id.to_owned(), registration);
        } else {
            self.local_plugins.remove(plugin_id);
        }
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
        self.pending.insert(
            canonical_plugin_id(plugin_id).to_owned(),
            PluginPreference { enabled },
        );
        Ok(())
    }

    /// Merge only staged assignments into the latest strictly validated document.
    /// Writers serialize on a persistent sidecar lock; the last committed assignment
    /// to the same preference wins. Local edits compare the complete original record
    /// with the latest record before applying any edit; concurrent changes conflict.
    /// In particular, a stale grants update cannot recreate a removed registration.
    /// Conflicts require reloading and explicitly restaging the intended local edit.
    /// Success refreshes this snapshot and clears staged edits.
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
        for (id, edit) in &self.pending_local {
            let current = latest.local_plugins.get(id);
            if current != edit.expected.as_ref() {
                let (kind, reason) = match (current, edit.expected.as_ref()) {
                    (None, _) => (io::ErrorKind::NotFound, "registration was removed"),
                    (Some(_), None) => (
                        io::ErrorKind::AlreadyExists,
                        "id was registered by another writer",
                    ),
                    (Some(current), Some(expected)) if current.path != expected.path => {
                        (io::ErrorKind::InvalidData, "registered path changed")
                    }
                    _ => (io::ErrorKind::InvalidData, "registered grants changed"),
                };
                return Err(self.local_error(
                    id,
                    kind,
                    &format!("{reason} since loading; reload and explicitly restage the edit"),
                ));
            }
        }
        if !self.pending.is_empty() || !self.pending_local.is_empty() || latest.schema == 1 {
            latest.plugins.extend(self.pending.clone());
            // Upgrade only an explicitly edited GUI preference, under the same
            // merge lock. Read-only inspection and unrelated writes preserve the
            // legacy key; a newer canonical assignment always takes precedence.
            if self.pending.contains_key(GUI_PLUGIN_ID) {
                latest.plugins.remove(LEGACY_GUI_PLUGIN_ID);
            }
            for (id, edit) in &self.pending_local {
                if let Some(registration) = &edit.desired {
                    latest
                        .local_plugins
                        .insert(id.clone(), registration.clone());
                } else {
                    latest.local_plugins.remove(id);
                }
            }
            latest.schema = REGISTRY_SCHEMA;
            latest.validate(&self.path)?;
            let mut bytes = serde_json::to_vec_pretty(&latest)
                .expect("the typed plugin registry is always serializable");
            bytes.push(b'\n');
            if bytes.len() > MAX_REGISTRY_BYTES {
                return Err(PluginRegistryError::TooLarge {
                    path: self.path.clone(),
                });
            }
            TemporaryRegistry::create(&self.path)?.replace(&self.path, &bytes)?;
        }
        self.local_plugins = latest.local_plugins.clone();
        self.document = latest;
        self.pending.clear();
        self.pending_local.clear();
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

fn deserialize_unique_ids<'de, D, T>(deserializer: D) -> Result<BTreeMap<String, T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    struct UniqueIdsVisitor<T>(std::marker::PhantomData<T>);

    impl<'de, T: Deserialize<'de>> serde::de::Visitor<'de> for UniqueIdsVisitor<T> {
        type Value = BTreeMap<String, T>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("an object with unique plugin IDs")
        }

        fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
        where
            M: serde::de::MapAccess<'de>,
        {
            let mut entries = BTreeMap::new();
            while let Some((id, entry)) = map.next_entry::<String, T>()? {
                if entries.insert(id.clone(), entry).is_some() {
                    return Err(serde::de::Error::custom(format!(
                        "duplicate plugin id: {id}"
                    )));
                }
            }
            Ok(entries)
        }
    }

    deserializer.deserialize_map(UniqueIdsVisitor(std::marker::PhantomData))
}

fn deserialize_local_plugins<'de, D>(
    deserializer: D,
) -> Result<Option<BTreeMap<String, LocalPluginRegistration>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // A present null must not masquerade as an absent schema-1 field.
    deserialize_unique_ids(deserializer).map(Some)
}

fn deserialize_local_path<'de, D>(deserializer: D) -> Result<PathBuf, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let path = PathBuf::deserialize(deserializer)?;
    validate_local_path(&path).map_err(serde::de::Error::custom)?;
    Ok(path)
}

fn deserialize_grants<'de, D>(deserializer: D) -> Result<Vec<Permission>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let grants = Vec::<Permission>::deserialize(deserializer)?;
    validate_grants(&grants).map_err(serde::de::Error::custom)?;
    Ok(grants)
}

fn validate_local_path(path: &Path) -> Result<(), &'static str> {
    let Some(text) = path.to_str() else {
        return Err("path must be Unicode and representable as JSON");
    };
    if text.is_empty() || text.contains('\0') || !path.is_absolute() {
        return Err("path must be a nonempty absolute local path without NUL characters");
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        if !matches!(
            path.components().next(),
            Some(Component::Prefix(prefix))
                if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
        ) {
            return Err("path must use a local drive, not a UNC or device namespace");
        }
    }
    Ok(())
}

fn validate_grants(grants: &[Permission]) -> Result<(), &'static str> {
    for (index, grant) in grants.iter().enumerate() {
        if grants[..index].contains(grant) {
            return Err("grants must contain unique permissions");
        }
    }
    Ok(())
}

fn validate_local_registration(registration: &LocalPluginRegistration) -> Result<(), &'static str> {
    validate_local_path(&registration.path)?;
    validate_grants(&registration.grants)
}

fn reserved_plugin_id(id: &str) -> bool {
    matches!(
        id,
        LEGACY_GUI_PLUGIN_ID | GUI_PLUGIN_ID | "codex.ui.adapter" | "codlet.core.host"
    )
}

/// User-facing aliases are resolved before preparing a control receipt. Runtime
/// identities and already-issued receipts retain their original exact IDs.
pub(crate) fn canonical_plugin_id(id: &str) -> &str {
    if id == LEGACY_GUI_PLUGIN_ID {
        GUI_PLUGIN_ID
    } else {
        id
    }
}

impl Default for RegistryDocument {
    fn default() -> Self {
        Self {
            schema: REGISTRY_SCHEMA,
            plugins: BTreeMap::new(),
            local_plugins: BTreeMap::new(),
        }
    }
}

impl RegistryDocument {
    fn read(path: &Path) -> Result<Self, PluginRegistryError> {
        let document = match read_registry_text(path)? {
            Some(json) => {
                let input: RegistryInput =
                    serde_json::from_str(&json).map_err(|error| PluginRegistryError::Json {
                        path: path.to_owned(),
                        message: error.to_string(),
                    })?;
                match input.schema {
                    1 if input.local_plugins.is_some() => {
                        return Err(PluginRegistryError::Json {
                            path: path.to_owned(),
                            message: "schema 1 does not allow localPlugins".to_owned(),
                        });
                    }
                    REGISTRY_SCHEMA if input.local_plugins.is_none() => {
                        return Err(PluginRegistryError::Json {
                            path: path.to_owned(),
                            message: "schema 2 requires localPlugins".to_owned(),
                        });
                    }
                    1 | REGISTRY_SCHEMA => (),
                    other => return Err(PluginRegistryError::Schema(other)),
                }
                Self {
                    schema: input.schema,
                    plugins: input.plugins,
                    local_plugins: input.local_plugins.unwrap_or_default(),
                }
            }
            None => Self::default(),
        };
        document.validate(path)?;
        Ok(document)
    }

    fn validate(&self, path: &Path) -> Result<(), PluginRegistryError> {
        if !matches!(self.schema, 1 | REGISTRY_SCHEMA) {
            return Err(PluginRegistryError::Schema(self.schema));
        }
        if let Some(plugin_id) = self.plugins.keys().find(|id| !valid_plugin_id(id)) {
            return Err(PluginRegistryError::PluginId(plugin_id.clone()));
        }
        let mut paths = BTreeMap::new();
        for (id, registration) in &self.local_plugins {
            if !valid_plugin_id(id) {
                return Err(PluginRegistryError::PluginId(id.clone()));
            }
            let invalid = if reserved_plugin_id(id) {
                Some("id is reserved for a built-in plugin or provider")
            } else {
                validate_local_registration(registration).err()
            };
            if let Some(message) = invalid {
                return Err(PluginRegistryError::Json {
                    path: path.to_owned(),
                    message: format!("local plugin {id}: {message}"),
                });
            }
            if let Some(previous) = paths.insert(&registration.path, id) {
                return Err(PluginRegistryError::Json {
                    path: path.to_owned(),
                    message: format!("local plugins {previous} and {id} have duplicate paths"),
                });
            }
        }
        Ok(())
    }
}

fn read_registry_text(path: &Path) -> Result<Option<String>, PluginRegistryError> {
    let read_error = |source| PluginRegistryError::Io {
        operation: "read",
        path: path.to_owned(),
        source,
    };
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(read_error(error)),
    };
    if file.metadata().map_err(read_error)?.len() > MAX_REGISTRY_BYTES as u64 {
        return Err(PluginRegistryError::TooLarge {
            path: path.to_owned(),
        });
    }
    let mut bytes = Vec::new();
    // Metadata is only an early rejection. A concurrent writer cannot make the
    // allocation/read unbounded by growing the file after that check.
    file.take(MAX_REGISTRY_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(read_error)?;
    if bytes.len() > MAX_REGISTRY_BYTES {
        return Err(PluginRegistryError::TooLarge {
            path: path.to_owned(),
        });
    }
    let text = String::from_utf8(bytes).map_err(|_| {
        read_error(io::Error::new(
            io::ErrorKind::InvalidData,
            "stream did not contain valid UTF-8",
        ))
    })?;
    Ok(Some(text))
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
        manifest: PluginManifest::parse(include_str!("../bundled/codlet/codlet.json"))?,
        source: Some(include_str!("../bundled/codlet/dist/renderer.js").to_owned()),
        host: None,
        generation: 1,
    })
}

pub fn bundled_codex_ui_adapter() -> Result<LoadedPlugin, ManifestError> {
    Ok(LoadedPlugin {
        manifest: PluginManifest::parse(include_str!("../bundled/codex-ui-adapter/codlet.json"))?,
        source: Some(include_str!("../bundled/codex-ui-adapter/dist/renderer.js").to_owned()),
        host: None,
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

pub(crate) fn valid_plugin_id(id: &str) -> bool {
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
    fn registry_byte_limit_rejects_large_reads_and_oversized_saves_without_overwrite() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        let initial = br#"{"schema":2,"plugins":{},"localPlugins":{}}"#;
        let mut oversized = initial.to_vec();
        oversized.resize(MAX_REGISTRY_BYTES + 1, b' ');
        fs::write(&path, &oversized).unwrap();
        let error = PluginRegistry::load(&path).unwrap_err();
        assert!(matches!(error, PluginRegistryError::TooLarge { .. }));
        assert!(error.to_string().contains("1048576-byte limit"));
        assert_eq!(fs::read(&path).unwrap(), oversized);
        assert_eq!(directory.path().read_dir().unwrap().count(), 1);

        fs::write(&path, initial).unwrap();
        let mut registry = PluginRegistry::load(&path).unwrap();
        let previous = registry.document.clone();
        for index in 0..8192 {
            registry
                .set_enabled(&format!("dev.{}.{index}", "x".repeat(100)), false)
                .unwrap();
        }
        let staged = registry.pending.clone();
        assert!(matches!(
            registry.save(),
            Err(PluginRegistryError::TooLarge { .. })
        ));
        assert_eq!(registry.document, previous);
        assert_eq!(registry.pending, staged);
        assert_eq!(fs::read(&path).unwrap(), initial);
        assert_eq!(directory.path().read_dir().unwrap().count(), 2); // registry + stable lock only
    }

    #[test]
    fn bundled_codlet_uses_the_public_manifest_contract() {
        let plugin = bundled_codlet().unwrap();
        assert_eq!(plugin.manifest.id, "codlet-gui");
        assert_eq!(
            plugin.manifest.renderer.as_ref().unwrap().world,
            RendererWorld::Isolated
        );
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
        assert!(plugin.source.as_deref().unwrap().contains("module.exports"));
        assert!(
            plugin
                .source
                .as_deref()
                .unwrap()
                .contains("codex.ui.titlebar.afterMenu@1")
        );
        assert!(
            plugin
                .source
                .as_deref()
                .unwrap()
                .contains("context.rpc.request")
        );
        assert!(
            plugin
                .source
                .as_deref()
                .unwrap()
                .contains("capability?.available")
        );
        assert!(
            plugin
                .source
                .as_deref()
                .unwrap()
                .contains("codlet.runtime.ping")
        );
        assert!(plugin.source.as_deref().unwrap().contains("disableSelf"));
        assert!(
            !plugin
                .source
                .as_deref()
                .unwrap()
                .contains("data-app-shell-header-layout")
        );
        assert!(
            !plugin
                .source
                .as_deref()
                .unwrap()
                .contains("app-shell-header-context-menu-surface")
        );
    }

    #[test]
    fn bundled_ui_adapter_provides_the_gui_mount_capability() {
        let plugin = bundled_codex_ui_adapter().unwrap();
        assert_eq!(plugin.manifest.id, "codex.ui.adapter");
        assert_eq!(
            plugin.manifest.renderer.as_ref().unwrap().world,
            RendererWorld::Isolated
        );
        assert_eq!(plugin.manifest.permissions, [Permission::UiDom]);
        assert_eq!(plugin.manifest.provides.len(), 1);
        assert_eq!(
            plugin.manifest.provides[0],
            CapabilityDescriptor::new("codex.ui.titlebar.afterMenu", 1, CapabilityScope::Target)
                .unwrap()
        );
        assert!(plugin.manifest.requires.is_empty());
        assert!(
            plugin
                .source
                .as_deref()
                .unwrap()
                .contains("HEADER_SELECTOR")
        );
        assert!(
            plugin
                .source
                .as_deref()
                .unwrap()
                .contains("data-app-shell-header-layout")
        );
        assert!(
            plugin
                .source
                .as_deref()
                .unwrap()
                .contains("codex.ui.titlebar.afterMenu@1")
        );
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
    fn optional_entries_keep_renderer_schema_one_compatible_and_accept_host_only() {
        let renderer = bundled_codlet().unwrap();
        assert!(renderer.manifest.host.is_none());
        assert!(renderer.host.is_none());
        let value = serde_json::to_value(&renderer.manifest).unwrap();
        assert!(value.get("host").is_none());
        assert_eq!(value["renderer"]["entry"], "dist/renderer.js");
        assert_eq!(
            PluginManifest::parse(&value.to_string()).unwrap(),
            renderer.manifest
        );

        let host = PluginManifest::parse(
            r#"{"schema":1,"id":"dev.host","version":"1",
                "host":{"entry":"dist/host.js"},
                "permissions":["host.process","cdp.raw"]}"#,
        )
        .unwrap();
        assert!(host.renderer.is_none());
        assert_eq!(host.host.as_ref().unwrap().entry, "dist/host.js");
        let value = serde_json::to_value(&host).unwrap();
        assert!(value.get("renderer").is_none());
        assert_eq!(PluginManifest::parse(&value.to_string()).unwrap(), host);
        assert_eq!(
            PluginManifest::parse(r#"{"schema":1,"id":"dev.empty","version":"1"}"#),
            Err(ManifestError::EntryRequired)
        );
    }

    #[test]
    fn host_manifest_requires_built_javascript_and_rejects_executable_commands() {
        let mut value = serde_json::json!({
            "schema":1, "id":"dev.host", "version":"1",
            "host":{"entry":"dist/host.js"},
            "permissions":["host.process"]
        });
        for entry in [
            "",
            "../host.js",
            "C:/host.js",
            "host.exe",
            "host.node",
            "host.ts",
            "host.mts",
            "host",
            "host.js --flag",
            "host\0.js",
        ] {
            value["host"]["entry"] = serde_json::json!(entry);
            assert!(matches!(
                PluginManifest::parse(&value.to_string()),
                Err(ManifestError::HostEntry(_))
            ));
        }
        value["host"]["entry"] = serde_json::json!("dist/host.cjs");
        value["permissions"] = serde_json::json!([]);
        assert_eq!(
            PluginManifest::parse(&value.to_string()),
            Err(ManifestError::HostProcessPermissionRequired)
        );
        value["permissions"] = serde_json::json!(["host.process"]);
        for host in [
            serde_json::json!({"command":["bin/helper.exe"],"protocol":"jsonl"}),
            serde_json::json!({"entry":"dist/host.js","command":["node.exe"]}),
            serde_json::json!({"entry":"dist/host.js","protocol":"jsonl"}),
            serde_json::json!({"entry":"dist/host.js","runtime":"C:/other/node.exe"}),
        ] {
            value["host"] = host;
            assert!(matches!(
                PluginManifest::parse(&value.to_string()),
                Err(ManifestError::Json(_))
            ));
        }
    }

    #[test]
    fn missing_registry_uses_defaults_without_creating_a_file() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        let registry = PluginRegistry::load(&path).unwrap();

        assert!(registry.is_enabled("codlet-gui"));
        assert!(registry.is_enabled("codex.ui.adapter"));
        assert_eq!(registry.path(), path);
        assert!(!path.exists());
    }

    #[test]
    fn registry_round_trip_atomically_replaces_the_previous_state() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("state").join("config.json");
        let mut registry = PluginRegistry::load(&path).unwrap();

        registry.set_enabled("codlet-gui", false).unwrap();
        registry.save().unwrap();
        assert!(
            !PluginRegistry::load(&path)
                .unwrap()
                .is_enabled("codlet-gui")
        );

        registry.set_enabled("codlet-gui", true).unwrap();
        registry.save().unwrap();
        assert!(
            PluginRegistry::load(&path)
                .unwrap()
                .is_enabled("codlet-gui")
        );
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

        first.set_enabled("codlet-gui", false).unwrap();
        second.set_enabled("codex.ui.adapter", false).unwrap();
        first.save().unwrap();
        second.save().unwrap();

        let committed = PluginRegistry::load(&path).unwrap();
        assert!(!committed.is_enabled("codlet-gui"));
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
        stale.set_enabled("codlet-gui", false).unwrap();
        stale.save().unwrap();

        assert!(stale.is_enabled("future.plugin"));
        assert!(!stale.is_enabled("another.future-plugin"));
        assert!(!stale.is_enabled("codlet-gui"));
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
        second.set_enabled("codlet-gui", true).unwrap();
        first.set_enabled("codlet-gui", false).unwrap();
        first.save().unwrap();
        second.save().unwrap();
        assert!(
            PluginRegistry::load(&path)
                .unwrap()
                .is_enabled("codlet-gui")
        );

        // Saving again without an assignment refreshes, never replays the old disable.
        first.save().unwrap();
        assert!(first.is_enabled("codlet-gui"));
        assert!(
            PluginRegistry::load(&path)
                .unwrap()
                .is_enabled("codlet-gui")
        );
    }

    #[test]
    fn save_revalidates_latest_bytes_and_retains_staged_edits_on_failure() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        let mut registry = PluginRegistry::load(&path).unwrap();
        registry.set_enabled("codlet-gui", false).unwrap();
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
        assert!(!registry.is_enabled("codlet-gui"));
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
        registry.set_enabled("codlet-gui", false).unwrap();
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
        assert!(!registry.is_enabled("codlet-gui"));
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
        registry.set_enabled("codlet-gui", false).unwrap();

        let plugins = enabled_bundled_plugins(&registry).unwrap();
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].manifest.id, "codex.ui.adapter");
    }
}
