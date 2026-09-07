#![cfg(windows)]

use std::process::Command;

#[test]
fn status_json_does_not_read_or_modify_invalid_plugin_configuration() {
    let directory = tempfile::tempdir().unwrap();
    let config_directory = directory.path().join("Codlet");
    std::fs::create_dir(&config_directory).unwrap();
    let config = config_directory.join("config.json");
    let invalid = b"{ this is intentionally invalid configuration }";
    std::fs::write(&config, invalid).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_codlet"))
        .args(["status", "--json"])
        .env("LOCALAPPDATA", directory.path())
        .output()
        .unwrap();
    let report: codlet::runtime_status::StatusReport =
        serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report.schema_version, 1);
    assert_eq!(output.status.success(), report.is_success());
    // This also works when a user already has a Host in another installation.
    // The isolated endpoint no-host behavior is covered by the pipe unit tests.
    assert!(!String::from_utf8_lossy(&output.stderr).contains("configuration"));
    assert_eq!(std::fs::read(config).unwrap(), invalid);
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    assert_eq!(std::fs::read_dir(config_directory).unwrap().count(), 1);
}

#[test]
fn status_rejects_control_or_execution_arguments() {
    for arguments in [
        ["status", "--reload"],
        ["status", "--eval"],
        ["status", "--json=1"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_codlet"))
            .args(arguments)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8_lossy(&output.stderr).contains("codlet status [--json]"));
    }
}
