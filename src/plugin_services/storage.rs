use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{
    Namespace, Result, ServiceError, ServiceOwner, ServiceRoot, atomic_json, decode,
    ensure_directory, is_link_or_reparse, lock_file, read_json,
};

const STATE_BYTES: u64 = 768 * 1024;
const VALUE_BYTES: usize = 128 * 1024;
const MAX_KEYS: usize = 1024;
const MAX_OPERATIONS: usize = 128;
const MAX_CHANGES: usize = 256;
const MAX_CHANGE_PAGE: usize = 100;
const DATA_QUOTA: u64 = 64 * 1024 * 1024;
const CACHE_QUOTA: u64 = 256 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES: usize = 10_000;

#[derive(Clone)]
pub(super) struct PluginStorage {
    root: ServiceRoot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StorageDocument {
    schema: u32,
    revision: u64,
    #[serde(default)]
    config: BTreeMap<String, Value>,
    #[serde(default)]
    entries: BTreeMap<String, Value>,
    #[serde(default)]
    changes: Vec<StorageChange>,
}

impl Default for StorageDocument {
    fn default() -> Self {
        Self {
            schema: 1,
            revision: 0,
            config: BTreeMap::new(),
            entries: BTreeMap::new(),
            changes: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StorageChange {
    cursor: u64,
    config_changed: bool,
    keys: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GetInput {
    key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransactionInput {
    expected_revision: u64,
    #[serde(default)]
    config: Option<BTreeMap<String, Value>>,
    #[serde(default)]
    operations: Vec<StorageOperation>,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum StorageOperation {
    Set { key: String, value: Value },
    Remove { key: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChangesInput {
    after_cursor: u64,
    #[serde(default = "default_change_limit")]
    limit: usize,
}

fn default_change_limit() -> usize {
    50
}

impl PluginStorage {
    pub(super) fn new(root: ServiceRoot) -> Self {
        Self { root }
    }

    pub(super) fn invoke(
        &self,
        owner: &ServiceOwner,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        let namespace = self.root.namespace(owner)?;
        match method {
            "snapshot" => {
                require_null(params)?;
                Ok(snapshot(&self.read(&namespace)?))
            }
            "get" => {
                let input: GetInput = decode(params)?;
                validate_key(&input.key)?;
                let document = self.read(&namespace)?;
                Ok(json!({
                    "revision": document.revision,
                    "key": &input.key,
                    "found": document.entries.contains_key(&input.key),
                    "value": document.entries.get(&input.key),
                }))
            }
            "transaction" => self.transaction(&namespace, decode(params)?),
            "changes" => self.changes(&namespace, decode(params)?),
            "directories" => {
                require_null(params)?;
                self.directories(&namespace)
            }
            "clearCache" => {
                require_null(params)?;
                self.clear_cache(&namespace)
            }
            _ => Err(ServiceError::new(
                "method_not_found",
                "storage method is not registered",
            )),
        }
    }

    fn read(&self, namespace: &Namespace) -> Result<StorageDocument> {
        let path = namespace.path.join("storage.json");
        let document = read_json(&path, STATE_BYTES)?.unwrap_or_default();
        validate_document(&document)?;
        Ok(document)
    }

    fn transaction(&self, namespace: &Namespace, input: TransactionInput) -> Result<Value> {
        if input.operations.len() > MAX_OPERATIONS
            || input.config.is_none() && input.operations.is_empty()
        {
            return Err(ServiceError::new(
                "invalid_params",
                "storage transaction requires 1..128 changes",
            ));
        }
        if let Some(config) = &input.config {
            validate_object(config, "config")?;
        }
        for operation in &input.operations {
            match operation {
                StorageOperation::Set { key, value } => {
                    validate_key(key)?;
                    validate_value(value)?;
                }
                StorageOperation::Remove { key } => validate_key(key)?,
            }
        }
        let _lock = lock_file(&namespace.path.join("storage.lock"))?;
        let path = namespace.path.join("storage.json");
        let mut document: StorageDocument = read_json(&path, STATE_BYTES)?.unwrap_or_default();
        validate_document(&document)?;
        if document.revision != input.expected_revision {
            return Err(conflict(document.revision));
        }
        if document.revision == ((1_u64 << 53) - 1) {
            return Err(ServiceError::new(
                "revision_exhausted",
                "storage revision is exhausted",
            ));
        }
        let mut config_changed = false;
        if let Some(config) = input.config
            && document.config != config
        {
            document.config = config;
            config_changed = true;
        }
        let mut changed_keys = BTreeSet::new();
        for operation in input.operations {
            match operation {
                StorageOperation::Set { key, value } => {
                    if document.entries.get(&key) != Some(&value) {
                        document.entries.insert(key.clone(), value);
                        changed_keys.insert(key);
                    }
                }
                StorageOperation::Remove { key } => {
                    if document.entries.remove(&key).is_some() {
                        changed_keys.insert(key);
                    }
                }
            }
        }
        if document.entries.len() > MAX_KEYS {
            return Err(ServiceError::new(
                "quota_exceeded",
                "storage key count exceeds its quota",
            ));
        }
        if !config_changed && changed_keys.is_empty() {
            return Ok(snapshot(&document));
        }
        document.revision += 1;
        document.changes.push(StorageChange {
            cursor: document.revision,
            config_changed,
            keys: changed_keys.into_iter().collect(),
        });
        if document.changes.len() > MAX_CHANGES {
            document
                .changes
                .drain(..document.changes.len() - MAX_CHANGES);
        }
        atomic_json(&path, &document, STATE_BYTES)?;
        Ok(snapshot(&document))
    }

    fn changes(&self, namespace: &Namespace, input: ChangesInput) -> Result<Value> {
        if input.limit == 0 || input.limit > MAX_CHANGE_PAGE {
            return Err(ServiceError::new(
                "invalid_params",
                "change limit must be between 1 and 100",
            ));
        }
        let document = self.read(namespace)?;
        if input.after_cursor > document.revision {
            return Err(ServiceError::new(
                "invalid_cursor",
                "change cursor is newer than current storage",
            ));
        }
        let earliest = document
            .changes
            .first()
            .map_or(document.revision.saturating_add(1), |change| change.cursor);
        if input.after_cursor.saturating_add(1) < earliest {
            return Ok(json!({
                "cursor": document.revision,
                "revision": document.revision,
                "resetRequired": true,
                "changes": [],
                "snapshot": snapshot(&document),
            }));
        }
        let changes = document
            .changes
            .iter()
            .filter(|change| change.cursor > input.after_cursor)
            .take(input.limit)
            .collect::<Vec<_>>();
        let cursor = changes
            .last()
            .map_or(input.after_cursor, |change| change.cursor);
        Ok(json!({
            "cursor": cursor,
            "revision": document.revision,
            "resetRequired": false,
            "changes": changes,
        }))
    }

    fn directories(&self, namespace: &Namespace) -> Result<Value> {
        let data = namespace.path.join("data");
        let cache = namespace.path.join("cache");
        ensure_directory(&data)?;
        ensure_directory(&cache)?;
        let data_usage = directory_usage(&data, DATA_QUOTA)?;
        let cache_usage = directory_usage(&cache, CACHE_QUOTA)?;
        Ok(json!({
            "dataPath": unicode_path(&data)?,
            "cachePath": unicode_path(&cache)?,
            "dataBytes": data_usage,
            "cacheBytes": cache_usage,
            "dataQuotaBytes": DATA_QUOTA,
            "cacheQuotaBytes": CACHE_QUOTA,
            "quotaEnforcement": "core-writes-only",
        }))
    }

    fn clear_cache(&self, namespace: &Namespace) -> Result<Value> {
        let _lock = lock_file(&namespace.path.join("cache.lock"))?;
        let cache = namespace.path.join("cache");
        ensure_directory(&cache)?;
        clear_directory(&cache, 0)?;
        Ok(json!({"cleared": true}))
    }
}

fn validate_document(document: &StorageDocument) -> Result<()> {
    if document.schema != 1
        || document.revision > ((1_u64 << 53) - 1)
        || document.entries.len() > MAX_KEYS
        || document.changes.len() > MAX_CHANGES
        || (document.revision == 0) != document.changes.is_empty()
        || document
            .changes
            .windows(2)
            .any(|pair| pair[0].cursor.checked_add(1) != Some(pair[1].cursor))
        || document
            .changes
            .last()
            .is_some_and(|change| change.cursor != document.revision)
        || document.changes.iter().any(|change| {
            change.cursor == 0
                || change.keys.len() > MAX_OPERATIONS
                || (!change.config_changed && change.keys.is_empty())
                || change.keys.windows(2).any(|pair| pair[0] >= pair[1])
                || change.keys.iter().any(|key| validate_key(key).is_err())
        })
    {
        return Err(ServiceError::new(
            "storage_corrupt",
            "storage document invariants are invalid",
        ));
    }
    if validate_object(&document.config, "config").is_err() {
        return Err(ServiceError::new(
            "storage_corrupt",
            "storage configuration invariants are invalid",
        ));
    }
    for (key, value) in &document.entries {
        if validate_key(key).is_err() || validate_value(value).is_err() {
            return Err(ServiceError::new(
                "storage_corrupt",
                "storage entry invariants are invalid",
            ));
        }
    }
    Ok(())
}

fn validate_object(values: &BTreeMap<String, Value>, label: &str) -> Result<()> {
    if values.len() > MAX_KEYS
        || serde_json::to_vec(values).map_or(true, |bytes| bytes.len() > VALUE_BYTES)
    {
        return Err(ServiceError::new(
            "quota_exceeded",
            format!("{label} exceeds its quota"),
        ));
    }
    for (key, value) in values {
        validate_key(key)?;
        validate_value(value)?;
    }
    Ok(())
}

fn validate_key(key: &str) -> Result<()> {
    if key.is_empty()
        || key.len() > 128
        || !key.is_ascii()
        || key
            .bytes()
            .any(|byte| !(byte.is_ascii_alphanumeric() || b"._-".contains(&byte)))
    {
        return Err(ServiceError::new(
            "invalid_params",
            "storage keys must be 1..128 ASCII letters, digits, dots, underscores or hyphens",
        ));
    }
    Ok(())
}

fn validate_value(value: &Value) -> Result<()> {
    if serde_json::to_vec(value).map_or(true, |bytes| bytes.len() > VALUE_BYTES) {
        return Err(ServiceError::new(
            "quota_exceeded",
            "storage value exceeds its quota",
        ));
    }
    Ok(())
}

fn snapshot(document: &StorageDocument) -> Value {
    json!({
        "schema": document.schema,
        "revision": document.revision,
        "cursor": document.revision,
        "config": &document.config,
        "entries": &document.entries,
    })
}

fn conflict(revision: u64) -> ServiceError {
    ServiceError::new(
        "storage_conflict",
        "storage changed in another window; read the current revision and retry",
    )
    .with_data(json!({"revision": revision}))
}

fn require_null(params: Value) -> Result<()> {
    if params.is_null() {
        Ok(())
    } else {
        Err(ServiceError::new(
            "invalid_params",
            "this storage method expects null parameters",
        ))
    }
}

fn unicode_path(path: &Path) -> Result<&str> {
    path.to_str().ok_or_else(|| {
        ServiceError::new(
            "storage_unavailable",
            "plugin service directory is not representable as Unicode",
        )
    })
}

fn directory_usage(root: &Path, quota: u64) -> Result<u64> {
    let mut stack = vec![PathBuf::from(root)];
    let mut bytes = 0_u64;
    let mut entries = 0_usize;
    while let Some(directory) = stack.pop() {
        for entry in fs::read_dir(directory).map_err(super::storage_io)? {
            let entry = entry.map_err(super::storage_io)?;
            entries += 1;
            if entries > MAX_DIRECTORY_ENTRIES {
                return Err(ServiceError::new(
                    "quota_exceeded",
                    "plugin directory contains too many entries",
                ));
            }
            let metadata = fs::symlink_metadata(entry.path()).map_err(super::storage_io)?;
            if is_link_or_reparse(&metadata) {
                return Err(ServiceError::new(
                    "storage_unavailable",
                    "plugin data and cache directories cannot contain links or reparse points",
                ));
            }
            if metadata.is_dir() {
                stack.push(entry.path());
            } else if metadata.is_file() {
                bytes = bytes.saturating_add(metadata.len());
                if bytes > quota {
                    return Err(ServiceError::new(
                        "quota_exceeded",
                        "plugin directory exceeds its reported quota",
                    ));
                }
            } else {
                return Err(ServiceError::new(
                    "storage_unavailable",
                    "plugin directory contains an unsupported filesystem object",
                ));
            }
        }
    }
    Ok(bytes)
}

fn clear_directory(directory: &Path, depth: usize) -> Result<()> {
    if depth > 32 {
        return Err(ServiceError::new(
            "storage_unavailable",
            "cache directory nesting is too deep",
        ));
    }
    for entry in fs::read_dir(directory).map_err(super::storage_io)? {
        let path = entry.map_err(super::storage_io)?.path();
        let metadata = fs::symlink_metadata(&path).map_err(super::storage_io)?;
        if is_link_or_reparse(&metadata) {
            if metadata.is_dir() {
                fs::remove_dir(&path).map_err(super::storage_io)?;
            } else {
                fs::remove_file(&path).map_err(super::storage_io)?;
            }
        } else if metadata.is_dir() {
            clear_directory(&path, depth + 1)?;
            fs::remove_dir(&path).map_err(super::storage_io)?;
        } else {
            fs::remove_file(&path).map_err(super::storage_io)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    fn fixture() -> (tempfile::TempDir, PluginStorage, ServiceOwner) {
        let root = tempfile::tempdir().unwrap();
        let registry = root.path().join("config.json");
        fs::write(&registry, b"{}").unwrap();
        let service_root = ServiceRoot::new(&registry).unwrap();
        (
            root,
            PluginStorage::new(service_root),
            ServiceOwner {
                plugin_id: "dev.storage-test".into(),
                source_identity: "local:C:/stable/plugin".into(),
            },
        )
    }

    #[test]
    fn transaction_is_atomic_cas_and_namespaces_config_with_kv() {
        let (_root, storage, owner) = fixture();
        let first = storage
            .invoke(
                &owner,
                "transaction",
                json!({"expectedRevision":0,"config":{"enabled":true},"operations":[
                    {"op":"set","key":"token.mode","value":{"kind":"test"}},
                    {"op":"set","key":"count","value":1}
                ]}),
            )
            .unwrap();
        assert_eq!(first["revision"], 1);
        assert_eq!(first["config"]["enabled"], true);
        assert_eq!(first["entries"]["token.mode"]["kind"], "test");
        let conflict = storage
            .invoke(
                &owner,
                "transaction",
                json!({"expectedRevision":0,"operations":[{"op":"remove","key":"count"}]}),
            )
            .unwrap_err();
        assert_eq!(conflict.code, "storage_conflict");
        assert_eq!(conflict.data.unwrap()["revision"], 1);
        assert_eq!(
            storage
                .invoke(&owner, "get", json!({"key":"count"}))
                .unwrap()["value"],
            1
        );
    }

    #[test]
    fn simultaneous_windows_cannot_both_commit_the_same_revision() {
        let (_root, storage, owner) = fixture();
        let barrier = Arc::new(Barrier::new(2));
        let left_storage = storage.clone();
        let left_owner = owner.clone();
        let left_barrier = barrier.clone();
        let left = std::thread::spawn(move || {
            left_barrier.wait();
            left_storage.invoke(
                &left_owner,
                "transaction",
                json!({"expectedRevision":0,"operations":[{"op":"set","key":"left","value":1}]}),
            )
        });
        barrier.wait();
        let right = storage.invoke(
            &owner,
            "transaction",
            json!({"expectedRevision":0,"operations":[{"op":"set","key":"right","value":1}]}),
        );
        let left = left.join().unwrap();
        assert_eq!(usize::from(left.is_ok()) + usize::from(right.is_ok()), 1);
        assert_eq!(
            left.err().or_else(|| right.err()).unwrap().code,
            "storage_conflict"
        );
    }

    #[test]
    fn bounded_change_cursor_requires_snapshot_after_history_rolls_over() {
        let (_root, storage, owner) = fixture();
        for revision in 0..=MAX_CHANGES {
            storage
                .invoke(
                    &owner,
                    "transaction",
                    json!({"expectedRevision":revision,"operations":[{"op":"set","key":"value","value":revision}]}),
                )
                .unwrap();
        }
        let old = storage
            .invoke(&owner, "changes", json!({"afterCursor":0,"limit":10}))
            .unwrap();
        assert_eq!(old["resetRequired"], true);
        assert_eq!(old["snapshot"]["revision"], (MAX_CHANGES + 1) as u64);
        let recent = storage
            .invoke(
                &owner,
                "changes",
                json!({"afterCursor":MAX_CHANGES,"limit":10}),
            )
            .unwrap();
        assert_eq!(recent["resetRequired"], false);
        assert_eq!(recent["changes"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn stable_source_keeps_directories_and_changed_source_is_refused() {
        let (_root, storage, owner) = fixture();
        let directories = storage.invoke(&owner, "directories", Value::Null).unwrap();
        fs::write(
            Path::new(directories["dataPath"].as_str().unwrap()).join("kept.txt"),
            b"kept",
        )
        .unwrap();
        assert_eq!(
            storage.invoke(&owner, "directories", Value::Null).unwrap()["dataBytes"],
            4
        );
        let changed = ServiceOwner {
            plugin_id: owner.plugin_id,
            source_identity: "github:another/source".into(),
        };
        assert_eq!(
            storage
                .invoke(&changed, "snapshot", Value::Null)
                .unwrap_err()
                .code,
            "source_identity_changed"
        );
    }

    #[test]
    fn state_document_hard_links_are_rejected() {
        let (root, storage, owner) = fixture();
        storage
            .invoke(
                &owner,
                "transaction",
                json!({"expectedRevision":0,"operations":[{"op":"set","key":"safe","value":true}]}),
            )
            .unwrap();
        let namespace = storage.root.namespace(&owner).unwrap();
        let state = namespace.path.join("storage.json");
        let outside = root.path().join("outside.json");
        fs::rename(&state, &outside).unwrap();
        fs::hard_link(&outside, &state).unwrap();
        assert_eq!(
            storage
                .invoke(&owner, "snapshot", Value::Null)
                .unwrap_err()
                .code,
            "storage_corrupt"
        );
    }

    #[test]
    fn clearing_cache_removes_only_the_link_and_keeps_its_target() {
        let (root, storage, owner) = fixture();
        let directories = storage.invoke(&owner, "directories", Value::Null).unwrap();
        let cache = PathBuf::from(directories["cachePath"].as_str().unwrap());
        let outside = root.path().join("outside-cache-target.txt");
        fs::write(&outside, b"keep").unwrap();
        let link = cache.join("linked.txt");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(&outside, &link).is_err() {
            fs::hard_link(&outside, &link).unwrap();
        }
        assert_eq!(
            storage.invoke(&owner, "clearCache", Value::Null).unwrap()["cleared"],
            true
        );
        assert!(!link.exists());
        assert_eq!(fs::read(&outside).unwrap(), b"keep");
    }

    #[test]
    fn malformed_persistent_history_is_reported_as_corrupt() {
        let (_root, storage, owner) = fixture();
        let namespace = storage.root.namespace(&owner).unwrap();
        fs::write(
            namespace.path.join("storage.json"),
            br#"{"schema":1,"revision":1,"config":{},"entries":{},"changes":[{"cursor":0,"configChanged":false,"keys":[]}]}"#,
        )
        .unwrap();
        assert_eq!(
            storage
                .invoke(&owner, "snapshot", Value::Null)
                .unwrap_err()
                .code,
            "storage_corrupt"
        );
    }

    #[test]
    fn oversized_commit_leaves_the_previous_document_intact() {
        let (_root, storage, owner) = fixture();
        storage
            .invoke(
                &owner,
                "transaction",
                json!({"expectedRevision":0,"operations":[{"op":"set","key":"kept","value":1}]}),
            )
            .unwrap();
        let large = "x".repeat(120 * 1024);
        let operations = (0..7)
            .map(|index| json!({"op":"set","key":format!("large-{index}"),"value":large}))
            .collect::<Vec<_>>();
        assert_eq!(
            storage
                .invoke(
                    &owner,
                    "transaction",
                    json!({"expectedRevision":1,"operations":operations}),
                )
                .unwrap_err()
                .code,
            "quota_exceeded"
        );
        let snapshot = storage.invoke(&owner, "snapshot", Value::Null).unwrap();
        assert_eq!(snapshot["revision"], 1);
        assert_eq!(snapshot["entries"], json!({"kept":1}));
    }
}
