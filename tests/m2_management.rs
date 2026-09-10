#![cfg(windows)]
// Actual managed Host JS/OS calls, the foreground coordinator and public
// runtime.manage service; renderer lifecycle is the existing fake CDP peer.
use codlet::catalog::PluginCatalog;
use codlet::cdp::{CdpClient, TargetController, TargetSession};
use codlet::host_control::HostControl;
use codlet::host_runtime::{HostCoreServices, HostRuntime};
use codlet::js_runtime::JsRuntime;
use codlet::os_broker::OsBroker;
use codlet::plugin_control::{
    PluginControlAction as Action, PluginControlOutcome as Outcome, PluginControlReport,
};
use codlet::plugin_execution::ExecutionState;
use codlet::plugin_permissions::BrokerPolicy;
use codlet::plugins::{LocalPluginRegistration, Permission, PluginRegistry};
use codlet::renderer::RendererRuntime;
use codlet::runtime_control::{ControlBroker, ControlCompletion};
use codlet::runtime_manage::RuntimeManageService;
use codlet::windows::process::{ChildProcess, launch_with_cdp_pipes};
use serde_json::{Value, json};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tempfile::{TempDir, tempdir};

const WAIT: Duration = Duration::from_secs(12);
const PROVIDER: &str = "dev.zz.provider";
const CONSUMER: &str = "dev.aa.consumer";
const OTHER: &str = "dev.other";

struct Fixture {
    renderer: RendererRuntime,
    hosts: HostRuntime,
    os: OsBroker,
    control: HostControl,
    broker: ControlBroker,
    manage: RuntimeManageService,
    client: CdpClient,
    child: ChildProcess,
    _targets: TargetController,
    sessions: Vec<TargetSession>,
    root: TempDir,
    registry_path: PathBuf,
    finished: bool,
}

impl Fixture {
    fn new() -> Self {
        let root = tempdir().unwrap();
        let registry_path = root.path().join("registry.json");
        let mut registry = PluginRegistry::load(&registry_path).unwrap();
        registry.set_enabled("codlet-gui", false).unwrap();
        registry.set_enabled("codex.ui.adapter", false).unwrap();
        registry.save().unwrap();
        let mut renderer =
            RendererRuntime::from_catalog(PluginCatalog::load(&registry).unwrap(), registry)
                .unwrap();
        let (child, pipes) = launch_with_cdp_pipes(
            Path::new(env!("CARGO_BIN_EXE_codlet-fake-child")),
            &[OsString::from("--scenario=renderer-control")],
            true,
        )
        .unwrap();
        let (client, events) = CdpClient::spawn(pipes).unwrap();
        let (targets, sessions) = TargetController::discover(client.clone(), events, WAIT).unwrap();
        let broker = ControlBroker::new([71; 16], "7".repeat(64));
        broker.set_ready();
        let manage = RuntimeManageService::new(broker.clone());
        renderer.set_manage_service(manage.clone());
        let os = OsBroker::for_registry(registry_path.clone()).unwrap();
        let js =
            JsRuntime::from_distribution(Path::new(env!("CARGO_BIN_EXE_codlet")).parent().unwrap())
                .unwrap();
        let hosts = HostRuntime::start_with_services(
            Vec::new(),
            client.clone(),
            Some(js),
            HostCoreServices {
                os_broker: Some(os.client()),
                runtime_manage: Some(manage.clone()),
            },
        )
        .unwrap();
        renderer.set_host_capability_client(hosts.capability_client());
        for session in &sessions {
            renderer.attach(session).unwrap();
        }
        Self {
            renderer,
            hosts,
            os,
            control: HostControl::new(registry_path.clone()),
            broker,
            manage,
            client,
            child,
            _targets: targets,
            sessions,
            root,
            registry_path,
            finished: false,
        }
    }

    fn registry(&self) -> PluginRegistry {
        PluginRegistry::load(&self.registry_path).unwrap()
    }

    fn host(&self, id: &str, read: bool) -> PathBuf {
        let path = self.root.path().join(id);
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("data.txt"), "managed file contents").unwrap();
        let path = std::fs::canonicalize(path).unwrap();
        let mut grants = vec![Permission::HostProcess, Permission::CdpRaw];
        if read {
            grants.push(Permission::HostFs);
        }
        let capability = json!({"name":format!("{id}.api"),"api":1,"scope":"target"});
        std::fs::write(path.join("codlet.json"), json!({"schema":1,"id":id,"version":"1","host":{"entry":"host.js"},"permissions":grants,"provides":[capability]}).to_string()).unwrap();
        let source = format!(
            r#"
const fs=require('node:fs'), path=require('node:path');
let ctx,timer;
function record(event,fields={{}}){{fs.appendFileSync(path.join(ctx.root,'events.jsonl'),JSON.stringify({{event,generation:ctx.plugin.generation,...fields}})+'\n');}}
module.exports={{
 async activate(context){{
   ctx=context;
   const data={read} ? await ctx.core.request('host.fs.readText',{{path:path.join(ctx.root,'data.txt')}}) : null;
   ctx.rpc.provide({capability},'inspect',()=>({{ready:true}}));
   record('active',{{data}});
   timer=setInterval(()=>ctx.cdp.request('Fake.hostStillAlive').then(()=>record('ping')).catch(()=>{{}}),30);
 }},
 async deactivate(cleanup){{
   clearInterval(timer);
   try{{await cleanup.cdp.request('Fake.hostStillAlive');record('cleanup',{{allowed:true}});}}
   catch(error){{record('cleanup',{{allowed:false,code:error.code}});}}
 }}
}};
"#
        );
        std::fs::write(path.join("host.js"), source).unwrap();
        let mut registry = self.registry();
        registry
            .register_local(
                id,
                LocalPluginRegistration {
                    path: path.clone(),
                    grants,
                    broker_policy: BrokerPolicy {
                        read_roots: if read { vec![path.clone()] } else { vec![] },
                        ..Default::default()
                    },
                },
            )
            .unwrap();
        registry.set_enabled(id, false).unwrap();
        registry.save().unwrap();
        path
    }

    fn consumer(&self) {
        let path = self.root.path().join(CONSUMER);
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("codlet.json"),json!({"schema":1,"id":CONSUMER,"version":"1","renderer":{"entry":"renderer.js","world":"isolated"},"requires":[{"name":format!("{PROVIDER}.api"),"api":1,"scope":"target"}]}).to_string()).unwrap();
        std::fs::write(
            path.join("renderer.js"),
            "module.exports={activate(){},deactivate(){}};",
        )
        .unwrap();
        let mut registry = self.registry();
        registry
            .register_local(
                CONSUMER,
                LocalPluginRegistration {
                    path: std::fs::canonicalize(path).unwrap(),
                    grants: vec![],
                    broker_policy: Default::default(),
                },
            )
            .unwrap();
        registry.set_enabled(CONSUMER, false).unwrap();
        registry.save().unwrap();
    }

    fn management_host(&self, id: &str, allowed: bool) -> PathBuf {
        let path = self.root.path().join(id);
        std::fs::create_dir(&path).unwrap();
        let path = std::fs::canonicalize(path).unwrap();
        let mut grants = vec![Permission::HostProcess];
        if allowed {
            grants.push(Permission::RuntimeManage);
        }
        let capability = json!({"name":"codlet.runtime.manage","api":1,"scope":"runtime"});
        std::fs::write(
            path.join("codlet.json"),
            json!({
                "schema":1,"id":id,"version":"1","host":{"entry":"host.js"},
                "permissions":grants,"requires":[capability]
            })
            .to_string(),
        )
        .unwrap();
        let source = format!(
            r#"
const fs=require('node:fs'), path=require('node:path');
let ctx, stopped=false;
function record(event, fields={{}}){{fs.appendFileSync(path.join(ctx.root,'events.jsonl'),JSON.stringify({{event,...fields}})+'\n');}}
async function manage(){{
  const cap={capability};
  try {{
    const list=await ctx.rpc.request(cap,'list',null);
    record('listed',{{count:list.plugins.length}});
    const prepared=await ctx.rpc.request(cap,'prepare',{{action:'enable',plugin_id:'{OTHER}'}});
    const operationId=prepared.operation.operation_id;
    await ctx.rpc.request(cap,'submit',{{operationId}});
    record('submitted',{{operationId}});
    for(let count=0;count<400&&!stopped;count++){{
      const receipt=await ctx.rpc.request(cap,'operation',{{operationId}});
      if(receipt.status==='completed'){{record('completed',{{receipt}});return;}}
      await new Promise(resolve=>setTimeout(resolve,5));
    }}
  }} catch(error) {{if(!stopped)record('denied',{{code:error.code,message:error.message}});}}
}}
module.exports={{
  activate(context){{ctx=context;void manage();}},
  deactivate(){{stopped=true;}}
}};
"#
        );
        std::fs::write(path.join("host.js"), source).unwrap();
        let mut registry = self.registry();
        registry
            .register_local(
                id,
                LocalPluginRegistration {
                    path: path.clone(),
                    grants,
                    broker_policy: Default::default(),
                },
            )
            .unwrap();
        registry.set_enabled(id, false).unwrap();
        registry.save().unwrap();
        path
    }

    fn request(&mut self, action: &str, id: &str, permission: Option<Permission>) -> Value {
        let mut input = json!({"action":action,"plugin_id":id});
        if let Some(permission) = permission {
            input["permission"] = json!(permission);
        }
        let prepared = self.manage.invoke("prepare", input).unwrap();
        assert_eq!(prepared["status"], "prepared");
        let receipt = prepared["operation"]["operation_id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            self.manage
                .invoke("submit", json!({"operationId":receipt}))
                .unwrap()["status"],
            "queued"
        );
        let end = Instant::now() + WAIT;
        loop {
            self.tick();
            let result = self
                .manage
                .invoke("operation", json!({"operationId":receipt}))
                .unwrap();
            if result["status"] == "completed" {
                return result;
            }
            assert!(Instant::now() < end, "receipt did not finish: {result}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    fn applied(
        &mut self,
        action: &str,
        id: &str,
        permission: Option<Permission>,
    ) -> PluginControlReport {
        let result = self.request(action, id, permission);
        let completion: ControlCompletion =
            serde_json::from_value(result["operation"]["completion"].clone()).unwrap();
        let ControlCompletion::Report { report } = completion else {
            panic!("unexpected failure: {result}")
        };
        assert!(
            matches!(report.outcome, Outcome::Applied | Outcome::Unchanged),
            "{report:?}"
        );
        report
    }
    fn tick(&mut self) {
        self.renderer
            .set_external_observations(self.hosts.observations());
        self.renderer.pump_bindings().unwrap();
        self.control
            .poll(&mut self.renderer, &self.hosts, &self.broker);
        if !self.control.is_pending()
            && let Some(job) = self.broker.take_next()
        {
            assert!(
                self.control
                    .dispatch(job, &mut self.renderer, &self.hosts, &self.broker)
                    .is_none()
            );
        }
        self.renderer.refresh_management_list();
    }
    fn events(path: &Path) -> Vec<Value> {
        std::fs::read_to_string(path.join("events.jsonl"))
            .unwrap_or_default()
            .split_inclusive('\n')
            .filter(|line| line.ends_with('\n'))
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    fn finish(&mut self) {
        for session in &self.sessions {
            self.renderer
                .deactivate_target(session.target_id())
                .unwrap();
        }
        self.hosts.stop().unwrap();
        self.os.stop().unwrap();
        self.client
            .request("Fake.finish", Some(json!({})), None, WAIT)
            .unwrap();
        assert_eq!(self.child.wait(WAIT).unwrap(), Some(0));
        self.client.shutdown().unwrap();
        self.finished = true;
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if !self.finished {
            for session in &self.sessions {
                let _ = self.renderer.deactivate_target(session.target_id());
            }
            let _ = self.hosts.stop();
            let _ = self.os.stop();
            let _ = self
                .client
                .request("Fake.finish", Some(json!({})), None, WAIT);
            let _ = self.child.wait(Duration::from_secs(2));
            let _ = self.client.shutdown();
        }
    }
}

#[test]
fn public_revoke_retires_the_dependent_closure_without_undoing_preferences_or_unrelated_hosts() {
    let mut f = Fixture::new();
    let provider = f.host(PROVIDER, true);
    let other = f.host(OTHER, false);
    f.consumer();
    f.applied("enable", PROVIDER, None);
    f.applied("enable", CONSUMER, None);
    f.applied("enable", OTHER, None);
    assert!(Fixture::events(&provider).iter().any(
        |event| event["event"] == "active" && event["data"]["text"] == "managed file contents"
    ));
    let other_pings = Fixture::events(&other)
        .iter()
        .filter(|event| event["event"] == "ping")
        .count();
    let report = f.applied("revoke", PROVIDER, Some(Permission::HostFs));
    assert_eq!(report.action, Action::Revoke);
    assert_eq!(
        report.affected_plugin_ids,
        vec![CONSUMER.to_owned(), PROVIDER.to_owned()]
    );
    let registry = f.registry();
    assert!(registry.is_enabled(PROVIDER) && registry.is_enabled(CONSUMER));
    assert!(
        !registry.local_plugins()[PROVIDER]
            .grants
            .contains(&Permission::HostFs)
    );
    assert!(
        registry.local_plugins()[PROVIDER]
            .broker_policy
            .read_roots
            .is_empty()
    );
    assert!(f.hosts.observations().iter().any(|owner|owner.plugin.manifest.id==OTHER&&owner.state==ExecutionState::Active));
    assert!(
        f.hosts
            .observations()
            .iter()
            .filter(|owner| owner.plugin.manifest.id == PROVIDER)
            .all(|owner| matches!(owner.state, ExecutionState::Exited | ExecutionState::Failed))
    );
    assert!(
        Fixture::events(&provider)
            .iter()
            .any(|event| event["event"] == "cleanup" && event["allowed"] == true)
    );
    let list = f.manage.invoke("list", Value::Null).unwrap();
    assert!(
        list["plugins"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["id"] == PROVIDER || row["id"] == CONSUMER)
            .all(|row| row["active"] == false)
    );
    let deadline = Instant::now() + WAIT;
    while Fixture::events(&other)
        .iter()
        .filter(|event| event["event"] == "ping")
        .count()
        <= other_pings
    {
        f.tick();
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    let rejected = f.request("enable", PROVIDER, None);
    assert_eq!(rejected["operation"]["completion"]["kind"], "error");
    assert_eq!(
        Fixture::events(&provider)
            .iter()
            .filter(|event| event["event"] == "active")
            .count(),
        1
    );
    f.applied("disable", OTHER, None);
    f.finish();
}

#[test]
fn changed_idle_authorization_retires_owners_without_removing_newly_selected_scopes() {
    let mut f = Fixture::new();
    let provider = f.host(PROVIDER, true);
    f.consumer();
    f.applied("enable", PROVIDER, None);
    f.applied("enable", CONSUMER, None);
    let mut registry = f.registry();
    let mut changed = registry.local_plugins()[PROVIDER].clone();
    changed.broker_policy.read_roots.clear();
    registry.register_local(PROVIDER, changed.clone()).unwrap();
    registry.save().unwrap();
    f.control
        .reconcile_authorization(
            &mut f.renderer,
            &f.hosts,
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
    let deadline = Instant::now() + WAIT;
    while f.control.is_pending() {
        f.tick();
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(f.registry().local_plugins()[PROVIDER], changed);
    assert!(
        f.registry().local_plugins()[PROVIDER]
            .grants
            .contains(&Permission::HostFs)
    );
    assert_eq!(f.control.take_authorization_reports().len(), 1);
    assert_eq!(
        Fixture::events(&provider)
            .iter()
            .filter(|event| event["event"] == "active")
            .count(),
        1
    );
    f.finish();
}

#[test]
fn explicitly_revoked_cdp_cannot_be_reopened_through_the_cleanup_context() {
    let mut f = Fixture::new();
    let provider = f.host(PROVIDER, false);
    f.applied("enable", PROVIDER, None);
    f.applied("revoke", PROVIDER, Some(Permission::CdpRaw));
    assert!(
        Fixture::events(&provider)
            .iter()
            .any(|event| event["event"] == "cleanup" && event["allowed"] == false)
    );
    assert!(
        !f.registry().local_plugins()[PROVIDER]
            .grants
            .contains(&Permission::CdpRaw)
    );
    f.finish();
}

#[test]
fn actual_host_management_rpc_requires_its_grant_and_uses_the_shared_receipt_executor() {
    let mut f = Fixture::new();
    let other = f.host(OTHER, false);
    let denied = f.management_host("dev.manager.denied", false);
    f.applied("enable", "dev.manager.denied", None);
    let end = Instant::now() + WAIT;
    while Fixture::events(&denied).is_empty() {
        f.tick();
        assert!(Instant::now() < end);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        Fixture::events(&denied)
            .iter()
            .any(|event| event["event"] == "denied" && event["code"] == "permission_denied"),
        "{:?}",
        Fixture::events(&denied)
    );
    assert!(!f.registry().is_enabled(OTHER));
    assert!(f.broker.take_next().is_none());

    let manager = f.management_host("dev.manager.allowed", true);
    f.applied("enable", "dev.manager.allowed", None);
    let end = Instant::now() + WAIT;
    loop {
        f.tick();
        let events = Fixture::events(&manager);
        assert!(
            events.iter().all(|event| event["event"] != "denied"),
            "{events:?}"
        );
        if events.iter().any(|event| event["event"] == "completed") {
            break;
        }
        assert!(
            Instant::now() < end,
            "Host management receipt did not complete: {events:?}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let events = Fixture::events(&manager);
    assert_eq!(
        events
            .iter()
            .filter(|event| event["event"] == "submitted")
            .count(),
        1
    );
    let completed = events
        .iter()
        .find(|event| event["event"] == "completed")
        .unwrap();
    assert_eq!(
        completed["receipt"]["operation"]["completion"]["report"]["outcome"],
        "applied"
    );
    assert!(f.registry().is_enabled(OTHER));
    assert_eq!(
        Fixture::events(&other)
            .iter()
            .filter(|event| event["event"] == "active")
            .count(),
        1
    );
    f.finish();
}
