#![cfg(windows)]

use std::fs::{self, OpenOptions};
use std::os::windows::fs::OpenOptionsExt;
use std::path::Path;
use std::process::{Command, Output};
use std::time::{Duration, Instant};

use codlet::plugins::PluginRegistry;
use tempfile::tempdir;

fn run(local_app_data: &Path, arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_codlet"))
        .args(arguments)
        .env("LOCALAPPDATA", local_app_data)
        .output()
        .unwrap()
}

#[test]
fn plugin_cli_lists_and_persists_bundled_plugin_state_without_launching_codex() {
    let local_app_data = tempdir().unwrap();
    let registry = local_app_data.path().join("Codlet").join("config.json");

    let listed = run(local_app_data.path(), &["plugin", "list"]);
    assert!(listed.status.success());
    let stdout = String::from_utf8(listed.stdout).unwrap();
    assert!(stdout.contains("plugin: id=codex.ui.adapter;"));
    assert!(stdout.contains("plugin: id=codlet; version=0.1.0; source=bundled; enabled=true"));
    assert!(!registry.exists());

    let disabled = run(local_app_data.path(), &["plugin", "disable", "codlet"]);
    assert!(disabled.status.success());
    assert_eq!(
        String::from_utf8(disabled.stdout).unwrap().trim(),
        "plugin-state: id=codlet; enabled=false; applies=next-codlet-launch"
    );
    assert!(registry.exists());

    let listed = run(local_app_data.path(), &["plugin", "list"]);
    assert!(listed.status.success());
    assert!(
        String::from_utf8(listed.stdout)
            .unwrap()
            .contains("plugin: id=codlet; version=0.1.0; source=bundled; enabled=false")
    );

    let enabled = run(local_app_data.path(), &["plugin", "enable", "codlet"]);
    assert!(enabled.status.success());
    assert_eq!(
        String::from_utf8(enabled.stdout).unwrap().trim(),
        "plugin-state: id=codlet; enabled=true; applies=next-codlet-launch"
    );
}

#[test]
fn plugin_cli_rejects_unknown_plugins_without_creating_registry_state() {
    let local_app_data = tempdir().unwrap();
    let output = run(
        local_app_data.path(),
        &["plugin", "disable", "unknown.plugin"],
    );

    assert!(!output.status.success());
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("unknown plugin unknown.plugin")
    );
    assert!(!local_app_data.path().join("Codlet").exists());
}

#[test]
fn plugin_cli_preserves_valid_unknown_preferences() {
    let local_app_data = tempdir().unwrap();
    let path = local_app_data.path().join("Codlet").join("config.json");
    fs::create_dir(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        r#"{"schema":1,"plugins":{"future.plugin":{"enabled":false}}}"#,
    )
    .unwrap();

    for action in ["disable", "enable"] {
        let output = run(local_app_data.path(), &["plugin", action, "codlet"]);
        assert!(output.status.success());
        assert!(
            !PluginRegistry::load(&path)
                .unwrap()
                .is_enabled("future.plugin")
        );
    }
}

#[test]
fn plugin_cli_rejects_corrupt_documents_without_changing_them() {
    let local_app_data = tempdir().unwrap();
    let path = local_app_data.path().join("Codlet").join("config.json");
    fs::create_dir(path.parent().unwrap()).unwrap();
    for document in [
        "{truncated",
        r#"{"schema":1,"plugins":{"future.plugin":{"enabled":false},"future.plugin":{"enabled":true}}}"#,
    ] {
        fs::write(&path, document).unwrap();
        for arguments in [
            vec!["plugin", "list"],
            vec!["plugin", "enable", "codlet"],
            vec!["plugin", "disable", "codlet"],
        ] {
            let output = run(local_app_data.path(), &arguments);
            assert!(!output.status.success());
            assert!(!String::from_utf8_lossy(&output.stdout).contains("plugin-state:"));
            assert!(String::from_utf8_lossy(&output.stderr).contains("not valid JSON"));
            assert_eq!(fs::read_to_string(&path).unwrap(), document);
            assert_eq!(path.parent().unwrap().read_dir().unwrap().count(), 1);
        }
    }
}

#[test]
fn plugin_cli_reports_busy_and_replace_failure_without_a_success_acknowledgement() {
    let local_app_data = tempdir().unwrap();
    let path = local_app_data.path().join("Codlet").join("config.json");
    assert!(
        run(local_app_data.path(), &["plugin", "enable", "codlet"])
            .status
            .success()
    );
    let original = fs::read(&path).unwrap();
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path.with_extension("json.lock"))
        .unwrap();
    lock.try_lock().unwrap();
    let started = Instant::now();
    let busy = run(local_app_data.path(), &["plugin", "disable", "codlet"]);
    assert!(!busy.status.success());
    assert!(started.elapsed() < Duration::from_secs(15));
    assert!(String::from_utf8_lossy(&busy.stderr).contains("plugin registry is busy"));
    assert!(!String::from_utf8_lossy(&busy.stdout).contains("plugin-state:"));
    assert_eq!(fs::read(&path).unwrap(), original);

    let listed = run(local_app_data.path(), &["plugin", "list"]);
    assert!(listed.status.success());
    assert!(String::from_utf8_lossy(&listed.stdout).contains("source=bundled; enabled=true"));
    drop(lock);

    let blocker = OpenOptions::new()
        .read(true)
        .share_mode(0x1 | 0x2)
        .open(&path)
        .unwrap();
    let failed = run(local_app_data.path(), &["plugin", "disable", "codlet"]);
    assert!(!failed.status.success());
    assert!(String::from_utf8_lossy(&failed.stderr).contains("failed to replace"));
    assert!(!String::from_utf8_lossy(&failed.stdout).contains("plugin-state:"));
    assert_eq!(fs::read(&path).unwrap(), original);
    assert_eq!(path.parent().unwrap().read_dir().unwrap().count(), 2);
    drop(blocker);

    assert!(
        run(local_app_data.path(), &["plugin", "disable", "codlet"])
            .status
            .success()
    );
    assert!(!PluginRegistry::load(&path).unwrap().is_enabled("codlet"));
}

#[test]
fn management_json_has_one_versioned_result_for_success_and_early_failures() {
    let local_app_data = tempdir().unwrap();
    for (arguments, expected_code) in [
        (
            vec!["plugin", "reload", "codlet", "--json"],
            "host_required",
        ),
        (
            vec!["plugin", "enable", "../plugin", "--json"],
            "invalid_plugin_id",
        ),
        (
            vec!["plugin", "enable", "unknown.plugin", "--json"],
            "unknown_plugin",
        ),
        (
            vec!["plugin", "operation", "invalid", "--json"],
            "invalid_operation",
        ),
    ] {
        let output = run(local_app_data.path(), &arguments);
        assert!(!output.status.success());
        let reply: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(reply["schema_version"], 1);
        assert_eq!(reply["outcome"], "failed");
        assert_eq!(reply["error"]["code"], expected_code);
        assert!(!local_app_data.path().join("Codlet").exists());
    }
    let output = run(
        local_app_data.path(),
        &["plugin", "disable", "codlet", "--json"],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let reply: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(reply["schema_version"], 1);
    assert_eq!(reply["outcome"], "offline_saved");
    assert_eq!(reply["offline"]["enabled"], false);
    assert!(reply["error"].is_null());
}
