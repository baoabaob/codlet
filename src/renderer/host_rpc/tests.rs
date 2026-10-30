use super::*;
use crate::catalog::PluginCatalog;
use crate::cdp::{TargetController, VmPeer};
use crate::host_runtime::{HostCoreServices, HostRuntime};
use crate::plugins::{LocalPluginRegistration, Permission, PluginRegistry, bundled_plugins};
use tempfile::{TempDir, tempdir};

const WAIT: Duration = Duration::from_secs(12);
const STATE: &str = "__hostAdmissionState";

struct Fixture {
    renderer: RendererRuntime,
    hosts: HostRuntime,
    peer: VmPeer,
    target: String,
    context: u64,
    _directory: TempDir,
}

impl Fixture {
    fn new() -> Self {
        Self::in_world("isolated")
    }

    fn in_world(world: &str) -> Self {
        Self::with_direct_provider(world, false)
    }

    fn with_direct_provider(world: &str, direct: bool) -> Self {
        let directory = tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let scope = root.join("registry.json");
        let id = "test.host-admission";
        let mut grants = vec![Permission::CoreStorage, Permission::CoreTasks];
        if world == "main" {
            grants.push(Permission::UiMainWorld);
        }
        let direct_capability = json!({"name":"test.renderer.direct","api":1,"scope":"target"});
        let mut requires = vec![json!({"name":"codlet.core.services","api":1,"scope":"runtime"})];
        if direct {
            requires.push(direct_capability.clone());
        }
        std::fs::write(root.join("codlet.json"), json!({"schema":1,"id":id,"version":"1","renderer":{"entry":"renderer.js","world":world},"requires":requires,"permissions":grants}).to_string()).unwrap();
        std::fs::write(root.join("renderer.js"), "exports.activate=context=>{globalThis.__hostAdmissionContext=context};exports.deactivate=()=>{delete globalThis.__hostAdmissionContext};").unwrap();
        let mut registry = PluginRegistry::load(&scope).unwrap();
        for plugin in bundled_plugins().unwrap() {
            registry.set_enabled(&plugin.manifest.id, false).unwrap();
        }
        if direct {
            let provider = root.join("provider");
            std::fs::create_dir(&provider).unwrap();
            std::fs::write(provider.join("codlet.json"), json!({"schema":1,"id":"test.renderer.provider","version":"1","renderer":{"entry":"renderer.js","world":"main"},"provides":[direct_capability],"permissions":["ui.mainWorld"]}).to_string()).unwrap();
            std::fs::write(provider.join("renderer.js"), r#"exports.activate=context=>{
              globalThis.__directProvider={calls:0,aborts:0,completions:0};
              context.rpc.provide({name:'test.renderer.direct',api:1,scope:'target'},'hold',async(params,invocation)=>{
                __directProvider.calls++;
                if(params.cancel)__hostAdmissionState.controller.abort();
                invocation.signal.addEventListener('abort',()=>__directProvider.aborts++,{once:true});
                await new Promise(resolve=>setTimeout(resolve,25));
                __directProvider.completions++;
                return {received:true};
              });
            };"#).unwrap();
            registry
                .register_local(
                    "test.renderer.provider",
                    LocalPluginRegistration {
                        path: provider,
                        grants: vec![Permission::UiMainWorld],
                        broker_policy: Default::default(),
                    },
                )
                .unwrap();
        }
        registry
            .register_local(
                id,
                LocalPluginRegistration {
                    path: root,
                    grants,
                    broker_policy: Default::default(),
                },
            )
            .unwrap();
        registry.save().unwrap();
        let catalog = PluginCatalog::load(&registry).unwrap();
        let services = crate::core_services::SharedCoreServices::new(&scope).unwrap();
        let (peer, events) = VmPeer::start();
        let hosts = HostRuntime::start_with_services(
            catalog.enabled_plugins(&registry).unwrap(),
            peer.client.clone(),
            Some(peer.runtime.clone()),
            HostCoreServices {
                plugin_services: Some(services.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        let mut renderer = RendererRuntime::from_catalog(catalog, registry).unwrap();
        renderer.set_core_services(services).unwrap();
        renderer.set_host_capability_client(hosts.capability_client());
        let (_controller, sessions) =
            TargetController::discover(peer.client.clone(), events, Duration::from_secs(5))
                .unwrap();
        let reports = renderer.attach_all(&sessions);
        assert!(
            reports.iter().all(|(_, result)| result.is_ok()),
            "{reports:?}"
        );
        let inspected = peer.request("Fixture.inspect", json!({"keys":[]}));
        let realm = inspected["contexts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|context| {
                context["plugins"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|plugin| plugin["id"] == id)
            })
            .unwrap();
        let target = realm["targetId"].as_str().unwrap().to_owned();
        let context = realm["id"].as_u64().unwrap();
        let mut fixture = Self {
            renderer,
            hosts,
            peer,
            target,
            context,
            _directory: directory,
        };
        fixture.eval("__hostAdmissionContext.services.storage.snapshot()");
        fixture.until(|fixture| fixture.renderer.pending_host_call_count() == 0);
        fixture
    }

    fn eval(&mut self, expression: &str) -> Value {
        let response = self
            .renderer
            .evaluate_with_binding_pump(&self.target, expression, self.context)
            .unwrap();
        assert!(response.get("exceptionDetails").is_none(), "{response}");
        response
            .pointer("/result/value")
            .cloned()
            .unwrap_or(Value::Null)
    }

    fn inspect(&self) -> Value {
        let response = self
            .peer
            .request("Fixture.inspect", json!({"keys":[STATE]}));
        response["contexts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|context| context["id"] == self.context)
            .unwrap()["globals"][STATE]
            .clone()
    }

    fn enqueue(&self, expression: &str) {
        let response = self.renderer.sessions[&self.target]
            .session
            .evaluate_in_context(expression, Some(self.context))
            .unwrap();
        assert!(response.get("exceptionDetails").is_none(), "{response}");
    }

    fn until(&mut self, condition: impl Fn(&mut Self) -> bool) {
        let deadline = Instant::now() + WAIT;
        loop {
            if condition(self) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "renderer calls did not settle; state={}",
                self.inspect()
            );
            self.renderer.pump_bindings().unwrap();
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    fn hold_delivery_acks(&self) {
        // Main-world fixture scheduling delays only the evaluation receipt:
        // the actual production receiver resolves the actual SDK Promise first.
        self.enqueue(r#"globalThis.__heldHostDeliveryAcks=[];
          const bridge=globalThis.__codletRendererV1;
          globalThis.__unheldHostBridge=bridge;
          Object.defineProperty(globalThis,'__codletRendererV1',{configurable:true,value:Object.freeze({
            ...bridge,__rpcReceive(...args){
              const result=bridge.__rpcReceive(...args);
              if(args[1].ok && __heldHostDeliveryAcks.length<4)
                return new Promise(resolve=>__heldHostDeliveryAcks.push(()=>resolve(result)));
              return result;
            }
          })});undefined"#);
    }

    fn release_delivery_acks(&self) {
        self.enqueue("Object.defineProperty(globalThis,'__codletRendererV1',{configurable:true,value:__unheldHostBridge});for(const release of __heldHostDeliveryAcks.splice(0))release();delete globalThis.__unheldHostBridge;undefined");
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        for target in self.renderer.sessions.keys().cloned().collect::<Vec<_>>() {
            let _ = self.renderer.deactivate_target(&target);
        }
        let _ = self.hosts.stop();
        self.peer.close();
    }
}

#[test]
fn acknowledged_host_deliveries_are_reaped_before_continuation_admission() {
    let mut fixture = Fixture::new();
    fixture.enqueue("globalThis.__hostAdmissionState={continued:false,result:null}; const query=()=>__hostAdmissionContext.services.storage.snapshot(); Promise.all(Array.from({length:4},query)).then(()=>{__hostAdmissionState.continued=true;Promise.all(Array.from({length:4},()=>query().then(()=>({ok:true}),error=>({code:error.code})))).then(result=>{__hostAdmissionState.result=result})}); undefined");
    let deadline = Instant::now() + WAIT;
    // Admit the first actual SDK batch without advancing its service operations.
    while fixture.renderer.host_rpc.pending.len() != MAX_PER_BINDING {
        assert!(Instant::now() < deadline);
        let event = fixture.renderer.sessions[&fixture.target]
            .events
            .recv_timeout(Duration::from_millis(10));
        match event {
            Ok(event) => {
                fixture
                    .renderer
                    .handle_renderer_event(&fixture.target, event)
                    .unwrap();
            }
            Err(EventStreamError::Timeout) => {}
            Err(error) => panic!("{error}"),
        }
    }
    // Finish each real execution, retaining its delivery until the next turn.
    // No earlier delivery is polled while a later worker finishes.
    let calls = std::mem::take(&mut fixture.renderer.host_rpc.pending);
    for mut call in calls {
        loop {
            call = fixture
                .renderer
                .advance_host_call(call)
                .expect("a response must be delivered");
            if matches!(call.phase, Some(Phase::Delivering { .. })) {
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        fixture.renderer.host_rpc.pending.push(call);
    }
    // This FIFO peer response follows all four Runtime.evaluate ACKs. The client
    // reader has routed them, but the Host bridge has not reaped those records.
    let barrier = fixture
        .peer
        .request("Fixture.inspect", json!({"keys":[STATE]}));
    assert_eq!(barrier["evaluations"], 0, "{barrier}");
    assert_eq!(fixture.inspect()["continued"], true);
    assert_eq!(fixture.renderer.host_rpc.pending.len(), MAX_PER_BINDING);
    fixture.until(|fixture| fixture.inspect()["result"].is_array());
    let state = fixture.inspect();
    assert_eq!(
        state["result"],
        json!([{ "ok":true },{ "ok":true },{ "ok":true },{ "ok":true }]),
        "{state}"
    );
}

#[test]
fn sdk_task_runner_and_serial_service_calls_preserve_host_admission() {
    let mut fixture = Fixture::new();
    run_sdk_runner(&mut fixture);
    assert_eq!(fixture.inspect()["result"], json!({"ok":true}));
}

fn run_sdk_runner(fixture: &mut Fixture) {
    fixture.eval(r#"globalThis.__hostAdmissionState={result:null,step:'register'};
      (async()=>{
        const state=__hostAdmissionState, services=__hostAdmissionContext.services;
        const runner=await services.tasks.register('admission',async input=>({echo:input}));
        try {
          for(let index=0;index<8;index++){
            state.index=index;state.step='snapshot-before';await services.storage.snapshot();
            state.step='start';const task=await runner.start({input:index,operationKey:'admission-'+index,timeoutMs:10000});
            let result;
            do {
              state.step='result';result=await services.tasks.result({task:task.task});state.task=result;
              if(result.terminal && result.state!=='succeeded')throw new Error('task failed: '+JSON.stringify(result));
              if(result.state!=='succeeded')await new Promise(resolve=>setTimeout(resolve,40));
            } while(result.state!=='succeeded');
            if(result.result.echo!==index)throw new Error('wrong task result');
            state.step='snapshot-after';await services.storage.snapshot();
          }
          state.result={ok:true};
        } finally {await runner.close();}
      })().catch(error=>{__hostAdmissionState.result={code:error.code,message:error.message}});undefined"#);
    fixture.until(|fixture| fixture.inspect()["result"].is_object());
}

#[test]
fn unacknowledged_host_deliveries_retain_the_original_admission_ownership() {
    let mut fixture = Fixture::in_world("main");
    fixture.hold_delivery_acks();
    fixture.enqueue("globalThis.__hostAdmissionState={result:null};Promise.all(Array.from({length:4},()=>__hostAdmissionContext.services.storage.snapshot())).then(()=>{__hostAdmissionState.result={ok:true}});undefined");
    fixture.until(|fixture| fixture.inspect()["result"].is_object());
    assert_eq!(fixture.renderer.host_rpc.pending.len(), MAX_PER_BINDING);
    assert_eq!(
        fixture.peer.request("Fixture.inspect", json!({"keys":[]}))["evaluations"],
        MAX_PER_BINDING
    );
    let rejected = fixture.eval("__hostAdmissionContext.services.storage.snapshot().catch(error=>({code:error.code,message:error.message}))");
    assert_eq!(rejected["code"], "request_limit", "{rejected}");
    assert!(
        rejected["message"]
            .as_str()
            .unwrap()
            .contains("binding[invoking=0,core=0,delivering=4]"),
        "{rejected}"
    );
    assert_eq!(fixture.renderer.host_rpc.pending.len(), MAX_PER_BINDING);
    fixture.release_delivery_acks();
    fixture.until(|fixture| fixture.renderer.pending_host_call_count() == 0);
    assert_eq!(
        fixture.eval("__hostAdmissionContext.services.storage.snapshot()")["revision"],
        0
    );
}

fn direct_call(fixture: &mut Fixture, cancel: bool, mode: &str) {
    fixture.enqueue(&format!(r#"
      globalThis.__hostAdmissionState={{result:null,deliveries:0,controller:new AbortController()}};
      globalThis.__directBridge??=globalThis.__codletRendererV1;
      Object.defineProperty(globalThis,'__codletRendererV1',{{configurable:true,value:Object.freeze({{
        ...__directBridge,__rpcReceive(...args){{
          __hostAdmissionState.deliveries++;
          const receipt=__directBridge.__rpcReceive(...args);
          if({mode:?}==='duplicate')return __directBridge.__rpcReceive(...args);
          if({mode:?}==='unknown')return{{ok:false,error:'secret consumer payload'}};
          return receipt;
        }}
      }})}});
      __hostAdmissionContext.rpc.request({{name:'test.renderer.direct',api:1,scope:'target'}},'hold',{{cancel:{cancel}}},{{signal:__hostAdmissionState.controller.signal}})
        .then(result=>__hostAdmissionState.result={{ok:true,result}},error=>__hostAdmissionState.result={{code:error.code}});
      undefined"#));
    fixture.until(|fixture| {
        fixture.inspect()["result"].is_object() && fixture.renderer.host_rpc.direct.is_empty()
    });
}

#[test]
fn explicitly_cancelled_renderer_consumer_does_not_receive_a_terminal_reply() {
    let mut fixture = Fixture::with_direct_provider("main", true);
    direct_call(&mut fixture, true, "normal");
    fixture.until(|fixture| fixture.eval("__directProvider.completions") == 1);
    let state = fixture.inspect();
    assert_eq!(state["result"]["code"], "invocation_cancelled", "{state}");
    assert_eq!(state["deliveries"], 0, "{state}");
    assert_eq!(fixture.eval("__directProvider.calls"), 1);
    assert_eq!(fixture.eval("__directProvider.aborts"), 1);
    assert!(fixture.renderer.host_rpc.direct.is_empty());
    assert_eq!(fixture.renderer.pending_host_call_count(), 0);
    assert!(
        fixture.renderer.diagnostics.is_empty(),
        "{:?}",
        fixture.renderer.diagnostics
    );
}

#[test]
fn renderer_cancellation_requires_the_original_session_binding_and_request_id() {
    let mut fixture = Fixture::with_direct_provider("main", true);
    let session = &fixture.renderer.sessions[&fixture.target];
    let consumer = session
        .plugins
        .iter()
        .find(|plugin| plugin.id == "test.host-admission")
        .unwrap()
        .clone();
    let other = session
        .plugins
        .iter()
        .find(|plugin| plugin.id == "test.renderer.provider")
        .unwrap()
        .clone();
    let request = parse_binding_message(&json!({"v":1,"type":"request","pluginId":consumer.id,"generation":consumer.generation,"id":901,"capability":{"name":"test.renderer.direct","api":1,"scope":"target"},"method":"hold","params":null}).to_string()).unwrap();
    let scope = fixture
        .renderer
        .prepare_scoped_call(&fixture.target, &consumer, &request)
        .unwrap();
    fixture
        .renderer
        .cancel_scoped_call(&fixture.target, &consumer, 902);
    assert!(!scope.consumer_cancelled());
    fixture
        .renderer
        .cancel_scoped_call(&fixture.target, &other, 901);
    assert!(!scope.consumer_cancelled());
    let other_target = fixture
        .renderer
        .sessions
        .keys()
        .find(|target| **target != fixture.target)
        .unwrap()
        .clone();
    fixture
        .renderer
        .cancel_scoped_call(&other_target, &consumer, 901);
    assert!(!scope.consumer_cancelled());
    fixture
        .renderer
        .cancel_scoped_call(&fixture.target, &consumer, 901);
    assert!(scope.consumer_cancelled());
}

#[test]
fn renderer_replies_and_unknown_or_duplicate_rejections_remain_observable() {
    let mut fixture = Fixture::with_direct_provider("main", true);
    direct_call(&mut fixture, false, "normal");
    assert_eq!(
        fixture.inspect()["result"],
        json!({"ok":true,"result":{"received":true}})
    );
    assert_eq!(fixture.inspect()["deliveries"], 1);
    assert!(fixture.renderer.diagnostics.is_empty());
    for (mode, code) in [
        ("duplicate", "response_not_pending"),
        ("unknown", "response_rejected"),
    ] {
        direct_call(&mut fixture, false, mode);
        fixture.until(|fixture| !fixture.renderer.diagnostics.is_empty());
        let diagnostics = std::mem::take(&mut fixture.renderer.diagnostics);
        assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
        let message = &diagnostics[0].message;
        assert!(message.contains("request_id="), "{message}");
        assert!(message.contains("method=\"hold\""), "{message}");
        assert!(message.contains(code), "{message}");
        assert!(!message.contains("secret consumer payload"), "{message}");
        assert_eq!(fixture.inspect()["deliveries"], 1);
        assert_eq!(fixture.inspect()["result"]["ok"], true);
    }
    assert_eq!(fixture.eval("__directProvider.calls"), 3);
}
