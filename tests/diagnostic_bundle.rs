use std::io::Read;
use std::path::Path;

use codlet::catalog::PluginCatalog;
use codlet::diagnostic_bundle::{self, BundleError};
use codlet::diagnostics::{
    Check, DiagnosticIssue, DoctorInputs, DoctorReport, PackageInfo, ProcessInfo, ProcessSnapshot,
};
use codlet::plugins::{PluginRegistry, bundled_plugins};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn report(root: &Path) -> DoctorReport {
    let registry = PluginRegistry::load(root.join("private-path/config.json")).unwrap();
    DoctorReport::from_inputs(DoctorInputs {
        package: Check::ok(PackageInfo {
            family_name: "OpenAI.Codex".into(),
            full_name: "private-package-field".into(),
            version: "26.908.4834.0".into(),
            install_location: "private-install-path".into(),
        }),
        executable: Check::ok("private-executable-path".into()),
        processes: Check::ok(ProcessSnapshot::new(vec![ProcessInfo {
            process_id: 123,
            executable: "private-process-path".into(),
        }])),
        registry_path: Some(registry.path().to_owned()),
        registry: Ok(registry),
        catalog: Ok(PluginCatalog::from_bundled(bundled_plugins().unwrap())),
    })
}
fn read_archive(path: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    (0..zip.len())
        .map(|index| {
            let mut file = zip.by_index(index).unwrap();
            let name = file.name().to_owned();
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).unwrap();
            (name, bytes)
        })
        .collect()
}

#[test]
fn exports_a_small_fixed_archive_with_matching_hashes_and_unavailable_evidence() {
    let root = tempfile::tempdir().unwrap();
    let output = root.path().join("诊断 report.zip");
    let report = report(root.path());
    let receipt = diagnostic_bundle::export(&output, &report).unwrap();
    let raw = std::fs::read(&output).unwrap();
    assert_eq!(receipt.sha256, format!("{:x}", Sha256::digest(&raw)));
    assert_eq!(receipt.bytes, raw.len() as u64);
    let entries = read_archive(&output);
    assert_eq!(
        entries.keys().map(String::as_str).collect::<Vec<_>>(),
        ["README.txt", "doctor-summary.json", "manifest.json"]
    );
    let manifest: Value = serde_json::from_slice(&entries["manifest.json"]).unwrap();
    assert_eq!(manifest["schema"], "codlet.diagnostic-bundle/v1");
    for file in manifest["files"].as_array().unwrap() {
        let bytes = &entries[file["path"].as_str().unwrap()];
        assert_eq!(file["bytes"], bytes.len());
        assert_eq!(file["sha256"], format!("{:x}", Sha256::digest(bytes)));
    }
    let summary: Value = serde_json::from_slice(&entries["doctor-summary.json"]).unwrap();
    assert_eq!(summary["runtime"]["status"], "not_probed");
    assert!(summary["runtime"]["sample"].is_null());
    assert_eq!(
        summary["runtime"]["checks"]["providerReady"]["status"],
        "unavailable"
    );
    assert_eq!(summary["processes"]["processIds"], json!([123]));
    assert!(!root.path().join("private-path").exists());
}

#[test]
fn projection_drops_raw_errors_paths_and_target_ids_but_preserves_failure_facts() {
    use codlet::diagnostics::RuntimeGenerations;
    use codlet::runtime_inspection::InspectedTarget;
    use codlet::runtime_status::StatusEvent;
    let root = tempfile::tempdir().unwrap();
    let mut report = report(root.path());
    let mut issue = DiagnosticIssue::new(
        "fixture_failure",
        "secret-token-IN-MESSAGE",
        "private-remediation-path",
    );
    issue.details = json!({"secret":"raw-configuration"});
    report.plugin_validation = Check::Failed { error: issue };
    report.runtime.plugin_generations = Check::ok(RuntimeGenerations {
        basis: "fixture",
        complete: false,
        targets: vec![InspectedTarget {
            target_id: "private-target-identifier".into(),
            session_id: "private-session-identifier".into(),
            session_live: true,
            document_epoch: 3,
            recovery_pending: true,
            scope_active: false,
            plugins: vec![],
        }],
    });
    report.runtime.recent_events = vec![StatusEvent {
        target_id: "private-target-identifier".into(),
        code: "activation_failed".into(),
        message: "secret-token-IN-EVENT".into(),
    }];
    let summary = diagnostic_bundle::summary(&report);
    let text = summary.to_string();
    for omitted in [
        "private-path",
        "private-install-path",
        "private-executable-path",
        "private-process-path",
        "private-package-field",
        "secret-token-IN-MESSAGE",
        "private-remediation-path",
        "raw-configuration",
        "private-target-identifier",
        "private-session-identifier",
        "secret-token-IN-EVENT",
    ] {
        assert!(!text.contains(omitted), "leaked {omitted}");
    }
    assert_eq!(
        summary["checks"]["pluginValidation"]["code"],
        "fixture_failure"
    );
    assert_eq!(summary["runtime"]["generations"]["complete"], false);
    assert_eq!(
        summary["runtime"]["generations"]["targets"][0]["target"],
        summary["runtime"]["events"][0]["target"]
    );
    assert_eq!(summary["runtime"]["events"][0]["code"], "activation_failed");
}

#[test]
fn existing_files_links_and_racing_exports_cannot_be_overwritten() {
    let root = tempfile::tempdir().unwrap();
    let output = root.path().join("existing.zip");
    std::fs::write(&output, b"keep existing file").unwrap();
    assert!(matches!(
        diagnostic_bundle::export(&output, &report(root.path())),
        Err(BundleError::Exists)
    ));
    let linked = root.path().join("linked.zip");
    std::fs::hard_link(&output, &linked).unwrap();
    assert!(matches!(
        diagnostic_bundle::export(&linked, &report(root.path())),
        Err(BundleError::Exists)
    ));
    assert_eq!(std::fs::read(&output).unwrap(), b"keep existing file");
    let output = root.path().join("race.zip");
    let barrier = std::sync::Barrier::new(2);
    let results = std::thread::scope(|scope| {
        let jobs: Vec<_> = (0..2)
            .map(|_| {
                scope.spawn(|| {
                    let report = report(root.path());
                    barrier.wait();
                    diagnostic_bundle::export(&output, &report)
                })
            })
            .collect();
        jobs.into_iter()
            .map(|job| job.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(read_archive(&output).len(), 3);
}

#[test]
fn export_rejects_relative_paths_non_zip_and_missing_parents() {
    let root = tempfile::tempdir().unwrap();
    for output in [
        std::path::PathBuf::from("relative.zip"),
        root.path().join("config.json"),
        root.path().join("missing/new.zip"),
    ] {
        assert!(matches!(
            diagnostic_bundle::validate_output(&output),
            Err(BundleError::InvalidOutput)
        ));
    }
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}

#[cfg(windows)]
#[test]
fn actual_cli_exports_a_failed_doctor_without_modifying_the_corrupt_registry() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("Codlet");
    std::fs::create_dir(&config).unwrap();
    let file = config.join("config.json");
    std::fs::write(&file, b"{ private broken registry").unwrap();
    let output = root.path().join("failed.zip");
    let args = [
        std::ffi::OsStr::new("diagnostics"),
        std::ffi::OsStr::new("--output"),
        output.as_os_str(),
        std::ffi::OsStr::new("--json"),
    ];
    let result = std::process::Command::new(env!("CARGO_BIN_EXE_codlet"))
        .args(args)
        .env("LOCALAPPDATA", root.path())
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let receipt: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(receipt["doctorStatus"], "failed");
    let entries = read_archive(&output);
    let report: Value = serde_json::from_slice(&entries["doctor-summary.json"]).unwrap();
    assert_eq!(
        report["checks"]["registry"]["code"],
        "registry_json_invalid"
    );
    assert!(
        !String::from_utf8_lossy(&entries["doctor-summary.json"])
            .contains("private broken registry")
    );
    assert_eq!(std::fs::read(&file).unwrap(), b"{ private broken registry");
    assert_eq!(std::fs::read_dir(&config).unwrap().count(), 1);
    let repeat = std::process::Command::new(env!("CARGO_BIN_EXE_codlet"))
        .args(args)
        .env("LOCALAPPDATA", root.path())
        .output()
        .unwrap();
    assert!(!repeat.status.success());
    assert!(repeat.stdout.is_empty());
    assert!(String::from_utf8_lossy(&repeat.stderr).contains("already exists"));
}
