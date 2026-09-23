//! Explicit, isolated cross-layer acceptance for a real Windows managed ZIP.
//! A compiled Core test child stages and plans a real managed ZIP. Its parent
//! performs the helper handshake after that fake owner exits; the Codex tool
//! Job disallows production breakaway spawning. Only a fake restart script runs
//! after replacement. No installed client or user registry is used.

use super::*;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use windows_sys::Win32::System::Threading::{
    CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW,
};

const ROOT_ENV: &str = "CODLET_ACCEPTANCE_ROOT";
const ZIP_ENV: &str = "CODLET_ACCEPTANCE_ZIP";
const NODE_ENV: &str = "CODLET_ACCEPTANCE_HELPER_NODE";
const MODE_ENV: &str = "CODLET_ACCEPTANCE_MODE";

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn core_fixture() -> Vec<u8> {
    let mut bytes = vec![0u8; 128];
    bytes[..2].copy_from_slice(b"MZ");
    bytes[60..64].copy_from_slice(&64u32.to_le_bytes());
    bytes[64..68].copy_from_slice(b"PE\0\0");
    bytes[68..70].copy_from_slice(&0x8664u16.to_le_bytes());
    bytes.extend_from_slice(b"old fake owner, never executed");
    bytes
}

fn release_manifest(zip_path: &Path) -> (package::RuntimePackageManifest, Vec<u8>) {
    let bytes = fs::read(zip_path).unwrap();
    let manifest = {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
        let mut entry = archive.by_name(package::MANIFEST).unwrap();
        let mut manifest = Vec::new();
        entry.read_to_end(&mut manifest).unwrap();
        manifest
    };
    (serde_json::from_slice(&manifest).unwrap(), bytes)
}

fn put(root: &Path, relative: &str, bytes: &[u8]) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn plain_argument(path: &Path) -> String {
    let value = path.to_string_lossy();
    value.strip_prefix("\\\\?\\").unwrap_or(&value).to_owned()
}

#[test]
#[ignore = "opt-in: requires CODLET_ACCEPTANCE_ZIP and CODLET_ACCEPTANCE_HELPER_NODE"]
fn managed_cross_layer_child() {
    let root = PathBuf::from(std::env::var_os(ROOT_ENV).expect("isolated acceptance root"));
    let zip_path = PathBuf::from(std::env::var_os(ZIP_ENV).expect("real managed update ZIP"));
    let node_path = PathBuf::from(std::env::var_os(NODE_ENV).expect("runnable Node fixture"));
    let mode = std::env::var(MODE_ENV).unwrap();
    let install = root.join("installed");
    let state = root.join("updates");
    fs::create_dir(&install).unwrap();
    let old_core = core_fixture();
    let node = fs::read(&node_path).unwrap();
    let license = b"isolated fixture Node license";
    put(&install, "codlet.exe", &old_core);
    put(&install, "runtime/node-v24.18.1-win-x64/node.exe", &node);
    put(&install, "runtime/node-v24.18.1-win-x64/LICENSE", license);
    let old_pin = serde_json::json!({
        "schema":1,"version":"24.18.1",
        "platforms":{"win-x64":{"executableSha256":sha(&node),"licenseSha256":sha(license)}}
    });
    put(
        &install,
        "runtime/node-runtime.json",
        &serde_json::to_vec(&old_pin).unwrap(),
    );
    put(
        &install,
        "plugins/owner-data.txt",
        b"preserve this unknown owner data",
    );

    let (manifest, zip_bytes) = release_manifest(&zip_path);
    assert_eq!(manifest.profile, RuntimePayloadProfile::Portable);
    assert_eq!(manifest.runtime.mode, package::NodeRuntimeMode::Managed);
    let digest = sha(&zip_bytes);
    let selected = source::Candidate {
        public: RuntimeUpdateCandidate {
            id: digest.clone(),
            version: manifest.version.clone(),
            platform: PLATFORM.into(),
            size: zip_bytes.len() as u64,
            sha256: digest,
            release_url: None,
        },
        profile: RuntimePayloadProfile::Portable,
        url: url::Url::parse("https://cdn.example/acceptance.zip").unwrap(),
        origins: std::collections::BTreeSet::from(["https://cdn.example".into()]),
    };
    let state = package::ensure_state_root(&state).unwrap();
    let staged = package::stage_archive(&zip_path, &selected, &state).unwrap();
    let new_sha = staged
        .manifest
        .files
        .iter()
        .find(|file| file.path == "codlet.exe")
        .unwrap()
        .sha256
        .clone();
    assert_ne!(new_sha, sha(&old_core));

    let script = root.join("fake-restart.mjs");
    fs::write(
        &script,
        r#"import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const [install,log,newSha,mode]=process.argv.slice(2);
const actual=createHash('sha256').update(fs.readFileSync(path.join(install,'codlet.exe'))).digest('hex');
const phase=actual===newSha?'new':'old';
fs.appendFileSync(log,phase+'\n');
if(mode==='rollback'&&phase==='new')process.exitCode=1;
"#,
    )
    .unwrap();
    let restart = RuntimeRestartContext {
        profile: RuntimePayloadProfile::Portable,
        command: RuntimeRestartCommand {
            program: node_path,
            args: vec![
                plain_argument(&script),
                plain_argument(&install),
                plain_argument(&root.join("restarts.log")),
                new_sha,
                mode,
            ],
            working_directory: install.clone(),
            environment: std::collections::BTreeMap::new(),
            timeout_seconds: 30,
        },
        wait_for: vec![],
        launcher_files: vec![script],
        config_pin: None,
    };
    let request = install::prepare_install_plan(&install, &state, &staged, &restart).unwrap();
    let plan: serde_json::Value =
        serde_json::from_slice(&fs::read(&request.plan_path).unwrap()).unwrap();
    assert_eq!(plan["newRuntime"]["mode"], "managed");
    assert!(
        plan["newFiles"]
            .as_array()
            .unwrap()
            .iter()
            .all(|f| { !f["path"].as_str().unwrap().contains("node-v") })
    );
    assert!(plan["preparedNode"]["sha256"].as_str().is_some());
    assert!(!request.handoff_ack_path.exists());

    let no_breakaway = Command::new(&request.node_path)
        .arg("--version")
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let breakaway = Command::new(&request.node_path)
        .arg("--version")
        .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB)
        .output();
    let probe = serde_json::json!({
        "node":request.node_path,
        "withoutBreakaway":no_breakaway.as_ref().map(|output| serde_json::json!({"success":output.status.success(),"stdout":String::from_utf8_lossy(&output.stdout)})).map_err(|error| error.raw_os_error()),
        "withBreakaway":breakaway.as_ref().map(|output| serde_json::json!({"success":output.status.success(),"stdout":String::from_utf8_lossy(&output.stdout)})).map_err(|error| error.raw_os_error())
    });
    fs::write(root.join("breakaway-probe.json"), probe.to_string()).unwrap();

    // The Core test process is the fake old owner. It must retire before the
    // stable parent starts the helper; this host's Job forbids breakaway.
    fs::write(
        root.join("install-request.json"),
        serde_json::to_vec(&request).unwrap(),
    )
    .unwrap();
}

#[test]
#[ignore = "opt-in: real compiled Core managed ZIP, isolated fake owner only"]
fn managed_cross_layer_parent() {
    let zip = PathBuf::from(std::env::var_os(ZIP_ENV).expect("set CODLET_ACCEPTANCE_ZIP"));
    let node =
        PathBuf::from(std::env::var_os(NODE_ENV).expect("set CODLET_ACCEPTANCE_HELPER_NODE"));
    assert!(zip.is_absolute() && zip.is_file());
    assert!(node.is_absolute() && node.is_file());
    for mode in ["success", "rollback"] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "runtime_update::windows_acceptance::managed_cross_layer_child",
                "--nocapture",
            ])
            .env(ROOT_ENV, &root)
            .env(ZIP_ENV, &zip)
            .env(NODE_ENV, &node)
            .env(MODE_ENV, mode)
            .env("CODLET_HOME", root.join("codlet-home"))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let child_deadline = Instant::now() + Duration::from_secs(180);
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            if Instant::now() >= child_deadline {
                let _ = child.kill();
                panic!("{mode} planner/handoff exceeded the acceptance deadline");
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let output = child.wait_with_output().unwrap();
        let probe = fs::read_to_string(root.join("breakaway-probe.json")).unwrap_or_default();
        assert!(
            output.status.success(),
            "{mode} planner/handoff failed; breakaway probe: {probe}; stdout: {} stderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let request: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("install-request.json")).unwrap()).unwrap();
        let node = PathBuf::from(request["nodePath"].as_str().unwrap());
        let script = PathBuf::from(request["helperPath"].as_str().unwrap());
        let plan = PathBuf::from(request["planPath"].as_str().unwrap());
        let digest = request["planSha256"].as_str().unwrap();
        let mut helper = Command::new(&node)
            .arg(&script)
            .arg("--plan")
            .arg(&plan)
            .arg("--sha256")
            .arg(digest)
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = helper.stdout.take().unwrap();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut ready = String::new();
            let result = BufReader::new(stdout).read_line(&mut ready);
            let _ = sender.send((result, ready));
        });
        let (read, ready) = receiver.recv_timeout(Duration::from_secs(45)).unwrap();
        assert!(read.unwrap() > 0, "{mode} helper exited before ready");
        let ready: serde_json::Value = serde_json::from_str(&ready).unwrap();
        assert_eq!(
            ready["event"], "runtime-update-helper-ready",
            "{mode}: {ready}"
        );
        assert_eq!(ready["id"], request["id"]);
        assert_eq!(ready["planSha256"], request["planSha256"]);
        let ack = PathBuf::from(request["handoffAckPath"].as_str().unwrap());
        let temporary_ack = ack.with_extension("tmp");
        fs::write(
            &temporary_ack,
            serde_json::to_vec(&serde_json::json!({"id":request["id"],"planSha256":digest}))
                .unwrap(),
        )
        .unwrap();
        fs::rename(temporary_ack, ack).unwrap();
        let helper_deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if helper.try_wait().unwrap().is_some() {
                break;
            }
            if Instant::now() >= helper_deadline {
                let _ = helper.kill();
                panic!("{mode} helper exceeded the acceptance deadline");
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let helper_output = helper.wait_with_output().unwrap();
        let receipt_path = root.join("updates/runtime-update-install-receipt.json");
        let deadline = Instant::now() + Duration::from_secs(60);
        let receipt = loop {
            if let Ok(bytes) = fs::read(&receipt_path)
                && let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes)
                && matches!(
                    value["phase"].as_str(),
                    Some("installed" | "rolledBack" | "rollbackBlocked" | "rollbackRestartFailed")
                )
            {
                break value;
            }
            assert!(Instant::now() < deadline, "{mode} helper did not finish");
            std::thread::sleep(Duration::from_millis(100));
        };
        let expected = if mode == "success" {
            "installed"
        } else {
            "rolledBack"
        };
        assert_eq!(receipt["phase"], expected, "{mode} receipt: {receipt}");
        assert_eq!(
            helper_output.status.success(),
            mode == "success",
            "{mode} helper stderr: {}",
            String::from_utf8_lossy(&helper_output.stderr)
        );
        let installed = fs::read(root.join("installed/codlet.exe")).unwrap();
        if mode == "success" {
            assert_ne!(installed, core_fixture());
            assert!(
                !root
                    .join("installed/runtime/node-v24.18.1-win-x64/node.exe")
                    .exists()
            );
        } else {
            assert_eq!(installed, core_fixture());
            assert!(
                root.join("installed/runtime/node-v24.18.1-win-x64/node.exe")
                    .exists()
            );
        }
        assert_eq!(
            fs::read(root.join("installed/plugins/owner-data.txt")).unwrap(),
            b"preserve this unknown owner data"
        );
        let phases = fs::read_to_string(root.join("restarts.log")).unwrap();
        assert_eq!(
            phases.lines().collect::<Vec<_>>(),
            if mode == "success" {
                vec!["new"]
            } else {
                vec!["new", "old"]
            }
        );
    }
}
