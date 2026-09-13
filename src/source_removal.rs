//! Optional source deletion after unregistering and retiring a plugin. Requests
//! carry no path: the registered directory and its Windows identity are pinned
//! at preview, checked again before unregistering, and checked before deletion.
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::plugin_control::PluginControlError;
use crate::plugins::PluginRegistry;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SourceRemovalRequest {
    pub registration_digest: String,
    pub source_identity: Option<String>,
}

impl SourceRemovalRequest {
    pub fn validate(&self) -> Result<(), PluginControlError> {
        if !valid_digest(&self.registration_digest)
            || self
                .source_identity
                .as_ref()
                .is_some_and(|identity| !valid_digest(identity))
        {
            return Err(error(
                "invalid_source_removal",
                "Use the source-removal identity from a fresh preview.",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRemovalPreview {
    pub schema: u32,
    pub kind: &'static str,
    pub plugin_id: String,
    pub path: PathBuf,
    pub status: &'static str,
    pub registration_digest: String,
    pub source_identity: Option<String>,
    pub warning: Option<String>,
}

impl SourceRemovalPreview {
    pub fn request(&self) -> Box<SourceRemovalRequest> {
        Box::new(SourceRemovalRequest {
            registration_digest: self.registration_digest.clone(),
            source_identity: self.source_identity.clone(),
        })
    }
}

#[derive(Debug)]
pub struct SourceRemovalPlan {
    registry_path: PathBuf,
    plugin_id: String,
    path: PathBuf,
    identity: Option<String>,
    managed: bool,
    skip: Option<SourceRemovalResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRemovalResult {
    pub status: &'static str,
    pub code: &'static str,
    pub message: String,
}

impl SourceRemovalResult {
    pub fn failed(&self) -> bool {
        self.status == "failed"
    }
    pub fn retirement_unconfirmed() -> Self {
        skipped(
            "source_removal_retirement_unconfirmed",
            "The plugin was unregistered. Source files were preserved because stopping the affected runtime was not fully confirmed.",
        )
    }
}

pub fn preview(
    registry: &PluginRegistry,
    plugin_id: &str,
) -> Result<SourceRemovalPreview, PluginControlError> {
    let registration = registry.local_plugins().get(plugin_id).ok_or_else(|| {
        error(
            "plugin_not_found",
            "This plugin has no registered source directory.",
        )
    })?;
    let managed = is_managed(registry, plugin_id, &registration.path);
    let inspected = protected_path(registry, plugin_id, &registration.path, managed)
        .and_then(|()| directory_identity(&registration.path));
    let (status, source_identity, warning) = match inspected {
        Ok(identity) => ("available", Some(identity), None),
        Err(issue) => (
            if issue.code == "source_directory_missing" {
                "missing"
            } else {
                "blocked"
            },
            None,
            Some(issue.message),
        ),
    };
    Ok(SourceRemovalPreview {
        schema: 1,
        kind: "codlet.source-removal-preview",
        plugin_id: plugin_id.into(),
        path: registration.path.clone(),
        status,
        source_identity,
        warning,
        registration_digest: crate::local_import::registration_digest(registry, plugin_id),
    })
}

pub fn prepare(
    registry: &PluginRegistry,
    plugin_id: &str,
    request: &SourceRemovalRequest,
) -> Result<SourceRemovalPlan, PluginControlError> {
    request.validate()?;
    if request.registration_digest != crate::local_import::registration_digest(registry, plugin_id)
    {
        return Err(error(
            "source_removal_registration_changed",
            "The registration changed after confirmation. Inspect the plugin again before removing it.",
        ));
    }
    let registration = registry.local_plugins().get(plugin_id).ok_or_else(|| {
        error(
            "plugin_not_found",
            "This plugin has no registered source directory.",
        )
    })?;
    let managed = is_managed(registry, plugin_id, &registration.path);
    let current = preview(registry, plugin_id)?;
    let skip = if current.source_identity.is_none() {
        Some(skipped(
            if current.status == "missing" {
                "source_directory_missing"
            } else {
                "source_removal_blocked"
            },
            format!(
                "The plugin will be unregistered and source deletion skipped. {}",
                current.warning.unwrap_or_default()
            ),
        ))
    } else if request.source_identity.is_none()
        || current.source_identity != request.source_identity
    {
        Some(skipped(
            "source_directory_changed",
            "The source directory moved or its identity changed after preview. The plugin will be unregistered; the replacement directory will be preserved.",
        ))
    } else {
        None
    };
    Ok(SourceRemovalPlan {
        registry_path: registry.path().to_owned(),
        plugin_id: plugin_id.into(),
        path: registration.path.clone(),
        identity: request.source_identity.clone(),
        managed,
        skip,
    })
}

/// Execute only after the selected registration is removed and its runtime has
/// stopped. The online owner runs this on a worker, retaining its original receipt.
pub fn apply(plan: SourceRemovalPlan) -> SourceRemovalResult {
    if let Some(mut skipped) = plan.skip {
        skipped.message = skipped
            .message
            .replace("will be unregistered", "was unregistered");
        return skipped;
    }
    let registry = match PluginRegistry::load(&plan.registry_path) {
        Ok(registry) => registry,
        Err(issue) => {
            return skipped(
                "source_removal_registry_unavailable",
                format!(
                    "The plugin was unregistered. Source files were preserved because the registry could not be rechecked: {issue}"
                ),
            );
        }
    };
    if registry.local_plugins().contains_key(&plan.plugin_id) {
        return skipped(
            "source_removal_reregistered",
            "The plugin ID was registered again. The confirmed source directory was preserved.",
        );
    }
    if let Err(issue) = protected_path(&registry, &plan.plugin_id, &plan.path, plan.managed) {
        return skipped(
            "source_removal_blocked",
            format!("The plugin was unregistered. {}", issue.message),
        );
    }
    #[cfg(windows)]
    {
        let directory = match windows::pin_directory(&plan.path, true) {
            Ok(directory) => directory,
            Err(issue) => {
                return skipped(
                    if issue.code == "source_directory_missing" {
                        "source_directory_missing"
                    } else {
                        "source_removal_blocked"
                    },
                    format!("The plugin was unregistered. {}", issue.message),
                );
            }
        };
        if Some(&directory.identity) != plan.identity.as_ref() {
            return skipped(
                "source_directory_changed",
                "The plugin was unregistered. The source directory moved or changed identity; the replacement directory was preserved.",
            );
        }
        match directory.remove() {
            Ok(()) => SourceRemovalResult { status: "deleted", code: "source_directory_deleted", message: "The plugin was unregistered and its confirmed source directory was deleted. Separate plugin data was preserved.".into() },
            Err(issue) => SourceRemovalResult { status: "failed", code: "source_removal_failed", message: format!("The plugin was unregistered, but its source directory was not fully deleted. Some source files may have been removed: {issue}") },
        }
    }
    #[cfg(not(windows))]
    skipped(
        "source_removal_unsupported",
        "The plugin was unregistered. Source removal is not supported on this platform.",
    )
}

#[cfg(windows)]
pub(crate) fn with_registered_directory<T>(
    registry: &PluginRegistry,
    plugin_id: &str,
    action: impl FnOnce(&Path) -> Result<T, PluginControlError>,
) -> Result<T, PluginControlError> {
    let registration = registry.local_plugins().get(plugin_id).ok_or_else(|| {
        error(
            "plugin_not_found",
            "This plugin has no registered source directory.",
        )
    })?;
    let directory = windows::pin_directory(&registration.path, false)?;
    action(&directory.path)
}

fn directory_identity(path: &Path) -> Result<String, PluginControlError> {
    #[cfg(windows)]
    {
        Ok(windows::pin_directory(path, false)?.identity)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err(error(
            "source_removal_unsupported",
            "Source removal is available on Windows.",
        ))
    }
}

fn is_managed(registry: &PluginRegistry, plugin_id: &str, path: &Path) -> bool {
    registry
        .managed_plugins()
        .get(plugin_id)
        .and_then(|record| record.current())
        .is_some_and(|version| version.package_path == path)
}

fn protected_path(
    registry: &PluginRegistry,
    plugin_id: &str,
    source: &Path,
    managed: bool,
) -> Result<(), PluginControlError> {
    crate::plugin_permissions::validate_policy_path(source)
        .map_err(|issue| error("source_removal_blocked", issue.to_string()))?;
    let blocked = || {
        error(
            "source_removal_blocked",
            "This location contains shared, system, registry or runtime files. Source deletion is blocked; the plugin can still be unregistered.",
        )
    };
    if source.parent().is_none()
        || source
            .components()
            .filter(|component| matches!(component, std::path::Component::Normal(_)))
            .count()
            == 0
    {
        return Err(blocked());
    }
    let registry_parent = registry.path().parent().ok_or_else(blocked)?;
    if within(registry_parent, source) {
        return Err(blocked());
    }
    if within(source, registry_parent) {
        let managed_parent = registry_parent.join("packages/github");
        if !managed
            || source
                .parent()
                .is_none_or(|parent| !same_path(parent, &managed_parent))
        {
            return Err(blocked());
        }
    }
    if registry.local_plugins().iter().any(|(id, registration)| {
        id != plugin_id
            && (within(&registration.path, source) || within(source, &registration.path))
    }) {
        return Err(blocked());
    }
    if let Ok(executable) = std::env::current_exe()
        && let Some(runtime) = executable.parent()
    {
        if within(runtime, source) {
            return Err(blocked());
        }
        if within(source, runtime)
            && source
                .parent()
                .is_none_or(|parent| !same_path(parent, &runtime.join("plugins")))
        {
            return Err(blocked());
        }
    }
    for variable in [
        "SystemRoot",
        "WINDIR",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "ProgramData",
    ] {
        if let Some(value) = std::env::var_os(variable) {
            let protected = PathBuf::from(value);
            if within(&protected, source) || within(source, &protected) {
                return Err(blocked());
            }
        }
    }
    for variable in [
        "USERPROFILE",
        "HOME",
        "APPDATA",
        "LOCALAPPDATA",
        "CODEX_HOME",
    ] {
        if let Some(value) = std::env::var_os(variable)
            && within(&PathBuf::from(value), source)
        {
            return Err(blocked());
        }
    }
    Ok(())
}

fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\");
    text.strip_prefix("\\\\?\\")
        .unwrap_or(&text)
        .trim_end_matches('\\')
        .to_lowercase()
}
fn same_path(left: &Path, right: &Path) -> bool {
    path_key(left) == path_key(right)
}
fn within(path: &Path, root: &Path) -> bool {
    let path = path_key(path);
    let root = path_key(root);
    path == root
        || path
            .strip_prefix(&root)
            .is_some_and(|tail| tail.starts_with('\\'))
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn skipped(code: &'static str, message: impl Into<String>) -> SourceRemovalResult {
    SourceRemovalResult {
        status: "skipped",
        code,
        message: message.into(),
    }
}
fn error(code: &str, message: impl Into<String>) -> PluginControlError {
    PluginControlError::new(code, message)
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::fs::{File, OpenOptions};
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, FileDispositionInfo,
        GetFileInformationByHandle, SetFileInformationByHandle,
    };

    pub(super) struct Directory {
        pub path: PathBuf,
        pub identity: String,
        root: File,
        _ancestors: Vec<File>,
    }

    pub(super) fn pin_directory(
        path: &Path,
        delete: bool,
    ) -> Result<Directory, PluginControlError> {
        crate::plugin_permissions::validate_policy_path(path)
            .map_err(|issue| error("source_directory_invalid", issue.to_string()))?;
        if path.components().any(|component| {
            matches!(
                component,
                std::path::Component::CurDir | std::path::Component::ParentDir
            )
        }) {
            return Err(error(
                "source_directory_invalid",
                "The registered directory is not a canonical location.",
            ));
        }
        let mut ancestors = Vec::new();
        for ancestor in path
            .ancestors()
            .skip(1)
            .filter(|ancestor| ancestor.has_root())
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
        {
            ancestors.push(open_plain(ancestor, false)?);
        }
        let root = open_plain(path, delete)?;
        let canonical = path.canonicalize().map_err(io_error)?;
        if !same_path(path, &canonical) {
            return Err(error(
                "source_directory_changed",
                "The registered directory redirects to a different location.",
            ));
        }
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        // SAFETY: the handle remains owned and pinned throughout this query.
        if unsafe { GetFileInformationByHandle(root.as_raw_handle().cast(), &mut info) } == 0 {
            return Err(io_error(std::io::Error::last_os_error()));
        }
        let identity = crate::local_import::digest(&(
            path_key(&canonical),
            info.dwVolumeSerialNumber,
            info.nFileIndexHigh,
            info.nFileIndexLow,
            info.ftCreationTime.dwHighDateTime,
            info.ftCreationTime.dwLowDateTime,
        ));
        Ok(Directory {
            path: canonical,
            identity,
            root,
            _ancestors: ancestors,
        })
    }

    fn open_plain(path: &Path, delete: bool) -> Result<File, PluginControlError> {
        let file = OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES | if delete { DELETE } else { 0 })
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(io_error)?;
        let metadata = file.metadata().map_err(io_error)?;
        if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(error(
                "source_directory_invalid",
                "The registered location is not an ordinary directory, or contains a link/junction in its ancestry. It will not be followed.",
            ));
        }
        Ok(file)
    }

    impl Directory {
        pub fn remove(self) -> std::io::Result<()> {
            // The absolute root and every ancestor remain pinned without delete
            // sharing. Rust's Windows remove_dir_all uses handle-relative APIs
            // and never follows child symlinks/junctions, including swap races.
            for entry in std::fs::read_dir(&self.path)? {
                let entry = entry?;
                let child = entry.path();
                if child.parent() != Some(self.path.as_path()) {
                    return Err(std::io::Error::other(
                        "source entry escaped its pinned parent",
                    ));
                }
                let metadata = std::fs::symlink_metadata(&child)?;
                if metadata.file_attributes() & FILE_ATTRIBUTE_DIRECTORY != 0 {
                    std::fs::remove_dir_all(&child)?;
                } else {
                    std::fs::remove_file(&child)?;
                }
            }
            let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
            // Mark the exact DELETE-capable handle, without releasing it and
            // looking up a possibly replaced directory by pathname.
            if unsafe {
                SetFileInformationByHandle(
                    self.root.as_raw_handle().cast(),
                    FileDispositionInfo,
                    (&disposition as *const FILE_DISPOSITION_INFO).cast(),
                    std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error());
            }
            let removed_path = self.path.clone();
            drop(self);
            match std::fs::symlink_metadata(removed_path) {
                Err(issue) if issue.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(issue) => Err(issue),
                Ok(_) => Err(std::io::Error::other(
                    "source deletion was requested but disappearance was not confirmed; a replacement location will not be deleted",
                )),
            }
        }
    }
    fn io_error(issue: std::io::Error) -> PluginControlError {
        if issue.kind() == std::io::ErrorKind::NotFound {
            error(
                "source_directory_missing",
                "The source directory is missing or has moved. It will not be recreated or searched for at another location.",
            )
        } else {
            error(
                "source_directory_unavailable",
                format!("The source directory could not be safely accessed: {issue}"),
            )
        }
    }
}

#[cfg(all(test, windows))]
mod tests;
