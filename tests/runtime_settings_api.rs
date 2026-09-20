use codlet::plugin_control::PluginControlError;
use codlet::runtime_control::{ControlBroker, ControlRequest};
use codlet::runtime_manage::RuntimeManageService;
use serde_json::{Value, json};

fn values(watch: bool) -> Value {
    json!({"checkPluginUpdatesOnStartup":true,"automaticUpdateChecks":false,"showPluginTags":true,"updateCheckIntervalSeconds":3600,"localSourceAutoReload":watch})
}

#[test]
fn runtime_folder_rpc_rejects_arbitrary_paths_before_shell_dispatch() {
    let root = tempfile::tempdir().unwrap();
    let (_, service) = service(&root.path().join("config.json"), false);
    for params in [
        json!({"location":"C:/Windows"}),
        json!({"location":"logs","path":"C:/Windows"}),
        Value::Null,
    ] {
        assert_eq!(
            service
                .invoke("openRuntimeFolder", params)
                .unwrap_err()
                .code,
            "invalid_params"
        );
    }
    assert!(!root.path().join("config.json").exists());
    assert!(!root.path().join("logs").exists());
}
fn service(path: &std::path::Path, watch: bool) -> (ControlBroker, RuntimeManageService) {
    let broker = ControlBroker::new([61; 16], "settings-api-scope".into());
    broker.set_ready();
    let service =
        RuntimeManageService::new(broker.clone()).with_local_management(path.to_owned(), watch);
    (broker, service)
}

#[test]
fn rpc_preferences_are_persistent_isolated_and_preserve_registry_bytes() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("配置.json");
    let original = br#"{"schema":2,"plugins":{"dev.keep":{"enabled":true}},"localPlugins":{}}"#;
    std::fs::write(&path, original).unwrap();
    let (_, first) = service(&path, false);
    let before = first.invoke("getSettings", Value::Null).unwrap();
    assert_eq!(before["revision"], 0);
    assert_eq!(before["effective"]["localSourceAutoReload"], false);
    let saved = first
        .invoke(
            "saveSettings",
            json!({"expectedRevision":0,"values":values(true)}),
        )
        .unwrap();
    assert_eq!(saved["revision"], 1);
    assert_eq!(saved["effective"]["localSourceAutoReload"], true);
    let (_, restarted) = service(&path, false);
    assert_eq!(
        restarted.invoke("getSettings", Value::Null).unwrap()["values"],
        values(true)
    );
    let (_, other) = service(&root.path().join("other.json"), true);
    assert_eq!(
        other.invoke("getSettings", Value::Null).unwrap()["revision"],
        0
    );
    assert_eq!(
        other.invoke("getSettings", Value::Null).unwrap()["effective"]["localSourceAutoReload"],
        true
    );
    assert_eq!(std::fs::read(&path).unwrap(), original);
}

#[test]
fn rpc_rejects_invalid_missing_extra_and_stale_values_without_writes() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("registry.json");
    let (_, api) = service(&path, false);
    for params in [
        json!({"expectedRevision":"0","values":values(true)}),
        json!({"expectedRevision":0,"values":{"checkPluginUpdatesOnStartup":true,"automaticUpdateChecks":false}}),
        json!({"expectedRevision":0,"values":values(true),"registry":"other"}),
        json!({"expectedRevision":0,"values":{"checkPluginUpdatesOnStartup":true,"automaticUpdateChecks":false,"showPluginTags":true,"updateCheckIntervalSeconds":300.5,"localSourceAutoReload":true}}),
        json!({"expectedRevision":0,"values":{"checkPluginUpdatesOnStartup":true,"automaticUpdateChecks":"true","showPluginTags":true,"updateCheckIntervalSeconds":900,"localSourceAutoReload":false}}),
    ] {
        assert!(api.invoke("saveSettings", params).is_err());
    }
    assert_eq!(
        api.invoke("getSettings", Value::Null).unwrap()["revision"],
        0
    );
    api.invoke(
        "saveSettings",
        json!({"expectedRevision":0,"values":values(true)}),
    )
    .unwrap();
    assert_eq!(
        api.invoke(
            "saveSettings",
            json!({"expectedRevision":0,"values":values(false)})
        )
        .unwrap_err()
        .code,
        "settings_conflict"
    );
    assert_eq!(
        api.invoke("getSettings", Value::Null).unwrap()["values"],
        values(true)
    );
}

#[test]
fn settings_writes_respect_pending_operations_and_the_owner_stop_boundary() {
    let root = tempfile::tempdir().unwrap();
    let (broker, api) = service(&root.path().join("registry.json"), false);
    let prepared = broker.handle(ControlRequest::prepare(
        serde_json::from_value(json!({"action":"enable","plugin_id":"dev.test"})).unwrap(),
    ));
    let id = prepared.operation_id().unwrap();
    broker.handle(ControlRequest::submit(id));
    let write = || {
        api.invoke(
            "saveSettings",
            json!({"expectedRevision":0,"values":values(true)}),
        )
    };
    assert_eq!(write().unwrap_err().code, "settings_busy");
    let job = broker.take_next().unwrap();
    broker.complete(
        &job.operation_id,
        Err(PluginControlError::new("fixture", "No executor started.")),
    );
    assert!(write().is_ok());
    broker.stop();
    assert_eq!(
        api.invoke(
            "saveSettings",
            json!({"expectedRevision":1,"values":values(false)})
        )
        .unwrap_err()
        .code,
        "settings_busy"
    );
    assert_eq!(
        api.invoke("getSettings", Value::Null).unwrap()["values"],
        values(true)
    );
}

#[test]
fn version_status_does_not_depend_on_plugin_list_or_a_configured_updater() {
    let root = tempfile::tempdir().unwrap();
    let (_, api) = service(&root.path().join("registry.json"), false);
    api.publish_list_error("unavailable list");
    assert!(api.invoke("list", Value::Null).is_err());
    let version = api.invoke("versionStatus", Value::Null).unwrap();
    assert_eq!(version["clientStatus"]["status"], "unknown");
    assert!(version["runtimeUpdate"].is_null());
    assert_eq!(
        version["runtimeUpdateError"]["code"],
        "runtime_update_unavailable"
    );
    assert!(
        api.invoke("versionStatus", json!({"path":"other"}))
            .is_err()
    );
}

#[test]
fn legacy_preferences_gain_startup_check_default_without_a_write_and_new_choice_persists() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("registry.json");
    let preferences = root.path().join("registry.json.preferences.json");
    let legacy = br#"{"schema":1,"revision":4,"values":{"automaticUpdateChecks":false,"updateCheckIntervalSeconds":3600,"localSourceAutoReload":null}}"#;
    std::fs::write(&preferences, legacy).unwrap();
    let (_, api) = service(&path, false);
    let before = api.invoke("getSettings", Value::Null).unwrap();
    assert_eq!(before["values"]["checkPluginUpdatesOnStartup"], true);
    assert_eq!(before["values"]["showPluginTags"], true);
    assert_eq!(before["availability"]["pluginUpdateChecks"], true);
    assert_eq!(std::fs::read(&preferences).unwrap(), legacy);
    let mut updated = before["values"].clone();
    updated["checkPluginUpdatesOnStartup"] = json!(false);
    api.invoke(
        "saveSettings",
        json!({"expectedRevision":4,"values":updated}),
    )
    .unwrap();
    let (_, restarted) = service(&path, false);
    let saved = restarted.invoke("getSettings", Value::Null).unwrap();
    assert_eq!(saved["revision"], 5);
    assert_eq!(saved["values"], updated);
    assert_eq!(
        restarted
            .invoke("checkPluginUpdates", json!({"url":"https://example.com"}))
            .unwrap_err()
            .code,
        "invalid_params"
    );
}
