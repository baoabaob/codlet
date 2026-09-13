//! Actual renderer JS in the shared page world, alongside isolated consumers.
use super::host_renderer_vm_tests::VmPeer;
use super::*;
use crate::catalog::PluginCatalog;
use crate::cdp::TargetController;
use crate::plugin_control::{PluginControlAction, PluginControlOutcome, PluginControlRequest};
use crate::plugins::{LocalPluginRegistration, Permission, PluginRegistry, bundled_plugins};
use crate::renderer::RendererRuntime;
use serde_json::json;
use tempfile::tempdir;

#[test]
fn main_world_rpc_navigation_reload_and_cleanup_preserve_world_identity() {
    let directory = tempdir().unwrap();
    let mut registry = PluginRegistry::load(directory.path().join("config.json")).unwrap();
    for plugin in bundled_plugins().unwrap() {
        registry.set_enabled(&plugin.manifest.id, false).unwrap();
    }
    let provided = json!({"name":"example.main","api":1,"scope":"target"});
    let ping = json!({"name":"codlet.runtime.ping","api":1,"scope":"target"});
    let sources = [
        (
            "main",
            "main",
            json!([provided]),
            json!([ping]),
            r#"
            let ctx;
            module.exports = {
                async activate(value) {
                    ctx = value;
                    ctx.reportDiagnostic({code:'example_ready',message:'main world sample ready',level:'info'});
                    globalThis.__m3Main = { world: ctx.world, generation: ctx.generation };
                    ctx.rpc.provide({name:'example.main',api:1,scope:'target'}, 'echo', p => ({echo:p,world:ctx.world,generation:ctx.generation}));
                    await ctx.rpc.request('ping', null);
                },
                deactivate() { globalThis.__m3Retired = ctx.rpc; delete globalThis.__m3Main; }
            };
        "#,
        ),
        (
            "peer",
            "main",
            json!([]),
            json!([]),
            r#"
            module.exports = { activate(ctx) { globalThis.__m3Peer = ctx.world; }, deactivate() { delete globalThis.__m3Peer; } };
        "#,
        ),
        (
            "consumer",
            "isolated",
            json!([]),
            json!([provided]),
            r#"
            module.exports = {
                async activate(ctx) { globalThis.__m3Isolated = { world:ctx.world, result:await ctx.rpc.request('echo', 'roundtrip') }; },
                deactivate() { delete globalThis.__m3Isolated; }
            };
        "#,
        ),
    ];
    for (name, world, provides, requires, source) in sources {
        let path = directory.path().join(name);
        std::fs::create_dir(&path).unwrap();
        let id = format!("example.{name}");
        let grants = if world == "main" {
            vec![Permission::UiMainWorld]
        } else {
            vec![]
        };
        std::fs::write(path.join("codlet.json"), json!({"schema":1,"id":id,"version":"1","renderer":{"entry":"renderer.js","world":world},"permissions":grants,"provides":provides,"requires":requires}).to_string()).unwrap();
        std::fs::write(path.join("renderer.js"), source).unwrap();
        registry
            .register_local(
                &id,
                LocalPluginRegistration {
                    path,
                    grants,
                    broker_policy: Default::default(),
                },
            )
            .unwrap();
        registry.set_enabled(&id, true).unwrap();
    }
    registry.save().unwrap();
    let mut renderer =
        RendererRuntime::from_catalog(PluginCatalog::load(&registry).unwrap(), registry).unwrap();
    let (mut peer, events) = VmPeer::start();
    let (mut controller, sessions) =
        TargetController::discover(peer.client.clone(), events, Duration::from_secs(5)).unwrap();
    let reports = renderer.attach_all(&sessions);
    assert!(
        reports.iter().all(|(_, result)| result.is_ok()),
        "{reports:?}"
    );
    let inspect = |peer: &VmPeer| {
        peer.request(
            "Fixture.inspect",
            json!({"keys":["__m3Main","__m3Peer","__m3Isolated"]}),
        )
    };
    let assert_worlds = |snapshot: &Value, count: usize| {
        let contexts = snapshot["contexts"].as_array().unwrap();
        let main: Vec<_> = contexts.iter().filter(|c| c["name"] == "").collect();
        assert_eq!(main.len(), count);
        for context in main {
            assert_eq!(context["globals"]["__m3Main"]["world"], "main");
            assert_eq!(context["globals"]["__m3Peer"], "main");
            assert_eq!(context["plugins"].as_array().unwrap().len(), 2);
            assert!(
                context["bindings"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|binding| binding.as_str().unwrap().contains("_main"))
            );
            assert!(context["globals"].get("__m3Isolated").is_none());
        }
        let consumers: Vec<_> = contexts
            .iter()
            .filter(|c| c["globals"].get("__m3Isolated").is_some())
            .collect();
        assert_eq!(consumers.len(), count);
        for context in consumers {
            assert_eq!(context["globals"]["__m3Isolated"]["world"], "isolated");
            assert_eq!(
                context["globals"]["__m3Isolated"]["result"]["world"],
                "main"
            );
            assert!(
                context["bindings"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|binding| !binding.as_str().unwrap().contains("_main"))
            );
        }
    };
    assert_worlds(&inspect(&peer), 2);
    let snapshot = renderer.status_snapshot();
    assert_eq!(
        snapshot
            .recent_events
            .iter()
            .filter(|event| event.code == "plugin_reported_info"
                && event
                    .message
                    .contains("example.main generation 1 reported example_ready"))
            .count(),
        2
    );
    for session in &sessions {
        session.evaluate("(() => { for (const name of Object.keys(globalThis).filter(name => name.startsWith('codlet_rpc_v1_'))) { if (typeof globalThis[name] === 'function') globalThis[name](JSON.stringify({v:1,type:'diagnostic',pluginId:'intruder',generation:1,code:'spoofed',message:'must not route',level:'error'})); } return true; })()").unwrap();
    }
    renderer.pump_bindings().unwrap();
    assert!(
        renderer
            .status_snapshot()
            .recent_events
            .iter()
            .all(|event| !event.message.contains("must not route"))
    );
    peer.request("Fixture.navigate", json!({"targetId":"window-a"}));
    for change in controller.pump(Duration::ZERO).unwrap() {
        renderer.apply_target_change(change).unwrap();
    }
    renderer.pump_bindings().unwrap();
    assert_worlds(&inspect(&peer), 2);
    let report = renderer
        .manage_plugin(PluginControlRequest {
            action: PluginControlAction::Reload,
            plugin_id: "example.main".into(),
            permission: None,
            cascade: false,
            remove_source: None,
            local_import: None,
        })
        .unwrap();
    assert_eq!(report.outcome, PluginControlOutcome::Applied);
    assert_worlds(&inspect(&peer), 2);
    let session = sessions
        .iter()
        .find(|s| s.target_id() == "window-a")
        .unwrap();
    assert_eq!(
        session
            .evaluate("__m3Retired.request('ping').then(() => 'unexpected', error => error.code)")
            .unwrap()
            .pointer("/result/value"),
        Some(&json!("plugin_deactivated"))
    );
    peer.request("Fixture.destroyTarget", json!({"targetId":"window-b"}));
    for change in controller.pump(Duration::ZERO).unwrap() {
        renderer.apply_target_change(change).unwrap();
    }
    renderer.pump_bindings().unwrap();
    assert_worlds(&inspect(&peer), 1);
    renderer.deactivate_target("window-a").unwrap();
    let snapshot = inspect(&peer);
    for session in snapshot["sessions"].as_array().unwrap() {
        assert_eq!(session["scripts"], 0);
        assert_eq!(session["bindings"], 0);
    }
    for context in snapshot["contexts"].as_array().unwrap() {
        assert_eq!(context["plugins"].as_array().unwrap().len(), 0);
    }
    assert_eq!(
        session
            .evaluate("typeof globalThis.__codletRendererV1")
            .unwrap()
            .pointer("/result/value"),
        Some(&json!("undefined"))
    );
    assert!(renderer.take_diagnostics().is_empty());
    peer.close();
}

#[test]
fn optional_renderer_drift_retires_only_the_failed_provider_and_its_dependents() {
    let directory = tempdir().unwrap();
    let mut registry = PluginRegistry::load(directory.path().join("config.json")).unwrap();
    for plugin in bundled_plugins().unwrap() {
        registry.set_enabled(&plugin.manifest.id, false).unwrap();
    }
    let provided = json!({"name":"example.optional","api":1,"scope":"target"});
    for (name, world, provides, requires, source) in [
        (
            "a-drift",
            "main",
            json!([provided]),
            json!([]),
            "module.exports={activate(){throw Error('desktop_build_drift: unsupported sample build')},deactivate(){}};",
        ),
        (
            "b-dependent",
            "isolated",
            json!([]),
            json!([provided]),
            "module.exports={activate(){globalThis.__dependentRan=true},deactivate(){}};",
        ),
        (
            "c-independent",
            "isolated",
            json!([]),
            json!([]),
            "module.exports={activate(){globalThis.__independentRan=true},deactivate(){delete globalThis.__independentRan}};",
        ),
    ] {
        let path = directory.path().join(name);
        std::fs::create_dir(&path).unwrap();
        let id = format!("example.{name}");
        let grants = if world == "main" {
            vec![Permission::UiMainWorld]
        } else {
            vec![]
        };
        std::fs::write(path.join("codlet.json"), json!({"schema":1,"id":id,"version":"1","renderer":{"entry":"renderer.js","world":world},"permissions":grants,"provides":provides,"requires":requires}).to_string()).unwrap();
        std::fs::write(path.join("renderer.js"), source).unwrap();
        registry
            .register_local(
                &id,
                LocalPluginRegistration {
                    path,
                    grants,
                    broker_policy: Default::default(),
                },
            )
            .unwrap();
        registry.set_enabled(&id, true).unwrap();
    }
    registry.save().unwrap();
    let mut renderer =
        RendererRuntime::from_catalog(PluginCatalog::load(&registry).unwrap(), registry).unwrap();
    let (mut peer, events) = VmPeer::start();
    let (mut controller, sessions) =
        TargetController::discover(peer.client.clone(), events, Duration::from_secs(5)).unwrap();
    let reports = renderer.attach_all(&sessions);
    assert!(
        reports
            .iter()
            .all(|(_, report)| report.as_ref().is_ok_and(|report| report.plugin_count == 1)),
        "{reports:?}"
    );
    let diagnostics = renderer.take_diagnostics();
    assert_eq!(diagnostics.len(), 4);
    assert_eq!(
        diagnostics
            .iter()
            .filter(|d| d.message.contains("desktop_build_drift"))
            .count(),
        2
    );
    assert_eq!(
        diagnostics
            .iter()
            .filter(|d| d.message.contains("required renderer provider"))
            .count(),
        2
    );
    peer.request("Fixture.navigate", json!({"targetId":"window-a"}));
    for change in controller.pump(Duration::ZERO).unwrap() {
        renderer.apply_target_change(change).unwrap();
    }
    renderer.pump_bindings().unwrap();
    let snapshot = peer.request(
        "Fixture.inspect",
        json!({"keys":["__independentRan","__dependentRan"]}),
    );
    let contexts = snapshot["contexts"].as_array().unwrap();
    assert_eq!(
        contexts
            .iter()
            .filter(|c| c["globals"]["__independentRan"] == true)
            .count(),
        2
    );
    assert!(
        contexts
            .iter()
            .all(|c| c["globals"].get("__dependentRan").is_none())
    );
    for session in &sessions {
        renderer.deactivate_target(session.target_id()).unwrap();
    }
    let snapshot = peer.request("Fixture.inspect", json!({}));
    for session in snapshot["sessions"].as_array().unwrap() {
        assert_eq!(session["scripts"], 0);
        assert_eq!(session["bindings"], 0);
    }
    peer.close();
}
