use super::*;
use crate::github_distribution::tests::{Fixture, response, zip_files};
use crate::managed_plugins::ManagedOperation;
use crate::plugin_update_manifest::{
    UpdateManifestSource, default_manifest_url,
    tests::{entry, feed, sign},
};

fn repository() -> GitHubRepository {
    GitHubRepository::parse("https://github.com/example/plugins").unwrap()
}
fn feed_response() -> Vec<u8> {
    response(
        "200 OK",
        "ETag: \"feed-1\"\r\n",
        &serde_json::to_vec(&feed(vec![entry("community.notes", "2.0.0")])).unwrap(),
    )
}
fn allow_refresh(path: &Path, url: &str) {
    let file = cache_path(path, url).unwrap();
    let mut cache: Cache = read_cache(Some(&file)).unwrap();
    cache.attempted_at = now_ms() - MIN_CHECK_INTERVAL_MS - 1;
    cache.next_check_at = 0;
    write_cache(Some(&file), &cache).unwrap();
}

#[test]
fn retry_times_accept_http_dates_and_never_shortcut_an_exhausted_quota_reset() {
    let now = 1_792_512_000_000;
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("retry-after", "120".parse().unwrap());
    assert_eq!(retry_time(&headers, 429, now), Some(now + 120_000));
    headers.insert("x-ratelimit-remaining", "0".parse().unwrap());
    headers.insert(
        "x-ratelimit-reset",
        ((now + 3_600_000) / 1000).to_string().parse().unwrap(),
    );
    assert_eq!(retry_time(&headers, 403, now), Some(now + 3_600_000));
    headers.remove("x-ratelimit-remaining");
    assert_eq!(retry_time(&headers, 429, now), Some(now + 120_000));
    headers.insert(
        "retry-after",
        httpdate::fmt_http_date(UNIX_EPOCH + Duration::from_millis(now + 300_000))
            .parse()
            .unwrap(),
    );
    assert_eq!(retry_time(&headers, 503, now), Some(now + 300_000));
    assert_eq!(retry_time(&headers, 404, now), None);
}

#[tokio::test]
async fn persistent_cache_coalesces_restarts_and_manual_checks_then_revalidates_with_etag() {
    let root = tempfile::tempdir().unwrap();
    let registry = root.path().join("config.json");
    let repo = repository();
    let url = default_manifest_url(&repo);
    let server = Fixture::new(vec![
        feed_response(),
        response("304 Not Modified", "ETag: \"feed-1\"\r\n", b""),
        response("503 Unavailable", "", b""),
    ]);
    let first = server
        .client()
        .plugin_update_manifest(&registry, &repo, &url, false)
        .await
        .unwrap();
    assert!(!first.cached);
    assert!(
        server
            .client()
            .plugin_update_manifest(&registry, &repo, &url, false)
            .await
            .unwrap()
            .cached
    );
    assert!(
        server
            .client()
            .plugin_update_manifest(&registry, &repo, &url, true)
            .await
            .unwrap()
            .cached
    );
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    allow_refresh(&registry, &url);
    assert!(
        server
            .client()
            .plugin_update_manifest(&registry, &repo, &url, false)
            .await
            .unwrap()
            .cached
    );
    let refreshed = server
        .client()
        .plugin_update_manifest(&registry, &repo, &url, true)
        .await
        .unwrap();
    assert!(!refreshed.cached);
    assert!(refreshed.error.is_none());
    allow_refresh(&registry, &url);
    let stale = server
        .client()
        .plugin_update_manifest(&registry, &repo, &url, true)
        .await
        .unwrap();
    assert!(stale.cached);
    assert_eq!(stale.checked_at, refreshed.checked_at);
    assert!(stale.error.as_deref().unwrap().contains("503"));
    assert!(
        server
            .client()
            .plugin_update_manifest(&registry, &repo, &url, true)
            .await
            .unwrap()
            .cached
    );
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(
        requests[1]
            .to_lowercase()
            .contains("if-none-match: \"feed-1\"")
    );
    for request in requests.iter() {
        assert!(
            request
                .starts_with("GET /example/plugins/releases/latest/download/codlet-updates.json ")
        );
        assert!(!request.to_lowercase().contains("authorization:"));
        assert!(!request.to_lowercase().contains("x-github-api-version:"));
    }
}

#[tokio::test]
async fn server_cooldown_is_shared_by_other_repository_checks_and_survives_new_clients() {
    let root = tempfile::tempdir().unwrap();
    let registry = root.path().join("config.json");
    let server = Fixture::new(vec![response(
        "429 Too Many Requests",
        "Retry-After: 3600\r\n",
        b"",
    )]);
    let repo = repository();
    assert!(
        server
            .client()
            .plugin_update_manifest(&registry, &repo, &default_manifest_url(&repo), true)
            .await
            .is_err()
    );
    for index in 0..20 {
        let repo = GitHubRepository::parse(&format!("https://github.com/community/plugin{index}"))
            .unwrap();
        let error = server
            .client()
            .plugin_update_manifest(&registry, &repo, &default_manifest_url(&repo), true)
            .await
            .err()
            .unwrap();
        assert!(error.message.contains("limiting requests"));
        assert!(error.next_check_at.unwrap() > now_ms());
    }
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn missing_feeds_and_api_redirects_never_fall_back_to_rest_discovery() {
    for response_bytes in [
        response("404 Not Found", "", b""),
        response(
            "302 Found",
            "Location: https://api.github.com/repos/example/plugins/releases\r\n",
            b"",
        ),
    ] {
        let root = tempfile::tempdir().unwrap();
        let registry = root.path().join("config.json");
        let repo = repository();
        let url = default_manifest_url(&repo);
        let server = Fixture::new(vec![response_bytes]);
        assert!(
            server
                .client()
                .plugin_update_manifest(&registry, &repo, &url, true)
                .await
                .is_err()
        );
        assert!(
            server
                .client()
                .plugin_update_manifest(&registry, &repo, &url, true)
                .await
                .is_err()
        );
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn twenty_community_repositories_use_twenty_file_gets_and_no_api_requests() {
    let root = tempfile::tempdir().unwrap();
    let registry = root.path().join("config.json");
    let mut repositories = Vec::new();
    let mut responses = Vec::new();
    for index in 0..20 {
        let repo = GitHubRepository::parse(&format!("https://github.com/community/plugin{index}"))
            .unwrap();
        let mut payload = entry(&format!("community.tool{index}"), "2.0.0").payload;
        payload.repository_url = repo.url.clone();
        payload.asset.url = format!(
            "{}/releases/download/v2.0.0/{}",
            repo.url, payload.asset.name
        );
        responses.push(response(
            "200 OK",
            "",
            &serde_json::to_vec(&feed(vec![sign(payload)])).unwrap(),
        ));
        repositories.push(repo);
    }
    let server = Fixture::new(responses);
    let client = server.client();
    for repo in &repositories {
        client
            .plugin_update_manifest(&registry, repo, &default_manifest_url(repo), false)
            .await
            .unwrap();
    }
    for repo in &repositories {
        assert!(
            server
                .client()
                .plugin_update_manifest(&registry, repo, &default_manifest_url(repo), true)
                .await
                .unwrap()
                .cached
        );
    }
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 20);
    assert!(
        requests
            .iter()
            .all(|request| request.starts_with("GET /community/plugin")
                && request.contains("/releases/latest/download/codlet-updates.json "))
    );
}

fn package(
    id: &str,
    version: &str,
    source: &UpdateManifestSource,
    extra_permission: bool,
) -> Vec<u8> {
    let permissions = if extra_permission {
        vec!["ui.dom", "runtime.manage"]
    } else {
        vec!["ui.dom"]
    };
    let manifest = serde_json::to_vec(&serde_json::json!({
        "schema":1,"id":id,"version":version,
        "renderer":{"entry":"entry.js","world":"isolated"},"permissions":permissions
    }))
    .unwrap();
    let configuration = serde_json::to_vec(source).unwrap();
    zip_files(&[
        ("codlet.json", &manifest),
        ("codlet-update.json", &configuration),
        (
            "entry.js",
            b"throw new Error('download must never execute plugin code');",
        ),
    ])
}

#[tokio::test]
async fn signed_update_downloads_directly_and_keeps_permissions_and_managed_receipts() {
    use crate::plugins::{Permission, PluginRegistry};
    for extra_permission in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("config.json");
        let registry = PluginRegistry::load(&path).unwrap();
        let repo = GitHubRepository::parse("https://github.com/dev-owner/dev-repo").unwrap();
        let id = "community.notes";
        let source = UpdateManifestSource {
            schema: 1,
            manifest_url: default_manifest_url(&repo),
            public_key: entry(id, "1.0.0").public_key,
        };
        let original = package(id, "1.0.0", &source, false);
        let original = crate::github_distribution::test_prepare_archive_identity(
            &path,
            &original,
            Some((42, 7)),
        )
        .unwrap();
        let preview = crate::managed_plugins::preview(
            &registry,
            &original.package_path,
            ManagedOperation::Install,
        )
        .unwrap();
        let (mut registry, _) = crate::managed_plugins::stage(
            &registry,
            id,
            &preview.request(vec![Permission::UiDom], Default::default(), false),
        )
        .unwrap();
        registry.save().unwrap();
        let expected =
            crate::plugin_update_source::PluginUpdateSource::load(&registry, id).unwrap();
        assert_eq!(expected.channel.update_manifest, Some(source.clone()));
        let archive = package(id, "2.0.0", &source, extra_permission);
        let mut payload = entry(id, "2.0.0").payload;
        payload.repository_url = repo.url.clone();
        payload.asset.url = format!(
            "{}/releases/download/v2.0.0/{}",
            repo.url, payload.asset.name
        );
        payload.asset.bytes = archive.len() as u64;
        payload.asset.sha256 = format!("{:x}", Sha256::digest(&archive));
        let update = sign(payload);
        let server = Fixture::new(vec![
            response(
                "200 OK",
                "",
                &serde_json::to_vec(&feed(vec![update.clone()])).unwrap(),
            ),
            response("200 OK", "", &archive),
        ]);
        let before = std::fs::read(&path).unwrap();
        let prepared = crate::plugin_update_install::prepare_latest(
            &server.client(),
            &path,
            id,
            &expected.version_key,
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(prepared.source.update_proof, Some(update));
        assert_eq!(prepared.source.release_id, 0);
        assert_eq!(prepared.source.asset_id, 0);
        assert_eq!(prepared.source.repository_id, Some(42));
        assert!(!prepared.source.upstream_digest_verified);
        assert!(!prepared.existing_enabled);
        assert_eq!(
            prepared.existing_registration.as_ref().unwrap().grants,
            vec![Permission::UiDom]
        );
        assert_eq!(
            crate::plugin_update_install::needs_authority_review(&prepared),
            extra_permission
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(
            requests[0].starts_with(
                "GET /dev-owner/dev-repo/releases/latest/download/codlet-updates.json "
            )
        );
        assert!(requests[1].starts_with(
            "GET /dev-owner/dev-repo/releases/download/v2.0.0/community.notes-2.0.0.zip "
        ));
        drop(requests);
        if !extra_permission {
            let (mut updated, _) = crate::managed_plugins::stage(
                &registry,
                id,
                &prepared.request(vec![Permission::UiDom], Default::default(), false),
            )
            .unwrap();
            updated.save().unwrap();
            crate::managed_plugins::validate_current(&updated, id).unwrap();
            assert_eq!(
                updated.managed_plugins()[id]
                    .current()
                    .unwrap()
                    .manifest
                    .version,
                "2.0.0"
            );
        }
    }
}

#[tokio::test]
async fn legacy_migration_pins_a_key_only_after_verifying_the_existing_repository_identity() {
    use crate::plugins::{Permission, PluginRegistry};
    for changed_repository in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("config.json");
        let registry = PluginRegistry::load(&path).unwrap();
        let repo = GitHubRepository::parse("https://github.com/dev-owner/dev-repo").unwrap();
        let id = "community.notes";
        let old_manifest = serde_json::to_vec(&serde_json::json!({
            "schema":1,"id":id,"version":"1.0.0","renderer":{"entry":"entry.js","world":"isolated"},"permissions":["ui.dom"]
        })).unwrap();
        let old_bytes = zip_files(&[
            ("codlet.json", &old_manifest),
            ("entry.js", b"module.exports={activate(){},deactivate(){}};"),
        ]);
        let old = crate::github_distribution::test_prepare_archive_identity(
            &path,
            &old_bytes,
            Some((42, 7)),
        )
        .unwrap();
        let preview = crate::managed_plugins::preview(
            &registry,
            &old.package_path,
            ManagedOperation::Install,
        )
        .unwrap();
        let (mut registry, _) = crate::managed_plugins::stage(
            &registry,
            id,
            &preview.request(vec![Permission::UiDom], Default::default(), false),
        )
        .unwrap();
        registry.save().unwrap();
        let current = crate::plugin_update_source::PluginUpdateSource::load(&registry, id).unwrap();
        assert!(current.channel.update_manifest.is_none());
        let source = UpdateManifestSource {
            schema: 1,
            manifest_url: default_manifest_url(&repo),
            public_key: entry(id, "2.0.0").public_key,
        };
        let archive = package(id, "2.0.0", &source, false);
        let mut payload = entry(id, "2.0.0").payload;
        payload.repository_url = repo.url.clone();
        payload.asset.url = format!(
            "{}/releases/download/v2.0.0/{}",
            repo.url, payload.asset.name
        );
        payload.asset.bytes = archive.len() as u64;
        payload.asset.sha256 = format!("{:x}", Sha256::digest(&archive));
        let signed = sign(payload);
        let identity = serde_json::json!({
            "id":if changed_repository {43} else {42},
            "html_url":repo.url,"full_name":"dev-owner/dev-repo",
            "owner":{"id":7,"login":"dev-owner"}
        });
        let release = serde_json::json!({
            "id":2,"tag_name":"v2.0.0","name":"Notes 2",
            "html_url":signed.release_url(),"draft":false,"prerelease":false,
            "published_at":"2026-10-20T00:00:00Z",
            "assets":[{
                "id":22,"name":signed.payload.asset.name,"size":archive.len(),
                "content_type":"application/zip","browser_download_url":signed.payload.asset.url,
                "state":"uploaded","digest":format!("sha256:{}",signed.payload.asset.sha256)
            }]
        });
        let mut responses = vec![
            response(
                "200 OK",
                "",
                &serde_json::to_vec(&feed(vec![signed])).unwrap(),
            ),
            response("200 OK", "", &serde_json::to_vec(&identity).unwrap()),
        ];
        if !changed_repository {
            responses.extend([
                response("200 OK", "", &serde_json::to_vec(&release).unwrap()),
                response("200 OK", "", &serde_json::to_vec(&release).unwrap()),
                response("200 OK", "", &serde_json::to_vec(&identity).unwrap()),
                response("200 OK", "", &archive),
            ]);
        }
        let server = Fixture::new(responses);
        let before = std::fs::read(&path).unwrap();
        let result = crate::plugin_update_install::prepare_latest(
            &server.client(),
            &path,
            id,
            &current.version_key,
        )
        .await;
        assert_eq!(std::fs::read(&path).unwrap(), before);
        if changed_repository {
            assert!(result.err().unwrap().contains("identity changed"));
            assert_eq!(server.requests.lock().unwrap().len(), 2);
            assert!(
                crate::plugin_update_source::PluginUpdateSource::load(&registry, id)
                    .unwrap()
                    .channel
                    .update_manifest
                    .is_none()
            );
        } else {
            let prepared = result.unwrap().unwrap();
            assert_eq!(prepared.source.update_source, Some(source.clone()));
            assert!(prepared.source.update_proof.is_none());
            assert_eq!(prepared.source.repository_id, Some(42));
            assert_eq!(prepared.source.release_id, 2);
            let (mut updated, _) = crate::managed_plugins::stage(
                &registry,
                id,
                &prepared.request(vec![Permission::UiDom], Default::default(), false),
            )
            .unwrap();
            updated.save().unwrap();
            assert_eq!(
                crate::plugin_update_source::PluginUpdateSource::load(&updated, id)
                    .unwrap()
                    .channel
                    .update_manifest,
                Some(source)
            );
            let requests = server.requests.lock().unwrap();
            assert_eq!(requests.len(), 6);
            assert!(requests[2].starts_with("GET /repos/dev-owner/dev-repo/releases/tags/v2.0.0 "));
        }
    }
}
