use super::*;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, VecDeque};
use std::io::{Cursor, Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use url::Url;

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn pe(label: &str) -> Vec<u8> {
    let mut bytes = vec![0u8; 128];
    bytes[..2].copy_from_slice(b"MZ");
    bytes[60..64].copy_from_slice(&64u32.to_le_bytes());
    bytes[64..68].copy_from_slice(b"PE\0\0");
    bytes[68..70].copy_from_slice(&0x8664u16.to_le_bytes());
    bytes.extend_from_slice(label.as_bytes());
    bytes
}
fn payload(
    profile: RuntimePayloadProfile,
    version: &str,
    node_version: &str,
    label: &str,
) -> (package::RuntimePackageManifest, BTreeMap<String, Vec<u8>>) {
    let node = pe(&format!("node-{node_version}"));
    let license = b"fixture Node license".to_vec();
    let runtime = package::NodeRuntime {
        version: node_version.into(),
        executable_sha256: sha(&node),
        license_sha256: sha(&license),
    };
    let pin = serde_json::json!({"schema":1,"version":node_version,"baseUrl":"https://nodejs.org/fixture","platforms":{"win-x64":{"executableSha256":runtime.executable_sha256,"licenseSha256":runtime.license_sha256}}});
    let executable = if profile == RuntimePayloadProfile::Portable {
        "codlet.exe"
    } else {
        "codlet-lab.exe"
    };
    let mut files = BTreeMap::new();
    files.insert(executable.into(), pe(label));
    files.insert(
        "runtime/node-runtime.json".into(),
        serde_json::to_vec(&pin).unwrap(),
    );
    files.insert(
        format!("runtime/node-v{node_version}-win-x64/node.exe"),
        node,
    );
    files.insert(
        format!("runtime/node-v{node_version}-win-x64/LICENSE"),
        license,
    );
    let records = files
        .iter()
        .map(|(name, bytes)| package::RuntimeFile {
            path: name.clone(),
            bytes: bytes.len() as u64,
            sha256: sha(bytes),
            mode: None,
        })
        .collect();
    (
        package::RuntimePackageManifest {
            schema: 1,
            kind: "codlet-runtime-update".into(),
            version: version.into(),
            platform: PLATFORM.into(),
            profile,
            runtime,
            files: records,
        },
        files,
    )
}
fn zip_payload(
    manifest: &package::RuntimePackageManifest,
    files: &BTreeMap<String, Vec<u8>>,
    extra: Option<(&str, &[u8])>,
) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, bytes) in files {
        writer.start_file(name, options).unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.start_file(package::MANIFEST, options).unwrap();
    writer
        .write_all(&serde_json::to_vec(manifest).unwrap())
        .unwrap();
    if let Some((name, bytes)) = extra {
        writer.start_file(name, options).unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}
fn candidate(bytes: &[u8], profile: RuntimePayloadProfile) -> source::Candidate {
    source::Candidate {
        public: RuntimeUpdateCandidate {
            id: sha(bytes),
            version: "9.0.0".into(),
            platform: PLATFORM.into(),
            size: bytes.len() as u64,
            sha256: sha(bytes),
            release_url: None,
        },
        profile,
        url: Url::parse("https://cdn.example/runtime.zip").unwrap(),
        origins: BTreeSet::from(["https://cdn.example".into()]),
    }
}
fn channel() -> RuntimeUpdateChannel {
    RuntimeUpdateChannel {
        schema: 1,
        channel: "stable".into(),
        check_interval_seconds: 900,
        source: Some(RuntimeUpdateSource::Https {
            manifest_url: "https://releases.example/stable.json".into(),
            allowed_asset_origins: vec!["https://cdn.example".into()],
        }),
    }
}
fn stage(
    bytes: &[u8],
    profile: RuntimePayloadProfile,
    state_root: &Path,
) -> Result<package::StagedRuntime> {
    let root = package::ensure_state_root(state_root)?;
    let mut file = tempfile::NamedTempFile::new().unwrap();
    file.write_all(bytes).unwrap();
    package::stage_archive(file.path(), &candidate(bytes, profile), &root)
}

#[test]
fn unconfigured_development_is_truthful_offline_and_creates_no_update_directory() {
    let root = tempfile::tempdir().unwrap();
    let state_root = root.path().join("state");
    let service =
        RuntimeUpdateService::start(root.path().into(), state_root.clone(), None).unwrap();
    let status = service.status();
    assert_eq!(status.current_version, CURRENT_VERSION);
    assert_eq!(status.phase, RuntimeUpdatePhase::Development);
    assert!(!status.configured);
    assert!(status.last_checked_at.is_none());
    assert!(status.next_check_at.is_none());
    assert!(status.candidate.is_none());
    assert!(!status.install_available);
    assert_eq!(
        service.download().unwrap_err().code,
        "runtime_update_unconfigured"
    );
    assert_eq!(
        service.request_install().unwrap_err().code,
        "install_unavailable"
    );
    assert_eq!(
        service.check().unwrap().phase,
        RuntimeUpdatePhase::Development
    );
    assert!(!state_root.exists());
    assert_eq!(
        read_channel(root.path()).unwrap().check_interval_seconds,
        900
    );
}

#[test]
fn preference_changes_reschedule_real_worker_without_fetching_and_honor_full_interval_range() {
    use crate::runtime_settings::{RuntimePreferences, SettingsDocument};
    let root = tempfile::tempdir().unwrap();
    let channel_path = if PLATFORM == "darwin-arm64" {
        root.path()
            .join("Codlet.app/Contents/Resources/runtime/update-channel.json")
    } else {
        root.path().join("runtime/update-channel.json")
    };
    std::fs::create_dir_all(channel_path.parent().unwrap()).unwrap();
    std::fs::write(channel_path, serde_json::to_vec(&channel()).unwrap()).unwrap();
    let mut document = SettingsDocument {
        schema: 1,
        revision: 0,
        values: RuntimePreferences {
            automatic_update_checks: false,
            ..Default::default()
        },
    };
    let service = RuntimeUpdateService::start_with_preferences(
        root.path().into(),
        root.path().join("state"),
        None,
        document.clone(),
    )
    .unwrap();
    assert_eq!(service.status().phase, RuntimeUpdatePhase::Idle);
    assert_eq!(service.status().next_check_at, None);
    for interval in [300, 900, 3600, 86400] {
        document.revision += 1;
        document.values.automatic_update_checks = true;
        document.values.update_check_interval_seconds = Some(interval);
        let before = now_ms();
        service.configure_checks(&document).unwrap();
        let next = service.status().next_check_at.unwrap();
        assert!(next >= before + interval * 1000 && next <= now_ms() + interval * 1000 + 2000);
        assert_eq!(check_delay(interval, 0), interval);
        assert!(check_delay(interval, 5) >= interval);
    }
    let active_next = service.status().next_check_at;
    let mut stale = document.clone();
    stale.revision = 0;
    stale.values.automatic_update_checks = false;
    service.configure_checks(&stale).unwrap();
    assert!(service.status().next_check_at.is_some());
    document.revision += 1;
    document.values.automatic_update_checks = false;
    service.configure_checks(&document).unwrap();
    assert_eq!(service.status().next_check_at, None);
    assert!(active_next.is_some());
    assert!(service.status().last_checked_at.is_none());
}

#[test]
fn automatic_check_reservation_cannot_replace_queued_or_downloaded_versions() {
    let root = tempfile::tempdir().unwrap();
    let service =
        RuntimeUpdateService::start(root.path().into(), root.path().join("state"), None).unwrap();
    let mut state = service.shared.lock().unwrap();
    for phase in [
        RuntimeUpdatePhase::Downloading,
        RuntimeUpdatePhase::Downloaded,
        RuntimeUpdatePhase::InstallRequested,
    ] {
        state.status.phase = phase.clone();
        state.busy = true;
        state.automatic_checks = true;
        state.status.candidate =
            Some(candidate(b"fixture", RuntimePayloadProfile::Portable).public);
        let id = state.status.candidate.as_ref().unwrap().id.clone();
        assert!(!reserve_check(&mut state, true, true));
        assert_eq!(state.status.phase, phase);
        assert!(state.busy);
        assert_eq!(state.status.candidate.as_ref().unwrap().id, id);
    }
    state.status.phase = RuntimeUpdatePhase::Checking;
    state.automatic_checks = false;
    state.busy = true;
    assert!(!reserve_check(&mut state, true, true));
    assert!(state.busy);
    assert!(reserve_check(&mut state, true, false));
    assert_eq!(state.status.phase, RuntimeUpdatePhase::Checking);
}

#[test]
fn semantic_version_order_does_not_sort_version_strings_lexically() {
    for (next, current) in [
        ("1.10.0", "1.9.0"),
        ("1.0.0", "1.0.0-rc.9"),
        ("1.0.0-rc.10", "1.0.0-rc.9"),
        ("2.0.0-alpha", "1.9.9"),
    ] {
        assert!(source::newer(next, current).unwrap());
    }
    for (next, current) in [
        ("1.0.0+new", "1.0.0+old"),
        ("1.0.0-alpha", "1.0.0"),
        ("1.0.0-alpha.2", "1.0.0-alpha.10"),
    ] {
        assert!(!source::newer(next, current).unwrap());
    }
    for invalid in [
        "01.2.3",
        "1.2",
        "1.2.3-01",
        "1.2.3+",
        "v1.2.3",
        "1.2.3/../../",
    ] {
        assert!(source::newer(invalid, "0.1.0").is_err());
    }
}

#[cfg(windows)]
#[test]
fn runtime_profiles_stage_only_their_own_executable_and_resume_after_restart() {
    for profile in [
        RuntimePayloadProfile::Portable,
        RuntimePayloadProfile::IsolatedClient,
    ] {
        let temp = tempfile::tempdir().unwrap();
        let state = temp.path().join("updates");
        let (manifest, files) = payload(profile, "9.0.0", "24.21.0", "new");
        let zip = zip_payload(&manifest, &files, None);
        let staged = stage(&zip, profile, &state).unwrap();
        assert_eq!(staged.manifest.files.len(), 4);
        assert_eq!(staged.manifest.profile, profile);
        package::persist_staged(&state, &staged, &channel()).unwrap();
        let restored = package::restore_staged(&state, &channel(), Some(profile))
            .unwrap()
            .unwrap();
        assert_eq!(restored.candidate, staged.candidate);
        assert_eq!(restored.directory, staged.directory);
        let mut other = channel();
        other.channel = "preview".into();
        assert!(
            package::restore_staged(&state, &other, Some(profile))
                .unwrap()
                .is_none()
        );
        let binary = if profile == RuntimePayloadProfile::Portable {
            "codlet.exe"
        } else {
            "codlet-lab.exe"
        };
        std::fs::write(staged.directory.join(binary), b"changed").unwrap();
        assert_eq!(
            package::restore_staged(&state, &channel(), Some(profile))
                .unwrap_err()
                .code,
            "runtime_update_digest_mismatch"
        );
    }
}

#[cfg(windows)]
#[test]
fn malicious_runtime_zip_never_changes_user_configuration_or_escapes_staging() {
    let temp = tempfile::tempdir().unwrap();
    let state = temp.path().join("updates");
    let user = temp.path().join("config.json");
    std::fs::write(&user, b"user settings").unwrap();
    let (manifest, files) = payload(RuntimePayloadProfile::Portable, "9.0.0", "24.21.0", "new");
    for name in [
        "../config.json",
        "C:/config.json",
        "runtime/node.exe:stream",
        "CON.txt",
        "NODE~1.EXE",
        "runtime/../node.exe",
        "runtime//node.exe",
        "plugins/user.json",
        "lab-config.json",
        "runtime/update-channel.json",
    ] {
        let zip = zip_payload(&manifest, &files, Some((name, b"attacker")));
        assert!(
            stage(&zip, RuntimePayloadProfile::Portable, &state).is_err(),
            "{name}"
        );
        assert_eq!(std::fs::read(&user).unwrap(), b"user settings");
        assert_eq!(std::fs::read_dir(&state).unwrap().count(), 0);
    }
    let mut wrong = manifest.clone();
    wrong.files[0].sha256 = "0".repeat(64);
    assert!(
        stage(
            &zip_payload(&wrong, &files, None),
            RuntimePayloadProfile::Portable,
            &state
        )
        .is_err()
    );
    let mut wrong = manifest.clone();
    wrong.profile = RuntimePayloadProfile::IsolatedClient;
    assert!(
        stage(
            &zip_payload(&wrong, &files, None),
            RuntimePayloadProfile::Portable,
            &state
        )
        .is_err()
    );
}

#[cfg(windows)]
#[test]
fn runtime_zip_rejects_crc_errors_symlinks_and_overlapping_header_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let (manifest, files) = payload(RuntimePayloadProfile::Portable, "9.0.0", "24.21.0", "new");
    let original = zip_payload(&manifest, &files, None);
    let central = original
        .windows(4)
        .position(|p| p == b"PK\x01\x02")
        .unwrap();
    let mut variants = Vec::new();
    let mut symlink = original.clone();
    symlink[central + 38..central + 42].copy_from_slice(&(0o120777u32 << 16).to_le_bytes());
    variants.push(symlink);
    let mut crc = original.clone();
    crc[14..18].copy_from_slice(&1u32.to_le_bytes());
    crc[central + 16..central + 20].copy_from_slice(&1u32.to_le_bytes());
    variants.push(crc);
    let mut hidden = original.clone();
    hidden.extend_from_slice(b"extra");
    variants.push(hidden);
    let mut oversized = original.clone();
    oversized[central + 24..central + 28]
        .copy_from_slice(&((MAX_EXPANDED_BYTES + 1) as u32).to_le_bytes());
    variants.push(oversized);
    for bytes in variants {
        assert!(
            stage(
                &bytes,
                RuntimePayloadProfile::Portable,
                &temp.path().join("updates")
            )
            .is_err()
        );
    }
}

#[cfg(windows)]
#[test]
fn helper_failure_receipt_releases_safe_candidate_but_blocks_uncertain_restart() {
    for phase in ["failed", "rollbackBlocked"] {
        let temp = tempfile::tempdir().unwrap();
        let id = "runtime-install-fixture";
        let receipt_path = temp.path().join("install-receipt.json");
        let digest = "a".repeat(64);
        package::atomic_json(&receipt_path,&serde_json::json!({"schema":1,"id":id,"planSha256":digest,"phase":phase,"movedOld":[],"movedNew":[],"configPatched":false,"error":{"code":"owner_still_running","message":"Owner remained alive"}})).unwrap();
        let service =
            RuntimeUpdateService::start(temp.path().into(), temp.path().join("state"), None)
                .unwrap();
        let (manifest, files) = payload(
            RuntimePayloadProfile::Portable,
            "9.0.0",
            "24.21.0",
            "retained candidate",
        );
        let staged = stage(
            &zip_payload(&manifest, &files, None),
            RuntimePayloadProfile::Portable,
            &temp.path().join("state"),
        )
        .unwrap();
        {
            let mut state = service.shared.lock().unwrap();
            state.status.candidate = Some(staged.candidate.clone());
            state.staged = Some(staged);
            state.status.phase = RuntimeUpdatePhase::InstallRequested;
            state.install_id = Some(id.into());
            state.install_receipt = Some((receipt_path, digest));
        }
        poll_install_receipt(&service.shared);
        let status = service.status();
        assert_eq!(status.error.unwrap().code, "owner_still_running");
        if phase == "failed" {
            assert_eq!(status.phase, RuntimeUpdatePhase::Downloaded);
        } else {
            assert_eq!(status.phase, RuntimeUpdatePhase::Failed);
            assert_eq!(
                service.check().unwrap_err().code,
                "runtime_update_needs_attention"
            );
        }
    }
}

struct Fixture {
    origin: Url,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Fixture {
    fn new(replies: Vec<Vec<u8>>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let log = requests.clone();
        let stopped = stop.clone();
        let thread = std::thread::spawn(move || {
            let mut replies: VecDeque<_> = replies.into();
            while !stopped.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        let mut req = Vec::new();
                        let mut buffer = [0; 1024];
                        while !req.windows(4).any(|p| p == b"\r\n\r\n") {
                            let n = stream.read(&mut buffer).unwrap();
                            if n == 0 {
                                break;
                            }
                            req.extend_from_slice(&buffer[..n]);
                            assert!(req.len() < 8192);
                        }
                        log.lock().unwrap().push(String::from_utf8(req).unwrap());
                        stream
                            .write_all(&replies.pop_front().expect("unexpected request"))
                            .unwrap();
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2))
                    }
                    Err(e) => panic!("{e}"),
                }
            }
        });
        Self {
            origin,
            requests,
            stop,
            thread: Some(thread),
        }
    }
    fn client(&self) -> source::UpdateClient {
        let mut client = source::UpdateClient::new(&channel()).unwrap();
        client.fixture_origin = Some(self.origin.clone());
        client
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let result = self.thread.take().unwrap().join();
        if !std::thread::panicking() {
            result.unwrap();
        }
    }
}
fn response(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
    let mut data = format!(
        "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n",
        body.len()
    )
    .into_bytes();
    data.extend_from_slice(body);
    data
}
fn release(bytes: &[u8]) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({"schema":1,"kind":"codlet-runtime-channel","channel":"stable","version":"9.0.0","artifacts":[{"platform":"win-x64","profile":"portable","bytes":bytes.len(),"sha256":sha(bytes),"url":"https://cdn.example/runtime.zip","assetName":null}]})).unwrap()
}

fn github_channel(name: &str) -> RuntimeUpdateChannel {
    RuntimeUpdateChannel {
        channel: name.into(),
        source: Some(RuntimeUpdateSource::Github {
            repository_url: "https://github.com/codlet-tests/core".into(),
            manifest_asset: "codlet-update.json".into(),
        }),
        ..channel()
    }
}

fn github_release_fixture(
    version: &str,
    channel: &str,
    prerelease: bool,
    draft: bool,
) -> (serde_json::Value, Vec<u8>) {
    let manifest = serde_json::to_vec(&serde_json::json!({
        "schema":1, "kind":"codlet-runtime-channel", "channel":channel,
        "version":version, "artifacts":[{
            "platform":PLATFORM, "profile":"portable", "bytes":123,
            "sha256":"a".repeat(64), "url":null, "assetName":"runtime.zip"
        }]
    }))
    .unwrap();
    let release = serde_json::json!({
        "id":1, "tag_name":format!("v{version}"),
        "html_url":format!("https://github.com/codlet-tests/core/releases/tag/v{version}"),
        "draft":draft, "prerelease":prerelease, "assets":[
            {"id":11,"name":"codlet-update.json","size":manifest.len(),"state":"uploaded","digest":format!("sha256:{}",sha(&manifest))},
            {"id":12,"name":"runtime.zip","size":123,"state":"uploaded","digest":format!("sha256:{}","a".repeat(64))}
        ]
    });
    (release, manifest)
}

#[tokio::test]
async fn github_preview_finds_numeric_latest_prerelease_and_ignores_drafts_and_other_assets() {
    let (older, _) = github_release_fixture("9.0.0-preview.2", "preview", true, false);
    let (selected, manifest) = github_release_fixture("9.0.0-preview.10", "preview", true, false);
    let (stable, _) = github_release_fixture("10.0.0", "stable", false, false);
    let (draft, _) = github_release_fixture("11.0.0-preview.1", "preview", true, true);
    let (mut unrelated, _) = github_release_fixture("12.0.0-preview.1", "preview", true, false);
    unrelated["assets"] = serde_json::json!([]);
    let list = serde_json::to_vec(&vec![older, stable, draft, unrelated, selected]).unwrap();
    let fixture = Fixture::new(vec![
        response("200 OK", "", &list),
        response("200 OK", "", &manifest),
    ]);
    let selected = fixture
        .client()
        .check(
            &github_channel("preview"),
            Some(RuntimePayloadProfile::Portable),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(selected.public.version, "9.0.0-preview.10");
    assert_eq!(
        selected.url.as_str(),
        "https://api.github.com/repos/codlet-tests/core/releases/assets/12"
    );
    let requests = fixture.requests.lock().unwrap();
    assert!(requests[0].starts_with("GET /repos/codlet-tests/core/releases?per_page=30 "));
    assert!(requests[1].starts_with("GET /repos/codlet-tests/core/releases/assets/11 "));
    assert_eq!(
        requests.len(),
        2,
        "a check must not download the update ZIP"
    );
    assert!(
        requests
            .iter()
            .all(|request| !request.to_ascii_lowercase().contains("authorization:"))
    );
}

#[tokio::test]
async fn github_stable_still_uses_the_public_latest_release() {
    let (release, manifest) = github_release_fixture("9.0.0", "stable", false, false);
    let fixture = Fixture::new(vec![
        response("200 OK", "", &serde_json::to_vec(&release).unwrap()),
        response("200 OK", "", &manifest),
    ]);
    let selected = fixture
        .client()
        .check(
            &github_channel("stable"),
            Some(RuntimePayloadProfile::Portable),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(selected.public.version, "9.0.0");
    assert!(
        fixture.requests.lock().unwrap()[0]
            .starts_with("GET /repos/codlet-tests/core/releases/latest ")
    );
}

#[tokio::test]
async fn github_preview_without_a_published_candidate_reports_unpublished() {
    let fixture = Fixture::new(vec![response("200 OK", "", b"[]")]);
    let error = fixture
        .client()
        .check(
            &github_channel("preview"),
            Some(RuntimePayloadProfile::Portable),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "runtime_update_not_published");
    assert_eq!(fixture.requests.lock().unwrap().len(), 1);
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn github_preview_defaults_to_mac_app_profile() {
    let (mut release, manifest) =
        github_release_fixture("9.0.0-preview.10", "preview", true, false);
    let mut manifest: serde_json::Value = serde_json::from_slice(&manifest).unwrap();
    manifest["artifacts"][0]["profile"] = serde_json::json!("macApp");
    let manifest = serde_json::to_vec(&manifest).unwrap();
    release["assets"][0]["size"] = serde_json::json!(manifest.len());
    release["assets"][0]["digest"] = serde_json::json!(format!("sha256:{}", sha(&manifest)));
    let fixture = Fixture::new(vec![
        response("200 OK", "", &serde_json::to_vec(&vec![release]).unwrap()),
        response("200 OK", "", &manifest),
    ]);
    let selected = fixture
        .client()
        .check(&github_channel("preview"), None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(selected.profile, RuntimePayloadProfile::MacApp);
    assert_eq!(selected.public.platform, "darwin-arm64");
    assert_eq!(fixture.requests.lock().unwrap().len(), 2);
}

#[cfg(windows)]
#[tokio::test]
async fn fixed_https_fixture_checks_then_downloads_exact_pinned_payload_without_authentication() {
    let (manifest, files) = payload(RuntimePayloadProfile::Portable, "9.0.0", "24.21.0", "new");
    let bytes = zip_payload(&manifest, &files, None);
    let fixture = Fixture::new(vec![
        response("200 OK", "", &release(&bytes)),
        response(
            "302 Found",
            "Location: https://cdn.example/fixed-runtime.zip\r\n",
            b"",
        ),
        response("200 OK", "", &bytes),
    ]);
    let client = fixture.client();
    let selected = client
        .check(&channel(), Some(RuntimePayloadProfile::Portable))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(selected.public.sha256, sha(&bytes));
    assert_eq!(
        fixture.requests.lock().unwrap().len(),
        1,
        "checking must not download runtime bytes"
    );
    let temp = tempfile::tempdir().unwrap();
    let mut progress = 0;
    let staged = client
        .download(&selected, temp.path(), |n| progress = n)
        .await
        .unwrap();
    assert_eq!(progress, bytes.len() as u64);
    assert_eq!(staged.manifest.version, "9.0.0");
    for request in fixture.requests.lock().unwrap().iter() {
        assert!(!request.to_ascii_lowercase().contains("authorization:"));
    }
}

#[tokio::test]
async fn download_rejects_digest_mismatch_and_unpinned_redirect_before_staging() {
    let (manifest, files) = payload(RuntimePayloadProfile::Portable, "9.0.0", "24.21.0", "new");
    let bytes = zip_payload(&manifest, &files, None);
    for redirect in [false, true] {
        let fixture = Fixture::new(vec![if redirect {
            response(
                "302 Found",
                "Location: https://untrusted.example/asset.zip\r\n",
                b"",
            )
        } else {
            response("200 OK", "", &bytes)
        }]);
        let mut selected = candidate(&bytes, RuntimePayloadProfile::Portable);
        selected.public.sha256 = "0".repeat(64);
        let temp = tempfile::tempdir().unwrap();
        let e = fixture
            .client()
            .download(&selected, temp.path(), |_| {})
            .await
            .unwrap_err();
        assert_eq!(
            e.code,
            if redirect {
                "runtime_update_redirect_rejected"
            } else {
                "runtime_update_digest_mismatch"
            }
        );
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
    }
}

#[test]
fn release_configuration_cannot_enable_http_or_unpinned_arbitrary_urls() {
    for source in [
        RuntimeUpdateSource::Https {
            manifest_url: "http://example.com/update.json".into(),
            allowed_asset_origins: vec!["https://cdn.example".into()],
        },
        RuntimeUpdateSource::Https {
            manifest_url: "https://u:p@example.com/update.json".into(),
            allowed_asset_origins: vec!["https://cdn.example".into()],
        },
        RuntimeUpdateSource::Https {
            manifest_url: "https://example.com/update.json".into(),
            allowed_asset_origins: vec!["https://cdn.example/path".into()],
        },
    ] {
        let mut c = channel();
        c.source = Some(source);
        assert!(source::UpdateClient::new(&c).is_err());
    }
}

#[cfg(windows)]
#[test]
fn install_plan_binds_current_identity_and_only_the_two_owner_configuration_pins() {
    let temp = tempfile::tempdir().unwrap();
    let install_root = temp.path().join("installed");
    let state_root = temp.path().join("updates");
    std::fs::create_dir(&install_root).unwrap();
    let (old, files) = payload(
        RuntimePayloadProfile::IsolatedClient,
        CURRENT_VERSION,
        "24.21.0",
        "old",
    );
    for (name, bytes) in files {
        let dest = install_root.join(name);
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::write(dest, bytes).unwrap();
    }
    let (new, files) = payload(
        RuntimePayloadProfile::IsolatedClient,
        "9.0.0",
        "25.0.0",
        "new",
    );
    let staged = stage(
        &zip_payload(&new, &files, None),
        RuntimePayloadProfile::IsolatedClient,
        &state_root,
    )
    .unwrap();
    let config = install_root.join("lab-config.json");
    let original = serde_json::json!({"schema":1,"labBinary":"codlet-lab.exe","labBinarySha256":old.files.iter().find(|f|f.path=="codlet-lab.exe").unwrap().sha256.to_uppercase(),"nodeRelative":"runtime/node-v24.21.0-win-x64/node.exe","userSetting":"preserve","officialCli":"C:/not-touched/codex.exe"});
    std::fs::write(&config, serde_json::to_vec(&original).unwrap()).unwrap();
    let program = PathBuf::from(std::env::var("SYSTEMROOT").unwrap())
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let restart = RuntimeRestartContext {
        profile: RuntimePayloadProfile::IsolatedClient,
        command: RuntimeRestartCommand {
            program,
            args: vec!["-NoProfile".into(), "-Command".into(), "exit 0".into()],
            working_directory: install_root.clone(),
            environment: BTreeMap::new(),
            timeout_seconds: 30,
        },
        wait_for: vec![],
        launcher_files: vec![config.clone()],
        config_pin: Some(RuntimeConfigPin {
            path: config.clone(),
        }),
    };
    let request =
        install::prepare_install_plan(&install_root, &state_root, &staged, &restart).unwrap();
    let plan: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&request.plan_path).unwrap()).unwrap();
    assert_eq!(
        plan["configPin"]["oldNodeRelative"],
        "runtime/node-v24.21.0-win-x64/node.exe"
    );
    assert_eq!(
        plan["configPin"]["newNodeRelative"],
        "runtime/node-v25.0.0-win-x64/node.exe"
    );
    assert_eq!(
        plan["configPin"]["newValue"],
        new.files
            .iter()
            .find(|f| f.path == "codlet-lab.exe")
            .unwrap()
            .sha256
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&std::fs::read(&config).unwrap()).unwrap(),
        original,
        "planning must not install or change pins"
    );
    assert!(
        plan["waitFor"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["pid"] == std::process::id())
    );
    assert!(!request.handoff_ack_path.exists());
}

#[cfg(windows)]
#[cfg(windows)]
#[test]
fn powershell_builder_emits_real_dotnet_zips_and_merges_both_profiles_without_user_files() {
    use std::os::windows::process::CommandExt;
    let temporary = tempfile::tempdir().unwrap();
    let powershell = PathBuf::from(std::env::var("SYSTEMROOT").unwrap())
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let builder = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("scripts/Build-RuntimeUpdate.ps1");
    let mut prior = None;
    for (profile, name) in [
        (RuntimePayloadProfile::Portable, "portable"),
        (RuntimePayloadProfile::IsolatedClient, "isolatedClient"),
    ] {
        let input = temporary.path().join(format!("input-{name}"));
        let output = temporary.path().join(format!("output-{name}"));
        let (_manifest, files) = payload(profile, "9.0.0", "24.21.0", "builder fixture");
        for (relative, bytes) in files {
            let file = input.join(relative);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, bytes).unwrap();
        }
        std::fs::create_dir(input.join("plugins")).unwrap();
        std::fs::write(
            input.join("plugins/user.json"),
            b"do not package author files",
        )
        .unwrap();
        std::fs::write(input.join("auth.json"), b"do not package authentication").unwrap();
        let mut command = std::process::Command::new(&powershell);
        command
            .creation_flags(0x08000000)
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-File"])
            .arg(&builder)
            .arg("-InputDirectory")
            .arg(&input)
            .args([
                "-Profile",
                name,
                "-Version",
                "9.0.0",
                "-ArtifactBaseUrl",
                "https://downloads.example.com/codlet",
            ])
            .arg("-OutputDirectory")
            .arg(&output);
        if let Some(prior) = &prior {
            command.arg("-MergeChannelManifest").arg(prior);
        }
        let result = command.output().unwrap();
        assert!(
            result.status.success(),
            "builder failed: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        let zip = std::fs::read(output.join(format!("codlet-9.0.0-win-x64-{name}.zip"))).unwrap();
        let staged = stage(
            &zip,
            profile,
            &temporary.path().join(format!("state-{name}")),
        )
        .unwrap();
        assert_eq!(staged.manifest.files.len(), 4);
        assert!(!staged.directory.join("plugins").exists());
        assert!(!staged.directory.join("auth.json").exists());
        let channel_path = output.join("codlet-update-stable.json");
        let published: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&channel_path).unwrap()).unwrap();
        let selected = published["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["profile"] == name)
            .unwrap();
        assert_eq!(selected["sha256"], sha(&zip));
        assert_eq!(selected["bytes"], zip.len());
        assert!(
            selected["url"]
                .as_str()
                .unwrap()
                .starts_with("https://downloads.example.com/codlet/")
        );
        if prior.is_some() {
            assert_eq!(published["artifacts"].as_array().unwrap().len(), 2);
        }
        prior = Some(channel_path);
    }
}

#[cfg(windows)]
#[cfg(windows)]
#[test]
fn cross_volume_install_is_rejected_before_any_process_handoff_or_file_access() {
    assert_eq!(
        install::ensure_same_volume(
            Path::new("C:\\owned-runtime"),
            Path::new("D:\\registry\\updates")
        )
        .unwrap_err()
        .code,
        "runtime_update_cross_volume"
    );
    assert!(
        install::ensure_same_volume(
            Path::new("\\\\?\\C:\\owned-runtime"),
            Path::new("c:\\registry\\updates")
        )
        .is_ok()
    );
    assert!(
        install::ensure_same_volume(
            Path::new("C:\\owned-runtime"),
            Path::new("\\\\server\\share\\updates")
        )
        .is_err()
    );
}

#[test]
fn restarted_service_observes_install_completion_and_retains_blocked_receipts() {
    for phase in ["installed", "rollbackBlocked"] {
        let temp = tempfile::tempdir().unwrap();
        let state_root = temp.path().join("state");
        let id = "runtime-install-restarted";
        let job = state_root.join(id);
        std::fs::create_dir_all(&job).unwrap();
        let value = serde_json::json!({"schema":1,"id":id,"planSha256":"a".repeat(64),"phase":phase,"version":CURRENT_VERSION,"movedOld":["codlet.exe"],"movedNew":["codlet.exe"],"configPatched":false,"error":null});
        package::atomic_json(&job.join("install-receipt.json"), &value).unwrap();
        package::atomic_json(
            &state_root.join("runtime-update-install-receipt.json"),
            &value,
        )
        .unwrap();
        let service =
            RuntimeUpdateService::start(temp.path().into(), state_root.clone(), None).unwrap();
        restore_install_receipt(&service.shared, &state_root);
        let status = service.status();
        if phase == "installed" {
            assert_eq!(status.phase, RuntimeUpdatePhase::UpToDate);
            assert!(status.error.is_none());
        } else {
            assert_eq!(status.phase, RuntimeUpdatePhase::Failed);
            assert_eq!(
                service.check().unwrap_err().code,
                "runtime_update_needs_attention"
            );
        }
    }
}
