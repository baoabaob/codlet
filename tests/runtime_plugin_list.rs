#![cfg(windows)]

use std::ffi::OsString;
use std::path::PathBuf;
use std::time::Duration;

use codlet::catalog::PluginCatalog;
use codlet::cdp::{CdpClient, TargetController};
use codlet::plugin_control::{PluginControlAction, PluginControlRequest};
use codlet::plugins::{LocalPluginRegistration, Permission, PluginRegistry, bundled_plugins};
use codlet::renderer::RendererRuntime;
use codlet::windows::process::launch_with_cdp_pipes;
use serde_json::{Value, json};
use tempfile::tempdir;

const DEADLINE: Duration = Duration::from_secs(5);

fn query_list(client: &CdpClient, runtime: &mut RendererRuntime) -> Value {
    client
        .request(
            "Fake.emitManagementList",
            Some(json!({"pluginId":"dev.list.manager","targetId":"main"})),
            None,
            DEADLINE,
        )
        .unwrap();
    assert_eq!(runtime.pump_bindings_with_timeout(DEADLINE).unwrap(), 1);
    client
        .request("Fake.managementResponse", None, None, DEADLINE)
        .unwrap()
        .result
        .unwrap()
}

fn find_row<'a>(response: &'a Value, id: &str) -> &'a Value {
    response["result"]["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .find(|plugin| plugin["id"] == id)
        .expect("requested plugin should be listed")
}

#[test]
fn renderer_list_refresh_observes_removals_and_additions_but_preserves_unregistered_running_instances()
 {
    let directory = tempdir().unwrap();
    let registry_path = directory.path().join("config.json");
    let mut registry = PluginRegistry::load(&registry_path).unwrap();
    for bundled in bundled_plugins().unwrap() {
        registry.set_enabled(&bundled.manifest.id, false).unwrap();
    }
    for id in ["dev.list.manager", "dev.list.removed", "dev.list.running"] {
        let root = directory.path().join(id);
        std::fs::create_dir(&root).unwrap();
        let grants = if id == "dev.list.manager" {
            vec![Permission::RuntimeManage]
        } else {
            vec![]
        };
        let mut manifest = json!({"schema":1,"id":id,"version":"1","renderer":{"entry":"renderer.js","world":"isolated"},"permissions":grants});
        if id == "dev.list.manager" {
            manifest["requires"] =
                json!([{"name":"codlet.runtime.manage","api":1,"scope":"target"}]);
        }
        std::fs::write(root.join("plugin.json"), manifest.to_string()).unwrap();
        std::fs::write(
            root.join("renderer.js"),
            "module.exports = { activate() {}, deactivate() {} };",
        )
        .unwrap();
        registry
            .register_local(id, LocalPluginRegistration { path: root, grants })
            .unwrap();
    }
    registry.save().unwrap();
    let catalog = PluginCatalog::load(&registry).unwrap();
    let mut runtime = RendererRuntime::from_catalog(catalog, registry).unwrap();
    let executable = PathBuf::from(env!("CARGO_BIN_EXE_codlet-fake-child"));
    let (child, pipes) = launch_with_cdp_pipes(
        &executable,
        &[OsString::from("--scenario=renderer-control")],
        true,
    )
    .unwrap();
    let (client, events) = CdpClient::spawn(pipes).unwrap();
    let (_targets, sessions) =
        TargetController::discover(client.clone(), events, DEADLINE).unwrap();
    for session in &sessions {
        assert_eq!(runtime.attach(session).unwrap().plugin_count, 3);
    }
    let initial = query_list(&client, &mut runtime);
    assert_eq!(initial["ok"], true);
    assert_eq!(find_row(&initial, "dev.list.running")["registered"], true);

    runtime
        .manage_plugin(PluginControlRequest {
            action: PluginControlAction::Disable,
            plugin_id: "dev.list.removed".into(),
        })
        .unwrap();
    let mut external = PluginRegistry::load(&registry_path).unwrap();
    external.remove_local("dev.list.removed").unwrap();
    external.remove_local("dev.list.running").unwrap();
    external.set_enabled("dev.list.manager", false).unwrap();
    let unread_directory = directory.path().join("new-unread-source");
    external
        .register_local(
            "dev.list.new",
            LocalPluginRegistration {
                path: unread_directory.clone(),
                grants: vec![],
            },
        )
        .unwrap();
    external.save().unwrap();
    let registry_bytes = std::fs::read(&registry_path).unwrap();
    // A list refresh must consume only registrations and already loaded metadata.
    for id in ["dev.list.manager", "dev.list.removed", "dev.list.running"] {
        std::fs::write(
            directory.path().join(id).join("plugin.json"),
            "invalid disk manifest after launch",
        )
        .unwrap();
        std::fs::write(
            directory.path().join(id).join("renderer.js"),
            "throw new Error('new source must not be evaluated by list');",
        )
        .unwrap();
    }
    let refreshed = query_list(&client, &mut runtime);
    assert_eq!(refreshed["ok"], true);
    assert!(
        refreshed["result"]["plugins"]
            .as_array()
            .unwrap()
            .iter()
            .all(|plugin| plugin["id"] != "dev.list.removed")
    );
    let running = find_row(&refreshed, "dev.list.running");
    assert_eq!(running["registered"], false);
    assert_eq!(running["loaded"], true);
    assert_eq!(running["active"], true);
    assert_eq!(running["version"], "1");
    assert_eq!(running["generation"], 1);
    assert!(running["path"].is_null());
    assert_eq!(
        running["loadedPath"],
        json!(directory.path().join("dev.list.running").to_string_lossy())
    );
    assert_eq!(running["metadataSource"], "runtime");
    assert_eq!(find_row(&refreshed, "dev.list.manager")["enabled"], false);
    assert_eq!(find_row(&refreshed, "dev.list.manager")["active"], true);
    let new = find_row(&refreshed, "dev.list.new");
    assert_eq!(new["registered"], true);
    assert_eq!(new["loaded"], false);
    assert_eq!(new["active"], false);
    assert!(new["generation"].is_null() && new["version"].is_null());
    assert_eq!(new["validation"]["status"], "not_loaded");
    assert!(!unread_directory.exists());
    assert_eq!(std::fs::read(&registry_path).unwrap(), registry_bytes);

    // Removing trust does not erase the stop route for that already loaded ID.
    let stopped = runtime
        .manage_plugin(PluginControlRequest {
            action: PluginControlAction::Disable,
            plugin_id: "dev.list.running".into(),
        })
        .unwrap();
    assert!(stopped.is_success());
    let refreshed = query_list(&client, &mut runtime);
    assert!(
        refreshed["result"]["plugins"]
            .as_array()
            .unwrap()
            .iter()
            .all(|plugin| plugin["id"] != "dev.list.running")
    );
    let saved_registry = std::fs::read(&registry_path).unwrap();
    std::fs::write(&registry_path, "invalid registry").unwrap();
    let failed = query_list(&client, &mut runtime);
    assert_eq!(failed["ok"], false);
    assert_eq!(failed["error"]["code"], "registry_error");
    assert!(failed.get("result").is_none());
    std::fs::write(&registry_path, saved_registry).unwrap();
    assert_eq!(query_list(&client, &mut runtime)["ok"], true);
    client
        .request("Fake.hostStillAlive", None, None, DEADLINE)
        .unwrap();
    for session in &sessions {
        runtime.deactivate_target(session.target_id()).unwrap();
    }
    client.request("Fake.finish", None, None, DEADLINE).unwrap();
    assert_eq!(child.wait(DEADLINE).unwrap(), Some(0));
}
