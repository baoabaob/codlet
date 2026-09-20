//! Production owner for a checked Codlet update. The helper waits for exact old
//! identities; this owner sends only the existing audited application quit message.
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::cdp::{TargetChange, TargetSession};
use crate::runtime_manage::RuntimeManageService;
use crate::runtime_update::{
    RuntimePayloadProfile, RuntimeProcessIdentity, RuntimeRestartCommand, RuntimeRestartContext,
    RuntimeUpdatePhase, RuntimeUpdateService, RuntimeUpdateStatus,
};
use crate::runtime_update_owner::RuntimeUpdateHandoff;
use crate::windows::control_pipe::RegistryScope;
use crate::windows::process::ChildProcess;

const RESTART_SCRIPT: &[u8] = include_bytes!("../../scripts/Restart-Codlet.ps1");
const QUIT_SCRIPT: &str = include_str!("../lab/quit.js");
const QUIT_AVAILABLE_SCRIPT: &str = r#"(() => { const document = 'app://-/index.html'; const href = window.location.href; return window === window.top && (href === document || href.startsWith(document + '?') || href.startsWith(document + '#')) && window.electronBridge?.windowType === 'electron' && typeof window.electronBridge?.sendMessageFromView === 'function'; })()"#;
const AUDITED_QUIT_VERSIONS: &[&str] = &["26.903.8094.0", "26.903.9818.0", "26.908.4834.0", "26.915.4065.0"];

pub(super) struct RuntimeUpdateOwner {
    service: Option<RuntimeUpdateService>,
    sessions: BTreeMap<String, TargetSession>,
    handoff: Option<RuntimeUpdateHandoff>,
    quit_started: Option<Instant>,
    timeout_reported: bool,
}

impl RuntimeUpdateOwner {
    pub fn start(
        manage: &RuntimeManageService,
        registry_path: &Path,
        watch: bool,
        child: &ChildProcess,
        package_version: &str,
        sessions: &[TargetSession],
    ) -> Self {
        let mut owner = Self {
            service: None,
            sessions: BTreeMap::new(),
            handoff: None,
            quit_started: None,
            timeout_reported: false,
        };
        owner.seed_sessions(sessions);
        manage.start_plugin_update_checks();
        let result = (|| {
            let executable = std::env::current_exe().map_err(|error| error.to_string())?;
            let install_root = executable
                .parent()
                .ok_or("The runtime installation has no parent directory.")?
                .to_owned();
            let scope =
                RegistryScope::for_path(registry_path).map_err(|error| error.to_string())?;
            let state_root = install_root.join(".codlet-updates").join(scope.id());
            let restart =
                restart_context(&executable, registry_path, watch, child, package_version);
            RuntimeUpdateService::start_with_preferences(
                install_root,
                state_root,
                restart,
                manage.preferences_for_start(),
            )
            .map_err(|error| error.to_string())
        })();
        match result {
            Ok(service) => {
                manage.set_runtime_update(service.clone());
                owner.service = Some(service);
            }
            Err(error) => eprintln!("runtime-update: unavailable; {error}"),
        }
        owner
    }

    pub fn seed_sessions(&mut self, sessions: &[TargetSession]) {
        for session in sessions {
            self.sessions
                .insert(session.target_id().to_owned(), session.clone());
        }
    }

    pub fn observe(&mut self, change: &TargetChange) {
        match change {
            TargetChange::Attached(session) => {
                self.sessions
                    .insert(session.target_id().to_owned(), session.clone());
            }
            TargetChange::NavigatedAway(session) => {
                self.sessions.remove(session.target_id());
            }
            TargetChange::SessionEnded {
                target_id,
                session_id,
            } => {
                if self
                    .sessions
                    .get(target_id)
                    .is_some_and(|session| session.session_id() == session_id)
                {
                    self.sessions.remove(target_id);
                }
            }
        }
    }

    pub fn installing(&self) -> bool {
        self.handoff.is_some() || self.quit_started.is_some()
    }

    pub fn poll(&mut self, management_busy: bool) {
        let Some(service) = self.service.clone() else {
            return;
        };
        if self.quit_started.is_some() {
            if self.restore_management_after_terminal_failure(&service.status()) {
                eprintln!(
                    "runtime-update: helper failure is confirmed; the retained client can manage plugins again"
                );
                return;
            }
            if !self.timeout_reported
                && self
                    .quit_started
                    .is_some_and(|started| started.elapsed() > Duration::from_secs(20))
            {
                self.timeout_reported = true;
                eprintln!(
                    "runtime-update: the owned Desktop has not confirmed exit; it is retained and the installer must keep waiting or fail safely"
                );
            }
            return;
        }
        if management_busy {
            return;
        }
        if self.handoff.is_none()
            && let Some(request) = service.take_install_request()
        {
            let available = self
                .sessions
                .values()
                .find(|session| session.is_live())
                .and_then(|session| {
                    session
                        .until(Instant::now() + Duration::from_secs(3))
                        .evaluate(QUIT_AVAILABLE_SCRIPT)
                        .ok()
                })
                .is_some_and(|value| {
                    value.get("exceptionDetails").is_none()
                        && value
                            .pointer("/result/value")
                            .and_then(serde_json::Value::as_bool)
                            == Some(true)
                });
            if !available {
                service.install_handoff_failed(&request.id, "The owned main document has no available audited quit bridge; the current client was retained.");
                return;
            }
            self.handoff = Some(RuntimeUpdateHandoff::start(service.clone(), request));
        }
        let Some(result) = self.handoff.as_ref().and_then(RuntimeUpdateHandoff::poll) else {
            return;
        };
        self.handoff = None;
        if let Err(error) = result {
            eprintln!("runtime-update: helper handoff failed; current client retained: {error}");
            return;
        }
        self.quit_started = Some(Instant::now());
        let result = self
            .sessions
            .values()
            .find(|session| session.is_live())
            .ok_or_else(|| {
                "The owned main document ended before the application quit request.".to_owned()
            })
            .and_then(request_quit);
        match result {
            Ok(()) => eprintln!(
                "runtime-update: checked installer armed; normal quit requested for the owned Desktop"
            ),
            Err(error) => eprintln!(
                "runtime-update: quit response unavailable ({error}); waiting for the exact owned Desktop to exit, without a force stop or retry"
            ),
        }
    }

    fn restore_management_after_terminal_failure(&mut self, status: &RuntimeUpdateStatus) -> bool {
        if self.quit_started.is_some()
            && status.error.is_some()
            && matches!(
                status.phase,
                RuntimeUpdatePhase::Downloaded | RuntimeUpdatePhase::Failed
            )
        {
            self.quit_started = None;
            self.timeout_reported = false;
            self.handoff = None;
            return true;
        }
        false
    }
}

fn restart_context(
    executable: &Path,
    registry_path: &Path,
    watch: bool,
    child: &ChildProcess,
    package_version: &str,
) -> Option<RuntimeRestartContext> {
    if !AUDITED_QUIT_VERSIONS.contains(&package_version)
        || !executable
            .file_name()?
            .to_str()?
            .eq_ignore_ascii_case("codlet.exe")
    {
        return None;
    }
    let directory = executable.parent()?;
    let wrapper = directory.join("Restart-Codlet.ps1");
    let mut script = Vec::with_capacity(RESTART_SCRIPT.len());
    std::fs::File::open(&wrapper)
        .ok()?
        .take(RESTART_SCRIPT.len() as u64 + 1)
        .read_to_end(&mut script)
        .ok()?;
    if script.as_slice() != RESTART_SCRIPT {
        return None;
    }
    let powershell = PathBuf::from(std::env::var_os("SystemRoot")?)
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    if !powershell.is_file() {
        return None;
    }
    let scope = RegistryScope::for_path(registry_path).ok()?;
    let mut args = vec![
        "-NoLogo".into(),
        "-NoProfile".into(),
        "-NonInteractive".into(),
        "-ExecutionPolicy".into(),
        "Bypass".into(),
        "-File".into(),
        wrapper.to_str()?.into(),
        "-Executable".into(),
        executable.to_str()?.into(),
        "-RegistryPath".into(),
        registry_path.to_str()?.into(),
        "-RegistryScope".into(),
        scope.id().to_owned(),
    ];
    if watch {
        args.push("-Watch".into());
    }
    let environment =
        BTreeMap::from([("LOCALAPPDATA".into(), std::env::var("LOCALAPPDATA").ok()?)]);
    Some(RuntimeRestartContext {
        profile: RuntimePayloadProfile::Portable,
        command: RuntimeRestartCommand {
            program: powershell,
            args,
            working_directory: std::env::current_dir().ok()?,
            environment,
            timeout_seconds: 120,
        },
        wait_for: vec![RuntimeProcessIdentity {
            pid: child.process_id(),
            creation_time: child.creation_time_filetime().ok()?.to_string(),
        }],
        launcher_files: vec![wrapper],
        config_pin: None,
    })
}

fn request_quit(session: &TargetSession) -> Result<(), String> {
    let result = session
        .until(Instant::now() + Duration::from_secs(3))
        .evaluate(QUIT_SCRIPT)
        .map_err(|error| error.to_string())?;
    if result.get("exceptionDetails").is_none()
        && result
            .pointer("/result/value/status")
            .and_then(serde_json::Value::as_str)
            == Some("quit_requested")
    {
        Ok(())
    } else {
        Err("The audited application quit bridge did not confirm the request.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retained_client_resumes_management_only_after_confirmed_terminal_failure() {
        let mut owner = RuntimeUpdateOwner {
            service: None,
            sessions: BTreeMap::new(),
            handoff: None,
            quit_started: Some(Instant::now()),
            timeout_reported: true,
        };
        let mut status = RuntimeUpdateStatus {
            current_version: "fixture".into(),
            phase: RuntimeUpdatePhase::InstallRequested,
            configured: true,
            channel: "fixture".into(),
            last_checked_at: None,
            next_check_at: None,
            candidate: None,
            downloaded_bytes: 0,
            total_bytes: 0,
            install_available: true,
            unavailable_reason: None,
            error: None,
        };
        assert!(owner.installing());
        assert!(!owner.restore_management_after_terminal_failure(&status));
        assert!(owner.installing());
        status.phase = RuntimeUpdatePhase::Downloaded;
        assert!(
            !owner.restore_management_after_terminal_failure(&status),
            "a downloaded state alone does not confirm the old helper failed"
        );
        status.error = Some(crate::runtime_update::RuntimeUpdateError {
            code: "owner_still_running".into(),
            message: "The old client was retained.".into(),
        });
        assert!(owner.restore_management_after_terminal_failure(&status));
        assert!(!owner.installing());
        assert!(!owner.timeout_reported);
        owner.quit_started = Some(Instant::now());
        status.phase = RuntimeUpdatePhase::Failed;
        status.install_available = false;
        assert!(owner.restore_management_after_terminal_failure(&status));
        assert!(
            !owner.installing(),
            "blocked future updates must not block ordinary plugin management"
        );
    }
}
