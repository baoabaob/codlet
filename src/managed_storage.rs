//! Stable plugin-ID directories. File replacement occurs only after retirement;
//! a short-lived journal protects the previous package until activation commits.
use crate::catalog::PluginCatalogEntry;
use crate::github_distribution as packages;
use crate::local_import::registration_digest;
use crate::managed_plugins::{self, ManagedPluginRecord};
use crate::plugin_control::PluginControlError;
use crate::plugins::{LocalPluginRegistration, PluginRegistry};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Path, PathBuf};
type Result<T> = std::result::Result<T, PluginControlError>;
fn issue(e: impl std::fmt::Display) -> PluginControlError {
    PluginControlError::new("managed_storage", e.to_string())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    schema: u32,
    id: String,
    target: PathBuf,
    staged: PathBuf,
    ready: PathBuf,
    backup: Option<PathBuf>,
    source: packages::GitHubSource,
    previous_registration: Option<LocalPluginRegistration>,
    previous_managed: Option<ManagedPluginRecord>,
    previous_enabled: bool,
    allowed_registrations: Vec<String>,
    committed: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrationCheckpoint {
    schema: u32,
    id: String,
    candidate: String,
    previous: String,
    registration: Option<LocalPluginRegistration>,
    managed: Option<ManagedPluginRecord>,
    enabled: bool,
}

/// The lifecycle planner persists a staged registration before it retires the
/// old runtime. Record the previous state first so a crash in that interval has
/// the same recovery guarantee as the later file replacement transaction.
pub(crate) fn checkpoint_registration(
    candidate: &PluginRegistry,
    previous: &PluginRegistry,
    id: &str,
) -> Result<()> {
    let (journal, _lock) = lock(candidate.path(), id)?;
    if journal.exists() {
        return Err(issue(
            "An interrupted installation must be recovered before another update",
        ));
    }
    let path = journal.with_extension("pending");
    if path.exists() {
        return Err(issue(
            "An interrupted registration must be recovered before another update",
        ));
    }
    let checkpoint = RegistrationCheckpoint {
        schema: 1,
        id: id.into(),
        candidate: registration_digest(candidate, id),
        previous: registration_digest(previous, id),
        registration: previous.local_plugins().get(id).cloned(),
        managed: previous.managed_plugins().get(id).cloned(),
        enabled: previous.is_enabled(id),
    };
    let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(issue)?;
    let bytes = serde_json::to_vec(&checkpoint).map_err(issue)?;
    if bytes.len() > crate::plugins::MAX_REGISTRY_BYTES {
        return Err(issue("Registration recovery record exceeds its limit"));
    }
    file.write_all(&bytes).map_err(issue)?;
    file.as_file().sync_all().map_err(issue)?;
    file.persist_noclobber(&path).map_err(issue)?;
    Ok(())
}

pub(crate) fn clear_registration_checkpoint(registry: &PluginRegistry, id: &str) -> Result<()> {
    let path = transaction_root(registry.path())?.join(format!("{id}.pending"));
    if !path.exists() {
        return Ok(());
    }
    let checkpoint = read_checkpoint(&path)?;
    let current = registration_digest(registry, id);
    if checkpoint.id != id || (current != checkpoint.candidate && current != checkpoint.previous) {
        return Err(issue(
            "A later registration change prevents checkpoint retirement",
        ));
    }
    std::fs::remove_file(path).map_err(issue)
}

fn read_checkpoint(path: &Path) -> Result<RegistrationCheckpoint> {
    use std::io::Read;
    let metadata = std::fs::symlink_metadata(path).map_err(issue)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(issue("Invalid registration recovery record"));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(issue)?
        .take(crate::plugins::MAX_REGISTRY_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(issue)?;
    if bytes.len() > crate::plugins::MAX_REGISTRY_BYTES {
        return Err(issue("Registration recovery record exceeds its limit"));
    }
    let checkpoint: RegistrationCheckpoint = serde_json::from_slice(&bytes).map_err(issue)?;
    if checkpoint.schema != 1
        || !crate::plugins::valid_plugin_id(&checkpoint.id)
        || path.file_stem().and_then(|s| s.to_str()) != Some(&checkpoint.id)
    {
        return Err(issue("Registration recovery identity is invalid"));
    }
    Ok(checkpoint)
}
pub(crate) struct Installation {
    registry_path: PathBuf,
    journal_path: PathBuf,
    journal: Journal,
    _lock: std::fs::File,
}

fn transaction_root(registry: &Path) -> Result<PathBuf> {
    let path = packages::managed_root(registry, true)
        .map_err(issue)?
        .join(".transactions");
    if !path.exists() {
        std::fs::create_dir(&path).map_err(issue)?;
    }
    let metadata = std::fs::symlink_metadata(&path).map_err(issue)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || path.canonicalize().map_err(issue)? != path
    {
        return Err(issue("Transaction directory must not redirect"));
    }
    Ok(path)
}
fn lock(registry: &Path, id: &str) -> Result<(PathBuf, std::fs::File)> {
    if !crate::plugins::valid_plugin_id(id) {
        return Err(issue("Invalid plugin ID"));
    }
    let root = transaction_root(registry)?;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join(format!("{id}.lock")))
        .map_err(issue)?;
    file.try_lock()
        .map_err(|_| issue("This plugin already has an installation in progress"))?;
    Ok((root.join(format!("{id}.json")), file))
}
impl Installation {
    pub(crate) fn publish(
        candidate: &PluginRegistry,
        previous: &PluginRegistry,
        id: &str,
        enable_after: bool,
    ) -> Result<(Self, PluginRegistry, PluginCatalogEntry)> {
        let (installation, registry, entry) =
            Self::publish_inner(candidate, previous, id, enable_after, true)?;
        Ok((
            installation,
            registry,
            entry.expect("installation requests a checked entry"),
        ))
    }
    fn publish_inner(
        candidate: &PluginRegistry,
        previous: &PluginRegistry,
        id: &str,
        enable_after: bool,
        load_entry: bool,
    ) -> Result<(Self, PluginRegistry, Option<PluginCatalogEntry>)> {
        let (journal_path, lock) = lock(candidate.path(), id)?;
        if journal_path.exists() {
            return Err(issue(
                "An interrupted installation must be recovered before updating this plugin",
            ));
        }
        let staged = candidate
            .managed_plugins()
            .get(id)
            .and_then(ManagedPluginRecord::current)
            .ok_or_else(|| issue("Managed selection missing"))?;
        let checked = packages::inspect_prepared_package(candidate.path(), &staged.package_path)
            .map_err(issue)?;
        let target = packages::managed_root(candidate.path(), false)
            .map_err(issue)?
            .join(id);
        if target.exists()
            && previous
                .local_plugins()
                .get(id)
                .is_none_or(|r| r.path != target)
        {
            return Err(issue(
                "The plugin ID directory is already owned by another source",
            ));
        }
        if target.exists() {
            managed_plugins::validate_current(previous, id)?;
        }
        let ready = packages::clone_prepared_package(candidate.path(), &staged.package_path)
            .map_err(issue)?;
        let backup = if target.exists() {
            let temp = tempfile::Builder::new()
                .prefix("backup-")
                .tempdir_in(packages::staging_root(candidate.path()).map_err(issue)?)
                .map_err(issue)?;
            let path = temp.keep();
            std::fs::remove_dir(&path).map_err(issue)?;
            Some(path)
        } else {
            None
        };
        let mut installation = Self {
            registry_path: candidate.path().into(),
            journal_path,
            journal: Journal {
                schema: 1,
                id: id.into(),
                target,
                staged: staged.package_path.clone(),
                ready: ready.package_path,
                backup,
                source: checked.source,
                previous_registration: previous.local_plugins().get(id).cloned(),
                previous_managed: previous.managed_plugins().get(id).cloned(),
                previous_enabled: previous.is_enabled(id),
                allowed_registrations: vec![
                    registration_digest(candidate, id),
                    registration_digest(previous, id),
                ],
                committed: false,
            },
            _lock: lock,
        };
        installation.save()?;
        // The file journal now owns recovery. Clear the earlier metadata-only
        // checkpoint before any rename so it cannot later undo a committed swap.
        clear_registration_checkpoint(candidate, id)?;
        let result = (|| {
            let j = &installation.journal;
            if let Some(backup) = &j.backup {
                packages::relocate_prepared_package(candidate.path(), &j.target, backup)
                    .map_err(issue)?;
            }
            packages::relocate_prepared_package(candidate.path(), &j.ready, &j.target)
                .map_err(issue)?;
            let (mut next, entry) = if load_entry {
                let (next, entry) =
                    managed_plugins::at_installation_path(candidate, id, &j.target)?;
                (next, Some(entry))
            } else {
                (
                    managed_plugins::registration_at_path(candidate, id, &j.target)?,
                    None,
                )
            };
            installation
                .journal
                .allowed_registrations
                .push(registration_digest(&next, id));
            if enable_after {
                let mut enabled = next.clone();
                enabled.set_enabled(id, true).map_err(issue)?;
                installation
                    .journal
                    .allowed_registrations
                    .push(registration_digest(&enabled, id));
            }
            installation.save()?;
            next.save().map_err(issue)?;
            Ok((next, entry))
        })();
        match result {
            Ok((next, entry)) => Ok((installation, next, entry)),
            Err(error) => {
                if let Err(restore) = installation.rollback() {
                    return Err(issue(format!(
                        "{error}; previous installation recovery: {restore}"
                    )));
                }
                Err(error)
            }
        }
    }
    fn save(&self) -> Result<()> {
        let mut file =
            tempfile::NamedTempFile::new_in(self.journal_path.parent().unwrap()).map_err(issue)?;
        let bytes = serde_json::to_vec(&self.journal).map_err(issue)?;
        if bytes.len() > crate::plugins::MAX_REGISTRY_BYTES {
            return Err(issue("Installation recovery record exceeds its limit"));
        }
        file.write_all(&bytes).map_err(issue)?;
        file.as_file().sync_all().map_err(issue)?;
        file.persist(&self.journal_path).map_err(issue)?;
        Ok(())
    }
    fn check_registration(&self) -> Result<PluginRegistry> {
        let registry = PluginRegistry::load(&self.registry_path).map_err(issue)?;
        if !self
            .journal
            .allowed_registrations
            .contains(&registration_digest(&registry, &self.journal.id))
        {
            return Err(issue(
                "Concurrent permission or source changes prevent installation restoration",
            ));
        }
        Ok(registry)
    }
    pub(crate) fn rollback(&mut self) -> Result<PluginRegistry> {
        let mut registry = self.check_registration()?;
        let j = &self.journal;
        // Before any deletion, confirm that the previous package can be restored.
        let backup = j.backup.as_ref().filter(|path| path.exists());
        if let Some(path) = backup {
            self.check_previous(path)?;
        } else if let Some(previous) = &j.previous_registration {
            self.check_previous(&previous.path)?;
        }
        if j.target.exists()
            && (backup.is_some()
                || j.previous_registration
                    .as_ref()
                    .is_none_or(|r| r.path != j.target))
        {
            let package = packages::inspect_prepared_package(&self.registry_path, &j.target)
                .map_err(issue)?;
            if package.source != j.source || package.manifest.id != j.id {
                return Err(issue("Installation content changed during recovery"));
            }
            packages::remove_prepared_package(&self.registry_path, &j.target).map_err(issue)?;
        }
        if let Some(backup) = backup {
            packages::relocate_prepared_package(&self.registry_path, backup, &j.target)
                .map_err(issue)?;
        }
        registry.restore_managed(
            &j.id,
            j.previous_registration.clone(),
            j.previous_managed.clone(),
        );
        registry
            .set_enabled(&j.id, j.previous_enabled)
            .map_err(issue)?;
        registry.save().map_err(issue)?;
        self.clean_paths([self.journal.ready.clone(), self.journal.staged.clone()])?;
        std::fs::remove_file(&self.journal_path).map_err(issue)?;
        Ok(registry)
    }
    fn check_previous(&self, path: &Path) -> Result<()> {
        let old = self
            .journal
            .previous_managed
            .as_ref()
            .and_then(ManagedPluginRecord::current)
            .ok_or_else(|| issue("Previous package record missing"))?;
        let package =
            packages::inspect_prepared_package(&self.registry_path, path).map_err(issue)?;
        if package.source != old.source || package.manifest != old.manifest {
            return Err(issue("Previous package changed during installation"));
        }
        Ok(())
    }
    pub(crate) fn commit(&mut self) -> Result<()> {
        self.check_registration()?;
        self.journal.committed = true;
        self.save()?;
        self.clean_obsolete()?;
        std::fs::remove_file(&self.journal_path).map_err(issue)?;
        Ok(())
    }
    fn clean_obsolete(&self) -> Result<()> {
        let mut paths = vec![self.journal.staged.clone(), self.journal.ready.clone()];
        paths.extend(self.journal.backup.iter().cloned());
        paths.extend(
            self.journal
                .previous_managed
                .iter()
                .flat_map(|r| r.history.iter().map(|v| v.package_path.clone())),
        );
        self.clean_paths(paths)
    }
    fn clean_paths(&self, paths: impl IntoIterator<Item = PathBuf>) -> Result<()> {
        let registry = PluginRegistry::load(&self.registry_path).map_err(issue)?;
        for path in paths.into_iter().collect::<BTreeSet<_>>() {
            if path == self.journal.target
                || !path.exists()
                || registry
                    .local_plugins()
                    .values()
                    .any(|r| r.path.starts_with(&path) || path.starts_with(&r.path))
            {
                continue;
            }
            let package =
                packages::inspect_prepared_package(&self.registry_path, &path).map_err(issue)?;
            if package.manifest.id != self.journal.id {
                return Err(issue("Cleanup directory belongs to a different plugin"));
            }
            packages::remove_prepared_package(&self.registry_path, &path).map_err(issue)?;
        }
        Ok(())
    }
}

/// Called by the exclusive Core owner before loading any optional plugins.
pub(crate) fn prepare_installations(registry: &mut PluginRegistry) -> Result<()> {
    let root = packages::managed_root(registry.path(), true).map_err(issue)?;
    let mut deferred = BTreeSet::new();
    for file in std::fs::read_dir(transaction_root(registry.path())?).map_err(issue)? {
        let file = file.map_err(issue)?;
        if file.path().extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let metadata = file.metadata().map_err(issue)?;
        if !metadata.is_file() || metadata.len() > crate::plugins::MAX_REGISTRY_BYTES as u64 {
            return Err(issue("Invalid installation recovery record"));
        }
        let journal: Journal =
            serde_json::from_slice(&std::fs::read(file.path()).map_err(issue)?).map_err(issue)?;
        if journal.schema != 1
            || !crate::plugins::valid_plugin_id(&journal.id)
            || journal.target != root.join(&journal.id)
            || journal.ready.parent() != Some(root.join(".staging").as_path())
            || journal
                .backup
                .as_ref()
                .is_some_and(|p| p.parent() != Some(root.join(".staging").as_path()))
        {
            return Err(issue("Installation recovery paths are invalid"));
        }
        let (path, lock) = lock(registry.path(), &journal.id)?;
        if path != file.path() {
            return Err(issue("Installation recovery identity mismatch"));
        }
        let mut installation = Installation {
            registry_path: registry.path().into(),
            journal_path: path,
            journal,
            _lock: lock,
        };
        if installation.journal.committed {
            match installation.clean_obsolete() {
                Ok(()) => {
                    std::fs::remove_file(&installation.journal_path).map_err(issue)?;
                }
                Err(error) => {
                    crate::runtime_log::error(
                        "managed_cleanup",
                        &format!("{}: {error}", installation.journal.id),
                    );
                    deferred.insert(installation.journal.id.clone());
                }
            }
        } else {
            match installation.rollback() {
                Ok(restored) => *registry = restored,
                Err(error) => {
                    crate::runtime_log::error(
                        "managed_recovery",
                        &format!("{}: {error}", installation.journal.id),
                    );
                    deferred.insert(installation.journal.id.clone());
                }
            }
        }
    }
    *registry = PluginRegistry::load(registry.path()).map_err(issue)?;
    for file in std::fs::read_dir(transaction_root(registry.path())?).map_err(issue)? {
        let path = file.map_err(issue)?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("pending") {
            continue;
        }
        let checkpoint = read_checkpoint(&path)?;
        if deferred.contains(&checkpoint.id) {
            continue;
        }
        let current = registration_digest(registry, &checkpoint.id);
        if current == checkpoint.candidate {
            registry.restore_managed(&checkpoint.id, checkpoint.registration, checkpoint.managed);
            registry
                .set_enabled(&checkpoint.id, checkpoint.enabled)
                .map_err(issue)?;
            registry.save().map_err(issue)?;
        } else if current != checkpoint.previous {
            crate::runtime_log::error(
                "managed_recovery",
                &format!(
                    "{}: later permissions or registration changes were preserved",
                    checkpoint.id
                ),
            );
            deferred.insert(checkpoint.id);
            continue;
        }
        std::fs::remove_file(path).map_err(issue)?;
    }
    let ids = registry
        .managed_plugins()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    for id in ids {
        if deferred.contains(&id) {
            continue;
        }
        let record = registry.managed_plugins().get(&id).unwrap();
        let Some(current) = record.current() else {
            continue;
        };
        if current.package_path == root.join(&id) && record.history.len() == 1 {
            continue;
        }
        if let Err(error) = managed_plugins::validate_current(registry, &id) {
            crate::runtime_log::error("managed_migration", &format!("{id}: {error}"));
            continue;
        }
        let migration = (|| {
            let copied = packages::clone_prepared_package(registry.path(), &current.package_path)
                .map_err(issue)?;
            // Migration changes storage only. Do not persist a disabled staging
            // registration before the file transaction has a recovery journal.
            let staged =
                managed_plugins::registration_at_path(registry, &id, &copied.package_path)?;
            let (mut installation, next, _) = Installation::publish_inner(
                &staged,
                registry,
                &id,
                registry.is_enabled(&id),
                false,
            )?;
            if let Err(error) = installation.commit() {
                crate::runtime_log::error("managed_cleanup", &format!("{id}: {error}"));
            }
            Ok::<_, PluginControlError>(next)
        })();
        match migration {
            Ok(next) => *registry = next,
            Err(error) => {
                crate::runtime_log::error("managed_migration", &format!("{id}: {error}"));
                // A filesystem conflict in one optional package must not stop
                // Core or overwrite a registration restored by the transaction.
                *registry = PluginRegistry::load(registry.path()).map_err(issue)?;
            }
        }
    }
    *registry = PluginRegistry::load(registry.path()).map_err(issue)?;
    Ok(())
}
