use std::ffi::{OsStr, OsString};
use std::fmt;
use std::mem::size_of;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Component, Path, PathBuf};
use std::ptr::{null_mut, read_unaligned};

use thiserror::Error;
use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, WIN32_ERROR};
use windows_sys::Win32::Storage::Packaging::Appx::{
    GetPackagePathByFullName, GetPackagesByPackageFamily, PACKAGE_ID, PACKAGE_INFORMATION_BASIC,
    PACKAGE_VERSION, PackageIdFromFullName,
};

pub const CODEX_PACKAGE_FAMILY: &str = "OpenAI.Codex_2p2nqsd0c76g0";
pub const CODEX_EXECUTABLE_RELATIVE_PATH: &str = r"app\ChatGPT.exe";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PackageVersion {
    pub major: u16,
    pub minor: u16,
    pub build: u16,
    pub revision: u16,
}

impl fmt::Display for PackageVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{}.{}.{}.{}",
            self.major, self.minor, self.build, self.revision
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledPackage {
    pub family_name: String,
    pub full_name: String,
    pub install_location: PathBuf,
    pub version: PackageVersion,
}

#[derive(Debug, Error)]
pub enum PackageError {
    #[error("{field} contains an embedded NUL")]
    EmbeddedNul { field: &'static str },
    #[error("{operation} failed with Win32 error {code}")]
    Win32 {
        operation: &'static str,
        code: WIN32_ERROR,
    },
    #[error("{operation} returned invalid data: {reason}")]
    InvalidOsData {
        operation: &'static str,
        reason: String,
    },
    #[error("package family {0} is not installed for the current user")]
    NotFound(String),
    #[error("package family {family} resolved to {count} packages; refusing to guess")]
    Ambiguous { family: String, count: usize },
    #[error("package install location does not resolve to a directory: {0}")]
    InvalidInstallLocation(PathBuf),
    #[error("package executable path must contain only normal relative components: {0}")]
    InvalidRelativeExecutable(PathBuf),
    #[error("package executable does not resolve to a file: {0}")]
    ExecutableNotFound(PathBuf),
    #[error("resolved executable escaped package install root: {0}")]
    ExecutableOutsidePackage(PathBuf),
    #[error("failed to resolve {path}: {source}")]
    Canonicalize {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

pub fn find_current_user_packages(
    family_name: &str,
) -> Result<Vec<InstalledPackage>, PackageError> {
    let family_wide = wide_nul(OsStr::new(family_name), "package family name")?;
    let full_names = query_full_names(&family_wide)?;
    full_names
        .into_iter()
        .map(|full_name| {
            let full_name_wide = wide_nul(OsStr::new(&full_name), "package full name")?;
            Ok(InstalledPackage {
                family_name: family_name.to_owned(),
                install_location: query_install_location(&full_name_wide)?,
                version: query_version(&full_name_wide)?,
                full_name,
            })
        })
        .collect()
}

pub fn find_unique_current_user_package(
    family_name: &str,
) -> Result<InstalledPackage, PackageError> {
    let packages = find_current_user_packages(family_name)?;
    match packages.len() {
        0 => Err(PackageError::NotFound(family_name.to_owned())),
        1 => Ok(packages.into_iter().next().unwrap()),
        count => Err(PackageError::Ambiguous {
            family: family_name.to_owned(),
            count,
        }),
    }
}

pub fn resolve_package_executable(
    package: &InstalledPackage,
    relative_path: &Path,
) -> Result<PathBuf, PackageError> {
    if relative_path.as_os_str().is_empty()
        || !relative_path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(PackageError::InvalidRelativeExecutable(
            relative_path.to_owned(),
        ));
    }

    let root =
        package
            .install_location
            .canonicalize()
            .map_err(|source| PackageError::Canonicalize {
                path: package.install_location.clone(),
                source,
            })?;
    if !root.is_dir() {
        return Err(PackageError::InvalidInstallLocation(root));
    }

    let requested = root.join(relative_path);
    let executable = requested
        .canonicalize()
        .map_err(|source| PackageError::Canonicalize {
            path: requested,
            source,
        })?;
    if !executable.starts_with(&root) {
        return Err(PackageError::ExecutableOutsidePackage(executable));
    }
    if !executable.is_file() {
        return Err(PackageError::ExecutableNotFound(executable));
    }
    Ok(executable)
}

fn query_full_names(family_name: &[u16]) -> Result<Vec<String>, PackageError> {
    let mut count = 0_u32;
    let mut buffer_length = 0_u32;
    // SAFETY: both size outputs are valid and the null buffers request their required sizes.
    let first = unsafe {
        GetPackagesByPackageFamily(
            family_name.as_ptr(),
            &mut count,
            null_mut(),
            &mut buffer_length,
            null_mut(),
        )
    };
    if first == ERROR_SUCCESS && count == 0 {
        return Ok(Vec::new());
    }
    expect_size_query(
        "GetPackagesByPackageFamily(size)",
        first,
        count,
        buffer_length,
    )?;

    let pointer_count = usize::try_from(count).map_err(|_| {
        invalid_os_data(
            "GetPackagesByPackageFamily(size)",
            "package count does not fit usize",
        )
    })?;
    let character_count = usize::try_from(buffer_length).map_err(|_| {
        invalid_os_data(
            "GetPackagesByPackageFamily(size)",
            "buffer length does not fit usize",
        )
    })?;
    let mut pointers = vec![null_mut(); pointer_count];
    let mut buffer = vec![0_u16; character_count];

    // SAFETY: the buffers have exactly the capacities reported by the size query.
    let result = unsafe {
        GetPackagesByPackageFamily(
            family_name.as_ptr(),
            &mut count,
            pointers.as_mut_ptr(),
            &mut buffer_length,
            buffer.as_mut_ptr(),
        )
    };
    expect_success("GetPackagesByPackageFamily(data)", result)?;
    let returned_count = usize::try_from(count).map_err(|_| {
        invalid_os_data(
            "GetPackagesByPackageFamily(data)",
            "returned package count does not fit usize",
        )
    })?;
    let returned_length = usize::try_from(buffer_length).map_err(|_| {
        invalid_os_data(
            "GetPackagesByPackageFamily(data)",
            "returned buffer length does not fit usize",
        )
    })?;
    if returned_count > pointers.len() || returned_length > buffer.len() {
        return Err(invalid_os_data(
            "GetPackagesByPackageFamily(data)",
            "returned sizes exceed the supplied buffers",
        ));
    }

    pointers[..returned_count]
        .iter()
        .map(|&pointer| string_from_shared_buffer(pointer, &buffer[..returned_length]))
        .collect()
}

fn query_install_location(full_name: &[u16]) -> Result<PathBuf, PackageError> {
    let mut length = 0_u32;
    // SAFETY: the output length pointer is valid and a null buffer requests its required size.
    let first = unsafe { GetPackagePathByFullName(full_name.as_ptr(), &mut length, null_mut()) };
    if first != ERROR_INSUFFICIENT_BUFFER || length == 0 {
        return Err(PackageError::Win32 {
            operation: "GetPackagePathByFullName(size)",
            code: first,
        });
    }
    let character_count = usize::try_from(length).map_err(|_| {
        invalid_os_data(
            "GetPackagePathByFullName(size)",
            "path length does not fit usize",
        )
    })?;
    let mut buffer = vec![0_u16; character_count];
    // SAFETY: the buffer has the capacity reported by the size query.
    let result =
        unsafe { GetPackagePathByFullName(full_name.as_ptr(), &mut length, buffer.as_mut_ptr()) };
    expect_success("GetPackagePathByFullName(data)", result)?;
    let returned_length = usize::try_from(length).map_err(|_| {
        invalid_os_data(
            "GetPackagePathByFullName(data)",
            "returned path length does not fit usize",
        )
    })?;
    if returned_length == 0 || returned_length > buffer.len() {
        return Err(invalid_os_data(
            "GetPackagePathByFullName(data)",
            "returned path length is outside the supplied buffer",
        ));
    }
    let nul = buffer[..returned_length]
        .iter()
        .position(|&unit| unit == 0)
        .ok_or_else(|| {
            invalid_os_data(
                "GetPackagePathByFullName(data)",
                "path is not NUL terminated",
            )
        })?;
    Ok(PathBuf::from(OsString::from_wide(&buffer[..nul])))
}

fn query_version(full_name: &[u16]) -> Result<PackageVersion, PackageError> {
    let mut byte_length = 0_u32;
    // SAFETY: the output length pointer is valid and a null buffer requests its required size.
    let first = unsafe {
        PackageIdFromFullName(
            full_name.as_ptr(),
            PACKAGE_INFORMATION_BASIC,
            &mut byte_length,
            null_mut(),
        )
    };
    if first != ERROR_INSUFFICIENT_BUFFER || byte_length == 0 {
        return Err(PackageError::Win32 {
            operation: "PackageIdFromFullName(size)",
            code: first,
        });
    }
    let bytes = usize::try_from(byte_length).map_err(|_| {
        invalid_os_data(
            "PackageIdFromFullName(size)",
            "buffer length does not fit usize",
        )
    })?;
    let word_size = size_of::<usize>();
    let words = bytes
        .checked_add(word_size - 1)
        .ok_or_else(|| invalid_os_data("PackageIdFromFullName(size)", "buffer length overflow"))?
        / word_size;
    let mut storage = vec![0_usize; words];
    // SAFETY: usize storage supplies sufficient alignment and at least byte_length writable bytes.
    let result = unsafe {
        PackageIdFromFullName(
            full_name.as_ptr(),
            PACKAGE_INFORMATION_BASIC,
            &mut byte_length,
            storage.as_mut_ptr().cast(),
        )
    };
    expect_success("PackageIdFromFullName(data)", result)?;
    let returned_bytes = usize::try_from(byte_length).map_err(|_| {
        invalid_os_data(
            "PackageIdFromFullName(data)",
            "returned buffer length does not fit usize",
        )
    })?;
    if returned_bytes < size_of::<PACKAGE_ID>() || returned_bytes > storage.len() * word_size {
        return Err(invalid_os_data(
            "PackageIdFromFullName(data)",
            "returned buffer length is outside the supplied storage",
        ));
    }

    // SAFETY: the checked, aligned output starts with a complete PACKAGE_ID. The generated
    // structure is packed on x64, so copy the version field without forming an aligned reference.
    let version: PACKAGE_VERSION = unsafe {
        let package_id = storage.as_ptr().cast::<PACKAGE_ID>();
        read_unaligned(std::ptr::addr_of!((*package_id).version))
    };
    // SAFETY: PACKAGE_VERSION is a Win32 union and the component view is always valid.
    let components = unsafe { version.Anonymous.Anonymous };
    Ok(PackageVersion {
        major: components.Major,
        minor: components.Minor,
        build: components.Build,
        revision: components.Revision,
    })
}

fn string_from_shared_buffer(pointer: *mut u16, buffer: &[u16]) -> Result<String, PackageError> {
    if pointer.is_null() || buffer.is_empty() {
        return Err(invalid_os_data(
            "GetPackagesByPackageFamily(data)",
            "package name pointer is null or the shared buffer is empty",
        ));
    }
    let start = buffer.as_ptr() as usize;
    let byte_length = buffer.len().checked_mul(size_of::<u16>()).ok_or_else(|| {
        invalid_os_data(
            "GetPackagesByPackageFamily(data)",
            "shared buffer length overflow",
        )
    })?;
    let end = start.checked_add(byte_length).ok_or_else(|| {
        invalid_os_data(
            "GetPackagesByPackageFamily(data)",
            "shared buffer address overflow",
        )
    })?;
    let address = pointer as usize;
    if address < start || address >= end || !(address - start).is_multiple_of(size_of::<u16>()) {
        return Err(invalid_os_data(
            "GetPackagesByPackageFamily(data)",
            "package name pointer is outside the shared buffer",
        ));
    }
    let offset = (address - start) / size_of::<u16>();
    let tail = &buffer[offset..];
    let nul = tail.iter().position(|&unit| unit == 0).ok_or_else(|| {
        invalid_os_data(
            "GetPackagesByPackageFamily(data)",
            "package full name is not NUL terminated",
        )
    })?;
    String::from_utf16(&tail[..nul]).map_err(|error| {
        invalid_os_data(
            "GetPackagesByPackageFamily(data)",
            format!("package full name is not valid UTF-16: {error}"),
        )
    })
}

fn wide_nul(value: &OsStr, field: &'static str) -> Result<Vec<u16>, PackageError> {
    let mut encoded: Vec<_> = value.encode_wide().collect();
    if encoded.contains(&0) {
        return Err(PackageError::EmbeddedNul { field });
    }
    encoded.push(0);
    Ok(encoded)
}

fn expect_size_query(
    operation: &'static str,
    code: WIN32_ERROR,
    count: u32,
    length: u32,
) -> Result<(), PackageError> {
    if code == ERROR_INSUFFICIENT_BUFFER && count > 0 && length > 0 {
        Ok(())
    } else {
        Err(PackageError::Win32 { operation, code })
    }
}

fn expect_success(operation: &'static str, code: WIN32_ERROR) -> Result<(), PackageError> {
    if code == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(PackageError::Win32 { operation, code })
    }
}

fn invalid_os_data(operation: &'static str, reason: impl Into<String>) -> PackageError {
    PackageError::InvalidOsData {
        operation,
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn rejects_executable_parent_traversal() {
        let package = InstalledPackage {
            family_name: "family".to_owned(),
            full_name: "full".to_owned(),
            install_location: PathBuf::from(r"C:\package"),
            version: PackageVersion {
                major: 1,
                minor: 0,
                build: 0,
                revision: 0,
            },
        };
        assert!(matches!(
            resolve_package_executable(&package, Path::new(r"..\outside.exe")),
            Err(PackageError::InvalidRelativeExecutable(_))
        ));
    }

    #[test]
    fn resolves_existing_file_inside_package_root() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join("app")).unwrap();
        fs::write(directory.path().join(r"app\child.exe"), b"fake").unwrap();
        let package = InstalledPackage {
            family_name: "family".to_owned(),
            full_name: "full".to_owned(),
            install_location: directory.path().to_owned(),
            version: PackageVersion {
                major: 1,
                minor: 2,
                build: 3,
                revision: 4,
            },
        };
        assert_eq!(
            resolve_package_executable(&package, Path::new(r"app\child.exe")).unwrap(),
            directory
                .path()
                .join(r"app\child.exe")
                .canonicalize()
                .unwrap()
        );
    }
}
