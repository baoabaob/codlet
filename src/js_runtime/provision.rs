//! Private, content-addressed Node provisioning for managed Core packages.
//! Only Core-owned distribution pins and embedded official-client profiles
//! can select bytes; plugin manifests, PATH, and ambient Node are ignored.

use std::collections::BTreeSet;
use std::error::Error as _;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::{
    JsRuntime, MAX_LICENSE_BYTES, MAX_NODE_BYTES, PlatformPin, RuntimePin, io_error, sha256,
};
use crate::platform::DesktopTarget;
use crate::plugin_host::HostError;

const MAX_PIN_BYTES: u64 = 64 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 200 * 1024 * 1024;
const CACHE_MARKER: &str = ".codlet-node-cache.json";
const PREPARING_MARKER: &str = ".codlet-node-preparing.json";
const CACHE_RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CacheMarker {
    schema: u32,
    platform: String,
    version: String,
    node_sha256: String,
    license_sha256: String,
    created_ms: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreparingMarker {
    schema: u32,
    platform: String,
    node_sha256: String,
    created_ms: u64,
}

#[derive(Deserialize)]
struct ClientProfiles {
    schema: u32,
    profiles: Vec<ClientProfile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ClientProfile {
    pub(super) enabled: bool,
    pub(super) platform: String,
    pub(super) node_version: String,
    pub(super) node_sha256: String,
    pub(super) license_sha256: String,
    source: ClientSource,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum ClientSource {
    WindowsPackage {
        family: String,
        full_name: String,
        node_path: String,
        license_path: String,
    },
    MacBundle {
        bundle_id: String,
        app_version: String,
        team_id: String,
        node_path: String,
        license_path: String,
    },
}

fn invalid(message: impl Into<String>) -> HostError {
    HostError::new("js_runtime_invalid", message)
}

fn network_error(error: reqwest::Error) -> HostError {
    let error = error.without_url();
    let mut details = vec![error.to_string()];
    let mut source = error.source();
    while let Some(cause) = source {
        let message = cause.to_string();
        details.push(if message.contains("://") || message.contains('@') {
            "network endpoint redacted".into()
        } else {
            message.chars().take(240).collect()
        });
        if details.len() == 5 {
            break;
        }
        source = cause.source();
    }
    HostError::new("js_runtime_download", details.join(": "))
}

fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn version(value: &str) -> bool {
    value.len() <= 64
        && value.split('.').count() == 3
        && value.split('.').all(|component| {
            !component.is_empty() && component.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn pin_for(pin: &RuntimePin, target: DesktopTarget) -> Result<(&PlatformPin, &str), HostError> {
    let platform = target.node_platform();
    let selected = pin
        .platforms
        .get(platform)
        .ok_or_else(|| invalid("Node pin has no current platform"))?;
    let release = selected.version.as_deref().unwrap_or(&pin.version);
    let base = selected.base_url.as_deref().unwrap_or(&pin.base_url);
    let suffix = if platform == "darwin-arm64" {
        "tar.gz"
    } else {
        "zip"
    };
    if pin.schema != 1
        || !version(release)
        || base != format!("https://nodejs.org/download/release/v{release}")
        || selected.archive != format!("node-v{release}-{platform}.{suffix}")
        || !hash(&selected.archive_sha256)
        || !hash(&selected.executable_sha256)
        || !hash(&selected.license_sha256)
        || selected
            .mirror_url
            .as_deref()
            .is_some_and(|mirror| !allowed_mirror_asset_url(mirror, &selected.archive))
    {
        return Err(invalid(
            "Node fallback pin is not an exact official release archive and file set",
        ));
    }
    Ok((selected, release))
}

pub(super) fn allowed_mirror_asset_url(raw: &str, archive: &str) -> bool {
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };
    if url.scheme() != "https"
        || !matches!(url.host_str(), Some("github.com" | "api.github.com"))
        || url.port().is_some_and(|port| port != 443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    let parts: Vec<_> = url.path().split('/').collect();
    match url.host_str() {
        Some("github.com") => {
            parts.len() == 7
                && parts[0].is_empty()
                && parts[1..5] == ["baoabaob", "codlet", "releases", "download"]
                && parts[5] == "node-runtimes"
                && parts[6] == archive
        }
        Some("api.github.com") => {
            parts.len() == 7
                && parts[0].is_empty()
                && parts[1..6] == ["repos", "baoabaob", "codlet", "releases", "assets"]
                && !parts[6].is_empty()
                && parts[6].len() <= 20
                && parts[6].bytes().all(|byte| byte.is_ascii_digit())
                && parts[6].parse::<u64>().is_ok_and(|id| id > 0)
        }
        _ => false,
    }
}

fn plain(path: &Path) -> Result<(), HostError> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(invalid("Node runtime path contains a link"));
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
                    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                        return Err(invalid("Node runtime path contains a reparse point"));
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(io_error(error)),
        }
    }
    Ok(())
}

fn read_pin(directory: &Path) -> Result<RuntimePin, HostError> {
    if !directory.is_absolute() {
        return Err(invalid("Core distribution directory must be absolute"));
    }
    #[cfg(target_os = "macos")]
    let directory = directory.canonicalize().map_err(io_error)?;
    let path = directory.join("runtime/node-runtime.json");
    plain(&path)?;
    let metadata = fs::symlink_metadata(&path).map_err(io_error)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_PIN_BYTES {
        return Err(invalid(
            "Core distribution Node pin is not an ordinary bounded file",
        ));
    }
    let mut bytes = Vec::new();
    File::open(&path)
        .map_err(io_error)?
        .take(MAX_PIN_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > MAX_PIN_BYTES {
        return Err(invalid("Core distribution Node pin exceeded its limit"));
    }
    serde_json::from_slice(&bytes)
        .map_err(|error| invalid(format!("Invalid Core distribution Node pin: {error}")))
}

pub(super) fn ensure(directory: &Path) -> Result<JsRuntime, HostError> {
    let pin = read_pin(directory)?;
    let target =
        DesktopTarget::current().ok_or_else(|| invalid("Unsupported Node runtime platform"))?;
    let (selected, release) = pin_for(&pin, target)?;
    match pin.mode.as_deref().unwrap_or("bundled") {
        "bundled" => JsRuntime::checked_bundled(directory, &pin),
        "managed" => ensure_managed(directory, &pin, selected, release, target),
        _ => Err(invalid("Unknown Core distribution Node provisioning mode")),
    }
}

pub(super) fn ensure_current(directory: &Path) -> Result<JsRuntime, HostError> {
    let mut disk = read_pin(directory)?;
    let mut embedded: RuntimePin =
        serde_json::from_str(include_str!("../../runtime/node-runtime.json"))
            .expect("checked-in Node runtime pin is valid");
    // Packaging marks a bridge bundle as bundled and a slim bundle as
    // managed. The Node identities and official URLs remain fixed in Core.
    disk.mode = None;
    embedded.mode = None;
    if disk != embedded {
        return Err(HostError::new(
            "js_runtime_mismatch",
            "Current distribution Node pin differs from the Core-owned pin",
        ));
    }
    // Existing bridge packages and unit fixtures retain the verified bundled
    // executor. Slim packages have no Node files and proceed to provisioning.
    if let Ok(bundled) = JsRuntime::checked_bundled(directory, &disk) {
        return Ok(bundled);
    }
    ensure(directory)
}

fn cache_root() -> Result<PathBuf, HostError> {
    let registry = crate::plugins::default_registry_path().map_err(|error| {
        invalid(format!(
            "Codlet user data directory is unavailable: {error}"
        ))
    })?;
    let user_data = registry
        .parent()
        .ok_or_else(|| invalid("Codlet registry has no user data directory"))?;
    fs::create_dir_all(user_data).map_err(io_error)?;
    let root = user_data
        .canonicalize()
        .map_err(io_error)?
        .join("js-runtimes");
    if !root.is_absolute() {
        return Err(invalid("Private Node cache must have an absolute path"));
    }
    plain(&root)?;
    fs::create_dir_all(&root).map_err(io_error)?;
    plain(&root)?;
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).map_err(io_error)?;
    }
    Ok(root)
}

pub(super) fn profiles() -> Result<Vec<ClientProfile>, HostError> {
    let parsed: ClientProfiles =
        serde_json::from_str(include_str!("../../runtime/client-node-profiles.json"))
            .map_err(|error| invalid(format!("Invalid embedded client Node profiles: {error}")))?;
    if parsed.schema != 1 || parsed.profiles.len() > 16 {
        return Err(invalid(
            "Embedded client Node profiles have an unsupported schema or count",
        ));
    }
    for profile in &parsed.profiles {
        if !version(&profile.node_version)
            || !hash(&profile.node_sha256)
            || !hash(&profile.license_sha256)
            || !matches!(
                profile.platform.as_str(),
                "win-x64" | "win-arm64" | "darwin-arm64"
            )
        {
            return Err(invalid("Embedded client Node profile is invalid"));
        }
        let source_valid = match &profile.source {
            ClientSource::WindowsPackage {
                family,
                full_name,
                node_path,
                license_path,
            } => {
                profile.platform.starts_with("win-")
                    && family == "OpenAI.Codex_2p2nqsd0c76g0"
                    && full_name.starts_with("OpenAI.Codex_")
                    && full_name.ends_with("__2p2nqsd0c76g0")
                    && safe_relative(node_path)
                    && safe_relative(license_path)
            }
            ClientSource::MacBundle {
                bundle_id,
                app_version,
                team_id,
                node_path,
                license_path,
            } => {
                profile.platform == "darwin-arm64"
                    && bundle_id == "com.openai.codex"
                    && !app_version.is_empty()
                    && team_id == "2DC432GLL2"
                    && safe_relative(node_path)
                    && safe_relative(license_path)
            }
        };
        if !source_valid {
            return Err(invalid("Embedded client Node source identity is invalid"));
        }
    }
    Ok(parsed.profiles)
}

fn safe_relative(value: &str) -> bool {
    !value.is_empty()
        && Path::new(value)
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
}

fn ensure_managed(
    directory: &Path,
    pin: &RuntimePin,
    selected: &PlatformPin,
    release: &str,
    target: DesktopTarget,
) -> Result<JsRuntime, HostError> {
    let root = cache_root()?;
    let current: RuntimePin = serde_json::from_str(include_str!("../../runtime/node-runtime.json"))
        .expect("checked-in Node runtime pin is valid");
    let current_fallback_matches =
        pin_for(&current, target).is_ok_and(|(current_pin, current_version)| {
            current_version == release
                && current_pin.executable_sha256 == selected.executable_sha256
                && current_pin.license_sha256 == selected.license_sha256
        });
    for profile in profiles()?.iter().filter(|profile| {
        current_fallback_matches && profile.enabled && profile.platform == target.node_platform()
    }) {
        if let Some(cached) = reuse_cache(
            &root,
            target,
            &profile.node_version,
            &profile.node_sha256,
            &profile.license_sha256,
        )? {
            prune_obsolete(&root, target, pin);
            return Ok(cached);
        }
        if let Some(source) = official_source(profile) {
            let node = source.executable_path().to_owned();
            let license = source.license_path().to_owned();
            let cached = ensure_cache_with(
                &root,
                target,
                &profile.node_version,
                &profile.node_sha256,
                &profile.license_sha256,
                move |prepared_node, prepared_license| {
                    copy_pair(&node, &license, prepared_node, prepared_license)
                },
            )?;
            prune_obsolete(&root, target, pin);
            return Ok(cached);
        }
    }
    if let Some(cached) = reuse_cache(
        &root,
        target,
        release,
        &selected.executable_sha256,
        &selected.license_sha256,
    )? {
        prune_obsolete(&root, target, pin);
        return Ok(cached);
    }
    // Old full packages remain usable without network while a managed update is
    // being prepared; slim packages have no bundled Node and use the fixed URL.
    if JsRuntime::checked_bundled(directory, pin).is_ok() {
        return JsRuntime::checked_bundled(directory, pin);
    }
    let url = format!(
        "{}/{}",
        selected.base_url.as_deref().unwrap_or(&pin.base_url),
        selected.archive
    );
    let cached = ensure_cache_with(
        &root,
        target,
        release,
        &selected.executable_sha256,
        &selected.license_sha256,
        |prepared_node, prepared_license| {
            let archive = prepared_license
                .parent()
                .ok_or_else(|| invalid("Prepared Node LICENSE has no parent"))?
                .join(&selected.archive);
            download_exact_archive(
                &url,
                selected.mirror_url.as_deref(),
                &archive,
                &selected.archive_sha256,
            )?;
            extract_exact(&archive, target, release, prepared_node, prepared_license)?;
            fs::remove_file(&archive).map_err(io_error)
        },
    )?;
    prune_obsolete(&root, target, pin);
    Ok(cached)
}

fn cache_paths(root: &Path, target: DesktopTarget, digest: &str) -> (PathBuf, PathBuf, PathBuf) {
    let directory = root.join(format!("{}-{digest}", target.node_platform()));
    let executable = directory.join(target.node_executable());
    let license = directory.join("LICENSE");
    (directory, executable, license)
}

fn existing_cache(
    root: &Path,
    target: DesktopTarget,
    version: &str,
    node_sha256: &str,
    license_sha256: &str,
) -> Result<Option<JsRuntime>, HostError> {
    let (directory, executable, license) = cache_paths(root, target, node_sha256);
    if !directory.exists() {
        return Ok(None);
    }
    plain(&directory)?;
    let marker = read_marker(&directory)?;
    if marker.schema != 1
        || marker.platform != target.node_platform()
        || marker.node_sha256 != node_sha256
        || marker.license_sha256 != license_sha256
        || !version_is_valid(&marker.version)
    {
        return Err(invalid(
            "Private Node cache marker does not match its pinned identity",
        ));
    }
    cache_layout(&directory, target)?;
    let checked = JsRuntime::checked_pair(
        &executable,
        &license,
        node_sha256,
        license_sha256,
        version,
        Some((executable.clone(), license.clone())),
    )?;
    Ok(Some(checked))
}

fn reuse_cache(
    root: &Path,
    target: DesktopTarget,
    version: &str,
    node_sha256: &str,
    license_sha256: &str,
) -> Result<Option<JsRuntime>, HostError> {
    let _lock = lock(root, target, node_sha256)?;
    cleanup_interrupted_for_key(root, target, node_sha256)?;
    existing_cache(root, target, version, node_sha256, license_sha256)
}

fn read_marker(directory: &Path) -> Result<CacheMarker, HostError> {
    let path = directory.join(CACHE_MARKER);
    plain(&path)?;
    let metadata = fs::symlink_metadata(&path).map_err(io_error)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 4096 {
        return Err(invalid(
            "Private Node cache marker is not an ordinary bounded file",
        ));
    }
    serde_json::from_slice(&fs::read(path).map_err(io_error)?)
        .map_err(|_| invalid("Private Node cache marker is invalid"))
}

fn write_preparing(directory: &Path, target: DesktopTarget, digest: &str) -> Result<(), HostError> {
    let marker = PreparingMarker {
        schema: 1,
        platform: target.node_platform().into(),
        node_sha256: digest.into(),
        created_ms: now_ms(),
    };
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.join(PREPARING_MARKER))
        .map_err(io_error)?;
    file.write_all(&serde_json::to_vec(&marker).expect("preparation marker serializes"))
        .map_err(io_error)?;
    file.sync_all().map_err(io_error)
}

fn preparation_owned(directory: &Path, target: DesktopTarget, digest: &str) -> bool {
    let pending = directory.join(PREPARING_MARKER);
    if plain(&pending).is_err() {
        return false;
    }
    if let Ok(metadata) = fs::symlink_metadata(&pending)
        && metadata.is_file()
        && metadata.len() > 0
        && metadata.len() <= 4096
        && let Ok(bytes) = fs::read(&pending)
        && let Ok(marker) = serde_json::from_slice::<PreparingMarker>(&bytes)
    {
        return marker.schema == 1
            && marker.platform == target.node_platform()
            && marker.node_sha256 == digest
            && marker.created_ms > 0;
    }
    read_marker(directory).is_ok_and(|marker| {
        marker.schema == 1
            && marker.platform == target.node_platform()
            && marker.node_sha256 == digest
    })
}

fn cleanup_interrupted_for_key(
    root: &Path,
    target: DesktopTarget,
    digest: &str,
) -> Result<(), HostError> {
    let prefix = format!(".node-prepare-{}-{digest}-", target.node_platform());
    let mut inspected = 0;
    for entry in fs::read_dir(root).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        inspected += 1;
        if inspected > 128 {
            break;
        }
        if !entry.file_name().to_string_lossy().starts_with(&prefix) {
            continue;
        }
        let path = entry.path();
        if !entry.file_type().map_err(io_error)?.is_dir()
            || !preparation_owned(&path, target, digest)
        {
            continue;
        }
        plain(&path)?;
        // The caller holds this exact digest's process-wide file lock. Any
        // marked preparation left here is from an interrupted owner.
        let _ = fs::remove_dir_all(&path);
    }
    Ok(())
}

fn cache_layout(directory: &Path, target: DesktopTarget) -> Result<(), HostError> {
    let mut names = BTreeSet::new();
    for entry in fs::read_dir(directory).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        names.insert(entry.file_name().to_string_lossy().into_owned());
        if names.len() > 3 {
            return Err(invalid("Private Node cache contains unexpected files"));
        }
    }
    let expected = if target.node_platform() == "darwin-arm64" {
        BTreeSet::from(["bin".into(), "LICENSE".into(), CACHE_MARKER.into()])
    } else {
        BTreeSet::from(["node.exe".into(), "LICENSE".into(), CACHE_MARKER.into()])
    };
    if names != expected {
        return Err(invalid("Private Node cache contains unexpected files"));
    }
    if target.node_platform() == "darwin-arm64" {
        let children: Vec<_> = fs::read_dir(directory.join("bin"))
            .map_err(io_error)?
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(io_error)?;
        if children.len() != 1 || children[0].file_name() != "node" {
            return Err(invalid("Private Node cache bin directory is not exact"));
        }
    }
    Ok(())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

fn write_marker(
    directory: &Path,
    target: DesktopTarget,
    version: &str,
    node_sha256: &str,
    license_sha256: &str,
) -> Result<(), HostError> {
    let marker = CacheMarker {
        schema: 1,
        platform: target.node_platform().into(),
        version: version.into(),
        node_sha256: node_sha256.into(),
        license_sha256: license_sha256.into(),
        created_ms: now_ms(),
    };
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.join(CACHE_MARKER))
        .map_err(io_error)?;
    file.write_all(&serde_json::to_vec(&marker).expect("cache marker serializes"))
        .map_err(io_error)?;
    file.sync_all().map_err(io_error)
}

fn prune_obsolete(root: &Path, target: DesktopTarget, pin: &RuntimePin) {
    if let Err(error) = prune_obsolete_inner(root, target, pin) {
        crate::runtime_log::error("js_runtime_cache_cleanup", &error.to_string());
    }
}

pub(super) fn prune_obsolete_inner(
    root: &Path,
    target: DesktopTarget,
    pin: &RuntimePin,
) -> Result<(), HostError> {
    let (fallback, _) = pin_for(pin, target)?;
    let mut keep = BTreeSet::from([fallback.executable_sha256.clone()]);
    for profile in profiles()?
        .iter()
        .filter(|profile| profile.enabled && profile.platform == target.node_platform())
    {
        keep.insert(profile.node_sha256.clone());
    }
    let prefix = format!("{}-", target.node_platform());
    let mut scanned = 0;
    for entry in fs::read_dir(root).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        scanned += 1;
        if scanned > 128 {
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let preparation_prefix = format!(".node-prepare-{}-", target.node_platform());
        if let Some(rest) = name.strip_prefix(&preparation_prefix) {
            if rest.len() > 65 {
                let digest = &rest[..64];
                if hash(digest)
                    && rest.as_bytes().get(64) == Some(&b'-')
                    && let Some(_lock) = try_lock_for_cleanup(root, target, digest)?
                {
                    let _ = cleanup_interrupted_for_key(root, target, digest);
                }
            }
            continue;
        }
        let retired_prefix = format!(".gc-{}-", target.node_platform());
        if let Some(rest) = name.strip_prefix(&retired_prefix) {
            if rest.len() > 65 {
                let digest = &rest[..64];
                if hash(digest)
                    && rest.as_bytes().get(64) == Some(&b'-')
                    && let Some(_lock) = try_lock_for_cleanup(root, target, digest)?
                {
                    finish_retired_gc(&entry.path(), target, digest)?;
                }
            }
            continue;
        }
        let Some(digest) = name.strip_prefix(&prefix) else {
            continue;
        };
        if !hash(digest) || keep.contains(digest) {
            continue;
        }
        let directory = entry.path();
        plain(&directory)?;
        let marker = match read_marker(&directory) {
            Ok(marker) => marker,
            Err(_) => continue,
        };
        if marker.schema != 1
            || marker.platform != target.node_platform()
            || marker.node_sha256 != digest
            || !hash(&marker.license_sha256)
            || marker.created_ms == 0
            || now_ms().saturating_sub(marker.created_ms) < CACHE_RETENTION_MS
        {
            continue;
        }
        let _lock = match try_lock_for_cleanup(root, target, digest)? {
            Some(lock) => lock,
            None => continue,
        };
        if cache_layout(&directory, target).is_err() {
            continue;
        }
        let (_, executable, license) = cache_paths(root, target, digest);
        let checked = JsRuntime::checked_pair(
            &executable,
            &license,
            digest,
            &marker.license_sha256,
            &marker.version,
            None,
        );
        if checked.is_err() {
            continue;
        }
        drop(checked);
        if !cache_is_idle(&executable, &license) {
            continue;
        }
        let retired = root.join(format!(
            ".gc-{}-{digest}-{}-{}",
            target.node_platform(),
            now_ms(),
            std::process::id()
        ));
        if retired.exists() || fs::rename(&directory, &retired).is_err() {
            // A busy Windows directory or a collision stays untouched.
            continue;
        }
        finish_retired_gc(&retired, target, digest)?;
    }
    Ok(())
}

#[cfg(windows)]
fn cache_is_idle(node: &Path, license: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    let exclusive = |path: &Path| OpenOptions::new().read(true).share_mode(0).open(path);
    let Ok(node) = exclusive(node) else {
        return false;
    };
    let Ok(license) = exclusive(license) else {
        return false;
    };
    drop((node, license));
    true
}

#[cfg(target_os = "macos")]
fn cache_is_idle(_node: &Path, _license: &Path) -> bool {
    // Every Mac Host generation executes its own verified snapshot, so no
    // generation depends on the persistent cache inode after preparation.
    true
}

fn finish_retired_gc(
    directory: &Path,
    target: DesktopTarget,
    digest: &str,
) -> Result<(), HostError> {
    plain(directory)?;
    let names: BTreeSet<_> = fs::read_dir(directory)
        .map_err(io_error)?
        .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
        .collect::<std::io::Result<_>>()
        .map_err(io_error)?;
    if names.is_empty() {
        return fs::remove_dir(directory).map_err(io_error);
    }
    let allowed = if target.node_platform() == "darwin-arm64" {
        BTreeSet::from(["bin".into(), "LICENSE".into(), CACHE_MARKER.into()])
    } else {
        BTreeSet::from(["node.exe".into(), "LICENSE".into(), CACHE_MARKER.into()])
    };
    if !names.is_subset(&allowed) {
        return Err(invalid("Retired Node cache contains an unrelated file"));
    }
    let marker = read_marker(directory)?;
    if marker.schema != 1
        || marker.platform != target.node_platform()
        || marker.node_sha256 != digest
    {
        return Err(invalid("Retired Node cache ownership marker changed"));
    }
    let node = directory.join(target.node_executable());
    let license = directory.join("LICENSE");
    for path in [&node, &license] {
        if path.exists() {
            plain(path)?;
            fs::remove_file(path).map_err(io_error)?;
        }
    }
    if target.node_platform() == "darwin-arm64" {
        let bin = directory.join("bin");
        if bin.exists() {
            plain(&bin)?;
            fs::remove_dir(bin).map_err(io_error)?;
        }
    }
    fs::remove_file(directory.join(CACHE_MARKER)).map_err(io_error)?;
    fs::remove_dir(directory).map_err(io_error)
}

fn lock(root: &Path, target: DesktopTarget, digest: &str) -> Result<File, HostError> {
    let path = root.join(format!("{}-{digest}.lock", target.node_platform()));
    plain(&path)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(io_error)?;
    plain(&path)?;
    if !file.metadata().map_err(io_error)?.is_file() {
        return Err(invalid("Private Node cache lock is not an ordinary file"));
    }
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(std::fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => {
                return Err(HostError::new(
                    "js_runtime_busy",
                    format!("Private Node cache preparation did not acquire its lock: {error}"),
                ));
            }
        }
    }
}

fn try_lock_for_cleanup(
    root: &Path,
    target: DesktopTarget,
    digest: &str,
) -> Result<Option<File>, HostError> {
    let path = root.join(format!("{}-{digest}.lock", target.node_platform()));
    plain(&path)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(io_error)?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(error) => Err(HostError::new("js_runtime_busy", error.to_string())),
    }
}

pub(super) fn ensure_cache_with(
    root: &Path,
    target: DesktopTarget,
    version: &str,
    node_sha256: &str,
    license_sha256: &str,
    prepare: impl FnOnce(&Path, &Path) -> Result<(), HostError>,
) -> Result<JsRuntime, HostError> {
    if !hash(node_sha256) || !hash(license_sha256) || !version_is_valid(version) {
        return Err(invalid("Private Node cache identity is invalid"));
    }
    plain(root)?;
    fs::create_dir_all(root).map_err(io_error)?;
    plain(root)?;
    let _lock = lock(root, target, node_sha256)?;
    cleanup_interrupted_for_key(root, target, node_sha256)?;
    if let Some(cached) = existing_cache(root, target, version, node_sha256, license_sha256)? {
        return Ok(cached);
    }
    let (final_directory, final_node, final_license) = cache_paths(root, target, node_sha256);
    let temporary = tempfile::Builder::new()
        .prefix(&format!(
            ".node-prepare-{}-{node_sha256}-",
            target.node_platform()
        ))
        .tempdir_in(root)
        .map_err(io_error)?;
    write_preparing(temporary.path(), target, node_sha256)?;
    let prepared_node = temporary.path().join(target.node_executable());
    let prepared_license = temporary.path().join("LICENSE");
    if let Some(parent) = prepared_node.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    prepare(&prepared_node, &prepared_license)?;
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&prepared_node, fs::Permissions::from_mode(0o500)).map_err(io_error)?;
        fs::set_permissions(&prepared_license, fs::Permissions::from_mode(0o400))
            .map_err(io_error)?;
    }
    let verified = JsRuntime::checked_pair(
        &prepared_node,
        &prepared_license,
        node_sha256,
        license_sha256,
        version,
        None,
    )?;
    drop(verified);
    write_marker(
        temporary.path(),
        target,
        version,
        node_sha256,
        license_sha256,
    )?;
    fs::remove_file(temporary.path().join(PREPARING_MARKER)).map_err(io_error)?;
    if final_directory.exists() {
        return Err(invalid(
            "Private Node cache path appeared during preparation",
        ));
    }
    fs::rename(temporary.path(), &final_directory).map_err(io_error)?;
    plain(&final_directory)?;
    JsRuntime::checked_pair(
        &final_node,
        &final_license,
        node_sha256,
        license_sha256,
        version,
        Some((final_node.clone(), final_license.clone())),
    )
}

fn version_is_valid(value: &str) -> bool {
    version(value)
}

pub(super) fn copy_pair(
    source_node: &Path,
    source_license: &Path,
    node: &Path,
    license: &Path,
) -> Result<(), HostError> {
    fs::copy(source_node, node).map_err(io_error)?;
    fs::copy(source_license, license).map_err(io_error)?;
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(node, fs::Permissions::from_mode(0o500)).map_err(io_error)?;
        fs::set_permissions(license, fs::Permissions::from_mode(0o400)).map_err(io_error)?;
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn official_source(profile: &ClientProfile) -> Option<JsRuntime> {
    let ClientSource::WindowsPackage {
        family,
        full_name,
        node_path,
        license_path,
    } = &profile.source
    else {
        return None;
    };
    if family != crate::windows::packages::CODEX_PACKAGE_FAMILY {
        return None;
    }
    let packages = crate::windows::packages::find_current_user_packages(family).ok()?;
    let package = packages
        .into_iter()
        .find(|package| &package.full_name == full_name)?;
    let node = crate::windows::packages::resolve_package_executable(&package, Path::new(node_path))
        .ok()?;
    let license =
        crate::windows::packages::resolve_package_executable(&package, Path::new(license_path))
            .ok()?;
    JsRuntime::checked_pair(
        &node,
        &license,
        &profile.node_sha256,
        &profile.license_sha256,
        &profile.node_version,
        None,
    )
    .ok()
}

#[cfg(target_os = "macos")]
pub(super) fn official_source(profile: &ClientProfile) -> Option<JsRuntime> {
    let mut candidates = vec![PathBuf::from("/Applications/ChatGPT.app")];
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(home).join("Applications/ChatGPT.app"));
    }
    candidates
        .into_iter()
        .find_map(|candidate| checked_mac_bundle(profile, &candidate).ok())
}

#[cfg(target_os = "macos")]
fn mac_tool(path: &str, arguments: &[&std::ffi::OsStr]) -> Result<std::process::Output, HostError> {
    let output = std::process::Command::new(path)
        .args(arguments)
        .output()
        .map_err(io_error)?;
    if !output.status.success()
        || output.stdout.len() > 64 * 1024
        || output.stderr.len() > 64 * 1024
    {
        return Err(invalid("Official Mac bundle identity check failed"));
    }
    Ok(output)
}

#[cfg(target_os = "macos")]
fn plist_value(path: &Path, key: &str) -> Result<String, HostError> {
    let output = mac_tool(
        "/usr/bin/plutil",
        &[
            std::ffi::OsStr::new("-extract"),
            std::ffi::OsStr::new(key),
            std::ffi::OsStr::new("raw"),
            std::ffi::OsStr::new("-o"),
            std::ffi::OsStr::new("-"),
            path.as_os_str(),
        ],
    )?;
    String::from_utf8(output.stdout)
        .map(|value| value.trim().to_owned())
        .map_err(|_| invalid("Official Mac Info.plist value is not UTF-8"))
}

#[cfg(target_os = "macos")]
fn codesign_identity(path: &Path) -> Result<String, HostError> {
    mac_tool(
        "/usr/bin/codesign",
        &[
            std::ffi::OsStr::new("--verify"),
            std::ffi::OsStr::new("--strict"),
            path.as_os_str(),
        ],
    )?;
    let output = mac_tool(
        "/usr/bin/codesign",
        &[
            std::ffi::OsStr::new("--display"),
            std::ffi::OsStr::new("--verbose=4"),
            path.as_os_str(),
        ],
    )?;
    Ok(format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    ))
}

#[cfg(target_os = "macos")]
fn checked_mac_bundle(profile: &ClientProfile, app: &Path) -> Result<JsRuntime, HostError> {
    let ClientSource::MacBundle {
        bundle_id,
        app_version,
        team_id,
        node_path,
        license_path,
    } = &profile.source
    else {
        return Err(invalid("Client Node profile is not a Mac bundle"));
    };
    let app = app.canonicalize().map_err(io_error)?;
    plain(&app)?;
    if app.file_name().and_then(|name| name.to_str()) != Some("ChatGPT.app") {
        return Err(invalid("Official Mac candidate is not ChatGPT.app"));
    }
    let info = app.join("Contents/Info.plist");
    plain(&info)?;
    if plist_value(&info, "CFBundleIdentifier")? != *bundle_id
        || plist_value(&info, "CFBundleShortVersionString")? != *app_version
    {
        return Err(invalid(
            "Official Mac bundle ID or version differs from the embedded profile",
        ));
    }
    let app_signature = codesign_identity(&app)?;
    if !app_signature
        .lines()
        .any(|line| line == format!("Identifier={bundle_id}"))
        || !app_signature
            .lines()
            .any(|line| line == format!("TeamIdentifier={team_id}"))
    {
        return Err(invalid(
            "Official Mac bundle signature identity differs from the embedded profile",
        ));
    }
    let node = app.join(node_path).canonicalize().map_err(io_error)?;
    let license = app.join(license_path).canonicalize().map_err(io_error)?;
    if !node.starts_with(&app) || !license.starts_with(&app) {
        return Err(invalid("Official Mac CUA Node escaped its verified bundle"));
    }
    plain(&node)?;
    plain(&license)?;
    let node_signature = codesign_identity(&node)?;
    if !node_signature
        .lines()
        .any(|line| line == format!("TeamIdentifier={team_id}"))
    {
        return Err(invalid(
            "Official Mac CUA Node signature differs from the embedded profile",
        ));
    }
    JsRuntime::checked_pair(
        &node,
        &license,
        &profile.node_sha256,
        &profile.license_sha256,
        &profile.node_version,
        None,
    )
}

#[cfg(all(test, target_os = "macos"))]
pub(super) fn official_mac_fixture(app: &Path, root: &Path) -> Result<JsRuntime, HostError> {
    let profile = profiles()?
        .into_iter()
        .find(|profile| profile.platform == "darwin-arm64")
        .ok_or_else(|| invalid("Embedded Mac CUA Node profile is missing"))?;
    let source = checked_mac_bundle(&profile, app)?;
    let node = source.executable_path().to_owned();
    let license = source.license_path().to_owned();
    ensure_cache_with(
        root,
        DesktopTarget::MacOsArm64,
        &profile.node_version,
        &profile.node_sha256,
        &profile.license_sha256,
        |prepared_node, prepared_license| {
            copy_pair(&node, &license, prepared_node, prepared_license)
        },
    )
}

#[derive(Clone, Copy)]
pub(super) enum DownloadSource {
    Official,
    CodletMirror,
}

pub(super) fn download_exact_archive(
    official: &str,
    mirror: Option<&str>,
    path: &Path,
    expected: &str,
) -> Result<(), HostError> {
    download_exact_archive_with(official, mirror, path, expected, download_archive)
}

pub(super) fn download_exact_archive_with(
    official: &str,
    mirror: Option<&str>,
    path: &Path,
    expected: &str,
    mut fetch: impl FnMut(&str, &Path, DownloadSource) -> Result<(), HostError>,
) -> Result<(), HostError> {
    let sources = mirror
        .map(|url| (DownloadSource::CodletMirror, url))
        .into_iter()
        .chain(std::iter::once((DownloadSource::Official, official)));
    let mut failures = Vec::new();
    for (source, url) in sources {
        let result = fetch(url, path, source).and_then(|()| {
            if sha256(&File::open(path).map_err(io_error)?)? == expected {
                Ok(())
            } else {
                Err(HostError::new(
                    "js_runtime_mismatch",
                    "Official Node archive hash differs from its pinned SHA-256",
                ))
            }
        });
        if result.is_ok() {
            return Ok(());
        }
        if let Err(error) = result {
            let label = match source {
                DownloadSource::CodletMirror => "Codlet mirror",
                DownloadSource::Official => "Node.js release",
            };
            failures.push(format!("{label}: {} ({})", error.message, error.code));
        }
        if path.exists() {
            fs::remove_file(path).map_err(io_error)?;
        }
    }
    Err(HostError::new("js_runtime_download", failures.join("; ")))
}

pub(super) fn download_archive(
    url: &str,
    path: &Path,
    source: DownloadSource,
) -> Result<(), HostError> {
    let url = url.to_owned();
    let path = path.to_owned();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(io_error)?;
        runtime.block_on(async move { download_archive_async(&url, &path, source).await })
    })
    .join()
    .map_err(|_| {
        HostError::new(
            "js_runtime_download",
            "Official Node download worker failed",
        )
    })?
}

fn allowed_node_url(url: &url::Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("nodejs.org")
        && url.port().is_none_or(|port| port == 443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.path().starts_with("/download/release/")
        && url.query().is_none()
        && url.fragment().is_none()
}

fn allowed_download_url(url: &url::Url, source: DownloadSource, archive: &str) -> bool {
    match source {
        DownloadSource::Official => allowed_node_url(url),
        DownloadSource::CodletMirror => {
            allowed_mirror_asset_url(url.as_str(), archive)
                || (url.scheme() == "https"
                    && matches!(
                        url.host_str(),
                        Some(
                            "release-assets.githubusercontent.com"
                                | "objects.githubusercontent.com"
                        )
                    )
                    && url.port().is_none_or(|port| port == 443)
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.fragment().is_none())
        }
    }
}

async fn download_archive_async(
    url: &str,
    path: &Path,
    source: DownloadSource,
) -> Result<(), HostError> {
    let total_timeout = match source {
        DownloadSource::Official => Duration::from_secs(75),
        DownloadSource::CodletMirror => Duration::from_secs(180),
    };
    tokio::time::timeout(total_timeout, async {
        let started = Instant::now();
        for attempt in 0..3 {
            let remaining = total_timeout.saturating_sub(started.elapsed());
            let result = download_archive_attempt(url, path, source, remaining).await;
            match result {
                Ok(()) => return Ok(()),
                Err(error) if error.code != "js_runtime_download" || attempt == 2 => {
                    return Err(error);
                }
                Err(_) => {
                    if path.exists() {
                        fs::remove_file(path).map_err(io_error)?;
                    }
                    tokio::time::sleep(Duration::from_millis(500 * (attempt + 1))).await;
                }
            }
        }
        unreachable!()
    })
    .await
    .map_err(|_| {
        let received = fs::metadata(path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        HostError::new(
            "js_runtime_download",
            format!(
                "Fixed Node source exceeded its total download deadline after {received} bytes"
            ),
        )
    })?
}

async fn download_archive_attempt(
    url: &str,
    path: &Path,
    source: DownloadSource,
    total_timeout: Duration,
) -> Result<(), HostError> {
    let builder = reqwest::Client::builder()
        .http1_only()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(total_timeout)
        .user_agent("Codlet-managed-Node/1");
    #[cfg(windows)]
    let builder = builder.use_native_tls();
    let client = builder.build().map_err(network_error)?;
    let mut current = url::Url::parse(url).map_err(|_| invalid("Official Node URL is invalid"))?;
    let archive = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| invalid("Node archive name is invalid"))?;
    for _ in 0..=5 {
        if !allowed_download_url(&current, source, archive) {
            return Err(invalid(
                "Node download redirected outside the official HTTPS release source",
            ));
        }
        let response = client
            .get(current.clone())
            .header("Accept", "application/octet-stream")
            .header("X-GitHub-Api-Version", "2026-03-10")
            .header("Accept-Encoding", "identity")
            .send()
            .await
            .map_err(network_error)?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| invalid("Node download redirect has no valid location"))?;
            current = current
                .join(location)
                .map_err(|_| invalid("Node download redirect URL is invalid"))?;
            continue;
        }
        if !response.status().is_success() {
            return Err(HostError::new(
                "js_runtime_download",
                format!(
                    "Official Node download returned HTTP {}",
                    response.status().as_u16()
                ),
            ));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_ARCHIVE_BYTES)
        {
            return Err(invalid("Official Node archive exceeds its download limit"));
        }
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(io_error)?;
        let mut response = response;
        let mut total = 0_u64;
        while let Some(chunk) = tokio::time::timeout(Duration::from_secs(30), response.chunk())
            .await
            .map_err(|_| {
                HostError::new(
                    "js_runtime_download",
                    "Official Node download stalled for 30 seconds",
                )
            })?
            .map_err(network_error)?
        {
            total = total
                .checked_add(chunk.len() as u64)
                .ok_or_else(|| invalid("Official Node archive size overflow"))?;
            if total > MAX_ARCHIVE_BYTES {
                return Err(invalid("Official Node archive exceeds its download limit"));
            }
            output.write_all(&chunk).map_err(io_error)?;
        }
        output.sync_all().map_err(io_error)?;
        if total == 0 {
            return Err(invalid("Official Node archive was empty"));
        }
        return Ok(());
    }
    Err(invalid(
        "Official Node download exceeded its redirect limit",
    ))
}

pub(super) fn extract_exact(
    archive: &Path,
    target: DesktopTarget,
    release: &str,
    node: &Path,
    license: &Path,
) -> Result<(), HostError> {
    let basename = format!("node-v{release}-{}", target.node_platform());
    #[cfg(windows)]
    {
        let mut zip = zip::ZipArchive::new(File::open(archive).map_err(io_error)?)
            .map_err(|error| invalid(format!("Official Node ZIP is invalid: {error}")))?;
        if zip.len() > 10000 {
            return Err(invalid("Official Node ZIP has too many entries"));
        }
        for (wanted, destination, maximum) in [
            (format!("{basename}/node.exe"), node, MAX_NODE_BYTES),
            (format!("{basename}/LICENSE"), license, MAX_LICENSE_BYTES),
        ] {
            let mut matches = Vec::new();
            for index in 0..zip.len() {
                if zip
                    .by_index(index)
                    .map_err(|error| invalid(error.to_string()))?
                    .name()
                    == wanted
                {
                    matches.push(index);
                }
            }
            if matches.len() != 1 {
                return Err(invalid(
                    "Official Node ZIP is missing or duplicates a pinned file",
                ));
            }
            let member = zip
                .by_index(matches[0])
                .map_err(|error| invalid(error.to_string()))?;
            if !member.is_file() || member.size() == 0 || member.size() > maximum {
                return Err(invalid(
                    "Official Node ZIP pinned member is not a bounded regular file",
                ));
            }
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(destination)
                .map_err(io_error)?;
            if std::io::copy(&mut member.take(maximum + 1), &mut output).map_err(io_error)?
                > maximum
            {
                return Err(invalid("Official Node ZIP member exceeded its size limit"));
            }
            output.sync_all().map_err(io_error)?;
        }
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let input = File::open(archive).map_err(io_error)?;
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(input));
        let names = [
            format!("{basename}/bin/node"),
            format!("{basename}/LICENSE"),
        ];
        let mut seen = [false; 2];
        for entry in tar.entries().map_err(io_error)? {
            let mut entry = entry.map_err(io_error)?;
            let name = entry.path().map_err(io_error)?.into_owned();
            for index in 0..2 {
                if name == Path::new(&names[index]) {
                    if seen[index] || !entry.header().entry_type().is_file() {
                        return Err(invalid(
                            "Official Node archive has a duplicate or special pinned member",
                        ));
                    }
                    let (destination, maximum) = if index == 0 {
                        (node, MAX_NODE_BYTES)
                    } else {
                        (license, MAX_LICENSE_BYTES)
                    };
                    if entry.size() == 0 || entry.size() > maximum {
                        return Err(invalid("Official Node archive member exceeds its limit"));
                    }
                    let mut output = OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(destination)
                        .map_err(io_error)?;
                    if std::io::copy(&mut (&mut entry).take(maximum + 1), &mut output)
                        .map_err(io_error)?
                        > maximum
                    {
                        return Err(invalid(
                            "Official Node archive member exceeded its size limit",
                        ));
                    }
                    output.sync_all().map_err(io_error)?;
                    seen[index] = true;
                }
            }
        }
        if !seen.into_iter().all(|value| value) {
            return Err(invalid("Official Node archive is missing a pinned member"));
        }
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(node, fs::Permissions::from_mode(0o500)).map_err(io_error)?;
        fs::set_permissions(license, fs::Permissions::from_mode(0o400)).map_err(io_error)?;
        Ok(())
    }
}
