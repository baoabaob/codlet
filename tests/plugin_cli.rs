#![cfg(windows)]

use std::path::Path;
use std::process::{Command, Output};

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
            .contains("unknown bundled plugin unknown.plugin")
    );
    assert!(!local_app_data.path().join("Codlet").exists());
}
