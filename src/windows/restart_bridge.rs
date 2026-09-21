//! Per-launch restart bridge. The only process handle accepted here is a child
//! retained by our launcher. No PID-based attach or on-disk client patch exists.
use super::process::ChildProcess;
use std::ffi::{OsStr, c_void};
use std::mem::{offset_of, size_of};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::System::Diagnostics::{Debug::*, ToolHelp::*};
use windows_sys::Win32::System::LibraryLoader::*;
use windows_sys::Win32::System::Memory::*;
use windows_sys::Win32::System::Threading::*;

const DLL: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/codlet-restart-bridge.dll"));
const PATH_CAP: usize = 2048;
#[repr(C)]
#[derive(Clone, Copy)]
struct Shared {
    magic: u32,
    abi: u32,
    size: u32,
    owner_pid: u32,
    owner_handle: usize,
    registration_event: usize,
    enabled: i32,
    stop: i32,
    status: i32,
    registrations: i32,
    suppressed: i32,
    last_error: i32,
    updater_path: [u16; PATH_CAP],
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct Snapshot {
    pub ready: bool,
    #[cfg(test)]
    pub registrations: u32,
    pub error: Option<i32>,
}
pub(crate) struct RestartBridge {
    process: OwnedHandle,
    address: usize,
    foreground_entry: usize,
    registration_event: OwnedHandle,
    _files: tempfile::TempDir,
}

/// A permission handoff tied to the retained child handle, never a caller PID.
pub(crate) struct ForegroundPermission {
    process: OwnedHandle,
    address: usize,
    entry: usize,
}
impl ForegroundPermission {
    pub(crate) fn request(&self) -> Result<bool, String> {
        if unsafe { WaitForSingleObject(raw(&self.process), 0) } != WAIT_TIMEOUT {
            return Ok(false);
        }
        call(raw(&self.process), self.entry, self.address).map(|result| result == 1)
    }
}

fn failure(operation: &str) -> String {
    format!("{operation}: Win32 error {}", unsafe { GetLastError() })
}
fn raw(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle().cast()
}
fn wide(value: &OsStr) -> Result<Vec<u16>, String> {
    let mut value: Vec<_> = value.encode_wide().collect();
    if value.contains(&0) {
        return Err("Restart bridge path contains NUL".into());
    }
    value.push(0);
    Ok(value)
}
fn write(handle: HANDLE, address: usize, bytes: &[u8]) -> Result<(), String> {
    let mut written = 0;
    if unsafe {
        WriteProcessMemory(
            handle,
            address as *mut c_void,
            bytes.as_ptr().cast(),
            bytes.len(),
            &mut written,
        )
    } == 0
        || written != bytes.len()
    {
        return Err(failure("WriteProcessMemory(owned child)"));
    }
    Ok(())
}
fn allocate(handle: HANDLE, bytes: &[u8]) -> Result<usize, String> {
    let address = unsafe {
        VirtualAllocEx(
            handle,
            std::ptr::null(),
            bytes.len(),
            MEM_COMMIT | MEM_RESERVE,
            PAGE_READWRITE,
        )
    } as usize;
    if address == 0 {
        return Err(failure("VirtualAllocEx(owned child)"));
    }
    // A bounded allocation per launch remains alive until process exit. Never
    // free an argument while a remote thread might still be using it.
    write(handle, address, bytes)?;
    Ok(address)
}
fn call(handle: HANDLE, entry: usize, argument: usize) -> Result<u32, String> {
    let start = unsafe {
        std::mem::transmute::<usize, unsafe extern "system" fn(*mut c_void) -> u32>(entry)
    };
    let thread = unsafe {
        CreateRemoteThread(
            handle,
            std::ptr::null(),
            0,
            Some(start),
            argument as *const c_void,
            0,
            std::ptr::null_mut(),
        )
    };
    if thread.is_null() {
        return Err(failure("CreateRemoteThread(owned child)"));
    }
    let thread = unsafe { OwnedHandle::from_raw_handle(thread.cast()) };
    if unsafe { WaitForSingleObject(raw(&thread), 10_000) } != WAIT_OBJECT_0 {
        return Err("Restart bridge initialization did not finish; no retry or memory release was attempted".into());
    }
    let mut result = 0;
    if unsafe { GetExitCodeThread(raw(&thread), &mut result) } == 0 {
        return Err(failure("GetExitCodeThread"));
    }
    Ok(result)
}
fn module_base(pid: u32, expected: &Path) -> Result<usize, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match module_base_once(pid, expected) {
            Ok(Some(base)) => return Ok(base),
            Ok(None) if std::time::Instant::now() < deadline => (),
            Err(code)
                if [ERROR_BAD_LENGTH, ERROR_PARTIAL_COPY].contains(&code)
                    && std::time::Instant::now() < deadline => {}
            Ok(None) => {
                return Err(
                    "Expected restart bridge/system module is absent in the owned child".into(),
                );
            }
            Err(code) => {
                return Err(format!(
                    "CreateToolhelp32Snapshot(owned child modules): Win32 error {code}"
                ));
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}
fn module_base_once(pid: u32, expected: &Path) -> Result<Option<usize>, u32> {
    let snapshot =
        unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(unsafe { GetLastError() });
    }
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot.cast()) };
    let mut entry: MODULEENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = size_of::<MODULEENTRY32W>() as u32;
    let expected = expected
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('/', "\\")
        .to_lowercase();
    let mut found = unsafe { Module32FirstW(raw(&snapshot), &mut entry) };
    while found != 0 {
        let length = entry
            .szExePath
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(entry.szExePath.len());
        let actual = String::from_utf16_lossy(&entry.szExePath[..length]);
        if actual
            .trim_start_matches(r"\\?\")
            .replace('/', "\\")
            .to_lowercase()
            == expected
        {
            return Ok(Some(entry.modBaseAddr as usize));
        }
        found = unsafe { Module32NextW(raw(&snapshot), &mut entry) };
    }
    Ok(None)
}
fn remote_loader(pid: u32) -> Result<usize, String> {
    let name = wide(OsStr::new("kernel32.dll"))?;
    let kernel = unsafe { GetModuleHandleW(name.as_ptr()) };
    let loader = unsafe { GetProcAddress(kernel, c"LoadLibraryW".as_ptr().cast()) }
        .ok_or_else(|| failure("GetProcAddress(LoadLibraryW)"))? as usize;
    // Forwarded exports can live in KernelBase. Resolve that actual module and
    // its RVA instead of assuming equal ASLR bases across the two processes.
    let mut module = std::ptr::null_mut();
    if unsafe {
        GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            loader as *const u16,
            &mut module,
        )
    } == 0
    {
        return Err(failure("GetModuleHandleExW"));
    }
    let mut path = [0u16; PATH_CAP];
    let length = unsafe { GetModuleFileNameW(module, path.as_mut_ptr(), PATH_CAP as u32) } as usize;
    if length == 0 || length >= PATH_CAP {
        return Err("System module path is unavailable".into());
    }
    let path = std::path::PathBuf::from(String::from_utf16_lossy(&path[..length]));
    Ok(module_base(pid, &path)? + loader - module as usize)
}

impl RestartBridge {
    pub fn install(child: &ChildProcess, updater: &Path) -> Result<Self, String> {
        if !updater.is_absolute() || !updater.is_file() {
            return Err("Official updater module is unavailable".into());
        }
        let updater_path = updater
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .replace('/', "\\");
        let updater = wide(OsStr::new(&updater_path))?;
        if updater.len() > PATH_CAP {
            return Err("Updater module path is too long".into());
        }
        let files = tempfile::Builder::new()
            .prefix("codlet-restart-")
            .tempdir()
            .map_err(|e| e.to_string())?;
        let dll = files.path().join("codlet-restart-bridge.dll");
        std::fs::write(&dll, DLL).map_err(|e| e.to_string())?;
        let dll_wide = wide(dll.as_os_str())?;
        let process = child
            .owned_handle()
            .try_clone()
            .map_err(|e| e.to_string())?;
        let handle = raw(&process);
        let path_bytes = unsafe {
            std::slice::from_raw_parts(dll_wide.as_ptr().cast::<u8>(), dll_wide.len() * 2)
        };
        let argument = allocate(handle, path_bytes)?;
        call(handle, remote_loader(child.process_id())?, argument)?;
        let remote = module_base(child.process_id(), &dll)?;
        // Map our own embedded DLL without executing DllMain or its imports.
        let local = unsafe {
            LoadLibraryExW(
                dll_wide.as_ptr(),
                std::ptr::null_mut(),
                DONT_RESOLVE_DLL_REFERENCES,
            )
        };
        if local.is_null() {
            return Err(failure("LoadLibraryExW(bridge export map)"));
        }
        let entry = unsafe { GetProcAddress(local, c"codlet_restart_initialize".as_ptr().cast()) }
            .map(|entry| entry as usize - local as usize);
        let foreground_entry = unsafe {
            GetProcAddress(local, c"codlet_allow_owner_foreground".as_ptr().cast())
        }.map(|entry| entry as usize - local as usize);
        unsafe { FreeLibrary(local) };
        let entry = entry.ok_or("The embedded restart bridge has no initializer")?;
        let foreground_entry = foreground_entry.ok_or("The embedded bridge has no foreground handoff")?;
        let mut owner = std::ptr::null_mut();
        if unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                GetCurrentProcess(),
                handle,
                &mut owner,
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                0,
            )
        } == 0
        {
            return Err(failure("DuplicateHandle(Core identity)"));
        }
        // Zeroed repr(C), including padding, is copied to the native ABI.
        let mut shared: Shared = unsafe { std::mem::zeroed() };
        shared.magic = 0x43524c54;
        shared.abi = 1;
        shared.size = size_of::<Shared>() as u32;
        shared.owner_pid = std::process::id();
        shared.owner_handle = owner as usize;
        let event = unsafe { CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()) };
        if event.is_null() {
            return Err(failure("CreateEventW(restart registration)"));
        }
        let registration_event = unsafe { OwnedHandle::from_raw_handle(event.cast()) };
        let mut remote_event = std::ptr::null_mut();
        if unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                event,
                handle,
                &mut remote_event,
                EVENT_MODIFY_STATE,
                0,
                0,
            )
        } == 0
        {
            return Err(failure("DuplicateHandle(restart registration)"));
        }
        shared.registration_event = remote_event as usize;
        shared.updater_path[..updater.len()].copy_from_slice(&updater);
        let address = allocate(handle, unsafe {
            std::slice::from_raw_parts((&raw const shared).cast::<u8>(), size_of::<Shared>())
        })?;
        if call(handle, remote + entry, address)? != 0 {
            return Err("Native restart bridge rejected initialization".into());
        }
        Ok(Self {
            process,
            address,
            foreground_entry: remote + foreground_entry,
            registration_event,
            _files: files,
        })
    }
    pub(crate) fn foreground_permission(&self) -> Result<ForegroundPermission, String> {
        Ok(ForegroundPermission {
            process: self.process.try_clone().map_err(|error| error.to_string())?,
            address: self.address,
            entry: self.foreground_entry,
        })
    }
    pub fn enable(&self, enabled: bool) -> Result<(), String> {
        write(
            raw(&self.process),
            self.address + offset_of!(Shared, enabled),
            &i32::from(enabled).to_ne_bytes(),
        )
    }
    // Kernel event survives the child's exit, including an immediate exit in
    // the native installer before Core can read remote process memory again.
    pub fn take_registered(&self) -> bool {
        (unsafe { WaitForSingleObject(raw(&self.registration_event), 0) }) == WAIT_OBJECT_0
    }
    pub fn snapshot(&self) -> Result<Snapshot, String> {
        let mut shared: Shared = unsafe { std::mem::zeroed() };
        let mut read = 0;
        if unsafe {
            ReadProcessMemory(
                raw(&self.process),
                self.address as *const c_void,
                (&raw mut shared).cast(),
                size_of::<Shared>(),
                &mut read,
            )
        } == 0
            || read != size_of::<Shared>()
        {
            return Err(failure("ReadProcessMemory(restart status)"));
        }
        Ok(Snapshot {
            ready: shared.status == 1,
            #[cfg(test)]
            registrations: shared.registrations.max(0) as u32,
            error: (shared.status < 0 || shared.last_error != 0).then_some(
                if shared.last_error != 0 {
                    shared.last_error
                } else {
                    shared.status
                },
            ),
        })
    }
}
impl Drop for RestartBridge {
    fn drop(&mut self) {
        let _ = self.enable(false);
        let _ = write(
            raw(&self.process),
            self.address + offset_of!(Shared, stop),
            &1i32.to_ne_bytes(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::time::{Duration, Instant};
    #[test]
    #[ignore = "activate the test window on an unlocked desktop; opens Explorer"]
    fn foreground_client_hands_directory_activation_to_core() {
        use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW};
        let root = tempfile::Builder::new().prefix("Codlet-folder-activation-").tempdir().unwrap();
        let target = root.path().join("windows-updater.node");
        let other = root.path().join("unrelated.dll");
        let compiled = Path::new(env!("OUT_DIR"));
        std::fs::copy(compiled.join("restart-fixture.dll"), &target).unwrap();
        std::fs::copy(&target, &other).unwrap();
        let args: Vec<OsString> = [root.path(), target.as_path(), other.as_path()]
            .iter().map(|p| p.as_os_str().to_owned()).collect();
        let (child, _pipes) = super::super::process::launch_with_cdp_pipes(
            &compiled.join("restart-fixture.exe"), &args, true,
        ).unwrap();
        struct Exit<'a>(&'a Path, &'a ChildProcess);
        impl Drop for Exit<'_> {
            fn drop(&mut self) {
                let _ = std::fs::write(self.0.join("request"), b"q");
                let _ = self.1.wait(Duration::from_secs(3));
            }
        }
        let _exit = Exit(root.path(), &child);
        let bridge = RestartBridge::install(&child, &target).unwrap();
        let permission = bridge.foreground_permission().unwrap();
        assert!(!permission.request().unwrap(), "a background child cannot grant foreground");
        std::fs::write(root.path().join("request"), b"w").unwrap();
        eprintln!("Activate the window named 'Codlet folder activation test' within 45 seconds");
        let deadline = Instant::now() + Duration::from_secs(45);
        while !permission.request().unwrap() {
            assert!(Instant::now() < deadline, "test window was not activated");
            std::thread::sleep(Duration::from_millis(100));
        }
        super::super::open_folder::open_runtime_directory(root.path().to_owned()).unwrap();
        let name = root.path().file_name().unwrap().to_string_lossy();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut title = String::new();
        while Instant::now() < deadline {
            let mut text = [0_u16; 512];
            let length = unsafe { GetWindowTextW(GetForegroundWindow(), &mut text) };
            title = String::from_utf16_lossy(&text[..length as usize]);
            if title.contains(name.as_ref()) {
                assert!(!permission.request().unwrap(), "the background client must stop granting permission");
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        panic!("Explorer did not activate for {name}; foreground title: {title}");
    }

    #[test]
    fn registration_event_survives_immediate_child_exit() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("windows-updater.node");
        let other = root.path().join("unrelated.dll");
        let compiled = Path::new(env!("OUT_DIR"));
        std::fs::copy(compiled.join("restart-fixture.dll"), &target).unwrap();
        std::fs::copy(&target, &other).unwrap();
        let args: Vec<OsString> = [root.path(), target.as_path(), other.as_path()]
            .iter()
            .map(|p| p.as_os_str().to_owned())
            .collect();
        let (child, _pipes) = super::super::process::launch_with_cdp_pipes(
            &compiled.join("restart-fixture.exe"),
            &args,
            true,
        )
        .unwrap();
        let bridge = RestartBridge::install(&child, &target).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !bridge.snapshot().unwrap().ready {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(20));
        }
        bridge.enable(true).unwrap();
        let permission = bridge.foreground_permission().unwrap();
        assert!(!permission.request().unwrap(), "the headless child has no foreground permission");
        std::fs::write(root.path().join("request"), b"x").unwrap();
        assert_eq!(child.wait(Duration::from_secs(5)).unwrap(), Some(0));
        assert!(!permission.request().unwrap(), "a retired child cannot grant permission");
        assert!(
            bridge.take_registered(),
            "registration evidence must remain after process memory is gone"
        );
        assert!(!bridge.take_registered(), "one event is consumed only once");
    }
    #[test]
    fn native_hook_only_suppresses_armed_selected_updater_and_unhooks() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("windows-updater.node");
        let other = root.path().join("unrelated.dll");
        let compiled = Path::new(env!("OUT_DIR"));
        std::fs::copy(compiled.join("restart-fixture.dll"), &target).unwrap();
        std::fs::copy(&target, &other).unwrap();
        let args: Vec<OsString> = [root.path(), target.as_path(), other.as_path()]
            .iter()
            .map(|p| p.as_os_str().to_owned())
            .collect();
        let (child, _pipes) = super::super::process::launch_with_cdp_pipes(
            &compiled.join("restart-fixture.exe"),
            &args,
            true,
        )
        .unwrap();
        struct Exit<'a>(&'a Path, &'a ChildProcess);
        impl Drop for Exit<'_> {
            fn drop(&mut self) {
                let _ = std::fs::write(self.0.join("request"), b"q");
                let _ = self.1.wait(Duration::from_secs(3));
            }
        }
        let _exit = Exit(root.path(), &child);
        let bridge = RestartBridge::install(&child, &target).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !bridge.snapshot().unwrap().ready {
            assert!(Instant::now() < deadline, "{:?}", bridge.snapshot());
            std::thread::sleep(Duration::from_millis(20));
        }
        let command = |command| {
            let response = root.path().join("response");
            let _ = std::fs::remove_file(&response);
            std::fs::write(root.path().join("request"), [command]).unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                if let Ok(data) = std::fs::read(&response)
                    && let Ok(value) = serde_json::from_slice::<serde_json::Value>(&data)
                {
                    break value;
                }
                assert!(Instant::now() < deadline, "fixture response timed out");
                std::thread::sleep(Duration::from_millis(10));
            }
        };
        assert_eq!(
            command(b'r')["registered"],
            true,
            "disabled guard passes through"
        );
        bridge.enable(true).unwrap();
        assert_eq!(
            command(b'r')["registered"],
            false,
            "selected updater registration is suppressed, including the old registration"
        );
        assert_eq!(bridge.snapshot().unwrap().registrations, 1);
        assert_eq!(
            command(b'o')["registered"],
            true,
            "unrelated module remains untouched"
        );
        assert_eq!(bridge.snapshot().unwrap().registrations, 1);
        assert_eq!(command(b'r')["registered"], false);
        drop(bridge);
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(
            command(b'r')["registered"],
            true,
            "dropping the guard restores the native API"
        );
        command(b'u');
    }
}
