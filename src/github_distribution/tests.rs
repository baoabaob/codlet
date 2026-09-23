use super::*;
use std::collections::VecDeque;
use std::io::{Cursor, Write};
use std::net::TcpListener;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

fn zip_files(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, content) in files {
        writer
            .start_file(
                *name,
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
        writer.write_all(content).unwrap();
    }
    writer.finish().unwrap().into_inner()
}
fn manifest() -> &'static [u8] {
    br#"{"schema":1,"id":"dev.github-fixture","name":"GitHub fixture","version":"1","renderer":{"entry":"dist/entry.js","world":"isolated"},"permissions":["ui.dom"]}"#
}
fn good_zip() -> Vec<u8> {
    zip_files(&[
        ("codlet.json", manifest()),
        (
            "dist/entry.js",
            b"throw new Error('must never execute on download');",
        ),
    ])
}

#[test]
fn deflated_prebuilt_packages_with_explicit_directories_are_supported() {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    writer.start_file("codlet.json", options).unwrap();
    writer.write_all(manifest()).unwrap();
    writer
        .add_directory("dist/", zip::write::SimpleFileOptions::default())
        .unwrap();
    writer.start_file("dist/entry.js", options).unwrap();
    writer
        .write_all(b"throw new Error('not executed');")
        .unwrap();
    let bytes = writer.finish().unwrap().into_inner();
    let temp = tempfile::tempdir().unwrap();
    let prepared = test_prepare_archive(&temp.path().join("config.json"), &bytes).unwrap();
    assert_eq!(prepared.manifest.id, "dev.github-fixture");
}
fn with_extra(name: &str, bytes: &[u8]) -> Vec<u8> {
    zip_files(&[
        ("codlet.json", manifest()),
        ("dist/entry.js", b"throw 1;"),
        (name, bytes),
    ])
}
fn repository() -> GitHubRepository {
    GitHubRepository::parse("https://github.com/dev-owner/dev-repo").unwrap()
}

#[test]
fn strict_links_accept_repo_release_tag_and_zip_asset() {
    for value in [
        "https://github.com/dev-owner/dev-repo",
        "https://github.com/dev-owner/dev-repo/releases/",
    ] {
        assert_eq!(GitHubLink::parse(value).unwrap().repository, repository());
    }
    let link = GitHubLink::parse(
        "https://github.com/dev-owner/dev-repo/releases/download/release%2Fv1/plugin.zip",
    )
    .unwrap();
    assert_eq!(link.tag.as_deref(), Some("release/v1"));
    assert_eq!(link.asset_name.as_deref(), Some("plugin.zip"));
    assert!(
        GitHubLink::parse("https://github.com/dev-owner/dev-repo/releases/latest")
            .unwrap()
            .latest
    );
    assert_eq!(
        GitHubRepository::parse("https://github.com/DEV-Owner/Dev-Repo").unwrap(),
        repository()
    );
    for value in [
        "http://github.com/dev-owner/dev-repo",
        "https://github.com.evil/dev-owner/dev-repo",
        "https://user@github.com/dev-owner/dev-repo",
        "https://github.com:443/dev-owner/dev-repo",
        "https://github.com/dev-owner/dev-repo?token=x",
        "https://github.com/dev-owner/dev-repo#readme",
        "https://github.com/dev-owner/dev-repo/tree/main",
        "https://github.com/dev-owner/dev-repo/archive/main.zip",
        "https://github.com/dev-owner/dev-repo.git",
        "https://github.com/a/../dev-owner/dev-repo",
        "https://github.com/a/%2e%2e/dev-repo",
        "https://github.com/dev-owner%2frepo/dev-repo",
        "https://github.com/dev-owner/dev-repo/releases/tag/%2e%2e",
        "https://github.com/dev-owner/dev-repo/releases/download/v1/source.tar.gz",
        "https://github.com/dev-owner/dev-repo/releases/download/v1/..%2fplugin.zip",
        "https://github.com/dev-owner/dev-repo/releases/tag/%xx",
        "https://github.com/dev-owner/dev-repo\n",
        "https://github.com\\evil/dev-owner/dev-repo",
    ] {
        assert!(GitHubLink::parse(value).is_err(), "accepted {value}");
    }
}

#[test]
fn transport_origin_policy_has_no_production_http_or_suffix_exemption() {
    for value in [
        "https://api.github.com/repos/o/r/releases",
        "https://github.com/o/r/releases/download/v/a.zip",
        "https://release-assets.githubusercontent.com/path?signature=opaque",
        "https://objects.githubusercontent.com/path",
    ] {
        assert!(trusted_url(&Url::parse(value).unwrap(), true));
    }
    for value in [
        "http://api.github.com/repos/o/r/releases",
        "https://127.0.0.1/file",
        "https://api.github.com.evil/file",
        "https://evil.githubusercontent.com/file",
        "https://github.com:444/file",
        "https://user:pass@github.com/file",
        "file:///C:/secret",
        "https://codeload.github.com/o/r/zip/v1",
    ] {
        assert!(
            !trusted_url(&Url::parse(value).unwrap(), true),
            "accepted {value}"
        );
    }
    assert!(!trusted_url(
        &Url::parse("https://github.com/file").unwrap(),
        false
    ));
}

#[test]
fn preparing_persists_exact_bytes_and_detects_later_changes_without_execution() {
    let temp = tempfile::tempdir().unwrap();
    let registry = temp.path().join("config.json");
    let bytes = good_zip();
    let prepared = test_prepare_archive(&registry, &bytes).unwrap();
    assert!(prepared.source.upstream_digest_verified);
    assert_eq!(
        prepared.archive_sha256,
        format!("{:x}", Sha256::digest(&bytes))
    );
    assert_eq!(prepared.manifest.id, "dev.github-fixture");
    assert_eq!(
        std::fs::read(prepared.package_path.join("dist/entry.js")).unwrap(),
        b"throw new Error('must never execute on download');"
    );
    assert!(!registry.exists());
    assert_eq!(
        inspect_prepared_package(&registry, &prepared.package_path)
            .unwrap()
            .source,
        prepared.source
    );
    std::fs::write(prepared.package_path.join("dist/entry.js"), b"changed").unwrap();
    assert_eq!(
        inspect_prepared_package(&registry, &prepared.package_path)
            .unwrap_err()
            .code,
        "github_package_changed"
    );
}

#[cfg(windows)]
#[test]
fn powershell_release_package_interoperates_with_strict_preparation_without_execution() {
    use std::os::windows::process::CommandExt;

    fn files_below(root: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
        let mut files = std::collections::BTreeMap::new();
        let mut pending = vec![root.to_path_buf()];
        while let Some(directory) = pending.pop() {
            for entry in std::fs::read_dir(directory).unwrap() {
                let entry = entry.unwrap();
                let path = entry.path();
                if entry.file_type().unwrap().is_dir() {
                    pending.push(path);
                } else {
                    assert!(entry.file_type().unwrap().is_file());
                    files.insert(
                        path.strip_prefix(root)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/"),
                        std::fs::read(path).unwrap(),
                    );
                }
            }
        }
        files
    }

    let repository = Path::new(env!("CARGO_MANIFEST_DIR"));
    let temp = tempfile::tempdir().unwrap();
    let author = temp.path().join("prepared plugin 测试");
    std::fs::create_dir(&author).unwrap();
    for (relative, bytes) in files_below(&repository.join("examples/github-release-check/v1")) {
        let path = author.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }
    let sentinel = temp.path().join("javascript-executed.txt");
    let sentinel_literal = serde_json::to_string(&sentinel.to_string_lossy()).unwrap();
    std::fs::write(
        author.join("renderer.js"),
        format!(
            "if (typeof require === 'function') require('node:fs').writeFileSync({sentinel_literal}, 'executed');\nthrow new Error('Packaging and preparation must never execute plugin JavaScript');\n"
        ),
    )
    .unwrap();
    std::fs::create_dir(author.join("resources")).unwrap();
    std::fs::write(author.join("resources/nested.txt"), b"Release resource\r\n").unwrap();
    let expected_files = files_below(&author);
    let archive_path = temp.path().join("release output 测试/plugin.zip");
    let powershell = PathBuf::from(std::env::var_os("SystemRoot").expect("Windows system root"))
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let output = std::process::Command::new(powershell)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(repository.join("scripts/Build-PluginPackage.ps1"))
        .arg("-PluginDirectory")
        .arg(&author)
        .arg("-OutputPath")
        .arg(&archive_path)
        .creation_flags(0x0800_0000)
        .output()
        .expect("run the checked-in PowerShell package builder");
    assert!(
        output.status.success(),
        "PowerShell package build failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        !sentinel.exists(),
        "the package builder executed JavaScript"
    );
    let bytes = std::fs::read(&archive_path).unwrap();
    let expected_sha = format!("{:x}", Sha256::digest(&bytes));
    let builder_report: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&output.stdout)).unwrap();
    assert_eq!(builder_report["Sha256"], expected_sha);
    assert_eq!(builder_report["Files"], expected_files.len());

    let registry = temp.path().join("fresh registry 测试/config.json");
    assert!(!registry.exists());
    let prepared = test_prepare_archive(&registry, &bytes).unwrap();
    assert_eq!(prepared.archive_sha256, expected_sha);
    assert_eq!(prepared.source.sha256, expected_sha);
    assert!(prepared.source.upstream_digest_verified);
    let expected_manifest: PluginManifest =
        serde_json::from_slice(&expected_files["codlet.json"]).unwrap();
    assert_eq!(prepared.manifest, expected_manifest);
    assert_eq!(prepared.manifest.id, "dev.example.github-release-check");
    assert_eq!(prepared.manifest.version, "1.0.0");
    assert!(
        prepared.package_path.starts_with(
            registry
                .parent()
                .unwrap()
                .join("packages/github")
                .canonicalize()
                .unwrap()
        )
    );
    let mut actual_files = files_below(&prepared.package_path);
    assert!(actual_files.remove(RECEIPT).is_some());
    assert_eq!(actual_files, expected_files);
    assert_eq!(files_below(&author), expected_files);
    assert_eq!(
        inspect_prepared_package(&registry, &prepared.package_path)
            .unwrap()
            .source,
        prepared.source
    );
    assert!(!registry.exists(), "preparation registered the plugin");
    assert!(!sentinel.exists(), "preparation executed plugin JavaScript");
}

#[test]
fn package_receipt_cannot_be_injected_and_paths_must_be_owned() {
    let temp = tempfile::tempdir().unwrap();
    let registry = temp.path().join("config.json");
    for name in [RECEIPT, ".CODLET-SOURCE.JSON", "nested/.codlet-source.json"] {
        assert!(test_prepare_archive(&registry, &with_extra(name, b"{}")).is_err());
    }
    let prepared = test_prepare_archive(&registry, &good_zip()).unwrap();
    assert!(
        inspect_prepared_package(
            &temp.path().join("other/config.json"),
            &prepared.package_path
        )
        .is_err()
    );
    assert!(inspect_prepared_package(&registry, &prepared.package_path.join("dist")).is_err());
    assert!(inspect_prepared_package(&registry, Path::new("relative")).is_err());
    let copy = prepared
        .package_path
        .parent()
        .unwrap()
        .join(format!("{}-copy", prepared.archive_sha256));
    std::fs::create_dir(&copy).unwrap();
    std::fs::copy(prepared.package_path.join(RECEIPT), copy.join(RECEIPT)).unwrap();
    assert!(
        inspect_prepared_package(&registry, &copy).is_err(),
        "a copied receipt without its checked package must be rejected"
    );
}

#[test]
fn unsafe_archive_paths_are_rejected_before_extraction_and_failure_cleans_staging() {
    let temp = tempfile::tempdir().unwrap();
    let registry = temp.path().join("config.json");
    for path in [
        "../outside.js",
        "a/../../outside.js",
        "/absolute.js",
        "C:/outside.js",
        "a\\b.js",
        "a//b.js",
        "a/./b.js",
        "CON.js",
        "NUL .txt",
        "nul",
        "COM0.txt",
        "COM1.txt",
        "Lpt9.json",
        "file. ",
        "dir./entry.js",
        "entry.js:stream",
        "LONGFI~1.JS",
        " leading",
        "a?b",
        "中文.js",
    ] {
        let bytes = with_extra(path, b"bad");
        assert!(
            test_prepare_archive(&registry, &bytes).is_err(),
            "accepted {path}"
        );
        let root = temp.path().join("packages/github/.staging");
        if root.exists() {
            assert_eq!(
                std::fs::read_dir(root).unwrap().count(),
                0,
                "left staging for {path}"
            );
        }
    }
    assert!(!temp.path().join("outside.js").exists());
}

#[test]
fn rejects_case_collisions_duplicate_records_and_directory_conflicts() {
    let temp = tempfile::tempdir().unwrap();
    let registry = temp.path().join("config.json");
    for (a, b) in [
        ("Docs/a.txt", "docs/b.txt"),
        ("readme", "README"),
        ("file", "file/nested"),
    ] {
        let bytes = zip_files(&[
            ("codlet.json", manifest()),
            ("dist/entry.js", b"throw 1;"),
            (a, b"a"),
            (b, b"b"),
        ]);
        assert!(
            test_prepare_archive(&registry, &bytes).is_err(),
            "accepted {a} / {b}"
        );
    }
    let mut bytes = with_extra("Codlet.json", b"other");
    for i in 0..bytes.len() - 11 {
        if &bytes[i..i + 11] == b"Codlet.json" {
            bytes[i] = b'c';
        }
    }
    assert!(test_prepare_archive(&registry, &bytes).is_err());
}

#[test]
fn rejects_symlinks_special_files_and_malformed_zip_framing() {
    let temp = tempfile::tempdir().unwrap();
    let registry = temp.path().join("config.json");
    let original = good_zip();
    let central = original
        .windows(4)
        .position(|s| s == b"PK\x01\x02")
        .unwrap();
    let end = original.len() - 22;
    let mut variants = Vec::new();
    let mut symlink = original.clone();
    symlink[central + 38..central + 42].copy_from_slice(&(0o120777u32 << 16).to_le_bytes());
    variants.push(symlink);
    let mut special = original.clone();
    special[central + 38..central + 42].copy_from_slice(&(0o010644u32 << 16).to_le_bytes());
    variants.push(special);
    let mut encrypted = original.clone();
    encrypted[central + 8] |= 1;
    variants.push(encrypted);
    let mut multidisk = original.clone();
    multidisk[end + 4] = 1;
    variants.push(multidisk);
    let mut oversized = original.clone();
    oversized[central + 24..central + 28]
        .copy_from_slice(&((MAX_EXTRACTED_BYTES + 1) as u32).to_le_bytes());
    variants.push(oversized);
    let mut mismatch = original.clone();
    mismatch[30] = b'x';
    variants.push(mismatch);
    let mut trailing = original.clone();
    trailing.extend_from_slice(b"payload");
    variants.push(trailing);
    let mut prefix = b"MZ".to_vec();
    prefix.extend_from_slice(&original);
    variants.push(prefix);
    let mut crc = original.clone();
    crc[14..18].copy_from_slice(&1u32.to_le_bytes());
    crc[central + 16..central + 20].copy_from_slice(&1u32.to_le_bytes());
    variants.push(crc);
    let mut count = original.clone();
    count[end + 8..end + 10].copy_from_slice(&2049u16.to_le_bytes());
    count[end + 10..end + 12].copy_from_slice(&2049u16.to_le_bytes());
    variants.push(count);
    variants.push(original[..original.len() - 1].to_vec());
    for (i, bytes) in variants.iter().enumerate() {
        assert!(
            test_prepare_archive(&registry, bytes).is_err(),
            "accepted malicious ZIP {i}"
        );
    }
}

#[test]
fn no_source_archive_build_fallback_and_metadata_is_separate() {
    let temp = tempfile::tempdir().unwrap();
    let registry = temp.path().join("config.json");
    let wrapped = zip_files(&[
        ("repo-v1/codlet.json", manifest()),
        ("repo-v1/dist/entry.js", b"throw 1;"),
    ]);
    assert_eq!(
        test_prepare_archive(&registry, &wrapped).unwrap_err().code,
        "github_package_manifest_missing"
    );
    let raw = zip_files(&[
        ("codlet.json", manifest()),
        ("src/entry.ts", b"const x: string = 'typescript';"),
        ("package.json", br#"{"scripts":{"build":"exit 99"}}"#),
    ]);
    assert!(test_prepare_archive(&registry, &raw).is_err());
    let metadata = br#"{"schema":1,"runtimeApi":1,"platforms":["any"],"author":"fixture","adapters":{"thirdParty":{"version":"opaque"}}}"#;
    let prepared =
        test_prepare_archive(&registry, &with_extra("codlet-package.json", metadata)).unwrap();
    assert_eq!(
        prepared.metadata.unwrap().author.as_deref(),
        Some("fixture")
    );
    let target_metadata = serde_json::json!({"schema":1,"platforms":[format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)]});
    assert!(
        test_prepare_archive(
            &registry,
            &with_extra(
                "codlet-package.json",
                &serde_json::to_vec(&target_metadata).unwrap()
            )
        )
        .is_ok()
    );
    let unsupported_runtime = test_prepare_archive(
        &registry,
        &with_extra("codlet-package.json", br#"{"schema":1,"runtimeApi":999}"#),
    )
    .unwrap();
    assert_eq!(
        device_compatibility(unsupported_runtime.metadata.as_ref()).status,
        "incompatible"
    );
    let unsupported_platform = test_prepare_archive(
        &registry,
        &with_extra(
            "codlet-package.json",
            br#"{"schema":1,"platforms":["unsupportedOS"]}"#,
        ),
    )
    .unwrap();
    assert_eq!(
        device_compatibility(unsupported_platform.metadata.as_ref()).status,
        "incompatible"
    );
    assert!(
        test_prepare_archive(
            &registry,
            &with_extra(
                "codlet-package.json",
                br#"{"schema":1,"build":"npm run build"}"#
            )
        )
        .is_err()
    );
}

#[test]
fn hardlinked_prepared_files_are_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let registry = temp.path().join("config.json");
    let prepared = test_prepare_archive(&registry, &good_zip()).unwrap();
    std::fs::hard_link(
        prepared.package_path.join("dist/entry.js"),
        temp.path().join("external-link"),
    )
    .unwrap();
    assert_eq!(
        inspect_prepared_package(&registry, &prepared.package_path)
            .unwrap_err()
            .code,
        "github_package_unowned"
    );
}

struct Fixture {
    origin: Url,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Fixture {
    fn new(responses: Vec<Vec<u8>>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (request_log, stop_flag) = (requests.clone(), stop.clone());
        let worker = std::thread::spawn(move || {
            let mut responses: VecDeque<_> = responses.into();
            while !stop_flag.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        // Windows accepted sockets inherit listener nonblocking
                        // mode. Each fixture connection uses bounded blocking I/O.
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        let mut request = Vec::new();
                        let mut buffer = [0; 1024];
                        while !request.windows(4).any(|v| v == b"\r\n\r\n") {
                            let n = stream.read(&mut buffer).unwrap();
                            if n == 0 {
                                break;
                            }
                            request.extend_from_slice(&buffer[..n]);
                            assert!(request.len() < 8192);
                        }
                        request_log
                            .lock()
                            .unwrap()
                            .push(String::from_utf8(request).unwrap());
                        let response = responses.pop_front().expect("unexpected HTTP request");
                        // An empty test response deliberately stalls the socket
                        // until the test drops its fixture; never compiled in production.
                        if response.is_empty() {
                            while !stop_flag.load(Ordering::Relaxed) {
                                std::thread::sleep(Duration::from_millis(2));
                            }
                        }
                        let _ = stream.write_all(&response);
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
            worker: Some(worker),
        }
    }
    fn client(&self) -> GitHubClient {
        GitHubClient {
            client: GitHubClient::http_builder().no_proxy().build().unwrap(),
            fixture_origin: Some(self.origin.clone()),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let joined = self.worker.take().unwrap().join();
        if !std::thread::panicking() {
            joined.unwrap();
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
fn release_json(bytes: &[u8], digest: bool) -> serde_json::Value {
    serde_json::json!({"id":1,"tag_name":"v1.0.0","name":"Fixture","html_url":"https://github.com/dev-owner/dev-repo/releases/tag/v1.0.0",
        "draft":false,"prerelease":false,"published_at":"2026-09-12T00:00:00Z", "assets":[{"id":2,"name":"plugin.zip","size":bytes.len(),
        "content_type":"application/zip","browser_download_url":"https://github.com/dev-owner/dev-repo/releases/download/v1.0.0/plugin.zip","state":"uploaded",
        "digest":if digest { Some(format!("sha256:{:x}", Sha256::digest(bytes))) } else { None }}]})
}
fn repository_identity_response() -> Vec<u8> {
    response("200 OK", "Content-Type: application/json\r\n", br#"{"id":1001,"html_url":"https://github.com/dev-owner/dev-repo","full_name":"dev-owner/dev-repo","owner":{"id":2002,"login":"dev-owner"}}"#)
}

#[tokio::test]
async fn topic_discovery_keeps_uninspected_zip_metrics_unknown() {
    let search = serde_json::json!({"total_count":1,"items":[{"id":1001,"full_name":"dev-owner/dev-repo","html_url":"https://github.com/dev-owner/dev-repo","name":"dev-repo","owner":{"id":2002,"login":"dev-owner"},"description":"Plugin candidate","topics":["codlet-plugin","adapter"],"private":false,"archived":false}]});
    let mut release = release_json(&good_zip(), true);
    release["assets"][0]["download_count"] = serde_json::json!(13);
    let fixture = Fixture::new(vec![
        response("200 OK", "", &serde_json::to_vec(&search).unwrap()),
        response(
            "200 OK",
            "",
            &serde_json::to_vec(&vec![release.clone()]).unwrap(),
        ),
    ]);
    let query = MarketQuery {
        query: "#adapter".into(),
        page: 1,
        refresh: false,
    };
    let page = fixture.client().discover(&query).await.unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].repository_id, 1001);
    assert_eq!(page.items[0].owner_id, 2002);
    assert_eq!(page.items[0].plugin_id, None);
    assert_eq!(page.items[0].total_downloads, None);
    assert!(!page.items[0].latest_release_verified);
    assert_eq!(page.items[0].latest_installable_published_at, None);
    assert_eq!(page.items[0].latest_release.assets[0].download_count, None);
    assert_eq!(
        page.items[0].latest_release.published_at.as_deref(),
        Some("2026-09-12T00:00:00Z")
    );
    assert!(!page.has_more);
    let requests = fixture.requests.lock().unwrap();
    assert!(requests[0].contains("topic%3Acodlet-plugin+topic%3Aadapter"));
    assert!(requests[1].starts_with("GET /repos/dev-owner/dev-repo/releases?per_page=100&page=1"));
}

#[tokio::test]
async fn readme_zip_is_only_a_candidate_and_never_a_plugin_download_count() {
    let search = serde_json::json!({"total_count":1,"items":[{"id":1001,"full_name":"dev-owner/dev-repo","html_url":"https://github.com/dev-owner/dev-repo","name":"dev-repo","owner":{"id":2002,"login":"dev-owner"},"description":null,"topics":["codlet-plugin"]}]});
    let mut release = release_json(&good_zip(), true);
    release["assets"][0]["name"] = serde_json::json!("README.zip");
    release["assets"][0]["browser_download_url"] = serde_json::json!(
        "https://github.com/dev-owner/dev-repo/releases/download/v1.0.0/README.zip"
    );
    release["assets"][0]["download_count"] = serde_json::json!(999);
    let fixture = Fixture::new(vec![
        response("200 OK", "", &serde_json::to_vec(&search).unwrap()),
        response("200 OK", "", &serde_json::to_vec(&vec![release]).unwrap()),
    ]);
    let page = fixture
        .client()
        .discover(&MarketQuery {
            query: String::new(),
            page: 1,
            refresh: false,
        })
        .await
        .unwrap();
    assert_eq!(page.items[0].total_downloads, None);
    assert!(!page.items[0].latest_release_verified);
    assert_eq!(page.items[0].latest_installable_published_at, None);
}

#[tokio::test]
async fn matching_release_declaration_selects_one_zip_for_declared_market_stats() {
    let archive = good_zip();
    let search = serde_json::json!({"total_count":1,"items":[{"id":1001,"full_name":"dev-owner/dev-repo","html_url":"https://github.com/dev-owner/dev-repo","name":"dev-repo","owner":{"id":2002,"login":"dev-owner"},"description":"Plugin candidate","topics":["codlet-plugin"]}]});
    let declaration = serde_json::json!({"schema":1,"kind":"codlet-plugin-release",
        "manifest":serde_json::from_slice::<serde_json::Value>(manifest()).unwrap(),
        "metadata":{"schema":1,"runtimeApi":1,"platforms":["any"],"author":"Publisher"},
        "asset":{"name":"plugin.zip","bytes":archive.len(),"sha256":format!("{:x}",Sha256::digest(&archive))}});
    let declaration_bytes = serde_json::to_vec(&declaration).unwrap();
    let mut release = release_json(&archive, true);
    release["assets"][0]["download_count"] = serde_json::json!(13);
    release["assets"].as_array_mut().unwrap().push(serde_json::json!({"id":3,"name":"codlet-release.json","size":declaration_bytes.len(),"content_type":"application/json","browser_download_url":"https://github.com/dev-owner/dev-repo/releases/download/v1.0.0/codlet-release.json","state":"uploaded","digest":format!("sha256:{:x}",Sha256::digest(&declaration_bytes)),"download_count":99}));
    let fixture = Fixture::new(vec![
        response("200 OK", "", &serde_json::to_vec(&search).unwrap()),
        response(
            "200 OK",
            "",
            &serde_json::to_vec(&vec![release.clone()]).unwrap(),
        ),
        response("200 OK", "", &declaration_bytes),
    ]);
    let page = fixture
        .client()
        .discover(&MarketQuery {
            query: String::new(),
            page: 1,
            refresh: false,
        })
        .await
        .unwrap();
    let item = &page.items[0];
    assert_eq!(item.declaration_status, "matched");
    assert!(!item.latest_release_verified);
    assert_eq!(
        item.latest_installable_published_at.as_deref(),
        Some("2026-09-12T00:00:00Z")
    );
    assert_eq!(item.total_downloads, Some(13));
    let declared = item.declared_package.as_ref().unwrap();
    assert_eq!(declared.manifest.id, "dev.github-fixture");
    assert_eq!(declared.metadata.author.as_deref(), Some("Publisher"));
    assert_eq!(declared.asset.id, 2);
    assert_eq!(declared.asset.download_count, Some(13));
    assert_eq!(declared.basis, "publisher-release-declaration");
    assert_eq!(fixture.requests.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn mismatched_release_declaration_cannot_create_download_stats() {
    let archive = good_zip();
    let search = serde_json::json!({"total_count":1,"items":[{"id":1001,"full_name":"dev-owner/dev-repo","html_url":"https://github.com/dev-owner/dev-repo","name":"dev-repo","owner":{"id":2002,"login":"dev-owner"},"description":null,"topics":["codlet-plugin"]}]});
    let declaration = serde_json::json!({"schema":1,"kind":"codlet-plugin-release",
        "manifest":serde_json::from_slice::<serde_json::Value>(manifest()).unwrap(),
        "metadata":{"schema":1,"runtimeApi":1,"platforms":["any"]},
        "asset":{"name":"plugin.zip","bytes":archive.len(),"sha256":"0".repeat(64)}});
    let declaration_bytes = serde_json::to_vec(&declaration).unwrap();
    let mut release = release_json(&archive, true);
    release["assets"][0]["download_count"] = serde_json::json!(1000);
    release["assets"].as_array_mut().unwrap().push(serde_json::json!({"id":3,"name":"codlet-release.json","size":declaration_bytes.len(),"content_type":"application/json","browser_download_url":"https://github.com/dev-owner/dev-repo/releases/download/v1.0.0/codlet-release.json","state":"uploaded","digest":null}));
    let fixture = Fixture::new(vec![
        response("200 OK", "", &serde_json::to_vec(&search).unwrap()),
        response(
            "200 OK",
            "",
            &serde_json::to_vec(&vec![release.clone()]).unwrap(),
        ),
        response("200 OK", "", &declaration_bytes),
    ]);
    let page = fixture
        .client()
        .discover(&MarketQuery {
            query: String::new(),
            page: 1,
            refresh: false,
        })
        .await
        .unwrap();
    assert_eq!(page.items[0].declaration_status, "invalid");
    assert!(page.items[0].declared_package.is_none());
    assert_eq!(page.items[0].total_downloads, None);
    let disappeared = Fixture::new(vec![
        response("200 OK", "", &serde_json::to_vec(&search).unwrap()),
        response("200 OK", "", &serde_json::to_vec(&vec![release]).unwrap()),
        response("404 Not Found", "", b""),
    ]);
    let page = disappeared
        .client()
        .discover(&MarketQuery {
            query: String::new(),
            page: 1,
            refresh: false,
        })
        .await
        .unwrap();
    assert_eq!(page.items[0].declaration_status, "invalid");
    assert_eq!(page.items[0].total_downloads, None);
}

#[tokio::test]
async fn older_release_without_a_declaration_keeps_total_unknown() {
    let archive = good_zip();
    let search = serde_json::json!({"total_count":1,"items":[{"id":1001,"full_name":"dev-owner/dev-repo","html_url":"https://github.com/dev-owner/dev-repo","name":"dev-repo","owner":{"id":2002,"login":"dev-owner"},"description":null,"topics":["codlet-plugin"]}]});
    let declaration = serde_json::json!({"schema":1,"kind":"codlet-plugin-release",
        "manifest":serde_json::from_slice::<serde_json::Value>(manifest()).unwrap(),
        "metadata":{"schema":1,"runtimeApi":1,"platforms":["any"]},
        "asset":{"name":"plugin.zip","bytes":archive.len(),"sha256":format!("{:x}",Sha256::digest(&archive))}});
    let declaration_bytes = serde_json::to_vec(&declaration).unwrap();
    let mut current = release_json(&archive, true);
    current["assets"][0]["download_count"] = serde_json::json!(13);
    current["assets"].as_array_mut().unwrap().push(serde_json::json!({"id":3,"name":"codlet-release.json","size":declaration_bytes.len(),"content_type":"application/json","browser_download_url":"https://github.com/dev-owner/dev-repo/releases/download/v1.0.0/codlet-release.json","state":"uploaded","digest":null}));
    let mut older = release_json(&archive, true);
    older["id"] = serde_json::json!(4);
    older["tag_name"] = serde_json::json!("v0.9.0");
    older["html_url"] =
        serde_json::json!("https://github.com/dev-owner/dev-repo/releases/tag/v0.9.0");
    older["published_at"] = serde_json::json!("2026-08-12T00:00:00Z");
    older["assets"][0]["id"] = serde_json::json!(5);
    older["assets"][0]["browser_download_url"] = serde_json::json!(
        "https://github.com/dev-owner/dev-repo/releases/download/v0.9.0/plugin.zip"
    );
    older["assets"][0]["download_count"] = serde_json::json!(100);
    let fixture = Fixture::new(vec![
        response("200 OK", "", &serde_json::to_vec(&search).unwrap()),
        response(
            "200 OK",
            "",
            &serde_json::to_vec(&vec![current, older]).unwrap(),
        ),
        response("200 OK", "", &declaration_bytes),
    ]);
    let page = fixture
        .client()
        .discover(&MarketQuery {
            query: String::new(),
            page: 1,
            refresh: false,
        })
        .await
        .unwrap();
    assert_eq!(page.items[0].declaration_status, "matched");
    assert_eq!(
        page.items[0].latest_installable_published_at.as_deref(),
        Some("2026-09-12T00:00:00Z")
    );
    assert_eq!(page.items[0].total_downloads, None);
}

#[tokio::test]
async fn a_stalled_connection_reports_a_timeout_instead_of_a_generic_send_error() {
    let fixture = Fixture::new(vec![vec![]]);
    let mut client = fixture.client();
    client.client = GitHubClient::http_builder()
        .no_proxy()
        .read_timeout(Duration::from_millis(100))
        .build()
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(3),
        client.list_releases(&GitHubLink::parse("https://github.com/dev-owner/dev-repo").unwrap()),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert_eq!(result.code, "github_timeout");
    assert!(result.message.contains("Check the connection or proxy"));
    assert!(!result.message.contains("error sending request"));
}

#[tokio::test]
async fn fixed_http_fixture_lists_and_prepares_with_a_trusted_redirect() {
    let bytes = good_zip();
    let release = release_json(&bytes, true);
    let fixture = Fixture::new(vec![
        response(
            "200 OK",
            "Content-Type: application/json\r\n",
            serde_json::to_vec(&vec![&release]).unwrap().as_slice(),
        ),
        response(
            "200 OK",
            "",
            serde_json::to_vec(&release).unwrap().as_slice(),
        ),
        repository_identity_response(),
        response(
            "302 Found",
            "Location: https://release-assets.githubusercontent.com/fixture?signature=opaque\r\n",
            b"",
        ),
        response(
            "200 OK",
            "Content-Type: application/octet-stream\r\n",
            &bytes,
        ),
    ]);
    let client = fixture.client();
    let link = GitHubLink::parse(&repository().url).unwrap();
    let catalog = client.list_releases(&link).await.unwrap();
    assert_eq!(catalog.releases.len(), 1);
    assert_eq!(catalog.releases[0].assets[0].id, 2);
    let temp = tempfile::tempdir().unwrap();
    let package = client
        .prepare_asset(&repository(), 1, 2, &temp.path().join("config.json"))
        .await
        .unwrap();
    assert!(package.source.upstream_digest_verified);
    assert_eq!(package.source.repository_id, Some(1001));
    assert_eq!(package.source.owner_id, Some(2002));
    let requests = fixture.requests.lock().unwrap();
    assert_eq!(requests.len(), 5);
    assert!(
        requests[0]
            .starts_with("GET /repos/dev-owner/dev-repo/releases?per_page=100&page=1 HTTP/1.1")
    );
    assert!(requests[1].starts_with("GET /repos/dev-owner/dev-repo/releases/1 HTTP/1.1"));
    assert!(requests[2].starts_with("GET /repos/dev-owner/dev-repo HTTP/1.1"));
    assert!(requests[3].contains("accept: application/octet-stream"));
    for request in requests.iter() {
        assert!(!request.to_ascii_lowercase().contains("authorization:"));
        assert!(!request.to_ascii_lowercase().contains("cookie:"));
    }
}

#[tokio::test]
async fn preparation_rejects_inconsistent_repository_identity_before_downloading() {
    let bytes = good_zip();
    let changed = br#"{"id":1002,"html_url":"https://github.com/dev-owner/dev-repo","full_name":"another-owner/dev-repo","owner":{"id":2002,"login":"dev-owner"}}"#;
    let fixture = Fixture::new(vec![
        response(
            "200 OK",
            "",
            &serde_json::to_vec(&release_json(&bytes, true)).unwrap(),
        ),
        response("200 OK", "", changed),
    ]);
    let temp = tempfile::tempdir().unwrap();
    // A repository/name mismatch cannot become a trusted source receipt.
    let result = fixture
        .client()
        .prepare_asset(&repository(), 1, 2, &temp.path().join("config.json"))
        .await;
    assert!(result.is_err());
    assert_eq!(fixture.requests.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn missing_digest_remains_explicitly_unverified_and_size_still_checked() {
    let bytes = good_zip();
    let fixture = Fixture::new(vec![
        response(
            "200 OK",
            "",
            &serde_json::to_vec(&release_json(&bytes, false)).unwrap(),
        ),
        repository_identity_response(),
        response("200 OK", "", &bytes),
    ]);
    let temp = tempfile::tempdir().unwrap();
    let package = fixture
        .client()
        .prepare_asset(&repository(), 1, 2, &temp.path().join("config.json"))
        .await
        .unwrap();
    assert!(!package.source.upstream_digest_verified);
    assert_eq!(package.archive_sha256.len(), 64);
}

#[tokio::test]
async fn transport_rejects_untrusted_redirect_rate_limit_oversize_and_truncation() {
    for (reply, expected) in [
        (response("302 Found", "Location: http://127.0.0.1/secret\r\n", b""), "github_redirect_rejected"),
        (response("302 Found", "Location: https://evil.example/secret\r\n", b""), "github_redirect_rejected"),
        (response("429 Too Many Requests", "Retry-After: 60\r\n", b"rate limited"), "github_rate_limited"),
        (response("404 Not Found", "", b"private"), "github_not_found"),
        (response("200 OK", "", b"too many bytes"), "github_response_limit"),
        (b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 4\r\n\r\na".to_vec(), "github_network"),
        (b"HTTP/1.1 200 OK\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n6\r\n123456\r\n0\r\n\r\n".to_vec(), "github_response_limit"),
    ] {
        let fixture = Fixture::new(vec![reply]);
        let error = fixture.client().get(repository().endpoint(&["releases", "assets", "2"]), true, 5).await.unwrap_err();
        assert_eq!(error.code, expected);
        assert_eq!(fixture.requests.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn changed_asset_digest_or_size_never_creates_a_package() {
    let bytes = good_zip();
    for size_mismatch in [false, true] {
        let mut metadata = release_json(&bytes, true);
        if size_mismatch {
            metadata["assets"][0]["size"] = (bytes.len() + 1).into();
        } else {
            metadata["assets"][0]["digest"] = format!("sha256:{}", "0".repeat(64)).into();
        }
        let fixture = Fixture::new(vec![
            response("200 OK", "", &serde_json::to_vec(&metadata).unwrap()),
            repository_identity_response(),
            response("200 OK", "", &bytes),
        ]);
        let temp = tempfile::tempdir().unwrap();
        let error = fixture
            .client()
            .prepare_asset(&repository(), 1, 2, &temp.path().join("config.json"))
            .await
            .unwrap_err();
        assert_eq!(
            error.code,
            if size_mismatch {
                "github_size_mismatch"
            } else {
                "github_digest_mismatch"
            }
        );
        assert!(!temp.path().join("packages").exists());
    }
}

#[tokio::test]
async fn cancellation_during_asset_download_never_creates_staging_or_receipt() {
    let bytes = good_zip();
    let fixture = Fixture::new(vec![
        response(
            "200 OK",
            "",
            &serde_json::to_vec(&release_json(&bytes, true)).unwrap(),
        ),
        repository_identity_response(),
        Vec::new(),
    ]);
    let temp = tempfile::tempdir().unwrap();
    let client = fixture.client();
    let repository = repository();
    let registry = temp.path().join("config.json");
    let result = tokio::time::timeout(
        Duration::from_millis(100),
        client.prepare_asset(&repository, 1, 2, &registry),
    )
    .await;
    assert!(result.is_err());
    assert_eq!(fixture.requests.lock().unwrap().len(), 3);
    assert!(!temp.path().join("packages").exists());
    assert!(!registry.exists());
}

#[tokio::test]
async fn fresh_selection_must_match_repository_release_and_asset_ids() {
    for mode in [
        "wrong_release",
        "wrong_repository",
        "wrong_asset",
        "bad_digest",
    ] {
        let mut metadata = release_json(&good_zip(), true);
        match mode {
            "wrong_release" => metadata["id"] = 99.into(),
            "wrong_repository" => {
                metadata["assets"][0]["browser_download_url"] =
                    "https://github.com/other/repo/releases/download/v1.0.0/plugin.zip".into()
            }
            "wrong_asset" => metadata["assets"][0]["id"] = 99.into(),
            "bad_digest" => metadata["assets"][0]["digest"] = "md5:unsupported".into(),
            _ => unreachable!(),
        }
        let fixture = Fixture::new(vec![response(
            "200 OK",
            "",
            &serde_json::to_vec(&metadata).unwrap(),
        )]);
        let temp = tempfile::tempdir().unwrap();
        assert!(
            fixture
                .client()
                .prepare_asset(&repository(), 1, 2, &temp.path().join("config.json"))
                .await
                .is_err()
        );
        assert_eq!(fixture.requests.lock().unwrap().len(), 1);
    }
}
