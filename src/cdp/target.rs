use std::collections::HashMap;
use std::fmt;
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Map, Value, json};
use thiserror::Error;

use super::{CdpClient, CdpEvent, CdpEventStream, ClientError, EventStreamError};

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
    #[error("Target.attachToTarget returned invalid data: {0}")]
    InvalidAttach(String),
    #[error("{method} contained invalid target data: {message}")]
    InvalidTargetEvent { method: String, message: String },
    #[error(transparent)]
    EventStream(#[from] EventStreamError),
}

#[derive(Clone)]
pub struct TargetSession {
    client: CdpClient,
    target_id: String,
    session_id: String,
    deadline: Duration,
}

#[derive(Clone)]
pub enum TargetChange {
    Attached(TargetSession),
    NavigatedAway(TargetSession),
    SessionEnded {
        target_id: String,
        session_id: String,
    },
}

impl TargetChange {
    pub fn target_id(&self) -> &str {
        match self {
            Self::Attached(session) => session.target_id(),
            Self::NavigatedAway(session) => session.target_id(),
            Self::SessionEnded { target_id, .. } => target_id,
        }
    }
}

pub struct TargetController {
    client: CdpClient,
    events: CdpEventStream,
    sessions: HashMap<String, TargetSession>,
    deadline: Duration,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachResult {
    session_id: String,
}

impl TargetSession {
    fn attach(
        client: CdpClient,
        target_id: String,
        expires_at: Instant,
        deadline: Duration,
    ) -> Result<Self, TargetError> {
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
        self.evaluate_in_context(expression, None)
    }

    pub(crate) fn evaluate_in_context(
        &self,
        expression: &str,
        context_id: Option<u64>,
    ) -> Result<Value, TargetError> {
        let mut params = json!({
            "expression": expression,
            "returnByValue": true,
            "awaitPromise": true
        });
        if let Some(context_id) = context_id {
            params["contextId"] = json!(context_id);
        }
        self.request("Runtime.evaluate", Some(params))
    }

    pub(crate) fn request(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, TargetError> {
        let response =
            self.client
                .request(method, params, Some(&self.session_id), self.deadline)?;
        Ok(response
            .result
            .expect("successful CDP response must contain result"))
    }

    pub(crate) fn subscribe_events(&self) -> CdpEventStream {
        self.client.subscribe_events(Some(&self.session_id))
    }

    pub(crate) fn detach(&self) -> Result<(), TargetError> {
        self.client.request(
            "Target.detachFromTarget",
            Some(json!({"sessionId": self.session_id})),
            None,
            self.deadline,
        )?;
        Ok(())
    }
}

impl TargetController {
    pub fn discover(
        client: CdpClient,
        events: CdpEventStream,
        deadline: Duration,
    ) -> Result<(Self, Vec<TargetSession>), TargetError> {
        let started_at = Instant::now();
        let expires_at = started_at
            .checked_add(deadline)
            .ok_or(ClientError::DeadlineOutOfRange)?;
        let mut controller = Self {
            client,
            events,
            sessions: HashMap::new(),
            deadline,
        };
        controller.client.request(
            "Target.setDiscoverTargets",
            Some(json!({"discover": true})),
            None,
            remaining_budget(expires_at),
        )?;

        let mut attempts = 0_u64;
        let mut last_observations = Vec::new();
        loop {
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
            let targets = controller
                .client
                .request("Target.getTargets", None, None, remaining)?;
            let observations = parse_target_observations(
                targets
                    .result
                    .ok_or_else(|| TargetError::InvalidGetTargets("missing result".to_owned()))?,
            )?;
            let sessions = controller.attach_matching(&observations, expires_at)?;
            if !sessions.is_empty() {
                return Ok((controller, sessions));
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
        }
    }

    pub fn pump(&mut self, timeout: Duration) -> Result<Vec<TargetChange>, TargetError> {
        let mut event = match self.events.recv_timeout(timeout) {
            Ok(event) => event,
            Err(EventStreamError::Timeout) => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        loop {
            let changes = self.handle_event(event)?;
            if !changes.is_empty() {
                return Ok(changes);
            }
            match self.events.recv_timeout(Duration::ZERO) {
                Ok(next) => event = next,
                Err(EventStreamError::Timeout) => return Ok(Vec::new()),
                Err(error) => return Err(error.into()),
            }
        }
    }

    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }

    pub fn contains_target(&self, target_id: &str) -> bool {
        self.sessions.contains_key(target_id)
    }

    fn handle_event(&mut self, event: CdpEvent) -> Result<Vec<TargetChange>, TargetError> {
        match event.method.as_str() {
            "Target.targetCreated" => {
                let observation = parse_target_event(&event)?;
                let expires_at = Instant::now()
                    .checked_add(self.deadline)
                    .ok_or(ClientError::DeadlineOutOfRange)?;
                Ok(self
                    .attach_matching(&[observation], expires_at)?
                    .into_iter()
                    .map(TargetChange::Attached)
                    .collect())
            }
            "Target.targetInfoChanged" => {
                let observation = parse_target_event(&event)?;
                if !is_main_renderer(&observation) {
                    return Ok(self
                        .sessions
                        .remove(&observation.target_id)
                        .map(TargetChange::NavigatedAway)
                        .into_iter()
                        .collect());
                }
                let expires_at = Instant::now()
                    .checked_add(self.deadline)
                    .ok_or(ClientError::DeadlineOutOfRange)?;
                Ok(self
                    .attach_matching(&[observation], expires_at)?
                    .into_iter()
                    .map(TargetChange::Attached)
                    .collect())
            }
            "Target.targetDestroyed" => {
                let target_id = event_target_id(&event)?;
                Ok(self.end_target_session(target_id).into_iter().collect())
            }
            "Target.detachedFromTarget" => {
                let session_id = event_session_id(&event)?;
                Ok(self.end_exact_session(session_id).into_iter().collect())
            }
            _ => Ok(Vec::new()),
        }
    }

    fn attach_matching(
        &mut self,
        observations: &[TargetObservation],
        expires_at: Instant,
    ) -> Result<Vec<TargetSession>, TargetError> {
        let mut attached = Vec::new();
        for observation in observations
            .iter()
            .filter(|target| is_main_renderer(target))
        {
            if self.sessions.contains_key(&observation.target_id) {
                continue;
            }
            let session = TargetSession::attach(
                self.client.clone(),
                observation.target_id.clone(),
                expires_at,
                self.deadline,
            )?;
            self.sessions
                .insert(observation.target_id.clone(), session.clone());
            attached.push(session);
        }
        Ok(attached)
    }

    fn end_target_session(&mut self, target_id: &str) -> Option<TargetChange> {
        self.sessions
            .remove(target_id)
            .map(|session| TargetChange::SessionEnded {
                target_id: target_id.to_owned(),
                session_id: session.session_id,
            })
    }

    fn end_exact_session(&mut self, session_id: &str) -> Option<TargetChange> {
        let target_id = self.sessions.iter().find_map(|(target_id, session)| {
            (session.session_id == session_id).then(|| target_id.clone())
        })?;
        self.end_target_session(&target_id)
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
            parse_target_observation(value, &format!("targetInfos[{index}]"))
                .map_err(TargetError::InvalidGetTargets)
        })
        .collect()
}

fn parse_target_event(event: &CdpEvent) -> Result<TargetObservation, TargetError> {
    let target_info = event
        .params
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|params| params.get("targetInfo"))
        .ok_or_else(|| TargetError::InvalidTargetEvent {
            method: event.method.clone(),
            message: "params.targetInfo is missing".to_owned(),
        })?;
    parse_target_observation(target_info, "params.targetInfo").map_err(|message| {
        TargetError::InvalidTargetEvent {
            method: event.method.clone(),
            message,
        }
    })
}

fn event_target_id(event: &CdpEvent) -> Result<&str, TargetError> {
    event
        .params
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|params| params.get("targetId"))
        .and_then(Value::as_str)
        .ok_or_else(|| TargetError::InvalidTargetEvent {
            method: event.method.clone(),
            message: "params.targetId is not a string".to_owned(),
        })
}

fn event_session_id(event: &CdpEvent) -> Result<&str, TargetError> {
    event
        .params
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|params| params.get("sessionId"))
        .and_then(Value::as_str)
        .ok_or_else(|| TargetError::InvalidTargetEvent {
            method: event.method.clone(),
            message: "params.sessionId is not a string".to_owned(),
        })
}

fn parse_target_observation(value: &Value, context: &str) -> Result<TargetObservation, String> {
    let target = value
        .as_object()
        .ok_or_else(|| format!("{context} is not an object"))?;
    Ok(TargetObservation {
        target_id: required_target_string(target, context, "targetId")?,
        target_type: required_target_string(target, context, "type")?,
        url: required_target_string(target, context, "url")?,
        title: optional_target_string(target, context, "title")?,
        attached: optional_target_bool(target, context, "attached")?,
    })
}

fn required_target_string(
    target: &Map<String, Value>,
    context: &str,
    field: &str,
) -> Result<String, String> {
    target
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("{context}.{field} is not a string"))
}

fn optional_target_string(
    target: &Map<String, Value>,
    context: &str,
    field: &str,
) -> Result<Option<String>, String> {
    target
        .get(field)
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| format!("{context}.{field} is not a string"))
        })
        .transpose()
}

fn optional_target_bool(
    target: &Map<String, Value>,
    context: &str,
    field: &str,
) -> Result<Option<bool>, String> {
    target
        .get(field)
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| format!("{context}.{field} is not a boolean"))
        })
        .transpose()
}

fn is_main_renderer(target: &TargetObservation) -> bool {
    target.target_type == "page" && is_main_renderer_url(&target.url)
}

fn is_main_renderer_url(url: &str) -> bool {
    url == MAIN_RENDERER_URL
        || url
            .strip_prefix(MAIN_RENDERER_URL)
            .is_some_and(|suffix| suffix.starts_with('?') || suffix.starts_with('#'))
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
    fn matches_main_renderer_document_with_route_suffixes() {
        let observations = parse_target_observations(json!({
            "targetInfos": [
                {"targetId": "devtools", "type": "page", "url": "devtools://devtools"},
                {"targetId": "query", "type": "page", "url": "app://-/index.html?initialRoute=thread", "title": "Codex"},
                {"targetId": "fragment", "type": "page", "url": "app://-/index.html#/local/thread"},
                {"targetId": "worker", "type": "worker", "url": MAIN_RENDERER_URL},
                {"targetId": "main-a", "type": "page", "url": MAIN_RENDERER_URL},
                {"targetId": "main-b", "type": "page", "url": MAIN_RENDERER_URL}
            ]
        }))
        .unwrap();
        let matches: Vec<_> = observations
            .iter()
            .filter(|target| is_main_renderer(target))
            .map(|target| target.target_id.as_str())
            .collect();
        assert_eq!(matches, ["query", "fragment", "main-a", "main-b"]);
    }

    #[test]
    fn similarly_prefixed_urls_and_non_page_targets_are_rejected() {
        let observations = parse_target_observations(json!({
            "targetInfos": [
                {"targetId": "suffix", "type": "page", "url": "app://-/index.html.evil", "title": "Codex"},
                {"targetId": "child-path", "type": "page", "url": "app://-/index.html/other", "title": "Codex"},
                {"targetId": "wrong-host", "type": "page", "url": "app://other/index.html?initialRoute=thread", "title": "Codex"},
                {"targetId": "worker", "type": "worker", "url": MAIN_RENDERER_URL, "title": "Codex"}
            ]
        }))
        .unwrap();
        assert!(!observations.iter().any(is_main_renderer));
    }

    #[test]
    fn target_info_changed_uses_the_same_document_identity() {
        let event = CdpEvent {
            method: "Target.targetInfoChanged".to_owned(),
            params: Some(json!({
                "targetInfo": {"targetId": "new-window", "type": "page", "url": MAIN_RENDERER_URL}
            })),
            session_id: None,
        };
        let observation = parse_target_event(&event).unwrap();
        assert!(is_main_renderer(&observation));
        assert_eq!(observation.target_id, "new-window");
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
