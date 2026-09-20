use std::path::Path;

use codlet::catalog::PluginCatalog;
use codlet::diagnostics::{
    Check, DiagnosticIssue, DoctorInputs, DoctorReport, PackageInfo, ProcessInfo, ProcessSnapshot,
};
use codlet::plugins::{LoadedPlugin, PluginManifest, PluginRegistry, bundled_plugins};
use serde_json::{Value, json};
use tempfile::tempdir;

fn fixture(registry_path: &Path) -> DoctorInputs {
    DoctorInputs {
        package: Check::ok(PackageInfo {
            family_name: "test.codex_family".to_owned(),
            full_name: "test.codex_1.2.3.4".to_owned(),
            version: "1.2.3.4".to_owned(),
            install_location: "C:/fixture/Codex".to_owned(),
        }),
        executable: Check::ok("C:/fixture/Codex/app/ChatGPT.exe".to_owned()),
        processes: Check::ok(ProcessSnapshot::new(Vec::new())),
        registry_path: Some(registry_path.to_owned()),
        registry: PluginRegistry::load(registry_path),
        catalog: bundled_plugins().map(PluginCatalog::from_bundled),
    }
}

fn report_json(inputs: DoctorInputs) -> Value {
    serde_json::from_str(&DoctorReport::from_inputs(inputs).to_json()).unwrap()
}

fn plugin<'a>(report: &'a Value, id: &str) -> &'a Value {
    report["plugins"]["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|plugin| plugin["id"] == id)
        .unwrap()
}

fn assert_runtime_unavailable(report: &Value) {
    assert_eq!(report["runtime"]["status"], "not_probed");
    for key in [
        "targets",
        "pluginGenerations",
        "providerReady",
        "compatibility",
    ] {
        assert_eq!(report["runtime"][key]["status"], "unavailable");
        assert!(report["runtime"][key].get("data").is_none());
    }
}

#[test]
fn missing_registry_reports_defaults_without_creating_any_directory_or_runtime_facts() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("missing").join("config.json");
    let report = report_json(fixture(&path));
    assert_eq!(report["schema"], "codlet.doctor/v1");
    assert_eq!(report["mode"], "read_only");
    assert_eq!(report["result"]["exitCode"], 0);
    assert_eq!(report["registry"]["status"], "ok");
    assert_eq!(
        report["registry"]["data"]["appliesTo"],
        "next_codlet_launch"
    );
    assert_eq!(plugin(&report, "codlet-gui")["desiredEnabled"], true);
    assert_eq!(
        report["dependencyGraph"]["data"]["basis"],
        "static_desired_configuration"
    );
    assert_eq!(
        report["dependencyGraph"]["data"]["activationOrder"],
        json!(["codex.ui.adapter", "codlet.core.host", "codlet-gui"])
    );
    assert!(plugin(&report, "codlet-gui").get("generation").is_none());
    assert_runtime_unavailable(&report);
    assert!(!path.parent().unwrap().exists());
}

#[test]
fn package_unavailable_still_reports_corrupt_registry_and_declared_capabilities() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("config.json");
    let corrupt = b"{ broken registry";
    std::fs::write(&path, corrupt).unwrap();
    let mut inputs = fixture(&path);
    inputs.package = Check::Failed {
        error: DiagnosticIssue::new(
            "package_not_installed",
            "Package fixture unavailable",
            "Install the official Codex package.",
        ),
    };
    inputs.executable = Check::Unavailable {
        reason: "Package unavailable",
    };
    inputs.processes = Check::Unavailable {
        reason: "Executable unavailable",
    };
    let report = DoctorReport::from_inputs(inputs);
    let json: Value = serde_json::from_str(&report.to_json()).unwrap();
    assert_eq!(json["result"]["exitCode"], 1);
    assert_eq!(
        json["result"]["failedChecks"],
        json!(["package", "registry"])
    );
    assert_eq!(json["registry"]["error"]["code"], "registry_json_invalid");
    assert_eq!(json["dependencyGraph"]["status"], "unavailable");
    assert_eq!(json["processes"]["status"], "unavailable");
    assert!(plugin(&json, "codlet-gui")["desiredEnabled"].is_null());
    assert_eq!(
        plugin(&json, "codlet-gui")["requires"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert!(
        plugin(&json, "codex.ui.adapter")["provides"]
            .as_array()
            .unwrap()
            .iter()
            .any(|capability| capability["name"] == "codex.ui.navigation.page")
    );
    let human = report.to_human_readable();
    assert!(human.contains("package: failed [package_not_installed]"));
    assert!(human.contains("registry: failed [registry_json_invalid]"));
    assert!(human.contains("desired-enabled=unavailable"));
    assert!(human.contains("action:"));
    assert_eq!(std::fs::read(&path).unwrap(), corrupt);
    assert_runtime_unavailable(&json);
}

#[test]
fn disabled_provider_invalidates_the_desired_graph_and_identifies_a_repair() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("config.json");
    let mut inputs = fixture(&path);
    inputs
        .registry
        .as_mut()
        .unwrap()
        .set_enabled("codex.ui.adapter", false)
        .unwrap();
    let report = report_json(inputs);
    assert_eq!(report["result"]["exitCode"], 1);
    assert_eq!(report["result"]["failedChecks"], json!(["dependencyGraph"]));
    assert_eq!(plugin(&report, "codex.ui.adapter")["desiredEnabled"], false);
    let error = &report["dependencyGraph"]["error"];
    assert_eq!(error["code"], "dependency_provider_disabled");
    assert_eq!(error["details"]["consumer"], "codlet-gui");
    assert_eq!(
        error["details"]["disabledProviders"],
        json!(["codex.ui.adapter"])
    );
    assert!(
        error["remediation"]
            .as_str()
            .unwrap()
            .contains("codlet plugin enable codex.ui.adapter")
    );
    assert!(report["dependencyGraph"].get("data").is_none());
    assert!(!path.exists());
}

#[test]
fn disabling_both_provider_and_consumer_has_a_valid_static_graph() {
    let directory = tempdir().unwrap();
    let mut inputs = fixture(&directory.path().join("config.json"));
    for id in ["codlet-gui", "codex.ui.adapter"] {
        inputs
            .registry
            .as_mut()
            .unwrap()
            .set_enabled(id, false)
            .unwrap();
    }
    let report = report_json(inputs);
    assert_eq!(report["result"]["exitCode"], 0);
    assert_eq!(
        report["dependencyGraph"]["data"]["activationOrder"],
        json!(["codlet.core.host"])
    );
    assert_runtime_unavailable(&report);
}

#[test]
fn running_codex_blocks_launch_but_does_not_fail_read_only_doctor() {
    let directory = tempdir().unwrap();
    let mut inputs = fixture(&directory.path().join("config.json"));
    inputs.processes = Check::ok(ProcessSnapshot::new(vec![
        ProcessInfo {
            process_id: 51,
            executable: "C:/fixture/ChatGPT.exe".to_owned(),
        },
        ProcessInfo {
            process_id: 23,
            executable: "C:/fixture/ChatGPT.exe".to_owned(),
        },
    ]));
    let report = DoctorReport::from_inputs(inputs);
    let json: Value = serde_json::from_str(&report.to_json()).unwrap();
    assert_eq!(json["result"]["exitCode"], 0);
    assert_eq!(json["result"]["launchPreflight"], "blocked");
    assert_eq!(json["processes"]["data"]["launchConflict"], true);
    assert_eq!(
        json["processes"]["data"]["matchingProcesses"][0]["processId"],
        23
    );
    assert!(
        report
            .to_human_readable()
            .contains("Before a future codlet launch, close Codex yourself")
    );
    assert_runtime_unavailable(&json);
}

#[test]
fn failed_process_snapshot_is_not_an_empty_successful_snapshot() {
    let directory = tempdir().unwrap();
    let mut inputs = fixture(&directory.path().join("config.json"));
    inputs.processes = Check::Failed {
        error: DiagnosticIssue::new(
            "process_snapshot_failed",
            "Candidate access denied",
            "Check process access and rerun doctor.",
        ),
    };
    let report = report_json(inputs);
    assert_eq!(report["result"]["exitCode"], 1);
    assert_eq!(report["processes"]["status"], "failed");
    assert!(report["processes"].get("data").is_none());
    assert_eq!(report["dependencyGraph"]["status"], "ok");
}

fn descriptor(name: &str, api: u32, scope: &str) -> Value {
    json!({"name": name, "api": api, "scope": scope})
}

fn declared_plugin(id: &str, provides: Vec<Value>, requires: Vec<Value>) -> LoadedPlugin {
    LoadedPlugin {
        authorization: None,
        manifest: PluginManifest::parse(&json!({
            "schema": 1, "id": id, "version": "1", "renderer": {"entry": "renderer.js", "world": "isolated"},
            "provides": provides, "requires": requires,
        }).to_string()).unwrap(),
        source: Some(String::new()),
        host: None,
        generation: 1,
    }
}

#[test]
fn diagnostic_graph_reuses_kernel_conflict_version_scope_and_cycle_rules() {
    let first = descriptor("fixture.first", 1, "target");
    let second = descriptor("fixture.second", 1, "target");
    let cases = [
        (
            "dependency_capability_conflict",
            vec![
                declared_plugin("dev.a", vec![first.clone()], vec![]),
                declared_plugin(
                    "dev.b",
                    vec![descriptor("fixture.first", 2, "target")],
                    vec![],
                ),
            ],
        ),
        (
            "dependency_api_mismatch",
            vec![
                declared_plugin("dev.a", vec![first.clone()], vec![]),
                declared_plugin(
                    "dev.b",
                    vec![],
                    vec![descriptor("fixture.first", 2, "target")],
                ),
            ],
        ),
        (
            "dependency_missing_provider",
            vec![
                declared_plugin("dev.a", vec![first.clone()], vec![]),
                declared_plugin(
                    "dev.b",
                    vec![],
                    vec![descriptor("fixture.first", 1, "runtime")],
                ),
            ],
        ),
        (
            "dependency_cycle",
            vec![
                declared_plugin("dev.a", vec![first.clone()], vec![second.clone()]),
                declared_plugin("dev.b", vec![second], vec![first]),
            ],
        ),
    ];
    let directory = tempdir().unwrap();
    for (code, plugins) in cases {
        let mut inputs = fixture(&directory.path().join("config.json"));
        inputs.catalog = Ok(PluginCatalog::from_bundled(plugins));
        let report = report_json(inputs);
        assert_eq!(report["result"]["exitCode"], 1, "{code}");
        assert_eq!(report["dependencyGraph"]["error"]["code"], code);
        assert!(report["dependencyGraph"].get("data").is_none());
    }
}

#[test]
fn reported_host_declarations_satisfy_the_same_contract_as_renderer_construction() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("config.json");
    let report = report_json(fixture(&path));
    let host = &report["declaredHostProviders"][0];
    assert_eq!(host["id"], "codlet.core.host");
    let plugins = vec![declared_plugin(
        "dev.host-consumer",
        vec![],
        host["provides"].as_array().unwrap().clone(),
    )];
    let runtime =
        codlet::renderer::RendererRuntime::new(plugins, PluginRegistry::load(&path).unwrap())
            .unwrap();
    assert_eq!(runtime.session_count(), 0);
    assert_eq!(runtime.plugin_count(), 1);
    assert!(!path.exists());
}

#[cfg(windows)]
fn register_local_fixture(
    registry: &mut PluginRegistry,
    directory: &Path,
    id: &str,
    permissions: &[&str],
    provides: Vec<Value>,
    requires: Vec<Value>,
    grants: Vec<codlet::plugins::Permission>,
) -> std::path::PathBuf {
    let root = directory.join(id);
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("codlet.json"), json!({
        "schema": 1, "id": id, "version": "1", "renderer": {"entry": "renderer.js", "world": "isolated"},
        "permissions": permissions, "provides": provides, "requires": requires,
    }).to_string()).unwrap();
    std::fs::write(
        root.join("renderer.js"),
        "module.exports = { activate() {}, deactivate() {} };",
    )
    .unwrap();
    registry
        .register_local(
            id,
            codlet::plugins::LocalPluginRegistration {
                broker_policy: Default::default(),
                path: root.clone(),
                grants,
            },
        )
        .unwrap();
    root
}

#[cfg(windows)]
#[test]
fn local_catalog_shares_dependency_validation_and_uses_only_collected_data() {
    let directory = tempdir().unwrap();
    let registry_path = directory.path().join("config.json");
    let mut inputs = fixture(&registry_path);
    let registry = inputs.registry.as_mut().unwrap();
    let provided = descriptor("fixture.local", 1, "target");
    let provider_path = register_local_fixture(
        registry,
        directory.path(),
        "dev.provider",
        &[],
        vec![provided.clone()],
        vec![],
        vec![],
    );
    register_local_fixture(
        registry,
        directory.path(),
        "dev.consumer",
        &["ui.dom"],
        vec![],
        vec![provided],
        vec![codlet::plugins::Permission::UiDom],
    );
    let catalog = PluginCatalog::load(registry).unwrap();
    let runtime = codlet::renderer::RendererRuntime::from_catalog(
        PluginCatalog::load(registry).unwrap(),
        registry.clone(),
    )
    .unwrap();
    assert_eq!(runtime.plugin_count(), 4);
    assert_eq!(runtime.session_count(), 0);
    std::fs::remove_file(provider_path.join("codlet.json")).unwrap();
    inputs.catalog = Ok(catalog);
    let report = report_json(inputs);
    assert_eq!(report["result"]["exitCode"], 0);
    let order = report["dependencyGraph"]["data"]["activationOrder"]
        .as_array()
        .unwrap();
    assert!(
        order.iter().position(|id| id == "dev.provider").unwrap()
            < order.iter().position(|id| id == "dev.consumer").unwrap()
    );
    let consumer = plugin(&report, "dev.consumer");
    assert_eq!(consumer["source"], "local");
    assert_eq!(consumer["grants"], json!(["ui.dom"]));
    assert_eq!(consumer["requestedPermissions"], json!(["ui.dom"]));
    assert_eq!(consumer["validation"]["status"], "ok");
    assert!(consumer["path"].as_str().unwrap().contains("dev.consumer"));
    assert_runtime_unavailable(&report);
    assert!(!registry_path.exists());
}

#[cfg(windows)]
#[test]
fn disabled_broken_local_is_visible_but_only_enabled_failure_blocks_launch() {
    let directory = tempdir().unwrap();
    let mut inputs = fixture(&directory.path().join("config.json"));
    let registry = inputs.registry.as_mut().unwrap();
    registry
        .register_local(
            "dev.missing",
            codlet::plugins::LocalPluginRegistration {
                broker_policy: Default::default(),
                path: directory.path().join("missing"),
                grants: vec![],
            },
        )
        .unwrap();
    registry.set_enabled("dev.missing", false).unwrap();
    let catalog = PluginCatalog::load(registry).unwrap();
    assert_eq!(catalog.enabled_plugins(registry).unwrap().len(), 2);
    inputs.catalog = Ok(catalog);
    let report = report_json(inputs);
    assert_eq!(report["result"]["exitCode"], 0);
    assert_eq!(
        report["result"]["launchPreflight"],
        "not_blocked_by_snapshot"
    );
    let missing = plugin(&report, "dev.missing");
    assert_eq!(missing["validation"]["status"], "failed");
    assert_eq!(missing["desiredEnabled"], false);
    assert!(missing["version"].is_null());
    assert!(missing["requestedPermissions"].is_null());

    let mut enabled = fixture(&directory.path().join("config.json"));
    let registry = enabled.registry.as_mut().unwrap();
    registry
        .register_local(
            "dev.missing",
            codlet::plugins::LocalPluginRegistration {
                broker_policy: Default::default(),
                path: directory.path().join("missing"),
                grants: vec![],
            },
        )
        .unwrap();
    let catalog = PluginCatalog::load(registry).unwrap();
    assert!(catalog.enabled_plugins(registry).is_err());
    enabled.catalog = Ok(catalog);
    let report = report_json(enabled);
    assert_eq!(report["result"]["exitCode"], 1);
    assert_eq!(
        report["result"]["failedChecks"],
        json!(["pluginValidation"])
    );
    assert_eq!(
        report["pluginValidation"]["error"]["details"]["pluginId"],
        "dev.missing"
    );
    assert_eq!(report["dependencyGraph"]["status"], "unavailable");
    assert_eq!(
        plugin(&report, "dev.missing")["validation"]["status"],
        "failed"
    );
}

#[cfg(windows)]
#[test]
fn missing_local_grant_and_permission_upgrade_fail_before_runtime_construction() {
    let directory = tempdir().unwrap();
    let mut registry = PluginRegistry::load(directory.path().join("config.json")).unwrap();
    let root = register_local_fixture(
        &mut registry,
        directory.path(),
        "dev.trusted",
        &["ui.dom"],
        vec![],
        vec![],
        vec![],
    );
    assert!(
        PluginCatalog::load(&registry)
            .unwrap()
            .enabled_plugins(&registry)
            .is_err()
    );
    registry
        .register_local(
            "dev.trusted",
            codlet::plugins::LocalPluginRegistration {
                broker_policy: Default::default(),
                path: root.clone(),
                grants: vec![codlet::plugins::Permission::UiDom],
            },
        )
        .unwrap();
    let catalog = PluginCatalog::load(&registry).unwrap();
    assert_eq!(catalog.enabled_plugins(&registry).unwrap().len(), 3);
    let upgraded = json!({"schema":1,"id":"dev.trusted","version":"2","renderer":{"entry":"renderer.js","world":"isolated"},"permissions":["ui.dom","runtime.manage"]});
    std::fs::write(root.join("codlet.json"), upgraded.to_string()).unwrap();
    let error = codlet::renderer::RendererRuntime::from_catalog(
        PluginCatalog::load(&registry).unwrap(),
        registry,
    )
    .err()
    .unwrap();
    assert!(matches!(error, codlet::renderer::RendererError::Catalog(_)));
    assert!(error.to_string().contains("runtime.manage"));
}

#[test]
fn registration_operation_error_preserves_its_plugin_context() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("config.json");
    let mut inputs = fixture(&path);
    inputs.registry = Err(codlet::plugins::PluginRegistryError::Io {
        operation: "apply local plugin edit to",
        path,
        source: std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "local plugin dev.conflict: registration changed",
        ),
    });
    let report = report_json(inputs);
    assert_eq!(
        report["registry"]["error"]["code"],
        "registry_operation_failed"
    );
    assert!(
        report["registry"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("local plugin dev.conflict")
    );
}

#[cfg(windows)]
#[test]
fn deferred_local_scopes_fail_preflight_even_when_the_generic_graph_resolves() {
    use codlet::capabilities::CapabilityRegistry;
    use codlet::local_plugins::inspect_local_plugin;
    use codlet::renderer::{RendererError, RendererRuntime};

    for scope in ["backend-session", "thread"] {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        let mut inputs = fixture(&path);
        let registry = inputs.registry.as_mut().unwrap();
        let capability = descriptor("fixture.cross-scope", 1, scope);
        let consumer = register_local_fixture(
            registry,
            directory.path(),
            "dev.consumer",
            &[],
            vec![],
            vec![capability.clone()],
            vec![],
        );
        let consumer = inspect_local_plugin(&consumer).unwrap();
        let mut graph = CapabilityRegistry::new();
        graph
            .register_provider(
                "dev.provider",
                1,
                &[serde_json::from_value(capability).unwrap()],
                &[],
                &[],
            )
            .unwrap();
        graph
            .register_provider("dev.consumer", 1, &[], &consumer.manifest.requires, &[])
            .unwrap();
        assert!(
            graph.resolve_activation_order().is_ok(),
            "generic scope {scope} remains supported"
        );

        let catalog = PluginCatalog::load(registry).unwrap();
        let error = catalog.enabled_plugins(registry).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Core supports Runtime and Target requirements")
        );
        assert!(matches!(
            RendererRuntime::from_catalog(PluginCatalog::load(registry).unwrap(), registry.clone()),
            Err(RendererError::Catalog(_))
        ));
        registry.set_enabled("dev.consumer", false).unwrap();
        assert!(
            catalog.enabled_plugins(registry).is_ok(),
            "disabled unsupported requirements must not block launch"
        );
        registry.set_enabled("dev.consumer", true).unwrap();
        inputs.catalog = Ok(catalog);
        let report = report_json(inputs);
        assert_eq!(report["result"]["exitCode"], 1);
        assert_eq!(report["pluginValidation"]["status"], "failed");
        assert!(
            plugin(&report, "dev.consumer")["validation"]["error"]["message"]
                .as_str()
                .unwrap()
                .contains("Core supports Runtime and Target requirements")
        );
        assert!(!path.exists());
    }
}
