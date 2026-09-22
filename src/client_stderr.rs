//! Private stderr capture for one newly created client. Never reads shared logs
//! or scans inspector ports; the URL is retained only for its bounded handshake.
use crate::platform::host::{Channel, StopSignal, signal};
use crate::plugin_host::HostError;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[cfg(windows)]
type ChildHandle = std::os::windows::io::OwnedHandle;
#[cfg(target_os = "macos")]
type ChildHandle = std::os::fd::OwnedFd;

pub(crate) struct ClientStderr {
    child: ChildHandle,
    #[cfg(windows)]
    null: ChildHandle,
    stop: StopSignal,
    reader: Option<JoinHandle<()>>,
    receiver: mpsc::Receiver<Result<String, HostError>>,
}

fn error(code: &'static str) -> HostError {
    HostError::new(
        code,
        "The exact newly launched client did not supply a usable private inspector endpoint",
    )
}

impl ClientStderr {
    pub(crate) fn new() -> Result<Self, HostError> {
        #[cfg(windows)]
        let stop = std::sync::Arc::new(
            crate::windows::local_ipc::create_event().map_err(|_| error("client_stderr_failed"))?,
        );
        #[cfg(target_os = "macos")]
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        #[cfg(windows)]
        let (channel, child) = crate::windows::plugin_process::stdio_pair(false, stop.clone())
            .map_err(|_| error("client_stderr_failed"))?;
        #[cfg(target_os = "macos")]
        let (channel, child) =
            crate::macos::host::Channel::pair(&stop).map_err(|_| error("client_stderr_failed"))?;
        #[cfg(windows)]
        let null = null_handle()?;
        let (sender, receiver) = mpsc::sync_channel(1);
        let reader = std::thread::Builder::new()
            .name("codlet-client-stderr".into())
            .spawn(move || drain(channel, sender))
            .map_err(|_| error("client_stderr_failed"))?;
        Ok(Self {
            child,
            #[cfg(windows)]
            null,
            stop,
            reader: Some(reader),
            receiver,
        })
    }

    pub(crate) fn endpoint(
        &self,
        deadline: Instant,
        cancelled: impl Fn() -> bool,
    ) -> Result<String, HostError> {
        loop {
            if cancelled() {
                return Err(error("client_bootstrap_cancelled"));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(error("client_inspector_unavailable"));
            }
            match self
                .receiver
                .recv_timeout(remaining.min(Duration::from_millis(20)))
            {
                Ok(result) => return result,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(error("client_inspector_unavailable"));
                }
            }
        }
    }

    #[cfg(windows)]
    pub(crate) fn handles(&self) -> [windows_sys::Win32::Foundation::HANDLE; 2] {
        use std::os::windows::io::AsRawHandle;
        [
            self.child.as_raw_handle().cast(),
            self.null.as_raw_handle().cast(),
        ]
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn configure(&self, command: &mut std::process::Command) -> Result<(), HostError> {
        command.stderr(std::process::Stdio::from(
            self.child
                .try_clone()
                .map_err(|_| error("client_stderr_failed"))?,
        ));
        Ok(())
    }
}

impl Drop for ClientStderr {
    fn drop(&mut self) {
        signal(&self.stop);
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

fn drain(channel: Channel, sender: mpsc::SyncSender<Result<String, HostError>>) {
    let mut buffer = [0u8; 4096];
    let mut pending = Vec::new();
    let mut scanned = 0usize;
    let mut delivered = false;
    loop {
        let count = match channel.read_some(&mut buffer, None) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        if delivered {
            continue;
        }
        scanned += count;
        if scanned > 64 * 1024 {
            let _ = sender.try_send(Err(error("client_stderr_limit")));
            delivered = true;
            continue;
        }
        pending.extend_from_slice(&buffer[..count]);
        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
            let line = pending.drain(..=end).collect::<Vec<_>>();
            if let Some(endpoint) = inspector_line(&line) {
                let _ = sender.try_send(Ok(endpoint));
                delivered = true;
                pending.clear();
                break;
            }
        }
    }
    if !delivered {
        let _ = sender.try_send(Err(error("client_inspector_unavailable")));
    }
}

fn inspector_line(line: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(line)
        .ok()?
        .trim_end_matches(['\r', '\n']);
    let endpoint = text.strip_prefix("Debugger listening on ")?;
    let url = url::Url::parse(endpoint).ok()?;
    let uuid = url.path().strip_prefix('/')?;
    if url.scheme() != "ws"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || uuid.len() != 36
        || !uuid.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
    {
        return None;
    }
    Some(endpoint.to_owned())
}

#[cfg(windows)]
fn null_handle() -> Result<ChildHandle, HostError> {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::{
        Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE},
        Security::SECURITY_ATTRIBUTES,
        Storage::FileSystem::{CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING},
    };
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: 1,
    };
    let name: Vec<u16> = "NUL\0".encode_utf16().collect();
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &attributes,
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(error("client_stderr_failed"));
    }
    Ok(unsafe { ChildHandle::from_raw_handle(handle.cast()) })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_exact_loopback_inspector_lines() {
        let valid =
            "Debugger listening on ws://127.0.0.1:49152/12345678-abcd-1234-abcd-123456789abc\r\n";
        assert!(inspector_line(valid.as_bytes()).is_some());
        for invalid in [
            valid.replace("127.0.0.1", "0.0.0.0"),
            valid.replace("Debugger listening on ", "untrusted prefix "),
            valid.replace("12345678-abcd", "xxx-abcd"),
            valid.replace("49152/", "49152/?token="),
        ] {
            assert!(inspector_line(invalid.as_bytes()).is_none());
        }
    }
    #[test]
    fn empty_stderr_wait_is_bounded_and_reader_cancels_on_drop() {
        let stderr = ClientStderr::new().unwrap();
        let start = Instant::now();
        assert!(
            stderr
                .endpoint(start + Duration::from_millis(20), || false)
                .is_err()
        );
        drop(stderr);
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[cfg(windows)]
    #[test]
    fn captures_only_its_owned_fake_child_stderr_without_breaking_cdp() {
        use crate::windows::{
            environment::ChildEnvironment, process::launch_with_owned_traffic_capture,
        };
        let executable = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("codlet-fake-child.exe");
        let stderr = ClientStderr::new().unwrap();
        let (child, pipes) = launch_with_owned_traffic_capture(
            &executable,
            &["--scenario=lab-inspector".into()],
            &ChildEnvironment::inherited().unwrap(),
            &stderr,
        )
        .unwrap();
        let endpoint = stderr
            .endpoint(Instant::now() + Duration::from_secs(2), || false)
            .unwrap();
        assert_eq!(
            endpoint,
            "ws://127.0.0.1:49152/12345678-abcd-1234-abcd-123456789abc"
        );
        let (client, _) = crate::cdp::CdpClient::spawn(pipes).unwrap();
        let result = client
            .request("Fake.environment", None, None, Duration::from_secs(2))
            .unwrap()
            .result
            .unwrap();
        assert_eq!(result["pid"], child.process_id());
        client
            .request("Browser.close", None, None, Duration::from_secs(2))
            .unwrap();
        assert_eq!(child.wait(Duration::from_secs(2)).unwrap(), Some(0));
        client.shutdown().unwrap();
    }
}
