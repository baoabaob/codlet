//! Creation and lifetime ownership for one plugin process tree. Codex's process
//! type and launch path do not use this job or its termination methods.
use std::ffi::{OsStr, OsString};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use thiserror::Error;
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::Cryptography::{
    BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, OPEN_EXISTING, SECURITY_ANONYMOUS, SECURITY_SQOS_PRESENT,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CreateProcessW, EXTENDED_STARTUPINFO_PRESENT,
    GetExitCodeProcess, PROCESS_INFORMATION, ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    TerminateProcess, WaitForSingleObject,
};

use super::local_ipc::{Channel, LocalIpcError, create_event, create_server_pipe};
use super::process::{AttributeList, build_command_line};

#[derive(Debug, Error)]
pub(crate) enum PluginProcessError {
    #[error("plugin process {operation} failed with Win32 error {code}")]
    Win32 { operation: &'static str, code: u32 },
    #[error("plugin process: {0}")]
    Invalid(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Pipe(#[from] LocalIpcError),
}

pub(crate) struct PluginStdio {
    pub(crate) stdin: Channel,
    pub(crate) stdout: Channel,
    pub(crate) stderr: Channel,
    pub(crate) stop: Arc<OwnedHandle>,
}

pub(crate) struct OwnedPluginProcess {
    // An unnamed, non-inherited job supervises this plugin and its descendants.
    // It is lifecycle cleanup, not a restriction on the plugin's user privileges.
    job: OwnedHandle,
    process: OwnedHandle,
    pid: u32,
}

impl OwnedPluginProcess {
    pub(crate) fn spawn(
        executable: &Path,
        arguments: &[String],
        cwd: &Path,
    ) -> Result<(Self, PluginStdio), PluginProcessError> {
        let executable = canonical(executable, false)?;
        let cwd = canonical(cwd, true)?;
        let stop = Arc::new(create_event()?);
        let (stdin, child_stdin) = stdio_pair(true, Arc::clone(&stop))?;
        let (stdout, child_stdout) = stdio_pair(false, Arc::clone(&stop))?;
        let (stderr, child_stderr) = stdio_pair(false, Arc::clone(&stop))?;
        let job = owned(
            unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) },
            "CreateJobObjectW",
        )?;
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                raw(&job),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(last_error("SetInformationJobObject"));
        }
        let child_handles = [raw(&child_stdin), raw(&child_stdout), raw(&child_stderr)];
        let attributes = AttributeList::with_handle_list(&child_handles)
            .map_err(|error| PluginProcessError::Invalid(error.to_string()))?;
        let arguments: Vec<OsString> = arguments.iter().map(OsString::from).collect();
        let application = wide(executable.as_os_str())?;
        let directory = wide(cwd.as_os_str())?;
        let mut command = build_command_line(executable.as_os_str(), &arguments)
            .map_err(|error| PluginProcessError::Invalid(error.to_string()))?;
        let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
        startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = child_handles[0];
        startup.StartupInfo.hStdOutput = child_handles[1];
        startup.StartupInfo.hStdError = child_handles[2];
        startup.lpAttributeList = attributes.pointer;
        let mut output: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        // Start suspended so no plugin code can create a descendant before job
        // assignment. Only the three stdio endpoints may cross this boundary.
        if unsafe {
            CreateProcessW(
                application.as_ptr(),
                command.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | CREATE_SUSPENDED,
                std::ptr::null(),
                directory.as_ptr(),
                &startup.StartupInfo,
                &mut output,
            )
        } == 0
        {
            return Err(last_error("CreateProcessW"));
        }
        let process = unsafe { OwnedHandle::from_raw_handle(output.hProcess.cast()) };
        let thread = unsafe { OwnedHandle::from_raw_handle(output.hThread.cast()) };
        if unsafe { AssignProcessToJobObject(raw(&job), raw(&process)) } == 0 {
            let error = last_error("AssignProcessToJobObject");
            // The suspended child is our exact newly created process. It is the
            // sole unassigned failure case where process termination is needed.
            unsafe {
                TerminateProcess(raw(&process), 1);
                WaitForSingleObject(raw(&process), 2000);
            }
            return Err(error);
        }
        let child = Self {
            job,
            process,
            pid: output.dwProcessId,
        };
        if unsafe { ResumeThread(raw(&thread)) } == u32::MAX {
            let error = last_error("ResumeThread");
            let _ = child.terminate();
            let _ = child.wait(Duration::from_secs(2));
            return Err(error);
        }
        drop(thread);
        drop(child_stdin);
        drop(child_stdout);
        drop(child_stderr);
        Ok((
            child,
            PluginStdio {
                stdin,
                stdout,
                stderr,
                stop,
            },
        ))
    }

    pub(crate) fn pid(&self) -> u32 {
        self.pid
    }

    pub(crate) fn wait(&self, timeout: Duration) -> Result<Option<u32>, PluginProcessError> {
        let timeout = timeout.as_millis().min(u128::from(u32::MAX - 1)) as u32;
        match unsafe { WaitForSingleObject(raw(&self.process), timeout) } {
            WAIT_OBJECT_0 => {
                let mut code = 0;
                if unsafe { GetExitCodeProcess(raw(&self.process), &mut code) } == 0 {
                    Err(last_error("GetExitCodeProcess"))
                } else {
                    Ok(Some(code))
                }
            }
            WAIT_TIMEOUT => Ok(None),
            _ => Err(last_error("WaitForSingleObject")),
        }
    }

    pub(crate) fn terminate(&self) -> Result<(), PluginProcessError> {
        if unsafe { TerminateJobObject(raw(&self.job), 1) } == 0 {
            Err(last_error("TerminateJobObject"))
        } else {
            Ok(())
        }
    }
}

fn canonical(path: &Path, directory: bool) -> Result<PathBuf, PluginProcessError> {
    if !path.is_absolute() || (directory && !path.is_dir()) || (!directory && !path.is_file()) {
        return Err(PluginProcessError::Invalid(format!(
            "expected an existing absolute {}: {}",
            if directory {
                "directory"
            } else {
                "executable file"
            },
            path.display()
        )));
    }
    Ok(std::fs::canonicalize(path)?)
}

fn stdio_pair(
    child_reads: bool,
    stop: Arc<OwnedHandle>,
) -> Result<(Channel, OwnedHandle), PluginProcessError> {
    let mut nonce = [0_u8; 16];
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            nonce.as_mut_ptr(),
            nonce.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status < 0 {
        return Err(PluginProcessError::Invalid(format!(
            "stdio nonce allocation failed: {status:#x}"
        )));
    }
    let suffix: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
    let name = OsString::from(format!(
        r"\\.\pipe\Codlet.PluginStdio.{}.{}",
        std::process::id(),
        suffix
    ));
    let parent = create_server_pipe(&name)?;
    let name = wide(&name)?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: 1,
    };
    // The child gets synchronous standard handles. The parent's overlapped
    // endpoints remain non-inheritable and are cancelled through Channel.stop.
    let child = owned(
        unsafe {
            CreateFileW(
                name.as_ptr(),
                if child_reads {
                    GENERIC_READ
                } else {
                    GENERIC_WRITE
                },
                0,
                &attributes,
                OPEN_EXISTING,
                SECURITY_SQOS_PRESENT | SECURITY_ANONYMOUS,
                std::ptr::null_mut(),
            )
        },
        "CreateFileW(plugin stdio)",
    )?;
    let parent = Channel {
        pipe: parent,
        event: create_event()?,
        stop,
    };
    parent.connect()?;
    Ok((parent, child))
}

fn wide(value: &OsStr) -> Result<Vec<u16>, PluginProcessError> {
    let mut value: Vec<_> = value.encode_wide().collect();
    if value.contains(&0) {
        return Err(PluginProcessError::Invalid(
            "embedded NUL in launch argument".into(),
        ));
    }
    value.push(0);
    Ok(value)
}
fn raw(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle().cast()
}
fn owned(handle: HANDLE, operation: &'static str) -> Result<OwnedHandle, PluginProcessError> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(last_error(operation));
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(handle.cast()) })
}
fn last_error(operation: &'static str) -> PluginProcessError {
    PluginProcessError::Win32 {
        operation,
        code: unsafe { GetLastError() },
    }
}
