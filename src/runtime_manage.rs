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
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
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
    client_status: Arc<Mutex<Value>>,
    runtime_skill: Arc<Mutex<Value>>,
    runtime_update: Arc<Mutex<Option<crate::runtime_update::RuntimeUpdateService>>>,
    pub(crate) official_updates: crate::official_update::OfficialUpdates,
    local_registry: Option<Arc<PathBuf>>,
    local_watch: bool,
    settings: Option<crate::runtime_settings::RuntimeSettings>,
    github_jobs: Option<crate::runtime_manage_github::GitHubJobs>,
    plugin_updates: Option<crate::plugin_updates::PluginUpdates>,
    plugin_install: Option<crate::plugin_update_install::PluginUpdateInstall>,
    #[cfg(any(windows, target_os = "macos"))]
    folder_picker: crate::platform::folder_dialog::FolderPicker,
}

impl RuntimeManageService {
    pub(crate) fn runtime_update_service(
        &self,
    ) -> Option<crate::runtime_update::RuntimeUpdateService> {
        self.runtime_update
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub fn new(broker: ControlBroker) -> Self {
        Self {
            broker,
            listing: Arc::new(Mutex::new(Err(RuntimeManageError::new(
                "runtime_not_ready",
                "The runtime has not published a plugin list yet.",
            )))),
            local_registry: None,
            client_status: Arc::new(Mutex::new(serde_json::json!({"status":"unknown"}))),
            runtime_skill: Arc::new(Mutex::new(serde_json::json!({"available":false}))),
            runtime_update: Arc::new(Mutex::new(None)),
            official_updates: Default::default(),
            local_watch: false,
            settings: None,
            github_jobs: None,
            plugin_updates: None,
            plugin_install: None,
            #[cfg(any(windows, target_os = "macos"))]
            folder_picker: Default::default(),
        }
    }

    pub fn with_local_management(mut self, registry: PathBuf, watch: bool) -> Self {
        self.settings = Some(crate::runtime_settings::RuntimeSettings::for_registry(
            &registry,
        ));
        let registry = Arc::new(registry);
        self.github_jobs = Some(crate::runtime_manage_github::GitHubJobs::new(
            registry.clone(),
        ));
        self.plugin_updates = Some(crate::plugin_updates::PluginUpdates::new(registry.clone()));
        self.plugin_install = Some(crate::plugin_update_install::PluginUpdateInstall::new(
            registry.clone(),
            self.broker.clone(),
        ));
        self.local_registry = Some(registry);
        self.local_watch = watch;
        self
    }

    pub(crate) fn preferences_for_start(&self) -> crate::runtime_settings::SettingsDocument {
        self.settings
            .as_ref()
            .and_then(|settings| settings.cached().ok())
            .unwrap_or_else(|| {
                let mut document = crate::runtime_settings::SettingsDocument::default();
                document.values.automatic_update_checks = false;
                document.values.check_plugin_updates_on_startup = false;
                document
            })
    }
    pub(crate) fn start_plugin_update_checks(&self) {
        if let Some(updates) = &self.plugin_updates {
            updates.start(
                self.preferences_for_start()
                    .values
                    .check_plugin_updates_on_startup,
            );
        }
    }
    pub(crate) fn local_watch_enabled(&self) -> bool {
        self.settings
            .as_ref()
            .and_then(|settings| settings.cached().ok())
            .map(|document| {
                document
                    .values
                    .local_source_auto_reload
                    .unwrap_or(self.local_watch)
            })
            .unwrap_or(false)
    }
    fn settings_snapshot(&self, document: crate::runtime_settings::SettingsDocument) -> Value {
        let update = self
            .runtime_update
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        let interval = update
            .as_ref()
            .map_or(900, |service| service.default_check_interval_seconds());
        serde_json::json!({"schema":1,"revision":document.revision,"values":document.values,
            "effective":{"automaticUpdateChecks":document.values.automatic_update_checks,
                "checkPluginUpdatesOnStartup":document.values.check_plugin_updates_on_startup,
                "showPluginTags":document.values.show_plugin_tags,
                "updateCheckIntervalSeconds":document.values.update_check_interval_seconds.unwrap_or(interval),
                "localSourceAutoReload":document.values.local_source_auto_reload.unwrap_or(self.local_watch)},
            "defaults":{"updateCheckIntervalSeconds":interval,"localSourceAutoReload":self.local_watch},
            "availability":{"updateChecks":update.as_ref().is_some_and(|service|service.status().configured),"pluginUpdateChecks":self.plugin_updates.is_some(),"localSourceWatch":self.local_registry.is_some()}})
    }

    pub(crate) fn decorate_list(&self, list: &mut Value) {
        list["runtimeVersion"] = Value::from(env!("CARGO_PKG_VERSION"));
        list["runtimeSkill"] = self
            .runtime_skill
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        list["clientStatus"] = self
            .client_status
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        if self.local_registry.is_some() {
            list["localManagement"] = serde_json::json!({"available":true, "watchEnabled":self.local_watch_enabled(), "folderPicker":cfg!(any(windows,target_os="macos"))});
            list["githubManagement"] = serde_json::json!({"available":true});
        }
        if let Some(path) = &self.local_registry
            && let Ok(registry) = crate::plugins::PluginRegistry::load(path.as_ref())
            && let Some(plugins) = list["plugins"].as_array_mut()
        {
            for plugin in plugins {
                if let Some(current) = plugin["id"]
                    .as_str()
                    .and_then(|id| registry.managed_plugins().get(id))
                    .and_then(|record| record.current())
                {
                    plugin["ownership"] = Value::from("core-managed-github");
                    plugin["managedSource"] =
                        serde_json::to_value(&current.source).expect("source is serializable");
                    plugin["managedVersionKey"] = Value::from(current.version_key.clone());
                    plugin["metadata"] =
                        serde_json::to_value(&current.metadata).expect("metadata is serializable");
                }
            }
        }
    }

    pub(crate) fn publish_client_status(&self, status: Value) {
        *self
            .client_status
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = status;
    }

    pub(crate) fn publish_runtime_skill(&self, skill: Value) {
        *self.runtime_skill.lock().unwrap_or_else(|e| e.into_inner()) = skill;
    }

    pub(crate) fn set_runtime_update(&self, service: crate::runtime_update::RuntimeUpdateService) {
        *self
            .runtime_update
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(service);
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
        if method == "versionStatus" {
            if !params.is_null() {
                return Err(RuntimeManageError::new(
                    "invalid_params",
                    "versionStatus expects null params.",
                ));
            }
            let update = self
                .runtime_update
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .as_ref()
                .map(|service| service.status());
            let client = self
                .client_status
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone();
            return bounded_value(
                serde_json::json!({"runtimeVersion":env!("CARGO_PKG_VERSION"),"runtimeUpdate":update,
                "runtimeUpdateError":update.is_none().then(||serde_json::json!({"code":"runtime_update_unavailable","message":"Runtime updates are unavailable for this launcher."})),
                "officialUpdate":self.official_updates.status(),"clientStatus":client,"pluginUpdates":self.plugin_updates.as_ref().map(|service|service.status()),"pluginInstall":self.plugin_install.as_ref().map(|service|service.status())}),
                MAX_CONTROL_RESPONSE_BYTES,
                "response_too_large",
            );
        }
        if method == "getSettings" || method == "saveSettings" {
            let settings = self.settings.as_ref().ok_or_else(|| {
                RuntimeManageError::new(
                    "settings_unavailable",
                    "Settings are unavailable for this runtime.",
                )
            })?;
            let read = || {
                settings
                    .read()
                    .map_err(|error| RuntimeManageError::new(error.code, error.message))
            };
            let document = if method == "getSettings" {
                if !params.is_null() {
                    return Err(RuntimeManageError::new(
                        "invalid_params",
                        "getSettings expects null params.",
                    ));
                }
                read()?
            } else {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Input {
                    expected_revision: u64,
                    values: crate::runtime_settings::RuntimePreferences,
                }
                if params
                    .get("values")
                    .and_then(Value::as_object)
                    .is_none_or(|values| {
                        values.len() != 5
                            || ![
                                "automaticUpdateChecks",
                                "checkPluginUpdatesOnStartup",
                                "showPluginTags",
                                "updateCheckIntervalSeconds",
                                "localSourceAutoReload",
                            ]
                            .iter()
                            .all(|key| values.contains_key(*key))
                    })
                {
                    return Err(RuntimeManageError::new(
                        "invalid_params",
                        "saveSettings requires all five preference values.",
                    ));
                }
                let input: Input = serde_json::from_value(params).map_err(|error| {
                    RuntimeManageError::new("invalid_params", error.to_string())
                })?;
                input
                    .values
                    .validate()
                    .map_err(|error| RuntimeManageError::new(error.code, error.message))?;
                self.broker.with_settings_write(|| settings.save(input.expected_revision,input.values))
                    .map_err(|_|RuntimeManageError::new("settings_busy","The runtime is starting, stopping, or applying a plugin operation. Try again when it is ready."))?
                    .map_err(|error|RuntimeManageError::new(error.code,error.message))?
            };
            if let Some(update) = self
                .runtime_update
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone()
            {
                update.configure_checks(&document).map_err(|error| {
                    RuntimeManageError::new("settings_apply_failed", error.message)
                })?;
            }
            return Ok(self.settings_snapshot(document));
        }
        if method == "checkPluginUpdates" {
            if !params.is_null() {
                return Err(RuntimeManageError::new(
                    "invalid_params",
                    "checkPluginUpdates expects null params.",
                ));
            }
            let service = self.plugin_updates.as_ref().ok_or_else(|| {
                RuntimeManageError::new(
                    "plugin_updates_unavailable",
                    "Plugin update checks are unavailable for this runtime.",
                )
            })?;
            return bounded_value(
                serde_json::to_value(service.check(true)).expect("plugin update status serializes"),
                MAX_CONTROL_RESPONSE_BYTES,
                "response_too_large",
            );
        }
        if method == "installCombinedUpdate" {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct CombinedInput {
                candidate_id: String,
            }
            let input: CombinedInput = serde_json::from_value(params)
                .map_err(|e| RuntimeManageError::new("invalid_params", e.to_string()))?;
            if input.candidate_id.is_empty() || input.candidate_id.len() > 512 {
                return Err(RuntimeManageError::new(
                    "invalid_params",
                    "Invalid update candidate.",
                ));
            }
            let service = self.runtime_update_service().ok_or_else(|| {
                RuntimeManageError::new(
                    "runtime_update_unavailable",
                    "Runtime updates are unavailable for this launcher.",
                )
            })?;
            let status = self
                .official_updates
                .request_combined(&service, &input.candidate_id)
                .map_err(|e| RuntimeManageError::new("combined_update_unavailable", e))?;
            return Ok(serde_json::to_value(status).expect("official update status serializes"));
        }
        if matches!(
            method,
            "runtimeUpdateStatus"
                | "checkRuntimeUpdate"
                | "downloadRuntimeUpdate"
                | "installRuntimeUpdate"
        ) {
            if !params.is_null() && params.as_object().is_none_or(|object| !object.is_empty()) {
                return Err(RuntimeManageError::new(
                    "invalid_params",
                    "Runtime updates expect empty params.",
                ));
            }
            let service = self
                .runtime_update
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone()
                .ok_or_else(|| {
                    RuntimeManageError::new(
                        "runtime_update_unavailable",
                        "Runtime updates are unavailable for this launcher.",
                    )
                })?;
            if method != "runtimeUpdateStatus" && self.official_updates.busy() {
                return Err(RuntimeManageError::new(
                    "runtime_update_busy",
                    "A combined update is already running.",
                ));
            }
            let status = match method {
                "runtimeUpdateStatus" => Ok(service.status()),
                "checkRuntimeUpdate" => service.check(),
                "downloadRuntimeUpdate" => service.download(),
                _ => service.request_install(),
            }
            .map_err(|error| RuntimeManageError::new("runtime_update_error", error.to_string()))?;
            return bounded_value(
                serde_json::to_value(status).expect("update status serializes"),
                MAX_CONTROL_RESPONSE_BYTES,
                "response_too_large",
            );
        }
        if method == "openRuntimeFolder" {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct FolderInput {
                location: RuntimeFolder,
            }
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            enum RuntimeFolder {
                Installation,
                Logs,
            }
            let input: FolderInput = serde_json::from_value(params)
                .map_err(|error| RuntimeManageError::new("invalid_params", error.to_string()))?;
            let registry = self.local_registry.as_ref().ok_or_else(|| {
                RuntimeManageError::new(
                    "runtime_unavailable",
                    "Runtime directories are unavailable",
                )
            })?;
            let directory = match input.location {
                RuntimeFolder::Installation => std::env::current_exe().and_then(|file| {
                    file.parent()
                        .map(PathBuf::from)
                        .ok_or_else(|| std::io::Error::other("Executable has no parent"))
                }),
                RuntimeFolder::Logs => crate::runtime_log::directory(registry),
            }
            .map_err(|error| RuntimeManageError::new("open_folder_error", error.to_string()))?;
            #[cfg(any(windows, target_os = "macos"))]
            return crate::platform::open_folder::open_runtime_directory(directory)
                .map_err(|error| RuntimeManageError::new("open_folder_error", error.to_string()));
            #[cfg(not(any(windows, target_os = "macos")))]
            {
                let _ = directory;
                return Err(RuntimeManageError::new(
                    "unsupported_platform",
                    "Opening folders is unavailable on this platform",
                ));
            }
        }
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
        if method == "updatePlugins" || method == "pluginUpdateReview" {
            let service = self.plugin_install.as_ref().ok_or_else(|| {
                RuntimeManageError::new("runtime_unavailable", "Plugin updates are unavailable.")
            })?;
            let value = if method == "updatePlugins" {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields, rename_all = "camelCase")]
                struct Input {
                    plugin_ids: Option<Vec<String>>,
                }
                let input: Input = serde_json::from_value(params)
                    .map_err(|e| RuntimeManageError::new("invalid_params", e.to_string()))?;
                serde_json::to_value(service.start(input.plugin_ids)?).expect("batch serializes")
            } else {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields, rename_all = "camelCase")]
                struct Input {
                    batch_id: u64,
                    plugin_id: String,
                }
                let input: Input = serde_json::from_value(params)
                    .map_err(|e| RuntimeManageError::new("invalid_params", e.to_string()))?;
                let mut value = service.preview(input.batch_id, &input.plugin_id)?;
                self.decorate_managed_preview(&mut value)?;
                value
            };
            return bounded_value(value, MAX_CONTROL_RESPONSE_BYTES, "response_too_large");
        }
        if matches!(
            method,
            "githubReleases" | "githubPrepare" | "githubJob" | "cancelGitHubJob"
        ) {
            let jobs = self.github_jobs.as_ref().ok_or_else(|| {
                RuntimeManageError::new(
                    "runtime_unavailable",
                    "GitHub management is unavailable in this runtime.",
                )
            })?;
            let service = self.clone();
            let value = jobs.invoke(method, params, move |preview| {
                service.decorate_managed_preview(preview)
            })?;
            return bounded_value(value, MAX_CONTROL_RESPONSE_BYTES, "response_too_large");
        }
        if matches!(
            method,
            "previewLocal"
                | "permissions"
                | "chooseLocalFolder"
                | "folderSelection"
                | "managedHistory"
                | "previewRollback"
                | "sourceRemovalPreview"
                | "openFolder"
        ) {
            let path = self.local_registry.as_ref().ok_or_else(|| {
                RuntimeManageError::new(
                    "runtime_unavailable",
                    "Local management is unavailable in this runtime.",
                )
            })?;
            #[cfg(any(windows, target_os = "macos"))]
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
            let value = if method == "sourceRemovalPreview" || method == "openFolder" {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields, rename_all = "camelCase")]
                struct SourceInput {
                    plugin_id: String,
                }
                let input: SourceInput = serde_json::from_value(params).map_err(|error| {
                    RuntimeManageError::new("invalid_params", error.to_string())
                })?;
                if method == "sourceRemovalPreview" {
                    serde_json::to_value(
                        crate::source_removal::preview(&registry, &input.plugin_id).map_err(
                            |error| {
                                RuntimeManageError::new("source_removal_error", error.to_string())
                            },
                        )?,
                    )
                    .expect("source preview serializes")
                } else {
                    #[cfg(any(windows, target_os = "macos"))]
                    {
                        crate::platform::open_folder::open_registered_source(
                            &registry,
                            &input.plugin_id,
                        )
                        .map_err(|error| {
                            RuntimeManageError::new("open_folder_error", error.to_string())
                        })?
                    }
                    #[cfg(not(any(windows, target_os = "macos")))]
                    {
                        return Err(RuntimeManageError::new(
                            "unsupported_platform",
                            "Opening a source folder is unavailable on this platform.",
                        ));
                    }
                }
            } else if method == "previewLocal" {
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
                value["watchEnabled"] = Value::Bool(self.local_watch_enabled());
                value["dependencyCheck"] = dependency_check;
                value
            } else if method == "previewRollback" {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields, rename_all = "camelCase")]
                struct RollbackInput {
                    plugin_id: String,
                    version_key: String,
                }
                let input: RollbackInput = serde_json::from_value(params).map_err(|error| {
                    RuntimeManageError::new("invalid_params", error.to_string())
                })?;
                let preview = crate::managed_plugins::preview_rollback(
                    &registry,
                    &input.plugin_id,
                    &input.version_key,
                )
                .map_err(|error| {
                    RuntimeManageError::new("managed_plugin_error", error.to_string())
                })?;
                let mut value =
                    serde_json::to_value(preview).expect("managed preview is serializable");
                self.decorate_managed_preview(&mut value)?;
                value
            } else if method == "permissions" || method == "managedHistory" {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields, rename_all = "camelCase")]
                struct PermissionsInput {
                    plugin_id: String,
                    #[serde(default)]
                    cursor: Option<usize>,
                }
                let input: PermissionsInput = serde_json::from_value(params).map_err(|error| {
                    RuntimeManageError::new("invalid_params", error.to_string())
                })?;
                if method == "managedHistory" {
                    let record = registry
                        .managed_plugins()
                        .get(&input.plugin_id)
                        .ok_or_else(|| {
                            RuntimeManageError::new(
                                "managed_plugin_required",
                                "This plugin has no retained managed versions.",
                            )
                        })?;
                    let start = input.cursor.unwrap_or(0);
                    if start > record.history.len() {
                        return Err(RuntimeManageError::new(
                            "invalid_params",
                            "History cursor is past the retained versions.",
                        ));
                    }
                    let mut value = serde_json::json!({"pluginId":input.plugin_id,"currentVersion":record.current_version,"history":[],"nextCursor":null});
                    for (index, version) in record.history.iter().enumerate().skip(start).take(8) {
                        let mut summary =
                            serde_json::to_value(version).expect("version is serializable");
                        summary
                            .as_object_mut()
                            .expect("version object")
                            .remove("metadata");
                        value["history"]
                            .as_array_mut()
                            .expect("history array")
                            .push(summary);
                        value["nextCursor"] = if index + 1 < record.history.len() {
                            Value::from(index + 1)
                        } else {
                            Value::Null
                        };
                        if serde_json::to_vec(&value).map_or(true, |encoded| {
                            encoded.len() > MAX_CONTROL_RESPONSE_BYTES - 1024
                        }) {
                            value["history"]
                                .as_array_mut()
                                .expect("history array")
                                .pop();
                            if index == start {
                                return Err(RuntimeManageError::new(
                                    "response_too_large",
                                    "This version record exceeds the management response limit.",
                                ));
                            }
                            value["nextCursor"] = Value::from(index);
                            break;
                        }
                    }
                    return bounded_value(value, MAX_CONTROL_RESPONSE_BYTES, "response_too_large");
                }
                if input.cursor.is_some() {
                    return Err(RuntimeManageError::new(
                        "invalid_params",
                        "permissions does not accept a history cursor.",
                    ));
                }
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
                let mut value = serde_json::json!({"schema":1,"kind":"codlet.plugin-permissions","pluginId":input.plugin_id,"registration":registration,"enabled":registry.is_enabled(&input.plugin_id)});
                if let Some(current) = registry
                    .managed_plugins()
                    .get(&input.plugin_id)
                    .and_then(|record| record.current())
                {
                    value["ownership"] = Value::from("core-managed-github");
                    value["managedSource"] =
                        serde_json::to_value(&current.source).expect("source is serializable");
                    value["managedVersionKey"] = Value::from(current.version_key.clone());
                    value["metadata"] =
                        serde_json::to_value(&current.metadata).expect("metadata is serializable");
                }
                value
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
                if let Some(selection) = &request.remove_source {
                    let path = self.local_registry.as_ref().ok_or_else(|| {
                        RuntimeManageError::new(
                            "runtime_unavailable",
                            "Source removal requires a managed registry.",
                        )
                    })?;
                    let registry =
                        crate::plugins::PluginRegistry::load(path.as_ref()).map_err(|error| {
                            RuntimeManageError::new("registry_error", error.to_string())
                        })?;
                    crate::source_removal::prepare(&registry, &request.plugin_id, selection)
                        .map_err(|error| {
                            RuntimeManageError::new("source_removal_error", error.to_string())
                        })?;
                }
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

    fn decorate_managed_preview(&self, value: &mut Value) -> Result<(), RuntimeManageError> {
        let history_count = value
            .as_object_mut()
            .and_then(|object| object.remove("history"))
            .and_then(|history| history.as_array().map(Vec::len));
        if let Some(count) = history_count {
            value["historyCount"] = Value::from(count);
        }
        let manifest: crate::plugins::PluginManifest =
            serde_json::from_value(value["manifest"].clone())
                .map_err(|error| RuntimeManageError::new("invalid_preview", error.to_string()))?;
        value["watchEnabled"] = Value::Bool(false);
        value["dependencyCheck"] = self.dependency_check(&manifest);
        Ok(())
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

    #[test]
    fn large_retained_metadata_does_not_fill_public_previews_or_history_pages() {
        use crate::managed_plugins::ManagedOperation;
        use std::io::Write;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("registry.json");
        let mut registry = crate::plugins::PluginRegistry::load(&path).unwrap();
        let mut last = None;
        for index in 0..10 {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, content) in [
                ("codlet.json", json!({"schema":1,"id":"dev.large-history","version":format!("1.0.{index}"),"renderer":{"entry":"entry.js","world":"isolated"},"permissions":["ui.dom"]}).to_string()),
                ("entry.js", "throw new Error('previews must not execute this');".into()),
                ("codlet-package.json", json!({"schema":1,"adapters":{"fixture":"x".repeat(48_000)}}).to_string()),
            ] {
                zip.start_file(name, options).unwrap();
                zip.write_all(content.as_bytes()).unwrap();
            }
            let package = crate::github_distribution::test_prepare_archive(
                &path,
                &zip.finish().unwrap().into_inner(),
            )
            .unwrap();
            let preview = crate::managed_plugins::preview(
                &registry,
                &package.package_path,
                if index == 0 {
                    ManagedOperation::Install
                } else {
                    ManagedOperation::Update
                },
            )
            .unwrap();
            let request = preview.request(
                vec![crate::plugins::Permission::UiDom],
                Default::default(),
                false,
            );
            let (mut next, _) =
                crate::managed_plugins::stage(&registry, "dev.large-history", &request).unwrap();
            next.save().unwrap();
            registry = next;
            last = Some(package.package_path);
        }
        let service =
            RuntimeManageService::new(ControlBroker::new([6; 16], "large-history".into()))
                .with_local_management(path, false);
        let first = service
            .invoke("managedHistory", json!({"pluginId":"dev.large-history"}))
            .unwrap();
        assert_eq!(first["history"].as_array().unwrap().len(), 8);
        assert_eq!(first["nextCursor"], 8);
        assert!(first["history"][0].get("metadata").is_none());
        let second = service
            .invoke(
                "managedHistory",
                json!({"pluginId":"dev.large-history","cursor":8}),
            )
            .unwrap();
        assert_eq!(second["history"].as_array().unwrap().len(), 2);
        assert!(second["nextCursor"].is_null());
        assert!(
            service
                .invoke(
                    "managedHistory",
                    json!({"pluginId":"dev.large-history","cursor":11})
                )
                .is_err()
        );
        let preview =
            crate::managed_plugins::preview(&registry, &last.unwrap(), ManagedOperation::Update)
                .unwrap();
        let mut value = serde_json::to_value(preview).unwrap();
        assert!(serde_json::to_vec(&value).unwrap().len() > MAX_CONTROL_RESPONSE_BYTES);
        service.decorate_managed_preview(&mut value).unwrap();
        assert_eq!(value["historyCount"], 10);
        assert!(value.get("history").is_none());
        assert!(bounded_value(value, MAX_CONTROL_RESPONSE_BYTES, "response_too_large").is_ok());
    }
}
