//! Kernel process facts used for launch and local IPC identity checks.
use serde::Serialize;
use std::io;
use std::os::unix::ffi::OsStringExt;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessIdentity {
    pub pid: u32,
    pub uid: u32,
    pub started_seconds: u64,
    pub started_microseconds: u64,
    pub executable: PathBuf,
}

impl ProcessIdentity {
    pub fn inspect(pid: u32) -> io::Result<Self> {
        if pid == 0 || pid > i32::MAX as u32 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid process ID",
            ));
        }
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of_val(&info) as i32;
        let count = unsafe {
            libc::proc_pidinfo(
                pid as i32,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                size,
            )
        };
        if count != size || info.pbi_pid != pid {
            return Err(io::Error::last_os_error());
        }
        let mut path = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        let count =
            unsafe { libc::proc_pidpath(pid as i32, path.as_mut_ptr().cast(), path.len() as u32) };
        if count <= 0 {
            return Err(io::Error::last_os_error());
        }
        path.truncate(path.iter().position(|b| *b == 0).unwrap_or(count as usize));
        Ok(Self {
            pid,
            uid: info.pbi_uid,
            started_seconds: info.pbi_start_tvsec,
            started_microseconds: info.pbi_start_tvusec,
            executable: PathBuf::from(std::ffi::OsString::from_vec(path)),
        })
    }

    pub fn check_live(&self) -> io::Result<()> {
        if Self::inspect(self.pid)? != *self {
            return Err(io::Error::other("Process identity changed"));
        }
        Ok(())
    }
}

pub(crate) fn process_ids() -> io::Result<Vec<u32>> {
    // The kernel list may grow between calls; retry a full buffer and cap the
    // allocation. A truncated list is not accepted as proof of no running app.
    let mut capacity = 1024usize;
    while capacity <= 65536 {
        let mut pids = vec![0i32; capacity];
        let count =
            unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), (pids.len() * 4) as i32) };
        if count <= 0 {
            return Err(io::Error::last_os_error());
        }
        if (count as usize) < capacity {
            pids.truncate(count as usize);
            return Ok(pids
                .into_iter()
                .filter(|pid| *pid > 0)
                .map(|pid| pid as u32)
                .collect());
        }
        capacity *= 2;
    }
    Err(io::Error::other(
        "Process list exceeded its inspection limit",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn current_process_identity_is_live_and_cannot_accept_a_different_birth() {
        let mut identity = ProcessIdentity::inspect(std::process::id()).unwrap();
        assert_eq!(identity.uid, unsafe { libc::geteuid() });
        identity.check_live().unwrap();
        identity.started_microseconds ^= 1;
        assert!(identity.check_live().is_err());
        assert!(process_ids().unwrap().contains(&std::process::id()));
    }
}
