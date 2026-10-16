//! Shared installation directories for downloaded packages and folder copies.
use crate::github_distribution as github;
use crate::plugin_control::PluginControlError;
use crate::plugins::{PluginManifest, PluginRegistry};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};

type Result<T> = std::result::Result<T, PluginControlError>;
const RECEIPT: &str = ".codlet-folder-install.json";
fn issue(e: impl std::fmt::Display) -> PluginControlError {
    PluginControlError::new("installation_files", e.to_string())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Origin {
    path: PathBuf,
    identity: Option<String>,
    tree: String,
    preview_digest: String,
    #[serde(default)]
    acknowledged: bool,
    #[serde(default)]
    deleted: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    schema: u32,
    id: String,
    tree: String,
    origin: Option<Origin>,
}
pub(crate) struct Package {
    pub package_path: PathBuf,
    pub source: Option<github::GitHubSource>,
    pub manifest: PluginManifest,
}

pub(crate) fn root(registry: &Path) -> Result<PathBuf> {
    Ok(github::managed_root(registry, true)
        .map_err(issue)?
        .parent()
        .unwrap()
        .into())
}
pub(crate) fn is_owned(registry: &Path, path: &Path) -> bool {
    let Some(name) = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| crate::plugins::valid_plugin_id(name))
    else {
        return false;
    };
    root(registry).is_ok_and(|root| path.parent() == Some(root.as_path())) && name != "github"
        || github::managed_root(registry, false)
            .is_ok_and(|root| path.parent() == Some(root.as_path()))
}
fn checked_path(registry: &Path, path: &Path) -> Result<()> {
    let staging = github::staging_root(registry).map_err(issue)?;
    if !is_owned(registry, path) && path.parent() != Some(staging.as_path()) {
        return Err(issue("Package is outside the installation directory"));
    }
    github::check_regular(path, true).map_err(issue)?;
    if path.canonicalize().map_err(issue)? != path {
        return Err(issue("Installation directory redirects"));
    }
    Ok(())
}
fn receipt(path: &Path) -> Result<Receipt> {
    let file = path.join(RECEIPT);
    let metadata = github::check_regular(&file, false).map_err(issue)?;
    if metadata.len() > 32 * 1024 {
        return Err(issue("Installation receipt is too large"));
    }
    let receipt: Receipt =
        serde_json::from_slice(&std::fs::read(file).map_err(issue)?).map_err(issue)?;
    if receipt.schema != 1 || !crate::plugins::valid_plugin_id(&receipt.id) {
        return Err(issue("Invalid installation receipt"));
    }
    Ok(receipt)
}
pub(crate) fn inspect(registry: &Path, path: &Path) -> Result<Package> {
    checked_path(registry, path)?;
    if path.join(RECEIPT).exists() {
        let receipt = receipt(path)?;
        let candidate = crate::local_plugins::inspect_local_plugin(path).map_err(issue)?;
        if receipt.id != candidate.manifest.id
            || (!is_owned(registry, path) && receipt.tree != tree_digest(path)?)
        {
            return Err(issue("Installed folder contents changed"));
        }
        if is_owned(registry, path)
            && path.file_name().and_then(|n| n.to_str()) != Some(&receipt.id)
        {
            return Err(issue("Installation directory does not match its plugin ID"));
        }
        Ok(Package {
            package_path: path.into(),
            source: None,
            manifest: candidate.manifest,
        })
    } else {
        let package = github::inspect_prepared_package(registry, path).map_err(issue)?;
        Ok(Package {
            package_path: package.package_path,
            source: Some(package.source),
            manifest: package.manifest,
        })
    }
}

/// Hash every file and directory, including assets and empty directories. The
/// receipt is Core metadata, excluded from the copied author tree.
pub(crate) fn tree_digest(root: &Path) -> Result<String> {
    let mut pending = vec![PathBuf::new()];
    let mut entries = Vec::new();
    let mut total = 0u64;
    while let Some(relative) = pending.pop() {
        github::check_regular(&root.join(&relative), true).map_err(issue)?;
        for entry in std::fs::read_dir(root.join(&relative)).map_err(issue)? {
            let entry = entry.map_err(issue)?;
            let relative = relative.join(entry.file_name());
            if relative == Path::new(RECEIPT) {
                continue;
            }
            let directory = entry.file_type().map_err(issue)?.is_dir();
            let metadata = github::check_regular(&entry.path(), directory).map_err(issue)?;
            total = total
                .checked_add(metadata.len())
                .ok_or_else(|| issue("Folder size overflow"))?;
            if total > 1024 * 1024 * 1024 || entries.len() >= 100_000 {
                return Err(issue("Plugin folder exceeds 1 GiB or 100,000 entries"));
            }
            let name = relative
                .to_str()
                .ok_or_else(|| issue("Plugin path must be UTF-8"))?
                .replace('\\', "/");
            entries.push((name, directory, entry.path()));
            if directory {
                pending.push(relative);
            }
        }
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    for (name, directory, path) in entries {
        digest.update([u8::from(directory)]);
        digest.update((name.len() as u64).to_le_bytes());
        digest.update(name.as_bytes());
        if !directory {
            let before = github::check_regular(&path, false).map_err(issue)?;
            digest.update(before.len().to_le_bytes());
            let mut file = std::fs::File::open(&path).map_err(issue)?;
            let mut bytes = 0u64;
            loop {
                let count = file.read(&mut buffer).map_err(issue)?;
                if count == 0 {
                    break;
                }
                bytes += count as u64;
                if bytes > before.len() {
                    return Err(issue("Folder changed during inspection"));
                }
                digest.update(&buffer[..count]);
            }
            let after = github::check_regular(&path, false).map_err(issue)?;
            if bytes != before.len()
                || after.len() != before.len()
                || after.modified().ok() != before.modified().ok()
            {
                return Err(issue("Folder changed during inspection"));
            }
        }
    }
    Ok(format!("{:x}", digest.finalize()))
}
fn copy_tree(source: &Path, target: &Path) -> Result<()> {
    let mut pending = vec![PathBuf::new()];
    let mut count = 0usize;
    let mut bytes = 0u64;
    while let Some(relative) = pending.pop() {
        github::check_regular(&source.join(&relative), true).map_err(issue)?;
        for entry in std::fs::read_dir(source.join(&relative)).map_err(issue)? {
            let entry = entry.map_err(issue)?;
            let child = relative.join(entry.file_name());
            if child == Path::new(RECEIPT) {
                continue;
            }
            let directory = entry.file_type().map_err(issue)?.is_dir();
            let metadata = github::check_regular(&entry.path(), directory).map_err(issue)?;
            count += 1;
            bytes = bytes
                .checked_add(metadata.len())
                .ok_or_else(|| issue("Folder size overflow"))?;
            if count > 100_000 || bytes > 1024 * 1024 * 1024 {
                return Err(issue("Plugin folder exceeds 1 GiB or 100,000 entries"));
            }
            if directory {
                std::fs::create_dir(target.join(&child)).map_err(issue)?;
                pending.push(child);
            } else {
                std::fs::copy(entry.path(), target.join(child)).map_err(issue)?;
            }
        }
    }
    Ok(())
}
pub(crate) fn prepare_folder(
    registry: &Path,
    source: &Path,
    id: &str,
    digest: &str,
    tree: &str,
) -> Result<PathBuf> {
    let staging = github::staging_root(registry).map_err(issue)?;
    if staging.starts_with(source) {
        return Err(issue(
            "The source folder contains Codlet's installation directory",
        ));
    }
    let target = tempfile::Builder::new()
        .prefix("folder-")
        .tempdir_in(staging)
        .map_err(issue)?;
    copy_tree(source, target.path())?;
    if tree_digest(source)? != tree || tree_digest(target.path())? != tree {
        return Err(issue("Source folder changed while copying"));
    }
    let origin = Origin {
        path: source.into(),
        identity: crate::source_removal::directory_identity(source).ok(),
        tree: tree.into(),
        preview_digest: digest.into(),
        acknowledged: false,
        deleted: false,
    };
    let receipt = Receipt {
        schema: 1,
        id: id.into(),
        tree: tree.into(),
        origin: Some(origin),
    };
    std::fs::write(
        target.path().join(RECEIPT),
        serde_json::to_vec(&receipt).map_err(issue)?,
    )
    .map_err(issue)?;
    Ok(target.keep())
}
pub(crate) fn clone_package(registry: &Path, source: &Path) -> Result<Package> {
    let package = inspect(registry, source)?;
    if package.source.is_some() {
        let copy = github::clone_prepared_package(registry, source).map_err(issue)?;
        return inspect(registry, &copy.package_path);
    }
    let target = tempfile::Builder::new()
        .prefix("ready-")
        .tempdir_in(github::staging_root(registry).map_err(issue)?)
        .map_err(issue)?;
    let receipt = receipt(source)?;
    copy_tree(source, target.path())?;
    if tree_digest(target.path())? != receipt.tree {
        return Err(issue("Folder changed while copying"));
    }
    std::fs::write(
        target.path().join(RECEIPT),
        serde_json::to_vec(&receipt).map_err(issue)?,
    )
    .map_err(issue)?;
    let path = target.keep();
    inspect(registry, &path)
}
pub(crate) fn relocate(registry: &Path, source: &Path, target: &Path) -> Result<()> {
    let package = inspect(registry, source)?;
    if package.source.is_some() {
        return github::relocate_prepared_package(registry, source, target).map_err(issue);
    }
    if target != root(registry)?.join(&package.manifest.id)
        && target.parent() != Some(github::staging_root(registry).map_err(issue)?.as_path())
    {
        return Err(issue("Invalid installation destination"));
    }
    if target.exists() {
        return Err(issue("Installation destination already exists"));
    }
    std::fs::rename(source, target).map_err(issue)
}
pub(crate) fn remove(registry: &Path, path: &Path) -> Result<()> {
    checked_path(registry, path)?;
    crate::source_removal::remove_owned_directory(path)
}
pub(crate) fn discard_folder_stage(candidate: &PluginRegistry, id: &str) -> Result<()> {
    let Some(selected) = candidate.local_plugins().get(id) else {
        return Ok(());
    };
    let path = &selected.path;
    if path.parent()
        != Some(
            github::staging_root(candidate.path())
                .map_err(issue)?
                .as_path(),
        )
        || !path.join(RECEIPT).exists()
    {
        return Ok(());
    }
    let current = PluginRegistry::load(candidate.path()).map_err(issue)?;
    if current.local_plugins().values().any(|registration| {
        registration.path.starts_with(path) || path.starts_with(&registration.path)
    }) {
        return Ok(());
    }
    if inspect(candidate.path(), path)?.manifest.id != id {
        return Err(issue("Staged copy belongs to a different plugin"));
    }
    remove(candidate.path(), path)
}
pub(crate) fn relocate_previous(
    registry: &Path,
    id: &str,
    source: &Path,
    target: &Path,
) -> Result<()> {
    checked_path(registry, source)?;
    if target != root(registry)?.join(id)
        && target.parent() != Some(github::staging_root(registry).map_err(issue)?.as_path())
    {
        return Err(issue("Invalid previous installation destination"));
    }
    if target.exists() {
        return Err(issue("Previous installation destination exists"));
    }
    std::fs::rename(source, target).map_err(issue)
}

pub(crate) fn registration_at_path(
    registry: &PluginRegistry,
    id: &str,
    target: &Path,
) -> Result<PluginRegistry> {
    if registry
        .managed_plugins()
        .get(id)
        .and_then(crate::managed_plugins::ManagedPluginRecord::current)
        .is_some()
    {
        return crate::managed_plugins::registration_at_path(registry, id, target);
    }
    let checked = inspect(registry.path(), target)?;
    if checked.manifest.id != id {
        return Err(issue("Installed plugin ID differs"));
    }
    let mut registration = registry
        .local_plugins()
        .get(id)
        .ok_or_else(|| issue("Registration missing"))?
        .clone();
    registration.path = target.into();
    let mut next = registry.clone();
    next.restore_managed(id, Some(registration), None);
    Ok(next)
}
pub(crate) fn at_path(
    registry: &PluginRegistry,
    id: &str,
    target: &Path,
) -> Result<(PluginRegistry, crate::catalog::PluginCatalogEntry)> {
    if registry
        .managed_plugins()
        .get(id)
        .and_then(crate::managed_plugins::ManagedPluginRecord::current)
        .is_some()
    {
        return crate::managed_plugins::at_installation_path(registry, id, target);
    }
    let next = registration_at_path(registry, id, target)?;
    let candidate = crate::local_plugins::inspect_local_plugin(target).map_err(issue)?;
    let registration = &next.local_plugins()[id];
    let request = crate::local_import::LocalImportRequest {
        path: target.into(),
        content_digest: String::new(),
        registration_digest: String::new(),
        trusted: true,
        grants: registration.grants.clone(),
        broker_policy: registration.broker_policy.clone(),
        enable: next.is_enabled(id),
        managed: None,
        mode: None,
    };
    let entry = crate::local_import::checked_entry(candidate, &request)?;
    Ok((next, entry))
}
#[cfg(test)]
pub(crate) fn delete_import_source(
    registry: &PluginRegistry,
    id: &str,
    preview_digest: &str,
) -> Result<()> {
    complete_import(registry, id, preview_digest, true)
}

fn is_committed(registry: &Path, id: &str) -> Result<bool> {
    let transactions = github::managed_root(registry, false)
        .map_err(issue)?
        .join(".transactions");
    Ok(!transactions.join(format!("{id}.json")).exists()
        && !transactions.join(format!("{id}.pending")).exists())
}

pub(crate) fn pending_import(registry: &PluginRegistry, id: &str) -> Option<serde_json::Value> {
    if !crate::plugins::valid_plugin_id(id) || !is_committed(registry.path(), id).ok()? {
        return None;
    }
    let path = &registry.local_plugins().get(id)?.path;
    checked_path(registry.path(), path).ok()?;
    let receipt = receipt(path).ok()?;
    if receipt.id != id {
        return None;
    }
    let origin = receipt.origin.filter(|origin| !origin.acknowledged)?;
    Some(serde_json::json!({"path":origin.path,"contentDigest":origin.preview_digest}))
}

pub(crate) fn complete_import(
    registry: &PluginRegistry,
    id: &str,
    preview_digest: &str,
    delete_source: bool,
) -> Result<()> {
    if !crate::plugins::valid_plugin_id(id) {
        return Err(issue("Invalid plugin ID"));
    }
    if !is_committed(registry.path(), id)? {
        return Err(issue("Installation has not completed"));
    }
    let path = &registry
        .local_plugins()
        .get(id)
        .ok_or_else(|| issue("Installed plugin missing"))?
        .path;
    checked_path(registry.path(), path)?;
    let mut receipt = receipt(path)?;
    if receipt.id != id {
        return Err(issue("Installation identity changed"));
    }
    let origin = receipt
        .origin
        .as_mut()
        .ok_or_else(|| issue("Installation has no folder source"))?;
    if origin.preview_digest != preview_digest {
        return Err(issue("Source deletion does not match the completed import"));
    }
    if delete_source && !origin.deleted {
        if origin.path == *path || is_owned(registry.path(), &origin.path) {
            return Err(issue(
                "The installed copy cannot be deleted as an import source",
            ));
        }
        if origin.path.exists() {
            inspect(registry.path(), path)?;
            if tree_digest(&origin.path)? != origin.tree {
                return Err(issue(
                    "Source files changed after installation; the folder was preserved",
                ));
            }
            crate::source_removal::delete_import_source(
                registry,
                &origin.path,
                origin
                    .identity
                    .as_deref()
                    .ok_or_else(|| issue("Source directory identity unavailable"))?,
            )?;
        }
        origin.deleted = true;
    }
    origin.acknowledged = true;
    use std::io::Write;
    let mut file = tempfile::NamedTempFile::new_in(path).map_err(issue)?;
    file.write_all(&serde_json::to_vec(&receipt).map_err(issue)?)
        .map_err(issue)?;
    file.as_file().sync_all().map_err(issue)?;
    file.persist(path.join(RECEIPT)).map_err(issue)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_import::{self, InstallMode};
    use crate::plugin_permissions::BrokerPolicy;
    use crate::plugin_services::{PluginServices, ServiceOwner};
    use serde_json::{Value, json};
    const ID: &str = "dev.install-lifecycle";

    fn fixture() -> (tempfile::TempDir, PluginRegistry, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        std::fs::create_dir(&data).unwrap();
        let mut registry = PluginRegistry::load(data.join("config.json")).unwrap();
        registry.set_enabled("dev.other", false).unwrap();
        registry.save().unwrap();
        let source = temp.path().join("author");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(source.join("assets")).unwrap();
        std::fs::create_dir(source.join("empty")).unwrap();
        std::fs::write(source.join("assets/picture.txt"), "asset contents").unwrap();
        std::fs::write(source.join("codlet.json"), json!({"schema":1,"id":ID,"version":"1","renderer":{"entry":"entry.js","world":"isolated"}}).to_string()).unwrap();
        std::fs::write(source.join("entry.js"), "module.exports={activate(){}};").unwrap();
        (temp, registry, source)
    }
    fn publish(
        registry: &PluginRegistry,
        source: &Path,
        mode: Option<InstallMode>,
    ) -> (crate::managed_storage::Installation, PluginRegistry, String) {
        let preview = local_import::preview(registry, source).unwrap();
        let mut request = preview.request(vec![], BrokerPolicy::default(), false);
        request.mode = mode;
        let (staged, _) = local_import::stage(registry, ID, &request).unwrap();
        let (installation, next, _) = crate::managed_storage::Installation::publish_with_reset(
            &staged,
            registry,
            ID,
            false,
            request.resets_data(registry, ID),
        )
        .unwrap();
        (installation, next, preview.content_digest)
    }
    fn owner(source: &str) -> ServiceOwner {
        ServiceOwner {
            plugin_id: ID.into(),
            source_identity: source.into(),
        }
    }
    fn write_data(registry: &PluginRegistry, text: &str) {
        PluginServices::new(registry.path())
            .unwrap()
            .invoke_storage(
                &owner("local:old-path"),
                "transaction",
                json!({"expectedRevision":0,"config":{"note":text}}),
            )
            .unwrap();
    }
    fn snapshot(registry: &PluginRegistry) -> Value {
        PluginServices::new(registry.path())
            .unwrap()
            .invoke_storage(&owner("local:new-path"), "snapshot", Value::Null)
            .unwrap()
    }
    #[test]
    fn folder_install_copies_assets_and_clears_orphan_data() {
        let (_temp, registry, source) = fixture();
        write_data(&registry, "orphan");
        let (mut installation, next, _) = publish(&registry, &source, None);
        installation.commit().unwrap();
        drop(installation);
        let target = &next.local_plugins()[ID].path;
        assert_eq!(*target, root(registry.path()).unwrap().join(ID));
        assert_eq!(
            std::fs::read_to_string(target.join("assets/picture.txt")).unwrap(),
            "asset contents"
        );
        assert!(target.join("empty").is_dir());
        assert!(source.join("entry.js").exists());
        assert_eq!(snapshot(&next)["revision"], 0);
    }
    #[test]
    fn update_keeps_data_across_source_paths_replace_starts_empty_and_rollback_restores() {
        let (temp, registry, source) = fixture();
        let (mut install, next, _) = publish(&registry, &source, None);
        install.commit().unwrap();
        drop(install);
        write_data(&next, "keep me");
        let other = temp.path().join("other-author");
        std::fs::create_dir(&other).unwrap();
        copy_tree(&source, &other).unwrap();
        let (mut update, next, _) = publish(&next, &other, Some(InstallMode::Update));
        update.commit().unwrap();
        drop(update);
        assert_eq!(snapshot(&next)["config"]["note"], "keep me");
        let (mut replace, candidate, _) = publish(&next, &source, Some(InstallMode::Replace));
        assert_eq!(snapshot(&candidate)["revision"], 0);
        write_data(&candidate, "candidate");
        let restored = replace.rollback().unwrap();
        drop(replace);
        assert_eq!(snapshot(&restored)["config"]["note"], "keep me");
        let (mut replace, candidate, _) = publish(&restored, &source, Some(InstallMode::Replace));
        replace.commit().unwrap();
        drop(replace);
        assert_eq!(snapshot(&candidate)["revision"], 0);
    }
    #[test]
    fn interrupted_replacement_recovers_old_data_and_code_before_startup() {
        let (_temp, registry, source) = fixture();
        let (mut install, mut registry, _) = publish(&registry, &source, None);
        install.commit().unwrap();
        drop(install);
        write_data(&registry, "before crash");
        std::fs::write(
            source.join("entry.js"),
            "module.exports={activate(){throw Error('new')}};",
        )
        .unwrap();
        let (installation, candidate, _) = publish(&registry, &source, Some(InstallMode::Replace));
        write_data(&candidate, "after swap");
        drop(installation);
        crate::managed_storage::prepare_installations(&mut registry).unwrap();
        assert_eq!(snapshot(&registry)["config"]["note"], "before crash");
        assert_eq!(
            std::fs::read_to_string(registry.local_plugins()[ID].path.join("entry.js")).unwrap(),
            "module.exports={activate(){}};"
        );
    }
    #[test]
    fn uninstall_removes_installed_copy_preferences_and_data_then_reinstall_is_fresh() {
        let (_temp, registry, source) = fixture();
        let (mut install, mut registry, _) = publish(&registry, &source, None);
        install.commit().unwrap();
        drop(install);
        write_data(&registry, "old");
        let installed = registry.local_plugins()[ID].path.clone();
        crate::plugin_uninstall::prepare(&registry, ID).unwrap();
        registry.forget_plugin(ID).unwrap();
        registry.save().unwrap();
        crate::plugin_uninstall::finish(registry.path(), ID).unwrap();
        assert!(!installed.exists());
        assert!(source.exists());
        let document: Value =
            serde_json::from_slice(&std::fs::read(registry.path()).unwrap()).unwrap();
        assert!(document["plugins"].get(ID).is_none());
        assert!(document["localPlugins"].get(ID).is_none());
        let (mut reinstall, registry, _) = publish(&registry, &source, None);
        reinstall.commit().unwrap();
        drop(reinstall);
        assert_eq!(snapshot(&registry)["revision"], 0);
    }
    #[test]
    fn rollback_from_a_missing_old_installation_restores_data_and_allows_another_attempt() {
        let (_temp, registry, source) = fixture();
        let (mut install, registry, _) = publish(&registry, &source, None);
        install.commit().unwrap();
        drop(install);
        write_data(&registry, "previous data");
        let target = registry.local_plugins()[ID].path.clone();
        crate::source_removal::remove_owned_directory(&target).unwrap();
        let (mut replacement, _, _) = publish(&registry, &source, Some(InstallMode::Replace));
        let restored = replacement.rollback().unwrap();
        drop(replacement);
        assert!(!target.exists());
        assert_eq!(snapshot(&restored)["config"]["note"], "previous data");
        let (mut retry, installed, _) = publish(&restored, &source, Some(InstallMode::Update));
        retry.commit().unwrap();
        drop(retry);
        assert!(target.exists());
        assert_eq!(snapshot(&installed)["config"]["note"], "previous data");
    }

    #[test]
    fn uninstall_preserves_a_directory_swapped_after_the_selected_installation_retired() {
        let (_temp, registry, source) = fixture();
        let (mut install, mut registry, _) = publish(&registry, &source, None);
        install.commit().unwrap();
        drop(install);
        let target = registry.local_plugins()[ID].path.clone();
        crate::plugin_uninstall::prepare(&registry, ID).unwrap();
        registry.forget_plugin(ID).unwrap();
        registry.save().unwrap();
        let moved = target.with_file_name("previous-installation");
        std::fs::rename(&target, &moved).unwrap();
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("unrelated.txt"), "keep").unwrap();
        assert!(crate::plugin_uninstall::finish(registry.path(), ID).is_err());
        assert_eq!(
            std::fs::read_to_string(target.join("unrelated.txt")).unwrap(),
            "keep"
        );
        assert!(moved.join("entry.js").exists());
        assert!(!is_owned(
            registry.path(),
            &root(registry.path()).unwrap().join("github")
        ));
    }

    #[test]
    fn failed_uninstall_cleanup_can_retry_after_registration_has_been_removed() {
        let (_temp, registry, source) = fixture();
        let (mut install, mut registry, _) = publish(&registry, &source, None);
        install.commit().unwrap();
        drop(install);
        write_data(&registry, "old");
        let mut services_path = registry.path().as_os_str().to_owned();
        services_path.push(".plugin-services");
        let owner = PathBuf::from(services_path)
            .join("plugins")
            .join(ID)
            .join("owner.json");
        let original = std::fs::read(&owner).unwrap();
        std::fs::write(&owner, "corrupt").unwrap();
        crate::plugin_uninstall::prepare(&registry, ID).unwrap();
        registry.forget_plugin(ID).unwrap();
        registry.save().unwrap();
        assert!(crate::plugin_uninstall::finish(registry.path(), ID).is_err());
        assert!(crate::plugin_uninstall::ensure_installation_ready(&registry, ID).is_err());
        std::fs::write(owner, original).unwrap();
        crate::plugin_uninstall::prepare(&registry, ID).unwrap();
        crate::plugin_uninstall::finish(registry.path(), ID).unwrap();
        assert!(!crate::plugin_uninstall::pending(registry.path(), ID).unwrap());
        assert!(!root(registry.path()).unwrap().join(ID).exists());
    }

    #[test]
    fn acknowledging_a_completed_import_can_keep_the_original_folder() {
        let (_temp, registry, source) = fixture();
        let (mut install, registry, digest) = publish(&registry, &source, None);
        install.commit().unwrap();
        drop(install);
        assert!(pending_import(&registry, ID).is_some());
        complete_import(&registry, ID, &digest, false).unwrap();
        assert!(source.exists());
        assert!(pending_import(&registry, ID).is_none());
    }

    #[test]
    fn source_deletion_requires_committed_install_and_unchanged_whole_folder() {
        let (_temp, registry, source) = fixture();
        let (mut install, registry, digest) = publish(&registry, &source, None);
        assert!(delete_import_source(&registry, ID, &digest).is_err());
        install.commit().unwrap();
        drop(install);
        std::fs::write(source.join("assets/picture.txt"), "changed").unwrap();
        assert!(delete_import_source(&registry, ID, &digest).is_err());
        assert!(source.exists());
        std::fs::write(source.join("assets/picture.txt"), "asset contents").unwrap();
        delete_import_source(&registry, ID, &digest).unwrap();
        assert!(!source.exists());
        assert!(registry.local_plugins()[ID].path.join("entry.js").exists());
    }
}
