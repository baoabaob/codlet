//! The isolated launcher's restart contract contains only its fixed local files
//! and processes. Renderer RPC cannot supply any of these values.
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

use serde_json::Value;
use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::runtime_update::{
    RuntimeConfigPin, RuntimePayloadProfile, RuntimeProcessIdentity, RuntimeRestartCommand,
    RuntimeRestartContext,
};
use crate::windows::process::ChildProcess;

pub(super) fn restart_context(
    install: &Path,
    lab_root: &Path,
    child: &ChildProcess,
) -> Option<RuntimeRestartContext> {
    let config_path = install.join("lab-config.json");
    let config = read_config(&config_path)?;
    if config["schema"] != 1
        || config["labBinary"] != "codlet-lab.exe"
        || std::fs::canonicalize(config["labRoot"].as_str()?).ok()?
            != std::fs::canonicalize(lab_root).ok()?
    {
        return None;
    }
    let expected_pid: u32 = std::env::var("CODLET_UPDATE_OWNER_PID")
        .ok()?
        .parse()
        .ok()?;
    let expected_creation = std::env::var("CODLET_UPDATE_OWNER_CREATED").ok()?;
    let parent = parent_identity()?;
    if parent.pid != expected_pid || parent.creation_time != expected_creation {
        return None;
    }
    let launcher_files = [
        "Restart-TestClient.ps1",
        "Start-TestClient.ps1",
        "isolated-client.mjs",
    ]
    .map(|file| install.join(file))
    .to_vec();
    if launcher_files.iter().any(|path| !path.is_file()) {
        return None;
    }
    Some(RuntimeRestartContext {
        profile: RuntimePayloadProfile::IsolatedClient,
        command: RuntimeRestartCommand {
            program: super::LAB_SHELL.into(),
            args: vec![
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-File".into(),
                install.join("Restart-TestClient.ps1").to_str()?.into(),
            ],
            working_directory: install.to_owned(),
            environment: BTreeMap::new(),
            timeout_seconds: 150,
        },
        wait_for: vec![
            parent,
            RuntimeProcessIdentity {
                pid: child.process_id(),
                creation_time: child.creation_time_filetime().ok()?.to_string(),
            },
        ],
        launcher_files,
        config_pin: Some(RuntimeConfigPin { path: config_path }),
    })
}

fn read_config(path: &Path) -> Option<Value> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || metadata.len() > 65536
    {
        return None;
    }
    let mut bytes = Vec::new();
    File::take(file, 65537).read_to_end(&mut bytes).ok()?;
    if bytes.len() > 65536 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn parent_identity() -> Option<RuntimeProcessIdentity> {
    // SAFETY: initialized ToolHelp structure and process handles are closed on
    // every branch. Only identity queries are made; no other process is changed.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..std::mem::zeroed()
        };
        let mut found = Process32FirstW(snapshot, &mut entry);
        let mut parent = None;
        while found != 0 {
            if entry.th32ProcessID == std::process::id() {
                parent = Some(entry.th32ParentProcessID);
                break;
            }
            found = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        let pid = parent?;
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut creation: FILETIME = std::mem::zeroed();
        let mut exit: FILETIME = std::mem::zeroed();
        let mut kernel: FILETIME = std::mem::zeroed();
        let mut user: FILETIME = std::mem::zeroed();
        let ok = GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user);
        CloseHandle(handle);
        (ok != 0).then(|| RuntimeProcessIdentity {
            pid,
            creation_time: ((u64::from(creation.dwHighDateTime) << 32)
                | u64::from(creation.dwLowDateTime))
            .to_string(),
        })
    }
}
