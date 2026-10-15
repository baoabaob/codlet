#![cfg(not(feature = "test-fixtures"))]

use codlet::catalog::PluginCatalog;
use codlet::plugins::PluginRegistry;
use serde_json::{Value, json};
use std::fs;
use std::process::Command;
use tempfile::tempdir;

#[test]
fn legacy_adapters_are_preserved_but_never_compete_with_core_providers() {
    let temp = tempdir().unwrap();
    let old = temp.path().join("old-adapter");
    let old_desktop = temp.path().join("old-desktop-adapter");
    let consumer = temp.path().join("consumer");
    fs::create_dir_all(&old).unwrap();
    fs::create_dir_all(&old_desktop).unwrap();
    fs::create_dir_all(&consumer).unwrap();
    fs::write(old.join("keep.txt"), "author files remain").unwrap();
    fs::write(
        old.join("codlet.json"),
        "intentionally stale legacy metadata",
    )
    .unwrap();
    fs::write(
        old_desktop.join("codlet.json"),
        "intentionally stale Desktop metadata",
    )
    .unwrap();
    fs::write(consumer.join("codlet.json"), json!({"schema":1,"id":"dev.sdk","version":"1","renderer":{"entry":"renderer.js","world":"isolated"},"permissions":["ui.dom"],"requires":[{"name":"codex.ui.navigation.page","api":1,"scope":"target"}]}).to_string()).unwrap();
    fs::write(
        consumer.join("renderer.js"),
        "module.exports={activate(){}};",
    )
    .unwrap();
    let config = temp.path().join("config.json");
    let original = json!({"schema":2,"plugins":{"codex.ui.adapter":{"enabled":false},"codex.desktop.adapter":{"enabled":false}},"localPlugins":{
        "codex.ui.adapter":{"path":old,"grants":["ui.dom"]},
        "codex.desktop.adapter":{"path":old_desktop,"grants":[]},
        "dev.sdk":{"path":consumer,"grants":["ui.dom"]}
    }}).to_string();
    fs::write(&config, &original).unwrap();
    let registry = PluginRegistry::load(&config).unwrap();
    let catalog = PluginCatalog::load(&registry).unwrap();
    assert!(catalog.is_core("codex.ui.adapter") && catalog.is_core("codex.desktop.adapter"));
    let enabled = catalog.enabled_plugins(&registry).unwrap();
    assert_eq!(enabled.len(), 3);
    let legacy = catalog.legacy_adapter_registrations(&registry);
    assert_eq!(legacy.len(), 2);
    assert!(
        legacy
            .iter()
            .all(|record| record["status"] == "supersededByCore")
    );
    assert_eq!(
        codlet::renderer::RendererRuntime::from_catalog(catalog, registry)
            .unwrap()
            .plugin_count(),
        3
    );
    assert_eq!(fs::read_to_string(config).unwrap(), original);
    assert_eq!(
        fs::read_to_string(old.join("keep.txt")).unwrap(),
        "author files remain"
    );
}

#[test]
fn removing_a_legacy_registration_keeps_core_and_consumer_preferences() {
    let temp = tempdir().unwrap();
    let old = temp.path().join("legacy");
    fs::create_dir(&old).unwrap();
    fs::write(old.join("keep.txt"), "preserved").unwrap();
    fs::write(temp.path().join("config.json"), json!({"schema":2,"plugins":{"codlet-gui":{"enabled":true}},"localPlugins":{"codex.ui.adapter":{"path":old,"grants":["ui.dom"]}}}).to_string()).unwrap();
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_codlet"))
            .args(args)
            .env("CODLET_HOME", temp.path())
            .output()
            .unwrap()
    };
    let denied = run(&["plugin", "disable", "codex.ui.adapter", "--json"]);
    assert!(!denied.status.success());
    assert!(
        String::from_utf8_lossy(&denied.stdout).contains("core_owned_capability"),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&denied.stdout),
        String::from_utf8_lossy(&denied.stderr)
    );
    let removed = run(&["plugin", "remove", "codex.ui.adapter", "--json"]);
    assert!(
        removed.status.success(),
        "{} {}",
        String::from_utf8_lossy(&removed.stdout),
        String::from_utf8_lossy(&removed.stderr)
    );
    let config: Value =
        serde_json::from_slice(&fs::read(temp.path().join("config.json")).unwrap()).unwrap();
    assert!(config["localPlugins"].get("codex.ui.adapter").is_none());
    assert_eq!(config["plugins"]["codlet-gui"]["enabled"], true);
    assert_eq!(
        fs::read_to_string(old.join("keep.txt")).unwrap(),
        "preserved"
    );
    let listing = run(&["plugin", "list", "--json"]);
    let listing: Value = serde_json::from_slice(&listing.stdout).unwrap();
    assert_eq!(listing["coreProviders"].as_array().unwrap().len(), 2);
    assert!(
        listing["legacyAdapterRegistrations"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
