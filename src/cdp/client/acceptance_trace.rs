//! Metadata for the disposable desktop acceptance harness only. No params,
//! response bodies, expressions or Native content enter this sink.

use super::*;
use serde_json::json;

type Sink = Arc<dyn Fn(&str, Value) + Send + Sync>;

#[derive(Default)]
pub(super) struct TraceState {
    sink: Option<Sink>,
    requests: HashMap<u64, Value>,
}

impl CdpClient {
    pub(crate) fn set_acceptance_trace(&self, sink: Option<Sink>) {
        *self
            .inner
            .runtime
            .shared
            .acceptance_trace
            .lock()
            .expect("CDP trace state poisoned") = TraceState {
            sink,
            requests: HashMap::new(),
        };
    }
}

fn metadata(
    id: u64,
    method: &str,
    session: Option<&str>,
    params: &Option<Value>,
    state: Option<&State>,
) -> Value {
    // detachFromTarget addresses its actual session in params, not the flattened
    // envelope. Record this identity but no other method-specific parameter.
    let owned_session = (method == "Target.detachFromTarget")
        .then(|| {
            params
                .as_ref()
                .and_then(|p| p.get("sessionId"))
                .and_then(Value::as_str)
        })
        .flatten();
    let target = params
        .as_ref()
        .and_then(|p| p.get("targetId"))
        .and_then(Value::as_str)
        .or_else(|| {
            session
                .or(owned_session)
                .and_then(|s| state.and_then(|state| state.sessions.get(s)))
                .map(|(target, _)| target.as_str())
        });
    json!({"id":id,"method":method,"sessionId":session,"targetId":target,"ownedSessionId":owned_session})
}

impl Shared {
    pub(super) fn trace_before_enqueue_expiry(
        &self,
        id: u64,
        method: &str,
        session: Option<&str>,
        params: &Option<Value>,
        state: &State,
    ) {
        let trace = self
            .acceptance_trace
            .lock()
            .expect("CDP trace state poisoned");
        if let Some(sink) = &trace.sink {
            let mut details = metadata(id, method, session, params, Some(state));
            details["phase"] = json!("before_enqueue");
            details["enqueued"] = json!(false);
            sink("transport.expiry", details);
        }
    }

    pub(super) fn trace_enqueue(
        &self,
        id: u64,
        method: &str,
        session: Option<&str>,
        params: &Option<Value>,
        expires_at: Instant,
        state: &State,
    ) {
        let mut trace = self
            .acceptance_trace
            .lock()
            .expect("CDP trace state poisoned");
        if trace.sink.is_none() {
            return;
        }
        let mut details = metadata(id, method, session, params, Some(state));
        details["remainingMs"] = json!(remaining(expires_at).as_millis());
        trace.requests.insert(id, details.clone());
        trace.sink.as_ref().unwrap()("transport.enqueue", details);
    }

    pub(super) fn trace_writing(&self, id: u64) {
        let trace = self
            .acceptance_trace
            .lock()
            .expect("CDP trace state poisoned");
        if let Some(sink) = &trace.sink {
            let details = trace
                .requests
                .get(&id)
                .cloned()
                .unwrap_or_else(|| json!({"id":id}));
            sink("transport.write.begin", details);
        }
    }

    pub(super) fn trace_written(&self, id: u64) {
        let trace = self
            .acceptance_trace
            .lock()
            .expect("CDP trace state poisoned");
        if let Some(sink) = &trace.sink {
            let details = trace
                .requests
                .get(&id)
                .cloned()
                .unwrap_or_else(|| json!({"id":id}));
            sink("transport.written", details);
        }
    }

    pub(super) fn trace_expiry(&self, id: u64, phase: &str) {
        let trace = self
            .acceptance_trace
            .lock()
            .expect("CDP trace state poisoned");
        if let Some(sink) = &trace.sink {
            let mut details = trace
                .requests
                .get(&id)
                .cloned()
                .unwrap_or_else(|| json!({"id":id}));
            details["phase"] = json!(phase);
            sink("transport.expiry", details);
        }
    }

    pub(super) fn trace_response(&self, id: u64, object: &Map<String, Value>) {
        let trace = self
            .acceptance_trace
            .lock()
            .expect("CDP trace state poisoned");
        if let Some(sink) = &trace.sink {
            let mut details = trace
                .requests
                .get(&id)
                .cloned()
                .unwrap_or_else(|| json!({"id":id}));
            details["responseSessionId"] = object
                .get("sessionId")
                .and_then(Value::as_str)
                .map(|id| json!(id))
                .unwrap_or(Value::Null);
            details["remoteErrorCode"] = object
                .get("error")
                .and_then(|e| e.get("code"))
                .and_then(Value::as_i64)
                .map(|code| json!(code))
                .unwrap_or(Value::Null);
            if details["method"] == "Target.attachToTarget" {
                details["attachedSessionId"] = object
                    .get("result")
                    .and_then(|r| r.get("sessionId"))
                    .and_then(Value::as_str)
                    .map(|id| json!(id))
                    .unwrap_or(Value::Null);
            }
            sink("transport.response", details);
        }
    }

    pub(super) fn trace_target_event(&self, event: &CdpEvent) {
        if !matches!(
            event.method.as_str(),
            "Target.targetCreated"
                | "Target.targetInfoChanged"
                | "Target.targetDestroyed"
                | "Target.detachedFromTarget"
        ) {
            return;
        }
        let trace = self
            .acceptance_trace
            .lock()
            .expect("CDP trace state poisoned");
        if let Some(sink) = &trace.sink {
            let params = event.params.as_ref();
            let target = params
                .and_then(|p| {
                    p.get("targetId")
                        .or_else(|| p.get("targetInfo").and_then(|p| p.get("targetId")))
                })
                .and_then(Value::as_str);
            let ended_session = params
                .and_then(|p| p.get("sessionId"))
                .and_then(Value::as_str);
            sink(
                "transport.target-event",
                json!({"method":event.method,"targetId":target,"sessionId":event.session_id,"endedSessionId":ended_session}),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trace_keeps_protocol_identity_and_discards_native_payloads() {
        let _serial = super::super::tests::SPAWN_TEST_LOCK.lock().unwrap();
        let (reader, _remote_writer) = super::super::tests::blocking_pipe_reader();
        let (client, _events) =
            CdpClient::spawn_io(reader, io::sink(), SpawnConfig::default()).unwrap();
        let records = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
        let sink_records = Arc::clone(&records);
        client.set_acceptance_trace(Some(Arc::new(move |event, value| {
            sink_records.lock().unwrap().push((event.to_owned(), value));
        })));
        let shared = &client.inner.runtime.shared;
        let state = shared.state.lock().unwrap();
        shared.trace_enqueue(
            1,
            "Target.attachToTarget",
            None,
            &Some(json!({
                "targetId":"target-a", "expression":"sensitive-request", "roots":["sensitive-root"]
            })),
            Instant::now() + Duration::from_secs(1),
            &state,
        );
        drop(state);
        shared.trace_writing(1);
        shared.trace_written(1);
        shared.trace_response(1, json!({"result":{"sessionId":"session-a","content":"sensitive-response"},"error":{"code":-1,"message":"sensitive-error"}}).as_object().unwrap());
        let state = shared.state.lock().unwrap();
        shared.trace_before_enqueue_expiry(
            2,
            "Runtime.evaluate",
            Some("session-a"),
            &Some(json!({"expression":"sensitive-expired"})),
            &state,
        );
        drop(state);
        let records = records.lock().unwrap();
        let serialized = serde_json::to_string(&*records).unwrap();
        assert!(!serialized.contains("sensitive-"));
        assert_eq!(records[0].1["targetId"], "target-a");
        assert_eq!(records[1].0, "transport.write.begin");
        assert_eq!(records[3].1["attachedSessionId"], "session-a");
        assert_eq!(records[4].0, "transport.expiry");
        assert_eq!(records[4].1["phase"], "before_enqueue");
        assert_eq!(records[4].1["enqueued"], false);
        drop(records);
        client.set_acceptance_trace(None);
        client.shutdown().unwrap();
    }
}
