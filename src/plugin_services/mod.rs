//! Persistent, plugin-owned Core services. Callers are authenticated by the
//! Host/Renderer dispatcher before an owner reaches this module.

use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

mod secrets;
mod storage;

pub use secrets::SecretValue;

pub type Result<T> = std::result::Result<T, ServiceError>;
const LOCK_TIMEOUT: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, PartialEq)]
pub struct ServiceError {
    pub code: &'static str,
    pub message: String,
    pub data: Option<Value>,
}

impl ServiceError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub(crate) fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }
}

impl std::fmt::Display for ServiceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for ServiceError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceOwner {
    pub plugin_id: String,
    pub source_identity: String,
}

impl ServiceOwner {
    fn validate(&self) -> Result<()> {
        if !crate::plugins::valid_plugin_id(&self.plugin_id)
            || self.source_identity.is_empty()
            || self.source_identity.len() > 1024
            || self.source_identity.chars().any(char::is_control)
        {
            return Err(ServiceError::new(
                "invalid_owner",
                "plugin services require a valid plugin ID and stable source identity",
            ));
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct PluginServices {
    storage: storage::PluginStorage,
    secrets: secrets::PluginSecrets,
}

impl PluginServices {
    #[cfg(feature = "test-fixtures")]
    pub(crate) fn fixture(registry_path: &Path) -> Result<Self> {
        let root = ServiceRoot::new(registry_path)?;
        Ok(Self {
            storage: storage::PluginStorage::new(root.clone()),
            secrets: secrets::PluginSecrets::fixture(root),
        })
    }
    pub fn new(registry_path: &Path) -> Result<Self> {
        let root = ServiceRoot::new(registry_path)?;
        Ok(Self {
            storage: storage::PluginStorage::new(root.clone()),
            secrets: secrets::PluginSecrets::system(root),
        })
    }

    pub fn invoke_storage(
        &self,
        owner: &ServiceOwner,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        self.storage.invoke(owner, method, params)
    }

    pub fn invoke_credentials(
        &self,
        owner: &ServiceOwner,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        self.secrets.invoke(owner, method, params)
    }

    pub fn resolve_credential(
        &self,
        owner: &ServiceOwner,
        reference: &str,
        origin: &str,
    ) -> Result<SecretValue> {
        self.secrets.resolve(owner, reference, origin)
    }
}

#[derive(Clone)]
struct ServiceRoot {
    path: Arc<PathBuf>,
    scope_hash: Arc<String>,
}

#[derive(Clone)]
struct Namespace {
    path: PathBuf,
    credential_prefix: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerDocument {
    schema: u32,
    plugin_id: String,
    source_identity_hash: String,
}

impl ServiceRoot {
    fn new(registry_path: &Path) -> Result<Self> {
        let parent = registry_path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .ok_or_else(|| {
                ServiceError::new("storage_unavailable", "registry has no parent directory")
            })?;
        if !parent.is_dir() {
            return Err(ServiceError::new(
                "storage_unavailable",
                "registry parent directory is unavailable",
            ));
        }
        let mut root_name = registry_path.as_os_str().to_owned();
        root_name.push(".plugin-services");
        let root_path = PathBuf::from(root_name);
        ensure_directory(&root_path)?;
        ensure_directory(&root_path.join("plugins"))?;
        let scope_path = registry_path
            .canonicalize()
            .unwrap_or_else(|_| registry_path.to_path_buf());
        Ok(Self {
            path: Arc::new(root_path),
            scope_hash: Arc::new(hash_hex(&path_identity_bytes(&scope_path))),
        })
    }

    fn namespace(&self, owner: &ServiceOwner) -> Result<Namespace> {
        owner.validate()?;
        let path = self.path.join("plugins").join(&owner.plugin_id);
        ensure_directory(&path)?;
        let owner_hash = hash_hex(owner.source_identity.as_bytes());
        let _lock = lock_file(&path.join("owner.lock"))?;
        let owner_path = path.join("owner.json");
        let expected = OwnerDocument {
            schema: 1,
            plugin_id: owner.plugin_id.clone(),
            source_identity_hash: owner_hash.clone(),
        };
        match read_json::<OwnerDocument>(&owner_path, 16 * 1024)? {
            None => atomic_json(&owner_path, &expected, 16 * 1024)?,
            Some(current)
                if current.schema == expected.schema
                    && current.plugin_id == expected.plugin_id
                    && current.source_identity_hash == expected.source_identity_hash => {}
            Some(_) => {
                return Err(ServiceError::new(
                    "source_identity_changed",
                    "this plugin ID already has data owned by another stable source identity",
                ));
            }
        }
        Ok(Namespace {
            path,
            credential_prefix: format!(
                "Codlet/{}/{}/{owner_hash}",
                &self.scope_hash[..32],
                owner.plugin_id
            ),
        })
    }
}

fn ensure_directory(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => validate_directory(&metadata)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match fs::create_dir(path) {
                Ok(()) => {}
                // Another window can initialize the same plugin namespace
                // between the metadata probe and create_dir. Re-open and
                // validate what won the race instead of failing the request.
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let metadata = fs::symlink_metadata(path).map_err(storage_io)?;
                    validate_directory(&metadata)?;
                }
                Err(error) => return Err(storage_io(error)),
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(storage_io)?;
            }
        }
        Err(error) => return Err(storage_io(error)),
    }
    Ok(())
}

fn validate_directory(metadata: &fs::Metadata) -> Result<()> {
    if !metadata.is_dir() || is_link_or_reparse(metadata) {
        return Err(ServiceError::new(
            "storage_unavailable",
            "plugin service directory is not an ordinary directory",
        ));
    }
    Ok(())
}

fn read_json<T: DeserializeOwned>(path: &Path, maximum: u64) -> Result<Option<T>> {
    let Some(file) = checked_file(path, maximum)? else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    file.take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(storage_io)?;
    if bytes.len() as u64 > maximum {
        return Err(ServiceError::new(
            "storage_corrupt",
            "plugin service document exceeds its size limit",
        ));
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| ServiceError::new("storage_corrupt", "plugin service document is invalid"))
}

fn atomic_json(path: &Path, value: &impl Serialize, maximum: u64) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| {
        ServiceError::new(
            "storage_unavailable",
            "plugin service state did not serialize",
        )
    })?;
    if bytes.len() as u64 > maximum {
        return Err(ServiceError::new(
            "quota_exceeded",
            "plugin service state exceeds its quota",
        ));
    }
    let parent = path.parent().ok_or_else(|| {
        ServiceError::new("storage_unavailable", "plugin service path has no parent")
    })?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(storage_io)?;
    temporary.write_all(&bytes).map_err(storage_io)?;
    temporary.as_file().sync_all().map_err(storage_io)?;
    temporary.persist(path).map_err(storage_io)?;
    Ok(())
}

fn checked_file(path: &Path, maximum: u64) -> Result<Option<File>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(storage_io(error)),
    };
    if !metadata.is_file() || metadata.len() > maximum || is_link_or_reparse(&metadata) {
        return Err(ServiceError::new(
            "storage_corrupt",
            "plugin service state is not a bounded ordinary file",
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    let file = options.open(path).map_err(storage_io)?;
    let opened = file.metadata().map_err(storage_io)?;
    if !opened.is_file() || opened.len() > maximum || is_link_or_reparse(&opened) {
        return Err(ServiceError::new(
            "storage_corrupt",
            "plugin service state changed while opening",
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
        };
        let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0
            || information.nNumberOfLinks != 1
        {
            return Err(ServiceError::new(
                "storage_corrupt",
                "plugin service state cannot be a hard link",
            ));
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened.nlink() != 1 {
            return Err(ServiceError::new(
                "storage_corrupt",
                "plugin service state cannot be a hard link",
            ));
        }
    }
    Ok(Some(file))
}

fn lock_file(path: &Path) -> Result<File> {
    if fs::symlink_metadata(path).is_ok_and(|metadata| is_link_or_reparse(&metadata)) {
        return Err(ServiceError::new(
            "storage_unavailable",
            "plugin service lock is not an ordinary file",
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0x1 | 0x2).custom_flags(0x00200000);
    }
    let file = options.open(path).map_err(storage_io)?;
    if !file.metadata().map_err(storage_io)?.is_file() {
        return Err(ServiceError::new(
            "storage_unavailable",
            "plugin service lock is not a regular file",
        ));
    }
    let started = Instant::now();
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(TryLockError::WouldBlock) if started.elapsed() < LOCK_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(TryLockError::WouldBlock) => {
                return Err(ServiceError::new(
                    "storage_busy",
                    "another plugin service writer is busy",
                ));
            }
            Err(TryLockError::Error(error)) => return Err(storage_io(error)),
        }
    }
}

fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    false
}

fn hash_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(windows)]
fn path_identity_bytes(path: &Path) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str()
        .encode_wide()
        .flat_map(u16::to_le_bytes)
        .collect()
}

#[cfg(unix)]
fn path_identity_bytes(path: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    path.as_os_str().as_bytes().to_vec()
}

fn storage_io(_error: impl std::fmt::Display) -> ServiceError {
    ServiceError::new(
        "storage_unavailable",
        "plugin service storage is unavailable",
    )
}

fn decode<T: DeserializeOwned>(params: Value) -> Result<T> {
    serde_json::from_value(params)
        .map_err(|_| ServiceError::new("invalid_params", "plugin service parameters are invalid"))
}
