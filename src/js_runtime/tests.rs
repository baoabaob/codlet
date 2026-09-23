use super::*;
use crate::platform::DesktopTarget;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[test]
fn embedded_client_profiles_decode_exact_source_fields_and_keep_mac_disabled() {
    let profiles = provision::profiles().unwrap();
    let windows = profiles
        .iter()
        .find(|profile| profile.platform == "win-x64")
        .unwrap();
    assert!(windows.enabled);
    assert_eq!(windows.node_version, "24.21.0");
    let mac = profiles
        .iter()
        .find(|profile| profile.platform == "darwin-arm64")
        .unwrap();
    assert!(!mac.enabled);
}

fn fixture_pin(node: &[u8], license: &[u8], mode: Option<&str>) -> RuntimePin {
    let target = DesktopTarget::current().unwrap();
    let platform = target.node_platform().to_owned();
    let release = "24.21.0";
    RuntimePin {
        schema: 1,
        version: release.into(),
        base_url: format!("https://nodejs.org/download/release/v{release}"),
        mode: mode.map(str::to_owned),
        platforms: BTreeMap::from([(
            platform.clone(),
            PlatformPin {
                archive: format!(
                    "node-v{release}-{platform}.{}",
                    if cfg!(target_os = "macos") {
                        "tar.gz"
                    } else {
                        "zip"
                    }
                ),
                archive_sha256: "a".repeat(64),
                mirror_url: None,
                executable_sha256: digest(node),
                license_sha256: digest(license),
                version: None,
                base_url: None,
            },
        )]),
    }
}

fn write_pair(node: &Path, license: &Path, node_bytes: &[u8], license_bytes: &[u8]) {
    fs::create_dir_all(node.parent().unwrap()).unwrap();
    fs::write(node, node_bytes).unwrap();
    fs::write(license, license_bytes).unwrap();
}

fn isolated_cache(directory: &tempfile::TempDir) -> PathBuf {
    directory.path().canonicalize().unwrap().join("cache")
}

#[test]
fn bundled_seam_requires_both_exact_pinned_files_without_executing_node() {
    let directory = tempfile::tempdir().unwrap();
    let pin = fixture_pin(b"fixture Node", b"fixture license", None);
    let target = DesktopTarget::current().unwrap();
    let root = directory
        .path()
        .join(format!("runtime/node-v24.21.0-{}", target.node_platform()));
    let node = root.join(target.node_executable());
    let license = root.join("LICENSE");
    write_pair(&node, &license, b"fixture Node", b"fixture license");
    let runtime = JsRuntime::checked_bundled(directory.path(), &pin).unwrap();
    assert!(runtime.executable_path().is_file());
    assert!(runtime.license_path().is_file());
    drop(runtime);
    fs::write(&license, b"tampered").unwrap();
    assert_eq!(
        JsRuntime::checked_bundled(directory.path(), &pin)
            .err()
            .unwrap()
            .code,
        "js_runtime_mismatch"
    );
}

#[test]
fn private_cache_coordinates_concurrent_preparation_and_reuses_verified_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let root = isolated_cache(&directory);
    let target = DesktopTarget::current().unwrap();
    let node_sha = digest(b"verified Node");
    let license_sha = digest(b"verified LICENSE");
    let count = std::sync::Arc::new(AtomicUsize::new(0));
    let mut threads = Vec::new();
    for _ in 0..2 {
        let root = root.clone();
        let node_sha = node_sha.clone();
        let license_sha = license_sha.clone();
        let count = count.clone();
        threads.push(std::thread::spawn(move || {
            let runtime = provision::ensure_cache_with(
                &root,
                target,
                "24.21.0",
                &node_sha,
                &license_sha,
                |node, license| {
                    count.fetch_add(1, Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    write_pair(node, license, b"verified Node", b"verified LICENSE");
                    Ok(())
                },
            )
            .unwrap();
            assert!(runtime.cached_executable_path().unwrap().is_file());
        }));
    }
    for thread in threads {
        thread.join().unwrap();
    }
    assert_eq!(count.load(Ordering::SeqCst), 1);
    let runtime =
        provision::ensure_cache_with(&root, target, "24.21.0", &node_sha, &license_sha, |_, _| {
            panic!("verified cache must be reused")
        })
        .unwrap();
    assert!(runtime.cached_executable_path().unwrap().is_file());
}

#[test]
fn failed_or_interrupted_preparation_never_publishes_partial_cache() {
    let directory = tempfile::tempdir().unwrap();
    let root = isolated_cache(&directory);
    let target = DesktopTarget::current().unwrap();
    let node_sha = digest(b"verified Node");
    let license_sha = digest(b"verified LICENSE");
    let failure = provision::ensure_cache_with(
        &root,
        target,
        "24.21.0",
        &node_sha,
        &license_sha,
        |node, _| {
            fs::write(node, b"partial network download").unwrap();
            Err(HostError::new(
                "js_runtime_download",
                "fixture network failure",
            ))
        },
    )
    .err()
    .unwrap();
    assert_eq!(failure.code, "js_runtime_download");
    assert!(
        !root
            .join(format!("{}-{node_sha}", target.node_platform()))
            .exists()
    );
    assert_eq!(
        fs::read_dir(&root)
            .unwrap()
            .filter(|entry| entry
                .as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".node-prepare-"))
            .count(),
        0
    );
    let orphan = root.join(".node-prepare-interrupted");
    fs::create_dir(&orphan).unwrap();
    fs::write(orphan.join("partial"), b"interrupted").unwrap();
    let owned = root.join(format!(
        ".node-prepare-{}-{node_sha}-interrupted",
        target.node_platform()
    ));
    fs::create_dir(&owned).unwrap();
    fs::write(owned.join("partial"), b"incomplete previous download").unwrap();
    fs::write(
        owned.join(".codlet-node-preparing.json"),
        serde_json::json!({"schema":1,"platform":target.node_platform(),"nodeSha256":node_sha,"createdMs":1}).to_string(),
    )
    .unwrap();
    let runtime = provision::ensure_cache_with(
        &root,
        target,
        "24.21.0",
        &node_sha,
        &license_sha,
        |node, license| {
            write_pair(node, license, b"verified Node", b"verified LICENSE");
            Ok(())
        },
    )
    .unwrap();
    assert!(runtime.cached_executable_path().unwrap().is_file());
    assert!(
        !owned.exists(),
        "marked interrupted preparation is reclaimed under its key lock"
    );
    assert!(
        orphan.join("partial").exists(),
        "unowned stale path is never reused or deleted"
    );
}

#[test]
fn tampered_cache_cannot_be_reused_or_replaced_by_an_unchecked_source() {
    let directory = tempfile::tempdir().unwrap();
    let root = isolated_cache(&directory);
    let target = DesktopTarget::current().unwrap();
    let node_sha = digest(b"verified Node");
    let license_sha = digest(b"verified LICENSE");
    let runtime = provision::ensure_cache_with(
        &root,
        target,
        "24.21.0",
        &node_sha,
        &license_sha,
        |node, license| {
            write_pair(node, license, b"verified Node", b"verified LICENSE");
            Ok(())
        },
    )
    .unwrap();
    let node = runtime.cached_executable_path().unwrap().to_owned();
    drop(runtime);
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&node, fs::Permissions::from_mode(0o700)).unwrap();
    }
    fs::write(&node, b"tampered").unwrap();
    let failure =
        provision::ensure_cache_with(&root, target, "24.21.0", &node_sha, &license_sha, |_, _| {
            panic!("tampered cache must never be trusted or silently replaced")
        })
        .err()
        .unwrap();
    assert_eq!(failure.code, "js_runtime_mismatch");
}

#[test]
fn old_owned_cache_is_pruned_without_waiting_on_busy_keys_or_touching_custom_paths() {
    let directory = tempfile::tempdir().unwrap();
    let root = isolated_cache(&directory);
    let target = DesktopTarget::current().unwrap();
    let old_sha = digest(b"old verified Node");
    let license_sha = digest(b"verified LICENSE");
    let runtime = provision::ensure_cache_with(
        &root,
        target,
        "24.21.0",
        &old_sha,
        &license_sha,
        |node, license| {
            write_pair(node, license, b"old verified Node", b"verified LICENSE");
            Ok(())
        },
    )
    .unwrap();
    let old_directory = runtime
        .cached_executable_path()
        .unwrap()
        .parent()
        .unwrap()
        .to_owned();
    #[cfg(target_os = "macos")]
    let old_directory = old_directory.parent().unwrap().to_owned();
    drop(runtime);
    let marker_path = old_directory.join(".codlet-node-cache.json");
    let mut marker: serde_json::Value =
        serde_json::from_slice(&fs::read(&marker_path).unwrap()).unwrap();
    marker["createdMs"] = serde_json::json!(1);
    fs::write(&marker_path, marker.to_string()).unwrap();
    let custom = root.join(format!("{}-{}", target.node_platform(), digest(b"custom")));
    fs::create_dir(&custom).unwrap();
    fs::write(custom.join("user.txt"), b"not Codlet-owned").unwrap();
    let lock_path = root.join(format!("{}-{old_sha}.lock", target.node_platform()));
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(lock_path)
        .unwrap();
    lock.try_lock().unwrap();
    let pin = fixture_pin(b"current Node", b"verified LICENSE", Some("managed"));
    let start = std::time::Instant::now();
    provision::prune_obsolete_inner(&root, target, &pin).unwrap();
    assert!(start.elapsed() < std::time::Duration::from_secs(2));
    assert!(old_directory.exists(), "busy cache stays available");
    drop(lock);
    provision::prune_obsolete_inner(&root, target, &pin).unwrap();
    assert!(!old_directory.exists(), "old verified cache is reclaimed");
    assert!(
        custom.join("user.txt").exists(),
        "markerless custom directory is untouched"
    );
}

#[cfg(windows)]
#[test]
fn active_windows_cache_gc_preserves_original_marker_node_and_license() {
    let directory = tempfile::tempdir().unwrap();
    let root = isolated_cache(&directory);
    let target = DesktopTarget::WindowsX64;
    let old_sha = digest(b"old active Node");
    let license_sha = digest(b"active LICENSE");
    let runtime = provision::ensure_cache_with(
        &root,
        target,
        "24.21.0",
        &old_sha,
        &license_sha,
        |node, license| {
            write_pair(node, license, b"old active Node", b"active LICENSE");
            Ok(())
        },
    )
    .unwrap();
    let cache = runtime
        .cached_executable_path()
        .unwrap()
        .parent()
        .unwrap()
        .to_owned();
    let marker_path = cache.join(".codlet-node-cache.json");
    let mut marker: serde_json::Value =
        serde_json::from_slice(&fs::read(&marker_path).unwrap()).unwrap();
    marker["createdMs"] = serde_json::json!(1);
    fs::write(&marker_path, marker.to_string()).unwrap();
    let pin = fixture_pin(b"current Node", b"active LICENSE", Some("managed"));
    provision::prune_obsolete_inner(&root, target, &pin).unwrap();
    assert_eq!(
        fs::read(cache.join("node.exe")).unwrap(),
        b"old active Node"
    );
    assert_eq!(fs::read(cache.join("LICENSE")).unwrap(), b"active LICENSE");
    assert!(
        marker_path.is_file(),
        "busy cache marker stays at its original path"
    );
    drop(runtime);
    provision::prune_obsolete_inner(&root, target, &pin).unwrap();
    assert!(
        !cache.exists(),
        "retired idle cache is removed after its generation ends"
    );
}

#[cfg(windows)]
#[test]
fn fixed_official_zip_extracts_only_node_and_license() {
    use std::io::Cursor;
    let target = DesktopTarget::WindowsX64;
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    for (name, bytes) in [
        ("node-v24.21.0-win-x64/node.exe", b"node".as_slice()),
        ("node-v24.21.0-win-x64/LICENSE", b"license".as_slice()),
        ("node-v24.21.0-win-x64/npm/ignored", b"ignore".as_slice()),
    ] {
        zip.start_file(name, options).unwrap();
        zip.write_all(bytes).unwrap();
    }
    let archive = zip.finish().unwrap().into_inner();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("node.zip");
    fs::write(&path, archive).unwrap();
    let node = directory.path().join("node.exe");
    let license = directory.path().join("LICENSE");
    provision::extract_exact(&path, target, "24.21.0", &node, &license).unwrap();
    assert_eq!(fs::read(node).unwrap(), b"node");
    assert_eq!(fs::read(license).unwrap(), b"license");
    assert!(!directory.path().join("npm").exists());
}

#[test]
fn node_mirror_policy_rejects_other_repositories_and_unsafe_redirects() {
    let archive = "node-v24.21.0-win-x64.zip";
    assert!(provision::allowed_mirror_asset_url(
        "https://github.com/baoabaob/codlet/releases/download/node-runtimes/node-v24.21.0-win-x64.zip",
        archive,
    ));
    for url in [
        "https://github.com/another/codlet/releases/download/node-runtimes/node-v24.21.0-win-x64.zip",
        "https://github.com/baoabaob/codlet/releases/download/node-runtimes/other.zip",
        "http://github.com/baoabaob/codlet/releases/download/node-runtimes/node-v24.21.0-win-x64.zip",
        "https://github.com/baoabaob/codlet/releases/download/../node-v24.21.0-win-x64.zip",
    ] {
        assert!(!provision::allowed_mirror_asset_url(url, archive));
    }
}

#[test]
fn failed_mirror_download_clears_partial_bytes_before_official_backup() {
    let directory = tempfile::tempdir().unwrap();
    let archive = directory.path().join("node.zip");
    let mut attempts = Vec::new();
    provision::download_exact_archive_with(
        "https://nodejs.org/download/release/v24.21.0/node.zip",
        Some("https://github.com/baoabaob/codlet/releases/download/node-runtimes/node.zip"),
        &archive,
        &digest(b"exact official bytes"),
        |_, path, source| match source {
            provision::DownloadSource::CodletMirror => {
                attempts.push("mirror");
                fs::write(path, b"incomplete").unwrap();
                Err(HostError::new("js_runtime_download", "fixture timeout"))
            }
            provision::DownloadSource::Official => {
                attempts.push("official");
                assert!(
                    !path.exists(),
                    "partial bytes are removed before source switch"
                );
                fs::write(path, b"exact official bytes").unwrap();
                Ok(())
            }
        },
    )
    .unwrap();
    assert_eq!(attempts, ["mirror", "official"]);
    assert_eq!(fs::read(&archive).unwrap(), b"exact official bytes");
    let rejected = directory.path().join("rejected.zip");
    assert!(
        provision::download_exact_archive_with(
            "https://nodejs.org/download/release/v24.21.0/node.zip",
            Some("https://github.com/baoabaob/codlet/releases/download/node-runtimes/node.zip"),
            &rejected,
            &digest(b"exact official bytes"),
            |_, path, _| {
                fs::write(path, b"different bytes").unwrap();
                Ok(())
            },
        )
        .is_err()
    );
    assert!(
        !rejected.exists(),
        "neither source may publish a wrong archive digest"
    );
}

#[cfg(windows)]
#[test]
#[ignore = "requires an installed exact-profile official Codex package"]
fn installed_official_cua_node_can_be_verified_and_cached_without_execution() {
    let profile = provision::profiles()
        .unwrap()
        .into_iter()
        .find(|profile| profile.enabled && profile.platform == "win-x64")
        .unwrap();
    let source = provision::official_source(&profile)
        .expect("exact-profile official CUA Node must be installed");
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("cache");
    let runtime = provision::ensure_cache_with(
        &root,
        DesktopTarget::WindowsX64,
        &profile.node_version,
        &profile.node_sha256,
        &profile.license_sha256,
        |node, license| {
            provision::copy_pair(
                source.executable_path(),
                source.license_path(),
                node,
                license,
            )
        },
    )
    .unwrap();
    assert!(runtime.cached_executable_path().unwrap().exists());
    let again = provision::ensure_cache_with(
        &root,
        DesktopTarget::WindowsX64,
        &profile.node_version,
        &profile.node_sha256,
        &profile.license_sha256,
        |_, _| panic!("exact CUA cache must be reused"),
    )
    .unwrap();
    assert_eq!(runtime.executable_path(), again.executable_path());
    let plugin = directory.path().join("plugin");
    fs::create_dir(&plugin).unwrap();
    let entry = plugin.join("entry.js");
    let source = "module.exports = { activate() {}, deactivate() {} };";
    fs::write(&entry, source).unwrap();
    let host = LoadedHost {
        root: plugin,
        entry,
        source: std::sync::Arc::from(source),
        authorization: None,
    };
    let invocation = runtime.prepare(&host).unwrap();
    let mut command = std::process::Command::new(&invocation.executable);
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000);
    let mut child = command
        .args(&invocation.arguments)
        .current_dir(&invocation.cwd)
        .env_clear()
        .envs(invocation.environment.clone())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::BufReader::new(stdout).lines() {
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    let mut input = child.stdin.take().unwrap();
    let initialize = serde_json::json!({"v":1,"type":"request","pluginId":"dev.cua-smoke","generation":1,"id":1,"method":"initialize","params":{"protocolVersion":1,"pluginVersion":"1.0.0","provides":[],"requires":[]}});
    writeln!(input, "{initialize}").unwrap();
    input.flush().unwrap();
    let line = receiver
        .recv_timeout(std::time::Duration::from_secs(10))
        .unwrap()
        .unwrap();
    let response: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(response["type"], "response");
    assert_eq!(response["id"], 1);
    assert_eq!(response["ok"], true);
    assert_eq!(response["result"]["ready"], true);
    writeln!(input, "{}", serde_json::json!({"v":1,"type":"request","pluginId":"dev.cua-smoke","generation":1,"id":2,"method":"shutdown","params":null})).unwrap();
    input.flush().unwrap();
    let line = receiver
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap()
        .unwrap();
    let response: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(response["id"], 2);
    assert_eq!(response["ok"], true);
    drop(input);
    assert!(child.wait().unwrap().success());
}

#[cfg(windows)]
#[test]
#[ignore = "downloads the fixed official Node release archive"]
fn pinned_official_fallback_downloads_and_reuses_private_cache() {
    let pin: RuntimePin =
        serde_json::from_str(include_str!("../../runtime/node-runtime.json")).unwrap();
    let target = DesktopTarget::current().unwrap();
    let selected = &pin.platforms[target.node_platform()];
    let release = selected.version.as_deref().unwrap_or(&pin.version);
    let url = format!(
        "{}/{}",
        selected.base_url.as_deref().unwrap_or(&pin.base_url),
        selected.archive
    );
    let directory = tempfile::tempdir().unwrap();
    let root = isolated_cache(&directory);
    let mut used_mirror = false;
    let runtime = provision::ensure_cache_with(
        &root,
        target,
        release,
        &selected.executable_sha256,
        &selected.license_sha256,
        |node, license| {
            let archive = license.parent().unwrap().join(&selected.archive);
            provision::download_exact_archive_with(
                &url,
                selected.mirror_url.as_deref(),
                &archive,
                &selected.archive_sha256,
                |url, path, source| {
                    let result = provision::download_archive(url, path, source);
                    if matches!(source, provision::DownloadSource::CodletMirror) {
                        used_mirror = true;
                        if let Err(error) = &result {
                            panic!("public pinned mirror failed: {}", error.message);
                        }
                    }
                    result
                },
            )?;
            provision::extract_exact(&archive, target, release, node, license)?;
            fs::remove_file(archive).map_err(io_error)
        },
    )
    .unwrap();
    assert_eq!(
        runtime.verified_executable_sha256(),
        selected.executable_sha256
    );
    assert_eq!(runtime.verified_license_sha256(), selected.license_sha256);
    assert!(
        used_mirror,
        "the real fallback fixture must exercise the public mirror"
    );
    let cached = runtime.cached_executable_path().unwrap().to_owned();
    drop(runtime);
    let repeated = provision::ensure_cache_with(
        &root,
        target,
        release,
        &selected.executable_sha256,
        &selected.license_sha256,
        |_, _| panic!("verified fallback cache must be reused"),
    )
    .unwrap();
    assert_eq!(repeated.cached_executable_path(), Some(cached.as_path()));
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "requires a separately downloaded and verified exact official Mac bundle"]
fn verified_mac_client_node_bundle() {
    let app = std::env::var_os("CODLET_TEST_REVIEWED_MAC_APP")
        .map(PathBuf::from)
        .expect("set CODLET_TEST_REVIEWED_MAC_APP to the isolated verified ChatGPT.app");
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap().join("cache");
    let runtime = provision::official_mac_fixture(&app, &root).unwrap();
    assert_eq!(runtime.verified_node_version(), "24.21.0");
    assert_eq!(
        runtime.verified_executable_sha256(),
        "185e384f0784005202c0ad19c569f6764c6109f1c9903a36417578d28322f68a"
    );
    assert_eq!(
        runtime.verified_license_sha256(),
        "5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace"
    );
    assert!(runtime.executable_path().is_file());
    assert!(runtime.license_path().is_file());
    let cached_node = runtime.cached_executable_path().unwrap().to_owned();
    let cached_license = runtime.cached_license_path().unwrap().to_owned();
    assert!(cached_node.is_file() && cached_license.is_file());
    drop(runtime);
    assert!(
        cached_node.is_file() && cached_license.is_file(),
        "managed cache persists after generation snapshot retirement"
    );
    let again = provision::official_mac_fixture(&app, &root).unwrap();
    assert_eq!(again.cached_executable_path(), Some(cached_node.as_path()));
}
