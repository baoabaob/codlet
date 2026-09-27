//! Per-child Unicode environment construction. Never mutates the host process environment.
use std::cmp::Ordering;
use std::ffi::{OsStr, OsString};
use std::os::windows::ffi::{OsStrExt, OsStringExt};

use thiserror::Error;
use windows_sys::Win32::Globalization::{CSTR_EQUAL, CSTR_LESS_THAN, CompareStringOrdinal};
use windows_sys::Win32::System::Environment::{FreeEnvironmentStringsW, GetEnvironmentStringsW};

const MAX_ENVIRONMENT_UNITS: usize = 1024 * 1024;

#[derive(Debug, Error)]
pub enum EnvironmentError {
    #[error("child environment contains an invalid variable name")]
    InvalidName,
    #[error("child environment value contains NUL")]
    InvalidValue,
    #[error("child environment exceeds the UTF-16 size limit")]
    TooLarge,
    #[error("inherited Windows environment entry has no name/value separator")]
    MissingSeparator,
    #[error("failed to read the Windows environment: {0}")]
    Read(#[from] std::io::Error),
}

#[derive(Debug, Clone)]
pub struct ChildEnvironment {
    entries: Vec<(Vec<u16>, Vec<u16>)>,
}

impl ChildEnvironment {
    pub fn inherited() -> Result<Self, EnvironmentError> {
        // SAFETY: Windows returns an owned, double-NUL terminated environment block.
        let pointer = unsafe { GetEnvironmentStringsW() };
        if pointer.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        struct Block(*mut u16);
        impl Drop for Block {
            fn drop(&mut self) {
                unsafe {
                    FreeEnvironmentStringsW(self.0);
                }
            }
        }
        let block = Block(pointer);
        let mut entries = Vec::new();
        let mut offset = 0;
        loop {
            if offset >= MAX_ENVIRONMENT_UNITS {
                return Err(EnvironmentError::TooLarge);
            }
            if unsafe { *block.0.add(offset) } == 0 {
                break;
            }
            let start = offset;
            while unsafe { *block.0.add(offset) } != 0 {
                offset += 1;
                if offset >= MAX_ENVIRONMENT_UNITS {
                    return Err(EnvironmentError::TooLarge);
                }
            }
            let entry = unsafe { std::slice::from_raw_parts(block.0.add(start), offset - start) };
            // Native shell metadata (=C:, =ExitCode, etc.) starts with '='.
            // Its first '=' belongs to the name, not the name/value separator.
            let split = entry
                .iter()
                .enumerate()
                .skip(1)
                .find(|(_, unit)| **unit == b'=' as u16)
                .map(|(index, _)| index)
                .ok_or(EnvironmentError::MissingSeparator)?;
            entries.push((
                OsString::from_wide(&entry[..split]),
                OsString::from_wide(&entry[split + 1..]),
            ));
            offset += 1;
        }
        Self::from_entries(entries)
    }

    pub fn from_entries(
        entries: impl IntoIterator<Item = (OsString, OsString)>,
    ) -> Result<Self, EnvironmentError> {
        let mut environment = Self {
            entries: Vec::new(),
        };
        for (name, value) in entries {
            environment.set(&name, &value)?;
        }
        Ok(environment)
    }

    pub fn set(&mut self, name: &OsStr, value: &OsStr) -> Result<(), EnvironmentError> {
        let name = valid_name(name)?;
        let value: Vec<_> = value.encode_wide().collect();
        if value.contains(&0) {
            return Err(EnvironmentError::InvalidValue);
        }
        if value.len() > MAX_ENVIRONMENT_UNITS {
            return Err(EnvironmentError::TooLarge);
        }
        self.entries
            .retain(|(current, _)| compare_names(current, &name) != Ordering::Equal);
        self.entries.push((name, value));
        Ok(())
    }

    pub fn remove(&mut self, name: &OsStr) -> Result<(), EnvironmentError> {
        let name = valid_name(name)?;
        self.entries
            .retain(|(current, _)| compare_names(current, &name) != Ordering::Equal);
        Ok(())
    }

    pub fn names(&self) -> Vec<OsString> {
        self.entries
            .iter()
            .map(|(name, _)| OsString::from_wide(name))
            .collect()
    }

    pub(crate) fn entries_os(&self) -> Vec<(OsString, OsString)> {
        self.entries
            .iter()
            .map(|(name, value)| (OsString::from_wide(name), OsString::from_wide(value)))
            .collect()
    }

    pub(crate) fn block(&self) -> Result<Vec<u16>, EnvironmentError> {
        let mut entries: Vec<_> = self.entries.iter().collect();
        entries.sort_by(|(left, _), (right, _)| compare_names(left, right));
        let length = entries
            .iter()
            .try_fold(1_usize, |sum, (name, value)| {
                sum.checked_add(name.len() + value.len() + 2)
            })
            .ok_or(EnvironmentError::TooLarge)?;
        if length > MAX_ENVIRONMENT_UNITS {
            return Err(EnvironmentError::TooLarge);
        }
        let mut block = Vec::with_capacity(length.max(2));
        for (name, value) in entries {
            block.extend_from_slice(name);
            block.push(b'=' as u16);
            block.extend_from_slice(value);
            block.push(0);
        }
        if block.is_empty() {
            block.push(0);
        }
        block.push(0);
        Ok(block)
    }
}

fn valid_name(name: &OsStr) -> Result<Vec<u16>, EnvironmentError> {
    let name: Vec<_> = name.encode_wide().collect();
    // CreateProcessW's native block can contain shell-owned hidden names, not
    // just drive directories. Preserve them through the package helper too.
    // Exactly one leading '=' is allowed; any additional '=' is a separator.
    let logical_name = name.strip_prefix(&[b'=' as u16]).unwrap_or(&name);
    if name.len() > 32767 {
        return Err(EnvironmentError::TooLarge);
    }
    if logical_name.is_empty() || name.contains(&0) || logical_name.contains(&(b'=' as u16)) {
        return Err(EnvironmentError::InvalidName);
    }
    Ok(name)
}

fn compare_names(left: &[u16], right: &[u16]) -> Ordering {
    // SAFETY: lengths fit i32 and buffers contain exactly that many UTF-16 units.
    match unsafe {
        CompareStringOrdinal(
            left.as_ptr(),
            left.len() as i32,
            right.as_ptr(),
            right.len() as i32,
            1,
        )
    } {
        CSTR_EQUAL => Ordering::Equal,
        CSTR_LESS_THAN => Ordering::Less,
        _ => Ordering::Greater,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;

    #[test]
    fn shell_metadata_survives_helper_environment_round_trip() {
        let entries = [
            (OsString::from("=ExitCode"), OsString::from("00000007")),
            (OsString::from("=C:"), OsString::from(r"C:\fixture")),
            (OsString::from("=::"), OsString::from(r"::\")),
            (OsString::from("NORMAL"), OsString::from("保留=🙂")),
            (
                OsString::from_wide(&[0xd800]),
                OsString::from_wide(&[0xdc00]),
            ),
        ];
        let original = ChildEnvironment::from_entries(entries).unwrap();
        // The package helper reconstructs these entries in another process.
        let received = ChildEnvironment::from_entries(original.entries_os()).unwrap();
        assert_eq!(original.block().unwrap(), received.block().unwrap());
        assert!(received.names().contains(&OsString::from("=ExitCode")));
        assert!(received.entries_os().contains(&(
            OsString::from_wide(&[0xd800]),
            OsString::from_wide(&[0xdc00])
        )));
    }

    #[test]
    fn inherits_real_cmd_environment_after_external_exit() {
        const CHILD: &str = "CODLET_ENVIRONMENT_TEST_CHILD";
        if std::env::var_os(CHILD).is_some() {
            let inherited = ChildEnvironment::inherited().unwrap();
            assert!(
                inherited
                    .entries_os()
                    .contains(&(OsString::from("=ExitCode"), OsString::from("00000007")))
            );
            let received = ChildEnvironment::from_entries(inherited.entries_os()).unwrap();
            assert!(
                inherited.block().unwrap() == received.block().unwrap(),
                "helper round trip changed inherited metadata"
            );
            return;
        }
        let executable = std::env::current_exe().unwrap();
        let output = std::process::Command::new("cmd.exe")
            .args(["/d", "/c"])
            .raw_arg(format!(
                "cmd.exe /d /c exit 7 & \"{}\" --exact windows::environment::tests::inherits_real_cmd_environment_after_external_exit --nocapture",
                executable.display()
            ))
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn unicode_environment_has_case_insensitive_overrides_removals_and_double_nul() {
        let mut environment = ChildEnvironment::from_entries([
            (OsString::from("Path"), OsString::from("first")),
            (OsString::from("KEEP"), OsString::from("保留🙂")),
            (OsString::from("drop"), OsString::from("secret fixture")),
            (OsString::from("=C:"), OsString::from(r"C:\fixture")),
        ])
        .unwrap();
        environment
            .set(OsStr::new("PATH"), OsStr::new("新值"))
            .unwrap();
        environment
            .set(OsStr::new("EMPTY"), OsStr::new(""))
            .unwrap();
        environment.remove(OsStr::new("DROP")).unwrap();
        let block = environment.block().unwrap();
        assert_eq!(&block[block.len() - 2..], &[0, 0]);
        assert_eq!(
            String::from_utf16(&block).unwrap(),
            "=C:=C:\\fixture\0EMPTY=\0KEEP=保留🙂\0PATH=新值\0\0"
        );
        assert_eq!(
            ChildEnvironment::from_entries([]).unwrap().block().unwrap(),
            [0, 0]
        );
        for name in ["", "=", "==", "=bad=name", "bad=name", "bad\0name"] {
            assert!(environment.set(OsStr::new(name), OsStr::new("x")).is_err());
        }
        assert!(matches!(
            environment.set(OsStr::new("VALUE"), OsStr::new("a\0b")),
            Err(EnvironmentError::InvalidValue)
        ));
    }
}
