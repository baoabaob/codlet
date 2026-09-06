use std::path::Path;

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
        plugins: bundled_plugins(),
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
    assert_eq!(plugin(&report, "codlet")["desiredEnabled"], true);
    assert_eq!(
        report["dependencyGraph"]["data"]["basis"],
        "static_desired_configuration"
    );
    assert_eq!(
        report["dependencyGraph"]["data"]["activationOrder"],
        json!(["codex.ui.adapter", "codlet.core.host", "codlet"])
    );
    assert!(plugin(&report, "codlet").get("generation").is_none());
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
    assert!(plugin(&json, "codlet")["desiredEnabled"].is_null());
    assert_eq!(
        plugin(&json, "codlet")["requires"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        plugin(&json, "codex.ui.adapter")["provides"][0]["name"],
        "codex.ui.titlebar.afterMenu"
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
    assert_eq!(error["details"]["consumer"], "codlet");
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
    for id in ["codlet", "codex.ui.adapter"] {
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
        manifest: PluginManifest::parse(&json!({
            "schema": 1, "id": id, "version": "1", "renderer": {"entry": "renderer.js", "world": "isolated"},
            "provides": provides, "requires": requires,
        }).to_string()).unwrap(),
        source: String::new(),
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
        inputs.plugins = Ok(plugins);
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
