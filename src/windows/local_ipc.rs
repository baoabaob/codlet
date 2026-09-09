//! Private transport primitives shared by the read-only status and control endpoints.
//! This layer knows framing and process identity; it cannot execute runtime work.
use std::ffi::{OsStr, OsString};
use std::io;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use thiserror::Error;
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, OPEN_EXISTING,
    PIPE_ACCESS_DUPLEX, ReadFile, SECURITY_ANONYMOUS, SECURITY_SQOS_PRESENT, WriteFile,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId, GetNamedPipeServerProcessId,
    PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    QueryFullProcessImageNameW, ResetEvent, WaitForMultipleObjects, WaitForSingleObject,
};

use super::launch_mutex::{current_user_sid_bytes, process_user_sid_bytes};

#[derive(Debug, Error)]
pub enum LocalIpcError {
    #[error("{operation} failed with Win32 error {code}")]
    Win32 { operation: &'static str, code: u32 },
    #[error("local IPC: {0}")]
    Invalid(String),
    #[error("local IPC deadline exceeded")]
    Timeout,
    #[error("local IPC is shutting down")]
    Stopping,
    #[error("local IPC worker: {0}")]
    Worker(#[from] io::Error),
}

pub(crate) fn create_server_pipe(name: &OsStr) -> Result<OwnedHandle, LocalIpcError> {
    let name = wide(name)?;
    let mut sid =
        current_user_sid_bytes().map_err(|error| LocalIpcError::Invalid(error.to_string()))?;
    let mut sid_text = std::ptr::null_mut();
    // SAFETY: the SID was copied from a validated token; output is LocalAlloc memory.
    if unsafe { ConvertSidToStringSidW(sid.as_mut_ptr().cast(), &mut sid_text) } == 0 {
        return Err(last_error("ConvertSidToStringSidW"));
    }
    let sid_text = LocalAllocation(sid_text.cast());
    let sid = unsafe {
        let pointer = sid_text.0.cast::<u16>();
        let length = (0..).take_while(|index| *pointer.add(*index) != 0).count();
        String::from_utf16_lossy(std::slice::from_raw_parts(pointer, length))
    };
    let sddl = wide(OsStr::new(&format!("D:P(A;;GA;;;{sid})")))?;
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: SDDL is NUL terminated; output receives a self-relative descriptor.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(last_error(
            "ConvertStringSecurityDescriptorToSecurityDescriptorW",
        ));
    }
    let descriptor = LocalAllocation(descriptor);
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    // SAFETY: names and descriptor remain live; the returned handle is non-inheritable.
    let pipe = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            4096,
            4096,
            0,
            &attributes,
        )
    };
    owned(pipe, "CreateNamedPipeW(first user instance)")
}

pub(crate) struct LocalAllocation(pub(crate) *mut std::ffi::c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

pub(crate) fn open_client(name: &OsStr) -> Result<OwnedHandle, LocalIpcError> {
    let name = wide(name)?;
    // Anonymous SQOS prevents a squatting server from impersonating this client.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_ANONYMOUS,
            std::ptr::null_mut(),
        )
    };
    owned(handle, "CreateFileW(local IPC client)")
}

#[derive(Clone, Copy)]
enum Peer {
    Server,
    Client,
}

/// A live process handle pins the peer identity for the complete transaction.
pub(crate) struct ServerIdentity {
    pub(crate) process: OwnedHandle,
    pub(crate) pid: u32,
    peer: Peer,
}
impl ServerIdentity {
    pub(crate) fn verify(pipe: &OwnedHandle, expected: &Path) -> Result<Self, LocalIpcError> {
        Self::verify_peer(pipe, expected, Peer::Server)
    }

    pub(crate) fn verify_client(
        pipe: &OwnedHandle,
        expected: &Path,
    ) -> Result<Self, LocalIpcError> {
        Self::verify_peer(pipe, expected, Peer::Client)
    }

    fn verify_peer(pipe: &OwnedHandle, expected: &Path, peer: Peer) -> Result<Self, LocalIpcError> {
        let pid = peer_pid(pipe, peer)?;
        let process = owned(
            unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                    0,
                    pid,
                )
            },
            "OpenProcess(local IPC peer)",
        )?;
        let identity = Self { process, pid, peer };
        identity.check_live(pipe)?;
        let sid = process_user_sid_bytes(raw(&identity.process))
            .map_err(|error| LocalIpcError::Invalid(error.to_string()))?;
        if sid
            != current_user_sid_bytes()
                .map_err(|error| LocalIpcError::Invalid(error.to_string()))?
        {
            return Err(LocalIpcError::Invalid(
                "pipe peer belongs to a different user".to_owned(),
            ));
        }
        let actual = process_image_path(raw(&identity.process))?;
        if !actual
            .as_os_str()
            .eq_ignore_ascii_case(expected.as_os_str())
        {
            return Err(LocalIpcError::Invalid(format!(
                "pipe peer executable {} differs from this Codlet build {}",
                actual.display(),
                expected.display(),
            )));
        }
        identity.check_live(pipe)?;
        Ok(identity)
    }

    pub(crate) fn check_live(&self, pipe: &OwnedHandle) -> Result<(), LocalIpcError> {
        if unsafe { WaitForSingleObject(raw(&self.process), 0) } != WAIT_TIMEOUT
            || peer_pid(pipe, self.peer)? != self.pid
        {
            return Err(LocalIpcError::Invalid(
                "pipe peer process ended or identity changed".to_owned(),
            ));
        }
        Ok(())
    }
}

pub(crate) fn process_image_path(process: HANDLE) -> Result<PathBuf, LocalIpcError> {
    // Use the image recorded by Windows, never a filesystem path supplied by a peer.
    let mut buffer = vec![0_u16; 32768];
    let mut size = buffer.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut size) } == 0 {
        return Err(last_error("QueryFullProcessImageNameW(local IPC identity)"));
    }
    Ok(PathBuf::from(OsString::from_wide(&buffer[..size as usize])))
}

fn peer_pid(pipe: &OwnedHandle, peer: Peer) -> Result<u32, LocalIpcError> {
    let mut pid = 0;
    let success = unsafe {
        match peer {
            Peer::Server => GetNamedPipeServerProcessId(raw(pipe), &mut pid),
            Peer::Client => GetNamedPipeClientProcessId(raw(pipe), &mut pid),
        }
    };
    if success == 0 {
        return Err(last_error("GetNamedPipePeerProcessId"));
    }
    if pid == 0 {
        return Err(LocalIpcError::Invalid("pipe peer PID is zero".to_owned()));
    }
    Ok(pid)
}

pub(crate) struct Channel {
    pub(crate) pipe: OwnedHandle,
    pub(crate) event: OwnedHandle,
    pub(crate) stop: Arc<OwnedHandle>,
}
impl Channel {
    /// One cancellable byte-stream read. Protocol-specific framing remains with
    /// the caller; None waits for input until the shared stop event is signaled.
    pub(crate) fn read_some(
        &self,
        bytes: &mut [u8],
        deadline: Option<Instant>,
    ) -> Result<usize, LocalIpcError> {
        self.operation(deadline, |overlapped| {
            Ok(unsafe {
                ReadFile(
                    raw(&self.pipe),
                    bytes.as_mut_ptr(),
                    bytes.len() as u32,
                    std::ptr::null_mut(),
                    overlapped,
                )
            } != 0)
        })
        .map(|count| count as usize)
    }

    pub(crate) fn is_stopping(&self) -> bool {
        unsafe { WaitForSingleObject(raw(&self.stop), 0) == WAIT_OBJECT_0 }
    }

    pub(crate) fn connect(&self) -> Result<(), LocalIpcError> {
        self.operation(None, |overlapped| {
            Ok(unsafe { ConnectNamedPipe(raw(&self.pipe), overlapped) } != 0)
        })
        .map(|_| ())
    }

    fn operation(
        &self,
        deadline: Option<Instant>,
        start: impl FnOnce(*mut OVERLAPPED) -> Result<bool, LocalIpcError>,
    ) -> Result<u32, LocalIpcError> {
        if self.is_stopping() {
            return Err(LocalIpcError::Stopping);
        }
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            return Err(LocalIpcError::Timeout);
        }
        unsafe {
            ResetEvent(raw(&self.event));
        }
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = raw(&self.event);
        let complete = start(&mut overlapped)?;
        if !complete {
            let code = unsafe { GetLastError() };
            // An already-connected client does not start overlapped IO.
            if code == ERROR_PIPE_CONNECTED {
                return Ok(0);
            }
            if code != ERROR_IO_PENDING {
                return Err(LocalIpcError::Win32 {
                    operation: "local pipe IO",
                    code,
                });
            }
            let wait_ms = deadline
                .map(|deadline| {
                    deadline
                        .saturating_duration_since(Instant::now())
                        .as_millis()
                        .min(u128::from(u32::MAX - 1)) as u32
                })
                .unwrap_or(u32::MAX);
            let handles = [raw(&self.stop), raw(&self.event)];
            let result = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, wait_ms) };
            if result != WAIT_OBJECT_0 + 1 {
                // Drain asynchronous cancellation before freeing OVERLAPPED or the buffer.
                unsafe {
                    CancelIoEx(raw(&self.pipe), &overlapped);
                }
                let mut transferred = 0;
                unsafe {
                    GetOverlappedResult(raw(&self.pipe), &overlapped, &mut transferred, 1);
                }
                return Err(match result {
                    WAIT_OBJECT_0 => LocalIpcError::Stopping,
                    WAIT_TIMEOUT => LocalIpcError::Timeout,
                    _ => {
                        LocalIpcError::Invalid(format!("unexpected local IO wait result {result}"))
                    }
                });
            }
        }
        let mut transferred = 0;
        if unsafe { GetOverlappedResult(raw(&self.pipe), &overlapped, &mut transferred, 0) } == 0 {
            return Err(last_error("GetOverlappedResult(local IPC)"));
        }
        Ok(transferred)
    }

    pub(crate) fn read_exact(
        &self,
        mut bytes: &mut [u8],
        deadline: Instant,
    ) -> Result<(), LocalIpcError> {
        while !bytes.is_empty() {
            let count = self.operation(Some(deadline), |overlapped| {
                Ok(unsafe {
                    ReadFile(
                        raw(&self.pipe),
                        bytes.as_mut_ptr(),
                        bytes.len() as u32,
                        std::ptr::null_mut(),
                        overlapped,
                    )
                } != 0)
            })? as usize;
            if count == 0 {
                return Err(LocalIpcError::Invalid(
                    "pipe closed during frame read".to_owned(),
                ));
            }
            bytes = &mut bytes[count..];
        }
        Ok(())
    }

    pub(crate) fn write_all(
        &self,
        mut bytes: &[u8],
        deadline: Instant,
    ) -> Result<(), LocalIpcError> {
        while !bytes.is_empty() {
            let count = self.operation(Some(deadline), |overlapped| {
                Ok(unsafe {
                    WriteFile(
                        raw(&self.pipe),
                        bytes.as_ptr(),
                        bytes.len() as u32,
                        std::ptr::null_mut(),
                        overlapped,
                    )
                } != 0)
            })? as usize;
            if count == 0 {
                return Err(LocalIpcError::Invalid(
                    "pipe closed during frame write".to_owned(),
                ));
            }
            bytes = &bytes[count..];
        }
        Ok(())
    }

    pub(crate) fn read_frame(
        &self,
        limit: usize,
        deadline: Instant,
    ) -> Result<Vec<u8>, LocalIpcError> {
        let mut length = [0; 4];
        self.read_exact(&mut length, deadline)?;
        let length = u32::from_le_bytes(length) as usize;
        if length == 0 || length > limit {
            return Err(LocalIpcError::Invalid(format!(
                "frame length {length} outside 1..={limit}"
            )));
        }
        let mut bytes = vec![0; length];
        self.read_exact(&mut bytes, deadline)?;
        Ok(bytes)
    }

    pub(crate) fn write_frame(&self, bytes: &[u8], deadline: Instant) -> Result<(), LocalIpcError> {
        self.write_all(&(bytes.len() as u32).to_le_bytes(), deadline)?;
        self.write_all(bytes, deadline)
    }
}

pub(crate) fn create_event() -> Result<OwnedHandle, LocalIpcError> {
    owned(
        unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) },
        "CreateEventW(local IPC)",
    )
}
fn wide(value: &OsStr) -> Result<Vec<u16>, LocalIpcError> {
    let mut value: Vec<_> = value.encode_wide().collect();
    if value.contains(&0) {
        return Err(LocalIpcError::Invalid("embedded NUL".to_owned()));
    }
    value.push(0);
    Ok(value)
}
fn owned(handle: HANDLE, operation: &'static str) -> Result<OwnedHandle, LocalIpcError> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(last_error(operation));
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(handle.cast()) })
}
pub(crate) fn raw(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle().cast()
}
fn last_error(operation: &'static str) -> LocalIpcError {
    LocalIpcError::Win32 {
        operation,
        code: unsafe { GetLastError() },
    }
}
