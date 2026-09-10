use std::collections::HashMap;

use serde_json::Value;

use super::CdpEvent;

const MAX_FRAMES_PER_SESSION: usize = 256;

/// A bounded cache of CDP's default execution contexts for owned sessions.
/// Runtime.enable emits these before its response; retaining them avoids a
/// second enable/disable cycle or exposing a temporary all-world binding.
#[derive(Default)]
pub(super) struct DefaultContexts(HashMap<String, HashMap<String, u64>>);

impl DefaultContexts {
    pub(super) fn get(&self, session: &str, frame: &str) -> Option<u64> {
        self.0.get(session)?.get(frame).copied()
    }

    pub(super) fn forget(&mut self, session: &str) {
        self.0.remove(session);
    }

    pub(super) fn retain(&mut self, keep: impl Fn(&str) -> bool) {
        self.0.retain(|session, _| keep(session));
    }

    pub(super) fn observe(&mut self, event: &CdpEvent) {
        let Some(session) = event.session_id.as_deref() else {
            return;
        };
        if event.method == "Runtime.executionContextsCleared" {
            self.forget(session);
            return;
        }
        let Some(params) = event.params.as_ref() else {
            return;
        };
        match event.method.as_str() {
            "Runtime.executionContextCreated" => {
                let Some(context) = params.get("context") else {
                    return;
                };
                if context.pointer("/auxData/isDefault") != Some(&Value::Bool(true)) {
                    return;
                }
                let (Some(id), Some(frame)) = (
                    context.get("id").and_then(Value::as_u64),
                    context.pointer("/auxData/frameId").and_then(Value::as_str),
                ) else {
                    return;
                };
                if id == 0 || id > 9_007_199_254_740_991 || frame.is_empty() || frame.len() > 256 {
                    return;
                }
                let frames = self.0.entry(session.to_owned()).or_default();
                if frames.len() < MAX_FRAMES_PER_SESSION || frames.contains_key(frame) {
                    frames.insert(frame.to_owned(), id);
                }
            }
            "Runtime.executionContextDestroyed" => {
                if let Some(id) = params.get("executionContextId").and_then(Value::as_u64)
                    && let Some(frames) = self.0.get_mut(session)
                {
                    frames.retain(|_, value| *value != id);
                }
            }
            "Page.frameDetached" => {
                if let Some(frame) = params.get("frameId").and_then(Value::as_str)
                    && let Some(frames) = self.0.get_mut(session)
                {
                    frames.remove(frame);
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(session: &str, method: &str, params: Value) -> CdpEvent {
        CdpEvent {
            session_id: Some(session.into()),
            method: method.into(),
            params: Some(params),
        }
    }

    #[test]
    fn default_contexts_keep_frame_and_session_identity_and_retire_old_documents() {
        let mut contexts = DefaultContexts::default();
        for (session, frame, id, is_default) in [
            ("a", "main", 1, true),
            ("a", "child", 2, true),
            ("a", "main", 3, false),
            ("b", "main", 4, true),
        ] {
            contexts.observe(&event(
                session,
                "Runtime.executionContextCreated",
                json!({"context":{"id":id,"auxData":{"frameId":frame,"isDefault":is_default}}}),
            ));
        }
        assert_eq!(contexts.get("a", "main"), Some(1));
        assert_eq!(contexts.get("a", "child"), Some(2));
        assert_eq!(contexts.get("b", "main"), Some(4));
        contexts.observe(&event(
            "a",
            "Runtime.executionContextDestroyed",
            json!({"executionContextId":1}),
        ));
        assert_eq!(contexts.get("a", "main"), None);
        contexts.observe(&event(
            "a",
            "Runtime.executionContextCreated",
            json!({"context":{"id":5,"auxData":{"frameId":"main","isDefault":true}}}),
        ));
        contexts.observe(&event(
            "a",
            "Runtime.executionContextDestroyed",
            json!({"executionContextId":1}),
        ));
        assert_eq!(contexts.get("a", "main"), Some(5));
        contexts.observe(&event(
            "a",
            "Page.frameDetached",
            json!({"frameId":"child"}),
        ));
        assert_eq!(contexts.get("a", "child"), None);
        contexts.observe(&event("a", "Runtime.executionContextsCleared", json!({})));
        assert_eq!(contexts.get("a", "main"), None);
        assert_eq!(contexts.get("b", "main"), Some(4));
        contexts.forget("b");
        assert_eq!(contexts.get("b", "main"), None);
    }
}
