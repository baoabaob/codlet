//! Called only by the exclusive installation owner after runtime retirement.
use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DataReset {
    plugin_id: String,
    backup_name: String,
    had_data: bool,
}

pub(super) fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl DataReset {
    pub(crate) fn belongs_to(&self, id: &str) -> bool {
        self.plugin_id == id
    }
    pub(crate) fn plan(registry: &Path, id: &str) -> Result<Self> {
        if !crate::plugins::valid_plugin_id(id) {
            return Err(ServiceError::new("invalid_owner", "Invalid plugin ID"));
        }
        let root = ServiceRoot::new(registry)?;
        let path = root.path.join("plugins").join(id);
        let had_data = match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                validate_directory(&metadata)?;
                true
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => return Err(storage_io(e)),
        };
        let mut nonce = [0; 32];
        secrets::fill_random(&mut nonce)?;
        Ok(Self {
            plugin_id: id.into(),
            backup_name: hash_hex(&nonce),
            had_data,
        })
    }

    fn paths(&self, registry: &Path) -> Result<(ServiceRoot, PathBuf, PathBuf)> {
        if !crate::plugins::valid_plugin_id(&self.plugin_id) || !valid_hash(&self.backup_name) {
            return Err(ServiceError::new(
                "storage_corrupt",
                "Invalid data recovery identity",
            ));
        }
        let root = ServiceRoot::new(registry)?;
        let retired = root.path.join(".retired");
        ensure_directory(&retired)?;
        let current = root.path.join("plugins").join(&self.plugin_id);
        Ok((root, current, retired.join(&self.backup_name)))
    }

    // The caller persists this plan in its package journal before this rename.
    pub(crate) fn begin(&self, registry: &Path) -> Result<()> {
        let (_, current, backup) = self.paths(registry)?;
        if self.had_data {
            validate_directory(&fs::symlink_metadata(&current).map_err(storage_io)?)?;
            if backup.exists() {
                return Err(storage_io("Data backup already exists"));
            }
            fs::rename(current, backup).map_err(storage_io)?;
        }
        Ok(())
    }

    pub(crate) fn rollback(&self, registry: &Path) -> Result<()> {
        let (root, current, backup) = self.paths(registry)?;
        if backup.exists() {
            validate_directory(&fs::symlink_metadata(&backup).map_err(storage_io)?)?;
            purge_at(&root, &self.plugin_id, &current)?;
            fs::rename(backup, current).map_err(storage_io)?;
        } else if !self.had_data {
            purge_at(&root, &self.plugin_id, &current)?;
        }
        Ok(())
    }

    pub(crate) fn commit(&self, registry: &Path) -> Result<()> {
        let (root, _, backup) = self.paths(registry)?;
        purge_at(&root, &self.plugin_id, &backup)
    }
}

pub(crate) fn purge_plugin(registry: &Path, id: &str) -> Result<()> {
    if !crate::plugins::valid_plugin_id(id) {
        return Err(ServiceError::new("invalid_owner", "Invalid plugin ID"));
    }
    let root = ServiceRoot::new(registry)?;
    purge_at(&root, id, &root.path.join("plugins").join(id))
}

fn purge_at(root: &ServiceRoot, id: &str, path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(storage_io(e)),
        Ok(metadata) => validate_directory(&metadata)?,
    }
    let owner = read_json::<OwnerDocument>(&path.join("owner.json"), 16 * 1024)?;
    if let Some(owner) = owner {
        if owner.schema != 1 || owner.plugin_id != id || !valid_hash(&owner.source_identity_hash) {
            return Err(ServiceError::new(
                "storage_corrupt",
                "Data cleanup owner does not match",
            ));
        }
        let namespace = Namespace {
            path: path.into(),
            credential_prefix: format!(
                "Codlet/{}/{}/{}",
                &root.scope_hash[..32],
                id,
                owner.source_identity_hash
            ),
        };
        secrets::PluginSecrets::system(root.clone()).purge(&namespace)?;
    } else if path.join("credentials.json").exists() {
        return Err(ServiceError::new(
            "storage_corrupt",
            "Credential owner is missing",
        ));
    }
    crate::source_removal::remove_owned_directory(path).map_err(storage_io)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credential_scope_does_not_change_when_the_registry_file_is_created_or_removed() {
        let temp = tempfile::tempdir().unwrap();
        let registry = temp.path().join("config.json");
        let before = ServiceRoot::new(&registry).unwrap();
        fs::write(&registry, "{}").unwrap();
        let present = ServiceRoot::new(&registry).unwrap();
        fs::remove_file(&registry).unwrap();
        let removed = ServiceRoot::new(&registry).unwrap();
        assert_eq!(before.scope_hash, present.scope_hash);
        assert_eq!(present.scope_hash, removed.scope_hash);
    }
}
