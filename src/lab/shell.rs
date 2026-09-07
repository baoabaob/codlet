use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::io::{self, Read};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::{LAB_SHELL, LabError, require_absent_profiles};
use crate::windows::environment::ChildEnvironment;

pub(super) const SYSTEM_MODULES: &str = r"C:\Windows\System32\WindowsPowerShell\v1.0\Modules";
const OUTPUT_LIMIT: u64 = 64 * 1024;
const PROFILE_BUDGET: Duration = Duration::from_secs(10);
const ENVIRONMENT_BUDGET: Duration = Duration::from_secs(5);
const DELIMITER: &str = "_SHELL_ENV_DELIMITER_";
// The same command and interactive argument shape used by the audited Desktop.
const ENVIRONMENT_COMMAND: &str = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output '_SHELL_ENV_DELIMITER_'; Get-ChildItem Env: | ForEach-Object { '{0}={1}' -f $_.Name, $_.Value }; Write-Output '_SHELL_ENV_DELIMITER_'";
const PROFILE_COMMAND: &str = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @($PROFILE.AllUsersAllHosts, $PROFILE.AllUsersCurrentHost, $PROFILE.CurrentUserAllHosts, $PROFILE.CurrentUserCurrentHost) | ConvertTo-Json -Compress";

#[derive(Serialize)]
pub(super) struct ShellCheck {
    pub profiles_checked_absent: Vec<PathBuf>,
    pub environment_elapsed_ms: u128,
    pub critical_environment_verified: bool,
}

pub(super) fn check(environment: &ChildEnvironment, cwd: &Path) -> Result<ShellCheck, LabError> {
    let (output, _) = run(
        environment,
        cwd,
        &["-NoProfile", "-NonInteractive", "-Command", PROFILE_COMMAND],
        PROFILE_BUDGET,
    )?;
    let profiles: Vec<PathBuf> = serde_json::from_slice(&output)
        .map_err(|_| LabError::Preflight("invalid shell profile-path report".into()))?;
    require_absent_profiles(&profiles)?;

    let mut probe_environment = environment.clone();
    for (key, value) in [
        ("DISABLE_AUTO_UPDATE", "true"),
        ("ZSH_TMUX_AUTOSTARTED", "true"),
        ("ZSH_TMUX_AUTOSTART", "false"),
        ("CODEX_SHELL", "1"),
    ] {
        probe_environment.set(OsStr::new(key), OsStr::new(value))?;
    }
    let (output, elapsed) = run(
        &probe_environment,
        cwd,
        &["-NoLogo", "-Command", ENVIRONMENT_COMMAND],
        ENVIRONMENT_BUDGET,
    )?;
    verify_environment(&output, environment)?;
    require_absent_profiles(&profiles)?;
    Ok(ShellCheck {
        profiles_checked_absent: profiles,
        environment_elapsed_ms: elapsed.as_millis(),
        critical_environment_verified: true,
    })
}

fn run(
    environment: &ChildEnvironment,
    cwd: &Path,
    arguments: &[&str],
    budget: Duration,
) -> Result<(Vec<u8>, Duration), LabError> {
    let started = Instant::now();
    let mut child = Command::new(LAB_SHELL)
        .env_clear()
        .envs(environment.entries_os())
        .env("PSModulePath", SYSTEM_MODULES)
        .current_dir(cwd)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
        .spawn()?;
    let stdout = child.stdout.take().expect("piped shell stdout");
    let stderr = child.stderr.take().expect("piped shell stderr");
    let stdout = std::thread::spawn(move || read_bounded(stdout));
    let stderr = std::thread::spawn(move || read_bounded(stderr));
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started.elapsed() < budget => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                timed_out = true;
                // This handle belongs only to the read-only PowerShell probe we spawned.
                let _ = child.kill();
                break child.wait();
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(error);
            }
        }
    };
    let output = stdout
        .join()
        .map_err(|_| LabError::Preflight("shell output reader failed".into()))??;
    let errors = stderr
        .join()
        .map_err(|_| LabError::Preflight("shell error reader failed".into()))??;
    if timed_out {
        return Err(LabError::Preflight(format!(
            "fixed shell probe exceeded {}ms; its child was stopped",
            budget.as_millis()
        )));
    }
    if !status?.success() || !errors.is_empty() {
        return Err(LabError::Preflight(
            "fixed shell probe failed; no environment values are logged".into(),
        ));
    }
    Ok((output, started.elapsed()))
}

fn read_bounded(reader: impl Read) -> io::Result<Vec<u8>> {
    let mut output = Vec::new();
    reader.take(OUTPUT_LIMIT + 1).read_to_end(&mut output)?;
    if output.len() as u64 > OUTPUT_LIMIT {
        return Err(io::Error::other("shell output limit exceeded"));
    }
    Ok(output)
}

fn verify_environment(output: &[u8], expected: &ChildEnvironment) -> Result<(), LabError> {
    let output = std::str::from_utf8(output)
        .map_err(|_| LabError::Preflight("shell environment output is not UTF-8".into()))?;
    let pieces: Vec<_> = output.split(DELIMITER).collect();
    if pieces.len() != 3
        || !pieces[0]
            .trim_matches(['\u{feff}', '\r', '\n', ' '])
            .is_empty()
        || !pieces[2].trim().is_empty()
    {
        return Err(LabError::Preflight(
            "shell environment delimiters are invalid".into(),
        ));
    }
    let mut actual = BTreeMap::new();
    for line in pieces[1].lines().filter(|line| !line.is_empty()) {
        let (key, value) = line
            .split_once('=')
            .ok_or_else(|| LabError::Preflight("shell environment line is invalid".into()))?;
        if actual.insert(key.to_ascii_uppercase(), value).is_some() {
            return Err(LabError::Preflight(
                "duplicate shell environment key".into(),
            ));
        }
    }
    for (key, value) in expected.entries_os() {
        let key = key.to_string_lossy().to_ascii_uppercase();
        if matches!(key.as_str(), "PATH" | "PATHEXT" | "PSMODULEPATH") {
            continue; // Shell runtime normalization of search paths is not a lab routing value.
        }
        if actual.get(&key).copied() != value.to_str() {
            return Err(LabError::Preflight(format!(
                "fixed shell changed required environment key {key}"
            )));
        }
    }
    for key in actual.keys() {
        if matches!(
            key.as_str(),
            "OPENAI_API_KEY"
                | "CODEX_API_KEY"
                | "CODEX_ACCESS_TOKEN"
                | "CODEX_APP_SERVER_FORCE_CLI"
                | "CODEX_APP_TOOLS_PIPE_PATH"
                | "NODE_OPTIONS"
        ) || key.starts_with("SKY_CUA_")
            || key.starts_with("NODE_REPL_")
        {
            return Err(LabError::Preflight(format!(
                "unexpected shell environment key {key}"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_report_rejects_changed_routes_duplicates_and_truncated_output() {
        let expected = ChildEnvironment::from_entries(
            [
                ("CODEX_HOME", "C:\\测试\\home"),
                ("CODEX_APP_SERVER_WS_URL", "ws://127.0.0.1:49001"),
            ]
            .map(|(key, value)| (key.into(), value.into())),
        )
        .unwrap();
        let report = format!(
            "{DELIMITER}\r\nCODEX_HOME=C:\\测试\\home\r\nCODEX_APP_SERVER_WS_URL=ws://127.0.0.1:49001\r\n{DELIMITER}\r\n"
        );
        verify_environment(report.as_bytes(), &expected).unwrap();
        for bad in [
            report.replace("49001", "49002"),
            report.replace("CODEX_HOME=", "codex_home=C:\\other\r\nCODEX_HOME="),
            report.trim_end().trim_end_matches(DELIMITER).to_owned(),
            report.replace("CODEX_HOME=", "CODEX_ACCESS_TOKEN=fixture\r\nCODEX_HOME="),
        ] {
            assert!(verify_environment(bad.as_bytes(), &expected).is_err());
        }
    }
}
