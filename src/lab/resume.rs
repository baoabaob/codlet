use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Component, Path};

use serde::Serialize;
use serde_json::Value;
use windows_sys::Win32::Foundation::{
    ERROR_INVALID_PARAMETER, FILETIME, GetLastError, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    GetFileInformationByHandle,
};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    WaitForSingleObject,
};

use super::{LabError, pin_plain_directory, validate_root_path};

#[derive(Debug, Serialize)]
pub(super) struct ResumeEvidence {
    pub previous_host_pid: u32,
    pub previous_child_pid: Option<u32>,
    pub previous_child_created: Option<u64>,
    pub previous_package_version: String,
    pub package_upgraded: bool,
}

impl ResumeEvidence {
    pub fn verify(
        root: &Path,
        report: &Path,
        package: &str,
        version: &str,
    ) -> Result<Self, LabError> {
        let logs = root.join("logs");
        let relative = report
            .strip_prefix(&logs)
            .map_err(|_| blocked("resume report must be inside this lab's logs"))?;
        let parts: Vec<_> = relative.components().collect();
        let valid = match parts.as_slice() {
            [Component::Normal(file)] => *file == "report.jsonl",
            [Component::Normal(directory), Component::Normal(file)] => {
                directory
                    .to_str()
                    .is_some_and(|name| name.starts_with("run-"))
                    && *file == "report.jsonl"
            }
            _ => false,
        };
        if !valid {
            return Err(blocked("resume requires an original lab run report"));
        }
        let parent = report
            .parent()
            .ok_or_else(|| blocked("resume report has no parent"))?;
        validate_root_path(parent)?;
        let _logs_pin = pin_plain_directory(&logs)?;
        let _parent_pin = pin_plain_directory(parent)?;
        let report_file = open_plain(report, false)?;
        let created = report_file.metadata()?.creation_time();
        let mut candidates = vec![logs.join("report.jsonl")];
        let mut candidate_pins = Vec::new();
        for (index, entry) in fs::read_dir(&logs)?.enumerate() {
            if index >= 256 {
                return Err(blocked("too many lab log entries to verify resume"));
            }
            let entry = entry?;
            if entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with("run-"))
            {
                candidate_pins.push(pin_plain_directory(&entry.path())?);
                candidates.push(entry.path().join("report.jsonl"));
            }
        }
        for candidate in candidates {
            if candidate == report || !candidate.try_exists()? {
                continue;
            }
            if open_plain(&candidate, false)?.metadata()?.creation_time() >= created {
                return Err(blocked(
                    "resume must use the latest run report; a later or ambiguous run exists",
                ));
            }
        }
        let bytes = bounded_bytes(report_file, 4 * 1024 * 1024)?;
        let evidence = Self::parse(&bytes, root, package, version)?;
        if let (Some(pid), Some(created)) =
            (evidence.previous_child_pid, evidence.previous_child_created)
            && child_still_running(pid, created)?
        {
            return Err(blocked("the recorded Desktop is still running"));
        }
        Ok(evidence)
    }

    fn parse(bytes: &[u8], root: &Path, package: &str, version: &str) -> Result<Self, LabError> {
        let text = std::str::from_utf8(bytes).map_err(|_| blocked("resume report is not UTF-8"))?;
        if !text.ends_with('\n') {
            return Err(blocked("resume report has an incomplete final record"));
        }
        let mut host = None;
        let mut child = None;
        let mut exited = false;
        let mut reaped = false;
        let mut header = false;
        let mut no_child = false;
        let mut plugin_cleanup = None;
        let mut previous_package: Option<(String, String)> = None;
        for line in text.lines() {
            let row: Value = serde_json::from_str(line)
                .map_err(|_| blocked("resume report contains invalid JSON"))?;
            let row_host = row
                .get("host_pid")
                .and_then(Value::as_u64)
                .and_then(|pid| u32::try_from(pid).ok())
                .filter(|pid| *pid != 0)
                .ok_or_else(|| blocked("resume report has no valid Host identity"))?;
            if row["schema_version"] != 1 || host.is_some_and(|host| host != row_host) {
                return Err(blocked("resume report mixes schemas or Host identities"));
            }
            host = Some(row_host);
            let detail = &row["detail"];
            match row["event"].as_str() {
                Some("lab_opened" | "prepared") => {
                    let old_package = detail["package_full_name"].as_str().unwrap_or("");
                    let old_version = detail["package_version"].as_str().unwrap_or("");
                    if detail["root"]
                        .as_str()
                        .is_none_or(|value| Path::new(value) != root)
                        || !compatible_package(old_package, old_version, package, version)
                        || previous_package.as_ref().is_some_and(|(name, version)| {
                            name != old_package || version != old_version
                        })
                        || detail["experimental"] != true
                    {
                        return Err(blocked(
                            "resume report does not describe this lab and package",
                        ));
                    }
                    previous_package = Some((old_package.to_owned(), old_version.to_owned()));
                    header = true;
                }
                Some("child_created") => {
                    let pid = row["child_pid"]
                        .as_u64()
                        .and_then(|pid| u32::try_from(pid).ok())
                        .filter(|pid| *pid != 0);
                    let created = detail["creation_time_windows_100ns"]
                        .as_u64()
                        .filter(|time| *time != 0);
                    if child.is_some() || pid.is_none() || created.is_none() {
                        return Err(blocked("resume report has an invalid Desktop identity"));
                    }
                    child = Some((pid.unwrap(), created.unwrap()));
                }
                Some("child_exited") => {
                    exited = child.is_some_and(|(pid, _)| row["child_pid"] == pid)
                        && detail["exit_code"] == 0;
                }
                Some("cdp_workers_reaped") => reaped = exited,
                Some("plugin_runtime_stopped") => plugin_cleanup = Some(detail["clean"] == true),
                Some("no_child_created") => no_child = child.is_none(),
                _ => {}
            }
        }
        if !header
            || plugin_cleanup == Some(false)
            || !((child.is_some() && exited && reaped) || (child.is_none() && no_child))
        {
            return Err(blocked(
                "resume requires a closed run or a recorded preparation-only exit",
            ));
        }
        Ok(Self {
            previous_host_pid: host.ok_or_else(|| blocked("empty resume report"))?,
            previous_child_pid: child.map(|value| value.0),
            previous_child_created: child.map(|value| value.1),
            previous_package_version: previous_package
                .as_ref()
                .expect("header was checked")
                .1
                .clone(),
            package_upgraded: previous_package
                .as_ref()
                .is_some_and(|(_, previous)| previous != version),
        })
    }
}

fn compatible_package(
    previous: &str,
    previous_version: &str,
    current: &str,
    current_version: &str,
) -> bool {
    (previous == current && previous_version == current_version)
        || (previous == "OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0"
            && previous_version == "26.901.6511.0"
            && current == "OpenAI.Codex_26.903.8094.0_x64__2p2nqsd0c76g0"
            && current_version == super::AUDITED_PACKAGE_VERSION)
}

pub(super) fn open_plain(path: &Path, write: bool) -> Result<File, LabError> {
    let file = OpenOptions::new()
        .read(true)
        .write(write)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    check_file(&file)?;
    Ok(file)
}

pub(super) fn bounded_bytes(mut file: File, limit: u64) -> Result<Vec<u8>, LabError> {
    if file.metadata()?.len() > limit {
        return Err(blocked("lab resume evidence/configuration is oversized"));
    }
    let mut bytes = Vec::new();
    (&mut file).take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(blocked("lab resume file grew beyond its limit"));
    }
    Ok(bytes)
}

/// Inspect identity/attributes only; never read authentication bytes or hold a
/// handle that prevents the official backend from refreshing its own credentials.
pub(super) fn check_optional_auth(path: &Path) -> Result<(), LabError> {
    let file = match OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    check_file(&file)
}

pub(super) fn check_file(file: &File) -> Result<(), LabError> {
    let metadata = file.metadata()?;
    let mut identity = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut identity) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if !metadata.is_file()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || identity.nNumberOfLinks != 1
    {
        return Err(blocked("lab resume file is linked or is not a plain file"));
    }
    Ok(())
}

fn child_still_running(pid: u32, created: u64) -> Result<bool, LabError> {
    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if handle.is_null() {
        if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER {
            return Ok(false);
        }
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: OpenProcess returned this independently owned, read-only handle.
    let handle = unsafe { OwnedHandle::from_raw_handle(handle.cast()) };
    match unsafe { WaitForSingleObject(handle.as_raw_handle().cast(), 0) } {
        WAIT_OBJECT_0 => return Ok(false),
        WAIT_TIMEOUT => {}
        _ => return Err(std::io::Error::last_os_error().into()),
    }
    let mut times = [FILETIME::default(); 4];
    let [birth, exit, kernel, user] = &mut times;
    if unsafe { GetProcessTimes(handle.as_raw_handle().cast(), birth, exit, kernel, user) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok((u64::from(birth.dwHighDateTime) << 32 | u64::from(birth.dwLowDateTime)) == created)
}

fn blocked(message: &str) -> LabError {
    LabError::Preflight(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn report(root: &Path, closed: bool) -> Vec<u8> {
        let mut rows = vec![
            json!({"schema_version":1,"host_pid":9,"event":"prepared","detail":{
                "root":root,"package_full_name":"fixture","package_version":"1","experimental":true
            }}),
            json!({"schema_version":1,"host_pid":9,"child_pid":10,"event":"child_created","detail":{"creation_time_windows_100ns":1}}),
        ];
        if closed {
            rows.push(json!({"schema_version":1,"host_pid":9,"child_pid":10,"event":"child_exited","detail":{"exit_code":0}}));
            rows.push(json!({"schema_version":1,"host_pid":9,"child_pid":10,"event":"cdp_workers_reaped","detail":{}}));
        }
        rows.into_iter()
            .map(|row| format!("{row}\n"))
            .collect::<String>()
            .into_bytes()
    }

    #[test]
    fn receipt_requires_matching_root_package_and_completed_process_lifecycle() {
        let root = Path::new("C:/lab-fixture");
        ResumeEvidence::parse(&report(root, true), root, "fixture", "1").unwrap();
        assert!(ResumeEvidence::parse(&report(root, false), root, "fixture", "1").is_err());
        assert!(
            ResumeEvidence::parse(&report(root, true), Path::new("C:/other"), "fixture", "1")
                .is_err()
        );
        assert!(ResumeEvidence::parse(&report(root, true), root, "different", "1").is_err());
        let mut partial = report(root, true);
        partial.pop();
        assert!(ResumeEvidence::parse(&partial, root, "fixture", "1").is_err());
    }

    #[test]
    fn reviewed_upgrade_still_requires_a_closed_matching_profile() {
        let root = Path::new("C:/lab-fixture");
        let old = "OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0";
        let current = "OpenAI.Codex_26.903.8094.0_x64__2p2nqsd0c76g0";
        let upgraded_report = |closed| {
            String::from_utf8(report(root, closed))
                .unwrap()
                .replace("\"fixture\"", &format!("\"{old}\""))
                .replace(
                    "\"package_version\":\"1\"",
                    "\"package_version\":\"26.901.6511.0\"",
                )
        };
        let receipt = ResumeEvidence::parse(
            upgraded_report(true).as_bytes(),
            root,
            current,
            super::super::AUDITED_PACKAGE_VERSION,
        )
        .unwrap();
        assert!(receipt.package_upgraded);
        assert_eq!(receipt.previous_package_version, "26.901.6511.0");
        assert!(
            ResumeEvidence::parse(
                upgraded_report(false).as_bytes(),
                root,
                current,
                super::super::AUDITED_PACKAGE_VERSION
            )
            .is_err()
        );
        assert!(
            ResumeEvidence::parse(
                upgraded_report(true).as_bytes(),
                root,
                current,
                "26.903.8095.0"
            )
            .is_err()
        );
        assert!(
            ResumeEvidence::parse(
                upgraded_report(true)
                    .replace("26.901.6511", "26.901.6512")
                    .as_bytes(),
                root,
                current,
                super::super::AUDITED_PACKAGE_VERSION
            )
            .is_err()
        );
    }

    #[test]
    fn live_process_check_uses_both_pid_and_creation_time() {
        use windows_sys::Win32::System::Threading::GetCurrentProcess;
        let mut times = [FILETIME::default(); 4];
        let [birth, exit, kernel, user] = &mut times;
        assert_ne!(
            unsafe { GetProcessTimes(GetCurrentProcess(), birth, exit, kernel, user) },
            0
        );
        let created = u64::from(birth.dwHighDateTime) << 32 | u64::from(birth.dwLowDateTime);
        assert!(child_still_running(std::process::id(), created).unwrap());
        assert!(!child_still_running(std::process::id(), created - 1).unwrap());
    }

    #[test]
    fn metadata_check_rejects_credential_links_without_parsing_content() {
        let root = tempfile::tempdir().unwrap();
        let original = root.path().join("original");
        fs::write(&original, [0xff, 0xfe, 0, 1]).unwrap();
        check_optional_auth(&original).unwrap();
        let link = root.path().join("auth.json");
        fs::hard_link(&original, &link).unwrap();
        assert!(check_optional_auth(&link).is_err());
    }
}
