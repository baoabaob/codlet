//! Read-only static-manifest discovery for registered plugin packages. This never
//! downloads packages or mutates registrations, grants, or lifecycle receipts.
use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(test)]
use crate::github_distribution::GitHubSource;
use crate::github_distribution::{
    CachedManifest, GitHubClient, GitHubRepository, ManifestFetchError, ReleaseCatalog,
};
use crate::plugin_update_manifest::default_manifest_url;
use crate::plugin_update_source::PluginUpdateSource;
use crate::plugins::PluginRegistry;
use crate::runtime_update::newer_version;
use futures_util::StreamExt;
use serde::Serialize;

const MAX_PLUGINS: usize = 128;
const MIN_CHECK_INTERVAL_MS: u64 = 60_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginReleaseStatus {
    pub version_key: String,
    pub status: &'static str,
    pub release_tag: Option<String>,
    pub release_url: Option<String>,
    pub error: Option<String>,
    pub checked_at: Option<u64>,
    pub next_check_at: Option<u64>,
    pub cached: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginUpdateStatus {
    pub phase: &'static str,
    pub checked_at: Option<u64>,
    pub plugins: BTreeMap<String, PluginReleaseStatus>,
    pub error: Option<String>,
}
impl Default for PluginUpdateStatus {
    fn default() -> Self {
        Self {
            phase: "idle",
            checked_at: None,
            plugins: BTreeMap::new(),
            error: None,
        }
    }
}
struct Owner {
    registry: Arc<PathBuf>,
    started: AtomicBool,
    status: Mutex<PluginUpdateStatus>,
}
#[derive(Clone)]
pub(crate) struct PluginUpdates(Arc<Owner>);

impl PluginUpdates {
    pub(crate) fn new(registry: Arc<PathBuf>) -> Self {
        Self(Arc::new(Owner {
            registry,
            started: AtomicBool::new(false),
            status: Mutex::new(Default::default()),
        }))
    }
    pub(crate) fn start(&self, enabled: bool) {
        // One check per runtime owner, independent of opening the GUI or windows.
        if !self.0.started.swap(true, Ordering::AcqRel) && enabled {
            self.check(false);
        }
    }
    pub(crate) fn status(&self) -> PluginUpdateStatus {
        let mut status = self
            .0
            .status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        // A remove, update or rollback invalidates findings for the old package.
        // Never attach cached repository results to a replacement registration.
        match PluginRegistry::load(self.0.registry.as_ref()) {
            Ok(registry) => status.plugins.retain(|id, value| {
                PluginUpdateSource::load(&registry, id)
                    .is_some_and(|current| current.version_key == value.version_key)
            }),
            Err(_) => {
                status.phase = "failed";
                status.plugins.clear();
                status.error = Some("Plugin registrations could not be read".into());
            }
        }
        status
    }
    pub(crate) fn check(&self, force: bool) -> PluginUpdateStatus {
        {
            let mut state = self.0.status.lock().unwrap_or_else(|e| e.into_inner());
            if state.phase == "checking"
                || state
                    .checked_at
                    .is_some_and(|last| now_ms().saturating_sub(last) < MIN_CHECK_INTERVAL_MS)
            {
                drop(state);
                return self.status();
            }
            state.phase = "checking";
            state.error = None;
        }
        // No strong owner reference is kept by the worker; dropping the runtime
        // cancels in-flight I/O without delaying shutdown or touching other jobs.
        let weak = Arc::downgrade(&self.0);
        let registry = self.0.registry.clone();
        let spawn = std::thread::Builder::new().name("codlet-plugin-updates".into()).spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
                runtime.block_on(async {
                    let client = GitHubClient::new().map_err(|e| e.to_string())?;
                    let work = scan(registry.as_ref(), |repository, url| {
                        let client = client.clone();
                        let path = registry.clone();
                        async move { client.plugin_update_manifest(path.as_ref(), &repository, &url, force).await }
                    });
                    tokio::pin!(work);
                    let deadline = tokio::time::sleep(Duration::from_secs(120));
                    tokio::pin!(deadline);
                    let mut cancellation = tokio::time::interval(Duration::from_millis(100));
                    loop { tokio::select! {
                        result = &mut work => return result,
                        _ = &mut deadline => return Err("Plugin update check timed out; retry or check individual plugins".into()),
                        _ = cancellation.tick() => if weak.strong_count() == 0 { return Err("Plugin update check cancelled".into()); }
                    } }
                })
            })).unwrap_or_else(|_| Err("Plugin update checker failed".into()));
            if let Some(owner) = weak.upgrade() {
                let mut state = owner.status.lock().unwrap_or_else(|e| e.into_inner());
                state.checked_at = Some(now_ms());
                match result {
                    Ok(plugins) => { state.phase = "completed"; state.plugins = plugins; state.error = None; }
                    Err(error) => { state.phase = "failed"; state.error = Some(error); }
                }
            }
        });
        if let Err(error) = spawn {
            let mut state = self.0.status.lock().unwrap_or_else(|e| e.into_inner());
            state.phase = "failed";
            state.error = Some(error.to_string());
        }
        self.status()
    }
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

async fn scan<F, Fut>(
    registry_path: &Path,
    mut fetch: F,
) -> Result<BTreeMap<String, PluginReleaseStatus>, String>
where
    F: FnMut(GitHubRepository, String) -> Fut,
    Fut: Future<Output = Result<CachedManifest, ManifestFetchError>>,
{
    let registry = PluginRegistry::load(registry_path).map_err(|e| e.to_string())?;
    let current = PluginUpdateSource::all(&registry);
    if current.len() > MAX_PLUGINS {
        return Err("Too many managed plugins to check together; check individual plugins".into());
    }
    let mut feeds = BTreeMap::new();
    let mut plugins = Vec::new();
    for (id, version) in current {
        let repository =
            GitHubRepository::parse(&version.channel.repository_url).map_err(|e| e.to_string())?;
        let url = version
            .channel
            .update_manifest
            .as_ref()
            .map(|source| source.manifest_url.clone())
            .unwrap_or_else(|| default_manifest_url(&repository));
        feeds
            .entry(url.clone())
            .or_insert_with(|| repository.clone());
        plugins.push((id, version, repository, url));
    }
    // Monorepos share one feed even when their archive names or signing keys
    // differ. Bound parallelism without the old 32-repository truncation.
    let jobs = feeds
        .into_iter()
        .map(|(url, repository)| {
            let future = fetch(repository, url.clone());
            async move { (url, future.await) }
        })
        .collect::<Vec<_>>();
    let fetched: BTreeMap<_, _> = futures_util::stream::iter(jobs)
        .buffer_unordered(4)
        .collect()
        .await;
    let mut results = BTreeMap::new();
    for (id, version, repository, url) in plugins {
        let mut status = PluginReleaseStatus {
            version_key: version.version_key.clone(),
            status: "unknown",
            release_tag: None,
            release_url: None,
            error: None,
            checked_at: None,
            next_check_at: None,
            cached: false,
        };
        match &fetched[&url] {
            Ok(feed) => {
                status.checked_at = Some(feed.checked_at);
                status.next_check_at = Some(feed.next_check_at);
                status.cached = feed.cached;
                status.error = feed.error.clone();
                let key = version
                    .channel
                    .update_manifest
                    .as_ref()
                    .map(|source| source.public_key.as_str());
                match feed
                    .manifest
                    .latest(&id, &version.comparison_version, &repository, key)
                {
                    Ok(Some(update)) => {
                        status.status = "available";
                        status.release_tag = Some(update.payload.tag.clone());
                        status.release_url = Some(update.release_url());
                    }
                    Ok(None) => status.status = "upToDate",
                    Err(error) => {
                        status.status = "failed";
                        status.error = Some(error);
                        status.checked_at = None;
                        status.cached = false;
                    }
                }
            }
            Err(error) => {
                status.status = "failed";
                status.error = Some(error.message.chars().take(1000).collect());
                status.next_check_at = error.next_check_at;
            }
        }
        results.insert(id.clone(), status);
    }
    Ok(results)
}

fn tag_version(tag: &str) -> &str {
    tag.strip_prefix('v').unwrap_or(tag)
}
#[cfg(test)]
fn select_release(
    source: &GitHubSource,
    catalog: &ReleaseCatalog,
    result: &mut PluginReleaseStatus,
) {
    select_release_version(
        tag_version(&source.tag),
        Some(source.release_id),
        catalog,
        result,
    )
}
#[cfg(test)]
fn select_release_version(
    current: &str,
    release_id: Option<u64>,
    catalog: &ReleaseCatalog,
    result: &mut PluginReleaseStatus,
) {
    if let Some(release) = latest_release_version(current, release_id, catalog) {
        result.status = "available";
        result.release_tag = Some(release.tag.clone());
        result.release_url = Some(release.url.clone());
        return;
    }
    if newer_version(current, current).is_ok()
        && !catalog.truncated
        && catalog
            .releases
            .iter()
            .all(|r| newer_version(tag_version(&r.tag), current).is_ok())
    {
        result.status = "upToDate";
    }
}

pub(crate) fn latest_release_version<'a>(
    current: &str,
    release_id: Option<u64>,
    catalog: &'a ReleaseCatalog,
) -> Option<&'a crate::github_distribution::GitHubRelease> {
    if newer_version(current, current).is_err() {
        return None;
    }
    let accepts_prerelease = current.split('+').next().unwrap_or(current).contains('-');
    let mut candidate: Option<&crate::github_distribution::GitHubRelease> = None;
    for release in &catalog.releases {
        if Some(release.id) == release_id
            || release.prerelease && !accepts_prerelease
            || release.assets.is_empty()
        {
            continue;
        }
        let version = tag_version(&release.tag);
        // Never offer preview builds to a stable installation, even if a
        // publisher forgot to set GitHub's prerelease flag.
        if !accepts_prerelease && version.split('+').next().unwrap_or(version).contains('-') {
            continue;
        }
        match newer_version(version, current) {
            Ok(true)
                if candidate.is_none_or(|old| {
                    newer_version(version, tag_version(&old.tag)).unwrap_or(false)
                }) =>
            {
                candidate = Some(release)
            }
            _ => (),
        }
    }
    candidate
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github_distribution::{GitHubAsset, GitHubRelease};
    use crate::managed_plugins::{ManagedPluginRecord, ManagedVersion};
    use crate::plugins::{LocalPluginRegistration, PluginManifest};
    use serde_json::json;

    fn source() -> GitHubSource {
        serde_json::from_value(json!({"repositoryUrl":"https://github.com/example/notes","owner":"example","repository":"notes","releaseId":1,"tag":"v1.0.0","assetId":11,"assetName":"notes.zip","assetUrl":"https://github.com/example/notes/releases/download/v1.0.0/notes.zip","assetSize":100,"sha256":"a".repeat(64),"upstreamDigestVerified":true})).unwrap()
    }
    fn catalog(tags: &[(&str, bool)]) -> ReleaseCatalog {
        ReleaseCatalog {
            repository: GitHubRepository::parse("https://github.com/example/notes").unwrap(),
            truncated: false,
            requested_tag: None,
            requested_asset: None,
            releases: tags
                .iter()
                .enumerate()
                .map(|(i, (tag, prerelease))| GitHubRelease {
                    id: i as u64 + 20,
                    tag: tag.to_string(),
                    name: tag.to_string(),
                    url: format!("https://github.com/example/notes/releases/tag/{tag}"),
                    prerelease: *prerelease,
                    published_at: None,
                    assets: vec![GitHubAsset {
                        id: i as u64 + 100,
                        name: "notes.zip".into(),
                        size: 100,
                        content_type: "application/zip".into(),
                        download_url:
                            "https://github.com/example/notes/releases/download/v2.0.0/notes.zip"
                                .into(),
                        digest: None,
                        download_count: None,
                    }],
                })
                .collect(),
        }
    }
    fn selection(tag: &str, releases: &ReleaseCatalog) -> PluginReleaseStatus {
        let mut source = source();
        source.tag = tag.into();
        let mut result = PluginReleaseStatus {
            version_key: "a".repeat(64),
            status: "unknown",
            release_tag: None,
            release_url: None,
            error: None,
            checked_at: None,
            next_check_at: None,
            cached: false,
        };
        select_release(&source, releases, &mut result);
        result
    }
    fn registered(root: &Path, ids: &[&str]) -> PathBuf {
        let path = root.join("registry.json");
        let mut registry = PluginRegistry::load(&path).unwrap();
        for id in ids {
            let folder = root.join(id);
            let manifest=PluginManifest::parse(&json!({"schema":1,"id":id,"version":"1.0.0","renderer":{"entry":"renderer.js","world":"isolated"},"permissions":[],"provides":[],"requires":[]}).to_string()).unwrap();
            let version = ManagedVersion {
                version_key: "a".repeat(64),
                package_path: folder.clone(),
                content_digest: "b".repeat(64),
                source: source(),
                manifest,
                metadata: None,
            };
            registry
                .register_managed(
                    id,
                    LocalPluginRegistration {
                        path: folder,
                        grants: vec![],
                        broker_policy: Default::default(),
                    },
                    ManagedPluginRecord {
                        current_version: Some(version.version_key.clone()),
                        history: vec![version],
                    },
                )
                .unwrap();
        }
        registry.save().unwrap();
        path
    }
    fn manifest(repository: &GitHubRepository, ids: &[&str]) -> CachedManifest {
        let entries = ids
            .iter()
            .map(|id| {
                let mut payload = crate::plugin_update_manifest::tests::entry(id, "2.0.0").payload;
                payload.repository_url = repository.url.clone();
                payload.asset.url = format!(
                    "{}/releases/download/v2.0.0/{}-2.0.0.zip",
                    repository.url, id
                );
                crate::plugin_update_manifest::tests::sign(payload)
            })
            .collect();
        CachedManifest {
            manifest: crate::plugin_update_manifest::tests::feed(entries),
            checked_at: 10,
            next_check_at: 20,
            cached: false,
            error: None,
        }
    }
    #[test]
    fn selects_highest_stable_tag_and_does_not_treat_build_or_older_releases_as_updates() {
        let releases = catalog(&[
            ("v2.0.0", false),
            ("v11.0.0-rc.1", true),
            ("v3.0.0", false),
            ("v10.0.0-beta.1", false),
            ("v0.9.0", false),
        ]);
        assert_eq!(
            selection("v1.0.0", &releases).release_tag.as_deref(),
            Some("v3.0.0")
        );
        assert_eq!(selection("v3.0.0", &releases).status, "upToDate");
        assert_eq!(
            selection("v3.0.0+build.4", &catalog(&[("v3.0.0+build.5", false)])).status,
            "upToDate"
        );
        assert_eq!(
            selection("v3.0.0-beta.2", &catalog(&[("v3.0.0-beta.10", true)]))
                .release_tag
                .as_deref(),
            Some("v3.0.0-beta.10")
        );
    }
    #[test]
    fn custom_tags_truncated_catalogs_and_absent_packages_do_not_invent_available_updates() {
        assert_eq!(
            selection("nightly", &catalog(&[("v2.0.0", false)])).status,
            "unknown"
        );
        assert_eq!(
            selection("v1.0.0", &catalog(&[("nightly", false)])).status,
            "unknown"
        );
        let mut releases = catalog(&[("v2.0.0", false)]);
        releases.releases[0].assets.clear();
        assert_ne!(selection("v1.0.0", &releases).status, "available");
        releases.truncated = true;
        assert_eq!(selection("v1.0.0", &releases).status, "unknown");
    }
    #[tokio::test]
    async fn checks_each_repository_once_excludes_unregistered_history_and_never_writes() {
        let root = tempfile::tempdir().unwrap();
        let path = registered(root.path(), &["notes.a", "notes.b", "notes.removed"]);
        let mut registry = PluginRegistry::load(&path).unwrap();
        registry.remove_local("notes.removed").unwrap();
        registry.save().unwrap();
        let before = std::fs::read(&path).unwrap();
        let mut calls = 0;
        let results = scan(&path, |repository, url| {
            calls += 1;
            assert_eq!(repository.url, "https://github.com/example/notes");
            assert_eq!(
                url,
                "https://github.com/example/notes/releases/latest/download/codlet-updates.json"
            );
            async move { Ok(manifest(&repository, &["notes.a", "notes.b"])) }
        })
        .await
        .unwrap();
        assert_eq!(calls, 1);
        assert_eq!(results.len(), 2);
        assert!(results.values().all(|r| r.status == "available"));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let service = PluginUpdates::new(Arc::new(path.clone()));
        service.0.status.lock().unwrap().plugins = results;
        registry.remove_local("notes.a").unwrap();
        registry.save().unwrap();
        assert!(!service.status().plugins.contains_key("notes.a"));
        // A rollback or replacement version key invalidates a cached release.
        service
            .0
            .status
            .lock()
            .unwrap()
            .plugins
            .get_mut("notes.b")
            .unwrap()
            .version_key = "c".repeat(64);
        assert!(service.status().plugins.is_empty());
    }
    #[tokio::test]
    async fn installer_channel_participates_in_checks_and_changed_identity_invalidates_results() {
        let root = tempfile::tempdir().unwrap();
        let registry = crate::plugin_update_source::fixture_seed(root.path(), "dev.seed");
        let before = std::fs::read(registry.path()).unwrap();
        let results = scan(registry.path(), |repository, url| async move {
            assert_eq!(repository.url, "https://github.com/dev-owner/dev-repo");
            assert_eq!(
                url,
                "https://github.com/dev-owner/dev-repo/releases/latest/download/codlet-updates.json"
            );
            Ok(manifest(&repository, &["dev.seed"]))
        })
        .await
        .unwrap();
        assert_eq!(results["dev.seed"].status, "available");
        assert_eq!(std::fs::read(registry.path()).unwrap(), before);
        let service = PluginUpdates::new(Arc::new(registry.path().to_owned()));
        service.0.status.lock().unwrap().plugins = results;
        let receipt = root
            .path()
            .join(".official-seed-transactions/dev.seed.receipt.json");
        let mut value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&receipt).unwrap()).unwrap();
        value["package"]["updateSource"]["repositoryId"] = json!(43);
        std::fs::write(receipt, value.to_string()).unwrap();
        assert!(service.status().plugins.is_empty());
    }
    #[tokio::test]
    async fn network_failure_is_reported_without_claiming_a_plugin_is_current() {
        let root = tempfile::tempdir().unwrap();
        let path = registered(root.path(), &["notes.test"]);
        let result = scan(&path, |_, _| async { Err("GitHub rate limit".into()) })
            .await
            .unwrap();
        assert_eq!(result["notes.test"].status, "failed");
        assert_eq!(
            result["notes.test"].error.as_deref(),
            Some("GitHub rate limit")
        );
    }
    #[tokio::test]
    async fn community_plugins_share_feeds_and_stale_results_keep_their_original_check_time() {
        let root = tempfile::tempdir().unwrap();
        let ids: Vec<_> = (0..20)
            .map(|index| format!("community.tool{index}"))
            .collect();
        let references: Vec<_> = ids.iter().map(String::as_str).collect();
        let path = registered(root.path(), &references);
        let mut calls = 0;
        let results = scan(&path, |repository, _| {
            calls += 1;
            let mut previous = manifest(&repository, &references);
            previous.cached = true;
            previous.error = Some("Update source is temporarily unavailable.".into());
            async move { Ok(previous) }
        })
        .await
        .unwrap();
        assert_eq!(calls, 1);
        assert_eq!(results.len(), 20);
        assert!(results.values().all(|result| result.status == "available"
            && result.cached
            && result.checked_at == Some(10)
            && result.error.is_some()));
        assert!(results.keys().all(|id| id.starts_with("community.")));
    }
    #[test]
    fn startup_preference_is_once_per_owner_and_manual_checks_still_work() {
        let root = tempfile::tempdir().unwrap();
        let path = registered(root.path(), &[]);
        let service = PluginUpdates::new(Arc::new(path));
        service.start(false);
        service.start(true);
        assert_eq!(service.status().phase, "idle");
        service.check(true);
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while service.status().phase == "checking" && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let checked = service.status();
        assert_eq!(checked.phase, "completed");
        assert!(checked.plugins.is_empty());
        service.start(true);
        assert_eq!(service.check(false).checked_at, checked.checked_at);
        // Manual refresh never bypasses the minimum interval, including when
        // persistent cache writes are unavailable.
        service.0.status.lock().unwrap().phase = "failed";
        assert_eq!(service.check(true).phase, "failed");
        service.0.status.lock().unwrap().checked_at = Some(now_ms() - MIN_CHECK_INTERVAL_MS - 1);
        assert_ne!(service.check(true).phase, "failed");
    }
}
