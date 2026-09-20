use crate::platform::path::{path_key, same_path};
use crate::plugin_control::PluginControlError;
use std::fs::{File, OpenOptions};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, FileDispositionInfo,
    GetFileInformationByHandle, SetFileInformationByHandle,
};

pub(crate) struct Directory {
    pub path: PathBuf,
    pub identity: String,
    root: File,
    _ancestors: Vec<File>,
}

pub(crate) fn pin_directory(path: &Path, delete: bool) -> Result<Directory, PluginControlError> {
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
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_FORCE_IMAGE_SECTION_CHECK,
            FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO_EX, FileDispositionInfoEx,
        };
        let immediate = FILE_DISPOSITION_INFO_EX {
            Flags: FILE_DISPOSITION_FLAG_DELETE
                | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
                | FILE_DISPOSITION_FLAG_FORCE_IMAGE_SECTION_CHECK,
        };
        // Remove the name even when Explorer retains a delete-sharing handle.
        // Older file systems keep the original handle-based fallback.
        let unlinked = unsafe {
            SetFileInformationByHandle(
                self.root.as_raw_handle().cast(),
                FileDispositionInfoEx,
                (&immediate as *const FILE_DISPOSITION_INFO_EX).cast(),
                std::mem::size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
            )
        } != 0;
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        // Mark the exact DELETE-capable handle, without releasing it and
        // looking up a possibly replaced directory by pathname.
        if !unlinked
            && unsafe {
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
fn error(code: &str, message: impl Into<String>) -> PluginControlError {
    PluginControlError::new(code, message)
}
