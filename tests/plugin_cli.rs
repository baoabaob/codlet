#![cfg(windows)]

use std::fs::{self, OpenOptions};
use std::os::windows::fs::OpenOptionsExt;
use std::path::Path;
use std::process::{Command, Output};
use std::time::{Duration, Instant};

use codlet::plugins::{GUI_PLUGIN_ID, LocalPluginRegistration, PluginRegistry, bundled_plugins};
use tempfile::tempdir;

fn run(local_app_data: &Path, arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_codlet"))
        .args(arguments)
        .env("LOCALAPPDATA", local_app_data)
        .env_remove("CODLET_HOME")
        .output()
        .unwrap()
}

fn gui_fixture(local_app_data: &Path) -> (String, &'static str) {
    if let Some(gui) = bundled_plugins()
        .unwrap()
        .into_iter()
        .find(|plugin| plugin.manifest.id == GUI_PLUGIN_ID)
    {
        return (gui.manifest.version, "bundled");
    }
    // Ordinary production GUI installation is explicit. Keep every CLI write
    // scoped to this temporary package and registry, including failure tests.
    let root = local_app_data.join("gui");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("codlet.json"), serde_json::json!({"schema":1,"id":GUI_PLUGIN_ID,"version":env!("CARGO_PKG_VERSION"),"renderer":{"entry":"renderer.js","world":"isolated"}}).to_string()).unwrap();
    fs::write(
        root.join("renderer.js"),
        "module.exports={activate(){},deactivate(){}};",
    )
    .unwrap();
    let path = local_app_data.join("Codlet/config.json");
    let mut registry = PluginRegistry::load(path).unwrap();
    registry
        .register_local(
            GUI_PLUGIN_ID,
            LocalPluginRegistration {
                path: fs::canonicalize(root).unwrap(),
                grants: vec![],
                broker_policy: Default::default(),
            },
        )
        .unwrap();
    registry.save().unwrap();
    (env!("CARGO_PKG_VERSION").into(), "local")
}

#[test]
fn plugin_cli_lists_and_persists_gui_state_without_launching_codex() {
    let local_app_data = tempdir().unwrap();
    let registry = local_app_data.path().join("Codlet").join("config.json");
    let (version, source) = gui_fixture(local_app_data.path());
    let before_list = fs::read(&registry).ok();

    let listed = run(local_app_data.path(), &["plugin", "list"]);
    assert!(listed.status.success());
    let stdout = String::from_utf8(listed.stdout).unwrap();
    assert!(
        stdout.contains(if source == "bundled" {
            "plugin: id=codex.ui.adapter;"
        } else {
            "core-capability-provider: id=codex.ui.adapter;"
        }),
        "{stdout}"
    );
    assert!(
        stdout.contains(&format!(
            "plugin: id=codlet-gui; version={version}; source={source}; enabled=true"
        )),
        "{stdout}"
    );
    assert_eq!(
        fs::read(&registry).ok(),
        before_list,
        "listing cannot create or mutate registry state"
    );

    let disabled = run(local_app_data.path(), &["plugin", "disable", "codlet-gui"]);
    assert!(disabled.status.success());
    let disabled_text = String::from_utf8(disabled.stdout).unwrap();
    let disabled: serde_json::Value = serde_json::from_str(
        disabled_text
            .trim()
            .strip_prefix("plugin-registration: ")
            .expect("offline registration result"),
    )
    .unwrap();
    assert_eq!(
        disabled,
        serde_json::json!({"action":"disable","affected_plugin_ids":["codlet-gui"],"directory":"preserved","enabled":false,"plugin_id":"codlet-gui","applies":"next-codlet-launch"})
    );
    assert!(registry.exists());

    let listed = run(local_app_data.path(), &["plugin", "list"]);
    assert!(listed.status.success());
    assert!(String::from_utf8(listed.stdout).unwrap().contains(&format!(
        "plugin: id=codlet-gui; version={version}; source={source}; enabled=false"
    )));

    let enabled = run(local_app_data.path(), &["plugin", "enable", "codlet-gui"]);
    assert!(enabled.status.success());
    assert_eq!(
        String::from_utf8(enabled.stdout).unwrap().trim(),
        "plugin-state: id=codlet-gui; enabled=true; applies=next-codlet-launch"
    );
}

#[test]
fn plugin_cli_rejects_unknown_plugins_without_creating_registry_state() {
    let local_app_data = tempdir().unwrap();
    for arguments in [
        vec!["plugin", "disable", "unknown.plugin"],
        vec!["plugin", "disable", "unknown.plugin", "--cascade"],
        vec!["plugin", "enable", "unknown.plugin"],
        vec!["plugin", "remove", "unknown.plugin"],
        vec!["plugin", "revoke", "unknown.plugin", "host.fs"],
        vec!["plugin", "permissions", "unknown.plugin"],
    ] {
        let output = run(local_app_data.path(), &arguments);
        assert!(!output.status.success(), "{arguments:?}");
        assert!(
            output.stdout.is_empty(),
            "{arguments:?}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(
            String::from_utf8(output.stderr)
                .unwrap()
                .contains("unknown plugin unknown.plugin"),
            "{arguments:?}"
        );
        assert!(
            !local_app_data.path().join("Codlet").exists(),
            "{arguments:?}"
        );
    }
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

    gui_fixture(local_app_data.path());

    for action in ["disable", "enable"] {
        let output = run(local_app_data.path(), &["plugin", action, "codlet-gui"]);
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
            vec!["plugin", "enable", "codlet-gui"],
            vec!["plugin", "disable", "codlet-gui"],
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
    let (_, source) = gui_fixture(local_app_data.path());
    assert!(
        run(local_app_data.path(), &["plugin", "enable", "codlet-gui"])
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
    let busy = run(local_app_data.path(), &["plugin", "disable", "codlet-gui"]);
    assert!(!busy.status.success());
    assert!(started.elapsed() < Duration::from_secs(15));
    assert!(String::from_utf8_lossy(&busy.stderr).contains("plugin registry is busy"));
    assert!(!String::from_utf8_lossy(&busy.stdout).contains("plugin-state:"));
    assert_eq!(fs::read(&path).unwrap(), original);

    let listed = run(local_app_data.path(), &["plugin", "list"]);
    assert!(listed.status.success());
    assert!(
        String::from_utf8_lossy(&listed.stdout).contains(&format!("source={source}; enabled=true"))
    );
    drop(lock);

    let blocker = OpenOptions::new()
        .read(true)
        .share_mode(0x1 | 0x2)
        .open(&path)
        .unwrap();
    let failed = run(local_app_data.path(), &["plugin", "disable", "codlet-gui"]);
    assert!(!failed.status.success());
    assert!(String::from_utf8_lossy(&failed.stderr).contains("failed to replace"));
    assert!(!String::from_utf8_lossy(&failed.stdout).contains("plugin-state:"));
    assert_eq!(fs::read(&path).unwrap(), original);
    assert_eq!(path.parent().unwrap().read_dir().unwrap().count(), 2);
    drop(blocker);

    assert!(
        run(local_app_data.path(), &["plugin", "disable", "codlet-gui"])
            .status
            .success()
    );
    assert!(
        !PluginRegistry::load(&path)
            .unwrap()
            .is_enabled("codlet-gui")
    );
}

#[test]
fn management_json_has_one_versioned_result_for_success_and_early_failures() {
    let local_app_data = tempdir().unwrap();
    for (arguments, expected_code) in [
        (
            vec!["plugin", "reload", "codlet-gui", "--json"],
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
            vec!["plugin", "disable", "unknown.plugin", "--json"],
            "unknown_plugin",
        ),
        (
            vec!["plugin", "remove", "unknown.plugin", "--json"],
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
    gui_fixture(local_app_data.path());
    let output = run(
        local_app_data.path(),
        &["plugin", "disable", "codlet-gui", "--json"],
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
