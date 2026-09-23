//! A checked update helper may outlive only this owner's normal shutdown.
//! The helper remains unarmed until its complete preflight receipt is received.
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
#[cfg(target_os = "macos")]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{
    CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW,
};

use crate::runtime_update::{RuntimeInstallRequest, RuntimeUpdateService};

pub(crate) struct RuntimeUpdateHandoff(Receiver<Result<(), String>>);

impl RuntimeUpdateHandoff {
    pub(crate) fn start(service: RuntimeUpdateService, request: RuntimeInstallRequest) -> Self {
        let (sender, result) = mpsc::channel();
        std::thread::spawn(move || {
            let mut ack_sent = false;
            let outcome = handoff(&request, &mut ack_sent);
            // After an uncertain acknowledgment the helper's persisted terminal
            // receipt decides whether retry is safe. Do not open a second install.
            if let Err(error) = &outcome
                && !ack_sent
            {
                service.install_handoff_failed(&request.id, error.clone());
            }
            let _ = sender.send(outcome);
        });
        Self(result)
    }
    pub(crate) fn poll(&self) -> Option<Result<(), String>> {
        match self.0.try_recv() {
            Ok(result) => Some(result),
            Err(mpsc::TryRecvError::Empty) => None,
            Err(mpsc::TryRecvError::Disconnected) => Some(Err(
                "Update handoff worker exited before acknowledging readiness.".into(),
            )),
        }
    }
}

fn handoff(request: &RuntimeInstallRequest, ack_sent: &mut bool) -> Result<(), String> {
    let log_path = request
        .plan_path
        .parent()
        .ok_or("The install plan has no parent directory.")?
        .join("handoff-stderr.log");
    let log = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(log_path)
        .map_err(|error| error.to_string())?;
    let mut command = Command::new(&request.node_path);
    command
        .arg(&request.helper_path)
        .arg("--plan")
        .arg(&request.plan_path)
        .arg("--sha256")
        .arg(&request.plan_sha256)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(log));
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB);
    #[cfg(target_os = "macos")]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start the update helper: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Update helper has no readiness pipe.")?;
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut line = Vec::new();
        // The first and only handshake line is bounded independently of any logs.
        let result = std::io::Read::take(BufReader::new(stdout), 16385)
            .read_until(b'\n', &mut line)
            .map_err(|error| error.to_string())
            .and_then(|_| {
                if line.len() > 16384 || !line.ends_with(b"\n") {
                    return Err("Update helper sent an invalid readiness receipt.".into());
                }
                serde_json::from_slice::<Value>(&line).map_err(|error| error.to_string())
            });
        let _ = sender.send(result);
    });
    let receipt = receiver
        .recv_timeout(Duration::from_secs(45))
        .map_err(|_| {
            "Update helper did not confirm readiness; the client remains running.".to_owned()
        })??;
    validate_ready(&receipt, &request.id, &request.plan_sha256)?;
    if child
        .try_wait()
        .map_err(|error| error.to_string())?
        .is_some()
    {
        return Err("Update helper exited before handoff.".into());
    }
    let temporary_ack = request.handoff_ack_path.with_extension("tmp");
    let mut ack = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary_ack)
        .map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec(&json!({"id":request.id,"planSha256":request.plan_sha256}))
        .expect("ack serializes");
    ack.write_all(&bytes)
        .and_then(|()| ack.sync_all())
        .map_err(|error| error.to_string())?;
    drop(ack);
    std::fs::rename(&temporary_ack, &request.handoff_ack_path)
        .map_err(|error| error.to_string())?;
    *ack_sent = true;
    let receipt_path = request.plan_path.with_file_name("install-receipt.json");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            *ack_sent = false;
            return Err("Update helper exited before confirming the handoff.".into());
        }
        if let Ok(file) = std::fs::File::open(&receipt_path) {
            let mut bytes = Vec::new();
            std::io::Read::read_to_end(&mut std::io::Read::take(file, 65537), &mut bytes)
                .map_err(|error| error.to_string())?;
            if bytes.len() <= 65536
                && let Ok(receipt) = serde_json::from_slice::<Value>(&bytes)
                && receipt["schema"] == 1
                && receipt["id"] == request.id
                && receipt["planSha256"] == request.plan_sha256
            {
                if receipt["phase"] == "waitingForExit" {
                    break;
                }
                if receipt["phase"] == "failed" {
                    *ack_sent = false;
                    return Err(receipt["error"]["message"]
                        .as_str()
                        .unwrap_or("Update helper rejected the handoff.")
                        .into());
                }
            }
        }
        if Instant::now() >= deadline {
            return Err("Update handoff confirmation is pending; the client remains running until the helper reports its result.".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    // Dropping a Child handle does not terminate it. Only the armed helper owns
    // the subsequent verified wait/replace/restart transaction.
    Ok(())
}

fn validate_ready(receipt: &Value, id: &str, digest: &str) -> Result<(), String> {
    if receipt["schema"] != 1
        || receipt["event"] != "runtime-update-helper-ready"
        || receipt["id"] != id
        || receipt["planSha256"] != digest
    {
        return Err(receipt["error"]["message"]
            .as_str()
            .unwrap_or("The update helper did not acknowledge this install plan.")
            .to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_the_matching_positive_preflight_can_arm_installation() {
        let valid = json!({"schema":1,"event":"runtime-update-helper-ready","id":"request","planSha256":"digest"});
        assert!(validate_ready(&valid, "request", "digest").is_ok());
        for (key, value) in [
            ("schema", json!(2)),
            ("id", json!("stale")),
            ("planSha256", json!("changed")),
            ("event", json!("runtime-update-helper-failed")),
        ] {
            let mut changed = valid.clone();
            changed[key] = value;
            assert!(validate_ready(&changed, "request", "digest").is_err());
        }
    }
}
