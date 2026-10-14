//! Real update worker -> foreground coordinator -> production renderer JS/Host
//! -> retained Node Native bridge. VM providers are controlled fixtures, not
//! Chromium/Native adapters; real Native coverage is a separate owned run.
use super::*;
use crate::catalog::{PluginCatalog, PluginCatalogEntry, PluginSource};
use crate::cdp::{TargetController, VmPeer};
use crate::client_bridge::{ClientSourceRuntime, Endpoint};
use crate::host_control::HostControl;
use crate::host_runtime::{
    HostCapabilityCaller, HostCapabilityRequest, HostCoreServices, HostRuntime,
};
use crate::platform::host::OwnedPluginProcess;
use crate::plugins::{LocalPluginRegistration, Permission, PluginRegistry};
use crate::renderer::RendererRuntime;
use crate::runtime_control::ControlBroker;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::Instant;

const PLUGIN: &str = "test.online.foreground";
const WAIT: Duration = Duration::from_secs(30);
struct NativePeer(OwnedPluginProcess);
impl Drop for NativePeer {
    fn drop(&mut self) {
        let _ = self.0.terminate();
        let _ = self.0.wait(Duration::from_secs(2));
    }
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
const SOURCE: &str = r#"module.exports={handoffVersion:1,validateClientSource(){},validateSnapshot:s=>s.schema===1,installElectronTraffic(){return {
 handoffVersion:1,snapshot:()=>({schema:1}),suspend:()=>true,resume:()=>true,restore(){},confirmTakeover:()=>true,
 ready:async()=>({installed:true,activatedSources:[{id:'fixture-main',operations:['http.intercept'],protocols:['http'],coverage:['fixture-sse']}],unsupportedSources:[]}),close(){}};}};"#;
const UI: &str = "module.exports={activate(){},saveState:()=>({schema:1,value:null}),restoreState(){},deactivate(){}};";
// A retained test ingress forwarding gate with the same private contract. It
// has no Native postbox, DOM, model request or adapter discovery behavior.
const DESKTOP: &str = r#"let state;module.exports={activate(ctx){const key=Symbol.for('codlet.core.native-ingress.v1');
 state=globalThis.__foregroundIngress??={held:null,events:[],generation:0};state.generation=ctx.generation;state.events.push(['activate',ctx.generation]);
 globalThis[key]??=Object.freeze({api:1,documentEpoch:'fixture-document',pause(id){if(state.held&&state.held!==id)return {ok:false};state.held=id;state.events.push(['pause',id]);return {ok:true,held:true,documentEpoch:'fixture-document'};},
 resume(id){if(state.held!==id)return {ok:false};state.held=null;state.events.push(['resume',id]);return {ok:true,resumed:true,documentEpoch:'fixture-document'};}});},
 saveState:()=>({schema:1,value:null}),restoreState(){},deactivate(){state.events.push(['deactivate',state.generation]);}};"#;
const HOST: &str = r#"let ctx,count=0;const fs=require('node:fs'),path=require('node:path');
 const event=(name,value)=>fs.appendFileSync(path.join(ctx.root,'host-events.jsonl'),JSON.stringify({name,generation:ctx.plugin.generation,value})+'\n');
 module.exports={activate(context){ctx=context;event('activate',count);ctx.rpc.provide({name:'test.foreground.host',api:1,scope:'runtime'},'inspect',()=>({count:++count,generation:ctx.plugin.generation}));},
 saveState(){return {schema:1,value:{count}};},restoreState(snapshot){count=snapshot.value.count;event('restore',count);},deactivate(){event('deactivate',count);}};"#;
fn renderer_source(with_state: bool) -> String {
    format!(
        r#"let state,ctx;module.exports={{async activate(context){{ctx=context;state={{draft:'owned draft',generation:ctx.generation}};
 state.host=await ctx.rpc.request({{name:'test.foreground.host',api:1,scope:'runtime'}},'inspect',null);globalThis.__foregroundState=state;}},
 {}deactivate(){{delete globalThis.__foregroundState;}}}};"#,
        if with_state {
            "saveState(){return {schema:1,value:{draft:state.draft}};},restoreState(snapshot){state.draft=snapshot.value.draft;},"
        } else {
            ""
        }
    )
}
fn modules_for_fixture(stamp: &str) -> BTreeMap<String, String> {
    modules::module_paths()
        .map(|(id, path)| {
            let source = match id {
                "core-ui-provider" => UI.to_owned(),
                "core-desktop-provider" => DESKTOP.to_owned(),
                _ => std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(path))
                    .unwrap(),
            };
            (
                id.into(),
                format!("{source}\n// controlled foreground fixture {stamp}"),
            )
        })
        .collect()
}

#[test]
fn core_update_uses_the_actual_foreground_coordinator_for_apply_and_defer() {
    for scenario in ["applied", "nextStart"] {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "runtime_update::foreground_tests::foreground_child",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("CODLET_FOREGROUND_CHILD", scenario)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{scenario}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
#[test]
#[ignore = "isolated owned subprocess entry for verified global Core module generations"]
fn foreground_child() {
    let scenario = std::env::var("CODLET_FOREGROUND_CHILD").unwrap();
    assert!(matches!(scenario.as_str(), "applied" | "nextStart"));
    run_foreground(scenario == "applied");
}
fn run_foreground(with_state: bool) {
    let directory = tempfile::tempdir().unwrap();
    let install = directory.path().join("install");
    let stage = directory.path().join("stage");
    let state_root = directory.path().join("state");
    for root in [&install, &stage, &state_root] {
        std::fs::create_dir(root).unwrap();
    }
    let initial = OnlineCoreModulesRequest {
        id: "foreground-baseline".into(),
        version: CURRENT_VERSION.into(),
        module_abi: 1,
        modules: modules_for_fixture("baseline"),
        client_source: SOURCE.into(),
        deadline_unix_ms: now_ms() + 180_000,
    };
    activate_online_modules(&initial).unwrap().commit();
    let registry_path = state_root.join("config.json");
    let root = directory.path().join("plugin");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("codlet.json"),json!({"schema":1,"id":PLUGIN,"version":"1","host":{"entry":"host.cjs","provides":[{"name":"test.foreground.host","api":1,"scope":"runtime"}]},"renderer":{"entry":"renderer.cjs","world":"isolated"},"permissions":["host.process","cdp.raw"],"requires":[{"name":"test.foreground.host","api":1,"scope":"runtime"}]}).to_string()).unwrap();
    std::fs::write(root.join("host.cjs"), HOST).unwrap();
    std::fs::write(root.join("renderer.cjs"), renderer_source(with_state)).unwrap();
    let mut registry = PluginRegistry::load(&registry_path).unwrap();
    for plugin in crate::plugins::bundled_plugins().unwrap() {
        registry.set_enabled(&plugin.manifest.id, false).unwrap();
    }
    registry
        .register_local(
            PLUGIN,
            LocalPluginRegistration {
                path: root.canonicalize().unwrap(),
                grants: vec![Permission::HostProcess, Permission::CdpRaw],
                ..Default::default()
            },
        )
        .unwrap();
    registry.set_enabled(PLUGIN, true).unwrap();
    registry.save().unwrap();
    let saved_registry = std::fs::read(&registry_path).unwrap();
    let mut catalog = PluginCatalog::load(&registry).unwrap();
    // Unit builds deliberately substitute legacy synthetic bundled providers.
    // Insert the fixture's verified Core-owned implementations explicitly.
    for plugin in crate::codex::internal_plugins().unwrap() {
        catalog.replace_entry(PluginCatalogEntry {
            id: plugin.manifest.id.clone(),
            source: PluginSource::Core,
            plugin: Ok(plugin),
        });
    }
    let loaded = catalog.enabled_plugins(&registry).unwrap();
    let services = crate::core_services::SharedCoreServices::new(&registry_path).unwrap();
    let (mut peer, events) = VmPeer::start();
    let mut hosts = HostRuntime::start_with_services(
        loaded,
        peer.client.clone(),
        Some(peer.runtime.clone()),
        HostCoreServices {
            plugin_services: Some(services.clone()),
            ..Default::default()
        },
    )
    .unwrap();
    let mut renderer = RendererRuntime::from_catalog(catalog, registry).unwrap();
    renderer.set_host_capability_client(hosts.capability_client());
    renderer.set_external_observations(hosts.observations());
    renderer.set_core_services(services.clone()).unwrap();
    let (_targets, sessions) =
        TargetController::discover(peer.client.clone(), events, Duration::from_secs(5)).unwrap();
    let reports = renderer.attach_all(&sessions);
    assert!(
        reports.iter().all(|(_, result)| result.is_ok()),
        "{reports:?}"
    );
    assert!(
        reports
            .iter()
            .all(|(_, result)| result.as_ref().is_ok_and(|report| report.plugin_count == 3)),
        "all three owned renderer entries must be active before update: {reports:?}; {}",
        peer.request(
            "Fixture.inspect",
            json!({"keys":["__foregroundState","__foregroundIngress"]})
        )
    );
    let (source, _native_peer) =
        bridge_fixture(directory.path(), &peer, registry_path.clone(), &services);
    renderer.set_client_source(Some(source.clone()));
    let (mut manifest, files) = tests::payload(
        RuntimePayloadProfile::Portable,
        "1.0.1",
        "24.21.0",
        "foreground-identical-resident",
    );
    for (relative, bytes) in &files {
        for root in [&install, &stage] {
            let path = root.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }
    }
    let candidate_modules = modules_for_fixture("candidate");
    let candidate_source = format!("{SOURCE}\n// candidate");
    let mut online = package::OnlineRuntime::current();
    for (id, path) in modules::module_paths() {
        let source = &candidate_modules[id];
        let file = stage.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, source).unwrap();
        manifest
            .files
            .push(package::file_record(&file, path).unwrap());
        online.modules.push(package::OnlineModule {
            id: id.into(),
            path: path.into(),
        });
    }
    let source_file = stage.join(package::ONLINE_CLIENT_SOURCE);
    std::fs::write(&source_file, &candidate_source).unwrap();
    manifest
        .files
        .push(package::file_record(&source_file, package::ONLINE_CLIENT_SOURCE).unwrap());
    manifest.online = Some(online);
    let bytes = serde_json::to_vec(&manifest).unwrap();
    std::fs::write(stage.join(package::MANIFEST), &bytes).unwrap();
    let restart = RuntimeRestartContext {
        profile: RuntimePayloadProfile::Portable,
        command: RuntimeRestartCommand {
            program: std::env::current_exe().unwrap(),
            args: vec![],
            working_directory: install.clone(),
            environment: BTreeMap::new(),
            timeout_seconds: 15,
        },
        wait_for: vec![],
        launcher_files: vec![],
        config_pin: None,
    };
    let updates =
        RuntimeUpdateService::start(install.clone(), state_root.clone(), Some(restart)).unwrap();
    updates.attach_online_target(source.clone());
    {
        let mut state = updates.shared.lock().unwrap();
        state.staged = Some(package::StagedRuntime {
            directory: stage,
            manifest,
            manifest_sha256: digest(&bytes),
            candidate: RuntimeUpdateCandidate {
                id: "c".repeat(64),
                version: "1.0.1".into(),
                platform: PLATFORM.into(),
                size: 1,
                sha256: "d".repeat(64),
                release_url: None,
            },
        });
        state.status.phase = RuntimeUpdatePhase::Downloaded;
    }
    let broker = ControlBroker::new([74; 16], "controlled-foreground".into());
    broker.set_ready();
    let manage = crate::runtime_manage::RuntimeManageService::new(broker.clone());
    manage.set_runtime_update(updates.clone());
    renderer.set_manage_service(manage);
    let mut control = HostControl::new(registry_path.clone());
    if with_state {
        std::fs::write(directory.path().join("lose-source-reply"), b"once").unwrap();
        std::fs::write(directory.path().join("lose-release-reply"), b"once").unwrap();
    }
    updates.request_install().unwrap();
    let until = Instant::now() + WAIT;
    let mut entered = false;
    loop {
        renderer.pump_bindings().unwrap();
        control.poll(&mut renderer, &hosts, &broker);
        entered |= control.is_pending();
        let status = updates.status();
        if entered && !control.is_pending() && status.phase != RuntimeUpdatePhase::InstallRequested
        {
            break;
        }
        assert!(
            Instant::now() < until,
            "foreground timeout: status={status:?}; hosts={:?}; VM={}",
            hosts.observations(),
            peer.request(
                "Fixture.inspect",
                json!({"keys":["__foregroundState","__foregroundIngress"]})
            )
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let status = updates.status();
    let inspection = peer.request(
        "Fixture.inspect",
        json!({"keys":["__foregroundState","__foregroundIngress"]}),
    );
    assert_eq!(
        std::fs::read(&registry_path).unwrap(),
        saved_registry,
        "Core update must not write user registry intent"
    );
    assert!(updates.take_install_request().is_none());
    if with_state {
        assert_eq!(
            status.phase,
            RuntimeUpdatePhase::UpToDate,
            "actual foreground rolled back: {status:?}; Host events={}; VM={inspection}; bridge commands={}",
            std::fs::read_to_string(root.join("host-events.jsonl")).unwrap_or_default(),
            std::fs::read_to_string(directory.path().join("bridge-commands.log"))
                .unwrap_or_default()
        );
    }
    let bridge_status = source
        .confirm_core_code(if with_state {
            &candidate_source
        } else {
            SOURCE
        })
        .unwrap();
    assert_eq!(bridge_status["onlineUpdate"]["writes"]["accepting"], true);
    assert!(bridge_status["onlineUpdate"]["admission"].is_null());
    let events = std::fs::read_to_string(root.join("host-events.jsonl")).unwrap();
    let host_events = events
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    if with_state {
        assert_eq!(status.phase, RuntimeUpdatePhase::UpToDate, "{status:?}");
        assert_eq!(status.activation.as_ref().unwrap().mode, "online");
        assert!(
            host_events
                .iter()
                .any(|event| event["name"] == "restore" && event["generation"] == 2)
        );
        let commands =
            std::fs::read_to_string(directory.path().join("bridge-commands.log")).unwrap();
        assert_eq!(
            commands.lines().filter(|line| *line == "replace").count(),
            1
        );
        assert_eq!(
            commands
                .lines()
                .filter(|line| *line == "finishAdmission")
                .count(),
            1
        );
        assert_eq!(
            modules::installed_modules(&install).unwrap(),
            candidate_modules
        );
    } else {
        assert_eq!(status.phase, RuntimeUpdatePhase::Deferred, "{status:?}");
        assert_eq!(status.activation.as_ref().unwrap().mode, "nextStart");
        assert!(
            host_events
                .iter()
                .all(|event| event["name"] != "deactivate")
        );
        assert_eq!(
            core_module_source("core-ui-provider", "missing"),
            initial.modules["core-ui-provider"]
        );
    }
    for context in inspection["contexts"].as_array().unwrap() {
        if context["plugins"]
            .as_array()
            .is_some_and(|plugins| !plugins.is_empty())
        {
            assert!(
                context["coreAdmission"]["operationId"].is_null(),
                "active renderer realm must release global admission: {context}"
            );
        }
        if let Some(state) = context["globals"].get("__foregroundState") {
            assert_eq!(state["draft"], "owned draft");
            assert_eq!(state["generation"], if with_state { 2 } else { 1 });
        }
        if let Some(state) = context["globals"].get("__foregroundIngress") {
            assert!(state["held"].is_null());
            assert_eq!(
                state["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|event| event[0] == "resume")
                    .count(),
                1
            );
        }
    }
    assert_eq!(
        inspection["contexts"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|context| context["globals"].get("__foregroundState").is_some())
            .count(),
        sessions.len(),
        "every owned target must retain its restored consumer"
    );
    renderer.ensure_core_management_available().unwrap();
    let generation = if with_state { 2 } else { 1 };
    let mut post_update = hosts
        .capability_client()
        .begin_request(HostCapabilityRequest {
            owner_plugin_id: PLUGIN.into(),
            expected_generation: generation,
            capability: crate::capabilities::CapabilityDescriptor::new(
                "test.foreground.host",
                1,
                crate::capabilities::CapabilityScope::Runtime,
            )
            .unwrap(),
            method: "inspect".into(),
            params: Value::Null,
            caller: HostCapabilityCaller {
                plugin_id: PLUGIN.into(),
                generation,
                target_id: String::new(),
                document_epoch: 0,
            },
            cleanup: false,
            deadline: Instant::now() + Duration::from_secs(5),
        })
        .expect("normal Host capability admission must resume after the transaction");
    let until = Instant::now() + Duration::from_secs(5);
    let result = loop {
        if let Some(result) = post_update.try_result() {
            break result.unwrap();
        }
        assert!(Instant::now() < until, "post-update Host receipt timed out");
        std::thread::sleep(Duration::from_millis(5));
    };
    assert_eq!(result["generation"], generation);
    assert_eq!(result["count"], if with_state { 5 } else { 3 });
    let probe = peer.request("Fixture.inspect", json!({"keys":[]}));
    assert_eq!(probe["evaluations"], 0);
    hosts.stop().unwrap();
    peer.close();
}

fn bridge_fixture(
    root: &Path,
    peer: &VmPeer,
    registry: PathBuf,
    services: &crate::core_services::SharedCoreServices,
) -> (ClientSourceRuntime, NativePeer) {
    std::fs::write(
        root.join("bridge.cjs"),
        include_str!("../../runtime/client-bridge-bundle.cjs"),
    )
    .unwrap();
    let entry = root.join("native-peer.cjs");
    std::fs::write(&entry,format!(r#"process.type='browser';const bridge=require('./bridge.cjs').startClientBridge({{app:{{isReady:()=>false,getAppPath:()=>__dirname}}}},{{token:'f'.repeat(48)}});
 bridge.installInitial({{owner:'codlet.core',generation:1,code:{},configuration:{{}}}}).then(()=>bridge.ready()).then(()=>bridge.endpoint()).then(async endpoint=>{{
 const net=require('node:net'),fs=require('node:fs'),path=require('node:path');let lost=null,drop=false;
 const proxy=net.createServer(socket=>{{let bytes=Buffer.alloc(0);function first(chunk){{bytes=Buffer.concat([bytes,chunk]);if(!bytes.includes(10))return;socket.off('data',first);
 const command=JSON.parse(bytes.toString().split('\n')[0]);let suppress=false;if(['replace','finishAdmission'].includes(command.op)){{fs.appendFileSync(path.join(__dirname,'bridge-commands.log'),command.op+'\n');const marker=path.join(__dirname,command.op==='replace'?'lose-source-reply':'lose-release-reply');if(fs.existsSync(marker)){{fs.unlinkSync(marker);lost=command.operationId;drop=true;suppress=true;}}}}
 if(command.op==='status'&&command.operationId===lost&&drop){{drop=false;suppress=true;}}const upstream=net.connect({{host:endpoint.host,port:endpoint.port}},()=>upstream.write(bytes));socket.pipe(upstream);
 if(suppress){{upstream.resume();upstream.once('end',()=>socket.destroy());}}else upstream.pipe(socket);upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.once('close',()=>upstream.destroy());}}socket.on('data',first);}});
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));process.stdout.write(JSON.stringify({{...endpoint,port:proxy.address().port}})+'\n');}});"#,serde_json::to_string(SOURCE).unwrap())).unwrap();
    let (native, stdio) = OwnedPluginProcess::spawn(
        peer.runtime.executable_path(),
        &[entry.to_string_lossy().into_owned()],
        root,
        None,
    )
    .unwrap();
    let mut data = Vec::new();
    let mut buffer = [0; 4096];
    let deadline = Instant::now() + Duration::from_secs(5);
    while data.last() != Some(&b'\n') {
        let count = stdio.stdout.read_some(&mut buffer, Some(deadline)).unwrap();
        assert!(count > 0 && data.len() + count < 65536);
        data.extend_from_slice(&buffer[..count]);
    }
    let endpoint: Endpoint = serde_json::from_slice(&data).unwrap();
    let target = ClientSourceRuntime::new(
        endpoint,
        peer.runtime.clone(),
        registry,
        json!({"source":{"operations":["http.intercept"],"protocols":["http"]}}),
        None,
        services.prepare_traffic().unwrap(),
        deadline,
    )
    .unwrap();
    (target, NativePeer(native))
}
