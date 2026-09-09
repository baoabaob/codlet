use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use codlet::catalog::PluginCatalog;
use codlet::local_plugins::{
    LocalPluginError, MAX_SOURCE_BYTES, inspect_local_plugin, load_local_plugin,
    revalidate_host_executable,
};
use codlet::plugins::{HostProtocol, LocalPluginRegistration, Permission, PluginRegistry};
use serde_json::{Value, json};
use tempfile::{TempDir, tempdir};

const EXECUTABLE_BYTES: &[u8] = b"MZ\0\xff\x80not-a-valid-executable";

struct Fixture {
    directory: TempDir,
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempdir().unwrap();
        let root = directory.path().join("本地 host plugin");
        fs::create_dir_all(root.join("bin")).unwrap();
        let fixture = Self { directory, root };
        fixture.write_manifest(&Self::manifest());
        fs::write(fixture.executable(), EXECUTABLE_BYTES).unwrap();
        fixture
    }

    fn manifest() -> Value {
        json!({
            "schema":1, "id":"dev.host", "version":"1",
            "host":{
                "command":["bin/helper.exe", "a b", "$(do-not-expand)", "", "中文"],
                "protocol":"jsonl"
            },
            "permissions":["host.process"]
        })
    }

    fn write_manifest(&self, value: &Value) {
        fs::write(self.root.join("plugin.json"), value.to_string()).unwrap();
    }

    fn executable(&self) -> PathBuf {
        self.root.join("bin/helper.exe")
    }
}

fn rejection(error: &LocalPluginError, stage: &str, reason: &str) {
    let LocalPluginError::Rejected {
        stage: actual_stage,
        reason: actual_reason,
        ..
    } = error
    else {
        panic!("expected rejection, got {error:?}");
    };
    assert_eq!(*actual_stage, stage);
    assert!(actual_reason.contains(reason), "{error}");
}

#[test]
fn host_only_load_retains_a_binary_handle_and_literal_arguments_without_source_or_execution() {
    let fixture = Fixture::new();
    // A host executable is not JavaScript, has no renderer source size limit,
    // and is not validated by trying to execute it during inspection.
    fs::OpenOptions::new()
        .write(true)
        .open(fixture.executable())
        .unwrap()
        .set_len(MAX_SOURCE_BYTES as u64 + 1)
        .unwrap();
    let candidate = inspect_local_plugin(&fixture.root).unwrap();
    assert!(candidate.source.is_none());
    assert!(candidate.manifest.renderer.is_none());
    assert_eq!(
        candidate.manifest.host.as_ref().unwrap().protocol,
        HostProtocol::Jsonl
    );
    candidate
        .validate_grants(&[Permission::HostProcess])
        .unwrap();
    let plugin =
        load_local_plugin("dev.host", &fixture.root, &[Permission::HostProcess], 7).unwrap();
    assert_eq!(plugin.generation, 7);
    assert!(plugin.source.is_none());
    let host = plugin.host.as_ref().unwrap();
    assert_eq!(host.root, fs::canonicalize(&fixture.root).unwrap());
    assert_eq!(
        host.executable,
        fs::canonicalize(fixture.executable()).unwrap()
    );
    assert_eq!(host.args, ["a b", "$(do-not-expand)", "", "中文"]);
    assert_eq!(
        host.executable_file.metadata().unwrap().len(),
        MAX_SOURCE_BYTES as u64 + 1
    );
    revalidate_host_executable(host).unwrap();
    let clone = plugin.clone();
    assert!(Arc::ptr_eq(
        &host.executable_file,
        &clone.host.as_ref().unwrap().executable_file
    ));
    assert_eq!(fs::read_dir(&fixture.root).unwrap().count(), 2);
    assert_eq!(fs::read_dir(fixture.root.join("bin")).unwrap().count(), 1);
}

#[test]
fn host_grants_are_explicit_rechecked_and_do_not_expand_manifest_authority() {
    let fixture = Fixture::new();
    let candidate = inspect_local_plugin(&fixture.root).unwrap();
    rejection(
        &candidate.validate_grants(&[]).unwrap_err(),
        "grant validation",
        "host.process",
    );
    rejection(
        &candidate
            .validate_grants(&[Permission::HostProcess, Permission::HostProcess])
            .unwrap_err(),
        "grant validation",
        "duplicate grant",
    );
    rejection(
        &candidate
            .validate_grants(&[Permission::HostProcess, Permission::RuntimeManage])
            .unwrap_err(),
        "grant validation",
        "not implemented",
    );
    let loaded = load_local_plugin(
        "dev.host",
        &fixture.root,
        &[Permission::HostProcess, Permission::CdpRaw],
        1,
    )
    .unwrap();
    assert_eq!(loaded.manifest.permissions, [Permission::HostProcess]);

    let mut changed = Fixture::manifest();
    changed["permissions"] = json!(["host.process", "cdp.raw"]);
    fixture.write_manifest(&changed);
    rejection(
        &load_local_plugin("dev.host", &fixture.root, &[Permission::HostProcess], 2).unwrap_err(),
        "grant validation",
        "cdp.raw",
    );
    load_local_plugin(
        "dev.host",
        &fixture.root,
        &[Permission::HostProcess, Permission::CdpRaw],
        2,
    )
    .unwrap();
    changed["id"] = json!("dev.replaced");
    fixture.write_manifest(&changed);
    rejection(
        &load_local_plugin(
            "dev.host",
            &fixture.root,
            &[Permission::HostProcess, Permission::CdpRaw],
            3,
        )
        .unwrap_err(),
        "identity validation",
        "dev.replaced",
    );
    assert_eq!(loaded.manifest.id, "dev.host");
    assert_eq!(loaded.manifest.permissions, [Permission::HostProcess]);
}

#[test]
fn unsupported_entry_combinations_and_host_capabilities_fail_before_opening_either_entry() {
    let fixture = Fixture::new();
    fs::remove_file(fixture.executable()).unwrap();
    let mut value = Fixture::manifest();
    value["renderer"] = json!({"entry":"missing.js", "world":"isolated"});
    value["permissions"] = json!(["host.process", "ui.dom"]);
    fixture.write_manifest(&value);
    rejection(
        &inspect_local_plugin(&fixture.root).unwrap_err(),
        "entry validation",
        "combined",
    );

    for declaration in ["provides", "requires"] {
        let mut value = Fixture::manifest();
        value[declaration] = json!([{"name":"dev.host.service", "api":1, "scope":"runtime"}]);
        fixture.write_manifest(&value);
        rejection(
            &inspect_local_plugin(&fixture.root).unwrap_err(),
            "host capability routing",
            "unsupported",
        );
    }
    let mut value = Fixture::manifest();
    value["permissions"] = json!(["host.process", "ui.dom"]);
    fixture.write_manifest(&value);
    rejection(
        &inspect_local_plugin(&fixture.root).unwrap_err(),
        "permission validation",
        "ui.dom",
    );
}

#[test]
fn host_executable_obeys_ordinary_file_path_and_link_checks() {
    let fixture = Fixture::new();
    for entry in ["NUL.exe", "bin./helper.exe", "bin/CON.exe"] {
        let mut value = Fixture::manifest();
        value["host"]["command"][0] = json!(entry);
        fixture.write_manifest(&value);
        rejection(
            &inspect_local_plugin(&fixture.root).unwrap_err(),
            "entry path validation",
            "Windows device names",
        );
    }
    fixture.write_manifest(&Fixture::manifest());
    let alias = fixture.directory.path().join("outside.exe");
    fs::hard_link(fixture.executable(), &alias).unwrap();
    rejection(
        &inspect_local_plugin(&fixture.root).unwrap_err(),
        "open host executable",
        "links",
    );
    fs::remove_file(alias).unwrap();
    fs::remove_file(fixture.executable()).unwrap();
    fs::create_dir(fixture.executable()).unwrap();
    rejection(
        &inspect_local_plugin(&fixture.root).unwrap_err(),
        "open host executable",
        "ordinary file",
    );
    fs::remove_dir(fixture.executable()).unwrap();
    assert!(matches!(
        inspect_local_plugin(&fixture.root).unwrap_err(),
        LocalPluginError::Io {
            stage: "open host executable",
            ..
        }
    ));
}

#[cfg(windows)]
#[test]
fn retained_host_handle_rejects_mutation_until_all_loaded_clones_are_retired() {
    let fixture = Fixture::new();
    let plugin =
        load_local_plugin("dev.host", &fixture.root, &[Permission::HostProcess], 1).unwrap();
    let retained = plugin.clone();
    drop(plugin);
    assert!(
        fs::OpenOptions::new()
            .write(true)
            .open(fixture.executable())
            .is_err()
    );
    assert!(fs::remove_file(fixture.executable()).is_err());
    assert!(fs::rename(fixture.executable(), fixture.root.join("renamed.exe")).is_err());
    revalidate_host_executable(retained.host.as_ref().unwrap()).unwrap();
    assert_eq!(fs::read(fixture.executable()).unwrap(), EXECUTABLE_BYTES);
    drop(retained);
    fs::write(fixture.executable(), b"replacement").unwrap();
    fs::remove_file(fixture.executable()).unwrap();
}

#[cfg(windows)]
#[test]
fn host_executable_rejects_case_aliases() {
    let fixture = Fixture::new();
    for entry in ["BIN/helper.exe", "bin/Helper.exe"] {
        let mut value = Fixture::manifest();
        value["host"]["command"][0] = json!(entry);
        fixture.write_manifest(&value);
        rejection(
            &inspect_local_plugin(&fixture.root).unwrap_err(),
            "open host executable",
            "alias",
        );
    }
}

#[cfg(unix)]
#[test]
fn retained_host_handle_revalidation_detects_a_replaced_executable() {
    let fixture = Fixture::new();
    let plugin =
        load_local_plugin("dev.host", &fixture.root, &[Permission::HostProcess], 1).unwrap();
    fs::rename(fixture.executable(), fixture.root.join("previous.exe")).unwrap();
    fs::write(fixture.executable(), b"replacement").unwrap();
    rejection(
        &revalidate_host_executable(plugin.host.as_ref().unwrap()).unwrap_err(),
        "revalidate host executable",
        "changed",
    );
}

#[test]
fn catalog_preserves_a_host_only_selection_without_official_plugin_dependencies() {
    let fixture = Fixture::new();
    let mut registry = PluginRegistry::load(fixture.directory.path().join("config.json")).unwrap();
    registry.set_enabled("codlet-gui", false).unwrap();
    registry.set_enabled("codex.ui.adapter", false).unwrap();
    let root = fs::canonicalize(&fixture.root).unwrap();
    registry
        .register_local(
            "dev.host",
            LocalPluginRegistration {
                path: root.clone(),
                grants: vec![Permission::HostProcess],
            },
        )
        .unwrap();
    let catalog = PluginCatalog::load(&registry).unwrap();
    let plugins = catalog.enabled_plugins(&registry).unwrap();
    assert_eq!(plugins.len(), 1);
    assert_eq!(plugins[0].manifest.id, "dev.host");
    assert!(plugins[0].manifest.renderer.is_none());
    assert!(plugins[0].source.is_none());
    assert!(plugins[0].host.is_some());
    assert!(plugins[0].manifest.provides.is_empty());
    assert!(plugins[0].manifest.requires.is_empty());
    let entry = catalog
        .entries()
        .iter()
        .find(|entry| entry.id == "dev.host")
        .unwrap();
    assert_eq!(entry.source.path(), Some(root.as_path()));
}
