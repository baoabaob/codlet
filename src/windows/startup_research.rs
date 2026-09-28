//! Opt-in lab only. No DLL name, fuse layout or bootstrap semantics in Core.
use super::process::{ProcessError, SuspendedChild};
use std::{
    io::{BufRead, BufReader, Read},
    os::windows::{io::AsRawHandle, process::CommandExt},
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::FILETIME,
    System::Threading::{CREATE_NO_WINDOW, GetProcessTimes},
};

pub(super) fn before_resume(child: &SuspendedChild) -> Result<(), ProcessError> {
    let Some(helper) = std::env::var_os("CODLET_ACCEPTANCE_STARTUP_HELPER") else {
        return Ok(());
    };
    let err = |e: String| ProcessError::PackageLaunch(format!("acceptance startup helper: {e}"));
    let root = PathBuf::from(
        std::env::var_os("CODLET_ACCEPTANCE_ROOT").ok_or_else(|| err("no isolated root".into()))?,
    );
    if !root.is_absolute()
        || std::fs::read_to_string(root.join("owner.txt")).map_err(|e| err(e.to_string()))?
            != "codlet-desktop-acceptance\n"
    {
        return Err(err("no fixture owner".into()));
    }
    if !PathBuf::from(&helper).is_absolute() || !PathBuf::from(&helper).is_file() {
        return Err(err("helper must be an explicit absolute executable".into()));
    }
    let image = super::local_ipc::process_image_path(child.process.as_raw_handle().cast())
        .map_err(|e| err(e.to_string()))?;
    let expected = PathBuf::from(
        std::env::var_os("CODLET_ACCEPTANCE_EXE")
            .ok_or_else(|| err("no reviewed executable".into()))?,
    );
    if image.canonicalize().map_err(|e| err(e.to_string()))?
        != expected.canonicalize().map_err(|e| err(e.to_string()))?
    {
        return Err(err("wrong owned image".into()));
    }
    let (mut created, mut exit, mut kernel, mut user) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    if unsafe {
        GetProcessTimes(
            child.process.as_raw_handle().cast(),
            &mut created,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    } == 0
    {
        return Err(err("creation time unavailable".into()));
    }
    let created = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
    let mut helper = Command::new(helper)
        .arg(child.pid.to_string())
        .arg(created.to_string())
        .arg(&image)
        .arg(root.join("native-bootstrap.json"))
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| err(e.to_string()))?;
    let stdout = helper.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout)
            .take(64)
            .read_line(&mut line)
            .map(|_| line);
        let _ = tx.send(result);
    });
    let result = rx.recv_timeout(Duration::from_secs(6));
    if !matches!(result,Ok(Ok(ref line)) if line.trim()=="armed") {
        let _ = helper.kill();
        let _ = helper.wait();
        return Err(err("debugger did not arm".into()));
    }
    // The fixture's debugger has its own bounded deadline and exact-child
    // failure cleanup. Reap it; never pass a detached process handle to plugins.
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if matches!(helper.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = helper.kill();
        let _ = helper.wait();
    });
    Ok(())
}
