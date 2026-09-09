use codlet::plugins::{
    GUI_PLUGIN_ID, LocalPluginRegistration, Permission, PluginRegistry, bundled_plugins,
};
use serde_json::{Value, json};
use tempfile::tempdir;

#[test]
fn legacy_gui_preferences_are_read_only_and_explicit_new_preferences_win() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("config.json");
    for schema in [1, 2] {
        for old_enabled in [false, true] {
            for new_enabled in [None, Some(false), Some(true)] {
                let mut document =
                    json!({"schema":schema,"plugins":{"codlet":{"enabled":old_enabled}}});
                if schema == 2 {
                    document["localPlugins"] = json!({});
                }
                if let Some(enabled) = new_enabled {
                    document["plugins"][GUI_PLUGIN_ID] = json!({"enabled":enabled});
                }
                let bytes = serde_json::to_vec(&document).unwrap();
                std::fs::write(&path, &bytes).unwrap();
                let registry = PluginRegistry::load(&path).unwrap();
                assert_eq!(
                    registry.is_enabled(GUI_PLUGIN_ID),
                    new_enabled.unwrap_or(old_enabled)
                );
                assert_eq!(
                    registry.is_enabled("codlet"),
                    new_enabled.unwrap_or(old_enabled)
                );
                let enabled = codlet::plugins::enabled_bundled_plugins(&registry).unwrap();
                assert_eq!(
                    enabled
                        .iter()
                        .any(|plugin| plugin.manifest.id == GUI_PLUGIN_ID),
                    new_enabled.unwrap_or(old_enabled)
                );
                assert_eq!(std::fs::read(&path).unwrap(), bytes);
            }
        }
    }
    assert!(
        bundled_plugins()
            .unwrap()
            .iter()
            .all(|plugin| plugin.manifest.id != "codlet")
    );
}

#[test]
fn alias_updates_share_one_preference_and_merge_with_current_registrations_under_the_save_lock() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("config.json");
    std::fs::write(
        &path,
        br#"{"schema":2,"plugins":{"codlet":{"enabled":false}},"localPlugins":{}}"#,
    )
    .unwrap();
    let mut stale_gui_writer = PluginRegistry::load(&path).unwrap();
    let mut other_writer = PluginRegistry::load(&path).unwrap();
    stale_gui_writer.set_enabled("codlet", true).unwrap();
    other_writer.set_enabled("dev.other", false).unwrap();
    let registration = LocalPluginRegistration {
        path: directory.path().join("trusted-source"),
        grants: vec![Permission::UiDom],
    };
    other_writer
        .register_local("dev.other", registration.clone())
        .unwrap();
    other_writer.save().unwrap();
    let interim: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(interim["plugins"]["codlet"]["enabled"], false);
    assert!(interim["plugins"].get(GUI_PLUGIN_ID).is_none());
    stale_gui_writer.save().unwrap();
    let document: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert!(document["plugins"].get("codlet").is_none());
    assert_eq!(document["plugins"][GUI_PLUGIN_ID]["enabled"], true);
    let committed = PluginRegistry::load(&path).unwrap();
    assert!(!committed.is_enabled("dev.other"));
    assert_eq!(committed.local_plugins()["dev.other"], registration);

    let mut legacy = committed.clone();
    let mut canonical = committed.clone();
    legacy.set_enabled("codlet", false).unwrap();
    canonical.set_enabled(GUI_PLUGIN_ID, true).unwrap();
    legacy.save().unwrap();
    canonical.save().unwrap();
    assert!(
        PluginRegistry::load(&path)
            .unwrap()
            .is_enabled(GUI_PLUGIN_ID)
    );
    legacy.set_enabled("codlet", false).unwrap();
    legacy.save().unwrap();
    assert!(
        !PluginRegistry::load(&path)
            .unwrap()
            .is_enabled(GUI_PLUGIN_ID)
    );
}

#[test]
fn gui_ids_cannot_adopt_a_local_registration_or_silently_rewrite_a_conflict() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("config.json");
    let registration = LocalPluginRegistration {
        path: directory.path().join("unrelated-user-plugin"),
        grants: vec![Permission::UiDom],
    };
    for id in ["codlet", GUI_PLUGIN_ID] {
        let mut registry = PluginRegistry::load(directory.path().join("not-created.json")).unwrap();
        let error = registry
            .register_local(id, registration.clone())
            .unwrap_err();
        assert!(error.to_string().contains("reserved"));
        assert!(!registry.path().exists());
        let bytes = serde_json::to_vec(
            &json!({"schema":2,"plugins":{},"localPlugins":{(id): &registration}}),
        )
        .unwrap();
        std::fs::write(&path, &bytes).unwrap();
        assert!(
            PluginRegistry::load(&path)
                .unwrap_err()
                .to_string()
                .contains("reserved")
        );
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
    let duplicate =
        br#"{"schema":1,"plugins":{"codlet":{"enabled":false},"codlet":{"enabled":true}}}"#;
    std::fs::write(&path, duplicate).unwrap();
    assert!(
        PluginRegistry::load(&path)
            .unwrap_err()
            .to_string()
            .contains("duplicate plugin id")
    );
    assert_eq!(std::fs::read(&path).unwrap(), duplicate);
}

#[cfg(windows)]
#[test]
fn old_cli_gui_id_is_an_alias_and_reports_only_the_new_identity() {
    use std::process::Command;
    let directory = tempdir().unwrap();
    let path = directory.path().join("Codlet/config.json");
    std::fs::create_dir(path.parent().unwrap()).unwrap();
    let original = br#"{"schema":1,"plugins":{"codlet":{"enabled":false}}}"#;
    std::fs::write(&path, original).unwrap();
    let invoke = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_codlet"))
            .env("LOCALAPPDATA", directory.path())
            .args(args)
            .output()
            .unwrap()
    };
    let list = invoke(&["plugin", "list"]);
    assert!(list.status.success());
    let text = String::from_utf8(list.stdout).unwrap();
    assert!(text.contains("id=codlet-gui; version=0.1.0; source=bundled; enabled=false"));
    assert!(!text.contains("id=codlet;"));
    assert_eq!(std::fs::read(&path).unwrap(), original);
    let enabled = invoke(&["plugin", "enable", "codlet", "--json"]);
    assert!(
        enabled.status.success(),
        "{}",
        String::from_utf8_lossy(&enabled.stderr)
    );
    let report: Value = serde_json::from_slice(&enabled.stdout).unwrap();
    assert_eq!(report["offline"]["plugin_id"], GUI_PLUGIN_ID);
    assert_eq!(report["offline"]["enabled"], true);
    let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert!(saved["plugins"].get("codlet").is_none());
    assert_eq!(saved["plugins"][GUI_PLUGIN_ID]["enabled"], true);
}
