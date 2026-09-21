use super::*;
use crate::cdp::{TargetChange, TargetSession};
use crate::runtime_manage::RuntimeManageService;
use crate::runtime_update::RuntimeInstallRequest;
use crate::runtime_update_owner::RuntimeUpdateHandoff;
use crate::windows::packages::{
    CODEX_EXECUTABLE_RELATIVE_PATH, CODEX_PACKAGE_FAMILY, InstalledPackage,
    find_unique_current_user_package, resolve_package_executable,
};
use crate::windows::{process::ChildProcess, restart_bridge::RestartBridge};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant};

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum UpdateExit {
    Ordinary,
    Restart,
    Combined,
}

#[derive(Default)]
struct RestartIntent {
    pending: bool,
    registered_at: Option<Instant>,
    settled_samples: u8,
}
impl RestartIntent {
    fn registered(&mut self) {
        self.pending = true;
        self.registered_at = Some(Instant::now());
        self.settled_samples = 0;
    }
    fn observe(&mut self, phase: &str) -> bool {
        if !self.pending {
            return false;
        }
        if phase == "installing" {
            self.settled_samples = 0;
            return false;
        }
        if matches!(phase, "idle" | "ready")
            && self
                .registered_at
                .is_some_and(|t| t.elapsed() > Duration::from_secs(2))
        {
            self.settled_samples += 1;
            if self.settled_samples >= 3 {
                self.pending = false;
                return true;
            }
        }
        false
    }
}

pub(crate) struct OfficialUpdateOwner {
    bridge: Option<RestartBridge>,
    manage: RuntimeManageService,
    package: InstalledPackage,
    sessions: BTreeMap<String, TargetSession>,
    last_probe: Instant,
    intent: RestartIntent,
    handoff: Option<RuntimeUpdateHandoff>,
    request: Option<RuntimeInstallRequest>,
    install_sent: Option<Instant>,
    rehearsal: bool,
    completed: bool,
    reported_status: String,
}
impl OfficialUpdateOwner {
    pub fn start(
        child: &ChildProcess,
        package: &InstalledPackage,
        manage: RuntimeManageService,
    ) -> Self {
        let result = RestartBridge::install(
            child,
            &package
                .install_location
                .join("app/resources/native/windows-updater.node"),
        )
        .and_then(|bridge| {
            bridge.enable(true)?;
            Ok(bridge)
        });
        let bridge = match result {
            Ok(bridge) => {
                *manage.folder_foreground.lock().unwrap_or_else(|e| e.into_inner()) =
                    bridge.foreground_permission().ok();
                eprintln!("official-update: native restart bridge loaded into the owned client");
                Some(bridge)
            }
            Err(error) => {
                eprintln!("official-update: restart preservation unavailable: {error}");
                manage.official_updates.0.lock().unwrap().status.error = Some(error);
                None
            }
        };
        Self {
            bridge,
            manage,
            package: package.clone(),
            sessions: BTreeMap::new(),
            last_probe: Instant::now() - Duration::from_secs(2),
            intent: Default::default(),
            handoff: None,
            request: None,
            install_sent: None,
            rehearsal: false,
            completed: false,
            reported_status: String::new(),
        }
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
                    .is_some_and(|s| s.session_id() == session_id)
                {
                    self.sessions.remove(target_id);
                }
            }
        }
    }
    fn evaluate(&self, action: Value) -> Result<Value, String> {
        let installing = action["kind"] == "install";
        let script = include_str!("../official_update_bridge.js")
            .replace(
                "__CODLET_PROFILES__",
                include_str!("../../compatibility/client-profiles.json"),
            )
            .replace("__CODLET_ACTION__", &action.to_string());
        for session in self.sessions.values().filter(|s| s.is_live()) {
            let result = session
                .until(Instant::now() + Duration::from_secs(2))
                .evaluate(&script)
                .map_err(|e| e.to_string())?;
            if result.get("exceptionDetails").is_some() {
                if installing {
                    return Err("The official install call raised an exception; it will not be retried in another window.".into());
                }
                continue;
            }
            if let Some(value) = result
                .pointer("/result/value")
                .filter(|v| v["available"] == true)
            {
                return Ok(value.clone());
            }
        }
        Err("The official update service is not available in an audited main window.".into())
    }
    pub fn poll(&mut self, management_busy: bool) {
        if let Some(bridge) = &self.bridge {
            if bridge.take_registered() {
                self.intent.registered();
                eprintln!("official-update: installer requested restart; Core owns the handoff");
            }
            if let Ok(snapshot) = bridge.snapshot() {
                let ready = snapshot.ready && snapshot.error.is_none();
                let mut state = self.manage.official_updates.0.lock().unwrap();
                if ready && !state.status.restart_preserved {
                    match bridge.enable(true) {
                        Ok(()) => state.status.restart_preserved = true,
                        Err(error) => state.status.error = Some(error),
                    }
                } else if !ready {
                    state.status.restart_preserved = false;
                }
                if let Some(error) = snapshot.error {
                    state.status.error = Some(format!("Native restart bridge error: {error}"));
                }
            }
        }
        if self.last_probe.elapsed() < Duration::from_secs(1) {
            return;
        }
        self.last_probe = Instant::now();
        let sample = self.evaluate(json!({"kind":"status"}));
        if let Ok(value) = &sample {
            let phase = value["phase"].as_str().unwrap_or("idle");
            {
                let mut state = self.manage.official_updates.0.lock().unwrap();
                state.status.available = true;
                state.status.phase = phase.into();
                state.status.is_update_ready = value["isUpdateReady"] == true;
            }
            if self.intent.observe(phase) {
                eprintln!("official-update: installer returned to {phase}; restart intent cleared");
                if let Some(request) = &self.request {
                    let _ = self.evaluate(json!({"kind":"retire","id":request.id}));
                    self.abort("The official update was cancelled or did not complete.");
                }
            }
        } else {
            self.manage
                .official_updates
                .0
                .lock()
                .unwrap()
                .status
                .available = false;
        }
        if let Err(error) = self.poll_combined(management_busy) {
            self.abort(&error);
        }
        let report = serde_json::to_string(&self.manage.official_updates.status()).unwrap();
        if report != self.reported_status {
            eprintln!("official-update: {report}");
            self.reported_status = report;
        }
    }
    fn poll_combined(&mut self, management_busy: bool) -> Result<(), String> {
        let status = self.manage.official_updates.status();
        if !matches!(
            status.combined_phase.as_str(),
            "downloading" | "preparing" | "installing"
        ) {
            return Ok(());
        }
        let runtime = self
            .manage
            .runtime_update_service()
            .ok_or("Runtime update service ended")?;
        let core = runtime.status();
        let candidate = self
            .manage
            .official_updates
            .0
            .lock()
            .unwrap()
            .candidate_id
            .clone();
        if core.candidate.as_ref().map(|c| &c.id) != candidate.as_ref() {
            return Err("The Codlet update candidate changed; review the updates again.".into());
        }
        if core.error.is_some() || core.phase == RuntimeUpdatePhase::Failed {
            return Err(core
                .error
                .map(|e| e.message)
                .unwrap_or_else(|| "Codlet update preparation failed".into()));
        }
        if status.combined_phase == "downloading" && core.phase == RuntimeUpdatePhase::Downloaded {
            if management_busy {
                return Ok(());
            }
            if !status.available
                || !status.restart_preserved
                || !status.is_update_ready
                || status.phase != "ready"
            {
                return Err(
                    "The official update is no longer ready; the current client was retained."
                        .into(),
                );
            }
            runtime
                .request_combined_install()
                .map_err(|e| e.to_string())?;
            self.manage
                .official_updates
                .0
                .lock()
                .unwrap()
                .status
                .combined_phase = "preparing".into();
        }
        if self.handoff.is_none()
            && self.request.is_none()
            && let Some(request) = runtime.take_install_request_for(true)
        {
            self.handoff = Some(RuntimeUpdateHandoff::start(
                runtime.clone(),
                request.clone(),
            ));
            self.request = Some(request);
        }
        if let Some(result) = self.handoff.as_ref().and_then(RuntimeUpdateHandoff::poll) {
            self.handoff = None;
            result?;
            if !status.restart_preserved {
                return Err(
                    "Restart preservation is unavailable; the current client was retained.".into(),
                );
            }
            self.install_sent = Some(Instant::now());
            self.manage
                .official_updates
                .0
                .lock()
                .unwrap()
                .status
                .combined_phase = "installing".into();
            let id = self.request.as_ref().unwrap().id.clone();
            // A timeout after dispatch is uncertain. Keep the helper gated and
            // observe the real native installer; never retry the API call.
            match self.evaluate(json!({"kind":"install","id":id})) {
                Ok(value) if value["accepted"] == true => (),
                Ok(_) => return Err("The official installer did not accept the update.".into()),
                Err(error) => eprintln!(
                    "official-update: install response unavailable; observing without retry: {error}"
                ),
            }
        }
        if self
            .install_sent
            .is_some_and(|at| at.elapsed() > Duration::from_secs(120))
            && !self.intent.pending
        {
            return Err("The official installer did not begin installation; the current client was retained.".into());
        }
        Ok(())
    }
    fn abort(&mut self, error: &str) {
        if let Some(request) = self.request.take() {
            let _ = gate(&request, false, error);
        }
        self.handoff = None;
        self.install_sent = None;
        self.manage.official_updates.fail(error);
    }
    /// Only the lab's explicit stdin control exposes this rehearsal. It never
    /// calls the official installer or changes the registered Windows package.
    pub fn rehearse(&mut self) -> Result<(), String> {
        if self.manage.official_updates.busy() {
            return Err("An update is already running".into());
        }
        if !self.manage.official_updates.status().restart_preserved {
            return Err("Native restart preservation is not ready".into());
        }
        self.rehearsal = true;
        self.intent.registered();
        Ok(())
    }
    pub fn is_rehearsal(&self) -> bool {
        self.rehearsal
    }
    pub fn waiting_for_restart(&mut self) -> bool {
        if self
            .bridge
            .as_ref()
            .is_some_and(RestartBridge::take_registered)
        {
            self.intent.registered();
        }
        self.intent.pending
    }
    pub fn finish(&mut self) -> UpdateExit {
        if self
            .bridge
            .as_ref()
            .is_some_and(RestartBridge::take_registered)
        {
            self.intent.registered();
        }
        if self.rehearsal {
            self.completed = true;
            return UpdateExit::Restart;
        }
        if !self.intent.pending {
            self.abort_pending("Client closed without a confirmed official installation.");
            return UpdateExit::Ordinary;
        }
        eprintln!("official-update: waiting for Windows to finish registering the updated package");
        let deadline = Instant::now() + Duration::from_secs(300);
        let mut stable = None;
        while Instant::now() < deadline {
            if let Ok(package) = find_unique_current_user_package(CODEX_PACKAGE_FAMILY)
                && newer_package(&self.package, &package)
                && resolve_package_executable(&package, Path::new(CODEX_EXECUTABLE_RELATIVE_PATH))
                    .is_ok()
            {
                if stable.as_ref() == Some(&package.full_name) {
                    if let Some(request) = self.request.take() {
                        if let Err(error) = gate(&request, true, &package.full_name) {
                            eprintln!("official-update: combined handoff failed: {error}");
                            return UpdateExit::Ordinary;
                        }
                        self.completed = true;
                        return UpdateExit::Combined;
                    }
                    self.completed = true;
                    return UpdateExit::Restart;
                }
                stable = Some(package.full_name);
            } else {
                stable = None;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        self.abort_pending(
            "Windows did not confirm a newer installed package within five minutes.",
        );
        eprintln!(
            "official-update: installation was not confirmed; no automatic second client was launched"
        );
        UpdateExit::Ordinary
    }
    fn abort_pending(&mut self, error: &str) {
        if self.request.is_some() || self.manage.official_updates.busy() {
            self.abort(error);
        }
    }
}
impl Drop for OfficialUpdateOwner {
    fn drop(&mut self) {
        if !self.completed {
            self.abort_pending("The update owner stopped before confirming installation.");
        }
    }
}
fn newer_package(old: &InstalledPackage, new: &InstalledPackage) -> bool {
    let parts = |p: &InstalledPackage| {
        (
            p.version.major,
            p.version.minor,
            p.version.build,
            p.version.revision,
        )
    };
    old.family_name == new.family_name && old.full_name != new.full_name && parts(new) > parts(old)
}
fn gate(request: &RuntimeInstallRequest, ready: bool, detail: &str) -> Result<(), String> {
    let path = request.plan_path.with_file_name("official-result.json");
    let temporary = path.with_extension("tmp");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    file.write_all(
        json!({"id":request.id,"planSha256":request.plan_sha256,"ready":ready,"detail":detail})
            .to_string()
            .as_bytes(),
    )
    .and_then(|()| file.sync_all())
    .map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(temporary, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ordinary_close_and_cancel_are_not_update_restarts() {
        let mut state = RestartIntent::default();
        assert!(!state.pending);
        state.registered();
        assert!(state.pending);
        state.registered_at = Some(Instant::now() - Duration::from_secs(5));
        assert!(!state.observe("installing"));
        assert!(state.pending);
        assert!(!state.observe("ready"));
        assert!(!state.observe("ready"));
        assert!(state.observe("ready"));
        assert!(!state.pending);
        state.registered();
        assert!(state.pending);
    }
}
