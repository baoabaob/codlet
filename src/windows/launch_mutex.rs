use std::ffi::{OsStr, OsString};
use std::fmt::Write as _;
use std::marker::PhantomData;
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::rc::Rc;
use std::time::Duration;

use thiserror::Error;
use windows_sys::Win32::Foundation::{
    ERROR_INSUFFICIENT_BUFFER, GetLastError, HANDLE, WAIT_ABANDONED, WAIT_FAILED, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::{
    GetLengthSid, GetTokenInformation, IsValidSid, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::System::Threading::{
    CreateMutexW, GetCurrentProcess, OpenProcessToken, ReleaseMutex, WaitForSingleObject,
};

const MUTEX_PREFIX: &str = r"Global\Codlet.CodexLaunch.";

#[derive(Debug, Error)]
pub enum LaunchMutexError {
    #[error("launch mutex wait duration exceeds the Win32 millisecond range")]
    WaitDurationTooLarge,
    #[error("launch mutex name contains an embedded NUL")]
    EmbeddedNul,
    #[error("{operation} failed with Win32 error {code}")]
    Win32 { operation: &'static str, code: u32 },
    #[error("{operation} returned invalid data: {reason}")]
    InvalidOsData {
        operation: &'static str,
        reason: String,
    },
    #[error("timed out waiting for the per-user Codlet launch mutex")]
    Timeout,
}

pub struct LaunchMutexGuard {
    handle: OwnedHandle,
    _thread_affine: PhantomData<Rc<()>>,
}

impl LaunchMutexGuard {
    pub fn acquire_current_user(timeout: Duration) -> Result<Self, LaunchMutexError> {
        let name = current_user_mutex_name()?;
        Self::acquire_named(&name, timeout)
    }

    pub(crate) fn acquire_named(name: &OsStr, timeout: Duration) -> Result<Self, LaunchMutexError> {
        let milliseconds = u32::try_from(timeout.as_millis())
            .map_err(|_| LaunchMutexError::WaitDurationTooLarge)?;
        let mut name: Vec<_> = name.encode_wide().collect();
        if name.contains(&0) {
            return Err(LaunchMutexError::EmbeddedNul);
        }
        name.push(0);

        // SAFETY: the NUL-terminated name remains live for the call; default security is requested.
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err(last_error("CreateMutexW"));
        }
        // SAFETY: CreateMutexW returned a newly owned handle.
        let handle = unsafe { OwnedHandle::from_raw_handle(handle.cast()) };

        // SAFETY: handle is a live mutex handle and the timeout fits u32.
        match unsafe { WaitForSingleObject(raw_handle(&handle), milliseconds) } {
            WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(Self {
                handle,
                _thread_affine: PhantomData,
            }),
            WAIT_TIMEOUT => Err(LaunchMutexError::Timeout),
            WAIT_FAILED => Err(last_error("WaitForSingleObject(launch mutex)")),
            other => Err(LaunchMutexError::InvalidOsData {
                operation: "WaitForSingleObject(launch mutex)",
                reason: format!("unexpected wait result {other}"),
            }),
        }
    }
}

impl Drop for LaunchMutexGuard {
    fn drop(&mut self) {
        // SAFETY: acquisition returned WAIT_OBJECT_0 or WAIT_ABANDONED, so this thread owns it.
        let released = unsafe { ReleaseMutex(raw_handle(&self.handle)) };
        debug_assert_ne!(released, 0, "ReleaseMutex failed for an owned launch mutex");
    }
}

fn current_user_mutex_name() -> Result<OsString, LaunchMutexError> {
    let sid = current_user_sid_bytes()?;
    let mut suffix = String::with_capacity(sid.len() * 2);
    for byte in sid {
        write!(&mut suffix, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(OsString::from(format!("{MUTEX_PREFIX}{suffix}")))
}

pub(crate) fn current_user_sid_bytes() -> Result<Vec<u8>, LaunchMutexError> {
    // SAFETY: GetCurrentProcess returns the calling process pseudo-handle.
    process_user_sid_bytes(unsafe { GetCurrentProcess() })
}

pub(crate) fn process_user_sid_bytes(process: HANDLE) -> Result<Vec<u8>, LaunchMutexError> {
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: GetCurrentProcess returns a process pseudo-handle; token points to writable storage.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(last_error("OpenProcessToken"));
    }
    // SAFETY: OpenProcessToken returned a newly owned handle.
    let token = unsafe { OwnedHandle::from_raw_handle(token.cast()) };

    let mut required = 0_u32;
    // SAFETY: the null-buffer call queries the required TOKEN_USER size.
    let queried = unsafe {
        GetTokenInformation(
            raw_handle(&token),
            TokenUser,
            std::ptr::null_mut(),
            0,
            &mut required,
        )
    };
    // SAFETY: called immediately after the size query.
    let size_error = unsafe { GetLastError() };
    if queried != 0 || size_error != ERROR_INSUFFICIENT_BUFFER || required == 0 {
        return Err(LaunchMutexError::Win32 {
            operation: "GetTokenInformation(size)",
            code: size_error,
        });
    }

    let required = usize::try_from(required).map_err(|_| LaunchMutexError::InvalidOsData {
        operation: "GetTokenInformation(size)",
        reason: "TOKEN_USER size does not fit usize".to_owned(),
    })?;
    let word_size = size_of::<usize>();
    let words =
        required
            .checked_add(word_size - 1)
            .ok_or_else(|| LaunchMutexError::InvalidOsData {
                operation: "GetTokenInformation(size)",
                reason: "TOKEN_USER buffer size overflow".to_owned(),
            })?
            / word_size;
    let mut storage = vec![0_usize; words];
    let mut returned = u32::try_from(required).expect("required originated as u32");
    // SAFETY: storage is suitably aligned and provides at least required writable bytes.
    if unsafe {
        GetTokenInformation(
            raw_handle(&token),
            TokenUser,
            storage.as_mut_ptr().cast(),
            returned,
            &mut returned,
        )
    } == 0
    {
        return Err(last_error("GetTokenInformation(data)"));
    }

    // SAFETY: GetTokenInformation wrote a TOKEN_USER at the start of the aligned buffer.
    let token_user = unsafe { &*storage.as_ptr().cast::<TOKEN_USER>() };
    // SAFETY: the SID pointer comes from the validated TOKEN_USER returned above.
    if unsafe { IsValidSid(token_user.User.Sid) } == 0 {
        return Err(LaunchMutexError::InvalidOsData {
            operation: "GetTokenInformation(data)",
            reason: "TOKEN_USER contains an invalid SID".to_owned(),
        });
    }
    // SAFETY: IsValidSid accepted the SID pointer.
    let sid_length = unsafe { GetLengthSid(token_user.User.Sid) } as usize;
    let buffer_start = storage.as_ptr() as usize;
    let buffer_end = buffer_start
        .checked_add(storage.len() * word_size)
        .expect("allocated TOKEN_USER buffer size cannot overflow");
    let sid_start = token_user.User.Sid as usize;
    let sid_end =
        sid_start
            .checked_add(sid_length)
            .ok_or_else(|| LaunchMutexError::InvalidOsData {
                operation: "GetLengthSid",
                reason: "SID address range overflow".to_owned(),
            })?;
    if sid_length == 0 || sid_start < buffer_start || sid_end > buffer_end {
        return Err(LaunchMutexError::InvalidOsData {
            operation: "GetLengthSid",
            reason: "SID lies outside the TOKEN_USER buffer".to_owned(),
        });
    }
    // SAFETY: the range was checked to lie inside the live token-information buffer.
    Ok(unsafe { std::slice::from_raw_parts(token_user.User.Sid.cast(), sid_length) }.to_vec())
}

fn raw_handle(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle().cast()
}

fn last_error(operation: &'static str) -> LaunchMutexError {
    // SAFETY: GetLastError has no preconditions and is called immediately after failure.
    let code = unsafe { GetLastError() };
    LaunchMutexError::Win32 { operation, code }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};

    #[test]
    fn current_user_mutex_name_is_global_and_sid_scoped() {
        let name = current_user_mutex_name().unwrap();
        let name = name.to_string_lossy();
        assert!(name.starts_with(MUTEX_PREFIX));
        assert!(
            name[MUTEX_PREFIX.len()..]
                .chars()
                .all(|character| character.is_ascii_hexdigit())
        );
    }

    #[test]
    fn named_launch_mutex_serializes_concurrent_attempts() {
        let name = OsString::from(format!(
            r"Local\Codlet.MutexTest.{}.{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("unnamed")
        ));
        let barrier = Arc::new(Barrier::new(3));
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let name = name.clone();
                let barrier = Arc::clone(&barrier);
                let active = Arc::clone(&active);
                let maximum = Arc::clone(&maximum);
                std::thread::spawn(move || {
                    barrier.wait();
                    let _guard =
                        LaunchMutexGuard::acquire_named(&name, Duration::from_secs(2)).unwrap();
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    maximum.fetch_max(now, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(30));
                    active.fetch_sub(1, Ordering::SeqCst);
                })
            })
            .collect();
        barrier.wait();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(maximum.load(Ordering::SeqCst), 1);
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }
}
