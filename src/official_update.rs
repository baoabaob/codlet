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
impl State {
    fn validate_combined_identity(
        &self,
        expected_candidate: &str,
        expected_target: Option<&str>,
    ) -> Result<bool, String> {
        let busy = matches!(
            self.status.combined_phase.as_str(),
            "downloading" | "preparing" | "installing"
        );
        let target = if busy {
            self.expected_target.as_ref()
        } else {
            self.status.target.as_ref()
        };
        if expected_target.is_none()
            || target.is_none_or(|target| Some(target.id.as_str()) != expected_target)
            || busy && self.candidate_id.as_deref() != Some(expected_candidate)
        {
            return Err("The update changed or its target was not confirmed. Cancel and review it again before installing.".into());
        }
        Ok(busy)
    }
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
        if state.validate_combined_identity(expected_candidate, expected_target)? {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> State {
        let mut state = State::default();
        state.status.target = Some(OfficialUpdateTarget {
            id: "confirmed-target".into(),
            version: "26.1021.3705.0".into(),
        });
        state
    }

    #[test]
    fn combined_update_requires_the_confirmed_target_before_scheduling() {
        let state = state();
        assert!(state.validate_combined_identity("candidate", None).is_err());
        assert!(
            state
                .validate_combined_identity("candidate", Some(""))
                .is_err()
        );
        assert!(
            state
                .validate_combined_identity("candidate", Some("earlier-target"))
                .is_err()
        );
        assert_eq!(
            state.validate_combined_identity("candidate", Some("confirmed-target")),
            Ok(false)
        );
    }

    #[test]
    fn pending_combined_update_queries_only_the_original_identity() {
        for phase in ["downloading", "preparing", "installing"] {
            let mut state = state();
            state.status.combined_phase = phase.into();
            state.candidate_id = Some("original-candidate".into());
            state.expected_target = state.status.target.clone();
            state.status.target = Some(OfficialUpdateTarget {
                id: "newly-observed-target".into(),
                version: "26.1022.1.0".into(),
            });
            assert_eq!(
                state.validate_combined_identity("original-candidate", Some("confirmed-target")),
                Ok(true)
            );
            assert!(
                state
                    .validate_combined_identity("original-candidate", None)
                    .is_err()
            );
            assert!(
                state
                    .validate_combined_identity("original-candidate", Some("newly-observed-target"))
                    .is_err()
            );
            assert!(
                state
                    .validate_combined_identity("new-candidate", Some("confirmed-target"))
                    .is_err()
            );
            assert_eq!(state.candidate_id.as_deref(), Some("original-candidate"));
            assert_eq!(
                state.expected_target.as_ref().unwrap().id,
                "confirmed-target"
            );
        }
    }
}
