#![cfg(windows)]

use std::path::Path;
use std::process::{Command, Output};

use serde_json::{Value, json};
use tempfile::tempdir;

fn run(local_app_data: &Path, arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_codlet"))
        .args(arguments)
        .env("LOCALAPPDATA", local_app_data)
        .env_remove("CODLET_HOME")
        .output()
        .unwrap()
}

fn json_output(output: &Output) -> Value {
    // from_slice rejects any non-JSON log lines before or after the report.
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["schema"], "codlet.doctor/v1");
    assert_eq!(report["mode"], "read_only");
    assert_eq!(
        Some(report["result"]["exitCode"].as_i64().unwrap() as i32),
        output.status.code()
    );
    let failed_checks = report["result"]["failedChecks"].as_array().unwrap();
    assert_eq!(output.status.success(), failed_checks.is_empty());
    // These commands each use a fresh registry scope. A Host for the user's
    // real configuration may exist, but cannot supply this fixture's facts.
    assert!(
        matches!(
            report["runtime"]["status"].as_str(),
            Some("not_running" | "other_registry" | "unsupported" | "unavailable")
        ),
        "{report}"
    );
    assert!(report["runtime"].get("sample").is_none());
    for key in [
        "targets",
        "pluginGenerations",
        "providerReady",
        "compatibility",
    ] {
        assert_eq!(report["runtime"][key]["status"], "unavailable");
        assert!(report["runtime"][key].get("data").is_none());
    }
    report
}

#[test]
fn doctor_json_is_one_versioned_report_and_does_not_create_registry() {
    let directory = tempdir().unwrap();
    let report = json_output(&run(directory.path(), &["doctor", "--json"]));
    assert_eq!(report["registry"]["status"], "ok");
    assert_eq!(report["dependencyGraph"]["status"], "ok");
    let plugins = report["plugins"]["data"].as_array().unwrap();
    assert_eq!(plugins.len(), 2);
    assert!(
        plugins
            .iter()
            .all(|plugin| plugin["desiredEnabled"] == true)
    );
    assert!(
        plugins
            .iter()
            .all(|plugin| plugin.get("generation").is_none())
    );
    assert!(!directory.path().join("Codlet").exists());
}

#[test]
fn doctor_json_preserves_corrupt_registry_and_returns_nonzero_with_a_repair() {
    let directory = tempdir().unwrap();
    let config_dir = directory.path().join("Codlet");
    std::fs::create_dir(&config_dir).unwrap();
    let path = config_dir.join("config.json");
    let corrupt = b"{ invalid registry";
    std::fs::write(&path, corrupt).unwrap();
    let output = run(directory.path(), &["doctor", "--json"]);
    let report = json_output(&output);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(report["registry"]["error"]["code"], "registry_json_invalid");
    assert!(
        report["registry"]["error"]["remediation"]
            .as_str()
            .unwrap()
            .contains("Back up")
    );
    assert!(
        report["plugins"]["data"]
            .as_array()
            .unwrap()
            .iter()
            .all(|plugin| plugin["desiredEnabled"].is_null())
    );
    assert_eq!(report["dependencyGraph"]["status"], "unavailable");
    assert!(report.get("package").is_some());
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("doctor found")
    );
    assert_eq!(std::fs::read(&path).unwrap(), corrupt);
    assert_eq!(config_dir.read_dir().unwrap().count(), 1);
}

#[test]
fn doctor_json_reports_disabled_provider_dependency_failure_without_writing() {
    let directory = tempdir().unwrap();
    let config_dir = directory.path().join("Codlet");
    std::fs::create_dir(&config_dir).unwrap();
    let path = config_dir.join("config.json");
    let bytes =
        serde_json::to_vec(&json!({"schema":1,"plugins":{"codex.ui.adapter":{"enabled":false}}}))
            .unwrap();
    std::fs::write(&path, &bytes).unwrap();
    let output = run(directory.path(), &["doctor", "--json"]);
    let report = json_output(&output);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        report["dependencyGraph"]["error"]["code"],
        "dependency_provider_disabled"
    );
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(config_dir.read_dir().unwrap().count(), 1);
}

#[test]
fn doctor_human_output_distinguishes_declarations_and_unavailable_runtime() {
    let directory = tempdir().unwrap();
    let output = run(directory.path(), &["doctor"]);
    let stdout = String::from_utf8(output.stdout).unwrap();
    for expected in [
        "desired-enabled=true",
        "declares-provider:",
        "declares-requirement:",
        "static desired configuration only",
        "runtime: ",
        "targets: unavailable",
        "plugin-generations: unavailable",
        "provider-ready: unavailable",
        "compatibility: not_probed",
    ] {
        assert!(stdout.contains(expected), "missing {expected}: {stdout}");
    }
    assert!(!stdout.contains("runtime: not_probed"));
    assert!(!directory.path().join("Codlet").exists());
}

#[test]
fn doctor_rejects_extra_arguments_before_any_diagnostic_or_configuration_work() {
    let directory = tempdir().unwrap();
    for args in [
        vec!["doctor", "--json", "--launch-codex"],
        vec!["doctor", "--attach"],
        vec!["doctor", "--json", "--json"],
    ] {
        let output = run(directory.path(), &args);
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        assert!(
            String::from_utf8(output.stderr)
                .unwrap()
                .contains("codlet doctor [--json]")
        );
    }
    assert!(!directory.path().join("Codlet").exists());
}

#[test]
fn doctor_without_registry_path_keeps_static_diagnostics_and_reports_runtime_unavailable() {
    let directory = tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_codlet"))
        .args(["doctor", "--json"])
        .env_remove("LOCALAPPDATA")
        .env_remove("CODLET_HOME")
        .current_dir(directory.path())
        .output()
        .unwrap();
    let report = json_output(&output);
    assert_eq!(
        report["registry"]["error"]["code"],
        "registry_path_unavailable"
    );
    assert_eq!(report["runtime"]["status"], "unavailable");
    assert!(
        report["runtime"]["issues"]
            .as_array()
            .unwrap()
            .iter()
            .any(|issue| issue["code"] == "runtime_registry_unavailable")
    );
    assert!(
        report["result"]["failedChecks"]
            .as_array()
            .unwrap()
            .contains(&json!("runtime"))
    );
    assert!(
        !report["declaredHostProviders"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(directory.path().read_dir().unwrap().count(), 0);
}
