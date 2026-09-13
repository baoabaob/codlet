use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    CURRENT_VERSION, MAX_DOWNLOAD_BYTES, MAX_EXPANDED_BYTES, MAX_FILES, PLATFORM, Result,
    RuntimePayloadProfile, RuntimeUpdateCandidate, error, io_error,
};

pub(super) const MANIFEST: &str = "runtime-update-manifest.json";
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RuntimeFile {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct NodeRuntime {
    pub version: String,
    pub executable_sha256: String,
    pub license_sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RuntimePackageManifest {
    pub schema: u32,
    pub kind: String,
    pub version: String,
    pub platform: String,
    pub profile: RuntimePayloadProfile,
    pub runtime: NodeRuntime,
    pub files: Vec<RuntimeFile>,
}
#[derive(Debug, Clone)]
pub(super) struct StagedRuntime {
    pub directory: PathBuf,
    pub manifest: RuntimePackageManifest,
    pub manifest_sha256: String,
    pub candidate: RuntimeUpdateCandidate,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedStage {
    schema: u32,
    kind: String,
    channel_sha256: String,
    directory: PathBuf,
    manifest_sha256: String,
    candidate: RuntimeUpdateCandidate,
}
fn channel_digest(channel: &super::RuntimeUpdateChannel) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(channel).expect("channel serializable"))
    )
}
pub(super) fn persist_staged(
    state_root: &Path,
    staged: &StagedRuntime,
    channel: &super::RuntimeUpdateChannel,
) -> Result<()> {
    let saved = SavedStage {
        schema: 1,
        kind: "codlet-runtime-staged".into(),
        channel_sha256: channel_digest(channel),
        directory: staged.directory.clone(),
        manifest_sha256: staged.manifest_sha256.clone(),
        candidate: staged.candidate.clone(),
    };
    atomic_json(&state_root.join("runtime-update-staged.json"), &saved)
}
pub(super) fn restore_staged(
    state_root: &Path,
    channel: &super::RuntimeUpdateChannel,
    profile: Option<RuntimePayloadProfile>,
) -> Result<Option<StagedRuntime>> {
    let path = state_root.join("runtime-update-staged.json");
    if !path.exists() {
        return Ok(None);
    }
    let saved: SavedStage = serde_json::from_slice(&read_file(&path, 256 * 1024)?)
        .map_err(|e| error("runtime_update_staged_invalid", e.to_string()))?;
    if saved.schema != 1
        || saved.kind != "codlet-runtime-staged"
        || saved.channel_sha256 != channel_digest(channel)
    {
        return Ok(None);
    }
    if !super::source::newer(&saved.candidate.version, CURRENT_VERSION)? {
        return Ok(None);
    }
    let root = canonical_directory(state_root)?;
    if saved.directory.parent() != Some(root.as_path())
        || !saved
            .directory
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with("runtime-payload-"))
        || !valid_sha(&saved.manifest_sha256)
        || !valid_sha(&saved.candidate.id)
        || !valid_sha(&saved.candidate.sha256)
        || saved.candidate.size == 0
        || saved.candidate.size > MAX_DOWNLOAD_BYTES
        || saved.candidate.platform != PLATFORM
    {
        return Err(error(
            "runtime_update_staged_invalid",
            "Stored runtime update is not owned by this installation.",
        ));
    }
    let manifest: RuntimePackageManifest =
        serde_json::from_slice(&read_file(&saved.directory.join(MANIFEST), 256 * 1024)?)
            .map_err(|e| error("runtime_update_staged_invalid", e.to_string()))?;
    if manifest.version != saved.candidate.version || profile.is_some_and(|p| p != manifest.profile)
    {
        return Err(error(
            "runtime_update_staged_invalid",
            "Stored runtime update has a different version/profile.",
        ));
    }
    let staged = StagedRuntime {
        directory: saved.directory,
        manifest,
        manifest_sha256: saved.manifest_sha256,
        candidate: saved.candidate,
    };
    recheck_staged(&staged)?;
    Ok(Some(staged))
}
#[derive(Deserialize)]
struct NodePin {
    schema: u32,
    version: String,
    platforms: BTreeMap<String, NodePlatform>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodePlatform {
    executable_sha256: String,
    license_sha256: Option<String>,
}

pub(super) fn valid_sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(super) fn canonical_directory(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(error(
            "runtime_update_path_invalid",
            "Runtime update paths must be absolute local paths.",
        ));
    }
    no_redirect_ancestors(path)?;
    ordinary(path, true)?;
    path.canonicalize().map_err(io_error)
}
pub(super) fn ensure_state_root(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(error(
            "runtime_update_path_invalid",
            "Update state path must be absolute.",
        ));
    }
    no_redirect_ancestors(path)?;
    std::fs::create_dir_all(path).map_err(io_error)?;
    canonical_directory(path)
}
pub(super) fn no_redirect_ancestors(path: &Path) -> Result<()> {
    for ancestor in path.ancestors() {
        match std::fs::symlink_metadata(ancestor) {
            Ok(meta) => {
                let mut redirected = meta.file_type().is_symlink();
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    redirected |= meta.file_attributes() & 0x400 != 0;
                }
                if redirected {
                    return Err(error(
                        "runtime_update_path_invalid",
                        "Runtime update paths must not contain symbolic links or reparse points.",
                    ));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(io_error(e)),
        }
    }
    Ok(())
}
pub(super) fn ordinary(path: &Path, directory: bool) -> Result<std::fs::Metadata> {
    ordinary_with_links(path, directory, false)
}
fn ordinary_with_links(
    path: &Path,
    directory: bool,
    allow_hard_links: bool,
) -> Result<std::fs::Metadata> {
    let metadata = std::fs::symlink_metadata(path).map_err(io_error)?;
    let mut forbidden = metadata.file_type().is_symlink();
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        forbidden |= metadata.file_attributes() & 0x400 != 0;
        if !directory && !allow_hard_links {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Storage::FileSystem::{
                BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
            };
            let file = File::open(path).map_err(io_error)?;
            let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
            if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
                return Err(io_error(std::io::Error::last_os_error()));
            }
            forbidden |= info.nNumberOfLinks != 1;
        }
    }
    #[cfg(unix)]
    if !directory && !allow_hard_links {
        use std::os::unix::fs::MetadataExt;
        forbidden |= metadata.nlink() != 1;
    }
    if forbidden || (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
        return Err(error(
            "runtime_update_path_invalid",
            "Runtime payload must contain ordinary files and directories, without links.",
        ));
    }
    Ok(metadata)
}
pub(super) fn read_file(path: &Path, limit: u64) -> Result<Vec<u8>> {
    no_redirect_ancestors(path)?;
    let before = ordinary(path, false)?;
    if before.len() > limit {
        return Err(error(
            "runtime_update_size_limit",
            "Runtime metadata exceeded its size limit.",
        ));
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(io_error)?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    let after = ordinary(path, false)?;
    if bytes.len() as u64 != before.len()
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err(error(
            "runtime_update_changed",
            "Runtime file changed during verification.",
        ));
    }
    Ok(bytes)
}
pub(super) fn file_record(path: &Path, relative: &str) -> Result<RuntimeFile> {
    file_record_with_links(path, relative, false)
}
/// Windows system launchers may have a WinSxS hard link. They are read/hash-only
/// owner commands, never files the update transaction replaces.
pub(super) fn restart_program_record(path: &Path) -> Result<RuntimeFile> {
    file_record_with_links(path, "", true)
}
fn file_record_with_links(
    path: &Path,
    relative: &str,
    allow_hard_links: bool,
) -> Result<RuntimeFile> {
    no_redirect_ancestors(path)?;
    let before = ordinary_with_links(path, false, allow_hard_links)?;
    if before.len() > MAX_DOWNLOAD_BYTES {
        return Err(error(
            "runtime_update_size_limit",
            "A runtime file exceeds 512 MiB.",
        ));
    }
    let mut file = File::open(path).map_err(io_error)?;
    let mut digest = Sha256::new();
    let mut count = 0u64;
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buffer).map_err(io_error)?;
        if n == 0 {
            break;
        }
        count += n as u64;
        if count > MAX_DOWNLOAD_BYTES {
            return Err(error(
                "runtime_update_size_limit",
                "A runtime file grew beyond its limit.",
            ));
        }
        digest.update(&buffer[..n]);
    }
    let after = ordinary_with_links(path, false, allow_hard_links)?;
    if count != before.len()
        || count != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err(error(
            "runtime_update_changed",
            "Runtime file changed during verification.",
        ));
    }
    Ok(RuntimeFile {
        path: relative.into(),
        bytes: count,
        sha256: format!("{:x}", digest.finalize()),
    })
}
pub(super) fn atomic_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().ok_or_else(|| {
        error(
            "runtime_update_path_invalid",
            "Metadata path has no parent.",
        )
    })?;
    no_redirect_ancestors(path)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(io_error)?;
    serde_json::to_writer(&mut temp, value)
        .map_err(|e| error("runtime_update_metadata", e.to_string()))?;
    temp.write_all(b"\n").map_err(io_error)?;
    temp.as_file().sync_all().map_err(io_error)?;
    temp.persist(path).map_err(|e| io_error(e.error))?;
    Ok(())
}
pub(super) fn persist_status(root: &Path, status: &super::RuntimeUpdateStatus) -> Result<()> {
    let root = ensure_state_root(root)?;
    atomic_json(&root.join("runtime-update-status.json"), status)
}

fn expected_paths(
    profile: RuntimePayloadProfile,
    runtime: &NodeRuntime,
    include_other: bool,
) -> Result<BTreeSet<String>> {
    if !valid_sha(&runtime.executable_sha256)
        || !valid_sha(&runtime.license_sha256)
        || runtime.version.len() > 64
        || !runtime
            .version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
        || runtime.version.contains("..")
    {
        return Err(error(
            "runtime_update_manifest_invalid",
            "Invalid bundled Node identity.",
        ));
    }
    let node = format!("runtime/node-v{}-{PLATFORM}", runtime.version);
    let primary = if profile == RuntimePayloadProfile::Portable {
        "codlet.exe"
    } else {
        "codlet-lab.exe"
    };
    let other = if profile == RuntimePayloadProfile::Portable {
        "codlet-lab.exe"
    } else {
        "codlet.exe"
    };
    let mut paths = BTreeSet::from([
        primary.into(),
        "runtime/node-runtime.json".into(),
        format!("{node}/node.exe"),
        format!("{node}/LICENSE"),
    ]);
    if include_other {
        paths.insert(other.into());
    }
    Ok(paths)
}
fn pin_at(root: &Path) -> Result<NodeRuntime> {
    let pin: NodePin = serde_json::from_slice(&read_file(
        &root.join("runtime/node-runtime.json"),
        64 * 1024,
    )?)
    .map_err(|e| error("runtime_update_manifest_invalid", e.to_string()))?;
    let platform = pin.platforms.get(PLATFORM).ok_or_else(|| {
        error(
            "runtime_update_manifest_invalid",
            "Node pin has no entry for this platform.",
        )
    })?;
    if pin.schema != 1 {
        return Err(error(
            "runtime_update_manifest_invalid",
            "Unsupported Node pin schema.",
        ));
    }
    Ok(NodeRuntime {
        version: pin.version,
        executable_sha256: platform.executable_sha256.clone(),
        license_sha256: platform.license_sha256.clone().ok_or_else(|| {
            error(
                "runtime_update_manifest_invalid",
                "Node license is not pinned.",
            )
        })?,
    })
}
pub(super) fn inspect_installation(
    root: &Path,
    profile: RuntimePayloadProfile,
    include_other: bool,
) -> Result<RuntimePackageManifest> {
    canonical_directory(root)?;
    let runtime = pin_at(root)?;
    let files = expected_paths(profile, &runtime, include_other)?
        .into_iter()
        .map(|relative| file_record(&root.join(&relative), &relative))
        .collect::<Result<Vec<_>>>()?;
    let manifest = RuntimePackageManifest {
        schema: 1,
        kind: "codlet-runtime-update".into(),
        version: CURRENT_VERSION.into(),
        platform: PLATFORM.into(),
        profile,
        runtime,
        files,
    };
    verify_payload(root, &manifest, false)?;
    Ok(manifest)
}
pub(super) fn stage_archive(
    archive: &Path,
    selected: &super::source::Candidate,
    state_root: &Path,
) -> Result<StagedRuntime> {
    let temporary = tempfile::Builder::new()
        .prefix("runtime-payload-")
        .tempdir_in(state_root)
        .map_err(io_error)?;
    extract_zip(archive, temporary.path())?;
    let bytes = read_file(&temporary.path().join(MANIFEST), 256 * 1024)?;
    let manifest: RuntimePackageManifest = serde_json::from_slice(&bytes)
        .map_err(|e| error("runtime_update_manifest_invalid", e.to_string()))?;
    if manifest.version != selected.public.version
        || manifest.platform != selected.public.platform
        || manifest.profile != selected.profile
    {
        return Err(error(
            "runtime_update_manifest_invalid",
            "ZIP metadata does not match the fixed release candidate.",
        ));
    }
    verify_payload(temporary.path(), &manifest, true)?;
    let directory = temporary.path().canonicalize().map_err(io_error)?;
    let staged = StagedRuntime {
        directory,
        manifest,
        manifest_sha256: format!("{:x}", Sha256::digest(bytes)),
        candidate: selected.public.clone(),
    };
    let _ = temporary.keep();
    Ok(staged)
}
pub(super) fn recheck_staged(staged: &StagedRuntime) -> Result<()> {
    canonical_directory(&staged.directory)?;
    let digest = format!(
        "{:x}",
        Sha256::digest(read_file(&staged.directory.join(MANIFEST), 256 * 1024)?)
    );
    if digest != staged.manifest_sha256 {
        return Err(error(
            "runtime_update_changed",
            "Staged runtime manifest changed after download.",
        ));
    }
    verify_payload(&staged.directory, &staged.manifest, true)
}
fn verify_payload(
    root: &Path,
    manifest: &RuntimePackageManifest,
    no_extra_files: bool,
) -> Result<()> {
    if manifest.schema != 1
        || manifest.kind != "codlet-runtime-update"
        || manifest.platform != PLATFORM
    {
        return Err(error(
            "runtime_update_manifest_invalid",
            "Unsupported runtime package format/platform.",
        ));
    }
    let other = if manifest.profile == RuntimePayloadProfile::Portable {
        "codlet-lab.exe"
    } else {
        "codlet.exe"
    };
    let expected = expected_paths(
        manifest.profile,
        &manifest.runtime,
        manifest.files.iter().any(|f| f.path == other),
    )?;
    let mut seen = BTreeSet::new();
    let mut total = 0u64;
    for file in &manifest.files {
        if !expected.contains(&file.path)
            || !seen.insert(file.path.clone())
            || !valid_sha(&file.sha256)
        {
            return Err(error(
                "runtime_update_manifest_invalid",
                "Runtime manifest includes duplicate or non-owned payload paths.",
            ));
        }
        total = total.checked_add(file.bytes).ok_or_else(|| {
            error(
                "runtime_update_size_limit",
                "Runtime payload size overflow.",
            )
        })?;
        if total > MAX_EXPANDED_BYTES || file_record(&root.join(&file.path), &file.path)? != *file {
            return Err(error(
                "runtime_update_digest_mismatch",
                "Runtime file does not match its manifest size/SHA-256.",
            ));
        }
        if file.path.ends_with(".exe") {
            verify_pe(&root.join(&file.path))?;
        }
    }
    if seen != expected {
        return Err(error(
            "runtime_update_manifest_invalid",
            "Runtime payload is incomplete for the selected profile.",
        ));
    }
    let pin = pin_at(root)?;
    if pin.version != manifest.runtime.version
        || pin.executable_sha256 != manifest.runtime.executable_sha256
        || pin.license_sha256 != manifest.runtime.license_sha256
    {
        return Err(error(
            "runtime_update_digest_mismatch",
            "Bundled Node metadata and runtime manifest disagree.",
        ));
    }
    let node = format!("runtime/node-v{}-{PLATFORM}", pin.version);
    if manifest
        .files
        .iter()
        .find(|f| f.path == format!("{node}/node.exe"))
        .unwrap()
        .sha256
        != pin.executable_sha256
        || manifest
            .files
            .iter()
            .find(|f| f.path == format!("{node}/LICENSE"))
            .unwrap()
            .sha256
            != pin.license_sha256
    {
        return Err(error(
            "runtime_update_digest_mismatch",
            "Bundled Node files do not match their pins.",
        ));
    }
    if no_extra_files {
        let mut found = BTreeSet::new();
        let mut pending = vec![root.to_path_buf()];
        while let Some(directory) = pending.pop() {
            for entry in std::fs::read_dir(&directory).map_err(io_error)? {
                let entry = entry.map_err(io_error)?;
                let path = entry.path();
                let directory = entry.file_type().map_err(io_error)?.is_dir();
                ordinary(&path, directory)?;
                if directory {
                    pending.push(path);
                } else {
                    found.insert(
                        path.strip_prefix(root)
                            .map_err(|_| {
                                error("runtime_update_path_invalid", "Payload escaped its root.")
                            })?
                            .to_string_lossy()
                            .replace('\\', "/"),
                    );
                }
            }
        }
        let mut allowed = expected;
        allowed.insert(MANIFEST.into());
        if found != allowed {
            return Err(error(
                "runtime_update_manifest_invalid",
                "Runtime ZIP contains undeclared files or user configuration.",
            ));
        }
    }
    Ok(())
}
fn verify_pe(path: &Path) -> Result<()> {
    let mut file = File::open(path).map_err(io_error)?;
    let header = read_at(&mut file, 0, 64)?;
    let offset = u32::from_le_bytes(header[60..64].try_into().unwrap()) as u64;
    if &header[..2] != b"MZ" || !(64..=1024 * 1024).contains(&offset) {
        return Err(error(
            "runtime_update_executable_invalid",
            "Runtime package does not contain Windows x64 PE executables.",
        ));
    }
    let pe = read_at(&mut file, offset, 6)?;
    if &pe[..4] != b"PE\0\0" || u16::from_le_bytes(pe[4..6].try_into().unwrap()) != 0x8664 {
        return Err(error(
            "runtime_update_executable_invalid",
            "Runtime executable architecture is not Windows x64.",
        ));
    }
    Ok(())
}

fn zip_error(message: impl Into<String>) -> super::RuntimeUpdateError {
    error("runtime_update_zip_invalid", message)
}
fn read_at(file: &mut File, offset: u64, size: usize) -> Result<Vec<u8>> {
    file.seek(SeekFrom::Start(offset)).map_err(io_error)?;
    let mut bytes = vec![0u8; size];
    file.read_exact(&mut bytes)
        .map_err(|e| zip_error(e.to_string()))?;
    Ok(bytes)
}
fn u16at(bytes: &[u8], index: usize) -> u16 {
    u16::from_le_bytes(bytes[index..index + 2].try_into().unwrap())
}
fn u32at(bytes: &[u8], index: usize) -> u32 {
    u32::from_le_bytes(bytes[index..index + 4].try_into().unwrap())
}
fn valid_zip_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 240
        && name.is_ascii()
        && name.split('/').count() <= 12
        && name.split('/').all(|p| {
            let base = p.split('.').next().unwrap_or("").to_ascii_uppercase();
            !p.is_empty()
                && p != "."
                && p != ".."
                && !p.ends_with('.')
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
                && !matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                && !(base.len() == 4
                    && (base.starts_with("COM") || base.starts_with("LPT"))
                    && base.as_bytes()[3].is_ascii_digit())
        })
}
struct CheckedZip {
    name: String,
    size: u64,
    compressed: u64,
    directory: bool,
}
fn preflight_zip(path: &Path) -> Result<Vec<CheckedZip>> {
    let mut file = File::open(path).map_err(io_error)?;
    let length = file.metadata().map_err(io_error)?.len();
    if !(22..=MAX_DOWNLOAD_BYTES).contains(&length) {
        return Err(zip_error("Runtime ZIP is empty, truncated or too large."));
    }
    let tail_len = length.min(65557) as usize;
    let tail_start = length - tail_len as u64;
    let tail = read_at(&mut file, tail_start, tail_len)?;
    let end = (0..=tail.len() - 22)
        .rev()
        .find(|&i| {
            &tail[i..i + 4] == b"PK\x05\x06" && i + 22 + u16at(&tail, i + 20) as usize == tail.len()
        })
        .ok_or_else(|| zip_error("Missing ZIP end record or trailing bytes."))?;
    let record = &tail[end..];
    let count = u16at(record, 10) as usize;
    let central = u32at(record, 16) as u64;
    let central_end = tail_start + end as u64;
    if count == 0
        || count > MAX_FILES
        || u16at(record, 4) != 0
        || u16at(record, 6) != 0
        || u16at(record, 8) as usize != count
        || central + u32at(record, 12) as u64 != central_end
        || u16at(record, 20) > 1024
    {
        return Err(zip_error(
            "Only bounded single-disk ZIP32 packages are accepted.",
        ));
    }
    let mut cursor = central;
    let mut entries = Vec::new();
    let mut ranges = Vec::new();
    let mut names = BTreeSet::new();
    let mut nodes = BTreeMap::new();
    let mut total = 0u64;
    for _ in 0..count {
        let header = read_at(&mut file, cursor, 46)?;
        if u32at(&header, 0) != 0x02014b50 {
            return Err(zip_error("Malformed ZIP central directory."));
        }
        let flags = u16at(&header, 8);
        let method = u16at(&header, 10);
        let crc = u32at(&header, 16);
        let compressed = u32at(&header, 20) as u64;
        let size = u32at(&header, 24) as u64;
        let name_length = u16at(&header, 28) as usize;
        let extra_length = u16at(&header, 30) as usize;
        let comment_length = u16at(&header, 32) as usize;
        let attributes = u32at(&header, 38);
        let local = u32at(&header, 42) as u64;
        if flags & !0x080e != 0
            || !matches!(method, 0 | 8)
            || (method == 0 && flags & 6 != 0)
            || u16at(&header, 34) != 0
            || attributes & 0x400 != 0
            || name_length > 241
            || extra_length > 4096
            || comment_length > 1024
        {
            return Err(zip_error(
                "Unsupported, encrypted, reparse or oversized ZIP headers.",
            ));
        }
        let raw = read_at(&mut file, cursor + 46, name_length)?;
        let full_name =
            std::str::from_utf8(&raw).map_err(|_| zip_error("ZIP paths must be UTF-8."))?;
        let directory = full_name.ends_with('/');
        let name = full_name.trim_end_matches('/');
        if !valid_zip_name(name)
            || (directory && full_name != format!("{name}/"))
            || !names.insert(name.to_ascii_lowercase())
        {
            return Err(zip_error("Unsafe or duplicate ZIP path."));
        }
        let kind = (attributes >> 16) & 0xf000;
        if !matches!(kind, 0 | 0x4000 | 0x8000)
            || (kind == 0x4000 && !directory)
            || (kind == 0x8000 && directory)
            || (directory && (size != 0 || compressed != 0))
        {
            return Err(zip_error(
                "ZIP symlinks or inconsistent file types are forbidden.",
            ));
        }
        let parts: Vec<_> = name.split('/').collect();
        for end in 1..=parts.len() {
            let spelling = parts[..end].join("/");
            let is_dir = end < parts.len() || directory;
            if let Some(prior) =
                nodes.insert(spelling.to_ascii_lowercase(), (spelling.clone(), is_dir))
                && prior != (spelling, is_dir)
            {
                return Err(zip_error(
                    "ZIP contains case aliases or file/directory collisions.",
                ));
            }
        }
        if nodes.len() > MAX_FILES {
            return Err(zip_error("Too many ZIP entries."));
        }
        total = total
            .checked_add(size)
            .ok_or_else(|| zip_error("ZIP size overflow."))?;
        if total > MAX_EXPANDED_BYTES || size > MAX_DOWNLOAD_BYTES {
            return Err(zip_error("Runtime ZIP exceeds its expansion limit."));
        }
        check_extra(&read_at(
            &mut file,
            cursor + 46 + name_length as u64,
            extra_length,
        )?)?;
        cursor += 46 + (name_length + extra_length + comment_length) as u64;
        if cursor > central_end {
            return Err(zip_error("ZIP central directory exceeds its bounds."));
        }
        let local_header = read_at(&mut file, local, 30)?;
        if u32at(&local_header, 0) != 0x04034b50
            || u16at(&local_header, 6) != flags
            || u16at(&local_header, 8) != method
            || u16at(&local_header, 26) as usize != name_length
            || read_at(&mut file, local + 30, name_length)? != raw
        {
            return Err(zip_error("ZIP local and central headers disagree."));
        }
        let local_extra = u16at(&local_header, 28) as usize;
        if local_extra > 4096 {
            return Err(zip_error("Oversized ZIP extra field."));
        }
        check_extra(&read_at(
            &mut file,
            local + 30 + name_length as u64,
            local_extra,
        )?)?;
        let mut data_end = local + 30 + (name_length + local_extra) as u64 + compressed;
        if flags & 8 == 0 {
            if u32at(&local_header, 14) != crc
                || u32at(&local_header, 18) as u64 != compressed
                || u32at(&local_header, 22) as u64 != size
            {
                return Err(zip_error("ZIP sizes/checksums disagree."));
            }
        } else {
            for (offset, value) in [(14, crc), (18, compressed as u32), (22, size as u32)] {
                let actual = u32at(&local_header, offset);
                if actual != 0 && actual != value {
                    return Err(zip_error("ZIP local descriptor metadata disagrees."));
                }
            }
            let signature = read_at(&mut file, data_end, 4)?;
            if u32at(&signature, 0) == 0x08074b50 {
                data_end += 4;
            }
            let descriptor = read_at(&mut file, data_end, 12)?;
            if u32at(&descriptor, 0) != crc
                || u32at(&descriptor, 4) as u64 != compressed
                || u32at(&descriptor, 8) as u64 != size
            {
                return Err(zip_error("ZIP data descriptor disagrees."));
            }
            data_end += 12;
        }
        if data_end > central {
            return Err(zip_error("ZIP file overlaps the central directory."));
        }
        ranges.push((local, data_end));
        entries.push(CheckedZip {
            name: full_name.into(),
            size,
            compressed,
            directory,
        });
    }
    if cursor != central_end {
        return Err(zip_error("ZIP central count/length mismatch."));
    }
    ranges.sort_unstable();
    let mut next = 0;
    for (start, end) in ranges {
        if start != next {
            return Err(zip_error(
                "ZIP overlapping files, hidden data or executable prefixes are forbidden.",
            ));
        }
        next = end;
    }
    if next != central || !entries.iter().any(|e| e.name == MANIFEST && !e.directory) {
        return Err(zip_error(
            "Runtime ZIP has no root manifest or contains unaccounted bytes.",
        ));
    }
    Ok(entries)
}
fn check_extra(bytes: &[u8]) -> Result<()> {
    let mut i = 0;
    while i < bytes.len() {
        if i + 4 > bytes.len() {
            return Err(zip_error("Truncated ZIP extra field."));
        }
        let kind = u16at(bytes, i);
        let len = u16at(bytes, i + 2) as usize;
        if kind == 1 || i + 4 + len > bytes.len() {
            return Err(zip_error("ZIP64 or malformed extra fields are forbidden."));
        }
        i += 4 + len;
    }
    Ok(())
}
fn extract_zip(path: &Path, destination: &Path) -> Result<()> {
    let checked = preflight_zip(path)?;
    let mut archive = zip::ZipArchive::new(File::open(path).map_err(io_error)?)
        .map_err(|e| zip_error(e.to_string()))?;
    if archive.len() != checked.len()
        || archive.offset() != 0
        || archive
            .has_overlapping_files()
            .map_err(|e| zip_error(e.to_string()))?
    {
        return Err(zip_error("ZIP decoder found an ambiguous archive."));
    }
    let mut total = 0u64;
    for (index, expected) in checked.iter().enumerate() {
        let mut input = archive
            .by_index(index)
            .map_err(|e| zip_error(e.to_string()))?;
        if input.name() != expected.name
            || input.name_raw() != expected.name.as_bytes()
            || input.size() != expected.size
            || input.compressed_size() != expected.compressed
            || input.is_symlink()
            || input.encrypted()
        {
            return Err(zip_error("ZIP decoder disagrees with verified headers."));
        }
        let output = destination.join(expected.name.trim_end_matches('/'));
        if expected.directory {
            std::fs::create_dir_all(output).map_err(io_error)?;
            continue;
        }
        std::fs::create_dir_all(output.parent().unwrap()).map_err(io_error)?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(output)
            .map_err(io_error)?;
        let mut count = 0u64;
        let mut buffer = [0; 64 * 1024];
        loop {
            let n = input
                .read(&mut buffer)
                .map_err(|e| zip_error(e.to_string()))?;
            if n == 0 {
                break;
            }
            count += n as u64;
            total += n as u64;
            if count > expected.size || total > MAX_EXPANDED_BYTES {
                return Err(zip_error("ZIP expanded beyond its declared limit."));
            }
            file.write_all(&buffer[..n]).map_err(io_error)?;
        }
        if count != expected.size {
            return Err(zip_error("ZIP actual size differs from its header."));
        }
        file.sync_all().map_err(io_error)?;
    }
    Ok(())
}
