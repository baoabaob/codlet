use std::time::{Duration, Instant};

use serde_json::Value;

use crate::cdp::TargetSession;

const QUIT_SCRIPT: &str = include_str!("quit.js");
const REQUEST_BUDGET: Duration = Duration::from_secs(3);
const EXIT_BUDGET: Duration = Duration::from_secs(15);

pub(super) fn request(session: &TargetSession) -> Result<(), String> {
    if !session.is_live() {
        return Err("the owned renderer session has ended".into());
    }
    let response = session
        .until(Instant::now() + REQUEST_BUDGET)
        .evaluate(QUIT_SCRIPT)
        .map_err(|error| error.to_string())?;
    check_response(&response)
}

fn check_response(response: &Value) -> Result<(), String> {
    if response.get("exceptionDetails").is_some() {
        return Err("the fixed application quit request raised an exception".into());
    }
    match response
        .pointer("/result/value/status")
        .and_then(Value::as_str)
    {
        Some("quit_requested") => Ok(()),
        Some("wrong_document") => Err("the owned renderer is not the audited main document".into()),
        Some("bridge_unavailable") => {
            Err("the audited application quit bridge is unavailable".into())
        }
        _ => Err("the fixed application quit request returned an invalid result".into()),
    }
}

pub(super) struct QuitState {
    requested_at: Option<Instant>,
    timeout_reported: bool,
}

impl QuitState {
    pub fn new() -> Self {
        Self {
            requested_at: None,
            timeout_reported: false,
        }
    }
    pub fn requested(&self) -> bool {
        self.requested_at.is_some()
    }
    pub fn begin(&mut self) -> bool {
        if self.requested() {
            return false;
        }
        self.requested_at = Some(Instant::now());
        true
    }
    pub fn take_timeout(&mut self) -> bool {
        if !self.timeout_reported
            && self
                .requested_at
                .is_some_and(|time| time.elapsed() >= EXIT_BUDGET)
        {
            self.timeout_reported = true;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn application_quit_acknowledgment_is_not_an_exit_observation() {
        check_response(&json!({"result":{"value":{"status":"quit_requested"}}})).unwrap();
        assert!(
            check_response(&json!({"result":{"value":{"status":"bridge_unavailable"}}})).is_err()
        );
        assert!(
            check_response(
                &json!({"exceptionDetails":{},"result":{"value":{"status":"quit_requested"}}})
            )
            .is_err()
        );
        let mut state = QuitState::new();
        assert!(state.begin());
        assert!(!state.begin());
        assert!(!state.take_timeout());
        state.requested_at = Some(Instant::now() - EXIT_BUDGET);
        assert!(state.take_timeout());
        assert!(!state.take_timeout());
        assert!(state.requested());
    }
}
