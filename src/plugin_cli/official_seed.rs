//! Offline installer-owned local packages. The caller holds the existing registry
//! and launch leases from preview through recovery/publish. Sources stay local;
//! temporary ready/backup directories exist only while one journal is pending.
use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::PluginCliError;
use crate::local_import::{digest, registration_digest};
use crate::plugin_control::PluginControlError;
use crate::plugins::{LocalPluginRegistration, Permission, PluginRegistry};

type Result<T> = std::result::Result<T, PluginControlError>;
const IDS: [&str; 3] = ["codex.ui.adapter", "codex.desktop.adapter", "codlet-gui"];
const MAX_FILE: u64 = 16 * 1024 * 1024;
const MAX_TOTAL: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct FileRecord {
    path: String,
    sha256: String,
    bytes: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Package {
    id: String,
    version: String,
    permissions: Vec<Permission>,
    files: Vec<FileRecord>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    schema: u32,
    kind: String,
    packages: Vec<Package>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPackage {
    source_revision: String,
    #[serde(flatten)]
    package: Package,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    schema: u32,
    source: String,
    package: Package,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    schema: u32,
    id: String,
    previous: Option<LocalPluginRegistration>,
    next: LocalPluginRegistration,
    previous_enabled: bool,
    enabled: bool,
    previous_package: Option<Package>,
    package: Package,
    previous_receipt: Option<Receipt>,
    committed: bool,
}
struct Selection {
    package: Package,
    source: PathBuf,
    target: PathBuf,
    previous_package: Option<Package>,
    previous_receipt: Option<Receipt>,
    registration: Option<LocalPluginRegistration>,
    enabled: bool,
    added_permissions: Vec<Permission>,
    preview: String,
}

fn error(message: impl std::fmt::Display) -> PluginControlError {
    PluginControlError::new("official_seed", message.to_string())
}
fn migration(message: impl std::fmt::Display) -> PluginControlError {
    PluginControlError::new(
        "official_seed_source_changed",
        format!(
            "官方插件未更新：{message}。当前来源无法证明是未修改的官方安装包；作者文件、授权和禁用状态均保留，请在插件管理中检查来源。"
        ),
    )
}
fn plain(path: &Path) -> Result<()> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes() & 0x400 != 0 {
                        return Err(error("Linked installer paths are not allowed"));
                    }
                }
                if metadata.file_type().is_symlink() {
                    return Err(error("Linked installer paths are not allowed"));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(error(e)),
        }
    }
    Ok(())
}
fn bytes(path: &Path, max: u64) -> Result<Vec<u8>> {
    use std::io::Read;
    plain(path)?;
    let file = fs::File::open(path).map_err(error)?;
    let meta = file.metadata().map_err(error)?;
    if !meta.is_file() || meta.len() > max {
        return Err(error("Installer input exceeds its file bound"));
    }
    let mut data = Vec::new();
    file.take(max + 1).read_to_end(&mut data).map_err(error)?;
    if data.len() as u64 > max {
        return Err(error("Installer input grew past its bound"));
    }
    Ok(data)
}
fn read<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let data = bytes(path, 1024 * 1024)?;
    serde_json::from_slice(data.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&data)).map_err(error)
}
fn write(path: &Path, value: &impl Serialize) -> Result<()> {
    plain(path)?;
    let mut temp =
        tempfile::NamedTempFile::new_in(path.parent().ok_or_else(|| error("Missing parent"))?)
            .map_err(error)?;
    temp.write_all(&serde_json::to_vec(value).map_err(error)?)
        .map_err(error)?;
    temp.as_file().sync_all().map_err(error)?;
    temp.persist(path).map_err(error)?;
    Ok(())
}
fn valid(package: &Package) -> Result<()> {
    if !crate::plugins::valid_plugin_id(&package.id)
        || package.files.is_empty()
        || package.files.len() > 512
    {
        return Err(error("Invalid official package identity or file count"));
    }
    let mut names = BTreeSet::new();
    let mut total = 0u64;
    for file in &package.files {
        if file.path.is_empty()
            || file
                .path
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == "..")
            || !file
                .path
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._/-".contains(&c))
            || Path::new(&file.path)
                .components()
                .any(|p| !matches!(p, Component::Normal(_)))
            || !names.insert(file.path.to_ascii_lowercase())
            || file.sha256.len() != 64
            || !file
                .sha256
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            || file.bytes > MAX_FILE
        {
            return Err(error("Invalid official package file record"));
        }
        total = total
            .checked_add(file.bytes)
            .ok_or_else(|| error("Package size overflow"))?;
    }
    if total > MAX_TOTAL || !names.contains("codlet.json") {
        return Err(error("Invalid package size or missing manifest"));
    }
    Ok(())
}

/// Read-only proof that a registration still points to an unmodified installer
/// package. The migration path never infers ownership from an ID or display name.
pub(crate) fn verified_installer_source(registry: &PluginRegistry, id: &str) -> bool {
    let Some(registration) = registry.local_plugins().get(id) else {
        return false;
    };
    if registry.managed_plugins().contains_key(id) {
        return false;
    }
    let Some(home) = registry.path().parent() else {
        return false;
    };
    let Ok(home) = home.canonicalize() else {
        return false;
    };
    if registration.path != home.join("packages").join(id) {
        return false;
    }
    let receipt_path = home
        .join(".official-seed-transactions")
        .join(format!("{id}.receipt.json"));
    let Ok(receipt) = read::<Receipt>(&receipt_path) else {
        return false;
    };
    receipt.schema == 1
        && receipt.source == "official-installer"
        && receipt.package.id == id
        && verify(&registration.path, &receipt.package).is_ok()
}

/// Retire only the exact installer-owned source after a managed adoption has
/// durably committed. A failed or interrupted cleanup leaves the managed
/// journal in place so startup can retry without losing the old author files.
pub(crate) fn cleanup_adopted_source(
    registry: &PluginRegistry,
    id: &str,
    previous: &LocalPluginRegistration,
) -> Result<()> {
    let (packages, _) = roots(registry.path())?;
    let source = packages.join(id);
    if previous.path != source
        || registry.local_plugins().values().any(|registration| {
            registration.path.starts_with(&source) || source.starts_with(&registration.path)
        })
    {
        return Err(error(
            "Installer source is still registered or changed path",
        ));
    }
    let receipt_path = receipt_path(registry.path(), id)?;
    plain(&source)?;
    plain(&receipt_path)?;
    if !source.exists() && !receipt_path.exists() {
        return Ok(());
    }
    let receipt: Receipt = read(&receipt_path)?;
    if receipt.schema != 1 || receipt.source != "official-installer" || receipt.package.id != id {
        return Err(error("Installer source receipt changed during cleanup"));
    }
    if source.exists() {
        let mut previous_view = registry.clone();
        previous_view.restore_managed(id, Some(previous.clone()), None);
        if !verified_installer_source(&previous_view, id) {
            return Err(error(
                "Installer source changed during cleanup; directory preserved",
            ));
        }
        fs::remove_dir_all(&source).map_err(error)?;
    }
    // The source directory is gone, so this receipt has no remaining package.
    // Re-read it to avoid clearing a receipt replaced during directory removal.
    let current: Receipt = read(&receipt_path)?;
    if current != receipt {
        return Err(error("Installer source receipt changed during cleanup"));
    }
    fs::remove_file(&receipt_path).map_err(error)
}
fn tree(
    directory: &Path,
    prefix: &str,
    files: &mut BTreeSet<String>,
    dirs: &mut BTreeSet<String>,
) -> Result<()> {
    plain(directory)?;
    for entry in fs::read_dir(directory).map_err(error)? {
        let entry = entry.map_err(error)?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| error("Non-UTF8 package path"))?;
        let relative = format!("{prefix}{name}");
        let metadata = fs::symlink_metadata(entry.path()).map_err(error)?;
        plain(&entry.path())?;
        if metadata.is_dir() {
            if dirs.len() >= 512 {
                return Err(error("Too many package directories"));
            }
            dirs.insert(relative.clone());
            tree(&entry.path(), &(relative + "/"), files, dirs)?;
        } else if metadata.is_file() {
            files.insert(relative);
        } else {
            return Err(error("Special package file"));
        }
        if files.len() > 512 {
            return Err(error("Too many package files"));
        }
    }
    Ok(())
}
fn verify(directory: &Path, package: &Package) -> Result<()> {
    valid(package)?;
    let mut files = BTreeSet::new();
    let mut dirs = BTreeSet::new();
    tree(directory, "", &mut files, &mut dirs)?;
    let expected: BTreeSet<_> = package.files.iter().map(|f| f.path.clone()).collect();
    let mut expected_dirs = BTreeSet::new();
    for file in &package.files {
        let mut parent = Path::new(&file.path).parent();
        while let Some(path) = parent {
            if path.as_os_str().is_empty() {
                break;
            }
            expected_dirs.insert(path.to_string_lossy().replace('\\', "/"));
            parent = path.parent();
        }
        let data = bytes(&directory.join(&file.path), MAX_FILE)?;
        if data.len() as u64 != file.bytes || format!("{:x}", Sha256::digest(&data)) != file.sha256
        {
            return Err(error(format!("Package file changed: {}", file.path)));
        }
    }
    if files != expected || dirs != expected_dirs {
        return Err(error(
            "Package contains additional or missing author files/directories",
        ));
    }
    Ok(())
}
fn verify_remaining(directory: &Path, package: &Package) -> Result<()> {
    valid(package)?;
    let mut files = BTreeSet::new();
    let mut dirs = BTreeSet::new();
    tree(directory, "", &mut files, &mut dirs)?;
    for name in files {
        let file = package
            .files
            .iter()
            .find(|f| f.path == name)
            .ok_or_else(|| error("Unexpected author file during cleanup"))?;
        let data = bytes(&directory.join(name), MAX_FILE)?;
        if data.len() as u64 != file.bytes || format!("{:x}", Sha256::digest(data)) != file.sha256 {
            return Err(error("Backup changed during cleanup"));
        }
    }
    if dirs.iter().any(|p| {
        !package
            .files
            .iter()
            .any(|f| f.path.starts_with(&(p.to_owned() + "/")))
    }) {
        return Err(error("Unexpected backup directory"));
    }
    Ok(())
}
fn roots(registry: &Path) -> Result<(PathBuf, PathBuf)> {
    let home = registry
        .parent()
        .ok_or_else(|| error("Registry has no parent"))?;
    plain(home)?;
    fs::create_dir_all(home).map_err(error)?;
    let home = home.canonicalize().map_err(error)?;
    let packages = home.join("packages");
    let transactions = home.join(".official-seed-transactions");
    for path in [&packages, &transactions] {
        plain(path)?;
        fs::create_dir_all(path).map_err(error)?;
    }
    Ok((packages, transactions))
}
fn receipt_path(registry: &Path, id: &str) -> Result<PathBuf> {
    let (_, transactions) = roots(registry)?;
    Ok(transactions.join(format!("{id}.receipt.json")))
}
fn old_script_package(registry: &Path, id: &str, target: &Path) -> Option<Package> {
    for filename in ["plugin-setup.json", "macos-setup.json"] {
        let value: Value = match read(&registry.parent()?.join(filename)) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let entry = &value["decided"][id];
        if entry["source"] != "official-installer"
            || Path::new(entry["path"].as_str()?)
                .canonicalize()
                .ok()?
                .as_path()
                != target
        {
            continue;
        }
        let files = serde_json::from_value(entry["files"].clone()).ok()?;
        let manifest = crate::local_plugins::inspect_local_plugin(target)
            .ok()?
            .manifest;
        let package = Package {
            id: id.into(),
            version: manifest.version,
            permissions: manifest.permissions,
            files,
        };
        if verify(target, &package).is_ok() {
            return Some(package);
        }
    }
    None
}
fn select(registry: &PluginRegistry, catalog_path: &Path, id: &str) -> Result<Selection> {
    let known: Vec<LegacyPackage> = serde_json::from_str(include_str!(
        "../../scripts/distribution/legacy-official-seeds.json"
    ))
    .map_err(error)?;
    select_with_legacy(registry, catalog_path, id, &known)
}
fn select_with_legacy(
    registry: &PluginRegistry,
    catalog_path: &Path,
    id: &str,
    known: &[LegacyPackage],
) -> Result<Selection> {
    if !IDS.contains(&id) {
        return Err(error("Unknown official plugin"));
    }
    let catalog: Catalog = read(catalog_path)?;
    if catalog.schema != 1 || catalog.kind != "codlet-official-plugin-bundle" {
        return Err(error("Invalid official plugin catalog"));
    }
    if catalog.packages.iter().filter(|p| p.id == id).count() != 1 {
        return Err(error("Catalog identity is missing or duplicated"));
    }
    let package = catalog
        .packages
        .iter()
        .find(|p| p.id == id)
        .unwrap()
        .clone();
    valid(&package)?;
    let source = catalog_path
        .parent()
        .ok_or_else(|| error("Catalog has no directory"))?
        .join("packages")
        .join(id);
    verify(&source, &package)?;
    let candidate = crate::local_plugins::inspect_local_plugin(&source).map_err(error)?;
    if candidate.manifest.id != id
        || candidate.manifest.version != package.version
        || candidate.manifest.permissions != package.permissions
    {
        return Err(error("Catalog and manifest differ"));
    }
    let (packages, _) = roots(registry.path())?;
    let target = packages.join(id);
    let registration = registry.local_plugins().get(id).cloned();
    if registry.managed_plugins().contains_key(id)
        || registration.as_ref().is_some_and(|r| r.path != target)
    {
        return Err(migration(format!("{id} uses a custom or GitHub source")));
    }
    plain(&target)?;
    let receipt_file = receipt_path(registry.path(), id)?;
    let previous_receipt: Option<Receipt> = if receipt_file.exists() {
        Some(read(&receipt_file)?)
    } else {
        None
    };
    let previous_package = if target.exists() {
        let mut proofs = Vec::new();
        if let Some(receipt) = &previous_receipt
            && receipt.schema == 1
            && receipt.source == "official-installer"
        {
            proofs.push(receipt.package.clone());
        }
        if let Some(package) = old_script_package(registry.path(), id, &target) {
            proofs.push(package);
        }
        // The current signed/bundled catalog also proves identical existing bytes.
        proofs.push(package.clone());
        for legacy in known {
            if legacy.source_revision.len() == 40
                && legacy
                    .source_revision
                    .bytes()
                    .all(|c| c.is_ascii_hexdigit())
                && legacy.package.id == id
            {
                proofs.push(legacy.package.clone());
            }
        }
        Some(
            proofs
                .into_iter()
                .find(|p| p.id == id && verify(&target, p).is_ok())
                .ok_or_else(|| migration(id))?,
        )
    } else {
        if registration.is_some() {
            return Err(migration(format!("{id} source directory is missing")));
        }
        None
    };
    let enabled = registry.is_enabled(id);
    let grants = registration
        .as_ref()
        .map(|r| r.grants.as_slice())
        .unwrap_or(&[]);
    let added_permissions: Vec<_> = package
        .permissions
        .iter()
        .filter(|p| {
            !grants.contains(p)
                && (registration.is_none()
                    || previous_package
                        .as_ref()
                        .is_none_or(|old| !old.permissions.contains(p)))
        })
        .copied()
        .collect();
    let preview = digest(&(
        registration_digest(registry, id),
        &package,
        &previous_package,
        &source,
        &target,
        &added_permissions,
    ));
    Ok(Selection {
        package,
        source,
        target,
        previous_package,
        previous_receipt,
        registration,
        enabled,
        added_permissions,
        preview,
    })
}

pub fn command(
    catalog: &Path,
    id: &str,
    expected: Option<&str>,
    grants: Vec<Permission>,
) -> std::result::Result<(), PluginCliError> {
    let scope = crate::platform::control_pipe::RegistryScope::for_path(
        &crate::plugins::default_registry_path()?,
    )?;
    let _lease = super::offline_lease(&scope)?;
    let registry = PluginRegistry::load(scope.path())?;
    let selection = select(&registry, catalog, id)?;
    let mut result = json!({"schema":1,"pluginId":id,"preview":selection.preview,"version":selection.package.version,
        "existingVersion":selection.previous_package.as_ref().map(|p| &p.version),"existing":selection.registration.is_some(),
        "enabled":selection.enabled,"addedPermissions":selection.added_permissions,"path":selection.target,"source":"local"});
    if let Some(expected) = expected {
        if expected != selection.preview {
            return Err(error(
                "The package or registration changed after preview; review it again",
            )
            .into());
        }
        install(&registry, selection, grants)?;
        result["outcome"] = Value::from("installed");
    } else {
        result["outcome"] = Value::from("preview");
    }
    println!("{}", result);
    Ok(())
}

fn install(registry: &PluginRegistry, selected: Selection, grants: Vec<Permission>) -> Result<()> {
    let id_owned = selected.package.id.clone();
    let id = &id_owned;
    if grants.len() != selected.added_permissions.len()
        || grants
            .iter()
            .any(|p| !selected.added_permissions.contains(p))
        || grants
            .iter()
            .enumerate()
            .any(|(i, p)| grants[..i].contains(p))
    {
        return Err(error(
            "Explicitly approve exactly the previewed new permission grants",
        ));
    }
    let mut next = selected.registration.clone().unwrap_or_default();
    next.path = selected.target.clone();
    next.grants.extend(grants);
    next.broker_policy
        .validate_grants(&next.grants)
        .map_err(error)?;
    // Disabled packages may retain revoked grants. Enabling remains governed by
    // the ordinary loader; an update never restores a previously revoked grant.
    if selected.enabled {
        crate::local_plugins::load_local_plugin(id, &selected.source, &next.grants, 1)
            .map_err(error)?;
    }
    let (_, transactions) = roots(registry.path())?;
    let ready = transactions.join(format!("{id}.ready"));
    let backup = transactions.join(format!("{id}.backup"));
    let journal_path = transactions.join(format!("{id}.json"));
    for path in [&ready, &backup, &journal_path] {
        plain(path)?;
        if path.exists() {
            return Err(error("Unrecovered installer transaction"));
        }
    }
    let mut journal = Journal {
        schema: 1,
        id: id.clone(),
        previous: selected.registration,
        next,
        previous_enabled: registry.is_enabled(id),
        enabled: selected.enabled,
        previous_package: selected.previous_package,
        package: selected.package,
        previous_receipt: selected.previous_receipt,
        committed: false,
    };
    write(&journal_path, &journal)?;
    let result = (|| {
        fs::create_dir(&ready).map_err(error)?;
        for file in &journal.package.files {
            let target = ready.join(&file.path);
            fs::create_dir_all(target.parent().unwrap()).map_err(error)?;
            let data = bytes(&selected.source.join(&file.path), MAX_FILE)?;
            let mut out = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(target)
                .map_err(error)?;
            out.write_all(&data).map_err(error)?;
            out.sync_all().map_err(error)?;
        }
        verify(&ready, &journal.package)?;
        if let Some(old) = &journal.previous_package {
            verify(&selected.target, old)?;
            fs::rename(&selected.target, &backup).map_err(error)?;
            verify(&backup, old)?;
        }
        fs::rename(&ready, &selected.target).map_err(error)?;
        verify(&selected.target, &journal.package)?;
        let mut registry = PluginRegistry::load(registry.path()).map_err(error)?;
        if registration_digest(&registry, id)
            != registration_digest_for(&registry, id, &journal.previous, journal.previous_enabled)?
        {
            return Err(error("Registration changed during package installation"));
        }
        registry
            .register_local(id, journal.next.clone())
            .map_err(error)?;
        registry.set_enabled(id, journal.enabled).map_err(error)?;
        registry.save().map_err(error)?;
        write(
            &receipt_path(registry.path(), id)?,
            &Receipt {
                schema: 1,
                source: "official-installer".into(),
                package: journal.package.clone(),
            },
        )?;
        journal.committed = true;
        write(&journal_path, &journal)?;
        recover_one(registry.path(), &journal_path, journal)
    })();
    if let Err(error) = result {
        recover(registry.path())
            .map_err(|recovery| self::error(format!("{error}; recovery required: {recovery}")))?;
        return Err(error);
    }
    Ok(())
}
fn registration_digest_for(
    registry: &PluginRegistry,
    id: &str,
    registration: &Option<LocalPluginRegistration>,
    enabled: bool,
) -> Result<String> {
    let mut view = registry.clone();
    view.restore_managed(id, registration.clone(), None);
    view.set_enabled(id, enabled).map_err(error)?;
    Ok(registration_digest(&view, id))
}

/// Call only while holding the same registry scope and launch leases as Host
/// startup/offline CLI. Recovery never starts plugins or executes package code.
pub fn recover(registry_path: &Path) -> Result<()> {
    let home = registry_path
        .parent()
        .ok_or_else(|| error("Registry has no directory"))?;
    let transactions = home.join(".official-seed-transactions");
    if !transactions.exists() {
        return Ok(());
    }
    plain(&transactions)?;
    for id in IDS {
        let journal_path = transactions.join(format!("{id}.json"));
        if journal_path.exists() {
            let journal: Journal = read(&journal_path)?;
            if journal.id != id {
                return Err(error("Invalid transaction identity"));
            }
            recover_one(registry_path, &journal_path, journal)?;
        }
    }
    Ok(())
}
fn recover_one(registry_path: &Path, journal_path: &Path, journal: Journal) -> Result<()> {
    if journal.schema != 1
        || !IDS.contains(&journal.id.as_str())
        || journal.package.id != journal.id
    {
        return Err(error("Invalid installer journal"));
    }
    let (packages, transactions) = roots(registry_path)?;
    let target = packages.join(&journal.id);
    if journal.next.path != target || journal.previous.as_ref().is_some_and(|r| r.path != target) {
        return Err(error("Installer journal path escaped its owned directory"));
    }
    let ready = transactions.join(format!("{}.ready", journal.id));
    let backup = transactions.join(format!("{}.backup", journal.id));
    for path in [&target, &ready, &backup] {
        plain(path)?;
    }
    let mut registry = PluginRegistry::load(registry_path).map_err(error)?;
    let current = registration_digest(&registry, &journal.id);
    let old_digest = registration_digest_for(
        &registry,
        &journal.id,
        &journal.previous,
        journal.previous_enabled,
    )?;
    let new_digest = registration_digest_for(
        &registry,
        &journal.id,
        &Some(journal.next.clone()),
        journal.enabled,
    )?;
    if current != old_digest && current != new_digest {
        return Err(error(
            "A later source or authorization change prevents automatic recovery",
        ));
    }
    if journal.committed {
        if current != new_digest {
            return Err(error("Committed registration changed before cleanup"));
        }
        verify(&target, &journal.package)?;
        if backup.exists() {
            verify_remaining(
                &backup,
                journal
                    .previous_package
                    .as_ref()
                    .ok_or_else(|| error("Unexpected backup"))?,
            )?;
            fs::remove_dir_all(&backup).map_err(error)?;
        }
    } else {
        if backup.exists() {
            verify(
                &backup,
                journal
                    .previous_package
                    .as_ref()
                    .ok_or_else(|| error("Unexpected backup"))?,
            )?;
            if target.exists() {
                verify_remaining(&target, &journal.package)?;
                fs::remove_dir_all(&target).map_err(error)?;
            }
            fs::rename(&backup, &target).map_err(error)?;
        } else if let Some(previous) = &journal.previous_package {
            verify(&target, previous)?;
        } else if target.exists() {
            verify_remaining(&target, &journal.package)?;
            fs::remove_dir_all(&target).map_err(error)?;
        }
        registry.restore_managed(&journal.id, journal.previous.clone(), None);
        registry
            .set_enabled(&journal.id, journal.previous_enabled)
            .map_err(error)?;
        registry.save().map_err(error)?;
        let receipt = receipt_path(registry_path, &journal.id)?;
        if let Some(previous) = &journal.previous_receipt {
            write(&receipt, previous)?;
        } else if receipt.exists() {
            plain(&receipt)?;
            fs::remove_file(&receipt).map_err(error)?;
        }
    }
    if ready.exists() {
        // A crash can interrupt staging before a file has its final bytes. The
        // journal owns only these enumerated temporary paths, never author files.
        let mut files = BTreeSet::new();
        let mut dirs = BTreeSet::new();
        tree(&ready, "", &mut files, &mut dirs)?;
        if files
            .iter()
            .any(|p| !journal.package.files.iter().any(|f| &f.path == p))
            || dirs.iter().any(|p| {
                !journal
                    .package
                    .files
                    .iter()
                    .any(|f| f.path.starts_with(&(p.to_owned() + "/")))
            })
        {
            return Err(error("Unexpected file in temporary installation directory"));
        }
        fs::remove_dir_all(&ready).map_err(error)?;
    }
    fs::remove_file(journal_path).map_err(error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "codex.ui.adapter";
    struct Fixture {
        _temp: tempfile::TempDir,
        registry: PathBuf,
        catalog: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let registry = temp.path().join("data/config.json");
            let catalog = temp.path().join("bundle/catalog.json");
            fs::create_dir_all(catalog.parent().unwrap().join("packages")).unwrap();
            fs::create_dir_all(registry.parent().unwrap()).unwrap();
            Self {
                _temp: temp,
                registry,
                catalog,
            }
        }
        fn package(&self, version: &str, permissions: Vec<Permission>) -> Package {
            let source = self.catalog.parent().unwrap().join("packages").join(ID);
            fs::create_dir_all(&source).unwrap();
            fs::write(source.join("codlet.json"), serde_json::to_vec(&json!({"schema":1,"id":ID,"version":version,"renderer":{"entry":"renderer.js","world":"isolated"},"permissions":permissions})).unwrap()).unwrap();
            fs::write(
                source.join("renderer.js"),
                format!("module.exports={{activate(){{throw Error('never execute {version}')}}}};"),
            )
            .unwrap();
            let files = ["codlet.json", "renderer.js"]
                .iter()
                .map(|name| {
                    let bytes = fs::read(source.join(name)).unwrap();
                    FileRecord {
                        path: (*name).into(),
                        bytes: bytes.len() as u64,
                        sha256: format!("{:x}", Sha256::digest(bytes)),
                    }
                })
                .collect();
            let package = Package {
                id: ID.into(),
                version: version.into(),
                permissions,
                files,
            };
            write(
                &self.catalog,
                &json!({"schema":1,"kind":"codlet-official-plugin-bundle","packages":[package]}),
            )
            .unwrap();
            package
        }
        fn registry(&self) -> PluginRegistry {
            PluginRegistry::load(&self.registry).unwrap()
        }
        fn install(&self) {
            let registry = self.registry();
            let selection = select(&registry, &self.catalog, ID).unwrap();
            let grants = selection.added_permissions.clone();
            install(&registry, selection, grants).unwrap();
        }
        fn target(&self) -> PathBuf {
            roots(&self.registry).unwrap().0.join(ID)
        }
        fn assert_clean(&self) {
            let (_, tx) = roots(&self.registry).unwrap();
            for suffix in ["json", "ready", "backup"] {
                assert!(!tx.join(format!("{ID}.{suffix}")).exists());
            }
        }
    }

    #[test]
    fn official_seed_updates_in_place_preserving_disabled_revoked_grants_and_all_scopes() {
        let f = Fixture::new();
        f.package("1", vec![Permission::UiDom]);
        f.install();
        let mut registry = f.registry();
        let mut registration = registry.local_plugins()[ID].clone();
        let policy_root = f.registry.parent().unwrap().canonicalize().unwrap();
        let exe = policy_root.join("allowed.exe");
        fs::write(&exe, "not executed").unwrap();
        registration.grants = vec![
            Permission::HostFs,
            Permission::HostNetwork,
            Permission::HostFsWrite,
            Permission::HostFsWatch,
            Permission::HostProcessSpawn,
            Permission::CoreShortcuts,
        ];
        registration.broker_policy = crate::plugin_permissions::BrokerPolicy {
            read_roots: vec![policy_root.clone()],
            network_origins: vec!["https://example.com".into()],
            executables: vec![exe],
            write_roots: vec![policy_root.clone()],
            watch_roots: vec![policy_root.clone()],
            cwd_roots: vec![policy_root],
            env_keys: vec!["SELECTED".into()],
            shortcuts: vec!["Ctrl+Shift+K".into()],
        };
        registry.register_local(ID, registration.clone()).unwrap();
        registry.set_enabled(ID, false).unwrap();
        registry.save().unwrap();
        f.package("2", vec![Permission::UiDom]);
        let preview = select(&f.registry(), &f.catalog, ID).unwrap();
        assert!(preview.added_permissions.is_empty());
        f.install();
        let result = f.registry();
        assert!(!result.is_enabled(ID));
        assert_eq!(result.local_plugins()[ID], registration);
        assert_eq!(
            crate::local_plugins::inspect_local_plugin(&f.target())
                .unwrap()
                .manifest
                .version,
            "2"
        );
        assert!(result.managed_plugins().is_empty());
        f.assert_clean();
    }

    #[test]
    fn official_seed_requires_exact_new_permission_consent_and_preserves_authors() {
        let f = Fixture::new();
        f.package("1", vec![Permission::UiDom]);
        f.install();
        let old = fs::read(f.target().join("codlet.json")).unwrap();
        f.package("2", vec![Permission::UiDom, Permission::CoreEvents]);
        let selection = select(&f.registry(), &f.catalog, ID).unwrap();
        assert_eq!(selection.added_permissions, vec![Permission::CoreEvents]);
        assert!(install(&f.registry(), selection, vec![]).is_err());
        assert_eq!(fs::read(f.target().join("codlet.json")).unwrap(), old);
        f.install();
        assert_eq!(
            f.registry().local_plugins()[ID].grants,
            vec![Permission::UiDom, Permission::CoreEvents]
        );
        f.assert_clean();
        fs::write(f.target().join("author-note.txt"), "keep me").unwrap();
        f.package("3", vec![Permission::UiDom, Permission::CoreEvents]);
        assert_eq!(
            select(&f.registry(), &f.catalog, ID).err().unwrap().code,
            "official_seed_source_changed"
        );
        assert_eq!(
            fs::read_to_string(f.target().join("author-note.txt")).unwrap(),
            "keep me"
        );
    }

    #[test]
    fn official_seed_adopts_legacy_only_with_exact_known_revision_and_file_set() {
        let f = Fixture::new();
        let old = f.package("1", vec![Permission::UiDom]);
        f.install();
        fs::remove_file(receipt_path(&f.registry, ID).unwrap()).unwrap();
        let new = f.package("2", vec![Permission::UiDom]);
        assert!(select(&f.registry(), &f.catalog, ID).is_err());
        let mut legacy = serde_json::to_value(&old).unwrap();
        legacy["sourceRevision"] = json!("a".repeat(40));
        write(&f.catalog,&json!({"schema":1,"kind":"codlet-official-plugin-bundle","packages":[new],"legacyPackages":[legacy]})).unwrap();
        let legacy: LegacyPackage = serde_json::from_value(legacy).unwrap();
        let selection = select_with_legacy(&f.registry(), &f.catalog, ID, &[legacy]).unwrap();
        let grants = selection.added_permissions.clone();
        install(&f.registry(), selection, grants).unwrap();
        f.assert_clean();
        assert_eq!(
            crate::local_plugins::inspect_local_plugin(&f.target())
                .unwrap()
                .manifest
                .version,
            "2"
        );
    }

    #[test]
    fn official_seed_recovers_every_publish_boundary_without_retaining_old_packages() {
        for boundary in 0..8 {
            let f = Fixture::new();
            f.package("1", vec![Permission::UiDom]);
            f.install();
            f.package("2", vec![Permission::UiDom, Permission::CoreEvents]);
            let previous = f.registry();
            let selected = select(&previous, &f.catalog, ID).unwrap();
            let mut next = selected.registration.clone().unwrap();
            next.grants.push(Permission::CoreEvents);
            let journal = Journal {
                schema: 1,
                id: ID.into(),
                previous: selected.registration,
                next: next.clone(),
                previous_enabled: true,
                enabled: true,
                previous_package: selected.previous_package,
                package: selected.package.clone(),
                previous_receipt: selected.previous_receipt,
                committed: boundary >= 6,
            };
            let (_, tx) = roots(&f.registry).unwrap();
            let ready = tx.join(format!("{ID}.ready"));
            let backup = tx.join(format!("{ID}.backup"));
            write(&tx.join(format!("{ID}.json")), &journal).unwrap();
            fs::create_dir(&ready).unwrap();
            if boundary == 0 {
                fs::write(ready.join("codlet.json"), "partial staged bytes").unwrap();
            } else {
                for file in &journal.package.files {
                    fs::copy(selected.source.join(&file.path), ready.join(&file.path)).unwrap();
                }
            }
            if boundary >= 2 {
                fs::rename(f.target(), &backup).unwrap();
            }
            if boundary >= 3 {
                fs::rename(&ready, f.target()).unwrap();
            }
            if boundary >= 4 {
                let mut registry = f.registry();
                registry.register_local(ID, next.clone()).unwrap();
                registry.save().unwrap();
            }
            if boundary >= 5 {
                write(
                    &receipt_path(&f.registry, ID).unwrap(),
                    &Receipt {
                        schema: 1,
                        source: "official-installer".into(),
                        package: journal.package,
                    },
                )
                .unwrap();
            }
            if boundary == 7 {
                fs::remove_file(backup.join("renderer.js")).unwrap();
            }
            recover(&f.registry).unwrap();
            recover(&f.registry).unwrap();
            let expected = if boundary >= 6 { "2" } else { "1" };
            assert_eq!(
                crate::local_plugins::inspect_local_plugin(&f.target())
                    .unwrap()
                    .manifest
                    .version,
                expected,
                "boundary {boundary}"
            );
            assert_eq!(
                f.registry().local_plugins()[ID],
                if boundary >= 6 {
                    next
                } else {
                    previous.local_plugins()[ID].clone()
                }
            );
            f.assert_clean();
        }
    }

    #[test]
    fn official_seed_rejects_modified_or_redirected_receipt_and_journal_paths() {
        let f = Fixture::new();
        f.package("1", vec![Permission::UiDom]);
        f.install();
        let old = f.registry();
        f.package("2", vec![Permission::UiDom]);
        let selected = select(&old, &f.catalog, ID).unwrap();
        let mut next = selected.registration.clone().unwrap();
        next.path = f.registry.parent().unwrap().join("author");
        let journal = Journal {
            schema: 1,
            id: ID.into(),
            previous: selected.registration,
            next,
            previous_enabled: true,
            enabled: true,
            previous_package: selected.previous_package,
            package: selected.package,
            previous_receipt: selected.previous_receipt,
            committed: false,
        };
        let (_, tx) = roots(&f.registry).unwrap();
        write(&tx.join(format!("{ID}.json")), &journal).unwrap();
        assert!(recover(&f.registry).is_err());
        assert_eq!(f.registry().local_plugins()[ID], old.local_plugins()[ID]);
        assert_eq!(
            crate::local_plugins::inspect_local_plugin(&f.target())
                .unwrap()
                .manifest
                .version,
            "1"
        );
    }
}
