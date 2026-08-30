use std::fs::File;
use std::mem::size_of;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

use thiserror::Error;
use windows_sys::Win32::Foundation::{
    GetLastError, HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::Pipes::CreatePipe;

#[derive(Debug, Error)]
pub enum PipeError {
    #[error("{operation} failed with Win32 error {code}")]
    Win32 { operation: &'static str, code: u32 },
}

pub struct ParentCdpPipes {
    reader: File,
    writer: File,
}

impl ParentCdpPipes {
    pub(crate) fn into_parts(self) -> (File, File) {
        (self.reader, self.writer)
    }
}

pub(crate) struct CdpPipes {
    pub(crate) parent_reader: File,
    pub(crate) parent_writer: File,
    pub(crate) child_reader: OwnedHandle,
    pub(crate) child_writer: OwnedHandle,
}

impl CdpPipes {
    pub(crate) fn create() -> Result<Self, PipeError> {
        let (child_reader, parent_writer) = create_inheritable_pipe()?;
        clear_inherit_flag(&parent_writer)?;
        let (parent_reader, child_writer) = create_inheritable_pipe()?;
        clear_inherit_flag(&parent_reader)?;

        Ok(Self {
            parent_reader: File::from(parent_reader),
            parent_writer: File::from(parent_writer),
            child_reader,
            child_writer,
        })
    }

    pub(crate) fn child_handles(&self) -> [HANDLE; 2] {
        [
            raw_handle(&self.child_reader),
            raw_handle(&self.child_writer),
        ]
    }

    pub(crate) fn into_parent(self) -> ParentCdpPipes {
        let Self {
            parent_reader,
            parent_writer,
            child_reader,
            child_writer,
        } = self;
        drop(child_reader);
        drop(child_writer);
        ParentCdpPipes {
            reader: parent_reader,
            writer: parent_writer,
        }
    }
}

fn create_inheritable_pipe() -> Result<(OwnedHandle, OwnedHandle), PipeError> {
    let mut read = std::ptr::null_mut();
    let mut write = std::ptr::null_mut();
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: 1,
    };
    // SAFETY: output pointers and the initialized SECURITY_ATTRIBUTES remain valid for the call.
    if unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) } == 0 {
        return Err(last_error("CreatePipe"));
    }
    // SAFETY: CreatePipe returned two owned, non-null handles.
    Ok(unsafe {
        (
            OwnedHandle::from_raw_handle(read.cast()),
            OwnedHandle::from_raw_handle(write.cast()),
        )
    })
}

fn clear_inherit_flag(handle: &OwnedHandle) -> Result<(), PipeError> {
    // SAFETY: handle is live for this call.
    if unsafe { SetHandleInformation(raw_handle(handle), HANDLE_FLAG_INHERIT, 0) } == 0 {
        Err(last_error("SetHandleInformation"))
    } else {
        Ok(())
    }
}

pub(crate) fn raw_handle(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle().cast()
}

fn last_error(operation: &'static str) -> PipeError {
    // SAFETY: GetLastError has no preconditions and is called immediately after failure.
    let code = unsafe { GetLastError() };
    PipeError::Win32 { operation, code }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::Foundation::{GetHandleInformation, HANDLE_FLAGS};

    fn flags(handle: HANDLE) -> HANDLE_FLAGS {
        let mut flags = 0;
        // SAFETY: tests pass handles owned by the live CdpPipes value.
        assert_ne!(unsafe { GetHandleInformation(handle, &mut flags) }, 0);
        flags
    }

    #[test]
    fn only_child_pipe_ends_are_marked_inheritable() {
        let pipes = CdpPipes::create().unwrap();
        assert_eq!(
            flags(pipes.parent_reader.as_raw_handle().cast()) & HANDLE_FLAG_INHERIT,
            0
        );
        assert_eq!(
            flags(pipes.parent_writer.as_raw_handle().cast()) & HANDLE_FLAG_INHERIT,
            0
        );
        for child in pipes.child_handles() {
            assert_ne!(flags(child) & HANDLE_FLAG_INHERIT, 0);
        }
    }
}
