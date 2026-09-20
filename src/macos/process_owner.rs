//! A small native owner watches a private Core lease. Core crashes therefore
//! retire the owned process group without relying on Node's JavaScript event loop.
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SpawnPlan {
    pub executable: PathBuf,
    pub arguments: Vec<String>,
    pub cwd: PathBuf,
    pub environment: Option<Vec<(OsString, OsString)>>,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "event", deny_unknown_fields)]
pub(super) enum OwnerReply {
    Started {
        pid: u32,
    },
    Exited {
        code: u32,
        process_group_reaped: bool,
    },
    Failed {
        message: String,
    },
}
fn read_line(stream: &mut UnixStream, limit: usize) -> io::Result<Vec<u8>> {
    let mut result = Vec::new();
    let mut byte = [0];
    while result.len() <= limit {
        stream.read_exact(&mut byte)?;
        if byte[0] == b'\n' {
            return Ok(result);
        }
        result.push(byte[0]);
    }
    Err(io::Error::other("Process owner frame exceeded its limit"))
}
pub(super) fn read_reply(stream: &mut UnixStream) -> io::Result<OwnerReply> {
    Ok(serde_json::from_slice(&read_line(stream, 16384)?)?)
}
fn reply(stream: &mut UnixStream, reply: &OwnerReply) -> io::Result<()> {
    stream.write_all(&serde_json::to_vec(reply)?)?;
    stream.write_all(b"\n")
}

pub fn run() -> io::Result<()> {
    if unsafe { libc::fcntl(5, libc::F_GETFD) } < 0 {
        return Err(io::Error::other("Missing Core owner lease"));
    }
    let mut control = unsafe { UnixStream::from_raw_fd(5) };
    // The private lease must never survive exec in the plugin or a descendant.
    if unsafe { libc::fcntl(control.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    let parent = super::identity::ProcessIdentity::inspect(unsafe { libc::getppid() } as u32)?;
    if parent.uid != unsafe { libc::geteuid() } || parent.executable != std::env::current_exe()? {
        return Err(io::Error::other(
            "Process owner must be created by this Codlet executable",
        ));
    }
    control.set_read_timeout(Some(Duration::from_secs(5)))?;
    control.set_write_timeout(Some(Duration::from_secs(2)))?;
    let plan: SpawnPlan = serde_json::from_slice(&read_line(&mut control, 1024 * 1024)?)?;
    if !plan.executable.is_absolute() || !plan.cwd.is_absolute() || plan.arguments.len() > 128 {
        return Err(io::Error::other("Invalid Core process plan"));
    }
    let mut command = Command::new(&plan.executable);
    command
        .args(&plan.arguments)
        .current_dir(&plan.cwd)
        .process_group(0);
    if let Some(environment) = plan.environment {
        command.env_clear().envs(environment);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            reply(
                &mut control,
                &OwnerReply::Failed {
                    message: error.to_string(),
                },
            )?;
            return Ok(());
        }
    };
    let pid = child.id() as i32;
    let mut direct_exited = false;
    let result = (|| {
        reply(&mut control, &OwnerReply::Started { pid: child.id() })?;
        control.set_nonblocking(true)?;
        loop {
            // WNOWAIT preserves the direct child's PID until group retirement.
            // A reused PID/PGID can therefore never name a later unrelated job.
            if direct_child_exited(pid)? {
                direct_exited = true;
                break;
            }
            let mut command = [0];
            match control.read(&mut command) {
                Ok(0) | Ok(_) => break,
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) => {}
                Err(e) => return Err(e),
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Ok(())
    })();
    // The child has not been reaped on any path above, including a broken lease.
    let cleanup = retire_group(pid, direct_exited);
    if cleanup.is_err() {
        let _ = child.kill();
    }
    let until = Instant::now() + Duration::from_secs(2);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= until {
            return Err(io::Error::other("Direct Host retirement was not confirmed"));
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    control.set_nonblocking(false)?;
    let final_reply = match result.and(cleanup) {
        Ok(()) => OwnerReply::Exited {
            code: status
                .code()
                .unwrap_or_else(|| 128 + status.signal().unwrap_or(0)) as u32,
            process_group_reaped: true,
        },
        Err(error) => OwnerReply::Failed {
            message: error.to_string(),
        },
    };
    // A vanished Core cannot receive a receipt; its process group was still retired.
    let _ = reply(&mut control, &final_reply);
    Ok(())
}

fn direct_child_exited(pid: i32) -> io::Result<bool> {
    loop {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        if unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        } == 0
        {
            return Ok(unsafe { info.si_pid() } != 0);
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

fn retire_group(pid: i32, mut direct_exited: bool) -> io::Result<()> {
    if unsafe { libc::kill(-pid, libc::SIGKILL) } != 0
        && io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    {
        return Err(io::Error::last_os_error());
    }
    let until = Instant::now() + Duration::from_secs(2);
    loop {
        if !direct_exited {
            direct_exited = direct_child_exited(pid)?;
        }
        let mut pids = vec![0i32; 4096];
        unsafe {
            *libc::__error() = 0;
        }
        let count = unsafe {
            libc::proc_listpgrppids(pid, pids.as_mut_ptr().cast(), (pids.len() * 4) as i32)
        };
        if count == 0
            && matches!(
                io::Error::last_os_error().raw_os_error(),
                Some(0 | libc::ESRCH)
            )
        {
            return Ok(());
        }
        if count <= 0 || count as usize >= pids.len() {
            return Err(io::Error::other(
                "Cannot confirm owned process group membership",
            ));
        }
        // The direct child is exclusively ours and remains waitable because every
        // observation above used WNOWAIT. Once waitid confirms its exit, keeping
        // that zombie in the group list must not block retirement; retaining it
        // still prevents PID/PGID reuse until Child::try_wait reaps it below.
        let mut active = !direct_exited;
        for member in pids.into_iter().take(count as usize).filter(|p| *p > 0) {
            if member == pid && direct_exited {
                continue;
            }
            let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
            let size = std::mem::size_of_val(&info) as i32;
            let received = unsafe {
                libc::proc_pidinfo(
                    member,
                    libc::PROC_PIDTBSDINFO,
                    // Darwin requires a nonzero argument to include zombies.
                    // The leader intentionally stays unreaped until this check;
                    // hiding it would prevent a successful cleanup receipt.
                    1,
                    (&mut info as *mut libc::proc_bsdinfo).cast(),
                    size,
                )
            };
            // A disappearing member requires a fresh list. Zombies have already
            // stopped executing; the direct child is reaped only after this check.
            active |= received != size || info.pbi_status != libc::SZOMB;
        }
        if !active {
            return Ok(());
        }
        if Instant::now() >= until {
            return Err(io::Error::other(
                "Owned process group retirement was not confirmed",
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unreaped_natural_exit_can_retire_its_group_before_wait_reaps_the_leader() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .process_group(0)
            .spawn()
            .unwrap();
        let pid = child.id() as i32;
        let deadline = Instant::now() + Duration::from_secs(2);
        while !direct_child_exited(pid).unwrap() {
            assert!(Instant::now() < deadline, "child did not become waitable");
            std::thread::sleep(Duration::from_millis(5));
        }
        retire_group(pid, true).unwrap();
        assert!(child.wait().unwrap().success());
    }
}
