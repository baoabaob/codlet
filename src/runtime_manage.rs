//! Public runtime.manage@1 operations backed by the same bounded control broker.
//! Callers are authenticated by their execution owner before reaching this service.
//! This service never loads or executes plugin sources.

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::Value;
use thiserror::Error;

use crate::plugin_control::PluginControlRequest;
use crate::runtime_control::{
    ControlBroker, ControlRequest, MAX_CONTROL_REQUEST_BYTES, MAX_CONTROL_RESPONSE_BYTES,
};

#[derive(Debug, Clone, Error)]
#[error("{code}: {message}")]
pub struct RuntimeManageError {
    pub code: &'static str,
    pub message: String,
}

impl RuntimeManageError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// A clone retains the same host incarnation, registry scope and receipt table.
/// It is safe to inject before Host activation; control readiness remains owned
/// by the foreground coordinator.
#[derive(Clone)]
pub struct RuntimeManageService {
    broker: ControlBroker,
    listing: Arc<Mutex<Result<Value, RuntimeManageError>>>,
}

impl RuntimeManageService {
    pub fn new(broker: ControlBroker) -> Self {
        Self {
            broker,
            listing: Arc::new(Mutex::new(Err(RuntimeManageError::new(
                "runtime_not_ready",
                "The runtime has not published a plugin list yet.",
            )))),
        }
    }

    /// Publish owner facts without reading plugin files. Host callers receive
    /// this sampled list, including its timestamp, rather than invented live state.
    pub fn publish_list(&self, mut listing: Value) {
        let snapshot = if listing.get("plugins").is_some_and(Value::is_array) {
            listing["sampledAtUnixMs"] = Value::from(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
                    .min(u128::from(u64::MAX)) as u64,
            );
            bounded_value(listing, MAX_CONTROL_RESPONSE_BYTES, "response_too_large")
        } else {
            Err(RuntimeManageError::new(
                "invalid_list",
                "The runtime list has no plugin array.",
            ))
        };
        *self
            .listing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = snapshot;
    }

    pub fn publish_list_error(&self, message: impl Into<String>) {
        *self
            .listing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) =
            Err(RuntimeManageError::new("registry_error", message));
    }

    /// Only Core code may call this after validating the calling generation,
    /// permission and capability lease. Params cannot select a caller identity,
    /// executable, registry or source snapshot.
    pub fn invoke(&self, method: &str, params: Value) -> Result<Value, RuntimeManageError> {
        let params = bounded_value(params, MAX_CONTROL_REQUEST_BYTES, "invalid_params")?;
        if method == "list" {
            if !params.is_null() {
                return Err(RuntimeManageError::new(
                    "invalid_params",
                    "list expects null params.",
                ));
            }
            return self
                .listing
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
        }
        let request = match method {
            "prepare" => {
                let request: PluginControlRequest =
                    serde_json::from_value(params).map_err(|error| {
                        RuntimeManageError::new("invalid_params", error.to_string())
                    })?;
                request.validate().map_err(|error| {
                    RuntimeManageError::new("invalid_params", error.to_string())
                })?;
                ControlRequest::prepare(request)
            }
            "submit" | "operation" => {
                let input: Operation = serde_json::from_value(params).map_err(|error| {
                    RuntimeManageError::new("invalid_params", error.to_string())
                })?;
                if method == "submit" {
                    ControlRequest::submit(input.operation_id)
                } else {
                    ControlRequest::result(input.operation_id)
                }
            }
            _ => {
                return Err(RuntimeManageError::new(
                    "method_not_found",
                    "The runtime.manage method is not registered.",
                ));
            }
        };
        let result = serde_json::to_value(self.broker.handle(request))
            .expect("the control report contains only serializable DTO fields");
        bounded_value(result, MAX_CONTROL_RESPONSE_BYTES, "response_too_large")
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Operation {
    operation_id: String,
}

fn bounded_value(
    value: Value,
    limit: usize,
    code: &'static str,
) -> Result<Value, RuntimeManageError> {
    if serde_json::to_vec(&value).map_or(true, |encoded| encoded.len() > limit) {
        Err(RuntimeManageError::new(
            code,
            format!("Runtime management data exceeds {limit} bytes."),
        ))
    } else {
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_control::{PluginControlAction, PluginControlError};
    use crate::runtime_control::ControlStatus;
    use serde_json::json;

    #[test]
    fn public_management_prepares_once_submits_once_and_reads_the_same_completion() {
        let broker = ControlBroker::new([3; 16], "m2-management-fixture".into());
        broker.set_ready();
        let service = RuntimeManageService::new(broker.clone());
        let prepared = service
            .invoke(
                "prepare",
                json!({"action":"reload","plugin_id":"dev.fixture"}),
            )
            .unwrap();
        assert_eq!(prepared["status"], "prepared");
        let id = prepared["operation"]["operation_id"].as_str().unwrap();
        let params = json!({"operationId":id});
        assert_eq!(
            service.invoke("submit", params.clone()).unwrap()["status"],
            "queued"
        );
        assert_eq!(
            service.invoke("submit", params.clone()).unwrap()["status"],
            "queued"
        );
        let job = broker.take_next().expect("one job");
        assert_eq!(job.request.action, PluginControlAction::Reload);
        assert!(broker.take_next().is_none());
        assert_eq!(
            service.invoke("operation", params.clone()).unwrap()["status"],
            "running"
        );
        broker.complete(
            id,
            Err(PluginControlError::new(
                "fixture_failure",
                "source rejected",
            )),
        );
        let first = service.invoke("operation", params.clone()).unwrap();
        assert_eq!(first["status"], "completed");
        assert_eq!(
            first["operation"]["completion"]["error"]["code"],
            "fixture_failure"
        );
        assert_eq!(service.invoke("submit", params.clone()).unwrap(), first);
        assert_eq!(service.invoke("operation", params).unwrap(), first);
        assert!(broker.take_next().is_none());
    }

    #[test]
    fn data_and_identity_fields_cannot_turn_management_into_source_or_registry_execution() {
        let broker = ControlBroker::new([4; 16], "m2-management-fixture".into());
        let service = RuntimeManageService::new(broker.clone());
        for payload in [
            json!({"action":"enable","plugin_id":"dev.fixture","source":"execute me"}),
            json!({"action":"enable","plugin_id":"dev.fixture","registry":"elsewhere"}),
            json!({"action":"enable","plugin_id":"dev.fixture","callerId":"codlet-gui"}),
            json!({"action":"enable","plugin_id":"../bad"}),
        ] {
            assert_eq!(
                service.invoke("prepare", payload).unwrap_err().code,
                "invalid_params"
            );
        }
        assert_eq!(
            service
                .invoke(
                    "submit",
                    json!({"operationId":"invalid","action":"disable"})
                )
                .unwrap_err()
                .code,
            "invalid_params"
        );
        assert_eq!(
            service
                .invoke("submit", json!({"operationId":"invalid"}))
                .unwrap()["status"],
            "invalid_request"
        );
        assert!(broker.take_next().is_none());
        assert_eq!(
            service
                .invoke(
                    "prepare",
                    json!({"action":"enable","plugin_id":"dev.fixture"})
                )
                .unwrap()["status"],
            "not_ready"
        );
        assert_eq!(
            broker.handle(ControlRequest::identify()).status,
            ControlStatus::Identified
        );
    }

    #[test]
    fn list_samples_keep_their_own_time_and_fail_closed_when_oversized() {
        let broker = ControlBroker::new([5; 16], "m2-management-fixture".into());
        let service = RuntimeManageService::new(broker);
        assert_eq!(
            service.invoke("list", Value::Null).unwrap_err().code,
            "runtime_not_ready"
        );
        service.publish_list(json!({"plugins":[{"id":"dev.fixture","active":false}]}));
        let old = service.invoke("list", Value::Null).unwrap();
        assert!(old["sampledAtUnixMs"].as_u64().is_some());
        assert_eq!(service.invoke("list", Value::Null).unwrap(), old);
        service.publish_list(json!({"plugins":[{"id":"dev.fixture","active":true}]}));
        assert_eq!(old["plugins"][0]["active"], false);
        assert_eq!(
            service.invoke("list", Value::Null).unwrap()["plugins"][0]["active"],
            true
        );
        service.publish_list(json!({"plugins":[{"id":"x".repeat(MAX_CONTROL_RESPONSE_BYTES)}]}));
        assert_eq!(
            service.invoke("list", Value::Null).unwrap_err().code,
            "response_too_large"
        );
        assert_eq!(
            service
                .invoke(
                    "operation",
                    json!({"operationId":"x".repeat(MAX_CONTROL_REQUEST_BYTES)})
                )
                .unwrap_err()
                .code,
            "invalid_params"
        );
    }
}
