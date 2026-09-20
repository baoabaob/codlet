//! Bounded calls to fixed system utilities, never a shell command string.
use std::io::{self, Read};
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub(crate) fn output(command: &mut Command, timeout: Duration) -> io::Result<Vec<u8>> {
    let (mut stdout, child_stdout) = UnixStream::pair()?;
    let (mut stderr, child_stderr) = UnixStream::pair()?;
    stdout.set_nonblocking(true)?;
    stderr.set_nonblocking(true)?;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::from(OwnedFd::from(child_stdout)))
        .stderr(Stdio::from(OwnedFd::from(child_stderr)))
        .spawn()?;
    // Command retains its configured descriptors for possible reuse. Close the
    // parent's write copies so the read sockets can observe the child's EOF.
    command.stdout(Stdio::null()).stderr(Stdio::null());
    let deadline = Instant::now() + timeout;
    let mut bytes = Vec::new();
    let mut errors = Vec::new();
    let mut closed = [false; 2];
    let result = (|| {
        loop {
            for (index, stream, target) in
                [(0, &mut stdout, &mut bytes), (1, &mut stderr, &mut errors)]
            {
                if closed[index] {
                    continue;
                }
                let mut buffer = [0; 8192];
                match stream.read(&mut buffer) {
                    Ok(0) => closed[index] = true,
                    Ok(count) => target.extend_from_slice(&buffer[..count]),
                    Err(e)
                        if matches!(
                            e.kind(),
                            io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                        ) => {}
                    Err(e) => return Err(e),
                }
            }
            if bytes.len() + errors.len() > 1024 * 1024 {
                return Err(io::Error::other("System utility output exceeded 1 MiB"));
            }
            if let Some(status) = child.try_wait()?
                && closed.iter().all(|closed| *closed)
            {
                return if status.success() {
                    Ok(bytes)
                } else {
                    Err(io::Error::other(format!(
                        "System utility failed ({status}): {}",
                        String::from_utf8_lossy(&errors)
                    )))
                };
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "System utility deadline exceeded",
                ));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    })();
    if result.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    result
}
