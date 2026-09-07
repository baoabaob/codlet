#![cfg(windows)]

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use codlet::cdp::CdpClient;
use codlet::windows::environment::ChildEnvironment;
use codlet::windows::process::launch_with_cdp_pipes_in_environment;

#[test]
fn child_environment_overrides_are_unicode_local_and_leave_parent_unchanged() {
    let parent_before: Vec<_> = std::env::vars_os().collect();
    let mut environment = ChildEnvironment::inherited().unwrap();
    environment
        .set(OsStr::new("CODLET_LAB_FIXTURE"), OsStr::new("first"))
        .unwrap();
    environment
        .set(OsStr::new("codlet_lab_fixture"), OsStr::new("覆盖 🙂"))
        .unwrap();
    environment
        .set(OsStr::new("CODLET_LAB_REMOVE"), OsStr::new("remove me"))
        .unwrap();
    environment.remove(OsStr::new("codlet_lab_remove")).unwrap();
    environment
        .set(OsStr::new("环境_变量"), OsStr::new("Unicode 值"))
        .unwrap();
    environment
        .set(OsStr::new("EMPTY"), OsStr::new(""))
        .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let (child, pipes) = launch_with_cdp_pipes_in_environment(
        &PathBuf::from(env!("CARGO_BIN_EXE_codlet-fake-child")),
        &[OsString::from("--scenario=lab-environment")],
        true,
        Some(&environment),
        Some(directory.path()),
    )
    .unwrap();
    let (client, _events) = CdpClient::spawn(pipes).unwrap();
    assert!(child.creation_time_filetime().unwrap() > 0);
    let report = client
        .request("Fake.environment", None, None, Duration::from_secs(3))
        .unwrap()
        .result
        .unwrap();
    assert_eq!(report["environment"]["CODLET_LAB_FIXTURE"], "覆盖 🙂");
    assert_eq!(report["environment"]["环境_变量"], "Unicode 值");
    assert_eq!(report["environment"]["EMPTY"], "");
    assert!(report["environment"]["CODLET_LAB_REMOVE"].is_null());
    assert_eq!(
        report["environment"]["SystemRoot"],
        std::env::var("SystemRoot").unwrap()
    );
    assert_eq!(report["pid"], child.process_id());
    assert_eq!(
        PathBuf::from(report["cwd"].as_str().unwrap()),
        directory.path()
    );
    client
        .request("Browser.close", None, None, Duration::from_secs(3))
        .unwrap();
    assert_eq!(child.wait(Duration::from_secs(3)).unwrap(), Some(0));
    client.shutdown().unwrap();
    assert_eq!(std::env::vars_os().collect::<Vec<_>>(), parent_before);
}

#[test]
fn lab_cli_does_not_create_files_or_launch_without_explicit_audited_options() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("not-created");
    for arguments in [
        vec![OsString::from("--root"), root.clone().into_os_string()],
        vec![
            OsString::from("--experimental-isolated-client"),
            OsString::from("--root"),
            root.clone().into_os_string(),
            OsString::from("--expected-package-version"),
            OsString::from("26.901.6511.0"),
            OsString::from("--eval"),
            OsString::from("1+1"),
        ],
        vec![
            OsString::from("--experimental-isolated-client"),
            OsString::from("--root"),
            root.clone().into_os_string(),
            OsString::from("--expected-package-version"),
            OsString::from("0.0.0.0"),
        ],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_codlet-lab"))
            .args(arguments)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(!root.exists());
        assert!(output.stdout.is_empty());
    }
}
