use std::fs::{self, OpenOptions};
use std::io::Read;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE,
};

const STARTUP_BUDGET: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(250);
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_ENTRIES: usize = 128;
const MAX_LOGS: usize = 8;

#[derive(Default, Debug, Clone, Serialize)]
pub(super) struct Evidence {
    pub development_environment: bool,
    pub development_launch_with_updates_disabled: bool,
    pub websocket_transport: bool,
    pub initialized_websocket: bool,
    pub shell_environment_loaded: bool,
}

impl Evidence {
    pub fn complete(&self) -> bool {
        self.development_environment
            && self.development_launch_with_updates_disabled
            && self.websocket_transport
            && self.initialized_websocket
            && self.shell_environment_loaded
    }

    fn observe(&mut self, line: &str) -> Result<(), &'static str> {
        let Some((timestamp, line)) = line.split_once(' ') else {
            return Ok(());
        };
        if !timestamp.ends_with('Z') || !timestamp.contains('T') {
            return Ok(());
        }
        let Some((level, message)) = line.split_once(' ') else {
            return Ok(());
        };
        if level == "warning" && message.starts_with("Failed to load shell env ") {
            return Err("shell_environment_failed");
        }
        if level == "info" {
            if message.starts_with("[build-flavor] Resolved build flavor from env ") {
                if field(message, "value") != Some("dev") {
                    return Err("unexpected_build_flavor");
                }
                self.development_environment = true;
            } else if message.starts_with("Launching app ") {
                if field(message, "buildFlavor") != Some("dev")
                    || field(message, "enableSparkle") != Some("false")
                    || field(message, "enableUpdater") != Some("false")
                {
                    return Err("unexpected_launch_policy");
                }
                self.development_launch_with_updates_disabled = true;
            } else if message.starts_with("[AppServerConnection] Starting app-server connection ")
                && field(message, "hostId") == Some("local")
            {
                if field(message, "transport") != Some("websocket") {
                    return Err("unexpected_local_transport");
                }
                self.websocket_transport = true;
            } else if message.starts_with("[AppServerConnection] initialize_handshake_result ") {
                if field(message, "outcome") != Some("success")
                    || field(message, "transportKind") != Some("websocket")
                {
                    return Err("websocket_initialize_failed");
                }
                self.initialized_websocket = true;
            }
        } else if level == "trace"
            && let Some(message) = message.strip_prefix("[startup] [")
            && let Some((_, message)) = message.split_once("] ")
            && message.starts_with("shell environment hydrated ")
        {
            if field(message, "status") != Some("loaded") {
                return Err("shell_environment_not_loaded");
            }
            self.shell_environment_loaded = true;
        }
        Ok(())
    }
}

fn field<'a>(message: &'a str, name: &str) -> Option<&'a str> {
    message.split_ascii_whitespace().find_map(|token| {
        let (key, value) = token.split_once('=')?;
        (key == name).then_some(value)
    })
}

pub(super) struct StartupCheck {
    directory: PathBuf,
    process_id: u32,
    started: Instant,
    next_poll: Instant,
    pub evidence: Evidence,
}

impl StartupCheck {
    pub fn new(directory: PathBuf, process_id: u32) -> Self {
        Self {
            directory,
            process_id,
            started: Instant::now(),
            next_poll: Instant::now(),
            evidence: Evidence::default(),
        }
    }

    pub fn elapsed_ms(&self) -> u128 {
        self.started.elapsed().as_millis()
    }

    /// Reads only this newly created PID's main-process log in the fresh root.
    /// No log text or environment values are emitted in the report.
    pub fn poll(&mut self) -> Result<bool, &'static str> {
        if self.started.elapsed() >= STARTUP_BUDGET {
            return Err("startup_evidence_timed_out");
        }
        if Instant::now() < self.next_poll {
            return Ok(false);
        }
        self.next_poll = Instant::now() + POLL_INTERVAL;
        self.evidence = read_evidence(&self.directory, self.process_id)?;
        Ok(self.evidence.complete())
    }
}

fn read_evidence(directory: &Path, process_id: u32) -> Result<Evidence, &'static str> {
    let mut files = Vec::new();
    find_logs(directory, 0, process_id, &mut files)?;
    files.sort();
    let mut evidence = Evidence::default();
    for path in files {
        let file = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|_| "startup_log_unreadable")?;
        let metadata = file.metadata().map_err(|_| "startup_log_unreadable")?;
        if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("startup_log_not_plain_file");
        }
        let mut bytes = Vec::new();
        file.take(MAX_LOG_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "startup_log_unreadable")?;
        if bytes.len() as u64 > MAX_LOG_BYTES {
            return Err("startup_log_limit_exceeded");
        }
        // In-flight writes may end mid-line or mid-character. Only complete lines count.
        let complete_length = bytes
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map_or(0, |index| index + 1);
        let text =
            std::str::from_utf8(&bytes[..complete_length]).map_err(|_| "startup_log_not_utf8")?;
        for line in text.lines() {
            evidence.observe(line)?;
        }
    }
    Ok(evidence)
}

fn find_logs(
    directory: &Path,
    depth: usize,
    process_id: u32,
    files: &mut Vec<PathBuf>,
) -> Result<(), &'static str> {
    let metadata =
        fs::symlink_metadata(directory).map_err(|_| "startup_log_directory_unreadable")?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("startup_log_directory_not_plain");
    }
    let entries = fs::read_dir(directory).map_err(|_| "startup_log_directory_unreadable")?;
    for (index, entry) in entries.enumerate() {
        if index >= MAX_ENTRIES {
            return Err("startup_log_entry_limit_exceeded");
        }
        let entry = entry.map_err(|_| "startup_log_directory_unreadable")?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if depth < 3 {
            let expected_length = if depth == 0 { 4 } else { 2 };
            if name.len() == expected_length && name.bytes().all(|byte| byte.is_ascii_digit()) {
                find_logs(&entry.path(), depth + 1, process_id, files)?;
            }
        } else if name.starts_with("codex-desktop-")
            && name.contains(&format!("-{process_id}-t0-"))
            && name.ends_with(".log")
        {
            if files.len() >= MAX_LOGS {
                return Err("startup_log_file_limit_exceeded");
            }
            files.push(entry.path());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn successful_lines() -> String {
        [
            "info [build-flavor] Resolved build flavor from env value=dev",
            "info Launching app buildFlavor=dev enableSparkle=false enableUpdater=false",
            "info [AppServerConnection] Starting app-server connection hostId=local transport=websocket",
            "info [AppServerConnection] initialize_handshake_result outcome=success transportKind=websocket",
            "trace [startup] [0.400] shell environment hydrated background=true status=loaded",
        ].map(|line| format!("2026-09-08T00:00:00.000Z {line}\n")).join("")
    }

    #[test]
    fn runtime_gate_requires_actual_shell_success_and_rejects_timeout_or_stdio() {
        let lines = successful_lines();
        let mut evidence = Evidence::default();
        for line in lines.lines().take(4) {
            evidence.observe(line).unwrap();
        }
        assert!(!evidence.complete());
        evidence.observe(lines.lines().last().unwrap()).unwrap();
        assert!(evidence.complete());
        assert_eq!(
            Evidence::default().observe(
                "2026-09-08T00:00:00.000Z warning Failed to load shell env status=timed_out"
            ),
            Err("shell_environment_failed")
        );
        assert_eq!(Evidence::default().observe("2026-09-08T00:00:00.000Z trace [startup] [6.0] shell environment hydrated status=timed_out"), Err("shell_environment_not_loaded"));
        assert_eq!(Evidence::default().observe("2026-09-08T00:00:00.000Z info [AppServerConnection] Starting app-server connection hostId=local transport=stdio"), Err("unexpected_local_transport"));
    }

    #[test]
    fn gate_ignores_other_pids_and_partial_lines_in_open_logs() {
        use std::io::Write;
        let root = tempfile::tempdir().unwrap();
        let day = root.path().join("2026/09/08");
        fs::create_dir_all(&day).unwrap();
        let lines = successful_lines();
        fs::write(day.join("codex-desktop-fixture-22-t0-i1.log"), &lines).unwrap();
        assert!(!read_evidence(root.path(), 11).unwrap().complete());
        let mut own = fs::File::create(day.join("codex-desktop-fixture-11-t0-i1.log")).unwrap();
        own.write_all(lines.trim_end().as_bytes()).unwrap();
        own.flush().unwrap();
        assert!(!read_evidence(root.path(), 11).unwrap().complete());
        own.write_all(b"\n").unwrap();
        own.flush().unwrap();
        assert!(read_evidence(root.path(), 11).unwrap().complete());
    }

    #[test]
    fn gate_rejects_linked_log_directories_and_missing_evidence_deadline() {
        let root = tempfile::tempdir().unwrap();
        let linked = tempfile::tempdir().unwrap();
        std::os::windows::fs::symlink_dir(linked.path(), root.path().join("2026")).unwrap();
        assert_eq!(
            read_evidence(root.path(), 11).unwrap_err(),
            "startup_log_directory_not_plain"
        );
        let mut check = StartupCheck::new(linked.path().to_owned(), 11);
        check.started = Instant::now() - STARTUP_BUDGET;
        assert_eq!(check.poll(), Err("startup_evidence_timed_out"));
    }
}
