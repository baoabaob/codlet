use super::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;

#[test]
fn macos_signed_bundle_update_archive() {
    let Ok(app) = std::env::var("CODLET_MAC_UPDATE_APP") else {
        return;
    };
    let zip = PathBuf::from(std::env::var("CODLET_MAC_UPDATE_ZIP").expect("update ZIP path"));
    let app = PathBuf::from(app).canonicalize().unwrap();
    assert_eq!(app.file_name(), Some(std::ffi::OsStr::new("Codlet.app")));
    let root = app.parent().unwrap();
    let current =
        package::inspect_installation(root, RuntimePayloadProfile::MacApp, false).unwrap();
    let mut input = std::fs::File::open(&zip).unwrap();
    let mut digest = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = input.read(&mut buffer).unwrap();
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
        bytes += n as u64;
    }
    let candidate = source::Candidate {
        public: RuntimeUpdateCandidate {
            id: "0".repeat(64),
            version: CURRENT_VERSION.into(),
            platform: PLATFORM.into(),
            size: bytes,
            sha256: format!("{:x}", digest.finalize()),
            release_url: None,
        },
        profile: RuntimePayloadProfile::MacApp,
        url: url::Url::parse(
            "https://github.com/baoabaob/codlet/releases/download/fixture/update.zip",
        )
        .unwrap(),
        origins: BTreeSet::new(),
    };
    let state = tempfile::tempdir_in(root.parent().unwrap()).unwrap();
    let staged = package::stage_archive(&zip, &candidate, state.path()).unwrap();
    assert_eq!(staged.manifest.files, current.files);
    package::recheck_staged(&staged).unwrap();
    let core = staged
        .directory
        .join("Codlet.app/Contents/Resources/codlet");
    std::fs::set_permissions(&core, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        package::recheck_staged(&staged).unwrap_err().code,
        "runtime_update_digest_mismatch"
    );
}

#[test]
fn completed_mac_helper_is_cleaned_only_after_its_exact_process_exits() {
    use std::process::Command;
    let state = tempfile::tempdir().unwrap();
    let job = state.path().join("runtime-install-cleanup-fixture");
    std::fs::create_dir(&job).unwrap();
    let node = job.join("helper-node");
    let probe = job.join("identity-core");
    for file in [&node, &probe] {
        std::fs::write(file, b"private helper fixture").unwrap();
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let node_record = package::file_record(&node, "").unwrap();
    let probe_record = package::file_record(&probe, "").unwrap();
    let plan = serde_json::json!({
        "schema":1,"kind":"codlet-runtime-install-plan","profile":"macApp",
        "platform":PLATFORM,"id":"runtime-install-cleanup-fixture",
        "helperNode":{"path":node,"bytes":node_record.bytes,"sha256":node_record.sha256,"mode":node_record.mode},
        "identityProbe":{"path":probe,"bytes":probe_record.bytes,"sha256":probe_record.sha256,"mode":probe_record.mode}
    });
    let plan_path = job.join("install-plan.json");
    package::atomic_json(&plan_path, &plan).unwrap();
    let digest = format!(
        "{:x}",
        Sha256::digest(package::read_file(&plan_path, 2 * 1024 * 1024).unwrap())
    );
    let mut child = Command::new("/bin/sleep").arg("1").spawn().unwrap();
    let born = {
        let until = std::time::Instant::now() + std::time::Duration::from_secs(1);
        loop {
            if let Ok(identity) = crate::macos::identity::ProcessIdentity::inspect(child.id()) {
                break identity;
            }
            assert!(std::time::Instant::now() < until);
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    };
    let identity = RuntimeProcessIdentity {
        pid: child.id(),
        creation_time: format!("{}{:06}", born.started_seconds, born.started_microseconds),
    };
    let receipt_path = job.join("install-receipt.json");
    package::atomic_json(
        &receipt_path,
        &serde_json::json!({
            "schema":1,"id":"runtime-install-cleanup-fixture","planSha256":digest,
            "phase":"installed","version":CURRENT_VERSION,"helperIdentity":identity.clone()
        }),
    )
    .unwrap();
    assert!(!install::cleanup_completed_mac_helper(
        &receipt_path,
        &digest,
        &identity
    ));
    assert!(node.exists() && probe.exists());
    child.wait().unwrap();
    assert!(install::cleanup_completed_mac_helper(
        &receipt_path,
        &digest,
        &identity
    ));
    assert!(!node.exists() && !probe.exists());
    assert!(receipt_path.exists() && plan_path.exists());
}
