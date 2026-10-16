//! Durable uninstall cleanup, retried by the next exclusive Core owner.
use crate::plugin_control::PluginControlError;
use crate::plugins::PluginRegistry;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
type Result<T> = std::result::Result<T, PluginControlError>;
fn issue(e: impl std::fmt::Display) -> PluginControlError {
    PluginControlError::new("uninstall_cleanup", e.to_string())
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Plan {
    schema: u32,
    id: String,
    previous: String,
    paths: Vec<OwnedDirectory>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnedDirectory {
    path: PathBuf,
    identity: String,
}
fn directory(registry: &Path) -> Result<PathBuf> {
    let root = crate::installation_files::root(registry)?.join(".uninstall");
    if !root.exists() {
        std::fs::create_dir(&root).map_err(issue)?;
    }
    crate::github_distribution::check_regular(&root, true).map_err(issue)?;
    if root.canonicalize().map_err(issue)? != root {
        return Err(issue("Uninstall directory redirects"));
    }
    Ok(root)
}
fn existing_journal(registry: &Path, id: &str) -> Result<Option<PathBuf>> {
    if !crate::plugins::valid_plugin_id(id) {
        return Err(issue("Invalid plugin ID"));
    }
    let Some(parent) = registry.parent() else {
        return Err(issue("Registry has no parent"));
    };
    if !parent.exists() {
        return Ok(None);
    }
    let root = parent
        .canonicalize()
        .map_err(issue)?
        .join("packages")
        .join(".uninstall");
    let path = root.join(format!("{id}.json"));
    if !path.exists() {
        return Ok(None);
    }
    for directory in [root.parent().unwrap(), root.as_path()] {
        crate::github_distribution::check_regular(directory, true).map_err(issue)?;
        if directory.canonicalize().map_err(issue)? != directory {
            return Err(issue("Uninstall directory redirects"));
        }
    }
    Ok(Some(path))
}
pub(crate) fn prepare(registry: &PluginRegistry, id: &str) -> Result<()> {
    if !crate::plugins::valid_plugin_id(id) {
        return Err(issue("Invalid plugin ID"));
    }
    let path = directory(registry.path())?.join(format!("{id}.json"));
    if path.exists() {
        let metadata = crate::github_distribution::check_regular(&path, false).map_err(issue)?;
        if metadata.len() > crate::plugins::MAX_REGISTRY_BYTES as u64 {
            return Err(issue("Uninstall record exceeds its limit"));
        }
        let previous: Plan =
            serde_json::from_slice(&std::fs::read(&path).map_err(issue)?).map_err(issue)?;
        if previous.schema != 1
            || previous.id != id
            || registry.local_plugins().contains_key(id)
                && previous.previous != crate::local_import::registration_digest(registry, id)
        {
            return Err(issue(
                "An uninstall record belongs to a different registration",
            ));
        }
        return Ok(());
    }
    let mut paths = registry
        .local_plugins()
        .get(id)
        .into_iter()
        .map(|r| r.path.clone())
        .chain(
            registry
                .managed_plugins()
                .get(id)
                .into_iter()
                .flat_map(|r| r.history.iter().map(|v| v.package_path.clone())),
        )
        .filter(|path| crate::installation_files::is_owned(registry.path(), path))
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    let paths = paths
        .into_iter()
        .filter(|path| path.exists())
        .map(|path| {
            let identity = crate::source_removal::directory_identity(&path)?;
            Ok(OwnedDirectory { path, identity })
        })
        .collect::<Result<Vec<_>>>()?;
    let original = PluginRegistry::load(registry.path()).map_err(issue)?;
    let plan = Plan {
        schema: 1,
        id: id.into(),
        previous: crate::local_import::registration_digest(&original, id),
        paths,
    };
    use std::io::Write;
    let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(issue)?;
    file.write_all(&serde_json::to_vec(&plan).map_err(issue)?)
        .map_err(issue)?;
    file.as_file().sync_all().map_err(issue)?;
    file.persist_noclobber(path).map_err(issue)?;
    Ok(())
}
pub(crate) fn pending(registry: &Path, id: &str) -> Result<bool> {
    Ok(existing_journal(registry, id)?.is_some())
}
pub(crate) fn ensure_installation_ready(registry: &PluginRegistry, id: &str) -> Result<()> {
    if pending(registry.path(), id)? {
        if registry.local_plugins().contains_key(id) {
            finish(registry.path(), id)?;
        } else {
            return Err(issue(
                "The previous uninstall has unfinished cleanup. Retry uninstall before installing this ID.",
            ));
        }
    }
    Ok(())
}
pub(crate) fn finish(registry_path: &Path, id: &str) -> Result<()> {
    if !crate::plugins::valid_plugin_id(id) {
        return Err(issue("Invalid plugin ID"));
    }
    let Some(path) = existing_journal(registry_path, id)? else {
        return Ok(());
    };
    let metadata = crate::github_distribution::check_regular(&path, false).map_err(issue)?;
    if metadata.len() > crate::plugins::MAX_REGISTRY_BYTES as u64 {
        return Err(issue("Uninstall record exceeds its limit"));
    }
    let plan: Plan =
        serde_json::from_slice(&std::fs::read(&path).map_err(issue)?).map_err(issue)?;
    if plan.schema != 1 || plan.id != id {
        return Err(issue("Uninstall record identity mismatch"));
    }
    let registry = PluginRegistry::load(registry_path).map_err(issue)?;
    if registry.local_plugins().contains_key(id) {
        if crate::local_import::registration_digest(&registry, id) == plan.previous {
            std::fs::remove_file(path).map_err(issue)?;
            return Ok(());
        }
        return Err(issue("A later registration prevents uninstall cleanup"));
    }
    crate::plugin_services::purge_plugin(registry_path, id).map_err(issue)?;
    crate::plugin_cli::official_seed::forget_receipt(registry_path, id)?;
    for installed in plan.paths {
        if !crate::installation_files::is_owned(registry_path, &installed.path)
            || registry
                .local_plugins()
                .values()
                .any(|r| r.path.starts_with(&installed.path) || installed.path.starts_with(&r.path))
        {
            return Err(issue("Installed directory ownership changed"));
        }
        if installed.path.exists() {
            crate::source_removal::remove_owned_directory_with_identity(
                &installed.path,
                &installed.identity,
            )?;
        }
    }
    std::fs::remove_file(path).map_err(issue)
}
pub(crate) fn recover(registry: &Path) -> Result<()> {
    for entry in std::fs::read_dir(directory(registry)?).map_err(issue)? {
        let path = entry.map_err(issue)?.path();
        if path.extension().and_then(|v| v.to_str()) != Some("json") {
            continue;
        }
        let id = path
            .file_stem()
            .and_then(|v| v.to_str())
            .ok_or_else(|| issue("Invalid uninstall record name"))?;
        if let Err(error) = finish(registry, id) {
            crate::runtime_log::error("uninstall_cleanup", &format!("{id}: {error}"));
        }
    }
    Ok(())
}
