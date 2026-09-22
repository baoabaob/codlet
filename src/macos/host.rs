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
pub(crate) fn spawn_failure(
    code: &'static str,
    error: &io::Error,
) -> crate::plugin_host::HostError {
    // Only fixed stage identifiers plus OS classifications cross this boundary.
    // Never forward command paths, arguments, environment, or arbitrary messages.
    let message = error.to_string();
    let stage = message
        .strip_prefix("owner_stage=")
        .and_then(|text| text.split(';').next())
        .filter(|stage| {
            matches!(
                *stage,
                "owner_exec"
                    | "plan_write"
                    | "plan_delimiter"
                    | "startup_reply"
                    | "plugin_exec"
                    | "parent_identity_inspect"
                    | "parent_identity_rejected"
            )
        })
        .unwrap_or("prepare");
    let errno = error.raw_os_error().or_else(|| {
        message.split(';').find_map(|field| {
            field
                .strip_prefix("errno=Some(")?
                .strip_suffix(')')?
                .parse::<i32>()
                .ok()
        })
    });
    crate::plugin_host::HostError::new(
        code,
        format!(
            "Native process startup failed: owner_stage={stage};io_kind={:?};errno={errno:?}",
            error.kind()
        ),
    )
}
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
    pub(crate) fn pair(stop: &StopSignal) -> io::Result<(Self, OwnedFd)> {
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
        #[cfg(not(test))]
        command.arg("__codlet_process_owner");
        #[cfg(test)]
        command.args([
            "--exact",
            "macos::host::tests::process_owner_fixture",
            "--ignored",
            "--nocapture",
        ]);
        command
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
                #[cfg(test)]
                {
                    // libtest writes a header before invoking the selected test.
                    // Preserve the real Host output endpoints on extra inherited
                    // descriptors, hiding the harness until the fixture restores
                    // them. All of this exists only in the cfg(test) executable.
                    for (source, target) in [(1, 6), (2, 7)] {
                        if libc::dup2(source, target) < 0 {
                            return Err(io::Error::last_os_error());
                        }
                    }
                    let null = libc::open(c"/dev/null".as_ptr(), libc::O_WRONLY);
                    if null < 0 {
                        return Err(io::Error::last_os_error());
                    }
                    if libc::dup2(null, 1) < 0 || libc::dup2(null, 2) < 0 {
                        return Err(io::Error::last_os_error());
                    }
                    libc::close(null);
                }
                Ok(())
            });
        }
        let mut child = command
            .spawn()
            .map_err(|error| super::process_owner::sanitized_stage("owner_exec", &error))?;
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
            control
                .write_all(&body)
                .map_err(|error| super::process_owner::sanitized_stage("plan_write", &error))?;
            control
                .write_all(b"\n")
                .map_err(|error| super::process_owner::sanitized_stage("plan_delimiter", &error))?;
            let reply = super::process_owner::read_reply(&mut control)
                .map_err(|error| super::process_owner::sanitized_stage("startup_reply", &error))?;
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

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "private same-executable process owner entry; invoked only by Host spawn tests"]
    fn process_owner_fixture() {
        // An ordinary test run does not select this function exclusively.
        // No env override, alternate executable, or parent-auth bypass exists.
        let arguments = std::env::args().skip(1).collect::<Vec<_>>();
        if arguments
            != [
                "--exact",
                "macos::host::tests::process_owner_fixture",
                "--ignored",
                "--nocapture",
            ]
        {
            return;
        }
        for (source, target) in [(6, 1), (7, 2)] {
            if unsafe { libc::dup2(source, target) } < 0 {
                std::process::exit(120);
            }
            unsafe {
                libc::close(source);
            }
        }
        // Exit directly so no libtest trailer enters the plugin's output pipe.
        std::process::exit(if super::super::process_owner::run().is_ok() {
            0
        } else {
            121
        });
    }

    #[test]
    fn spawn_diagnostics_do_not_include_arbitrary_error_text() {
        let error = std::io::Error::other("secret-token /private/config.json");
        let failure = super::spawn_failure("spawn_failed", &error);
        assert!(!failure.message.contains("secret-token"));
        assert!(!failure.message.contains("/private"));
        let error = std::io::Error::other("owner_stage=parent_identity_rejected");
        assert!(
            super::spawn_failure("spawn_failed", &error)
                .message
                .contains("parent_identity_rejected")
        );
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
