//! Bounded, reversible data edits in one newly created client. The provider
//! supplies image identity and bytes; Core knows no client-specific offsets.
#[cfg(test)]
#[path = "client_bootstrap_tests.rs"]
mod tests;
use super::process::SuspendedChild;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, IntoRawHandle, OwnedHandle};
use std::path::{Component, Path};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::thread::JoinHandle;
use std::time::Instant;
use windows_sys::Win32::Foundation::{CloseHandle, ERROR_SEM_TIMEOUT, GetLastError, HANDLE};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, FILE_SHARE_READ, GetFileInformationByHandle,
};
use windows_sys::Win32::System::Diagnostics::Debug::{
    CREATE_PROCESS_DEBUG_EVENT, CREATE_THREAD_DEBUG_EVENT, ContinueDebugEvent, DEBUG_EVENT,
    DebugActiveProcess, DebugActiveProcessStop, DebugBreakProcess, DebugSetProcessKillOnExit,
    EXCEPTION_DEBUG_EVENT, EXIT_PROCESS_DEBUG_EVENT, EXIT_THREAD_DEBUG_EVENT, LOAD_DLL_DEBUG_EVENT,
    ReadProcessMemory, UNLOAD_DLL_DEBUG_EVENT, WaitForDebugEvent, WriteProcessMemory,
};
use windows_sys::Win32::System::Memory::{
    MEM_COMMIT, MEM_IMAGE, MEMORY_BASIC_INFORMATION, PAGE_GUARD, PAGE_NOACCESS, PAGE_READWRITE,
    VirtualProtectEx, VirtualQueryEx,
};
use windows_sys::Win32::System::Threading::TerminateProcess;

#[derive(Debug, thiserror::Error)]
#[error("owned client bootstrap: {code}{detail}")]
pub(crate) struct BootstrapError {
    pub(crate) code: &'static str,
    detail: String,
}
type Result<T> = std::result::Result<T, BootstrapError>;
fn fail(code: &'static str) -> BootstrapError {
    BootstrapError {
        code,
        detail: String::new(),
    }
}
fn win32(code: &'static str) -> BootstrapError {
    BootstrapError {
        code,
        detail: format!(" (Win32 {})", unsafe { GetLastError() }),
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ModuleDataPlan {
    module: String,
    sha256: String,
    patches: Vec<DataPatch>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DataPatch {
    file_offset: u64,
    expected: Vec<u8>,
    replacement: Vec<u8>,
}
#[derive(Clone)]
struct PreparedPatch {
    rva: usize,
    expected: Vec<u8>,
    replacement: Vec<u8>,
}
struct PreparedModule {
    _file: File,
    identity: (u32, u64),
    patches: Vec<PreparedPatch>,
}

fn file_identity(handle: HANDLE) -> Result<(u32, u64)> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0 {
        return Err(win32("bootstrap_image_identity_failed"));
    }
    Ok((
        info.dwVolumeSerialNumber,
        (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
    ))
}
fn read_at(file: &mut File, offset: u64, size: usize) -> Result<Vec<u8>> {
    let mut bytes = vec![0; size];
    file.seek(SeekFrom::Start(offset))
        .and_then(|_| file.read_exact(&mut bytes))
        .map_err(|_| fail("bootstrap_image_invalid"))?;
    Ok(bytes)
}
fn u16_at(bytes: &[u8], n: usize) -> u16 {
    u16::from_le_bytes(bytes[n..n + 2].try_into().unwrap())
}
fn u32_at(bytes: &[u8], n: usize) -> u32 {
    u32::from_le_bytes(bytes[n..n + 4].try_into().unwrap())
}

impl ModuleDataPlan {
    pub(crate) fn parse(value: serde_json::Value) -> Result<Self> {
        let plan: Self =
            serde_json::from_value(value).map_err(|_| fail("bootstrap_plan_invalid"))?;
        let path = Path::new(&plan.module);
        if plan.module.len() > 180
            || !matches!(
                (path.components().next(), path.components().nth(1)),
                (Some(Component::Normal(_)), None)
            )
            || plan.module.contains([':', '\\', '/'])
            || plan.module.ends_with(['.', ' '])
            || plan.sha256.len() != 64
            || !plan.sha256.bytes().all(|b| b.is_ascii_hexdigit())
            || plan.patches.is_empty()
            || plan.patches.len() > 8
        {
            return Err(fail("bootstrap_plan_invalid"));
        }
        let mut ranges = Vec::new();
        let mut total = 0;
        for patch in &plan.patches {
            if patch.expected.is_empty()
                || patch.expected.len() != patch.replacement.len()
                || patch.expected == patch.replacement
            {
                return Err(fail("bootstrap_plan_invalid"));
            }
            total += patch.expected.len();
            let end = patch
                .file_offset
                .checked_add(patch.expected.len() as u64)
                .ok_or_else(|| fail("bootstrap_plan_invalid"))?;
            if total > 64
                || end > 512 * 1024 * 1024
                || ranges
                    .iter()
                    .any(|&(start, stop)| patch.file_offset < stop && end > start)
            {
                return Err(fail("bootstrap_plan_invalid"));
            }
            ranges.push((patch.file_offset, end));
        }
        Ok(plan)
    }
    fn prepare(&self, executable: &Path, deadline: Instant) -> Result<PreparedModule> {
        let parent = executable
            .parent()
            .ok_or_else(|| fail("bootstrap_image_invalid"))?
            .canonicalize()
            .map_err(|_| fail("bootstrap_image_invalid"))?;
        let path = parent
            .join(&self.module)
            .canonicalize()
            .map_err(|_| fail("bootstrap_image_missing"))?;
        if path.parent() != Some(parent.as_path()) {
            return Err(fail("bootstrap_image_invalid"));
        }
        // Retain the file and deny writes/replacement for this short transaction.
        let mut file = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(path)
            .map_err(|_| fail("bootstrap_image_unavailable"))?;
        let size = file
            .metadata()
            .map_err(|_| fail("bootstrap_image_invalid"))?
            .len();
        if !(64..=512 * 1024 * 1024).contains(&size) {
            return Err(fail("bootstrap_image_invalid"));
        }
        let identity = file_identity(file.as_raw_handle().cast())?;
        let mut hash = Sha256::new();
        let mut buffer = vec![0; 256 * 1024];
        loop {
            if Instant::now() >= deadline {
                return Err(fail("bootstrap_timeout"));
            }
            let count = file
                .read(&mut buffer)
                .map_err(|_| fail("bootstrap_image_invalid"))?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        if format!("{:x}", hash.finalize()) != self.sha256.to_ascii_lowercase() {
            return Err(fail("bootstrap_image_changed"));
        }
        let dos = read_at(&mut file, 0, 64)?;
        if &dos[..2] != b"MZ" {
            return Err(fail("bootstrap_image_invalid"));
        }
        let pe = u64::from(u32_at(&dos, 60));
        if pe > 65536 {
            return Err(fail("bootstrap_image_invalid"));
        }
        let header = read_at(&mut file, pe, 24)?;
        if &header[..4] != b"PE\0\0" || ![0x8664, 0xaa64].contains(&u16_at(&header, 4)) {
            return Err(fail("bootstrap_image_invalid"));
        }
        let sections = usize::from(u16_at(&header, 6));
        let optional = u64::from(u16_at(&header, 20));
        if sections == 0 || sections > 96 || !(60..=4096).contains(&optional) {
            return Err(fail("bootstrap_image_invalid"));
        }
        let opt = read_at(&mut file, pe + 24, optional as usize)?;
        if u16_at(&opt, 0) != 0x20b {
            return Err(fail("bootstrap_image_invalid"));
        }
        let image_size = u64::from(u32_at(&opt, 56));
        let table = read_at(&mut file, pe + 24 + optional, sections * 40)?;
        let mut patches = Vec::new();
        for patch in &self.patches {
            if read_at(&mut file, patch.file_offset, patch.expected.len())? != patch.expected {
                return Err(fail("bootstrap_original_changed"));
            }
            let end = patch.file_offset + patch.expected.len() as u64;
            let mut matches = Vec::new();
            for section in table.chunks_exact(40) {
                let raw = u64::from(u32_at(section, 20));
                let raw_size = u64::from(u32_at(section, 16));
                let flags = u32_at(section, 36);
                if patch.file_offset >= raw && end <= raw + raw_size {
                    // No instruction patches: only file-backed initialized data.
                    if flags & 0x40 == 0 || flags & 0x20000020 != 0 {
                        return Err(fail("bootstrap_executable_patch_denied"));
                    }
                    let rva = u64::from(u32_at(section, 12)) + patch.file_offset - raw;
                    if rva + patch.expected.len() as u64 > image_size {
                        return Err(fail("bootstrap_image_invalid"));
                    }
                    matches.push(rva as usize);
                }
            }
            if matches.len() != 1 {
                return Err(fail("bootstrap_image_invalid"));
            }
            patches.push(PreparedPatch {
                rva: matches[0],
                expected: patch.expected.clone(),
                replacement: patch.replacement.clone(),
            });
        }
        Ok(PreparedModule {
            _file: file,
            identity,
            patches,
        })
    }
}

enum Command {
    Restore,
    Abort,
}
pub(crate) struct BootstrapSession {
    commands: SyncSender<Command>,
    patched: Receiver<Result<()>>,
    done: Receiver<Result<()>>,
    worker: Option<JoinHandle<()>>,
    completed: bool,
}
impl BootstrapSession {
    pub(crate) fn arm(
        child: &SuspendedChild,
        executable: &Path,
        plan: ModuleDataPlan,
        deadline: Instant,
    ) -> Result<Self> {
        let prepared = plan.prepare(executable, deadline)?;
        let process = child
            .process
            .try_clone()
            .map_err(|_| fail("bootstrap_process_unavailable"))?;
        let pid = child.pid;
        let (commands, rx) = mpsc::sync_channel(1);
        let (armed_tx, armed) = mpsc::sync_channel(1);
        let (patched_tx, patched) = mpsc::sync_channel(1);
        let (done_tx, done) = mpsc::sync_channel(1);
        let worker = std::thread::Builder::new()
            .name("codlet-owned-bootstrap".into())
            .spawn(move || {
                let result =
                    debug_owned(process, pid, prepared, deadline, rx, &armed_tx, &patched_tx);
                if let Err(error) = &result {
                    let _ = armed_tx.try_send(Err(fail(error.code)));
                    let _ = patched_tx.try_send(Err(fail(error.code)));
                }
                let _ = done_tx.send(result);
            })
            .map_err(|_| fail("bootstrap_worker_failed"))?;
        let session = Self {
            commands,
            patched,
            done,
            worker: Some(worker),
            completed: false,
        };
        armed
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| fail("bootstrap_timeout"))??;
        Ok(session)
    }
    pub(crate) fn wait_patched(&self, deadline: Instant) -> Result<()> {
        self.patched
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| fail("bootstrap_timeout"))?
    }
    pub(crate) fn restore(mut self, deadline: Instant) -> Result<()> {
        self.commands
            .send(Command::Restore)
            .map_err(|_| fail("bootstrap_worker_failed"))?;
        let result = self
            .done
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| fail("bootstrap_timeout"))?;
        self.completed = true;
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        result
    }
}
impl Drop for BootstrapSession {
    fn drop(&mut self) {
        if !self.completed {
            let _ = self.commands.try_send(Command::Abort);
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn read_memory(process: HANDLE, address: usize, size: usize) -> Result<Vec<u8>> {
    let mut result = vec![0; size];
    let mut count = 0;
    if unsafe {
        ReadProcessMemory(
            process,
            address as _,
            result.as_mut_ptr().cast(),
            size,
            &mut count,
        )
    } == 0
        || count != size
    {
        return Err(win32("bootstrap_memory_read_failed"));
    }
    Ok(result)
}
fn write_memory(
    process: HANDLE,
    address: usize,
    expected: &[u8],
    replacement: &[u8],
) -> Result<()> {
    let mut region = MEMORY_BASIC_INFORMATION::default();
    // A malformed PE table cannot turn a declared data edit into an instruction
    // patch. Also reject edits crossing regions with different protections.
    if unsafe {
        VirtualQueryEx(
            process,
            address as _,
            &mut region,
            std::mem::size_of_val(&region),
        )
    } == 0
        || region.State != MEM_COMMIT
        || region.Type != MEM_IMAGE
        || region.Protect & (0xf0 | PAGE_GUARD | PAGE_NOACCESS) != 0
        || address
            .checked_add(replacement.len())
            .is_none_or(|end| end > (region.BaseAddress as usize).saturating_add(region.RegionSize))
    {
        return Err(fail("bootstrap_executable_patch_denied"));
    }
    if read_memory(process, address, expected.len())? != expected {
        return Err(fail("bootstrap_memory_changed"));
    }
    let mut original = 0;
    if unsafe {
        VirtualProtectEx(
            process,
            address as _,
            replacement.len(),
            PAGE_READWRITE,
            &mut original,
        )
    } == 0
    {
        return Err(win32("bootstrap_memory_protection_failed"));
    }
    let mut count = 0;
    let written = unsafe {
        WriteProcessMemory(
            process,
            address as _,
            replacement.as_ptr().cast(),
            replacement.len(),
            &mut count,
        )
    };
    let mut ignored = 0;
    let restored = unsafe {
        VirtualProtectEx(
            process,
            address as _,
            replacement.len(),
            original,
            &mut ignored,
        )
    };
    if written == 0 || count != replacement.len() || restored == 0 {
        return Err(win32("bootstrap_memory_write_failed"));
    }
    if read_memory(process, address, replacement.len())? != replacement {
        return Err(fail("bootstrap_memory_changed"));
    }
    Ok(())
}

fn debug_owned(
    process: OwnedHandle,
    pid: u32,
    module: PreparedModule,
    deadline: Instant,
    commands: Receiver<Command>,
    armed: &SyncSender<Result<()>>,
    patched: &SyncSender<Result<()>>,
) -> Result<()> {
    let handle = process.as_raw_handle().cast();
    let mut attached = false;
    let mut debug_process: Option<OwnedHandle> = None;
    let mut threads = BTreeMap::<u32, OwnedHandle>::new();
    let result = (|| {
        if unsafe { DebugActiveProcess(pid) } == 0 {
            return Err(win32("bootstrap_debugger_denied"));
        }
        attached = true;
        if unsafe { DebugSetProcessKillOnExit(1) } == 0 {
            return Err(win32("bootstrap_debugger_failed"));
        }
        armed
            .send(Ok(()))
            .map_err(|_| fail("bootstrap_cancelled"))?;
        let mut applied = Vec::<(usize, PreparedPatch)>::new();
        let mut initial_break = false;
        let mut restore_requested = false;
        let mut break_sent = false;
        let mut loaded_base = None;
        loop {
            if Instant::now() >= deadline {
                return Err(fail("bootstrap_timeout"));
            }
            match commands.try_recv() {
                Ok(Command::Restore) => restore_requested = true,
                Ok(Command::Abort) | Err(mpsc::TryRecvError::Disconnected) => {
                    return Err(fail("bootstrap_cancelled"));
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
            if restore_requested && initial_break && !break_sent {
                if applied.len() != module.patches.len() {
                    return Err(fail("bootstrap_incomplete"));
                }
                if unsafe { DebugBreakProcess(handle) } == 0 {
                    return Err(win32("bootstrap_restore_failed"));
                }
                break_sent = true;
            }
            let mut event = DEBUG_EVENT::default();
            if unsafe { WaitForDebugEvent(&mut event, 50) } == 0 {
                if unsafe { GetLastError() } == ERROR_SEM_TIMEOUT {
                    continue;
                }
                return Err(win32("bootstrap_debugger_failed"));
            }
            let mut disposition = 0x00010002;
            let mut complete = false;
            let outcome = (|| {
                if event.dwProcessId != pid {
                    return Err(fail("bootstrap_process_changed"));
                }
                let mut image = None;
                match event.dwDebugEventCode {
                    CREATE_PROCESS_DEBUG_EVENT => {
                        let info = unsafe { event.u.CreateProcessInfo };
                        debug_process =
                            Some(unsafe { OwnedHandle::from_raw_handle(info.hProcess) });
                        threads.insert(event.dwThreadId, unsafe {
                            OwnedHandle::from_raw_handle(info.hThread)
                        });
                        image = Some((info.hFile, info.lpBaseOfImage as usize));
                    }
                    CREATE_THREAD_DEBUG_EVENT => {
                        threads.insert(event.dwThreadId, unsafe {
                            OwnedHandle::from_raw_handle(event.u.CreateThread.hThread)
                        });
                    }
                    EXIT_THREAD_DEBUG_EVENT => {
                        if let Some(thread) = threads.remove(&event.dwThreadId) {
                            let _ = thread.into_raw_handle();
                        }
                    }
                    EXIT_PROCESS_DEBUG_EVENT => {
                        if let Some(p) = debug_process.take() {
                            let _ = p.into_raw_handle();
                        }
                        for (_, t) in std::mem::take(&mut threads) {
                            let _ = t.into_raw_handle();
                        }
                        return Err(fail("bootstrap_client_exited"));
                    }
                    LOAD_DLL_DEBUG_EVENT => {
                        let info = unsafe { event.u.LoadDll };
                        image = Some((info.hFile, info.lpBaseOfDll as usize));
                    }
                    UNLOAD_DLL_DEBUG_EVENT => {
                        if loaded_base == Some(unsafe { event.u.UnloadDll.lpBaseOfDll } as usize) {
                            return Err(fail("bootstrap_image_unloaded"));
                        }
                    }
                    EXCEPTION_DEBUG_EVENT => {
                        let code = unsafe { event.u.Exception.ExceptionRecord.ExceptionCode };
                        if code == 0x80000003_u32 as i32 && !initial_break {
                            initial_break = true;
                        } else if code == 0x80000003_u32 as i32 && break_sent {
                            for (address, patch) in applied.iter().rev() {
                                write_memory(
                                    handle,
                                    *address,
                                    &patch.replacement,
                                    &patch.expected,
                                )?;
                            }
                            complete = true;
                        } else {
                            disposition = 0x80010001_u32 as i32;
                        }
                    }
                    _ => {}
                }
                if let Some((file, base)) = image.filter(|(file, _)| !file.is_null()) {
                    let identity = file_identity(file);
                    unsafe { CloseHandle(file) };
                    if identity.ok() == Some(module.identity) {
                        if !applied.is_empty() {
                            return Err(fail("bootstrap_image_ambiguous"));
                        }
                        loaded_base = Some(base);
                        for patch in &module.patches {
                            let address = base
                                .checked_add(patch.rva)
                                .ok_or_else(|| fail("bootstrap_image_invalid"))?;
                            write_memory(handle, address, &patch.expected, &patch.replacement)?;
                            applied.push((address, patch.clone()));
                        }
                        patched
                            .send(Ok(()))
                            .map_err(|_| fail("bootstrap_cancelled"))?;
                    }
                }
                Ok(())
            })();
            // Reject while suspended, before letting a partially edited client run.
            if outcome.is_err() {
                unsafe { TerminateProcess(handle, 1) };
            }
            if unsafe { ContinueDebugEvent(event.dwProcessId, event.dwThreadId, disposition) } == 0
            {
                return Err(win32("bootstrap_debugger_failed"));
            }
            outcome?;
            if complete {
                if unsafe { DebugActiveProcessStop(pid) } == 0 {
                    return Err(win32("bootstrap_detach_failed"));
                }
                attached = false;
                return Ok(());
            }
        }
    })();
    if result.is_err() {
        unsafe { TerminateProcess(handle, 1) };
        if attached {
            unsafe { DebugActiveProcessStop(pid) };
        }
    }
    result
}
