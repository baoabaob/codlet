use std::fmt;
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Map, Value, json};
use thiserror::Error;

use super::{CdpClient, ClientError};

pub const MAIN_RENDERER_URL: &str = "app://-/index.html";
const TARGET_POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone, PartialEq, Eq)]
pub struct TargetObservation {
    pub target_id: String,
    pub target_type: String,
    pub url: String,
    pub title: Option<String>,
    pub attached: Option<bool>,
}

impl fmt::Debug for TargetObservation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TargetObservation")
            .field("targetId", &self.target_id)
            .field("type", &self.target_type)
            .field("url", &self.url)
            .field("title", &self.title)
            .field("attached", &self.attached)
            .finish()
    }
}

#[derive(Debug, Error)]
pub enum TargetError {
    #[error(transparent)]
    Client(#[from] ClientError),
    #[error("Target.getTargets returned invalid data: {0}")]
    InvalidGetTargets(String),
    #[error(
        "Codex main renderer target was not found (attempts={attempts}, elapsed_ms={elapsed_ms}, observations={observations:?})"
    )]
    MainTargetNotFound {
        attempts: u64,
        elapsed_ms: u64,
        observations: Vec<TargetObservation>,
    },
    #[error("found {0} matching Codex main renderer targets")]
    AmbiguousMainTarget(usize),
    #[error("Target.attachToTarget returned invalid data: {0}")]
    InvalidAttach(String),
}

pub struct TargetSession {
    client: CdpClient,
    target_id: String,
    session_id: String,
    deadline: Duration,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachResult {
    session_id: String,
}

impl TargetSession {
    pub fn discover(client: CdpClient, deadline: Duration) -> Result<Self, TargetError> {
        let started_at = Instant::now();
        let expires_at = started_at
            .checked_add(deadline)
            .ok_or(ClientError::DeadlineOutOfRange)?;
        let mut attempts = 0_u64;
        let mut last_observations = Vec::new();
        let target_id = loop {
            let remaining = remaining_budget(expires_at);
            if remaining.is_zero() {
                return Err(main_target_not_found(
                    started_at,
                    attempts,
                    last_observations,
                ));
            }
            attempts = attempts
                .checked_add(1)
                .expect("target discovery attempt count overflowed");
            let targets = client.request("Target.getTargets", None, None, remaining)?;
            let observations = parse_target_observations(
                targets
                    .result
                    .ok_or_else(|| TargetError::InvalidGetTargets("missing result".to_owned()))?,
            )?;
            if let Some(target_id) = select_main_target(&observations)? {
                break target_id;
            }
            last_observations = observations;

            let remaining = remaining_budget(expires_at);
            if remaining.is_zero() {
                return Err(main_target_not_found(
                    started_at,
                    attempts,
                    last_observations,
                ));
            }
            thread::sleep(TARGET_POLL_INTERVAL.min(remaining));
        };

        let attach = client.request(
            "Target.attachToTarget",
            Some(json!({"targetId": target_id, "flatten": true})),
            None,
            remaining_budget(expires_at),
        )?;
        let attach: AttachResult = serde_json::from_value(
            attach
                .result
                .ok_or_else(|| TargetError::InvalidAttach("missing result".to_owned()))?,
        )
        .map_err(|error| TargetError::InvalidAttach(error.to_string()))?;

        client.request(
            "Runtime.enable",
            None,
            Some(&attach.session_id),
            remaining_budget(expires_at),
        )?;
        client.request(
            "Page.enable",
            None,
            Some(&attach.session_id),
            remaining_budget(expires_at),
        )?;

        Ok(Self {
            client,
            target_id,
            session_id: attach.session_id,
            deadline,
        })
    }

    pub fn target_id(&self) -> &str {
        &self.target_id
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn evaluate(&self, expression: &str) -> Result<Value, TargetError> {
        let response = self.client.request(
            "Runtime.evaluate",
            Some(json!({
                "expression": expression,
                "returnByValue": true,
                "awaitPromise": true
            })),
            Some(&self.session_id),
            self.deadline,
        )?;
        Ok(response
            .result
            .expect("successful CDP response must contain result"))
    }
}

fn parse_target_observations(value: Value) -> Result<Vec<TargetObservation>, TargetError> {
    let object = value
        .as_object()
        .ok_or_else(|| TargetError::InvalidGetTargets("result is not an object".to_owned()))?;
    let target_infos = object
        .get("targetInfos")
        .and_then(Value::as_array)
        .ok_or_else(|| TargetError::InvalidGetTargets("targetInfos is not an array".to_owned()))?;

    target_infos
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let target = value.as_object().ok_or_else(|| {
                TargetError::InvalidGetTargets(format!("targetInfos[{index}] is not an object"))
            })?;
            Ok(TargetObservation {
                target_id: required_target_string(target, index, "targetId")?,
                target_type: required_target_string(target, index, "type")?,
                url: required_target_string(target, index, "url")?,
                title: optional_target_string(target, index, "title")?,
                attached: optional_target_bool(target, index, "attached")?,
            })
        })
        .collect()
}

fn required_target_string(
    target: &Map<String, Value>,
    index: usize,
    field: &str,
) -> Result<String, TargetError> {
    target
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            TargetError::InvalidGetTargets(format!("targetInfos[{index}].{field} is not a string"))
        })
}

fn optional_target_string(
    target: &Map<String, Value>,
    index: usize,
    field: &str,
) -> Result<Option<String>, TargetError> {
    target
        .get(field)
        .map(|value| {
            value.as_str().map(str::to_owned).ok_or_else(|| {
                TargetError::InvalidGetTargets(format!(
                    "targetInfos[{index}].{field} is not a string"
                ))
            })
        })
        .transpose()
}

fn optional_target_bool(
    target: &Map<String, Value>,
    index: usize,
    field: &str,
) -> Result<Option<bool>, TargetError> {
    target
        .get(field)
        .map(|value| {
            value.as_bool().ok_or_else(|| {
                TargetError::InvalidGetTargets(format!(
                    "targetInfos[{index}].{field} is not a boolean"
                ))
            })
        })
        .transpose()
}

fn select_main_target(observations: &[TargetObservation]) -> Result<Option<String>, TargetError> {
    let matches: Vec<_> = observations
        .iter()
        .filter(|target| target.target_type == "page" && target.url == MAIN_RENDERER_URL)
        .collect();
    match matches.len() {
        0 => Ok(None),
        1 => Ok(Some(matches[0].target_id.clone())),
        count => Err(TargetError::AmbiguousMainTarget(count)),
    }
}

fn main_target_not_found(
    started_at: Instant,
    attempts: u64,
    observations: Vec<TargetObservation>,
) -> TargetError {
    TargetError::MainTargetNotFound {
        attempts,
        elapsed_ms: started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        observations,
    }
}

fn remaining_budget(expires_at: Instant) -> Duration {
    expires_at.saturating_duration_since(Instant::now())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_only_exact_main_renderer() {
        let observations = parse_target_observations(json!({
            "targetInfos": [
                {"targetId": "devtools", "type": "page", "url": "devtools://devtools"},
                {"targetId": "query", "type": "page", "url": "app://-/index.html?initialRoute=thread", "title": "Codex"},
                {"targetId": "worker", "type": "worker", "url": MAIN_RENDERER_URL},
                {"targetId": "main", "type": "page", "url": MAIN_RENDERER_URL}
            ]
        }))
        .unwrap();
        let target = select_main_target(&observations).unwrap().unwrap();
        assert_eq!(target, "main");
    }

    #[test]
    fn title_and_worker_type_do_not_relax_exact_identity() {
        let observations = parse_target_observations(json!({
            "targetInfos": [
                {"targetId": "query", "type": "page", "url": "app://-/index.html?initialRoute=thread", "title": "Codex"},
                {"targetId": "worker", "type": "worker", "url": MAIN_RENDERER_URL, "title": "Codex"}
            ]
        }))
        .unwrap();
        assert_eq!(select_main_target(&observations).unwrap(), None);
    }

    #[test]
    fn rejects_ambiguous_main_renderer_immediately() {
        let observations = parse_target_observations(json!({
            "targetInfos": [
                {"targetId": "a", "type": "page", "url": MAIN_RENDERER_URL},
                {"targetId": "b", "type": "page", "url": MAIN_RENDERER_URL}
            ]
        }))
        .unwrap();
        assert!(matches!(
            select_main_target(&observations),
            Err(TargetError::AmbiguousMainTarget(2))
        ));
    }

    #[test]
    fn malformed_observation_field_is_explicitly_rejected() {
        assert!(matches!(
            parse_target_observations(json!({
                "targetInfos": [
                    {"targetId": "main", "type": "page", "url": MAIN_RENDERER_URL, "attached": "yes"}
                ]
            })),
            Err(TargetError::InvalidGetTargets(message))
                if message == "targetInfos[0].attached is not a boolean"
        ));
    }

    #[test]
    fn not_found_display_and_debug_include_bounded_observations() {
        let error = TargetError::MainTargetNotFound {
            attempts: 3,
            elapsed_ms: 250,
            observations: vec![TargetObservation {
                target_id: "starting".to_owned(),
                target_type: "page".to_owned(),
                url: "about:blank".to_owned(),
                title: Some("Codex".to_owned()),
                attached: Some(false),
            }],
        };

        for rendered in [error.to_string(), format!("{error:?}")] {
            assert!(rendered.contains("attempts=3") || rendered.contains("attempts: 3"));
            assert!(rendered.contains("elapsed_ms=250") || rendered.contains("elapsed_ms: 250"));
            assert!(rendered.contains("targetId"));
            assert!(rendered.contains("starting"));
            assert!(rendered.contains("type"));
            assert!(rendered.contains("page"));
            assert!(rendered.contains("about:blank"));
            assert!(rendered.contains("title"));
            assert!(rendered.contains("attached"));
        }
    }
}
