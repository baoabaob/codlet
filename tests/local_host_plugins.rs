use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use codlet::catalog::PluginCatalog;
use codlet::local_plugins::{MAX_SOURCE_BYTES, inspect_local_plugin, load_local_plugin};
use codlet::plugins::{LocalPluginRegistration, Permission, PluginRegistry};
use serde_json::{Value, json};
use tempfile::{TempDir, tempdir};

const SOURCE: &str =
    "throw new Error('inspection must not execute'); module.exports = { activate() {} };";

struct Fixture {
    directory: TempDir,
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let directory = tempdir().unwrap();
        let root = directory.path().join("本地 JS host plugin");
        fs::create_dir_all(root.join("dist")).unwrap();
        let fixture = Self { directory, root };
        fixture.manifest(&json!({"schema":1,"id":"dev.host","version":"1","host":{"entry":"dist/host.js"},"permissions":["host.process"]}));
        fs::write(fixture.entry(), SOURCE).unwrap();
        fixture
    }
    fn manifest(&self, value: &Value) {
        fs::write(self.root.join("codlet.json"), value.to_string()).unwrap();
    }
    fn entry(&self) -> PathBuf {
        self.root.join("dist/host.js")
    }
    fn load(&self, grants: &[Permission]) -> codlet::plugins::LoadedPlugin {
        load_local_plugin("dev.host", &self.root, grants, 7).unwrap()
    }
}

#[test]
fn js_host_and_renderer_share_bounded_source_snapshots_without_executing_or_locking_the_package() {
    let fixture = Fixture::new();
    let candidate = inspect_local_plugin(&fixture.root).unwrap();
    assert!(candidate.source.is_none() && candidate.manifest.renderer.is_none());
    assert_eq!(candidate.manifest.host.unwrap().entry, "dist/host.js");
    let plugin = fixture.load(&[Permission::HostProcess]);
    let host = plugin.host.as_ref().unwrap();
    assert_eq!(host.root, fs::canonicalize(&fixture.root).unwrap());
    assert_eq!(host.entry, fs::canonicalize(fixture.entry()).unwrap());
    assert_eq!(&*host.source, SOURCE);
    assert_eq!(plugin.generation, 7);
    let clone = plugin.clone();
    assert!(Arc::ptr_eq(
        &host.source,
        &clone.host.as_ref().unwrap().source
    ));
    fs::write(
        fixture.entry(),
        "module.exports = { activate() {} }; // edited",
    )
    .unwrap();
    assert_eq!(
        &*host.source, SOURCE,
        "an edit changed the running generation"
    );
    assert!(
        fixture
            .load(&[Permission::HostProcess])
            .host
            .unwrap()
            .source
            .ends_with("// edited")
    );
    assert_eq!(fs::read_dir(&fixture.root).unwrap().count(), 2);
}

#[test]
fn host_javascript_rejects_binary_empty_and_oversized_sources_with_the_same_path_checks() {
    let fixture = Fixture::new();
    for bytes in [
        b"MZ\0\xff".to_vec(),
        b" \n ".to_vec(),
        vec![b'x'; MAX_SOURCE_BYTES + 1],
    ] {
        fs::write(fixture.entry(), bytes).unwrap();
        let error = inspect_local_plugin(&fixture.root).unwrap_err().to_string();
        assert!(error.contains("host entry"), "{error}");
    }
    fs::write(fixture.entry(), "x".repeat(MAX_SOURCE_BYTES)).unwrap();
    assert_eq!(
        inspect_local_plugin(&fixture.root)
            .unwrap()
            .host
            .unwrap()
            .source
            .len(),
        MAX_SOURCE_BYTES
    );
    let alias = fixture.directory.path().join("linked.js");
    fs::hard_link(fixture.entry(), &alias).unwrap();
    assert!(
        inspect_local_plugin(&fixture.root)
            .unwrap_err()
            .to_string()
            .contains("links")
    );
    fs::remove_file(alias).unwrap();
    let mut manifest: Value =
        serde_json::from_slice(&fs::read(fixture.root.join("codlet.json")).unwrap()).unwrap();
    for entry in ["NUL.js", "dist./host.js", "dist/CON.js"] {
        manifest["host"]["entry"] = json!(entry);
        fixture.manifest(&manifest);
        assert!(
            inspect_local_plugin(&fixture.root)
                .unwrap_err()
                .to_string()
                .contains("Windows device names")
        );
    }
}

#[test]
fn old_manifest_name_is_an_explicit_read_only_migration_error() {
    let fixture = Fixture::new();
    fs::rename(
        fixture.root.join("codlet.json"),
        fixture.root.join("plugin.json"),
    )
    .unwrap();
    assert!(
        inspect_local_plugin(&fixture.root)
            .unwrap_err()
            .to_string()
            .contains("rename plugin.json to codlet.json")
    );
    assert!(!fixture.root.join("codlet.json").exists());
    assert!(fixture.root.join("plugin.json").exists());
}

#[test]
fn host_grants_are_explicit_and_do_not_expand_the_declared_core_authority() {
    let fixture = Fixture::new();
    assert!(
        load_local_plugin("dev.host", &fixture.root, &[], 1)
            .unwrap_err()
            .to_string()
            .contains("host.process")
    );
    assert_eq!(
        fixture
            .load(&[Permission::HostProcess, Permission::CdpRaw])
            .manifest
            .permissions,
        [Permission::HostProcess]
    );
    let mut manifest: Value =
        serde_json::from_slice(&fs::read(fixture.root.join("codlet.json")).unwrap()).unwrap();
    manifest["permissions"] = json!(["host.process", "cdp.raw"]);
    fixture.manifest(&manifest);
    assert!(
        load_local_plugin("dev.host", &fixture.root, &[Permission::HostProcess], 1)
            .unwrap_err()
            .to_string()
            .contains("cdp.raw")
    );
    for declaration in ["provides", "requires"] {
        let mut changed = manifest.clone();
        changed[declaration] = json!([{"name":"dev.host.service","api":1,"scope":"runtime"}]);
        fixture.manifest(&changed);
        assert!(inspect_local_plugin(&fixture.root).is_ok());
        changed[declaration][0]["scope"] = json!("thread");
        fixture.manifest(&changed);
        assert!(
            inspect_local_plugin(&fixture.root)
                .unwrap_err()
                .to_string()
                .contains("Runtime and Target")
        );
    }
    manifest["renderer"] = json!({"entry":"missing.js","world":"isolated"});
    fixture.manifest(&manifest);
    assert!(
        inspect_local_plugin(&fixture.root)
            .unwrap_err()
            .to_string()
            .contains("missing.js")
    );
}

#[test]
fn catalog_keeps_standalone_js_host_and_core_providers_without_optional_packages() {
    let fixture = Fixture::new();
    let mut registry = PluginRegistry::load(fixture.directory.path().join("config.json")).unwrap();
    registry
        .register_local(
            "dev.host",
            LocalPluginRegistration {
                broker_policy: Default::default(),
                path: fs::canonicalize(&fixture.root).unwrap(),
                grants: vec![Permission::HostProcess],
            },
        )
        .unwrap();
    registry.set_enabled("codex.ui.adapter", false).unwrap();
    registry.set_enabled("codlet-gui", false).unwrap();
    let catalog = PluginCatalog::load(&registry).unwrap();
    let enabled = catalog.enabled_plugins(&registry).unwrap();
    let core_count = if cfg!(feature = "test-fixtures") {
        0
    } else {
        2
    };
    assert_eq!(
        enabled.len(),
        1 + core_count,
        "production Core providers plus the standalone author Host; synthetic fixtures were disabled"
    );
    let host = enabled
        .iter()
        .find(|plugin| plugin.manifest.id == "dev.host")
        .unwrap();
    assert!(host.manifest.renderer.is_none());
    assert_eq!(
        enabled
            .iter()
            .filter(|plugin| catalog.is_core(&plugin.manifest.id))
            .count(),
        core_count
    );
    assert!(
        !enabled
            .iter()
            .any(|plugin| plugin.manifest.id == "codlet-gui")
    );
    let runtime = codlet::renderer::RendererRuntime::from_catalog(catalog, registry).unwrap();
    assert_eq!(
        runtime.plugin_count(),
        core_count,
        "only production Core owns renderer entries"
    );
    assert_eq!(runtime.has_renderer_plugins(), core_count != 0);
}

#[test]
fn sdk_host_does_not_inherit_saved_raw_grants_and_node_migration_requires_a_new_grant() {
    let fixture = Fixture::new();
    fixture.manifest(&json!({"schema":1,"id":"dev.host","version":"1","host":{"entry":"dist/host.js","mode":"sdk"}}));
    let sdk = fixture.load(&[]);
    assert_eq!(
        sdk.manifest.host_mode(),
        Some(codlet::plugins::HostMode::Sdk)
    );
    assert!(
        fixture
            .load(&[Permission::HostProcess, Permission::HostRaw])
            .manifest
            .permissions
            .is_empty()
    );
    fixture.manifest(&json!({"schema":1,"id":"dev.host","version":"2","host":{"entry":"dist/host.js","mode":"node"},"permissions":["host.raw"]}));
    assert!(
        load_local_plugin("dev.host", &fixture.root, &[Permission::HostProcess], 8)
            .unwrap_err()
            .to_string()
            .contains("host.raw")
    );
    assert_eq!(
        fixture.load(&[Permission::HostRaw]).manifest.host_mode(),
        Some(codlet::plugins::HostMode::Node)
    );
}

#[test]
#[cfg(not(feature = "test-fixtures"))]
fn core_provider_migration_preserves_old_registration_files_data_and_disabled_preference() {
    let fixture = Fixture::new();
    let registry_path = fixture.directory.path().join("config.json");
    let mut registry = PluginRegistry::load(&registry_path).unwrap();
    for id in ["codex.ui.adapter", "codex.desktop.adapter"] {
        let root = fixture.directory.path().join(id);
        fs::create_dir_all(root.join("data")).unwrap();
        fs::write(
            root.join("codlet.json"),
            "invalid old author manifest; must not be inspected",
        )
        .unwrap();
        fs::write(
            root.join("renderer.js"),
            "throw Error('old copy must not execute');",
        )
        .unwrap();
        fs::write(
            root.join("data/observations.json"),
            "preserved observations",
        )
        .unwrap();
        registry
            .register_local(
                id,
                LocalPluginRegistration {
                    path: fs::canonicalize(root).unwrap(),
                    grants: vec![Permission::UiDom],
                    broker_policy: Default::default(),
                },
            )
            .unwrap();
        registry.set_enabled(id, false).unwrap();
    }
    registry.save().unwrap();
    let before = fs::read(&registry_path).unwrap();
    let catalog = PluginCatalog::load(&registry).unwrap();
    for id in ["codex.ui.adapter", "codex.desktop.adapter"] {
        assert!(catalog.is_core(id));
        assert_eq!(
            catalog
                .entries()
                .iter()
                .filter(|entry| entry.id == id)
                .count(),
            1
        );
        let provider = catalog
            .entries()
            .iter()
            .find(|entry| entry.id == id)
            .unwrap()
            .plugin
            .as_ref()
            .unwrap();
        assert!(codlet::codex::is_internal_plugin(provider));
        let old = &registry.local_plugins()[id];
        assert_eq!(old.grants, [Permission::UiDom]);
        assert!(!registry.is_enabled(id));
        assert_eq!(
            fs::read_to_string(old.path.join("data/observations.json")).unwrap(),
            "preserved observations"
        );
        assert_eq!(
            fs::read_to_string(old.path.join("codlet.json")).unwrap(),
            "invalid old author manifest; must not be inspected"
        );
    }
    assert_eq!(catalog.legacy_adapter_registrations(&registry).len(), 2);
    assert_eq!(
        catalog.enabled_plugins(&registry).unwrap().len(),
        2,
        "saved disabled preferences do not disable Core ownership"
    );
    assert_eq!(
        fs::read(registry_path).unwrap(),
        before,
        "catalog migration is read-only"
    );
}

#[test]
fn combined_loader_retains_both_snapshots_and_separates_entry_capability_declarations() {
    let fixture = Fixture::new();
    let descriptor = json!({"name":"dev.host.service","api":1,"scope":"target"});
    fixture.manifest(&json!({"schema":1,"id":"dev.host","version":"1","host":{"entry":"dist/host.js","provides":[descriptor]},"renderer":{"entry":"renderer.js","world":"isolated"},"requires":[descriptor],"permissions":["host.process","ui.dom"]}));
    let renderer_source = "module.exports={activate(){},deactivate(){}}; // immutable renderer";
    fs::write(fixture.root.join("renderer.js"), renderer_source).unwrap();
    let loaded = fixture.load(&[Permission::HostProcess, Permission::UiDom]);
    assert_eq!(loaded.generation, 7);
    assert_eq!(loaded.source.as_deref(), Some(renderer_source));
    let retained = loaded.clone();
    assert!(std::sync::Arc::ptr_eq(
        loaded.source.as_ref().unwrap(),
        retained.source.as_ref().unwrap()
    ));
    assert_eq!(&*loaded.host.as_ref().unwrap().source, SOURCE);
    assert_eq!(loaded.manifest.host_provides().len(), 1);
    assert!(loaded.manifest.renderer_provides().is_empty());
    assert_eq!(
        loaded.manifest.renderer_requires(),
        loaded.manifest.host_provides()
    );
    fs::write(fixture.entry(), "changed native bytes").unwrap();
    fs::write(fixture.root.join("renderer.js"), "changed renderer bytes").unwrap();
    assert_eq!(&*loaded.host.as_ref().unwrap().source, SOURCE);
    assert_eq!(loaded.source.as_deref(), Some(renderer_source));
    assert!(load_local_plugin("dev.host", &fixture.root, &[Permission::HostProcess], 8).is_err());
}

#[test]
fn standalone_host_manifest_uses_its_existing_top_level_provides_contract() {
    let fixture = Fixture::new();
    let descriptor = json!({"name":"dev.host.service","api":1,"scope":"target"});
    let mut manifest = json!({"schema":1,"id":"dev.host","version":"1","host":{"entry":"dist/host.js"},"provides":[descriptor],"permissions":["host.process"]});
    fixture.manifest(&manifest);
    let loaded = fixture.load(&[Permission::HostProcess]);
    assert_eq!(
        loaded.manifest.host_provides(),
        loaded.manifest.provides.as_slice()
    );
    assert!(
        serde_json::to_value(&loaded.manifest).unwrap()["host"]
            .get("provides")
            .is_none()
    );
    manifest["host"]["provides"] = json!([descriptor]);
    fixture.manifest(&manifest);
    assert!(
        inspect_local_plugin(&fixture.root)
            .unwrap_err()
            .to_string()
            .contains("provides at the top level")
    );
}
