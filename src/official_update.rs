//! Official updates use the client's own channel and installer. Core contributes
//! only restart ownership and the optional coordinated Codlet update transaction.
use crate::runtime_update::{RuntimeUpdatePhase, RuntimeUpdateService};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OfficialUpdateStatus {
    pub available: bool,
    pub restart_preserved: bool,
    pub phase: String,
    pub is_update_ready: bool,
    pub combined_phase: String,
    pub error: Option<String>,
    pub target: Option<OfficialUpdateTarget>,
    pub compatible_candidate_id: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OfficialUpdateTarget {
    pub id: String,
    pub version: String,
}
impl Default for OfficialUpdateStatus {
    fn default() -> Self {
        Self {
            available: false,
            restart_preserved: false,
            phase: "idle".into(),
            is_update_ready: false,
            combined_phase: "idle".into(),
            error: None,
            target: None,
            compatible_candidate_id: None,
        }
    }
}
#[derive(Default)]
struct State {
    status: OfficialUpdateStatus,
    candidate_id: Option<String>,
    expected_target: Option<OfficialUpdateTarget>,
}
#[derive(Clone, Default)]
pub(crate) struct OfficialUpdates(Arc<Mutex<State>>);
impl OfficialUpdates {
    pub fn status(&self) -> OfficialUpdateStatus {
        self.0.lock().unwrap().status.clone()
    }
    pub fn busy(&self) -> bool {
        matches!(
            self.status().combined_phase.as_str(),
            "downloading" | "preparing" | "installing"
        )
    }
    pub fn request_combined(
        &self,
        runtime: &RuntimeUpdateService,
        expected_candidate: &str,
        expected_target: Option<&str>,
    ) -> Result<OfficialUpdateStatus, String> {
        let mut state = self.0.lock().unwrap();
        if matches!(
            state.status.combined_phase.as_str(),
            "downloading" | "preparing" | "installing"
        ) {
            return Ok(state.status.clone());
        }
        let update = runtime.status();
        if update
            .candidate
            .as_ref()
            .is_none_or(|c| c.id != expected_candidate)
        {
            return Err("The update changed. Cancel and review it again before installing.".into());
        }
        if !state.status.available
            || !state.status.restart_preserved
            || !state.status.is_update_ready
            || state.status.phase != "ready"
            || !update.install_available
            || state.status.compatible_candidate_id.as_deref() != Some(expected_candidate)
            || state
                .status
                .target
                .as_ref()
                .is_none_or(|target| expected_target.is_some_and(|expected| target.id != expected))
            || !matches!(
                update.phase,
                RuntimeUpdatePhase::Available | RuntimeUpdatePhase::Downloaded
            )
        {
            return Err("Both updates must be ready for this Codlet launcher before a combined update can start.".into());
        }
        state.candidate_id = Some(
            update
                .candidate
                .as_ref()
                .ok_or("Codlet update candidate is unavailable")?
                .id
                .clone(),
        );
        state.expected_target = state.status.target.clone();
        if update.phase == RuntimeUpdatePhase::Available {
            runtime.download().map_err(|e| e.to_string())?;
        }
        state.status.combined_phase = "downloading".into();
        state.status.error = None;
        Ok(state.status.clone())
    }
    #[cfg(windows)]
    fn fail(&self, message: impl Into<String>) {
        let mut state = self.0.lock().unwrap();
        state.status.combined_phase = "failed".into();
        state.status.error = Some(message.into());
        state.candidate_id = None;
        state.expected_target = None;
    }
}

#[cfg(windows)]
mod owner;
#[cfg(windows)]
pub(crate) use owner::{OfficialUpdateOwner, UpdateExit};
