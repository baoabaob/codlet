use std::ffi::{OsStr, OsString};
use std::mem::size_of;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::time::Duration;

use thiserror::Error;
use windows_sys::Win32::Foundation::{
    APPMODEL_ERROR_NO_PACKAGE, CloseHandle, ERROR_INSUFFICIENT_BUFFER, ERROR_NO_MORE_FILES,
    ERROR_SUCCESS, FILETIME, GetLastError, HANDLE, INVALID_HANDLE_VALUE, WAIT_FAILED,
    WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Storage::Packaging::Appx::GetPackageFamilyName;
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList,
    EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, GetProcessTimes,
    InitializeProcThreadAttributeList, OpenProcess, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
    STARTUPINFOEXW, UpdateProcThreadAttribute, WaitForSingleObject,
};

use super::environment::{ChildEnvironment, EnvironmentError};
use super::pipes::{CdpPipes, ParentCdpPipes};

#[derive(Debug, Error)]
pub enum ProcessError {
    #[error("executable path must be absolute: {0}")]
    ExecutableNotAbsolute(PathBuf),
    #[error("executable path does not resolve to a file: {0}")]
    ExecutableNotFound(PathBuf),
    #[error("executable path has no file name: {0}")]
    ExecutableNameMissing(PathBuf),
    #[error("{field} contains an embedded NUL")]
    EmbeddedNul { field: &'static str },
    #[error("{operation} failed with Win32 error {code}")]
    Win32 { operation: &'static str, code: u32 },
    #[error("{operation} returned invalid data: {reason}")]
    InvalidOsData {
        operation: &'static str,
        reason: String,
    },
    #[error(
        "could not inspect candidate process {process_id} during {operation}: Win32 error {code}; refusing launch"
    )]
    CandidateProcessInspection {
        process_id: u32,
        operation: &'static str,
        code: u32,
    },
    #[error("wait duration exceeds the Win32 millisecond range")]
    WaitDurationTooLarge,
    #[error(transparent)]
    Pipe(#[from] super::pipes::PipeError),
    #[error(transparent)]
    Environment(#[from] EnvironmentError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunningProcess {
    pub process_id: u32,
    pub executable: PathBuf,
}

pub struct ChildProcess {
    handle: OwnedHandle,
    process_id: u32,
}

impl ChildProcess {
    pub fn process_id(&self) -> u32 {
        self.process_id
    }

    /// Creation identity from this exact retained process handle (Windows FILETIME units).
    pub fn creation_time_filetime(&self) -> Result<u64, ProcessError> {
        let mut times: [FILETIME; 4] = unsafe { std::mem::zeroed() };
        let [created, exited, kernel, user] = &mut times;
        if unsafe { GetProcessTimes(raw_handle(&self.handle), created, exited, kernel, user) } == 0
        {
            return Err(last_error("GetProcessTimes(owned child)"));
        }
        Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }

    pub fn wait(&self, timeout: Duration) -> Result<Option<u32>, ProcessError> {
        let milliseconds =
            u32::try_from(timeout.as_millis()).map_err(|_| ProcessError::WaitDurationTooLarge)?;
        // SAFETY: self owns a live process handle.
        match unsafe { WaitForSingleObject(raw_handle(&self.handle), milliseconds) } {
            WAIT_OBJECT_0 => {
                let mut exit_code = 0_u32;
                // SAFETY: self owns a live process handle and exit_code is writable.
                if unsafe { GetExitCodeProcess(raw_handle(&self.handle), &mut exit_code) } == 0 {
                    Err(last_error("GetExitCodeProcess"))
                } else {
                    Ok(Some(exit_code))
                }
            }
            WAIT_TIMEOUT => Ok(None),
            WAIT_FAILED => Err(last_error("WaitForSingleObject")),
            other => Err(ProcessError::InvalidOsData {
                operation: "WaitForSingleObject",
                reason: format!("unexpected wait result {other}"),
            }),
        }
    }
}

pub fn launch_with_cdp_pipes(
    executable: &Path,
    arguments: &[OsString],
    no_window: bool,
) -> Result<(ChildProcess, ParentCdpPipes), ProcessError> {
    launch_with_cdp_pipes_in_environment(executable, arguments, no_window, None, None)
}

/// The supplied environment and CWD apply only to the newly created child.
/// None preserves the normal launcher's existing inheritance behavior.
pub fn launch_with_cdp_pipes_in_environment(
    executable: &Path,
    arguments: &[OsString],
    no_window: bool,
    environment: Option<&ChildEnvironment>,
    current_directory: Option<&Path>,
) -> Result<(ChildProcess, ParentCdpPipes), ProcessError> {
    if !executable.is_absolute() {
        return Err(ProcessError::ExecutableNotAbsolute(executable.to_owned()));
    }
    if !executable.is_file() {
        return Err(ProcessError::ExecutableNotFound(executable.to_owned()));
    }
    let mut environment_block = environment.map(ChildEnvironment::block).transpose()?;
    let directory = current_directory
        .map(|directory| {
            if !directory.is_absolute() || !directory.is_dir() {
                return Err(ProcessError::InvalidOsData {
                    operation: "validate child current directory",
                    reason: "directory must be an existing absolute path".to_owned(),
                });
            }
            wide_nul(directory.as_os_str(), "child current directory")
        })
        .transpose()?;

    let pipes = CdpPipes::create()?;
    let child_handles = pipes.child_handles();
    let mut child_arguments = arguments.to_vec();
    child_arguments.push(OsString::from("--remote-debugging-pipe=JSON"));
    child_arguments.push(OsString::from(format!(
        "--remote-debugging-io-pipes={},{}",
        child_handles[0] as usize, child_handles[1] as usize
    )));

    let application_name = wide_nul(executable.as_os_str(), "executable path")?;
    let mut command_line = build_command_line(executable.as_os_str(), &child_arguments)?;
    let attribute_list = AttributeList::with_handle_list(&child_handles)?;
    // SAFETY: Win32 STARTUPINFOEXW is initialized by zeroing before setting cb and attributes.
    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.lpAttributeList = attribute_list.pointer;
    // SAFETY: PROCESS_INFORMATION is an output-only POD structure for CreateProcessW.
    let mut process_information: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let mut creation_flags = EXTENDED_STARTUPINFO_PRESENT;
    if environment_block.is_some() {
        creation_flags |= CREATE_UNICODE_ENVIRONMENT;
    }
    if no_window {
        creation_flags |= CREATE_NO_WINDOW;
    }

    // SAFETY: all pointers target initialized storage that remains live through CreateProcessW.
    let created = unsafe {
        CreateProcessW(
            application_name.as_ptr(),
            command_line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
            creation_flags,
            environment_block
                .as_mut()
                .map_or(std::ptr::null(), |block| block.as_mut_ptr().cast()),
            directory
                .as_ref()
                .map_or(std::ptr::null(), |directory| directory.as_ptr()),
            &startup.StartupInfo,
            &mut process_information,
        )
    };
    if created == 0 {
        return Err(last_error("CreateProcessW"));
    }

    // SAFETY: successful CreateProcessW returned two independently owned handles.
    let process = unsafe { OwnedHandle::from_raw_handle(process_information.hProcess.cast()) };
    // SAFETY: the primary thread handle is not needed after process creation.
    unsafe { CloseHandle(process_information.hThread) };
    let parent_pipes = pipes.into_parent();
    Ok((
        ChildProcess {
            handle: process,
            process_id: process_information.dwProcessId,
        },
        parent_pipes,
    ))
}

pub fn running_processes_for_package(
    family_name: &str,
    executable: &Path,
) -> Result<Vec<RunningProcess>, ProcessError> {
    if family_name.encode_utf16().any(|unit| unit == 0) {
        return Err(ProcessError::EmbeddedNul {
            field: "package family name",
        });
    }
    let expected = executable
        .canonicalize()
        .map_err(|_| ProcessError::ExecutableNotFound(executable.to_owned()))?;
    let expected_name = expected
        .file_name()
        .ok_or_else(|| ProcessError::ExecutableNameMissing(expected.clone()))?;
    // SAFETY: CreateToolhelp32Snapshot has no pointer preconditions.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(last_error("CreateToolhelp32Snapshot"));
    }
    // SAFETY: snapshot is a newly owned handle.
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot.cast()) };
    // SAFETY: PROCESSENTRY32W is initialized by zeroing and setting its required dwSize field.
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut matches = Vec::new();

    // SAFETY: snapshot and the initialized entry pointer are valid.
    if unsafe { Process32FirstW(raw_handle(&snapshot), &mut entry) } == 0 {
        let code = unsafe { GetLastError() };
        if code == ERROR_NO_MORE_FILES {
            return Ok(matches);
        }
        return Err(ProcessError::Win32 {
            operation: "Process32FirstW",
            code,
        });
    }

    loop {
        let entry_name = process_entry_name(&entry)?;
        if os_strings_equal_ascii_case_insensitive(&entry_name, expected_name) {
            let process = open_candidate_process(entry.th32ProcessID)?;
            if query_process_package_family(&process, entry.th32ProcessID)?
                .is_some_and(|candidate| candidate.eq_ignore_ascii_case(family_name))
            {
                matches.push(RunningProcess {
                    process_id: entry.th32ProcessID,
                    executable: query_process_path(&process, entry.th32ProcessID)?,
                });
            }
        }
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        // SAFETY: snapshot and entry remain valid for enumeration.
        if unsafe { Process32NextW(raw_handle(&snapshot), &mut entry) } == 0 {
            let code = unsafe { GetLastError() };
            if code == ERROR_NO_MORE_FILES {
                break;
            }
            return Err(ProcessError::Win32 {
                operation: "Process32NextW",
                code,
            });
        }
    }
    Ok(matches)
}

fn open_candidate_process(process_id: u32) -> Result<OwnedHandle, ProcessError> {
    // SAFETY: OpenProcess receives a PID from the process snapshot.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
    if handle.is_null() {
        // SAFETY: called immediately after OpenProcess failed.
        return Err(ProcessError::CandidateProcessInspection {
            process_id,
            operation: "OpenProcess",
            code: unsafe { GetLastError() },
        });
    }
    // SAFETY: OpenProcess returned an owned handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle.cast()) })
}

fn query_process_package_family(
    handle: &OwnedHandle,
    process_id: u32,
) -> Result<Option<String>, ProcessError> {
    let mut length = 0_u32;
    // SAFETY: the process handle is live and a null buffer requests the required size.
    let first =
        unsafe { GetPackageFamilyName(raw_handle(handle), &mut length, std::ptr::null_mut()) };
    if first == APPMODEL_ERROR_NO_PACKAGE {
        return Ok(None);
    }
    if first != ERROR_INSUFFICIENT_BUFFER || length == 0 {
        return Err(ProcessError::CandidateProcessInspection {
            process_id,
            operation: "GetPackageFamilyName(size)",
            code: first,
        });
    }
    let character_count = usize::try_from(length).map_err(|_| ProcessError::InvalidOsData {
        operation: "GetPackageFamilyName(size)",
        reason: format!("process {process_id} family-name length does not fit usize"),
    })?;
    let mut buffer = vec![0_u16; character_count];
    // SAFETY: the buffer has the capacity reported by the size query and the handle is live.
    let result =
        unsafe { GetPackageFamilyName(raw_handle(handle), &mut length, buffer.as_mut_ptr()) };
    if result != ERROR_SUCCESS {
        return Err(ProcessError::CandidateProcessInspection {
            process_id,
            operation: "GetPackageFamilyName(data)",
            code: result,
        });
    }
    let returned_length = usize::try_from(length).map_err(|_| ProcessError::InvalidOsData {
        operation: "GetPackageFamilyName(data)",
        reason: format!("process {process_id} family-name length does not fit usize"),
    })?;
    if returned_length == 0 || returned_length > buffer.len() {
        return Err(ProcessError::InvalidOsData {
            operation: "GetPackageFamilyName(data)",
            reason: format!("process {process_id} returned a length outside the supplied buffer"),
        });
    }
    let nul = buffer[..returned_length]
        .iter()
        .position(|&unit| unit == 0)
        .ok_or_else(|| ProcessError::InvalidOsData {
            operation: "GetPackageFamilyName(data)",
            reason: format!("process {process_id} returned a non-NUL-terminated family name"),
        })?;
    let family_name =
        String::from_utf16(&buffer[..nul]).map_err(|error| ProcessError::InvalidOsData {
            operation: "GetPackageFamilyName(data)",
            reason: format!("process {process_id} returned invalid UTF-16: {error}"),
        })?;
    Ok(Some(family_name))
}

fn query_process_path(handle: &OwnedHandle, process_id: u32) -> Result<PathBuf, ProcessError> {
    let mut buffer = vec![0_u16; 32_768];
    let mut length = buffer.len() as u32;
    // SAFETY: buffer and length describe writable storage; handle is live.
    if unsafe {
        QueryFullProcessImageNameW(raw_handle(handle), 0, buffer.as_mut_ptr(), &mut length)
    } == 0
    {
        // SAFETY: called immediately after QueryFullProcessImageNameW failed.
        return Err(ProcessError::CandidateProcessInspection {
            process_id,
            operation: "QueryFullProcessImageNameW",
            code: unsafe { GetLastError() },
        });
    }
    let length = usize::try_from(length).map_err(|_| ProcessError::InvalidOsData {
        operation: "QueryFullProcessImageNameW",
        reason: "path length does not fit usize".to_owned(),
    })?;
    if length == 0 || length > buffer.len() {
        return Err(ProcessError::InvalidOsData {
            operation: "QueryFullProcessImageNameW",
            reason: "returned path length is outside the supplied buffer".to_owned(),
        });
    }
    Ok(PathBuf::from(OsString::from_wide(&buffer[..length])))
}

fn process_entry_name(entry: &PROCESSENTRY32W) -> Result<OsString, ProcessError> {
    let length = entry
        .szExeFile
        .iter()
        .position(|&unit| unit == 0)
        .ok_or_else(|| ProcessError::InvalidOsData {
            operation: "Process32FirstW/Process32NextW",
            reason: "candidate executable name is not NUL terminated".to_owned(),
        })?;
    Ok(OsString::from_wide(&entry.szExeFile[..length]))
}

pub(crate) struct AttributeList {
    _storage: Vec<usize>,
    pub(crate) pointer: *mut core::ffi::c_void,
}

impl AttributeList {
    pub(crate) fn with_handle_list(handles: &[HANDLE]) -> Result<Self, ProcessError> {
        let mut byte_length = 0_usize;
        // SAFETY: a null list is the documented size-query form.
        unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut byte_length) };
        if byte_length == 0 {
            return Err(last_error("InitializeProcThreadAttributeList(size)"));
        }
        let word_size = size_of::<usize>();
        let words = byte_length
            .checked_add(word_size - 1)
            .ok_or(ProcessError::InvalidOsData {
                operation: "InitializeProcThreadAttributeList(size)",
                reason: "attribute buffer length overflow".to_owned(),
            })?
            / word_size;
        let mut storage = vec![0_usize; words];
        let pointer = storage.as_mut_ptr().cast();
        // SAFETY: pointer refers to byte_length bytes of suitably aligned writable storage.
        if unsafe { InitializeProcThreadAttributeList(pointer, 1, 0, &mut byte_length) } == 0 {
            return Err(last_error("InitializeProcThreadAttributeList(data)"));
        }
        // SAFETY: the initialized list and handle slice remain live through process creation.
        if unsafe {
            UpdateProcThreadAttribute(
                pointer,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr().cast(),
                std::mem::size_of_val(handles),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        } == 0
        {
            // SAFETY: initialization succeeded above.
            unsafe { DeleteProcThreadAttributeList(pointer) };
            return Err(last_error("UpdateProcThreadAttribute(handle list)"));
        }
        Ok(Self {
            _storage: storage,
            pointer,
        })
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        // SAFETY: pointer was initialized successfully and has not been deleted.
        unsafe { DeleteProcThreadAttributeList(self.pointer) };
    }
}

pub(crate) fn build_command_line(
    executable: &OsStr,
    arguments: &[OsString],
) -> Result<Vec<u16>, ProcessError> {
    let mut command_line = Vec::new();
    append_quoted_argument(&mut command_line, executable, "executable path")?;
    for argument in arguments {
        command_line.push(b' ' as u16);
        append_quoted_argument(&mut command_line, argument, "process argument")?;
    }
    command_line.push(0);
    Ok(command_line)
}

fn append_quoted_argument(
    output: &mut Vec<u16>,
    argument: &OsStr,
    field: &'static str,
) -> Result<(), ProcessError> {
    let units: Vec<_> = argument.encode_wide().collect();
    if units.contains(&0) {
        return Err(ProcessError::EmbeddedNul { field });
    }
    output.push(b'"' as u16);
    let mut backslashes = 0_usize;
    for unit in units {
        if unit == b'\\' as u16 {
            backslashes += 1;
        } else if unit == b'"' as u16 {
            output.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2 + 1));
            output.push(unit);
            backslashes = 0;
        } else {
            output.extend(std::iter::repeat_n(b'\\' as u16, backslashes));
            backslashes = 0;
            output.push(unit);
        }
    }
    output.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2));
    output.push(b'"' as u16);
    Ok(())
}

fn wide_nul(value: &OsStr, field: &'static str) -> Result<Vec<u16>, ProcessError> {
    let mut encoded: Vec<_> = value.encode_wide().collect();
    if encoded.contains(&0) {
        return Err(ProcessError::EmbeddedNul { field });
    }
    encoded.push(0);
    Ok(encoded)
}

fn os_strings_equal_ascii_case_insensitive(left: &OsStr, right: &OsStr) -> bool {
    let left: Vec<_> = left.encode_wide().collect();
    let right: Vec<_> = right.encode_wide().collect();
    wide_units_equal_ascii_case_insensitive(&left, &right)
}

fn wide_units_equal_ascii_case_insensitive(left: &[u16], right: &[u16]) -> bool {
    let fold = |unit: u16| {
        if unit >= b'A' as u16 && unit <= b'Z' as u16 {
            unit + (b'a' - b'A') as u16
        } else {
            unit
        }
    };
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .all(|(&left, &right)| fold(left) == fold(right))
}

fn raw_handle(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle().cast()
}

fn last_error(operation: &'static str) -> ProcessError {
    // SAFETY: GetLastError has no preconditions and is called immediately after failure.
    let code = unsafe { GetLastError() };
    ProcessError::Win32 { operation, code }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_line_quotes_spaces_quotes_and_trailing_backslashes() {
        let command = build_command_line(
            OsStr::new(r"C:\Program Files\fake.exe"),
            &[
                OsString::from("plain"),
                OsString::from("a b"),
                OsString::from("quoted\"value"),
                OsString::from(r"tail\"),
            ],
        )
        .unwrap();
        let text = String::from_utf16(&command[..command.len() - 1]).unwrap();
        assert_eq!(
            text,
            r#""C:\Program Files\fake.exe" "plain" "a b" "quoted\"value" "tail\\""#
        );
    }

    #[test]
    fn ascii_case_insensitive_name_comparison_is_exact_otherwise() {
        assert!(os_strings_equal_ascii_case_insensitive(
            OsStr::new("ChatGPT.EXE"),
            OsStr::new("chatgpt.exe")
        ));
        assert!(!os_strings_equal_ascii_case_insensitive(
            OsStr::new("ChatGPT.exe"),
            OsStr::new("Other.exe")
        ));
    }

    #[test]
    fn running_process_scan_rejects_path_without_file_name() {
        assert!(matches!(
            running_processes_for_package("test_family", Path::new(r"C:\")),
            Err(ProcessError::ExecutableNameMissing(_))
        ));
    }
}
