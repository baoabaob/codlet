//! Public runtime.manage@1 operations backed by the same bounded control broker.
//! Callers are authenticated by their execution owner before reaching this service.
//! Explicit local previews read bounded source text without executing it; all
//! registration and lifecycle mutations remain in the foreground coordinator.

use std::path::PathBuf;
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
    local_registry: Option<Arc<PathBuf>>,
    local_watch: bool,
    #[cfg(windows)]
    folder_picker: crate::windows::folder_dialog::FolderPicker,
}

impl RuntimeManageService {
    pub fn new(broker: ControlBroker) -> Self {
        Self {
            broker,
            listing: Arc::new(Mutex::new(Err(RuntimeManageError::new(
                "runtime_not_ready",
                "The runtime has not published a plugin list yet.",
            )))),
            local_registry: None,
            local_watch: false,
            #[cfg(windows)]
            folder_picker: Default::default(),
        }
    }

    pub fn with_local_management(mut self, registry: PathBuf, watch: bool) -> Self {
        self.local_registry = Some(Arc::new(registry));
        self.local_watch = watch;
        self
    }

    pub(crate) fn decorate_list(&self, list: &mut Value) {
        if self.local_registry.is_some() {
            list["localManagement"] = serde_json::json!({"available":true, "watchEnabled":self.local_watch, "folderPicker":cfg!(windows)});
        }
    }

    /// Publish owner facts without reading plugin files. Host callers receive
    /// this sampled list, including its timestamp, rather than invented live state.
    pub fn publish_list(&self, mut listing: Value) {
        self.decorate_list(&mut listing);
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
        if matches!(
            method,
            "previewLocal" | "permissions" | "chooseLocalFolder" | "folderSelection"
        ) {
            let path = self.local_registry.as_ref().ok_or_else(|| {
                RuntimeManageError::new(
                    "runtime_unavailable",
                    "Local management is unavailable in this runtime.",
                )
            })?;
            #[cfg(windows)]
            if method == "chooseLocalFolder" || method == "folderSelection" {
                return self
                    .folder_picker
                    .invoke(
                        method,
                        params,
                        path.parent().ok_or_else(|| {
                            RuntimeManageError::new(
                                "registry_error",
                                "The registry has no parent directory.",
                            )
                        })?,
                    )
                    .map_err(|message| RuntimeManageError::new("folder_selection_error", message));
            }
            let registry = crate::plugins::PluginRegistry::load(path.as_ref())
                .map_err(|error| RuntimeManageError::new("registry_error", error.to_string()))?;
            let value = if method == "previewLocal" {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct PreviewInput {
                    path: PathBuf,
                }
                let input: PreviewInput = serde_json::from_value(params).map_err(|error| {
                    RuntimeManageError::new("invalid_params", error.to_string())
                })?;
                crate::plugin_permissions::validate_policy_path(&input.path).map_err(|error| {
                    RuntimeManageError::new("invalid_params", error.to_string())
                })?;
                let preview =
                    crate::local_import::preview(&registry, &input.path).map_err(|error| {
                        RuntimeManageError::new("local_import_error", error.to_string())
                    })?;
                let dependency_check = self.dependency_check(&preview.manifest);
                let mut value = serde_json::to_value(preview).expect("preview is serializable");
                value["watchEnabled"] = Value::Bool(self.local_watch);
                value["dependencyCheck"] = dependency_check;
                value
            } else if method == "permissions" {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields, rename_all = "camelCase")]
                struct PermissionsInput {
                    plugin_id: String,
                }
                let input: PermissionsInput = serde_json::from_value(params).map_err(|error| {
                    RuntimeManageError::new("invalid_params", error.to_string())
                })?;
                let registration =
                    registry
                        .local_plugins()
                        .get(&input.plugin_id)
                        .ok_or_else(|| {
                            RuntimeManageError::new(
                                "plugin_not_found",
                                "This plugin has no local registration.",
                            )
                        })?;
                serde_json::json!({"schema":1,"kind":"codlet.plugin-permissions","pluginId":input.plugin_id,"registration":registration,"enabled":registry.is_enabled(&input.plugin_id)})
            } else {
                return Err(RuntimeManageError::new(
                    "unsupported_platform",
                    "Folder selection is unavailable on this platform.",
                ));
            };
            return bounded_value(value, MAX_CONTROL_RESPONSE_BYTES, "response_too_large");
        }
        let request = match method {
            "prepare" => {
                let mut request: PluginControlRequest =
                    serde_json::from_value(params).map_err(|error| {
                        RuntimeManageError::new("invalid_params", error.to_string())
                    })?;
                if let Some(selection) = &mut request.local_import {
                    selection.broker_policy =
                        crate::plugin_permissions::BrokerPolicy::from_explicit_inputs(
                            &selection.broker_policy.read_roots,
                            &selection.broker_policy.network_origins,
                            &selection.broker_policy.executables,
                        )
                        .map_err(|error| {
                            RuntimeManageError::new("invalid_params", error.to_string())
                        })?;
                }
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

    fn dependency_check(&self, manifest: &crate::plugins::PluginManifest) -> Value {
        let snapshot = self
            .listing
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
            .ok();
        let mut available = crate::renderer::builtin_host_capabilities()
            .iter()
            .map(|capability| serde_json::to_value(capability).expect("descriptor is serializable"))
            .collect::<Vec<_>>();
        if let Some(plugins) = snapshot
            .as_ref()
            .and_then(|snapshot| snapshot["plugins"].as_array())
        {
            available.extend(
                plugins
                    .iter()
                    .filter(|plugin| plugin["active"] == true)
                    .flat_map(|plugin| {
                        plugin["providedCapabilities"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .cloned()
                    }),
            );
        }
        let provided = manifest
            .all_provides()
            .map(|capability| serde_json::to_value(capability).expect("descriptor is serializable"))
            .collect::<Vec<_>>();
        let requirements = [
            ("renderer", manifest.renderer_requires()),
            ("host", manifest.host_requires()),
        ]
        .into_iter()
        .flat_map(|(entry, capabilities)| {
            capabilities
                .iter()
                .map(move |capability| (entry, capability))
        })
        .map(|(entry, capability)| {
            let descriptor = serde_json::to_value(capability).expect("descriptor is serializable");
            let status = if provided.contains(&descriptor) {
                "declared_by_import"
            } else if available.contains(&descriptor) {
                "available"
            } else if snapshot.is_some() {
                "unavailable"
            } else {
                "unknown"
            };
            serde_json::json!({"entry":entry,"capability":descriptor,"status":status})
        })
        .collect::<Vec<_>>();
        serde_json::json!({"basis":"runtime_list", "sampledAtUnixMs":snapshot.as_ref().and_then(|value| value["sampledAtUnixMs"].as_u64()), "requirements":requirements})
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

    #[test]
    fn local_preview_reports_sampled_dependencies_and_import_uses_one_bound_receipt() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("plugin");
        std::fs::create_dir(&root).unwrap();
        let capability = json!({"name":"dev.preview.provider","api":1,"scope":"target"});
        std::fs::write(root.join("codlet.json"), json!({"schema":1,"id":"dev.preview","version":"1","renderer":{"entry":"entry.js","world":"isolated"},"permissions":["ui.dom"],"requires":[capability]}).to_string()).unwrap();
        std::fs::write(
            root.join("entry.js"),
            "module.exports={activate(){throw Error('must not run during preview')}};",
        )
        .unwrap();
        let registry_path = directory.path().join("registry.json");
        let broker = ControlBroker::new([9; 16], "local-preview-scope".into());
        broker.set_ready();
        let service = RuntimeManageService::new(broker.clone())
            .with_local_management(registry_path.clone(), true);
        service.publish_list(json!({"plugins":[]}));
        let first = service
            .invoke("previewLocal", json!({"path":root}))
            .unwrap();
        assert_eq!(first["watchEnabled"], true);
        assert_eq!(
            first["dependencyCheck"]["requirements"][0]["status"],
            "unavailable"
        );
        service.publish_list(json!({"plugins":[{"id":"dev.provider","active":true,"providedCapabilities":[capability]}]}));
        assert_eq!(
            service
                .invoke("previewLocal", json!({"path":root}))
                .unwrap()["dependencyCheck"]["requirements"][0]["status"],
            "available"
        );
        assert!(!registry_path.exists());
        let request = json!({"action":"import","plugin_id":"dev.preview","local_import":{"path":first["path"],"contentDigest":first["contentDigest"],"registrationDigest":first["registrationDigest"],"trusted":true,"grants":["ui.dom"],"enable":false}});
        let prepared = service.invoke("prepare", request).unwrap();
        let id = prepared["operation"]["operation_id"].as_str().unwrap();
        for _ in 0..2 {
            assert_eq!(
                service.invoke("submit", json!({"operationId":id})).unwrap()["status"],
                "queued"
            );
        }
        let job = broker.take_next().unwrap();
        assert_eq!(job.request.action, PluginControlAction::Import);
        assert_eq!(
            job.request.local_import.unwrap().content_digest,
            first["contentDigest"].as_str().unwrap()
        );
        assert!(broker.take_next().is_none());
        assert!(!registry_path.exists());
        assert_eq!(
            service
                .invoke("previewLocal", json!({"path":root,"execute":true}))
                .unwrap_err()
                .code,
            "invalid_params"
        );
    }

    #[test]
    fn public_permission_details_are_fresh_and_cannot_select_another_registry() {
        let directory = tempfile::tempdir().unwrap();
        let mut registry =
            crate::plugins::PluginRegistry::load(directory.path().join("registry.json")).unwrap();
        let root = std::fs::canonicalize(directory.path()).unwrap();
        registry
            .register_local(
                "dev.permissions",
                crate::plugins::LocalPluginRegistration {
                    path: root,
                    grants: vec![crate::plugins::Permission::UiDom],
                    broker_policy: Default::default(),
                },
            )
            .unwrap();
        registry.save().unwrap();
        let service =
            RuntimeManageService::new(ControlBroker::new([8; 16], "permissions-scope".into()))
                .with_local_management(registry.path().to_owned(), false);
        let first = service
            .invoke("permissions", json!({"pluginId":"dev.permissions"}))
            .unwrap();
        assert_eq!(first["registration"]["grants"], json!(["ui.dom"]));
        registry
            .revoke_permission("dev.permissions", crate::plugins::Permission::UiDom)
            .unwrap();
        registry.save().unwrap();
        assert_eq!(
            service
                .invoke("permissions", json!({"pluginId":"dev.permissions"}))
                .unwrap()["registration"]["grants"],
            json!([])
        );
        assert_eq!(
            service
                .invoke(
                    "permissions",
                    json!({"pluginId":"dev.permissions","registry":"other"})
                )
                .unwrap_err()
                .code,
            "invalid_params"
        );
    }
}
