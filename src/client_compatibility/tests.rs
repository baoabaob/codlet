use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn plugins() -> Value {
    json!([
        {"id":"codex.desktop.adapter","version":"0.2.8","active":true},
        {"id":"codex.ui.adapter","version":"0.1.10","active":true}
    ])
}

#[test]
fn published_catalog_is_valid_and_can_advance_without_changing_the_baseline() {
    let baseline = parse_catalog(BASELINE.as_bytes()).unwrap();
    let published = parse_catalog(include_bytes!(
        "../../compatibility/tested-client-versions.json"
    ))
    .unwrap();
    assert!(published.revision >= baseline.revision);
}

#[test]
fn public_management_observes_cached_records_and_changed_adapter_state_without_mutations() {
    use crate::runtime_control::ControlBroker;
    use crate::runtime_manage::RuntimeManageService;
    let temp = tempfile::tempdir().unwrap();
    let registry = temp.path().join("config.json");
    save_state(&cache_path(&registry), updated_catalog());
    let broker = ControlBroker::new([83; 16], "compatibility-read-only".into());
    let service =
        RuntimeManageService::new(broker.clone()).with_local_management(registry.clone(), false);
    service.observe_client_version("26.999.1.0");
    service.publish_list(json!({"plugins":plugins()}));
    let first = service.invoke("versionStatus", Value::Null).unwrap();
    assert_eq!(first["clientStatus"]["source"], "remote-cache");
    assert_eq!(first["clientStatus"]["matchesRunningClient"], true);
    for input in [
        json!({"url":"https://other.invalid/records"}),
        json!({"path":"other"}),
    ] {
        assert_eq!(
            service
                .invoke("checkClientCompatibility", input)
                .unwrap_err()
                .code,
            "invalid_params"
        );
    }
    let mut changed = plugins();
    changed[0]["active"] = json!(false);
    service.publish_list(json!({"plugins":changed}));
    assert_eq!(
        service.invoke("versionStatus", Value::Null).unwrap()["clientStatus"]["status"],
        "requirements-unmet"
    );
    service.stop_client_version_checks();
    assert_eq!(
        service
            .invoke("checkClientCompatibility", Value::Null)
            .unwrap()["source"],
        "remote-cache"
    );
    assert!(broker.take_next().is_none());
    assert!(!registry.exists());
}
fn updated_catalog() -> Catalog {
    let mut catalog = parse_catalog(BASELINE.as_bytes()).unwrap();
    catalog.revision += 1;
    let mut record = catalog.records.last().unwrap().clone();
    record.client_version = "26.999.1.0".into();
    catalog.records.push(record);
    catalog
}
fn catalog_bytes(catalog: &Catalog) -> Vec<u8> {
    serde_json::to_vec(catalog).unwrap()
}
fn save_state(path: &Path, catalog: Catalog) -> State {
    let mut state = State::load(path);
    state
        .accept(
            Fetched {
                catalog: Some(catalog),
                etag: Some("\"fixture-v2\"".into()),
            },
            path,
        )
        .unwrap();
    state
}

struct Server {
    url: String,
    requests: Arc<Mutex<Vec<String>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn server(responses: Vec<Option<Vec<u8>>>) -> Server {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://{}/compatibility.json",
        listener.local_addr().unwrap()
    );
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = requests.clone();
    let task = tokio::spawn(async move {
        for response in responses {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0u8; 1024];
                let read = stream.read(&mut chunk).await.unwrap();
                if read == 0 {
                    break;
                }
                bytes.extend_from_slice(&chunk[..read]);
                assert!(bytes.len() <= 8192);
                if bytes.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    break;
                }
            }
            recorded
                .lock()
                .unwrap()
                .push(String::from_utf8(bytes).unwrap());
            if let Some(response) = response {
                let _ = stream.write_all(&response).await;
                let _ = stream.shutdown().await;
            } else {
                std::future::pending::<()>().await;
            }
        }
    });
    Server {
        url,
        requests,
        task,
    }
}
fn response(code: u16, body: &[u8], headers: &str) -> Vec<u8> {
    let mut bytes = format!(
        "HTTP/1.1 {code} fixture\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n",
        body.len()
    )
    .into_bytes();
    bytes.extend_from_slice(body);
    bytes
}
async fn wait_for(predicate: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !predicate() {
        assert!(Instant::now() < deadline, "fixture condition timed out");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[test]
fn acceptance_is_platform_specific_and_requires_current_core_and_active_adapters() {
    let temp = tempfile::tempdir().unwrap();
    let state = State::load(&temp.path().join("cache.json"));
    let check = |platform: &str, core: &str, plugins: &Value| {
        status(&state, "26.930.2377.0", platform, core, plugins)
    };
    assert_eq!(
        check("windows-x86_64", "0.2.0-preview.24", &plugins())["status"],
        "matched"
    );
    assert_eq!(
        check("windows-aarch64", "0.2.0-preview.24", &plugins())["adaptedVersions"],
        json!([])
    );
    assert_eq!(
        check("macos-aarch64", "0.2.0-preview.24", &plugins())["matchesRunningClient"],
        false
    );
    assert_eq!(
        check("windows-x86_64", "0.2.0-preview.21", &plugins())["missingRequirements"][0]["kind"],
        "core"
    );
    let mut old = plugins();
    old[0]["version"] = json!("0.2.7");
    assert_eq!(
        check("windows-x86_64", "0.2.0-preview.24", &old)["matchesRunningClient"],
        false
    );
    old[0]["version"] = json!("0.2.8");
    old[0]["active"] = json!(false);
    assert_eq!(
        check("windows-x86_64", "0.2.0-preview.24", &old)["status"],
        "requirements-unmet"
    );
    let value = check("windows-x86_64", "0.2.0-preview.24", &plugins());
    for field in [
        "latestVersion",
        "officialUpdateAvailable",
        "installedVersion",
    ] {
        assert!(value.get(field).is_none());
    }
}

#[test]
fn manifests_reject_wrong_identity_unknown_fields_duplicates_and_unverified_requirements() {
    let original: Value = serde_json::from_str(BASELINE).unwrap();
    let mut malformed = original.clone();
    malformed["repository"] = json!("other/repository");
    assert!(parse_catalog(malformed.to_string().as_bytes()).is_err());
    malformed = original.clone();
    malformed["execute"] = json!("anything");
    assert!(parse_catalog(malformed.to_string().as_bytes()).is_err());
    malformed = original.clone();
    let duplicate = malformed["records"][0].clone();
    malformed["records"].as_array_mut().unwrap().push(duplicate);
    assert!(parse_catalog(malformed.to_string().as_bytes()).is_err());
    malformed = original;
    malformed["records"][3]["requiredAdapters"]["codex.desktop.adapter"] = json!("9.9.9");
    assert!(parse_catalog(malformed.to_string().as_bytes()).is_err());
    assert!(parse_catalog(&vec![b' '; MAX_BYTES + 1]).is_err());
}

#[test]
fn remote_records_survive_restart_and_older_or_reused_revisions_preserve_the_cache() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("cache.json");
    let catalog = updated_catalog();
    let mut state = save_state(&path, catalog.clone());
    let restart = State::load(&path);
    assert_eq!(restart.source, "remote-cache");
    assert_eq!(
        status(
            &restart,
            "26.999.1.0",
            "windows-x86_64",
            "0.2.0-preview.24",
            &plugins()
        )["status"],
        "matched"
    );
    let bytes = std::fs::read(&path).unwrap();
    let old = parse_catalog(BASELINE.as_bytes()).unwrap();
    assert!(
        state
            .accept(
                Fetched {
                    catalog: Some(old),
                    etag: None
                },
                &path
            )
            .is_err()
    );
    let mut reused = catalog;
    reused.records.pop();
    assert!(
        state
            .accept(
                Fetched {
                    catalog: Some(reused),
                    etag: None
                },
                &path
            )
            .is_err()
    );
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(state.catalog, restart.catalog);
}

#[test]
fn corrupt_foreign_future_or_oversized_caches_fall_back_to_the_bundled_baseline() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("cache.json");
    save_state(&path, updated_catalog());
    let original: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    for (field, value) in [
        ("sourceUrl", json!("https://elsewhere.invalid/catalog")),
        ("checkedAtUnixMs", json!(unix_ms() + 3600 * 1000)),
        ("etag", json!("bad\r\nheader")),
    ] {
        let mut changed = original.clone();
        changed[field] = value;
        std::fs::write(&path, changed.to_string()).unwrap();
        let state = State::load(&path);
        assert_eq!(state.source, "local-package");
        assert!(state.error.is_some());
    }
    std::fs::write(&path, b"broken").unwrap();
    assert_eq!(State::load(&path).source, "local-package");
    std::fs::write(&path, vec![b' '; MAX_CACHE_BYTES + 1]).unwrap();
    assert!(read_cache(&path, unix_ms()).is_err());
}

#[tokio::test]
async fn real_http_refresh_uses_etag_without_credentials_and_304_keeps_records() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("cache.json");
    let catalog = updated_catalog();
    let server = server(vec![
        Some(response(
            200,
            &catalog_bytes(&catalog),
            "ETag: \"fixture-v2\"\r\n",
        )),
        Some(response(304, b"", "")),
    ])
    .await;
    let mut state = State::load(&path);
    state
        .accept(fetch(&server.url, None).await.unwrap(), &path)
        .unwrap();
    state
        .accept(
            fetch(&server.url, state.etag.as_deref()).await.unwrap(),
            &path,
        )
        .unwrap();
    assert_eq!(State::load(&path).catalog, catalog);
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(
        requests[1]
            .to_lowercase()
            .contains("if-none-match: \"fixture-v2\"")
    );
    assert!(
        requests
            .iter()
            .all(|request| !request.to_lowercase().contains("authorization:")
                && !request.to_lowercase().contains("cookie:"))
    );
}

#[tokio::test]
async fn malformed_failed_redirected_and_oversized_http_never_replace_good_records() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("cache.json");
    let state = save_state(&path, updated_catalog());
    let expected = std::fs::read(&path).unwrap();
    let oversized_header = format!(
        "HTTP/1.1 200 fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        MAX_BYTES + 1
    )
    .into_bytes();
    let body = vec![b' '; MAX_BYTES + 1];
    let mut chunked =
        b"HTTP/1.1 200 fixture\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n".to_vec();
    chunked.extend_from_slice(format!("{:x}\r\n", body.len()).as_bytes());
    chunked.extend_from_slice(&body);
    chunked.extend_from_slice(b"\r\n0\r\n\r\n");
    let responses = vec![
        response(200, b"{}", ""),
        response(500, b"error", ""),
        response(302, b"", "Location: https://example.invalid/other\r\n"),
        oversized_header,
        chunked,
    ];
    let count = responses.len();
    let server = server(responses.into_iter().map(Some).collect()).await;
    for _ in 0..count {
        assert!(fetch(&server.url, state.etag.as_deref()).await.is_err());
    }
    assert_eq!(std::fs::read(&path).unwrap(), expected);
    assert_eq!(server.requests.lock().unwrap().len(), count);
}

#[tokio::test]
async fn disabled_automatic_checks_allow_one_coalesced_manual_refresh() {
    let temp = tempfile::tempdir().unwrap();
    let registry = temp.path().join("config.json");
    let settings = RuntimeSettings::for_registry(&registry);
    let mut values = settings.cached().unwrap().values;
    values.automatic_update_checks = false;
    settings.save(0, values).unwrap();
    let server = server(vec![Some(response(
        200,
        &catalog_bytes(&updated_catalog()),
        "",
    ))])
    .await;
    let service = ClientCompatibility::new("26.999.1.0", &registry, Some(settings));
    service.start_with_source(&server.url);
    wait_for(|| service.status(&plugins())["compatibilityCatalog"]["phase"] == "disabled").await;
    assert!(server.requests.lock().unwrap().is_empty());
    for _ in 0..10 {
        service.check();
    }
    wait_for(|| service.status(&plugins())["source"] == "remote-manifest").await;
    assert_eq!(service.status(&plugins())["matchesRunningClient"], true);
    service.check();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    service.stop();
}

#[tokio::test]
async fn fresh_cache_skips_startup_network_and_new_client_refreshes_even_with_fresh_cache() {
    let temp = tempfile::tempdir().unwrap();
    let registry = temp.path().join("config.json");
    save_state(&cache_path(&registry), updated_catalog());
    let settings = RuntimeSettings::for_registry(&registry);
    let server = server(vec![Some(response(304, b"", ""))]).await;
    let known = ClientCompatibility::new("26.930.2377.0", &registry, Some(settings.clone()));
    known.start_with_source(&server.url);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(server.requests.lock().unwrap().is_empty());
    known.stop();
    let unknown = ClientCompatibility::new("26.999.2.0", &registry, Some(settings));
    unknown.start_with_source(&server.url);
    wait_for(|| unknown.status(&plugins())["source"] == "remote-manifest").await;
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    assert_eq!(unknown.status(&plugins())["matchesRunningClient"], false);
    unknown.stop();
}

#[tokio::test]
async fn changed_automatic_preference_updates_metadata_state_without_a_restart() {
    let temp = tempfile::tempdir().unwrap();
    let registry = temp.path().join("config.json");
    save_state(&cache_path(&registry), updated_catalog());
    let settings = RuntimeSettings::for_registry(&registry);
    let mut values = settings.cached().unwrap().values;
    values.automatic_update_checks = false;
    settings.save(0, values.clone()).unwrap();
    let server = server(vec![None]).await;
    let service = ClientCompatibility::new("26.930.2377.0", &registry, Some(settings.clone()));
    service.start_with_source(&server.url);
    wait_for(|| service.status(&plugins())["compatibilityCatalog"]["phase"] == "disabled").await;
    values.automatic_update_checks = true;
    settings.save(1, values).unwrap();
    wait_for(|| service.status(&plugins())["compatibilityCatalog"]["phase"] == "idle").await;
    assert!(server.requests.lock().unwrap().is_empty());
    service.stop();
}

#[tokio::test]
async fn unreachable_source_retains_cached_acceptance_and_stopping_cancels_a_hanging_fetch() {
    let temp = tempfile::tempdir().unwrap();
    let registry = temp.path().join("config.json");
    let settings = RuntimeSettings::for_registry(&registry);
    let server = server(vec![None]).await;
    let service = ClientCompatibility::new("26.930.2377.0", &registry, Some(settings));
    service.start_with_source(&server.url);
    wait_for(|| !server.requests.lock().unwrap().is_empty()).await;
    assert_eq!(service.status(&plugins())["source"], "local-package");
    assert_eq!(service.status(&plugins())["matchesRunningClient"], true);
    let started = Instant::now();
    service.stop();
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(service.0.worker.lock().unwrap().is_none());
    let cached = save_state(&cache_path(&registry), updated_catalog());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/missing", listener.local_addr().unwrap());
    drop(listener);
    assert!(fetch(&url, cached.etag.as_deref()).await.is_err());
    assert_eq!(State::load(&cache_path(&registry)).catalog, cached.catalog);
}
