//! Registry-scoped user preferences. These never alter plugin grants, source
//! registrations, update sources, or the authority of a lifecycle transaction.
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const MAX_BYTES: u64 = 16 * 1024;
const MAX_REVISION: u64 = (1u64 << 53) - 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimePreferences {
    pub automatic_update_checks: bool,
    #[serde(default = "default_plugin_update_checks")]
    pub check_plugin_updates_on_startup: bool,
    #[serde(default = "default_show_plugin_tags")]
    pub show_plugin_tags: bool,
    pub update_check_interval_seconds: Option<u64>,
    pub local_source_auto_reload: Option<bool>,
}

impl Default for RuntimePreferences {
    fn default() -> Self {
        Self {
            automatic_update_checks: true,
            check_plugin_updates_on_startup: true,
            show_plugin_tags: true,
            update_check_interval_seconds: None,
            local_source_auto_reload: None,
        }
    }
}

fn default_plugin_update_checks() -> bool {
    true
}

fn default_show_plugin_tags() -> bool {
    true
}

impl RuntimePreferences {
    pub fn validate(&self) -> Result<(), SettingsError> {
        if self
            .update_check_interval_seconds
            .is_some_and(|value| !(300..=86400).contains(&value))
        {
            return Err(SettingsError::new(
                "invalid_settings",
                "The update interval must be an integer from 300 to 86400 seconds.",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsDocument {
    pub schema: u32,
    pub revision: u64,
    pub values: RuntimePreferences,
}

impl Default for SettingsDocument {
    fn default() -> Self {
        Self {
            schema: 1,
            revision: 0,
            values: RuntimePreferences::default(),
        }
    }
}

#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct SettingsError {
    pub code: &'static str,
    pub message: String,
}
impl SettingsError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
fn io_error(error: impl std::fmt::Display) -> SettingsError {
    SettingsError::new("settings_unavailable", error.to_string())
}

#[derive(Clone)]
pub struct RuntimeSettings {
    path: Arc<PathBuf>,
    // All windows of a Host share this cache. The foreground watcher does not
    // perform file I/O on each iteration; reads/saves replace it under one lock.
    cached: Arc<Mutex<Result<SettingsDocument, SettingsError>>>,
}

impl RuntimeSettings {
    pub fn for_registry(registry_path: &Path) -> Self {
        // Callers supply the owner-selected registry path. Appending preserves
        // distinct scopes even when several registries share one directory.
        let mut name = registry_path.as_os_str().to_owned();
        name.push(".preferences.json");
        let path = PathBuf::from(name);
        Self {
            cached: Arc::new(Mutex::new(read_document(&path))),
            path: Arc::new(path),
        }
    }
    pub fn cached(&self) -> Result<SettingsDocument, SettingsError> {
        self.cached
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }
    pub fn read(&self) -> Result<SettingsDocument, SettingsError> {
        let mut cache = self
            .cached
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *cache = read_document(&self.path);
        cache.clone()
    }
    pub fn save(
        &self,
        expected_revision: u64,
        values: RuntimePreferences,
    ) -> Result<SettingsDocument, SettingsError> {
        values.validate()?;
        if expected_revision >= MAX_REVISION {
            return Err(SettingsError::new(
                "invalid_settings",
                "Invalid settings revision.",
            ));
        }
        let mut cache = self
            .cached
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let parent = self
            .path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .ok_or_else(|| io_error("Settings have no registry directory."))?;
        fs::create_dir_all(parent).map_err(io_error)?;
        let _lock = lock_file(&self.path)?;
        let latest = read_document(&self.path)?;
        *cache = Ok(latest.clone());
        if latest.revision != expected_revision {
            return Err(SettingsError::new(
                "settings_conflict",
                "Settings changed in another window. Review the current values before saving again.",
            ));
        }
        if latest.values == values {
            return Ok(latest);
        }
        let next = SettingsDocument {
            schema: 1,
            revision: latest.revision + 1,
            values,
        };
        let mut bytes = serde_json::to_vec_pretty(&next).expect("typed preferences serialize");
        bytes.push(b'\n');
        let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(io_error)?;
        temporary.write_all(&bytes).map_err(io_error)?;
        temporary.as_file().sync_all().map_err(io_error)?;
        // The lock spans revision comparison and atomic replacement. Never
        // truncate the old file or unlink the stable lock identity.
        temporary.persist(self.path.as_ref()).map_err(io_error)?;
        *cache = Ok(next.clone());
        Ok(next)
    }
}

fn checked_file(path: &Path) -> Result<Option<File>, SettingsError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(io_error("Settings cannot be a symbolic link."));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(error)),
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path).map_err(io_error)?;
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return Err(io_error("Settings must be a bounded regular file."));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
        };
        let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
            return Err(io_error(std::io::Error::last_os_error()));
        }
        if metadata.file_attributes() & 0x400 != 0 || information.nNumberOfLinks != 1 {
            return Err(io_error("Settings cannot be a reparse point or hard link."));
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(io_error("Settings cannot be a hard link."));
        }
    }
    Ok(Some(file))
}

fn read_document(path: &Path) -> Result<SettingsDocument, SettingsError> {
    let Some(file) = checked_file(path)? else {
        return Ok(SettingsDocument::default());
    };
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(io_error("Settings exceed the size limit."));
    }
    let document: SettingsDocument = serde_json::from_slice(&bytes).map_err(io_error)?;
    if document.schema != 1 || document.revision > MAX_REVISION {
        return Err(io_error("Unsupported settings schema or revision."));
    }
    document.values.validate()?;
    Ok(document)
}

fn lock_file(path: &Path) -> Result<File, SettingsError> {
    let mut name = path.as_os_str().to_owned();
    name.push(".lock");
    let path = PathBuf::from(name);
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0x1 | 0x2).custom_flags(0x00200000);
    }
    if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(io_error("Settings lock cannot be a symbolic link."));
    }
    let file = options.open(path).map_err(io_error)?;
    if !file.metadata().map_err(io_error)?.is_file() {
        return Err(io_error("Settings lock is not a regular file."));
    }
    let start = Instant::now();
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(TryLockError::WouldBlock) if start.elapsed() < Duration::from_millis(1500) => {
                std::thread::sleep(Duration::from_millis(10))
            }
            Err(TryLockError::WouldBlock) => {
                return Err(SettingsError::new(
                    "settings_busy",
                    "Another settings writer is busy. Try again.",
                ));
            }
            Err(TryLockError::Error(error)) => return Err(io_error(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_are_read_only_and_saves_persist_without_touching_registrations() {
        let root = tempfile::tempdir().unwrap();
        let registry = root.path().join("配置.json");
        fs::write(&registry, b"original grants and registrations").unwrap();
        let settings = RuntimeSettings::for_registry(&registry);
        assert_eq!(settings.read().unwrap(), SettingsDocument::default());
        assert!(!settings.path.exists());
        let values = RuntimePreferences {
            automatic_update_checks: false,
            check_plugin_updates_on_startup: true,
            show_plugin_tags: true,
            update_check_interval_seconds: Some(3600),
            local_source_auto_reload: Some(true),
        };
        let result = settings.save(0, values.clone()).unwrap();
        assert_eq!(result.revision, 1);
        assert_eq!(
            RuntimeSettings::for_registry(&registry)
                .read()
                .unwrap()
                .values,
            values
        );
        assert_eq!(
            fs::read(&registry).unwrap(),
            b"original grants and registrations"
        );
        assert_eq!(
            RuntimeSettings::for_registry(&root.path().join("other.json"))
                .read()
                .unwrap()
                .revision,
            0
        );
    }
    #[test]
    fn stale_and_simultaneous_writers_cannot_erase_each_others_settings() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("registry.json");
        let first = RuntimeSettings::for_registry(&path);
        let second = RuntimeSettings::for_registry(&path);
        let a = RuntimePreferences {
            local_source_auto_reload: Some(true),
            ..Default::default()
        };
        let b = RuntimePreferences {
            automatic_update_checks: false,
            ..Default::default()
        };
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let other = barrier.clone();
        let thread = std::thread::spawn(move || {
            other.wait();
            first.save(0, a)
        });
        barrier.wait();
        let right = second.save(0, b);
        let left = thread.join().unwrap();
        assert_eq!(usize::from(left.is_ok()) + usize::from(right.is_ok()), 1);
        assert_eq!(
            left.err().or(right.err()).unwrap().code,
            "settings_conflict"
        );
        assert_eq!(second.read().unwrap().revision, 1);
    }
    #[test]
    fn invalid_values_documents_and_linked_files_do_not_get_overwritten() {
        let root = tempfile::tempdir().unwrap();
        let settings = RuntimeSettings::for_registry(&root.path().join("registry.json"));
        for value in [0, 299, 86401, u64::MAX] {
            assert!(
                settings
                    .save(
                        0,
                        RuntimePreferences {
                            update_check_interval_seconds: Some(value),
                            ..Default::default()
                        }
                    )
                    .is_err()
            );
            assert!(!settings.path.exists());
        }
        fs::write(
            settings.path.as_ref(),
            br#"{"schema":1,"revision":0,"values":{"automaticUpdateChecks":true,"unknown":true}}"#,
        )
        .unwrap();
        let before = fs::read(settings.path.as_ref()).unwrap();
        assert!(settings.read().is_err());
        assert!(settings.save(0, RuntimePreferences::default()).is_err());
        assert_eq!(fs::read(settings.path.as_ref()).unwrap(), before);
        fs::remove_file(settings.path.as_ref()).unwrap();
        let other = root.path().join("other");
        fs::write(
            &other,
            serde_json::to_vec(&SettingsDocument::default()).unwrap(),
        )
        .unwrap();
        fs::hard_link(&other, settings.path.as_ref()).unwrap();
        assert!(settings.read().is_err());
        assert!(settings.save(0, RuntimePreferences::default()).is_err());
        assert_eq!(
            fs::read(&other).unwrap(),
            serde_json::to_vec(&SettingsDocument::default()).unwrap()
        );
    }
}
