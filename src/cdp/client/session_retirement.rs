//! Failed managed initialization still owns the acknowledged remote session.
//! The connection keeps one detach receipt until that exact session or transport
//! ends. Its cleanup never borrows plugin raw-request admission or closes another
//! session merely because this detach's observation budget has expired.

use super::*;

pub(super) struct RetiringSession {
    target_id: String,
    live: Arc<AtomicBool>,
    request_id: Option<u64>,
    phase: &'static str,
    expires_at: Option<Instant>,
}

fn report(session: &str, owner: &RetiringSession) {
    eprintln!(
        "cdp-session-retirement: target-id={}; session-id={session}; request-id={:?}; state={}",
        owner.target_id, owner.request_id, owner.phase
    );
}

impl CdpClient {
    pub(crate) fn target_is_retiring(&self, target: &str) -> bool {
        let shared = &self.inner.runtime.shared;
        let mut state = shared.state.lock().expect("CDP state poisoned");
        observe_deadlines(shared, &mut state);
        state
            .retiring_sessions
            .values()
            .any(|owner| owner.target_id == target)
    }

    pub(crate) fn retire_failed_session(
        &self,
        target: &str,
        session: &str,
        live: &Arc<AtomicBool>,
        budget: Duration,
    ) {
        let shared = &self.inner.runtime.shared;
        {
            let mut state = shared.state.lock().expect("CDP state poisoned");
            // Teardown and transport close race this publication under the same
            // state lock. Never create a new owner after either was confirmed.
            if state.terminal.is_some() || !live.load(Ordering::Acquire) {
                return;
            }
            if state.retiring_sessions.contains_key(session) {
                return;
            }
            state.retiring_sessions.insert(
                session.to_owned(),
                RetiringSession {
                    target_id: target.to_owned(),
                    live: Arc::clone(live),
                    request_id: None,
                    phase: "reserved",
                    expires_at: None,
                },
            );
        }
        if let Err(error) = self.enqueue_retirement(session, budget) {
            let mut state = shared.state.lock().expect("CDP state poisoned");
            if let Some(owner) = state.retiring_sessions.get_mut(session) {
                owner.phase = "unknown_not_dispatched";
                report(session, owner);
            }
            // Keep the initial Runtime/Page error as the caller's result.
            eprintln!("cdp-session-retirement: session-id={session}; error={error}");
        }
    }

    fn enqueue_retirement(&self, session: &str, budget: Duration) -> Result<(), ClientError> {
        let expires_at = Instant::now()
            .checked_add(budget)
            .ok_or(ClientError::DeadlineOutOfRange)?;
        let mut next_id = self
            .inner
            .next_id
            .lock()
            .expect("CDP request issuer poisoned");
        let id = *next_id;
        let following_id = id.checked_add(1).expect("CDP request id overflowed");
        let params = Some(serde_json::json!({"sessionId":session}));
        let bytes = encode_json_frame(&OutgoingRequest {
            id,
            method: "Target.detachFromTarget",
            params: params.clone(),
            session_id: None,
        })
        .map_err(|error| match error {
            FramingError::FrameTooLarge { max_bytes } => {
                ClientError::RequestFrameTooLarge { max_bytes }
            }
            other => ClientError::Connection(Arc::new(ConnectionError::Framing(other))),
        })?;
        let shared = &self.inner.runtime.shared;
        let mut state = shared.state.lock().expect("CDP state poisoned");
        if state.terminal.is_some() || !state.retiring_sessions.contains_key(session) {
            return Ok(());
        }
        let owner = state
            .retiring_sessions
            .get_mut(session)
            .expect("checked owner");
        if owner.request_id.is_some() {
            return Ok(());
        }
        if Instant::now() >= expires_at {
            owner.phase = "unknown_not_dispatched";
            report(session, owner);
            #[cfg(all(windows, feature = "desktop-acceptance"))]
            shared.trace_before_enqueue_expiry(
                id,
                "Target.detachFromTarget",
                None,
                &params,
                &state,
            );
            return Ok(());
        }
        owner.request_id = Some(id);
        owner.phase = "queued";
        owner.expires_at = Some(expires_at);
        report(session, owner);
        state.retirement_requests.insert(id, session.to_owned());
        let (completion, _) = mpsc::channel();
        if self
            .inner
            .runtime
            .writer_sender
            .send(WriterCommand::Frame {
                bytes,
                expires_at,
                timeout_error: Arc::new(ConnectionError::RequestTimedOut {
                    id,
                    method: "Target.detachFromTarget".into(),
                }),
                completion,
                raw_permit: None,
                retirement: Some((id, session.to_owned())),
            })
            .is_err()
        {
            drop(state);
            drop(next_id);
            self.inner.runtime.stop(Arc::new(ConnectionError::Protocol(
                "CDP writer stopped before accepting session retirement".into(),
            )));
            return Ok(());
        }
        assert_eq!(state.last_issued_id.checked_add(1), Some(id));
        state.last_issued_id = id;
        *next_id = following_id;
        #[cfg(all(windows, feature = "desktop-acceptance"))]
        shared.trace_enqueue(
            id,
            "Target.detachFromTarget",
            None,
            &params,
            expires_at,
            &state,
        );
        Ok(())
    }
}

pub(super) fn begin_write(
    shared: &Arc<Shared>,
    id: u64,
    session: &str,
    expires_at: Instant,
) -> bool {
    let mut state = shared.state.lock().expect("CDP state poisoned");
    if state.terminal.is_some()
        || state.retirement_requests.get(&id).map(String::as_str) != Some(session)
    {
        return false;
    }
    if Instant::now() >= expires_at {
        state.retirement_requests.remove(&id);
        if let Some(owner) = state.retiring_sessions.get_mut(session) {
            owner.phase = "unknown_not_written";
            report(session, owner);
        }
        #[cfg(all(windows, feature = "desktop-acceptance"))]
        shared.trace_expiry(id, "before_write");
        return false;
    }
    if let Some(owner) = state.retiring_sessions.get_mut(session) {
        owner.phase = "writing";
        report(session, owner);
    }
    true
}

pub(super) fn written(shared: &Arc<Shared>, id: u64, session: &str) {
    let mut state = shared.state.lock().expect("CDP state poisoned");
    if let Some(owner) = state.retiring_sessions.get_mut(session)
        && owner.request_id == Some(id)
    {
        owner.phase = "written_awaiting_receipt";
        report(session, owner);
    }
}

pub(super) fn observe_deadlines(shared: &Arc<Shared>, state: &mut State) {
    for (session, owner) in &mut state.retiring_sessions {
        if matches!(owner.phase, "writing" | "written_awaiting_receipt")
            && owner
                .expires_at
                .is_some_and(|until| Instant::now() >= until)
        {
            let writing = owner.phase == "writing";
            owner.phase = if writing {
                "unknown_writing"
            } else {
                "unknown_receipt"
            };
            report(session, owner);
            #[cfg(all(windows, feature = "desktop-acceptance"))]
            if let Some(id) = owner.request_id {
                shared.trace_expiry(
                    id,
                    if writing {
                        "retirement_writing"
                    } else {
                        "retirement_response"
                    },
                );
            }
        }
    }
    #[cfg(not(all(windows, feature = "desktop-acceptance")))]
    let _ = shared;
}

pub(super) fn response(
    shared: &Arc<Shared>,
    state: &mut State,
    id: u64,
    object: &Map<String, Value>,
) -> Result<(), ConnectionError> {
    let session = state
        .retirement_requests
        .get(&id)
        .expect("owned retirement request")
        .clone();
    let result = object.get("result");
    let error = object.get("error").map(parse_remote_error).transpose()?;
    if result.is_some() == error.is_some() {
        return Err(ConnectionError::Protocol(format!(
            "response {id} must contain exactly one of result or error"
        )));
    }
    ensure_response_session(id, &None, &optional_string(object, "sessionId")?)?;
    state.retirement_requests.remove(&id);
    if error.is_none() {
        ended(shared, state, &session, "detached");
    } else if let Some(owner) = state.retiring_sessions.get_mut(&session) {
        owner.phase = "unknown_detach_failed";
        report(&session, owner);
    }
    state.activity_epoch = state
        .activity_epoch
        .checked_add(1)
        .expect("CDP activity epoch overflowed");
    shared.activity.notify_all();
    Ok(())
}

pub(super) fn ended(_shared: &Arc<Shared>, state: &mut State, session: &str, phase: &'static str) {
    if let Some(mut owner) = state.retiring_sessions.remove(session) {
        owner.live.store(false, Ordering::Release);
        owner.phase = phase;
        report(session, &owner);
        if let Some(id) = owner.request_id {
            state.retirement_requests.remove(&id);
        }
        state.default_contexts.forget(session);
    }
}

pub(super) fn connection_ended(shared: &Arc<Shared>, state: &mut State) {
    let sessions: Vec<_> = state.retiring_sessions.keys().cloned().collect();
    for session in sessions {
        ended(shared, state, &session, "connection_ended");
    }
    debug_assert!(state.retirement_requests.is_empty());
}

#[cfg(all(test, windows))]
mod tests;
