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

fn health_runtime(
    source: &str,
) -> (
    tempfile::TempDir,
    RendererRuntime,
    VmPeer,
    TargetController,
    Vec<crate::cdp::TargetSession>,
) {
    let directory = tempdir().unwrap();
    let mut registry = PluginRegistry::load(directory.path().join("config.json")).unwrap();
    for plugin in bundled_plugins().unwrap() {
        registry.set_enabled(&plugin.manifest.id, false).unwrap();
    }
    let manage = json!({"name":"codlet.runtime.manage","api":1,"scope":"target"});
    let ping = json!({"name":"codlet.runtime.ping","api":1,"scope":"target"});
    for (id, body, needs_management) in [
        ("test.health", source, false),
        (
            "test.observer",
            "module.exports={activate(ctx){globalThis.__healthRead=()=>ctx.rpc.request({name:'codlet.runtime.manage',api:1,scope:'target'},'list');},deactivate(){delete globalThis.__healthRead}};",
            true,
        ),
    ] {
        let path = directory.path().join(id);
        std::fs::create_dir(&path).unwrap();
        let mut grants = vec![Permission::UiMainWorld];
        if needs_management {
            grants.push(Permission::RuntimeManage);
        }
        std::fs::write(path.join("codlet.json"), json!({
            "schema":1,"id":id,"version":"1","renderer":{"entry":"renderer.js","world":"main"},
            "permissions":grants,"requires":if needs_management { vec![manage.clone()] } else { vec![ping.clone()] }
        }).to_string()).unwrap();
        std::fs::write(path.join("renderer.js"), body).unwrap();
        registry
            .register_local(
                id,
                LocalPluginRegistration {
                    path,
                    grants,
                    broker_policy: Default::default(),
                },
            )
            .unwrap();
        registry.set_enabled(id, true).unwrap();
    }
    registry.save().unwrap();
    let renderer =
        RendererRuntime::from_catalog(PluginCatalog::load(&registry).unwrap(), registry).unwrap();
    let (peer, events) = VmPeer::start();
    let (controller, sessions) =
        TargetController::discover(peer.client.clone(), events, Duration::from_secs(5)).unwrap();
    (directory, renderer, peer, controller, sessions)
}

fn read_health_list(renderer: &mut RendererRuntime, session: &crate::cdp::TargetSession) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut pending = session
        .until(deadline)
        .start_evaluate_in_context("__healthRead()", None)
        .unwrap();
    loop {
        renderer.pump_bindings().unwrap();
        if let Some(response) = pending.try_response().unwrap() {
            let result = response.result.unwrap();
            assert!(result.get("exceptionDetails").is_none(), "{result}");
            return result.pointer("/result/value").unwrap().clone();
        }
        assert!(Instant::now() < deadline, "management list did not settle");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn health_row(list: &Value) -> &Value {
    list["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == "test.health")
        .unwrap()
}

fn health_request(action: PluginControlAction) -> PluginControlRequest {
    PluginControlRequest {
        action,
        plugin_id: "test.health".into(),
        permission: None,
        cascade: false,
        remove_source: None,
        local_import: None,
    }
}

#[test]
fn renderer_health_retains_activation_failure_until_the_affected_owner_is_replaced_or_disabled() {
    let (_directory, mut renderer, mut peer, _controller, sessions) = health_runtime(
        "module.exports={async activate(ctx){if(globalThis.__rejectHealth){for(let i=0;i<31;i++)ctx.reportDiagnostic({code:'note_'+i,message:'x'.repeat(4096),level:'info'});ctx.reportDiagnostic({code:'zzz_failure',message:'The page could not be registered'});await ctx.rpc.request({name:'codlet.runtime.ping',api:1,scope:'target'},'ping');throw Error('Native toolbar unavailable');}globalThis.__healthContext=ctx;},deactivate(){delete globalThis.__healthContext}};",
    );
    let current = sessions
        .iter()
        .find(|session| session.target_id() == "window-a")
        .unwrap();
    let peer_target = sessions
        .iter()
        .find(|session| session.target_id() == "window-b")
        .unwrap();
    current.evaluate("globalThis.__rejectHealth=true").unwrap();
    assert!(
        renderer
            .attach_all(&sessions)
            .iter()
            .all(|(_, result)| result.is_ok())
    );
    let failed = read_health_list(&mut renderer, current);
    assert_eq!(health_row(&failed)["enabled"], true);
    assert_eq!(health_row(&failed)["active"], false);
    assert_eq!(health_row(&failed)["renderer"]["targetId"], "window-a");
    assert_eq!(health_row(&failed)["renderer"]["lifecycle"], "failed");
    assert_eq!(
        health_row(&failed)["renderer"]["diagnosticsTruncated"],
        true
    );
    assert_eq!(
        health_row(&failed)["renderer"]["diagnostics"]
            .as_array()
            .unwrap()
            .len(),
        crate::runtime_status::MAX_STATUS_DIAGNOSTICS_PER_PLUGIN
    );
    assert_eq!(
        health_row(&failed)["renderer"]["diagnostics"][0]["code"],
        "zzz_failure"
    );
    assert!(
        health_row(&failed)["renderer"]["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .all(|diagnostic| diagnostic["message"].as_str().unwrap().len() <= 1024)
    );
    assert!(
        health_row(&failed)["renderer"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Native toolbar unavailable")
    );
    let healthy = read_health_list(&mut renderer, peer_target);
    assert_eq!(health_row(&healthy)["active"], true);
    assert!(health_row(&healthy)["renderer"]["error"].is_null());
    assert_eq!(
        renderer
            .manage_plugin(health_request(PluginControlAction::Disable))
            .unwrap()
            .outcome,
        PluginControlOutcome::Applied
    );
    let disabled = read_health_list(&mut renderer, current);
    assert_eq!(health_row(&disabled)["enabled"], false);
    assert!(health_row(&disabled).get("renderer").is_none());
    assert!(renderer.status_snapshot().targets.iter().all(|target| {
        target
            .plugins
            .iter()
            .all(|plugin| plugin.id != "test.health")
    }));
    current.evaluate("globalThis.__rejectHealth=false").unwrap();
    assert_eq!(
        renderer
            .manage_plugin(health_request(PluginControlAction::Enable))
            .unwrap()
            .outcome,
        PluginControlOutcome::Applied
    );
    let recovered = read_health_list(&mut renderer, current);
    assert_eq!(health_row(&recovered)["active"], true);
    assert!(health_row(&recovered)["renderer"]["error"].is_null());
    for session in &sessions {
        renderer.deactivate_target(session.target_id()).unwrap();
    }
    peer.close();
}

#[test]
fn renderer_health_diagnostics_are_current_owner_scoped_and_need_explicit_recovery() {
    let (_directory, mut renderer, mut peer, mut controller, sessions) = health_runtime(
        "module.exports={activate(ctx){globalThis.__healthContext=ctx;},deactivate(){delete globalThis.__healthContext}};",
    );
    assert!(
        renderer
            .attach_all(&sessions)
            .iter()
            .all(|(_, result)| result.is_ok())
    );
    let current = sessions
        .iter()
        .find(|session| session.target_id() == "window-a")
        .unwrap();
    let peer_target = sessions
        .iter()
        .find(|session| session.target_id() == "window-b")
        .unwrap();
    current.evaluate("__healthContext.reportDiagnostic({code:'page_failed',message:'Native toolbar unavailable'});__healthContext.reportDiagnostic({code:'page_failed',message:'still preparing',level:'info'});__healthContext.reportDiagnostic({code:'progress',message:'other work',level:'info'});true").unwrap();
    renderer.pump_bindings().unwrap();
    let list = read_health_list(&mut renderer, current);
    let row = health_row(&list);
    assert_eq!(
        row["active"], true,
        "diagnostics do not revoke an active owner's authority"
    );
    assert_eq!(row["renderer"]["diagnostics"][0]["code"], "page_failed");
    assert_eq!(
        row["renderer"]["diagnostics"][0]["message"],
        "Native toolbar unavailable"
    );
    assert_eq!(row["renderer"]["diagnostics"][0]["level"], "error");
    assert_eq!(
        health_row(&read_health_list(&mut renderer, peer_target))["renderer"]["diagnostics"],
        json!([])
    );
    current.evaluate("for(let i=3;i<32;i++)__healthContext.reportDiagnostic({code:'progress',message:'bounded '+i,level:'info'});__healthContext.reportDiagnostic({code:'page_failed',message:'ready',resolved:true});true").unwrap();
    renderer.pump_bindings().unwrap();
    let resolved = read_health_list(&mut renderer, current);
    assert_eq!(
        health_row(&resolved)["renderer"]["diagnostics"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        health_row(&resolved)["renderer"]["diagnostics"][0]["code"],
        "progress"
    );
    current
        .evaluate("globalThis.__retiredHealthContext=__healthContext;true")
        .unwrap();
    assert_eq!(
        renderer
            .manage_plugin(health_request(PluginControlAction::Reload))
            .unwrap()
            .outcome,
        PluginControlOutcome::Applied
    );
    let reloaded = read_health_list(&mut renderer, current);
    assert_eq!(health_row(&reloaded)["renderer"]["diagnostics"], json!([]));
    assert!(
        health_row(&reloaded)["generation"].as_u64().unwrap() > row["generation"].as_u64().unwrap()
    );
    let retired = current.evaluate("(()=>{try{__retiredHealthContext.reportDiagnostic({code:'progress',message:'late',resolved:true});return 'unexpected';}catch(error){return error.code;}})()").unwrap();
    assert_eq!(
        retired.pointer("/result/value"),
        Some(&json!("plugin_deactivated"))
    );
    for session in &sessions {
        session.evaluate("__healthContext.reportDiagnostic({code:'document_error',message:'this document'});true").unwrap();
    }
    current.evaluate("for(let i=1;i<32;i++)__healthContext.reportDiagnostic({code:'progress',message:'old document',level:'info'});true").unwrap();
    renderer.pump_bindings().unwrap();
    peer.request("Fixture.navigate", json!({"targetId":"window-a"}));
    for change in controller.pump(Duration::ZERO).unwrap() {
        renderer.apply_target_change(change).unwrap();
    }
    renderer.pump_bindings().unwrap();
    let navigated = read_health_list(&mut renderer, current);
    assert_eq!(health_row(&navigated)["renderer"]["diagnostics"], json!([]));
    assert_eq!(
        health_row(&navigated)["generation"],
        health_row(&reloaded)["generation"]
    );
    current.evaluate("__healthContext.reportDiagnostic({code:'new_document_error',message:'new document owner'});true").unwrap();
    renderer.pump_bindings().unwrap();
    let new_owner = read_health_list(&mut renderer, current);
    assert_eq!(
        health_row(&new_owner)["renderer"]["diagnostics"][0]["code"],
        "new_document_error",
        "the new document owns a fresh diagnostic budget at the same plugin generation"
    );
    let untouched = read_health_list(&mut renderer, peer_target);
    assert_eq!(
        health_row(&untouched)["renderer"]["diagnostics"][0]["code"],
        "document_error"
    );
    for session in &sessions {
        renderer.deactivate_target(session.target_id()).unwrap();
    }
    assert!(renderer.status_snapshot().targets.is_empty());
    peer.close();
}

#[test]
fn isolated_world_budget_refuses_reload_before_retirement_and_reserves_rollback() {
    let directory = tempdir().unwrap();
    let mut registry = PluginRegistry::load(directory.path().join("config.json")).unwrap();
    for plugin in bundled_plugins().unwrap() {
        registry.set_enabled(&plugin.manifest.id, false).unwrap();
    }
    for world in ["isolated", "main"] {
        let path = directory.path().join(world);
        std::fs::create_dir(&path).unwrap();
        let id = format!("test.{world}");
        let grants = if world == "main" {
            vec![Permission::UiMainWorld]
        } else {
            vec![]
        };
        std::fs::write(path.join("codlet.json"), json!({"schema":1,"id":id,"version":"1","renderer":{"entry":"renderer.js","world":world},"permissions":grants,"provides":[],"requires":[]}).to_string()).unwrap();
        std::fs::write(path.join("renderer.js"), "module.exports={activate(ctx){globalThis.ownerGeneration=ctx.generation},deactivate(){delete globalThis.ownerGeneration}};").unwrap();
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
    let saved = std::fs::read(registry.path()).unwrap();
    let mut renderer =
        RendererRuntime::from_catalog(PluginCatalog::load(&registry).unwrap(), registry.clone())
            .unwrap();
    renderer.set_world_limit_for_test(6);
    let (mut peer, events) = VmPeer::start();
    let (_controller, sessions) =
        TargetController::discover(peer.client.clone(), events, Duration::from_secs(5)).unwrap();
    assert_eq!(sessions.len(), 2);
    assert!(
        renderer
            .attach_all(&sessions)
            .iter()
            .all(|(_, result)| result.is_ok())
    );
    let request = |action, id: &str| PluginControlRequest {
        action,
        plugin_id: id.into(),
        permission: None,
        cascade: false,
        remove_source: None,
        local_import: None,
    };
    let report = renderer
        .manage_plugin(request(PluginControlAction::Reload, "test.isolated"))
        .unwrap();
    assert_eq!(report.outcome, PluginControlOutcome::Applied);
    assert_eq!(
        renderer
            .status_snapshot()
            .isolated_worlds
            .as_ref()
            .unwrap()
            .attempted,
        4
    );
    let before = peer.request("Fixture.inspect", json!({"keys":["ownerGeneration"]}));
    let error = renderer
        .manage_plugin(request(PluginControlAction::Reload, "test.isolated"))
        .unwrap_err();
    assert_eq!(error.code, "renderer_restart_required");
    assert_eq!(
        peer.request("Fixture.inspect", json!({"keys":["ownerGeneration"]}))["contexts"],
        before["contexts"]
    );
    assert_eq!(std::fs::read(registry.path()).unwrap(), saved);
    // A navigation during a package transaction cannot spend the worlds held
    // for its candidate/rollback on an unrelated document bootstrap.
    renderer.set_world_limit_for_test(8);
    let generations = renderer.package_generations();
    let replacements = renderer.logical_plugins();
    renderer
        .begin_package_management(generations.clone(), &replacements)
        .unwrap();
    assert_eq!(
        renderer
            .status_snapshot()
            .isolated_worlds
            .as_ref()
            .unwrap()
            .reserved,
        4
    );
    peer.request("Fixture.navigate", json!({"targetId":"window-a"}));
    renderer.pump_bindings().unwrap();
    assert_eq!(
        renderer
            .status_snapshot()
            .isolated_worlds
            .as_ref()
            .unwrap()
            .attempted,
        4
    );
    renderer.finish_package_management(registry.clone(), generations);
    assert_eq!(
        renderer
            .status_snapshot()
            .isolated_worlds
            .as_ref()
            .unwrap()
            .reserved,
        0
    );
    peer.request("Fixture.navigate", json!({"targetId":"window-a"}));
    renderer.pump_bindings().unwrap();
    assert_eq!(
        renderer
            .status_snapshot()
            .isolated_worlds
            .as_ref()
            .unwrap()
            .attempted,
        5
    );
    assert_eq!(
        renderer
            .manage_plugin(request(PluginControlAction::Reload, "test.main"))
            .unwrap()
            .outcome,
        PluginControlOutcome::Applied
    );
    assert_eq!(
        renderer
            .manage_plugin(request(PluginControlAction::Disable, "test.isolated"))
            .unwrap()
            .outcome,
        PluginControlOutcome::Applied
    );
    assert_eq!(
        renderer
            .status_snapshot()
            .isolated_worlds
            .as_ref()
            .unwrap()
            .attempted,
        5
    );
    for session in &sessions {
        renderer.deactivate_target(session.target_id()).unwrap();
    }
    peer.close();
}

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
