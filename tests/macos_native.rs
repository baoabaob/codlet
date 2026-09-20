#![cfg(target_os = "macos")]
//! Runs the real Mac HostSupervisor/owner in a separate fixture executable. The
//! owner re-executes that same binary, retaining production parent authentication.
use codlet::macos::lifecycle::OwnedChild;
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(15);
struct Fixture {
    child: Child,
    messages: Receiver<Value>,
    reader: Option<JoinHandle<()>>,
    _directory: tempfile::TempDir,
}
impl Fixture {
    fn start(mode: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_codlet-fake-child"))
            .args([mode, env!("CARGO_BIN_EXE_codlet-fake-host")])
            .current_dir(directory.path())
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (send, messages) = channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if line.len() > 65536 {
                    break;
                }
                let Ok(message) = serde_json::from_str(&line) else {
                    break;
                };
                if send.send(message).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            messages,
            reader: Some(reader),
            _directory: directory,
        }
    }
    fn next(&self, event: &str) -> Value {
        let message = self
            .messages
            .recv_timeout(WAIT)
            .expect("Native fixture did not respond before deadline");
        assert_eq!(message["event"], event, "{message}");
        message
    }
    fn stop(&mut self) -> Value {
        self.child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"stop\n")
            .unwrap();
        self.next("stopped")
    }
    fn exited(&mut self, success: bool) {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(exit) = self.child.try_wait().unwrap() {
                assert_eq!(exit.success(), success, "{exit}");
                return;
            }
            assert!(Instant::now() < deadline, "Native fixture did not exit");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
fn running(identity: &Value) -> bool {
    let pid = identity["pid"].as_u64().unwrap() as i32;
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info) as i32;
    let count = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    if count == 0 {
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
        return false;
    }
    assert_eq!(count, size, "Cannot inspect fixture process");
    info.pbi_start_tvsec == identity["startedSeconds"].as_u64().unwrap()
        && info.pbi_start_tvusec == identity["startedMicroseconds"].as_u64().unwrap()
        && info.pbi_status != libc::SZOMB
}
fn assert_retired(ready: &Value) {
    let deadline = Instant::now() + WAIT;
    while running(&ready["host"])
        || (!ready["descendant"].is_null() && running(&ready["descendant"]))
    {
        assert!(
            Instant::now() < deadline,
            "Owned process is still executing: {ready}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn witness() -> OwnedChild {
    OwnedChild::new(
        Command::new("/bin/sleep")
            .arg("60")
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    )
}

#[test]
fn cooperative_shutdown_reaps_native_host_and_io_workers() {
    let mut fixture = Fixture::start("cooperative");
    let ready = fixture.next("ready");
    assert!(running(&ready["host"]));
    let stopped = fixture.stop();
    assert_eq!(stopped["report"]["workers_reaped"], true);
    assert_eq!(stopped["report"]["forced"], false);
    fixture.exited(true);
    assert_retired(&ready);
}

#[test]
fn shutdown_reaps_stubborn_descendants_and_preserves_unrelated_processes() {
    let mut unrelated = witness();
    let mut fixture = Fixture::start("descendant");
    let ready = fixture.next("ready");
    assert!(running(&ready["descendant"]));
    let stopped = fixture.stop();
    assert_eq!(stopped["report"]["workers_reaped"], true);
    assert_eq!(stopped["report"]["forced"], true);
    fixture.exited(true);
    assert_retired(&ready);
    assert!(unrelated.try_wait().unwrap().is_none());
}

#[test]
fn core_crash_and_terminal_group_interrupt_preserve_the_cleanup_owner() {
    let mut unrelated = witness();
    for signal in [libc::SIGKILL, libc::SIGINT, libc::SIGHUP] {
        let mut fixture = Fixture::start("group-interrupt");
        let ready = fixture.next("ready");
        assert!(running(&ready["descendant"]));
        // The unreaped fixture is leader of its own group. SIGKILL targets only
        // Core; terminal signals target the group, as Ctrl+C/terminal close do.
        let target = if signal == libc::SIGKILL {
            fixture.child.id() as i32
        } else {
            -(fixture.child.id() as i32)
        };
        assert_eq!(unsafe { libc::kill(target, signal) }, 0);
        fixture.exited(false);
        assert_retired(&ready);
        assert!(unrelated.try_wait().unwrap().is_none());
    }
}

#[test]
fn core_shutdown_handlers_return_to_normal_host_cleanup() {
    for signal in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP] {
        let mut fixture = Fixture::start("handled-signal");
        let ready = fixture.next("ready");
        assert_eq!(
            unsafe { libc::kill(-(fixture.child.id() as i32), signal) },
            0
        );
        let stopped = fixture.next("stopped");
        assert_eq!(stopped["report"]["workers_reaped"], true);
        fixture.exited(true);
        assert_retired(&ready);
    }
}

#[test]
fn broken_protocol_and_blocked_stdin_cannot_hold_native_shutdown_open() {
    for (mode, codes) in [
        ("malformed", &["protocol_error"][..]),
        ("refuse-stdin", &["write_timeout", "stdin_write_failed"][..]),
    ] {
        let mut fixture = Fixture::start(mode);
        let failed = fixture.next("failure");
        assert!(
            codes.contains(&failed["code"].as_str().unwrap()),
            "{failed}"
        );
        let stopped = fixture.next("stopped");
        assert_eq!(stopped["report"]["workers_reaped"], true);
        fixture.exited(true);
    }
}
