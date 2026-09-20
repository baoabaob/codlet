use std::fs::File;
#[cfg(windows)]
use std::fs::OpenOptions;
use std::io::Read;
#[cfg(windows)]
use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
#[cfg(windows)]
use std::path::Component;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Deserialize;
use serde_json::{Value, json};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_SHARE_READ, FILE_SHARE_WRITE, GetFileInformationByHandle, GetFinalPathNameByHandleW,
};

use super::{OsBrokerError, RequestGuard, Result, byte_limit, decode, invalid};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReadText {
    path: PathBuf,
    max_bytes: Option<usize>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReadDirectory {
    path: PathBuf,
    max_entries: Option<usize>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Stat {
    path: PathBuf,
}

pub(super) fn execute(endpoint: &str, params: Value, guard: &RequestGuard) -> Result<Value> {
    match endpoint {
        "host.fs.readText" => {
            let request: ReadText = decode(params)?;
            let limit = byte_limit(request.max_bytes)?;
            let mut selected = open_authorized(&request.path, guard)?;
            let metadata = selected.file.metadata().map_err(io_error)?;
            if !metadata.is_file() {
                return Err(invalid("readText expects a regular file"));
            }
            if metadata.len() > limit as u64 {
                return Err(too_large());
            }
            let mut bytes = Vec::with_capacity((metadata.len() as usize).min(limit));
            let mut chunk = [0; 8192];
            loop {
                guard.check()?;
                let count = selected.file.read(&mut chunk).map_err(io_error)?;
                if count == 0 {
                    break;
                }
                if bytes.len() + count > limit {
                    return Err(too_large());
                }
                bytes.extend_from_slice(&chunk[..count]);
            }
            let text = String::from_utf8(bytes).map_err(|_| {
                OsBrokerError::new("invalid_utf8", "readText requires UTF-8 file contents")
            })?;
            selected.check_location()?;
            Ok(json!({"bytes":text.len(),"text":text}))
        }
        "host.fs.readDir" => {
            let request: ReadDirectory = decode(params)?;
            let max = request.max_entries.unwrap_or(128);
            if !(1..=256).contains(&max) {
                return Err(invalid("maxEntries must be between 1 and 256"));
            }
            let selected = open_authorized(&request.path, guard)?;
            if !selected.file.metadata().map_err(io_error)?.is_dir() {
                return Err(invalid("readDir expects a directory"));
            }
            let mut entries = Vec::new();
            #[cfg(windows)]
            let mut truncated = false;
            #[cfg(windows)]
            for entry in std::fs::read_dir(&selected.path).map_err(io_error)? {
                guard.check()?;
                if entries.len() == max {
                    truncated = true;
                    break;
                }
                let entry = entry.map_err(io_error)?;
                let name = entry
                    .file_name()
                    .to_str()
                    .ok_or_else(|| invalid("readDir encountered a non-Unicode filename"))?
                    .to_owned();
                let kind = entry.file_type().map_err(io_error)?;
                entries.push(json!({"name":name,"kind":if kind.is_symlink() { "link" } else if kind.is_dir() { "directory" } else if kind.is_file() { "file" } else { "other" }}));
            }
            #[cfg(target_os = "macos")]
            let truncated = {
                let (children, truncated) =
                    crate::macos::filesystem::entries(&selected.file, max).map_err(io_error)?;
                for (name, kind) in children {
                    guard.check()?;
                    let name = name
                        .to_str()
                        .ok_or_else(|| invalid("readDir encountered a non-Unicode filename"))?;
                    entries.push(json!({"name":name,"kind":kind}));
                }
                truncated
            };
            selected.check_location()?;
            entries.sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));
            Ok(json!({"entries":entries,"truncated":truncated}))
        }
        "host.fs.stat" => {
            let request: Stat = decode(params)?;
            let selected = open_authorized(&request.path, guard)?;
            let metadata = selected.file.metadata().map_err(io_error)?;
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64);
            selected.check_location()?;
            Ok(
                json!({"kind":if metadata.is_dir(){"directory"}else{"file"},"bytes":metadata.len(),"modifiedUnixMs":modified}),
            )
        }
        _ => unreachable!(),
    }
}

pub(crate) struct Selected {
    pub(crate) file: File,
    pub(crate) path: PathBuf,
    _parents: Vec<File>,
}
impl Selected {
    pub(crate) fn check_location(&self) -> Result<()> {
        #[cfg(target_os = "macos")]
        if crate::macos::filesystem::final_path(&self.file).map_err(io_error)? != self.path {
            return Err(denied("The selected path moved during the broker request"));
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn lexical_path(path: &Path) -> Result<PathBuf> {
    crate::plugin_permissions::validate_policy_path(path).map_err(|e| invalid(e.to_string()))?;
    Ok(path.to_owned())
}
#[cfg(target_os = "macos")]
fn contains_path(root: &Path, path: &Path) -> bool {
    path.starts_with(root)
}
#[cfg(target_os = "macos")]
fn paths_equal(left: &Path, right: &Path) -> bool {
    left == right
}
#[cfg(target_os = "macos")]
fn pin_without_following(path: &Path) -> Result<Selected> {
    let pinned = crate::macos::filesystem::open_checked(path).map_err(io_error)?;
    Ok(Selected {
        file: pinned.file,
        path: pinned.path,
        _parents: pinned.parents,
    })
}

fn open_authorized(requested: &Path, guard: &RequestGuard) -> Result<Selected> {
    crate::plugin_permissions::validate_policy_path(requested)
        .map_err(|error| invalid(error.to_string()))?;
    let policy = &guard.authorization.0.registration.broker_policy;
    if policy.read_roots.is_empty() {
        return Err(denied("no readRoots were explicitly granted"));
    }
    let requested = lexical_path(requested)?;
    let root = policy
        .read_roots
        .iter()
        .filter(|root| contains_path(root, &requested))
        .max_by_key(|root| root.components().count())
        .ok_or_else(|| denied("path is outside the granted readRoots"))?;
    guard.check_full()?;
    let selected = pin_without_following(&requested)?;
    if !contains_path(root, &selected.path) {
        return Err(denied("the final open handle escaped its granted root"));
    }
    Ok(selected)
}

pub(crate) fn pin_exact_grant(requested: &Path, allowed: &[PathBuf]) -> Result<Selected> {
    let requested = lexical_path(requested)?;
    if !allowed
        .iter()
        .any(|allowed| paths_equal(allowed, &requested))
    {
        return Err(denied("path was not explicitly granted"));
    }
    pin_without_following(&requested)
}

pub(crate) fn pin_within_grants(requested: &Path, roots: &[PathBuf]) -> Result<Selected> {
    let path = lexical_path(requested)?;
    let root = roots
        .iter()
        .find(|root| contains_path(root, &path))
        .ok_or_else(|| denied("path is outside the explicitly granted roots"))?;
    let selected = pin_without_following(&path)?;
    if !contains_path(root, &selected.path) {
        return Err(denied("the open handle escaped its granted root"));
    }
    Ok(selected)
}

#[cfg(windows)]
fn pin_without_following(path: &Path) -> Result<Selected> {
    let path = lexical_path(path)?;
    let mut current = PathBuf::new();
    let mut parents = Vec::new();
    for component in path.components() {
        current.push(component);
        if matches!(component, Component::Prefix(_)) {
            continue;
        }
        // Every parent is retained without DELETE sharing before the next
        // component is opened. A reparse point is opened itself and rejected;
        // no canonicalize/metadata traversal can follow it to UNC or elsewhere.
        let file = open_pinned(&current)?;
        if !paths_equal(&final_path(&file)?, &current) {
            return Err(denied("a broker path redirected while opening its handles"));
        }
        parents.push(file);
    }
    let file = parents
        .pop()
        .ok_or_else(|| invalid("broker path has no local root"))?;
    let final_name = final_path(&file)?;
    if !paths_equal(&final_name, &path) {
        return Err(denied(
            "the selected handle does not match the granted path",
        ));
    }
    Ok(Selected {
        file,
        path: final_name,
        _parents: parents,
    })
}

#[cfg(windows)]
fn lexical_path(path: &Path) -> Result<PathBuf> {
    crate::plugin_permissions::validate_policy_path(path)
        .map_err(|error| invalid(error.to_string()))?;
    let text = path.to_str().expect("Unicode validated").replace('/', "\\");
    let disk = text.strip_prefix("\\\\?\\").unwrap_or(&text);
    // Drive letters are aliases even on a case-sensitive directory. Every
    // subsequent UTF-16 code unit must match the explicitly granted spelling:
    // folding a component could authorize a distinct NTFS case-sensitive path.
    let drive = disk.as_bytes()[0].to_ascii_uppercase() as char;
    let normalized = PathBuf::from(format!("\\\\?\\{drive}{}", &disk[1..]));
    crate::plugin_permissions::validate_policy_path(&normalized)
        .map_err(|error| invalid(error.to_string()))?;
    Ok(normalized)
}

#[cfg(windows)]
fn contains_path(root: &Path, path: &Path) -> bool {
    let (Ok(root), Ok(path)) = (lexical_path(root), lexical_path(path)) else {
        return false;
    };
    let mut actual = path.components();
    root.components().all(|component| {
        actual
            .next()
            .is_some_and(|actual| os_equal(component.as_os_str(), actual.as_os_str()))
    })
}

#[cfg(windows)]
fn paths_equal(left: &Path, right: &Path) -> bool {
    let (Ok(left), Ok(right)) = (lexical_path(left), lexical_path(right)) else {
        return false;
    };
    os_equal(left.as_os_str(), right.as_os_str())
}

#[cfg(windows)]
fn os_equal(left: &std::ffi::OsStr, right: &std::ffi::OsStr) -> bool {
    use std::os::windows::ffi::OsStrExt;
    left.encode_wide().eq(right.encode_wide())
}

#[cfg(windows)]
pub(super) fn open_pinned(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(io_error)?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut info) } == 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    if info.dwFileAttributes & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
        != 0
        || info.nNumberOfLinks > 1
    {
        return Err(denied(
            "broker handles reject reparse points and hard-linked files",
        ));
    }
    Ok(file)
}

#[cfg(windows)]
pub(super) fn final_path(file: &File) -> Result<PathBuf> {
    let mut buffer = vec![0_u16; 32768];
    let count = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle().cast(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    };
    if count == 0 || count as usize >= buffer.len() {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    use std::os::windows::ffi::OsStringExt;
    Ok(PathBuf::from(std::ffi::OsString::from_wide(
        &buffer[..count as usize],
    )))
}
fn denied(message: impl Into<String>) -> OsBrokerError {
    OsBrokerError::new("policy_denied", message)
}
fn io_error(error: std::io::Error) -> OsBrokerError {
    OsBrokerError::new("io_error", error.to_string())
}
fn too_large() -> OsBrokerError {
    OsBrokerError::new(
        "response_too_large",
        "file exceeds the requested readText byte limit",
    )
}

#[cfg(test)]
mod tests {
    use super::{contains_path, paths_equal};
    use std::path::Path;

    #[test]
    fn broker_path_authority_preserves_component_case() {
        let root = Path::new(r"C:\approved\foo");
        assert!(contains_path(
            root,
            Path::new(r"\\?\c:\approved\foo\file.txt")
        ));
        assert!(!contains_path(root, Path::new(r"C:\approved\Foo\file.txt")));
        assert!(!contains_path(root, Path::new(r"C:\Approved\foo\file.txt")));
        assert!(!contains_path(
            root,
            Path::new(r"C:\approved\foobar\file.txt")
        ));
        assert!(paths_equal(
            Path::new(r"c:/approved/foo/node.exe"),
            Path::new(r"\\?\C:\approved\foo\node.exe")
        ));
        assert!(!paths_equal(
            Path::new(r"C:\approved\foo\node.exe"),
            Path::new(r"C:\approved\foo\NODE.EXE")
        ));
        assert!(!paths_equal(
            Path::new(r"C:\approved\é.txt"),
            Path::new(r"C:\approved\É.txt")
        ));
    }
}
