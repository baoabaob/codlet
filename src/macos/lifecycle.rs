//! Cleanup of resources launched by this Core; never looks up an ambient client.
use std::io;
use std::process::{Child, ExitStatus};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::time::{Duration, Instant};

static HANDLERS_IN_USE: AtomicBool = AtomicBool::new(false);
static SHUTDOWN_SIGNAL: AtomicI32 = AtomicI32::new(0);
const SIGNALS: [i32; 3] = [libc::SIGINT, libc::SIGTERM, libc::SIGHUP];

extern "C" fn request_shutdown(signal: i32) {
    // No allocation, locking, logging or process operations in a signal handler.
    SHUTDOWN_SIGNAL.store(signal, Ordering::Relaxed);
}

pub struct ShutdownSignal {
    previous: Vec<(i32, libc::sigaction)>,
}
impl ShutdownSignal {
    pub fn install() -> io::Result<Self> {
        if HANDLERS_IN_USE.swap(true, Ordering::AcqRel) {
            return Err(io::Error::other(
                "Core shutdown handlers are already installed",
            ));
        }
        SHUTDOWN_SIGNAL.store(0, Ordering::Relaxed);
        let mut guard = Self {
            previous: Vec::new(),
        };
        for signal in SIGNALS {
            let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
            let mut previous = unsafe { std::mem::zeroed() };
            action.sa_sigaction = request_shutdown as *const () as libc::sighandler_t;
            action.sa_flags = libc::SA_RESTART;
            unsafe { libc::sigemptyset(&mut action.sa_mask) };
            if unsafe { libc::sigaction(signal, &action, &mut previous) } != 0 {
                return Err(io::Error::last_os_error());
            }
            guard.previous.push((signal, previous));
        }
        Ok(guard)
    }

    pub fn requested(&self) -> bool {
        SHUTDOWN_SIGNAL.load(Ordering::Relaxed) != 0
    }
}
impl Drop for ShutdownSignal {
    fn drop(&mut self) {
        for (signal, previous) in self.previous.iter().rev() {
            unsafe { libc::sigaction(*signal, previous, std::ptr::null_mut()) };
        }
        HANDLERS_IN_USE.store(false, Ordering::Release);
    }
}

/// Rust's Child does not terminate on Drop. Keep the unreaped direct child owned
/// across every fallible startup step, so a failed launch cannot strand it.
pub struct OwnedChild(Child, bool);
impl OwnedChild {
    pub fn new(child: Child) -> Self {
        Self(child, true)
    }
    /// A failed update handoff may leave a responsive official client open.
    /// Release only this known child handle without sending it a signal.
    pub fn leave_running(&mut self) {
        self.1 = false;
    }
    pub fn id(&self) -> u32 {
        self.0.id()
    }
    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.0.try_wait()
    }
    pub fn wait_for_exit(&mut self, timeout: Duration) -> io::Result<bool> {
        let until = Instant::now() + timeout;
        loop {
            if self.0.try_wait()?.is_some() {
                return Ok(true);
            }
            if Instant::now() >= until {
                return Ok(false);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    pub fn terminate(&mut self) -> io::Result<()> {
        if self.0.try_wait()?.is_some() {
            return Ok(());
        }
        // No intervening wait/reap: the PID still belongs to this direct child.
        self.0.kill()?;
        if !self.wait_for_exit(Duration::from_secs(2))? {
            return Err(io::Error::other(
                "Launched process retirement was not confirmed",
            ));
        }
        Ok(())
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if !self.1 {
            return;
        }
        if let Err(error) = self.terminate() {
            crate::runtime_log::error("macos_child_cleanup", &error.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    #[test]
    fn startup_error_reaps_only_the_spawned_child() {
        let launch = || {
            OwnedChild::new(
                Command::new("/bin/sleep")
                    .arg("30")
                    .process_group(0)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap(),
            )
        };
        let mut unrelated = launch();
        let child = launch();
        let pid = child.id();
        drop(child);
        let mut status = 0;
        assert_eq!(
            unsafe { libc::waitpid(pid as i32, &mut status, libc::WNOHANG) },
            -1
        );
        assert_eq!(
            io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD)
        );
        assert!(unrelated.try_wait().unwrap().is_none());
    }
}
