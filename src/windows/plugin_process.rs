//! Creation and lifetime ownership for one plugin process tree. Codex's process
//! type and launch path do not use this job or its termination methods.
use std::ffi::{OsStr, OsString};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
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
use windows_sys::Win32::System::IO::{CreateIoCompletionPort, GetQueuedCompletionStatus};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_ASSOCIATE_COMPLETION_PORT, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectAssociateCompletionPortInformation,
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
    EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, PROCESS_INFORMATION, ResumeThread,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess, WaitForSingleObject,
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
    completion_port: OwnedHandle,
    active_process_zero: AtomicBool,
    process: OwnedHandle,
    pid: u32,
}

impl OwnedPluginProcess {
    pub(crate) fn spawn(
        executable: &Path,
        arguments: &[String],
        cwd: &Path,
        environment: Option<&[(OsString, OsString)]>,
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
        // Associate while the job is still empty, before the suspended root is
        // assigned. This avoids losing lifecycle messages during association.
        let completion_port = owned(
            unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, std::ptr::null_mut(), 0, 1) },
            "CreateIoCompletionPort(plugin job)",
        )?;
        let completion = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
            CompletionKey: raw(&job),
            CompletionPort: raw(&completion_port),
        };
        if unsafe {
            SetInformationJobObject(
                raw(&job),
                JobObjectAssociateCompletionPortInformation,
                (&completion as *const JOBOBJECT_ASSOCIATE_COMPLETION_PORT).cast(),
                std::mem::size_of_val(&completion) as u32,
            )
        } == 0
        {
            return Err(last_error(
                "SetInformationJobObject(associate completion port)",
            ));
        }
        let child_handles = [raw(&child_stdin), raw(&child_stdout), raw(&child_stderr)];
        let attributes = AttributeList::with_handle_list(&child_handles)
            .map_err(|error| PluginProcessError::Invalid(error.to_string()))?;
        let arguments: Vec<OsString> = arguments.iter().map(OsString::from).collect();
        let application = wide(executable.as_os_str())?;
        let directory = wide(cwd.as_os_str())?;
        let mut command = build_command_line(executable.as_os_str(), &arguments)
            .map_err(|error| PluginProcessError::Invalid(error.to_string()))?;
        let environment = environment.map(environment_block).transpose()?;
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
                EXTENDED_STARTUPINFO_PRESENT
                    | CREATE_NO_WINDOW
                    | CREATE_SUSPENDED
                    | CREATE_UNICODE_ENVIRONMENT,
                environment
                    .as_ref()
                    .map_or(std::ptr::null(), |block| block.as_ptr().cast()),
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
            completion_port,
            active_process_zero: AtomicBool::new(false),
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
        // A long-lived process may create and retire many descendants before
        // its root exits. Drain the private job port on every ordinary poll so
        // those lifecycle packets do not accumulate for the whole host run.
        self.drain_job_completions()?;
        let timeout = timeout.as_millis().min(u128::from(u32::MAX - 1)) as u32;
        let wait = unsafe { WaitForSingleObject(raw(&self.process), timeout) };
        // Draining the completion port calls another Win32 API, so preserve a
        // failed wait's error before doing that bounded maintenance work.
        let wait_error = (wait == WAIT_FAILED).then(|| unsafe { GetLastError() });
        self.drain_job_completions()?;
        match wait {
            WAIT_OBJECT_0 => {
                let mut code = 0;
                if unsafe { GetExitCodeProcess(raw(&self.process), &mut code) } == 0 {
                    Err(last_error("GetExitCodeProcess"))
                } else {
                    Ok(Some(code))
                }
            }
            WAIT_TIMEOUT => Ok(None),
            _ => Err(PluginProcessError::Win32 {
                operation: "WaitForSingleObject",
                code: wait_error.unwrap_or(ERROR_INVALID_FUNCTION),
            }),
        }
    }

    pub(crate) fn terminate(&self) -> Result<(), PluginProcessError> {
        if unsafe { TerminateJobObject(raw(&self.job), 1) } == 0 {
            Err(last_error("TerminateJobObject"))
        } else {
            Ok(())
        }
    }

    /// Terminating the main process is not sufficient evidence that descendants
    /// have retired. Accounting can reach zero before a retained descendant
    /// process handle becomes signaled, so require the job's ACTIVE_PROCESS_ZERO
    /// completion after the root handle is signaled as the retirement receipt.
    pub(crate) fn process_scope_is_empty(&self) -> Result<bool, PluginProcessError> {
        self.drain_job_completions()?;
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe {
            QueryInformationJobObject(
                raw(&self.job),
                JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                std::mem::size_of_val(&accounting) as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(last_error("QueryInformationJobObject"));
        }
        let root_exited = match unsafe { WaitForSingleObject(raw(&self.process), 0) } {
            WAIT_OBJECT_0 => true,
            WAIT_TIMEOUT => false,
            _ => return Err(last_error("WaitForSingleObject(plugin process receipt)")),
        };
        Ok(root_exited
            && accounting.ActiveProcesses == 0
            && self.active_process_zero.load(Ordering::Acquire))
    }

    fn drain_job_completions(&self) -> Result<(), PluginProcessError> {
        // winnt.h defines JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO as 4. Completion
        // delivery is not guaranteed; absence deliberately leaves cleanup
        // unconfirmed so callers return cleanup_incomplete within their budget.
        const ACTIVE_PROCESS_ZERO: u32 = 4;
        const MAX_PACKETS_PER_POLL: usize = 256;
        for _ in 0..MAX_PACKETS_PER_POLL {
            let mut message = 0;
            let mut completion_key = 0usize;
            let mut overlapped = std::ptr::null_mut();
            if unsafe {
                GetQueuedCompletionStatus(
                    raw(&self.completion_port),
                    &mut message,
                    &mut completion_key,
                    &mut overlapped,
                    0,
                )
            } == 0
            {
                let error = unsafe { GetLastError() };
                if error == WAIT_TIMEOUT {
                    return Ok(());
                }
                return Err(PluginProcessError::Win32 {
                    operation: "GetQueuedCompletionStatus(plugin job)",
                    code: error,
                });
            }
            if completion_key != raw(&self.job) as usize {
                return Err(PluginProcessError::Invalid(
                    "plugin job completion key changed".into(),
                ));
            }
            if message == ACTIVE_PROCESS_ZERO {
                if !overlapped.is_null() {
                    return Err(PluginProcessError::Invalid(
                        "plugin job ACTIVE_PROCESS_ZERO carried a process identifier".into(),
                    ));
                }
                self.active_process_zero.store(true, Ordering::Release);
            }
        }
        Ok(())
    }
}

fn environment_block(environment: &[(OsString, OsString)]) -> Result<Vec<u16>, PluginProcessError> {
    let mut environment: Vec<_> = environment.iter().collect();
    environment.sort_by_key(|(key, _)| key.to_string_lossy().to_uppercase());
    let mut block = Vec::new();
    for (key, value) in environment {
        let key: Vec<_> = key.encode_wide().collect();
        let value: Vec<_> = value.encode_wide().collect();
        // Windows may expose drive-specific =C: variables; preserve them, but
        // never permit NUL to manufacture an extra environment entry.
        if key.is_empty() || key.contains(&0) || value.contains(&0) {
            return Err(PluginProcessError::Invalid(
                "invalid process environment entry".into(),
            ));
        }
        block.extend(key);
        block.push(b'=' as u16);
        block.extend(value);
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    Ok(block)
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
