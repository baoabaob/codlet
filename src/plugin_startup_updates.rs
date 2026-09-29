//! Refresh already-installed official channels before plugin executors start.
//! This is distribution maintenance, not a dependency on any plugin capability.
use crate::github_distribution::GitHubClient;
use crate::platform::control_pipe::RegistryScopeGuard;
use crate::plugin_update_source::{PluginUpdateSource, is_official_channel};
use crate::plugins::PluginRegistry;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const BUDGET: Duration = Duration::from_secs(30);
const RETRY_MS: u64 = 300_000;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Checkpoint {
    schema: u32,
    key: String,
    checked_at: u64,
    completed: bool,
    items: Vec<Item>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Item {
    id: String,
    status: String,
    detail: String,
}

fn sources(registry: &PluginRegistry) -> Vec<(String, PluginUpdateSource)> {
    PluginUpdateSource::all(registry)
        .into_iter()
        .filter(|(id, source)| is_official_channel(id, &source.channel))
        .collect()
}
fn key(registry: &PluginRegistry, client: &str) -> String {
    crate::local_import::digest(&(
        env!("CARGO_PKG_VERSION"),
        client,
        sources(registry)
            .into_iter()
            .map(|(id, source)| (id, source.version_key))
            .collect::<Vec<_>>(),
    ))
}
fn due(previous: Option<&Checkpoint>, key: &str, now: u64) -> bool {
    previous.is_none_or(|previous| {
        previous.schema != 1
            || previous.key != key
            || !previous.completed && now.saturating_sub(previous.checked_at) >= RETRY_MS
    })
}
fn checkpoint_path(registry: &Path) -> PathBuf {
    registry.with_extension("json.client-plugins.json")
}
fn plain_file(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    return Err("Linked startup checkpoint rejected".into());
                }
            }
            if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 65536 {
                return Err("Invalid startup checkpoint".into());
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}
fn save(path: &Path, value: &Checkpoint) -> Result<(), String> {
    plain_file(path)?;
    let mut file =
        tempfile::NamedTempFile::new_in(path.parent().ok_or("Checkpoint has no parent")?)
            .map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Safe mode and synthetic acceptance clients do not call this. Network or
/// update failures never prevent the official client from starting.
pub(crate) fn refresh(lease: &RegistryScopeGuard, client: &str) {
    if let Err(error) = run(lease, client) {
        crate::runtime_log::error("startup_plugin_updates", &error);
        eprintln!("plugin-startup-update: {error}; continuing client launch");
    }
}
fn run(lease: &RegistryScopeGuard, client: &str) -> Result<(), String> {
    let path = lease.scope().path();
    let registry = PluginRegistry::load(path).map_err(|e| e.to_string())?;
    let selected = sources(&registry);
    if selected.is_empty() {
        return Ok(());
    }
    let checkpoint = checkpoint_path(path);
    plain_file(&checkpoint)?;
    let previous = std::fs::read(&checkpoint)
        .ok()
        .and_then(|data| serde_json::from_slice::<Checkpoint>(&data).ok());
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    if !due(previous.as_ref(), &key(&registry, client), now) {
        return Ok(());
    }
    eprintln!(
        "plugin-startup-update: checking {} installed official channels before launching {client}",
        selected.len()
    );
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    let items = runtime.block_on(async {
        let github = GitHubClient::new().map_err(|e|e.to_string())?;
        let deadline = tokio::time::Instant::now() + BUDGET;
        let mut items = Vec::new();
        for (id, source) in selected {
            let result = tokio::time::timeout_at(deadline,
                crate::plugin_update_install::prepare_latest(&github, path, &id, &source.version_key)).await;
            let (status, detail) = match result {
                Ok(Ok(None)) => ("upToDate", source.manifest.version),
                Ok(Ok(Some(preview))) => {
                    if !preview.source.upstream_digest_verified {
                        ("failed", "The release asset has no verified upstream digest".into())
                    } else if crate::plugin_update_install::needs_authority_review(&preview) {
                        ("reviewRequired", "New permissions or dependency changes require review in plugin management".into())
                    } else {
                        match crate::plugin_cli::update_before_launch(lease, &preview) {
                            Ok(()) => ("updated", preview.manifest.version),
                            Err(error) => ("failed", error.to_string()),
                        }
                    }
                }
                Ok(Err(error)) => ("failed", error),
                Err(_) => ("failed", "Startup update deadline reached; the installed package was retained".into()),
            };
            let detail: String = detail.chars().take(1000).collect();
            eprintln!("plugin-startup-update: {id}; {status}; {detail}");
            if matches!(status, "failed" | "reviewRequired") {
                crate::runtime_log::error("startup_plugin_update", &format!("{id}: {status}: {detail}"));
            } else {
                crate::runtime_log::info("startup_plugin_update", &format!("{id}: {status}: {detail}"));
            }
            items.push(Item { id, status: status.into(), detail });
        }
        Ok::<_, String>(items)
    })?;
    // Compute the key after commits so a successful migration does not trigger
    // another network check on the next ordinary launch.
    let current = PluginRegistry::load(path).map_err(|e| e.to_string())?;
    save(
        &checkpoint,
        &Checkpoint {
            schema: 1,
            key: key(&current, client),
            checked_at: now,
            completed: items.iter().all(|item| item.status != "failed"),
            items,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_sources_gain_the_pinned_channel_only_after_file_verification() {
        let temp = tempfile::tempdir().unwrap();
        let registry = crate::plugin_update_source::fixture_seed(temp.path(), "codex.ui.adapter");
        let receipt = temp
            .path()
            .join(".official-seed-transactions/codex.ui.adapter.receipt.json");
        let mut value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&receipt).unwrap()).unwrap();
        value["package"]
            .as_object_mut()
            .unwrap()
            .remove("updateSource");
        std::fs::write(&receipt, value.to_string()).unwrap();
        let selected = sources(&registry);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].1.channel.repository_id, Some(1379358711));
        assert_eq!(
            selected[0].1.operation,
            crate::managed_plugins::ManagedOperation::Adopt
        );
        assert!(!registry.is_enabled("codex.ui.adapter"));
        std::fs::write(
            registry.local_plugins()["codex.ui.adapter"]
                .path
                .join("author.js"),
            "preserve me",
        )
        .unwrap();
        assert!(
            sources(&registry).is_empty(),
            "changed author files cannot be adopted"
        );
        assert!(registry.managed_plugins().is_empty());
    }

    #[test]
    fn an_official_id_in_a_different_repository_never_gets_automatic_updates() {
        let temp = tempfile::tempdir().unwrap();
        let registry = crate::plugin_update_source::fixture_seed(temp.path(), "codex.ui.adapter");
        assert!(sources(&registry).is_empty());
        let mut channel =
            crate::plugin_update_source::official_channel("codex.ui.adapter").unwrap();
        channel.owner_id = Some(1);
        assert!(!is_official_channel("codex.ui.adapter", &channel));
        channel.owner_id = Some(76909162);
        channel.repository_id = None;
        assert!(!is_official_channel("codex.ui.adapter", &channel));
    }

    #[test]
    #[ignore = "downloads published official plugins into an explicitly prepared isolated fixture"]
    fn real_installer_migration_keeps_grants_and_enablement_and_is_idempotent() {
        let root =
            PathBuf::from(std::env::var_os("CODLET_STARTUP_UPDATE_FIXTURE").expect("fixture root"));
        assert!(root.is_absolute());
        assert_eq!(
            std::fs::read_to_string(root.join("owner.txt")).unwrap(),
            "codlet-startup-update-fixture\n"
        );
        let scope =
            crate::platform::control_pipe::RegistryScope::for_path(&root.join("config.json"))
                .unwrap();
        let lease = scope.acquire(Duration::from_secs(1)).unwrap();
        let before = PluginRegistry::load(scope.path()).unwrap();
        assert_eq!(sources(&before).len(), 3);
        for entry in before.local_plugins().values() {
            assert!(
                entry
                    .path
                    .canonicalize()
                    .unwrap()
                    .starts_with(root.canonicalize().unwrap())
            );
        }
        run(&lease, "fixture-26.924.2738.0").unwrap();
        let checkpoint_path = checkpoint_path(scope.path());
        let bytes = std::fs::read(&checkpoint_path).unwrap();
        let checkpoint: Checkpoint = serde_json::from_slice(&bytes).unwrap();
        assert!(
            checkpoint.items.iter().all(|item| item.status == "updated"),
            "{}",
            String::from_utf8_lossy(&bytes)
        );
        let after = PluginRegistry::load(scope.path()).unwrap();
        for (id, old) in before.local_plugins() {
            assert_eq!(old.grants, after.local_plugins()[id].grants);
            assert_eq!(old.broker_policy, after.local_plugins()[id].broker_policy);
            assert_eq!(before.is_enabled(id), after.is_enabled(id));
            assert!(after.managed_plugins().contains_key(id));
            crate::managed_plugins::validate_current(&after, id).unwrap();
        }
        run(&lease, "fixture-26.924.2738.0").unwrap();
        assert_eq!(std::fs::read(checkpoint_path).unwrap(), bytes);
    }
    #[test]
    fn changes_trigger_once_and_failed_checks_retry_without_delaying_every_launch() {
        let mut previous = Checkpoint {
            schema: 1,
            key: "client-and-core-a".into(),
            checked_at: 1000,
            completed: true,
            items: vec![],
        };
        assert!(due(None, "a", 1000));
        assert!(!due(Some(&previous), "client-and-core-a", u64::MAX));
        assert!(due(Some(&previous), "new-client", 1001));
        previous.completed = false;
        assert!(!due(Some(&previous), "client-and-core-a", 1001));
        assert!(due(Some(&previous), "client-and-core-a", 1000 + RETRY_MS));
    }
}
