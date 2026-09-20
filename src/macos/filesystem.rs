//! Descriptor-relative access. POSIX file handles retain an inode, not a locked
//! pathname, so callers check the final location and never traverse by a new path.
use std::ffi::{CStr, CString, OsString};
use std::fs::{File, OpenOptions};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};

pub(crate) struct Pinned {
    pub file: File,
    pub path: PathBuf,
    pub parents: Vec<File>,
}
pub(crate) fn open_checked(path: &Path) -> io::Result<Pinned> {
    if !path.is_absolute()
        || path.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::CurDir | Component::Prefix(_)
            )
        })
    {
        return Err(io::Error::other(
            "Expected an absolute path without dot segments",
        ));
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open("/")?;
    let mut parents = Vec::new();
    for component in path.components().filter_map(|c| {
        if let Component::Normal(name) = c {
            Some(name)
        } else {
            None
        }
    }) {
        let name = CString::new(component.as_bytes())?;
        let fd = unsafe {
            libc::openat(
                file.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let next = unsafe { File::from_raw_fd(fd) };
        let metadata = next.metadata()?;
        if (!metadata.is_file() && !metadata.is_dir())
            || (metadata.is_file() && metadata.nlink() != 1)
        {
            return Err(io::Error::other(
                "Expected a regular file or directory without file hard links",
            ));
        }
        parents.push(file);
        file = next;
    }
    let actual = final_path(&file)?;
    if actual != path {
        return Err(io::Error::other(
            "Path redirected while opening its components",
        ));
    }
    Ok(Pinned {
        file,
        path: actual,
        parents,
    })
}
pub(crate) fn final_path(file: &File) -> io::Result<PathBuf> {
    let mut bytes = vec![0u8; libc::PATH_MAX as usize];
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, bytes.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let length = bytes
        .iter()
        .position(|b| *b == 0)
        .ok_or_else(|| io::Error::other("Opened path exceeded the OS path limit"))?;
    bytes.truncate(length);
    Ok(PathBuf::from(OsString::from_vec(bytes)))
}

pub(crate) fn entries(
    file: &File,
    max: usize,
) -> io::Result<(Vec<(OsString, &'static str)>, bool)> {
    // A duplicated descriptor shares its directory position; obtain a new open
    // description for '.' relative to the already checked inode instead.
    let fd = unsafe {
        libc::openat(
            file.as_raw_fd(),
            c".".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let directory = unsafe { libc::fdopendir(fd) };
    if directory.is_null() {
        unsafe {
            libc::close(fd);
        }
        return Err(io::Error::last_os_error());
    }
    struct DirectoryStream(*mut libc::DIR);
    impl Drop for DirectoryStream {
        fn drop(&mut self) {
            unsafe {
                libc::closedir(self.0);
            }
        }
    }
    let directory = DirectoryStream(directory);
    let mut result = Vec::new();
    loop {
        unsafe {
            *libc::__error() = 0;
        }
        let entry = unsafe { libc::readdir(directory.0) };
        if entry.is_null() {
            let error = io::Error::last_os_error();
            return if error.raw_os_error() == Some(0) {
                Ok((result, false))
            } else {
                Err(error)
            };
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if name == b"." || name == b".." {
            continue;
        }
        if result.len() == max {
            return Ok((result, true));
        }
        let kind = match unsafe { (*entry).d_type } {
            libc::DT_DIR => "directory",
            libc::DT_REG => "file",
            libc::DT_LNK => "link",
            _ => "other",
        };
        result.push((OsString::from_vec(name.to_vec()), kind));
    }
}

pub(crate) struct Directory {
    pub path: PathBuf,
    pub identity: String,
    pinned: Pinned,
}
pub(crate) fn pin_directory(
    path: &Path,
    _deleting: bool,
) -> Result<Directory, crate::plugin_control::PluginControlError> {
    let result = (|| {
        let pinned = open_checked(path)?;
        let metadata = pinned.file.metadata()?;
        if !metadata.is_dir() || pinned.parents.is_empty() {
            return Err(io::Error::other(
                "Source must be a directory below the filesystem root",
            ));
        }
        let created = metadata
            .created()?
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(io::Error::other)?;
        Ok(Directory {
            path: pinned.path.clone(),
            identity: crate::local_import::digest(&(
                pinned.path.clone(),
                metadata.dev(),
                metadata.ino(),
                created.as_secs(),
                created.subsec_nanos(),
            )),
            pinned,
        })
    })();
    result.map_err(|e: io::Error| {
        crate::plugin_control::PluginControlError::new("source_identity", e.to_string())
    })
}
impl Directory {
    pub(crate) fn remove(self) -> io::Result<()> {
        if final_path(&self.pinned.file)? != self.path {
            return Err(io::Error::other("Source directory moved before removal"));
        }
        let mut budget = 100_000;
        remove_contents(&self.pinned.file, &mut budget, 0)?;
        let parent = self
            .pinned
            .parents
            .last()
            .ok_or_else(|| io::Error::other("No source parent"))?;
        let name = CString::new(
            self.path
                .file_name()
                .ok_or_else(|| io::Error::other("No source name"))?
                .as_bytes(),
        )?;
        unlink_directory(parent, &name, &self.pinned.file)
    }
}
fn unlink_directory(parent: &File, name: &CStr, opened: &File) -> io::Result<()> {
    let metadata = opened.metadata()?;
    let mut current: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            &mut current,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    if metadata.dev() != current.st_dev as u64 || metadata.ino() != current.st_ino {
        return Err(io::Error::other(
            "Source directory was replaced during removal",
        ));
    }
    if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
fn remove_contents(directory: &File, budget: &mut usize, depth: usize) -> io::Result<()> {
    if depth > 128 {
        return Err(io::Error::other(
            "Source removal exceeded its directory depth limit",
        ));
    }
    let (children, truncated) = entries(directory, *budget)?;
    if truncated {
        return Err(io::Error::other("Source removal exceeded its entry limit"));
    }
    for (name, _) in children {
        *budget = budget
            .checked_sub(1)
            .ok_or_else(|| io::Error::other("Source removal exceeded its entry limit"))?;
        let name = CString::new(name.as_bytes())?;
        let mut metadata: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe {
            libc::fstatat(
                directory.as_raw_fd(),
                name.as_ptr(),
                &mut metadata,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        if metadata.st_mode & libc::S_IFMT == libc::S_IFDIR {
            let fd = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            let child = unsafe { File::from_raw_fd(fd) };
            remove_contents(&child, budget, depth + 1)?;
            unlink_directory(directory, &name, &child)?;
        } else if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn links_never_expand_the_read_or_removal_scope() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let source = root.join("source");
        std::fs::create_dir(&source).unwrap();
        let outside = root.join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("keep"), "outside").unwrap();
        std::os::unix::fs::symlink(&outside, source.join("link")).unwrap();
        assert!(open_checked(&source.join("link/keep")).is_err());
        pin_directory(&source, true).unwrap().remove().unwrap();
        assert_eq!(
            std::fs::read_to_string(outside.join("keep")).unwrap(),
            "outside"
        );
    }
}
