//! Read-only inspection of explicitly trusted local plugin directories.
//!
//! The selected root is canonicalized, so a link chosen as the root is allowed.
//! Below it, exact directory-entry spelling is required and symbolic links,
//! Windows reparse points (including junctions), hard-linked files, and special
//! files are rejected. Checks surround a bounded read; Windows also checks the
//! opened handle's final path and denies sharing for writes/deletion while read.
//! This is not an OS sandbox or a guarantee against every filesystem race caused
//! by a malicious same-user process. It does not make manifest/source snapshots
//! atomic. JavaScript is returned unchanged, never parsed or executed here.

use std::collections::hash_map::DefaultHasher;
use std::fs::{self, File, Metadata, OpenOptions};
use std::hash::{Hash, Hasher};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use thiserror::Error;

#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
};

use crate::plugins::{LoadedPlugin, Permission, PluginManifest, RendererWorld};

const MANIFEST_NAME: &str = "plugin.json";
pub const MAX_MANIFEST_BYTES: usize = 128 * 1024;
// Even worst-case JSON escaping leaves room in the 16 MiB CDP frame.
pub const MAX_SOURCE_BYTES: usize = 1024 * 1024;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone)]
pub struct LocalPluginCandidate {
    pub root: PathBuf,
    pub manifest: PluginManifest,
    pub source: String,
}

/// A borrowed view of a currently loaded local source. Observers gain no
/// execution authority and do not clone renderer source on each host pump.
#[derive(Debug, Clone, Copy)]
pub struct LocalWatchSource<'a> {
    pub path: &'a Path,
    pub grants: &'a [Permission],
    pub plugin: &'a LoadedPlugin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct LocalWatchFingerprint(u64);

pub(crate) fn loaded_watch_fingerprint(plugin: &LoadedPlugin) -> LocalWatchFingerprint {
    semantic_watch_fingerprint(&plugin.manifest, &plugin.source)
}

fn semantic_watch_fingerprint(manifest: &PluginManifest, source: &str) -> LocalWatchFingerprint {
    let mut hash = DefaultHasher::new();
    0_u8.hash(&mut hash);
    serde_json::to_vec(manifest)
        .expect("typed manifest serialization cannot fail")
        .hash(&mut hash);
    source.hash(&mut hash);
    LocalWatchFingerprint(hash.finish())
}

/// Observe bounded input bytes through the same checked reader as activation.
/// Invalid JSON/UTF-8 keeps a byte fingerprint, so different invalid edits do
/// not collapse to an identical parser error. This function never executes code
/// or treats a successful read as a permission grant.
pub(crate) fn inspect_watch_fingerprint(root: &Path, current_entry: &str) -> LocalWatchFingerprint {
    let mut hash = DefaultHasher::new();
    1_u8.hash(&mut hash);
    let root = match canonical_local_root(root) {
        Ok(root) => root,
        Err(error) => {
            error.to_string().hash(&mut hash);
            return LocalWatchFingerprint(hash.finish());
        }
    };
    let manifest_bytes =
        match read_bytes(&root, MANIFEST_NAME, MAX_MANIFEST_BYTES, "watch manifest") {
            Ok(bytes) => bytes,
            Err(error) => {
                error.to_string().hash(&mut hash);
                return LocalWatchFingerprint(hash.finish());
            }
        };
    manifest_bytes.hash(&mut hash);
    let manifest = std::str::from_utf8(&manifest_bytes)
        .ok()
        .and_then(|text| PluginManifest::parse(text).ok());
    let entry = manifest
        .as_ref()
        .map(|manifest| manifest.renderer.entry.as_str())
        .unwrap_or(current_entry);
    if let Err(error) = validate_entry(&root, entry) {
        error.to_string().hash(&mut hash);
        return LocalWatchFingerprint(hash.finish());
    }
    let source_bytes = match read_bytes(&root, entry, MAX_SOURCE_BYTES, "watch renderer entry") {
        Ok(bytes) => bytes,
        Err(error) => {
            error.to_string().hash(&mut hash);
            return LocalWatchFingerprint(hash.finish());
        }
    };
    source_bytes.hash(&mut hash);
    if let (Some(manifest), Ok(source)) = (manifest, std::str::from_utf8(&source_bytes)) {
        return semantic_watch_fingerprint(&manifest, source);
    }
    LocalWatchFingerprint(hash.finish())
}

#[derive(Debug, Error)]
pub enum LocalPluginError {
    #[error(
        "local plugin identity validation: id {0} is reserved; choose an ID outside the bundled/core catalog"
    )]
    ReservedId(String),
    #[error("failed to {stage} local plugin path {path}: {source}")]
    Io {
        path: PathBuf,
        stage: &'static str,
        #[source]
        source: io::Error,
    },
    #[error("local plugin {stage} at {path}: {reason}")]
    Rejected {
        path: PathBuf,
        stage: &'static str,
        reason: String,
    },
}

impl LocalPluginCandidate {
    /// Check explicit user grants before persisting trust in this directory.
    /// Extra supported grants are accepted; the manifest remains the declaration
    /// of requested permissions. `load_local_plugin` repeats this check on disk.
    pub fn validate_grants(&self, grants: &[Permission]) -> Result<(), LocalPluginError> {
        validate_grants_at(&self.manifest, grants, &self.root.join(MANIFEST_NAME))
    }
}

/// Validate grants without file I/O. Errors use the logical `plugin.json` path;
/// the candidate method supplies its actual root for path-specific diagnostics.
pub fn validate_grants(
    manifest: &PluginManifest,
    grants: &[Permission],
) -> Result<(), LocalPluginError> {
    validate_grants_at(manifest, grants, Path::new(MANIFEST_NAME))
}

fn validate_grants_at(
    manifest: &PluginManifest,
    grants: &[Permission],
    path: &Path,
) -> Result<(), LocalPluginError> {
    validate_local_manifest(manifest, path)?;
    for (index, permission) in grants.iter().enumerate() {
        require_supported_permission(*permission, path, "grant validation")?;
        if grants[..index].contains(permission) {
            return Err(reject(
                path,
                "grant validation",
                format!(
                    "duplicate grant {}; specify each grant once",
                    permission.as_str()
                ),
            ));
        }
    }
    for permission in &manifest.permissions {
        if !grants.contains(permission) {
            return Err(reject(
                path,
                "grant validation",
                format!(
                    "plugin {} requests {}; explicitly grant it before loading",
                    manifest.id,
                    permission.as_str()
                ),
            ));
        }
    }
    Ok(())
}

pub fn inspect_local_plugin(root: &Path) -> Result<LocalPluginCandidate, LocalPluginError> {
    let root = canonical_local_root(root)?;

    let manifest_path = root.join(MANIFEST_NAME);
    let json = read_text(&root, MANIFEST_NAME, MAX_MANIFEST_BYTES, "read manifest")?;
    let manifest = PluginManifest::parse(&json)
        .map_err(|error| reject(&manifest_path, "parse manifest", error.to_string()))?;
    validate_local_manifest(&manifest, &manifest_path)?;
    validate_entry(&root, &manifest.renderer.entry)?;
    let source = read_text(
        &root,
        &manifest.renderer.entry,
        MAX_SOURCE_BYTES,
        "read renderer entry",
    )?;
    if source.trim().is_empty() {
        return Err(reject(
            &root.join(&manifest.renderer.entry),
            "read renderer entry",
            "entry must contain non-whitespace JavaScript source",
        ));
    }
    Ok(LocalPluginCandidate {
        root,
        manifest,
        source,
    })
}

fn canonical_local_root(root: &Path) -> Result<PathBuf, LocalPluginError> {
    validate_root_input(root)?;
    let absolute = if root.is_absolute() {
        root.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|error| io_error(root, "resolve current directory", error))?
            .join(root)
    };
    validate_root_input(&absolute)?;
    let root =
        fs::canonicalize(&absolute).map_err(|error| io_error(root, "resolve root", error))?;
    validate_root_input(&root)?;
    let metadata =
        fs::symlink_metadata(&root).map_err(|error| io_error(&root, "inspect root", error))?;
    require_file_type(&metadata, &root, "inspect root", true)?;

    Ok(root)
}

fn validate_root_input(root: &Path) -> Result<(), LocalPluginError> {
    let invalid = || {
        reject(
            root,
            "root path validation",
            "select a local directory using a Unicode relative path or absolute disk path; UNC, device namespaces, and drive-relative paths are not allowed",
        )
    };
    if root.as_os_str().is_empty() || root.to_str().is_none() {
        return Err(invalid());
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        match root.components().next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::Disk(_) | Prefix::VerbatimDisk(_) if root.is_absolute() => {}
                _ => return Err(invalid()),
            },
            Some(Component::RootDir) => return Err(invalid()),
            _ => {}
        }
    }
    #[cfg(not(windows))]
    if root
        .to_str()
        .is_some_and(|path| path.starts_with("\\\\") || path.starts_with("//"))
    {
        return Err(invalid());
    }
    Ok(())
}

pub fn load_local_plugin(
    expected_id: &str,
    root: &Path,
    grants: &[Permission],
    generation: u64,
) -> Result<LoadedPlugin, LocalPluginError> {
    let candidate = inspect_local_plugin(root)?;
    let manifest_path = candidate.root.join(MANIFEST_NAME);
    if candidate.manifest.id != expected_id {
        return Err(reject(
            &manifest_path,
            "identity validation",
            format!(
                "expected plugin {expected_id}, found {}; register the changed identity explicitly",
                candidate.manifest.id
            ),
        ));
    }
    candidate.validate_grants(grants)?;
    if !(1..=MAX_JAVASCRIPT_SAFE_INTEGER).contains(&generation) {
        return Err(reject(
            &manifest_path,
            "generation validation",
            format!(
                "generation must be between 1 and {MAX_JAVASCRIPT_SAFE_INTEGER}, got {generation}"
            ),
        ));
    }
    Ok(LoadedPlugin {
        manifest: candidate.manifest,
        source: candidate.source,
        generation,
    })
}

fn validate_local_manifest(manifest: &PluginManifest, path: &Path) -> Result<(), LocalPluginError> {
    if manifest.renderer.world != RendererWorld::Isolated {
        return Err(reject(
            path,
            "renderer world validation",
            "local plugins support only renderer.world = isolated; main world is not implemented",
        ));
    }
    for permission in &manifest.permissions {
        require_supported_permission(*permission, path, "permission validation")?;
    }
    Ok(())
}

fn require_supported_permission(
    permission: Permission,
    path: &Path,
    stage: &'static str,
) -> Result<(), LocalPluginError> {
    // This is the current loader's implementation boundary. Capability names,
    // API versions, scopes, and runtime authorization stay in the existing kernel.
    match permission {
        Permission::UiDom | Permission::RuntimeManage => Ok(()),
        Permission::UiMainWorld | Permission::CdpRaw | Permission::HostProcess => Err(reject(
            path,
            stage,
            format!(
                "permission {} is not implemented for local plugins",
                permission.as_str()
            ),
        )),
    }
}

fn validate_entry(root: &Path, entry: &str) -> Result<(), LocalPluginError> {
    // PluginManifest::parse already rejects traversal, non-ASCII names, drive,
    // UNC, ADS, backslash, empty/dot components, and unsupported punctuation.
    for component in entry.split('/') {
        let stem = component
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'));
        if component.ends_with('.') || component.ends_with(' ') || reserved {
            return Err(reject(
                &root.join(entry),
                "entry path validation",
                "use ordinary path components without Windows device names or trailing spaces/dots",
            ));
        }
    }
    Ok(())
}

fn checked_path(
    root: &Path,
    relative: &str,
    stage: &'static str,
) -> Result<PathBuf, LocalPluginError> {
    let mut path = root.to_owned();
    let mut components = relative.split('/').peekable();
    while let Some(component) = components.next() {
        let parent = path.clone();
        path.push(component);
        let metadata =
            fs::symlink_metadata(&path).map_err(|error| io_error(&path, stage, error))?;
        require_file_type(&metadata, &path, stage, components.peek().is_some())?;
        let entries = fs::read_dir(&parent).map_err(|error| io_error(&parent, stage, error))?;
        let mut exact_name = false;
        for entry in entries {
            let entry = entry.map_err(|error| io_error(&parent, stage, error))?;
            if entry.file_name() == component {
                exact_name = true;
                break;
            }
        }
        if !exact_name {
            return Err(reject(
                &path,
                stage,
                "path alias rejected; use the exact on-disk spelling of every component",
            ));
        }
        let canonical = fs::canonicalize(&path).map_err(|error| io_error(&path, stage, error))?;
        if !canonical.starts_with(root) || canonical != path {
            return Err(reject(
                &path,
                stage,
                "path escapes the selected root or resolves through an alias; use an ordinary file inside the root",
            ));
        }
    }
    Ok(path)
}

fn require_file_type(
    metadata: &Metadata,
    path: &Path,
    stage: &'static str,
    directory: bool,
) -> Result<(), LocalPluginError> {
    let mut linked = metadata.file_type().is_symlink();
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        linked |= metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        linked |= !directory && metadata.nlink() != 1;
    }
    if linked {
        return Err(reject(
            path,
            stage,
            "links and reparse points are not allowed below the selected root",
        ));
    }
    if (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
        return Err(reject(
            path,
            stage,
            if directory {
                "expected an ordinary directory"
            } else {
                "expected an ordinary UTF-8 text file"
            },
        ));
    }
    Ok(())
}

fn read_text(
    root: &Path,
    relative: &str,
    limit: usize,
    stage: &'static str,
) -> Result<String, LocalPluginError> {
    let bytes = read_bytes(root, relative, limit, stage)?;
    let path = root.join(relative);
    let text = String::from_utf8(bytes).map_err(|_| {
        reject(
            &path,
            stage,
            "file must be valid UTF-8; convert it to UTF-8 text",
        )
    })?;
    if text
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\t' | '\r' | '\n'))
    {
        return Err(reject(
            &path,
            stage,
            "binary/control characters are not allowed; use UTF-8 text with tabs and line breaks",
        ));
    }
    Ok(text)
}

fn read_bytes(
    root: &Path,
    relative: &str,
    limit: usize,
    stage: &'static str,
) -> Result<Vec<u8>, LocalPluginError> {
    let path = checked_path(root, relative, stage)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Hold the inspected file stable while reading and avoid impersonation.
        options
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .security_qos_flags(0);
    }
    let file = options
        .open(&path)
        .map_err(|error| io_error(&path, stage, error))?;
    let metadata = file
        .metadata()
        .map_err(|error| io_error(&path, stage, error))?;
    require_file_type(&metadata, &path, stage, false)?;
    verify_open_file(&file, &path, stage)?;
    checked_path(root, relative, stage)?;
    let too_large = || {
        reject(
            &path,
            stage,
            format!("file exceeds the {limit}-byte limit; reduce its size"),
        )
    };
    if metadata.len() > limit as u64 {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    (&file)
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| io_error(&path, stage, error))?;
    if bytes.len() > limit {
        return Err(too_large());
    }
    checked_path(root, relative, stage)?;
    verify_open_file(&file, &path, stage)?;
    Ok(bytes)
}

#[cfg(windows)]
fn verify_open_file(file: &File, path: &Path, stage: &'static str) -> Result<(), LocalPluginError> {
    let (final_path, links) =
        windows_file::details(file).map_err(|error| io_error(path, stage, error))?;
    if links != 1 || final_path != path {
        return Err(reject(
            path,
            stage,
            "opened file has hard links or a different final path; use an ordinary file inside the selected root",
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn verify_open_file(file: &File, path: &Path, stage: &'static str) -> Result<(), LocalPluginError> {
    let metadata = file
        .metadata()
        .map_err(|error| io_error(path, stage, error))?;
    require_file_type(&metadata, path, stage, false)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let named = fs::symlink_metadata(path).map_err(|error| io_error(path, stage, error))?;
        if (metadata.dev(), metadata.ino()) != (named.dev(), named.ino()) {
            return Err(reject(
                path,
                stage,
                "file changed while opening; retry with a stable plugin directory",
            ));
        }
    }
    Ok(())
}

fn reject(path: &Path, stage: &'static str, reason: impl Into<String>) -> LocalPluginError {
    LocalPluginError::Rejected {
        path: path.to_owned(),
        stage,
        reason: reason.into(),
    }
}

fn io_error(path: &Path, stage: &'static str, source: io::Error) -> LocalPluginError {
    LocalPluginError::Io {
        path: path.to_owned(),
        stage,
        source,
    }
}

#[cfg(windows)]
mod windows_file {
    use std::ffi::OsString;
    use std::mem::MaybeUninit;
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;

    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle, GetFinalPathNameByHandleW,
    };

    use super::*;

    pub(super) fn details(file: &File) -> io::Result<(PathBuf, u32)> {
        let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
        // SAFETY: the handle is borrowed from a live File and the output has the
        // Windows API's declared structure type and sufficient storage.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a successful call initialized the entire output structure.
        let information = unsafe { information.assume_init() };
        // Bound the allocation to the Windows extended-path limit, including NUL.
        let mut buffer = vec![0u16; 32_768];
        // SAFETY: the handle is live and buffer has capacity for the supplied
        // UTF-16 count. Flags 0 request the normalized DOS path, like canonicalize.
        let length = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                0,
            )
        };
        if length == 0 {
            return Err(io::Error::last_os_error());
        }
        if length as usize >= buffer.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "opened file path exceeds the Windows path limit",
            ));
        }
        let path = PathBuf::from(OsString::from_wide(&buffer[..length as usize]));
        Ok((path, information.nNumberOfLinks))
    }
}
