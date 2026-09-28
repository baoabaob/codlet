//! Short-lived, same-build package broker. Only the owned official client enters
//! the package context; Core, plugins and configuration keep their original scope.
//! DesktopAppXActivator is an internal Windows COM interface (v2, then v1). Its
//! availability and the returned package identity are checked; no policy bypass,
//! package registration, external-parent borrowing or PowerShell fallback exists.
use super::local_ipc::{self, Channel, ServerIdentity, raw};
use super::packages::{self, InstalledPackage};
use super::process::{self, NativeLaunch, ProcessError, SuspendedChild};
use serde::{Deserialize, Serialize};
use std::ffi::{OsStr, OsString, c_void};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::{FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
};
use windows::core::{GUID, HRESULT, IUnknown, IUnknown_Vtbl, Interface};
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Storage::Packaging::Appx::GetPackageFullName;
use windows_sys::Win32::System::Threading::*;

pub(crate) const COMMAND: &str = "--internal-package-launch";
const PREFIX: &str = r"\\.\pipe\Codlet.PackageLaunch.";
const TIMEOUT: Duration = Duration::from_secs(20);
const FRAME_LIMIT: usize = 8 * 1024 * 1024;

fn failure(error: impl std::fmt::Display) -> ProcessError {
    ProcessError::PackageLaunch(error.to_string())
}
fn win32(operation: &str) -> ProcessError {
    failure(format!("{operation}: Win32 {}", unsafe { GetLastError() }))
}
fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().collect()
}
fn terminated(value: &OsStr) -> Result<Vec<u16>, ProcessError> {
    let mut value = wide(value);
    if value.contains(&0) {
        return Err(failure("embedded NUL"));
    }
    value.push(0);
    Ok(value)
}
fn channel(pipe: OwnedHandle) -> Result<Channel, ProcessError> {
    Ok(Channel {
        pipe,
        event: local_ipc::create_event().map_err(failure)?,
        stop: Arc::new(local_ipc::create_event().map_err(failure)?),
    })
}
fn send<T: Serialize>(channel: &Channel, value: &T, deadline: Instant) -> Result<(), ProcessError> {
    let bytes = serde_json::to_vec(value).map_err(failure)?;
    if bytes.len() > FRAME_LIMIT {
        return Err(failure("package launch frame exceeds limit"));
    }
    channel.write_frame(&bytes, deadline).map_err(failure)
}
fn receive<T: for<'a> Deserialize<'a>>(
    channel: &Channel,
    deadline: Instant,
) -> Result<T, ProcessError> {
    serde_json::from_slice(&channel.read_frame(FRAME_LIMIT, deadline).map_err(failure)?)
        .map_err(failure)
}

pub(crate) fn package_full_name(process: HANDLE) -> Result<Option<String>, ProcessError> {
    let mut length = 0;
    let code = unsafe { GetPackageFullName(process, &mut length, std::ptr::null_mut()) };
    if code == APPMODEL_ERROR_NO_PACKAGE {
        return Ok(None);
    }
    if code != ERROR_INSUFFICIENT_BUFFER || length == 0 || length > 32768 {
        return Err(failure(format!("GetPackageFullName(size): Win32 {code}")));
    }
    let mut buffer = vec![0; length as usize];
    let code = unsafe { GetPackageFullName(process, &mut length, buffer.as_mut_ptr()) };
    if code != ERROR_SUCCESS {
        return Err(failure(format!("GetPackageFullName(data): Win32 {code}")));
    }
    let end = buffer
        .iter()
        .position(|&v| v == 0)
        .ok_or_else(|| failure("unterminated package identity"))?;
    String::from_utf16(&buffer[..end])
        .map(Some)
        .map_err(failure)
}
fn creation_time(process: HANDLE) -> Result<u64, ProcessError> {
    let mut times: [FILETIME; 4] = unsafe { std::mem::zeroed() };
    let [created, exited, kernel, user] = &mut times;
    if unsafe { GetProcessTimes(process, created, exited, kernel, user) } == 0 {
        return Err(win32("GetProcessTimes"));
    }
    Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
}
fn duplicate(
    source_process: HANDLE,
    handle: HANDLE,
    target_process: HANDLE,
    inherit: bool,
) -> Result<HANDLE, ProcessError> {
    let mut result = std::ptr::null_mut();
    if unsafe {
        DuplicateHandle(
            source_process,
            handle,
            target_process,
            &mut result,
            0,
            inherit.into(),
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err(win32("DuplicateHandle(package launch)"));
    }
    Ok(result)
}
fn open_dup_peer(identity: &ServerIdentity) -> Result<OwnedHandle, ProcessError> {
    let handle = unsafe {
        OpenProcess(
            PROCESS_DUP_HANDLE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            identity.pid,
        )
    };
    if handle.is_null() {
        return Err(win32("OpenProcess(package launch peer)"));
    }
    let process = unsafe { OwnedHandle::from_raw_handle(handle) };
    if creation_time(handle)? != creation_time(raw(&identity.process))? {
        return Err(failure("package launch peer changed"));
    }
    Ok(process)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    package: String,
    executable: Vec<u16>,
    arguments: Vec<Vec<u16>>,
    cwd: Vec<u16>,
    environment: Vec<(Vec<u16>, Vec<u16>)>,
    handles: Vec<u64>,
    no_window: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
enum Reply {
    Ready { pid: u32, tid: u32, created: u64 },
    Failed { error: String },
    Committed,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Commit {
    pid: u32,
    created: u64,
}

#[repr(C)]
struct ActivatorVtable {
    base: IUnknown_Vtbl,
    activate: unsafe extern "system" fn(
        *mut c_void,
        *const u16,
        *const u16,
        *const u16,
        *mut HANDLE,
    ) -> HRESULT,
    activate_with_options: unsafe extern "system" fn(
        *mut c_void,
        *const u16,
        *const u16,
        *const u16,
        u32,
        u32,
        *mut HANDLE,
    ) -> HRESULT,
}
#[repr(C)]
struct ActivatorV2Vtable {
    base: ActivatorVtable,
    activate_with_event_args: unsafe extern "system" fn(
        *mut c_void,
        *const u16,
        *const u16,
        *const u16,
        u32,
        *mut c_void,
        *mut HANDLE,
    ) -> HRESULT,
    activate_hidden: unsafe extern "system" fn(
        *mut c_void,
        *const u16,
        *const u16,
        *const u16,
        u32,
        u32,
        *mut c_void,
        *const u16,
        u32,
        *mut HANDLE,
    ) -> HRESULT,
}
fn activate_helper(
    package: &InstalledPackage,
    executable: &Path,
    pipe: &OsStr,
) -> Result<OwnedHandle, ProcessError> {
    let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    if initialized.is_err() && initialized.0 != 0x80010106u32 as i32 {
        return Err(failure(initialized));
    }
    struct Com(bool);
    impl Drop for Com {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }
    let _com = Com(initialized.is_ok());
    let class = GUID::from_u128(0x168eb462_775f_42ae_9111_d714b2306c2e);
    let object: IUnknown =
        unsafe { CoCreateInstance(&class, None, CLSCTX_INPROC_SERVER) }.map_err(failure)?;
    let mut selected = std::ptr::null_mut();
    let mut last = HRESULT(0x80004002u32 as i32);
    let mut version = 0;
    for (index, iid) in [
        GUID::from_u128(0xf158268a_d5a5_45ce_99cf_00d6c3f3fc0a),
        GUID::from_u128(0x72e3a5b0_8fea_485c_9f8b_822b16dba17f),
    ]
    .into_iter()
    .enumerate()
    {
        last = unsafe { (object.vtable().QueryInterface)(object.as_raw(), &iid, &mut selected) };
        if last.is_ok() {
            version = if index == 0 { 2 } else { 1 };
            break;
        }
    }
    if last.is_err() {
        return Err(failure(format!(
            "Windows package activator unavailable: {last}"
        )));
    }
    // Both queried interfaces have the same first two activation methods.
    let activator = unsafe { IUnknown::from_raw(selected) };
    let table = unsafe { &**(activator.as_raw() as *const *const ActivatorVtable) };
    let aumid = terminated(OsStr::new(&format!("{}!App", package.family_name)))?;
    let executable = terminated(executable.as_os_str())?;
    let arguments = process::build_command_line(OsStr::new(COMMAND), &[pipe.to_owned()])?;
    let mut process = std::ptr::null_mut();
    // NONPACKAGED_EXE | NO_ERROR_UI. Do not force the entire descendant tree
    // into the package: the helper sets OVERERRIDE only on the official child.
    // Windows still enforces application-control policy.
    let activated = if version == 2 {
        let table = unsafe { &**(activator.as_raw() as *const *const ActivatorV2Vtable) };
        unsafe {
            (table.activate_hidden)(
                activator.as_raw(),
                aumid.as_ptr(),
                executable.as_ptr(),
                arguments.as_ptr(),
                10,
                0,
                std::ptr::null_mut(),
                std::ptr::null(),
                0,
                &mut process,
            )
        }
    } else {
        unsafe {
            (table.activate_with_options)(
                activator.as_raw(),
                aumid.as_ptr(),
                executable.as_ptr(),
                arguments.as_ptr(),
                10,
                0,
                &mut process,
            )
        }
    };
    activated.ok().map_err(failure)?;
    if process.is_null() {
        return Err(failure("package activator returned no owned process"));
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(process) })
}

pub(crate) fn create_in_package(
    launch: &NativeLaunch<'_>,
    package: &InstalledPackage,
    before_resume: &mut impl FnMut(&SuspendedChild) -> Result<(), ProcessError>,
) -> Result<SuspendedChild, ProcessError> {
    let nonce = super::control_scope::random_incarnation().map_err(failure)?;
    let suffix = nonce
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let name = OsString::from(format!("{PREFIX}{}.{}", std::process::id(), suffix));
    let channel = channel(local_ipc::create_server_pipe(&name).map_err(failure)?)?;
    let executable =
        local_ipc::process_image_path(unsafe { GetCurrentProcess() }).map_err(failure)?;
    let helper = activate_helper(package, &executable, &name)?;
    let deadline = Instant::now() + TIMEOUT;
    let result = (|| {
        if package_full_name(raw(&helper))?.as_deref() != Some(&package.full_name) {
            return Err(failure("activated helper has wrong package identity"));
        }
        channel.connect_until(Some(deadline)).map_err(failure)?;
        let peer = ServerIdentity::verify_client(&channel.pipe, &executable).map_err(failure)?;
        if peer.pid != unsafe { GetProcessId(raw(&helper)) }
            || creation_time(raw(&peer.process))? != creation_time(raw(&helper))?
        {
            return Err(failure("unexpected package helper peer"));
        }
        let inherited;
        let environment = if let Some(environment) = launch.environment {
            environment
        } else {
            inherited = super::environment::ChildEnvironment::inherited()?;
            &inherited
        };
        let cwd = launch
            .current_directory
            .map(Path::to_owned)
            .map(Ok)
            .unwrap_or_else(std::env::current_dir)
            .map_err(failure)?;
        let handles = launch
            .cdp
            .iter()
            .chain(launch.stderr.iter().flatten())
            .map(|handle| *handle as usize as u64)
            .collect();
        send(
            &channel,
            &Request {
                package: package.full_name.clone(),
                executable: wide(launch.executable.as_os_str()),
                arguments: launch.arguments.iter().map(|arg| wide(arg)).collect(),
                cwd: wide(cwd.as_os_str()),
                environment: environment
                    .entries_os()
                    .iter()
                    .map(|(key, value)| (wide(key), wide(value)))
                    .collect(),
                handles,
                no_window: launch.no_window,
            },
            deadline,
        )?;
        let (pid, tid, created) = match receive(&channel, deadline)? {
            Reply::Ready { pid, tid, created } => (pid, tid, created),
            Reply::Failed { error } => return Err(failure(error)),
            Reply::Committed => return Err(failure("unexpected package helper state")),
        };
        // The authenticated helper keeps the exact suspended process and thread
        // alive until commit. Open only that reported identity, then verify it
        // before issuing any control operation; never adopt an existing client.
        let process = unsafe { OpenProcess(PROCESS_ALL_ACCESS, 0, pid) };
        if process.is_null() {
            return Err(win32("OpenProcess(owned suspended client)"));
        }
        let process = unsafe { OwnedHandle::from_raw_handle(process) };
        if creation_time(raw(&process))? != created {
            return Err(failure("suspended client creation identity changed"));
        }
        let thread = unsafe {
            OpenThread(
                THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
                0,
                tid,
            )
        };
        if thread.is_null() {
            return Err(win32("OpenThread(owned suspended client)"));
        }
        let thread = unsafe { OwnedHandle::from_raw_handle(thread) };
        if unsafe { GetProcessIdOfThread(raw(&thread)) } != pid {
            return Err(failure("suspended thread belongs to another process"));
        }
        let mut child = SuspendedChild {
            process,
            thread,
            pid,
            armed: false,
        };
        if unsafe { GetProcessId(raw(&child.process)) } != pid
            || unsafe { GetProcessIdOfThread(raw(&child.thread)) } != pid
            || creation_time(raw(&child.process))? != created
        {
            return Err(failure("package helper returned mismatched child handles"));
        }
        let image = local_ipc::process_image_path(raw(&child.process))
            .map_err(failure)?
            .canonicalize()
            .map_err(failure)?;
        if image != launch.executable.canonicalize().map_err(failure)?
            || package_full_name(raw(&child.process))?.as_deref() != Some(&package.full_name)
        {
            return Err(failure(
                "owned child image or package identity differs from the requested client",
            ));
        }
        child.armed = true;
        before_resume(&child)?;
        child.resume()?;
        send(&channel, &Commit { pid, created }, deadline)?;
        match receive(&channel, deadline)? {
            Reply::Committed => {}
            Reply::Failed { error } => return Err(failure(error)),
            _ => return Err(failure("package handoff not committed")),
        }
        eprintln!(
            "client-package-context: verified={}; activation=owned-helper",
            package.full_name
        );
        Ok(child)
    })();
    // EOF aborts the helper's uncommitted suspended child. Neither side keeps a
    // permanent broker or publishes a general-purpose package launcher endpoint.
    drop(channel);
    let _ = unsafe { WaitForSingleObject(raw(&helper), 3000) };
    result
}
pub(crate) fn run_helper(name: &OsStr) -> Result<(), ProcessError> {
    if !name.to_string_lossy().starts_with(PREFIX) {
        return Err(failure("invalid package helper endpoint"));
    }
    let channel = channel(local_ipc::open_client(name).map_err(failure)?)?;
    let executable =
        local_ipc::process_image_path(unsafe { GetCurrentProcess() }).map_err(failure)?;
    let peer = ServerIdentity::verify(&channel.pipe, &executable).map_err(failure)?;
    let parent = open_dup_peer(&peer)?;
    let deadline = Instant::now() + TIMEOUT;
    let result = (|| {
        let request: Request = receive(&channel, deadline)?;
        let package = packages::find_unique_current_user_package(packages::CODEX_PACKAGE_FAMILY)
            .map_err(failure)?;
        if package.full_name != request.package
            || package_full_name(unsafe { GetCurrentProcess() })?.as_deref()
                != Some(&request.package)
        {
            return Err(failure("package changed before client creation"));
        }
        let executable = PathBuf::from(OsString::from_wide(&request.executable));
        let expected = packages::resolve_package_executable(
            &package,
            Path::new(packages::CODEX_EXECUTABLE_RELATIVE_PATH),
        )
        .map_err(failure)?;
        if !cfg!(feature = "desktop-acceptance")
            && executable.canonicalize().map_err(failure)? != expected
        {
            return Err(failure(
                "package helper only starts the selected official executable",
            ));
        }
        if !matches!(request.handles.len(), 2 | 4) {
            return Err(failure("invalid inherited handle count"));
        }
        let mut handles = Vec::new();
        for value in request.handles {
            let value = usize::try_from(value).map_err(failure)?;
            if value == 0 || value > isize::MAX as usize {
                return Err(failure("invalid source handle"));
            }
            let local = duplicate(
                raw(&parent),
                value as HANDLE,
                unsafe { GetCurrentProcess() },
                true,
            )?;
            handles.push(unsafe { OwnedHandle::from_raw_handle(local) });
        }
        let arguments: Vec<_> = request
            .arguments
            .iter()
            .map(|value| OsString::from_wide(value))
            .collect();
        let environment = super::environment::ChildEnvironment::from_entries(
            request
                .environment
                .iter()
                .map(|(key, value)| (OsString::from_wide(key), OsString::from_wide(value))),
        )?;
        let cwd = PathBuf::from(OsString::from_wide(&request.cwd));
        peer.check_live(&channel.pipe).map_err(failure)?;
        let mut child = process::create_suspended(&NativeLaunch {
            executable: &executable,
            arguments: &arguments,
            no_window: request.no_window,
            environment: Some(&environment),
            current_directory: Some(&cwd),
            cdp: [raw(&handles[0]), raw(&handles[1])],
            preserve_package_identity: true,
            stderr: if handles.len() == 4 {
                Some([raw(&handles[2]), raw(&handles[3])])
            } else {
                None
            },
        })?;
        if package_full_name(raw(&child.process))?.as_deref() != Some(&request.package) {
            return Err(failure("client did not inherit activated package identity"));
        }
        let created = creation_time(raw(&child.process))?;
        send(
            &channel,
            &Reply::Ready {
                pid: child.pid,
                tid: unsafe { GetThreadId(raw(&child.thread)) },
                created,
            },
            deadline,
        )?;
        let commit: Commit = receive(&channel, deadline)?;
        peer.check_live(&channel.pipe).map_err(failure)?;
        if commit.pid != child.pid || commit.created != created {
            return Err(failure("package handoff identity changed"));
        }
        send(&channel, &Reply::Committed, deadline)?;
        child.armed = false;
        Ok(())
    })();
    if let Err(error) = &result {
        let _ = send(
            &channel,
            &Reply::Failed {
                error: error.to_string(),
            },
            deadline,
        );
    }
    result
}
