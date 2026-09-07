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
    #[error("child environment contains an invalid name, NUL, or oversized block")]
    Invalid,
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
                return Err(EnvironmentError::Invalid);
            }
            if unsafe { *block.0.add(offset) } == 0 {
                break;
            }
            let start = offset;
            while unsafe { *block.0.add(offset) } != 0 {
                offset += 1;
                if offset >= MAX_ENVIRONMENT_UNITS {
                    return Err(EnvironmentError::Invalid);
                }
            }
            let entry = unsafe { std::slice::from_raw_parts(block.0.add(start), offset - start) };
            // Drive-current-directory entries are =C:=path. Their first '=' is part of the name.
            let split = entry
                .iter()
                .enumerate()
                .skip(1)
                .find(|(_, unit)| **unit == b'=' as u16)
                .map(|(index, _)| index)
                .ok_or(EnvironmentError::Invalid)?;
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
        if value.contains(&0) || value.len() > MAX_ENVIRONMENT_UNITS {
            return Err(EnvironmentError::Invalid);
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
            .ok_or(EnvironmentError::Invalid)?;
        if length > MAX_ENVIRONMENT_UNITS {
            return Err(EnvironmentError::Invalid);
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
    let drive = name.len() == 3
        && name[0] == b'=' as u16
        && ((b'A' as u16..=b'Z' as u16).contains(&name[1])
            || (b'a' as u16..=b'z' as u16).contains(&name[1]))
        && name[2] == b':' as u16;
    if name.is_empty()
        || name.len() > 32767
        || name.contains(&0)
        || (!drive && name.contains(&(b'=' as u16)))
    {
        return Err(EnvironmentError::Invalid);
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
        for name in ["", "bad=name", "bad\0name"] {
            assert!(environment.set(OsStr::new(name), OsStr::new("x")).is_err());
        }
    }
}
