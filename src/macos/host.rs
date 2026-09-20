use super::process_owner::{OwnerReply, SpawnPlan};
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

pub(crate) type StopSignal = Arc<AtomicBool>;
pub(crate) fn signal(stop: &StopSignal) {
    stop.store(true, Ordering::Release);
}
#[derive(Debug, thiserror::Error)]
pub(crate) enum LocalIpcError {
    #[error("Local I/O deadline exceeded")]
    Timeout,
    #[error("Local I/O is stopping")]
    Stopping,
    #[error(transparent)]
    Io(#[from] io::Error),
}
pub(crate) fn stream_closed(error: &LocalIpcError) -> bool {
    matches!(error, LocalIpcError::Io(e) if matches!(e.kind(), io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset | io::ErrorKind::UnexpectedEof))
}
pub(crate) struct Channel {
    socket: UnixStream,
    stop: StopSignal,
}
impl Channel {
    pub(super) fn from_socket(socket: UnixStream, stop: StopSignal) -> io::Result<Self> {
        socket.set_nonblocking(true)?;
        Ok(Self { socket, stop })
    }
    fn pair(stop: &StopSignal) -> io::Result<(Self, OwnedFd)> {
        let (socket, child) = UnixStream::pair()?;
        socket.set_nonblocking(true)?;
        // Nonblocking is a property of this endpoint, not the peer inherited by
        // Node. Poll wakes at most every 20 ms to observe Core cancellation.
        Ok((
            Self {
                socket,
                stop: stop.clone(),
            },
            OwnedFd::from(child),
        ))
    }
    fn ready(&self, event: i16, deadline: Option<Instant>) -> Result<(), LocalIpcError> {
        loop {
            if self.stop.load(Ordering::Acquire) {
                return Err(LocalIpcError::Stopping);
            }
            let remaining = deadline
                .map(|d| d.saturating_duration_since(Instant::now()))
                .unwrap_or(Duration::from_millis(20));
            if remaining.is_zero() {
                return Err(LocalIpcError::Timeout);
            }
            let mut fd = libc::pollfd {
                fd: self.socket.as_raw_fd(),
                events: event,
                revents: 0,
            };
            let milliseconds = remaining.min(Duration::from_millis(20)).as_millis().max(1) as i32;
            let result = unsafe { libc::poll(&mut fd, 1, milliseconds) };
            if result > 0 {
                return Ok(());
            }
            if result < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                return Err(io::Error::last_os_error().into());
            }
        }
    }
    pub(crate) fn read_some(
        &self,
        buffer: &mut [u8],
        deadline: Option<Instant>,
    ) -> Result<usize, LocalIpcError> {
        loop {
            self.ready(libc::POLLIN, deadline)?;
            match (&self.socket).read(buffer) {
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) => {}
                result => return result.map_err(Into::into),
            }
        }
    }
    pub(crate) fn write_all(
        &self,
        mut bytes: &[u8],
        deadline: Instant,
    ) -> Result<(), LocalIpcError> {
        while !bytes.is_empty() {
            self.ready(libc::POLLOUT, Some(deadline))?;
            match (&self.socket).write(bytes) {
                Ok(0) => {
                    return Err(
                        io::Error::new(io::ErrorKind::WriteZero, "Closed Host stdin").into(),
                    );
                }
                Ok(count) => bytes = &bytes[count..],
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(())
    }
}

pub(crate) struct PluginStdio {
    pub stdin: Channel,
    pub stdout: Channel,
    pub stderr: Channel,
    pub stop: StopSignal,
}
struct Owner {
    child: Child,
    control: UnixStream,
    pending: Vec<u8>,
    result: Option<Result<(u32, bool), String>>,
}
pub(crate) struct OwnedPluginProcess {
    owner: Mutex<Owner>,
    pid: u32,
}
impl OwnedPluginProcess {
    pub(crate) fn spawn(
        executable: &Path,
        arguments: &[String],
        cwd: &Path,
        environment: Option<&[(OsString, OsString)]>,
    ) -> io::Result<(Self, PluginStdio)> {
        if !executable.is_absolute() || !cwd.is_absolute() || !executable.is_file() || !cwd.is_dir()
        {
            return Err(io::Error::other(
                "Host executable and working directory must exist at absolute paths",
            ));
        }
        let stop = Arc::new(AtomicBool::new(false));
        let (stdin, child_stdin) = Channel::pair(&stop)?;
        let (stdout, child_stdout) = Channel::pair(&stop)?;
        let (stderr, child_stderr) = Channel::pair(&stop)?;
        let (mut control, child_control) = UnixStream::pair()?;
        control.set_read_timeout(Some(Duration::from_secs(5)))?;
        control.set_write_timeout(Some(Duration::from_secs(5)))?;
        let fd = unsafe { libc::fcntl(child_control.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 10) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let descriptor = unsafe { OwnedFd::from_raw_fd(fd) };
        let mut command = Command::new(std::env::current_exe()?);
        command
            .arg("__codlet_process_owner")
            // Terminal signals may end Core, but its lease observer must remain
            // alive long enough to retire the separate plugin process group.
            .process_group(0)
            .stdin(Stdio::from(child_stdin))
            .stdout(Stdio::from(child_stdout))
            .stderr(Stdio::from(child_stderr));
        unsafe {
            command.pre_exec(move || {
                if libc::dup2(descriptor.as_raw_fd(), 5) < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn()?;
        drop(command);
        drop(child_control);
        let startup = (|| {
            let body = serde_json::to_vec(&SpawnPlan {
                executable: executable.into(),
                arguments: arguments.to_vec(),
                cwd: cwd.into(),
                environment: environment.map(Vec::from),
            })?;
            if body.len() > 1024 * 1024 {
                return Err(io::Error::other(
                    "Host environment exceeded its startup limit",
                ));
            }
            control.write_all(&body)?;
            control.write_all(b"\n")?;
            let reply = super::process_owner::read_reply(&mut control)?;
            match reply {
                OwnerReply::Started { pid } if pid > 0 => {
                    control.set_nonblocking(true)?;
                    Ok(pid)
                }
                OwnerReply::Failed { message } => Err(io::Error::other(message)),
                _ => Err(io::Error::other("Invalid Host owner startup reply")),
            }
        })();
        let pid = match startup {
            Ok(pid) => pid,
            Err(e) => {
                // Closing the private lease makes the owner retire a child even
                // when startup failed after process creation. Do not kill that
                // owner before it has a chance to perform group cleanup.
                drop(control);
                let until = Instant::now() + Duration::from_secs(3);
                while child.try_wait()?.is_none() && Instant::now() < until {
                    std::thread::sleep(Duration::from_millis(10));
                }
                if child.try_wait()?.is_none() {
                    let _ = child.kill();
                }
                let _ = child.wait();
                return Err(e);
            }
        };
        Ok((
            Self {
                owner: Mutex::new(Owner {
                    child,
                    control,
                    pending: Vec::new(),
                    result: None,
                }),
                pid,
            },
            PluginStdio {
                stdin,
                stdout,
                stderr,
                stop,
            },
        ))
    }
    pub(crate) fn pid(&self) -> u32 {
        self.pid
    }
    pub(crate) fn wait(&self, timeout: Duration) -> io::Result<Option<u32>> {
        let deadline = Instant::now() + timeout;
        loop {
            let mut owner = self.owner.lock().unwrap_or_else(|p| p.into_inner());
            owner.refresh()?;
            if let Some(result) = &owner.result {
                return result
                    .as_ref()
                    .map(|(code, _)| Some(*code))
                    .map_err(|e| io::Error::other(e.clone()));
            }
            drop(owner);
            if Instant::now() >= deadline {
                return Ok(None);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    pub(crate) fn terminate(&self) -> io::Result<()> {
        let mut owner = self.owner.lock().unwrap_or_else(|p| p.into_inner());
        owner.refresh()?;
        if owner.result.is_some() {
            return Ok(());
        }
        owner.control.write_all(b"T")
    }
    pub(crate) fn process_scope_is_empty(&self) -> io::Result<bool> {
        let mut owner = self.owner.lock().unwrap_or_else(|p| p.into_inner());
        owner.refresh()?;
        match &owner.result {
            Some(Ok((_, reaped))) => Ok(*reaped),
            Some(Err(e)) => Err(io::Error::other(e.clone())),
            None => Ok(false),
        }
    }
}
impl Owner {
    fn refresh(&mut self) -> io::Result<()> {
        if self.result.is_some() {
            return Ok(());
        }
        let mut buffer = [0; 4096];
        loop {
            match self.control.read(&mut buffer) {
                Ok(0) => {
                    if self.result.is_none() {
                        return Err(io::Error::other(
                            "Host owner ended without a cleanup receipt",
                        ));
                    }
                    break;
                }
                Ok(count) => self.pending.extend_from_slice(&buffer[..count]),
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            }
            if self.pending.len() > 16384 {
                return Err(io::Error::other("Host owner reply exceeded its limit"));
            }
            if let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
                let reply: OwnerReply = serde_json::from_slice(&self.pending[..end])?;
                self.result = Some(match reply {
                    OwnerReply::Exited {
                        code,
                        process_group_reaped,
                    } => Ok((code, process_group_reaped)),
                    OwnerReply::Failed { message } => Err(message),
                    _ => return Err(io::Error::other("Unexpected Host owner message")),
                });
                break;
            }
        }
        Ok(())
    }
}
impl Drop for OwnedPluginProcess {
    fn drop(&mut self) {
        let _ = self.terminate();
        let owner = self.owner.get_mut().unwrap_or_else(|p| p.into_inner());
        // The owner watches lease EOF independently of Core and the I/O workers.
        let _ = owner.control.shutdown(std::net::Shutdown::Both);
        let until = Instant::now() + Duration::from_secs(3);
        while owner.child.try_wait().is_ok_and(|code| code.is_none()) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(10));
        }
        if owner.child.try_wait().is_ok_and(|code| code.is_some()) {
            let _ = owner.child.wait();
        } else {
            crate::runtime_log::error(
                "host_cleanup",
                "macOS Host owner did not confirm retirement",
            );
        }
    }
}
