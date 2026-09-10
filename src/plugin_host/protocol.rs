use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_HOST_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_HOST_PENDING_REQUESTS: usize = 16;
pub(crate) const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub(crate) const MAX_HOST_METHOD_BYTES: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HostIdentity {
    pub plugin_id: String,
    pub generation: u64,
}

impl HostIdentity {
    pub fn validate(&self) -> Result<(), String> {
        if !crate::plugins::valid_plugin_id(&self.plugin_id) {
            return Err("invalid host-plugin id".into());
        }
        if !(1..=MAX_SAFE_INTEGER).contains(&self.generation) {
            return Err("host-plugin generation must be a positive JavaScript safe integer".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostRpcError {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl HostRpcError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            data: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum WireMessage {
    Request {
        v: u32,
        #[serde(rename = "pluginId")]
        plugin_id: String,
        generation: u64,
        id: u64,
        method: String,
        params: Value,
        #[serde(default, rename = "timeoutMs", skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u64>,
    },
    Response {
        v: u32,
        #[serde(rename = "pluginId")]
        plugin_id: String,
        generation: u64,
        id: u64,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<HostRpcError>,
    },
    Notification {
        v: u32,
        #[serde(rename = "pluginId")]
        plugin_id: String,
        generation: u64,
        method: String,
        params: Value,
    },
}

impl WireMessage {
    pub(crate) fn request(identity: &HostIdentity, id: u64, method: String, params: Value) -> Self {
        Self::Request {
            v: 1,
            plugin_id: identity.plugin_id.clone(),
            generation: identity.generation,
            id,
            method,
            params,
            timeout_ms: None,
        }
    }

    pub(crate) fn response(
        identity: &HostIdentity,
        id: u64,
        outcome: Result<Value, HostRpcError>,
    ) -> Self {
        let (ok, result, error) = match outcome {
            Ok(value) => (true, Some(value), None),
            Err(error) => (false, None, Some(error)),
        };
        Self::Response {
            v: 1,
            plugin_id: identity.plugin_id.clone(),
            generation: identity.generation,
            id,
            ok,
            result,
            error,
        }
    }

    pub(crate) fn notification(identity: &HostIdentity, method: String, params: Value) -> Self {
        Self::Notification {
            v: 1,
            plugin_id: identity.plugin_id.clone(),
            generation: identity.generation,
            method,
            params,
        }
    }
}

pub(crate) fn validate_method(method: &str) -> Result<(), String> {
    if method.is_empty()
        || method.len() > MAX_HOST_METHOD_BYTES
        || method.chars().any(char::is_control)
    {
        return Err(format!(
            "method must contain 1..={MAX_HOST_METHOD_BYTES} bytes and no control characters"
        ));
    }
    Ok(())
}

pub(crate) fn decode_frame(bytes: &[u8], identity: &HostIdentity) -> Result<WireMessage, String> {
    if bytes.is_empty() || bytes.len() > MAX_HOST_FRAME_BYTES {
        return Err("host frame is empty or exceeds its byte limit".into());
    }
    // Decode into the strict DTO first so duplicate keys are never normalized
    // away by Value. The small Value pass checks required response key presence.
    let message: WireMessage = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    let (version, plugin_id, generation, id, method) = match &message {
        WireMessage::Request {
            v,
            plugin_id,
            generation,
            id,
            method,
            ..
        } => (*v, plugin_id, *generation, Some(*id), Some(method)),
        WireMessage::Response {
            v,
            plugin_id,
            generation,
            id,
            ..
        } => (*v, plugin_id, *generation, Some(*id), None),
        WireMessage::Notification {
            v,
            plugin_id,
            generation,
            method,
            ..
        } => (*v, plugin_id, *generation, None, Some(method)),
    };
    if version != 1 {
        return Err(format!("unsupported host protocol version {version}"));
    }
    if plugin_id != &identity.plugin_id || generation != identity.generation {
        return Err("host frame does not match this plugin generation".into());
    }
    if id.is_some_and(|id| !(1..=MAX_SAFE_INTEGER).contains(&id)) {
        return Err("request id must be a positive JavaScript safe integer".into());
    }
    if let Some(method) = method {
        validate_method(method)?;
    }
    if let WireMessage::Request {
        timeout_ms: Some(timeout_ms),
        ..
    } = &message
        && !(1..=15_000).contains(timeout_ms)
    {
        return Err("request timeoutMs must be between 1 and 15000".into());
    }
    if let WireMessage::Response { ok, error, .. } = &message {
        let value: Value = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
        let valid = if *ok {
            value.get("result").is_some() && value.get("error").is_none()
        } else {
            value.get("result").is_none()
                && error
                    .as_ref()
                    .is_some_and(|error| !error.code.is_empty() && !error.message.is_empty())
        };
        if !valid {
            return Err(
                "response requires exactly result for ok=true or a nonempty error for ok=false"
                    .into(),
            );
        }
    }
    Ok(message)
}

pub(crate) fn encode_frame(message: &WireMessage) -> Result<Vec<u8>, String> {
    struct Limited(Vec<u8>);
    impl std::io::Write for Limited {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if self.0.len().saturating_add(bytes.len()) > MAX_HOST_FRAME_BYTES {
                return Err(std::io::Error::other("host frame exceeds byte limit"));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut output = Limited(Vec::new());
    serde_json::to_writer(&mut output, message).map_err(|error| error.to_string())?;
    output.0.push(b'\n');
    Ok(output.0)
}

#[derive(Default)]
pub(crate) struct LineDecoder {
    pending: Vec<u8>,
}

impl LineDecoder {
    pub(crate) fn push(&mut self, bytes: &[u8]) -> Result<Vec<Vec<u8>>, String> {
        let mut frames = Vec::new();
        for &byte in bytes {
            if byte == b'\n' {
                if self.pending.last() == Some(&b'\r') {
                    self.pending.pop();
                }
                if self.pending.is_empty() {
                    return Err("host stdout contains an empty protocol line".into());
                }
                frames.push(std::mem::take(&mut self.pending));
            } else {
                if self.pending.len() >= MAX_HOST_FRAME_BYTES {
                    return Err("host stdout frame exceeds its byte limit".into());
                }
                self.pending.push(byte);
            }
        }
        Ok(frames)
    }
    pub(crate) fn has_partial_frame(&self) -> bool {
        !self.pending.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn jsonl_fragments_preserve_identity_and_strict_request_response_shapes() {
        let identity = HostIdentity {
            plugin_id: "dev.host".into(),
            generation: 2,
        };
        let request = WireMessage::request(
            &identity,
            1,
            "cdp.request".into(),
            json!({"method":"Runtime.evaluate"}),
        );
        let response = WireMessage::response(&identity, 1, Ok(Value::Null));
        let mut decoder = LineDecoder::default();
        let encoded = encode_frame(&request).unwrap();
        assert!(decoder.push(&encoded[..13]).unwrap().is_empty());
        assert!(decoder.has_partial_frame());
        let mut rest = encoded[13..].to_vec();
        rest.extend(encode_frame(&response).unwrap());
        let frames = decoder.push(&rest).unwrap();
        assert_eq!(frames.len(), 2);
        assert_eq!(decode_frame(&frames[0], &identity).unwrap(), request);
        assert!(matches!(
            decode_frame(&frames[1], &identity).unwrap(),
            WireMessage::Response { ok: true, .. }
        ));
        assert!(!decoder.has_partial_frame());
        for bytes in [
            br#"{"v":1,"type":"request","pluginId":"dev.host","generation":1,"id":1,"method":"x","params":null}"#.as_slice(),
            br#"{"v":1,"type":"request","pluginId":"dev.host","generation":2,"id":0,"method":"x","params":null}"#,
            br#"{"v":1,"type":"request","pluginId":"dev.host","generation":2,"id":1,"method":"x","params":null,"extra":1}"#,
            br#"{"v":1,"type":"request","pluginId":"dev.host","generation":2,"id":1,"id":2,"method":"x","params":null}"#,
            br#"{"v":1,"type":"response","pluginId":"dev.host","generation":2,"id":1,"ok":true}"#,
            br#"{"v":1,"type":"response","pluginId":"dev.host","generation":2,"id":1,"ok":false,"result":null,"error":{"code":"x","message":"bad"}}"#,
        ] { assert!(decode_frame(bytes, &identity).is_err()); }
        assert!(LineDecoder::default().push(b"\n").is_err());
        assert!(
            LineDecoder::default()
                .push(&vec![b'x'; MAX_HOST_FRAME_BYTES + 1])
                .is_err()
        );
    }

    #[test]
    fn request_budget_is_bounded_and_legacy_requests_keep_their_wire_shape() {
        let identity = HostIdentity {
            plugin_id: "dev.host".into(),
            generation: 1,
        };
        let legacy = WireMessage::request(&identity, 1, "host.system.info".into(), json!({}));
        assert!(
            serde_json::to_value(&legacy)
                .unwrap()
                .get("timeoutMs")
                .is_none()
        );
        for milliseconds in [1, 40, 15_000] {
            let mut value = serde_json::to_value(&legacy).unwrap();
            value["timeoutMs"] = json!(milliseconds);
            assert!(
                matches!(decode_frame(&serde_json::to_vec(&value).unwrap(), &identity).unwrap(), WireMessage::Request { timeout_ms: Some(found), .. } if found == milliseconds)
            );
        }
        for invalid in [json!(0), json!(15_001), json!(-1), json!(1.5), json!("40")] {
            let mut value = serde_json::to_value(&legacy).unwrap();
            value["timeoutMs"] = invalid;
            assert!(decode_frame(&serde_json::to_vec(&value).unwrap(), &identity).is_err());
        }
    }
}
