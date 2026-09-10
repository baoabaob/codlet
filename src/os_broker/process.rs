use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};
use windows_sys::Win32::Foundation::{ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_PIPE_NOT_CONNECTED};
use windows_sys::Win32::System::Threading::SetEvent;

use super::{CHECK_INTERVAL, OsBrokerError, RequestGuard, Result, byte_limit, decode, invalid};
use crate::windows::local_ipc::{Channel, LocalIpcError, raw};
use crate::windows::plugin_process::{OwnedPluginProcess, PluginStdio};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Run {
    executable: PathBuf,
    args: Vec<String>,
    max_output_bytes: Option<usize>,
}

pub(super) fn run(params: Value, guard: &RequestGuard) -> Result<Value> {
    let request: Run = decode(params)?;
    let limit = byte_limit(request.max_output_bytes)?;
    crate::plugin_permissions::validate_policy_path(&request.executable)
        .map_err(|error| invalid(error.to_string()))?;
    if request.args.len() > 64
        || request
            .args
            .iter()
            .any(|argument| argument.len() > 8192 || argument.contains('\0'))
        || request.args.iter().map(String::len).sum::<usize>() > 64 * 1024
    {
        return Err(invalid(
            "process args must be at most 64 bounded strings without NUL",
        ));
    }
    let executable_guard = super::filesystem::pin_exact_grant(
        &request.executable,
        &guard.authorization.0.registration.broker_policy.executables,
    )?;
    let executable = &executable_guard.path;
    let cwd = &guard.authorization.0.registration.path;
    let cwd_guard = super::filesystem::pin_exact_grant(cwd, std::slice::from_ref(cwd))?;
    guard.check_full()?;
    let environment: Vec<(OsString, OsString)> = ["SystemRoot", "WINDIR", "TEMP", "TMP"]
        .into_iter()
        .filter_map(|key| std::env::var_os(key).map(|value| (OsString::from(key), value)))
        .collect();
    let (child, stdio) =
        OwnedPluginProcess::spawn(executable, &request.args, cwd, Some(&environment))
            .map_err(|error| OsBrokerError::new("process_start_failed", error.to_string()))?;
    let pid = child.pid();
    let PluginStdio {
        stdin,
        stdout,
        stderr,
        stop,
    } = stdio;
    drop(stdin); // This endpoint has no interactive stdin and never invokes a shell.
    let mut output = Vec::new();
    let mut errors = Vec::new();
    let mut stdout_closed = false;
    let mut stderr_closed = false;
    let execution = 'execution: loop {
        if let Err(error) = guard.check() {
            break Err(error);
        }
        if let Err(error) = read_available(&stdout, &mut output, &mut stdout_closed, limit)
            .and_then(|()| read_available(&stderr, &mut errors, &mut stderr_closed, limit))
        {
            break Err(error);
        }
        if output.len() + errors.len() > limit {
            break Err(OsBrokerError::new(
                "response_too_large",
                "combined process output exceeds its byte limit",
            ));
        }
        match child.wait(Duration::ZERO) {
            Ok(Some(code)) => {
                if child.job_is_empty().unwrap_or(false) && stdout_closed && stderr_closed {
                    break Ok(code);
                }
                // The executable has returned; descendants may not keep a run
                // receipt or its stdio alive after their parent's lifetime.
                if let Err(error) = child.terminate() {
                    break Err(OsBrokerError::new("cleanup_incomplete", error.to_string()));
                }
                let drain = Instant::now() + Duration::from_millis(100);
                while Instant::now() < drain && (!stdout_closed || !stderr_closed) {
                    if let Err(error) =
                        read_available(&stdout, &mut output, &mut stdout_closed, limit).and_then(
                            |()| read_available(&stderr, &mut errors, &mut stderr_closed, limit),
                        )
                    {
                        break 'execution Err(error);
                    }
                    if output.len() + errors.len() > limit {
                        break 'execution Err(OsBrokerError::new(
                            "response_too_large",
                            "combined process output exceeds its byte limit",
                        ));
                    }
                }
                break Ok(code);
            }
            Ok(None) => {}
            Err(error) => break Err(OsBrokerError::new("process_error", error.to_string())),
        }
    };
    let cleanup = retire(&child, &stop);
    drop(stdout);
    drop(stderr);
    drop(executable_guard);
    drop(cwd_guard);
    cleanup?;
    let code = execution?;
    let stdout = String::from_utf8(output)
        .map_err(|_| OsBrokerError::new("invalid_utf8", "process stdout is not UTF-8"))?;
    let stderr = String::from_utf8(errors)
        .map_err(|_| OsBrokerError::new("invalid_utf8", "process stderr is not UTF-8"))?;
    Ok(
        json!({"processId":pid,"exitCode":code,"stdoutBytes":stdout.len(),"stderrBytes":stderr.len(),"stdout":stdout,"stderr":stderr,"jobReaped":true}),
    )
}

fn read_available(
    channel: &Channel,
    bytes: &mut Vec<u8>,
    closed: &mut bool,
    limit: usize,
) -> Result<()> {
    if *closed {
        return Ok(());
    }
    let mut buffer = [0; 8192];
    match channel.read_some(&mut buffer, Some(Instant::now() + CHECK_INTERVAL)) {
        Ok(0) => *closed = true,
        Ok(count) => {
            if bytes.len() + count > limit {
                return Err(OsBrokerError::new(
                    "response_too_large",
                    "process output exceeds its byte limit",
                ));
            }
            bytes.extend_from_slice(&buffer[..count]);
        }
        Err(LocalIpcError::Timeout) => {}
        Err(LocalIpcError::Win32 {
            code: ERROR_BROKEN_PIPE | ERROR_NO_DATA | ERROR_PIPE_NOT_CONNECTED,
            ..
        }) => *closed = true,
        Err(error) => return Err(OsBrokerError::new("process_io_error", error.to_string())),
    }
    Ok(())
}

fn retire(child: &OwnedPluginProcess, stop: &Arc<std::os::windows::io::OwnedHandle>) -> Result<()> {
    unsafe {
        SetEvent(raw(stop));
    }
    if !child
        .job_is_empty()
        .map_err(|error| OsBrokerError::new("cleanup_incomplete", error.to_string()))?
    {
        child
            .terminate()
            .map_err(|error| OsBrokerError::new("cleanup_incomplete", error.to_string()))?;
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if child
            .wait(Duration::ZERO)
            .map_err(|error| OsBrokerError::new("cleanup_incomplete", error.to_string()))?
            .is_some()
            && child
                .job_is_empty()
                .map_err(|error| OsBrokerError::new("cleanup_incomplete", error.to_string()))?
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(OsBrokerError::new(
                "cleanup_incomplete",
                "process Job retirement could not be confirmed",
            ));
        }
        std::thread::sleep(CHECK_INTERVAL);
    }
}
