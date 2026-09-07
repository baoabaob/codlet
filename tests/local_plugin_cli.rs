#![cfg(windows)]

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use codlet::plugins::PluginRegistry;
use codlet::probe::prepare_renderer_runtime;
use serde_json::{Value, json};
use tempfile::{TempDir, tempdir};

const PLUGIN_ID: &str = "dev.test.local";

struct Fixture {
    directory: TempDir,
    plugin: PathBuf,
    local_app_data: PathBuf,
    marker: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempdir().unwrap();
        let plugin = directory.path().join("plugin-\u{6d4b}\u{8bd5} space");
        fs::create_dir_all(plugin.join("dist")).unwrap();
        let marker = directory.path().join("source-executed");
        let source = format!(
            "require('node:fs').writeFileSync({}, 'unexpected'); module.exports = {{ activate() {{}}, deactivate() {{}} }};",
            serde_json::to_string(&marker).unwrap()
        );
        fs::write(plugin.join("dist/renderer.js"), source).unwrap();
        let local_app_data = directory.path().join("app-data");
        let fixture = Self {
            directory,
            plugin,
            local_app_data,
            marker,
        };
        fixture.write_manifest(PLUGIN_ID, &["ui.dom"]);
        fixture
    }

    fn write_manifest(&self, id: &str, permissions: &[&str]) {
        fs::write(
            self.plugin.join("plugin.json"),
            serde_json::to_vec(&json!({
                "schema": 1,
                "id": id,
                "version": "0.1.0",
                "renderer": {"entry": "dist/renderer.js", "world": "isolated"},
                "permissions": permissions,
                "provides": [],
                "requires": []
            }))
            .unwrap(),
        )
        .unwrap();
    }

    fn run(&self, arguments: &[&str]) -> Output {
        self.command().args(arguments).output().unwrap()
    }

    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_codlet"));
        command.env("LOCALAPPDATA", &self.local_app_data);
        command.current_dir(self.directory.path());
        command
    }

    fn add(&self, path: &Path, flags: &[&str]) -> Output {
        self.command()
            .args([OsStr::new("plugin"), OsStr::new("add"), path.as_os_str()])
            .args(flags)
            .output()
            .unwrap()
    }

    fn config_path(&self) -> PathBuf {
        self.local_app_data.join("Codlet/config.json")
    }

    fn config(&self) -> Value {
        serde_json::from_slice(&fs::read(self.config_path()).unwrap()).unwrap()
    }

    fn register(&self) {
        successful(self.add(&self.plugin, &["--trust", "--grant", "ui.dom"]));
    }
}

fn successful(output: Output) -> Output {
    assert!(
        output.status.success(),
        "command failed: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

#[test]
fn inspection_and_incomplete_consent_never_register_or_execute_source() {
    let fixture = Fixture::new();
    let preview = fixture.add(&fixture.plugin, &[]);
    assert!(!preview.status.success());
    let stdout = String::from_utf8(preview.stdout).unwrap();
    assert!(stdout.contains("plugin-candidate: id=dev.test.local"));
    assert!(stdout.contains("requested-permissions: ui.dom"));
    assert!(!fixture.local_app_data.exists());

    for flags in [vec!["--trust"], vec!["--grant", "ui.dom"]] {
        let output = fixture.add(&fixture.plugin, &flags);
        assert!(!output.status.success());
        assert!(!String::from_utf8_lossy(&output.stdout).contains("plugin-added:"));
        assert!(!fixture.local_app_data.exists());
    }
    assert!(!fixture.marker.exists());
}

#[test]
fn trusted_relative_directory_is_persisted_listed_and_preserves_old_preferences() {
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.config_path().parent().unwrap()).unwrap();
    fs::write(
        fixture.config_path(),
        br#"{"schema":1,"plugins":{"future.plugin":{"enabled":false}}}"#,
    )
    .unwrap();
    successful(fixture.add(
        Path::new(fixture.plugin.file_name().unwrap()),
        &["--trust", "--grant", "ui.dom"],
    ));
    let config = fixture.config();
    assert_eq!(config["schema"], 2);
    assert_eq!(config["plugins"]["future.plugin"]["enabled"], false);
    assert_eq!(
        PathBuf::from(config["localPlugins"][PLUGIN_ID]["path"].as_str().unwrap()),
        fixture.plugin.canonicalize().unwrap()
    );
    assert_eq!(
        config["localPlugins"][PLUGIN_ID]["grants"],
        json!(["ui.dom"])
    );
    let before = fs::read(fixture.config_path()).unwrap();
    let listed = successful(fixture.run(&["plugin", "list"]));
    let stdout = String::from_utf8(listed.stdout).unwrap();
    assert!(stdout.contains("id=dev.test.local; version=0.1.0; source=local; enabled=true"));
    let doctor = fixture.run(&["doctor", "--json"]);
    let report: Value = serde_json::from_slice(&doctor.stdout).unwrap();
    assert!(
        report["plugins"]["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|plugin| { plugin["id"] == PLUGIN_ID && plugin["source"] == "local" })
    );
    assert_eq!(fs::read(fixture.config_path()).unwrap(), before);
    assert!(!fixture.marker.exists());
}

#[test]
fn permission_changes_require_an_explicit_grant_update_without_reenabling() {
    let fixture = Fixture::new();
    fixture.register();
    successful(fixture.run(&["plugin", "disable", PLUGIN_ID]));
    let disabled = fs::read(fixture.config_path()).unwrap();
    fixture.write_manifest(PLUGIN_ID, &["ui.dom", "runtime.manage"]);
    let denied = fixture.run(&["plugin", "enable", PLUGIN_ID]);
    assert!(!denied.status.success());
    assert!(!String::from_utf8_lossy(&denied.stdout).contains("plugin-state:"));
    assert_eq!(fs::read(fixture.config_path()).unwrap(), disabled);
    assert!(
        !fixture
            .add(&fixture.plugin, &["--trust", "--grant", "ui.dom"])
            .status
            .success()
    );
    assert_eq!(fs::read(fixture.config_path()).unwrap(), disabled);

    successful(fixture.add(
        &fixture.plugin,
        &["--trust", "--grant", "ui.dom", "--grant", "runtime.manage"],
    ));
    let updated = fixture.config();
    assert_eq!(updated["plugins"][PLUGIN_ID]["enabled"], false);
    assert_eq!(
        updated["localPlugins"][PLUGIN_ID]["grants"],
        json!(["ui.dom", "runtime.manage"])
    );
    successful(fixture.run(&["plugin", "enable", PLUGIN_ID]));
    assert_eq!(fixture.config()["plugins"][PLUGIN_ID]["enabled"], true);
    assert!(!fixture.marker.exists());
}

#[test]
fn broken_enabled_plugin_is_rejected_before_launch_and_can_be_disabled_and_removed() {
    let fixture = Fixture::new();
    fixture.register();
    let source = fixture.plugin.join("dist/renderer.js");
    fs::remove_file(&source).unwrap();
    let before = fs::read(fixture.config_path()).unwrap();
    let error = prepare_renderer_runtime(PluginRegistry::load(fixture.config_path()).unwrap())
        .err()
        .expect("invalid source must fail before the launcher is reached")
        .to_string();
    assert!(
        error.contains(PLUGIN_ID),
        "unexpected launch error: {error}"
    );
    assert!(
        error.contains("renderer.js"),
        "unexpected launch error: {error}"
    );
    assert_eq!(fs::read(fixture.config_path()).unwrap(), before);

    successful(fixture.run(&["plugin", "disable", PLUGIN_ID]));
    let prepared = prepare_renderer_runtime(PluginRegistry::load(fixture.config_path()).unwrap())
        .expect("disabled invalid source must not block the configured runtime");
    assert_eq!(prepared.session_count(), 0);
    assert_eq!(prepared.plugin_count(), 2);
    let listed = successful(fixture.run(&["plugin", "list"]));
    let stdout = String::from_utf8(listed.stdout).unwrap();
    assert!(stdout.contains("source=local; enabled=false"));
    assert!(stdout.contains("plugin-validation: id=dev.test.local; state=failed"));
    successful(fixture.run(&["plugin", "remove", PLUGIN_ID]));
    assert!(fixture.config()["localPlugins"].get(PLUGIN_ID).is_none());
    assert_eq!(fixture.config()["plugins"][PLUGIN_ID]["enabled"], false);
    assert!(fixture.plugin.join("plugin.json").is_file());
    assert!(!source.exists());
    assert!(!fixture.marker.exists());
}

#[test]
fn registration_cannot_replace_bundled_ids_or_an_existing_directory() {
    let fixture = Fixture::new();
    for id in ["codlet", "codex.ui.adapter", "codlet.core.host"] {
        fixture.write_manifest(id, &["ui.dom"]);
        assert!(
            !fixture
                .add(&fixture.plugin, &["--trust", "--grant", "ui.dom"])
                .status
                .success()
        );
        assert!(!fixture.local_app_data.exists());
    }
    fixture.write_manifest(PLUGIN_ID, &["ui.dom"]);
    fixture.register();
    let before = fs::read(fixture.config_path()).unwrap();
    let other = fixture.directory.path().join("different-directory");
    fs::create_dir_all(other.join("dist")).unwrap();
    fs::copy(
        fixture.plugin.join("plugin.json"),
        other.join("plugin.json"),
    )
    .unwrap();
    fs::copy(
        fixture.plugin.join("dist/renderer.js"),
        other.join("dist/renderer.js"),
    )
    .unwrap();
    assert!(
        !fixture
            .add(&other, &["--trust", "--grant", "ui.dom"])
            .status
            .success()
    );
    assert_eq!(fs::read(fixture.config_path()).unwrap(), before);
    assert!(
        !fixture
            .run(&["plugin", "remove", "codlet"])
            .status
            .success()
    );
    assert_eq!(fs::read(fixture.config_path()).unwrap(), before);
    assert!(!fixture.marker.exists());
}

#[test]
fn changing_a_registered_manifest_id_does_not_change_its_trusted_identity() {
    let fixture = Fixture::new();
    fixture.register();
    fixture.write_manifest("dev.test.renamed", &["ui.dom"]);
    let before = fs::read(fixture.config_path()).unwrap();
    let error = prepare_renderer_runtime(PluginRegistry::load(fixture.config_path()).unwrap())
        .err()
        .expect("a renamed manifest must fail before the launcher is reached")
        .to_string();
    assert!(error.contains(PLUGIN_ID));
    assert_eq!(fs::read(fixture.config_path()).unwrap(), before);
    successful(fixture.run(&["plugin", "disable", PLUGIN_ID]));
    successful(fixture.run(&["plugin", "remove", PLUGIN_ID]));
    assert!(
        fixture.config()["localPlugins"]
            .get("dev.test.renamed")
            .is_none()
    );
    assert!(!fixture.marker.exists());
}

#[test]
fn malformed_consent_options_fail_without_creating_state() {
    let fixture = Fixture::new();
    for flags in [
        vec!["--trust", "--trust"],
        vec!["--trust", "--grant"],
        vec!["--grant", "unknown.permission"],
        vec!["--grant", "ui.dom", "--grant", "ui.dom"],
        vec!["--trust", "--yes"],
    ] {
        let output = fixture.add(&fixture.plugin, &flags);
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(!fixture.local_app_data.exists());
    }
    assert!(!fixture.marker.exists());
}
