use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::Command;

pub struct ParentCdpPipes {
    reader: UnixStream,
    writer: UnixStream,
}
impl ParentCdpPipes {
    pub(crate) fn into_parts(self) -> (UnixStream, UnixStream) {
        (self.reader, self.writer)
    }
}

pub(crate) struct CdpPipes {
    pub parent: ParentCdpPipes,
    input: OwnedFd,
    output: OwnedFd,
}
impl CdpPipes {
    pub(crate) fn into_parent(self) -> ParentCdpPipes {
        // Consume the pair so Core drops its copies of the child endpoints now,
        // rather than retaining them until the entire client session exits.
        self.parent
    }

    pub(crate) fn new() -> io::Result<Self> {
        let (writer, input) = UnixStream::pair()?;
        let (reader, output) = UnixStream::pair()?;
        // Keep the two source descriptors above Chromium's 3/4 destinations so
        // either dup2 cannot overwrite the source of the following operation.
        fn high_fd(stream: &UnixStream) -> io::Result<OwnedFd> {
            let fd = unsafe { libc::fcntl(stream.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 10) };
            if fd < 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(unsafe { OwnedFd::from_raw_fd(fd) })
            }
        }
        Ok(Self {
            input: high_fd(&input)?,
            output: high_fd(&output)?,
            parent: ParentCdpPipes { reader, writer },
        })
    }

    pub(crate) fn configure(&self, command: &mut Command) -> io::Result<()> {
        fn duplicate(file: &OwnedFd) -> io::Result<OwnedFd> {
            let fd = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 10) };
            if fd < 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(unsafe { OwnedFd::from_raw_fd(fd) })
            }
        }
        let input = duplicate(&self.input)?;
        let output = duplicate(&self.output)?;
        // Only async-signal-safe syscalls run after fork. The caller holds these
        // descriptors through spawn; dup2 clears close-on-exec on destinations.
        unsafe {
            command.pre_exec(move || {
                if libc::dup2(input.as_raw_fd(), 3) < 0 || libc::dup2(output.as_raw_fd(), 4) < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdp::CdpClient;
    use std::time::{Duration, Instant};

    #[test]
    fn cancellation_reaps_a_blocked_socket_reader_without_closing_the_peer() {
        let pipes = CdpPipes::new().unwrap();
        let CdpPipes {
            parent,
            input: _open_input,
            output: _open_output,
        } = pipes;
        let (client, _events) = CdpClient::spawn(parent).unwrap();
        let start = Instant::now();
        client.shutdown().unwrap();
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn cancellation_interrupts_backpressure_on_the_write_socket() {
        let pipes = CdpPipes::new().unwrap();
        let CdpPipes {
            parent,
            input: _open_input,
            output: _open_output,
        } = pipes;
        let (client, _events) = CdpClient::spawn(parent).unwrap();
        let start = Instant::now();
        assert!(
            client
                .request(
                    "Runtime.evaluate",
                    Some(serde_json::json!({"expression":"x".repeat(2 * 1024 * 1024)})),
                    None,
                    Duration::from_millis(100)
                )
                .is_err()
        );
        client.shutdown().unwrap();
        assert!(start.elapsed() < Duration::from_secs(3));
    }
}
