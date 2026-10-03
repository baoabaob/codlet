//! Real scoped Host receipts with an owned Node main-process transport fixture.
//! No installed client, sandbox setup, model request or daily registry is used.
use super::*;
use crate::catalog::PluginCatalog;
use crate::cdp::CdpClient;
use crate::host_control::HostControl;
use crate::host_runtime::HostRuntime;
use crate::plugin_control::{
    PluginControlAction as Action, PluginControlOutcome as Outcome, PluginControlReport,
    PluginControlRequest,
};
use crate::plugins::{LocalPluginRegistration, Permission, PluginRegistry};
use crate::renderer::RendererRuntime;
use crate::runtime_control::{ControlBroker, ControlCompletion, ControlRequest, ControlStatus};
use crate::windows::process::{ChildProcess, launch_with_cdp_pipes};
use std::collections::BTreeSet;
use std::ffi::OsString;

const SOURCE: &str = "dev.fixture.source";
const DEPENDENT: &str = "dev.fixture.dependent";
const WAIT: Duration = Duration::from_secs(15);

fn source_host(revision: &str, fail: bool) -> String {
    let code = format!(
        r#"module.exports={{installElectronTraffic(){{
        {}
        return {{ready:async()=>({{installed:true,activatedSources:[{{id:'fixture-main',operations:['http.intercept'],protocols:['http'],coverage:[{}]}}],unsupportedSources:[]}}),close(){{}}}};
    }}}};"#,
        if fail {
            "throw Object.assign(Error(),{code:'fixture_activation_failed'});"
        } else {
            ""
        },
        serde_json::to_string(revision).unwrap()
    );
    host_for_code(&code)
}
fn host_for_code(code: &str) -> String {
    format!(
        r#"module.exports={{
      prepareClientLaunch:()=>({{arguments:['--inspect-brk=127.0.0.1:0']}}),
      attachClientLaunch:()=>({{}}),
      clientSource:()=>({{code:{}}}),
      activate(ctx){{ctx.rpc.provide({{name:'dev.fixture.desktop',api:1,scope:'runtime'}},'inspect',()=>({{ready:true}}));}},
      deactivate(){{}}
    }};"#,
        serde_json::to_string(code).unwrap()
    )
}

struct Fixture {
    hosts: HostRuntime,
    control: HostControl,
    broker: ControlBroker,
    renderer: RendererRuntime,
    source: ClientSourceRuntime,
    peer: OwnedPluginProcess,
    client: CdpClient,
    child: ChildProcess,
    _services: crate::core_services::SharedCoreServices,
    directory: tempfile::TempDir,
    registry: PathBuf,
}
impl Fixture {
    fn new(suspended: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let registry_path = directory.path().join("state/config.json");
        let mut registry = PluginRegistry::load(&registry_path).unwrap();
        for id in ["codlet-gui", "codex.ui.adapter"] {
            registry.set_enabled(id, false).unwrap();
        }
        for id in [SOURCE, DEPENDENT] {
            let root = directory.path().join(id);
            std::fs::create_dir(&root).unwrap();
            let declaration = if id == SOURCE {
                json!({"schema":1,"id":id,"version":"1","host":{"entry":"host.cjs"},"permissions":["host.process","cdp.raw"],"provides":[{"name":"codlet.client.launch","api":1,"scope":"runtime"},{"name":"dev.fixture.desktop","api":1,"scope":"runtime"}]})
            } else {
                json!({"schema":1,"id":id,"version":"1","host":{"entry":"host.cjs"},"permissions":["host.process","cdp.raw"],"requires":[{"name":"dev.fixture.desktop","api":1,"scope":"runtime"}]})
            };
            std::fs::write(root.join("codlet.json"), declaration.to_string()).unwrap();
            std::fs::write(
                root.join("host.cjs"),
                if id == SOURCE {
                    source_host("fixture-one", false)
                } else {
                    "module.exports={activate(){},deactivate(){}};".into()
                },
            )
            .unwrap();
            registry
                .register_local(
                    id,
                    LocalPluginRegistration {
                        path: root.canonicalize().unwrap(),
                        grants: vec![Permission::HostProcess, Permission::CdpRaw],
                        ..Default::default()
                    },
                )
                .unwrap();
            registry.set_enabled(id, suspended).unwrap();
        }
        registry.save().unwrap();
        let mut catalog = PluginCatalog::load(&registry).unwrap();
        if suspended {
            catalog.suspend_startup(
                &BTreeSet::from([SOURCE.into(), DEPENDENT.into()]),
                "client_source_build_unverified",
            );
        }
        let mut renderer = RendererRuntime::from_catalog(catalog, registry).unwrap();
        let distribution = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_owned();
        let runtime = JsRuntime::from_distribution(&distribution).unwrap();
        let (child, pipes) = launch_with_cdp_pipes(
            &distribution.join("codlet-fake-child.exe"),
            &[OsString::from("--scenario=raw-host-cdp")],
            true,
        )
        .unwrap();
        let (client, events) = CdpClient::spawn(pipes).unwrap();
        drop(events);
        let hosts =
            HostRuntime::start_with_runtime(Vec::new(), client.clone(), Some(runtime.clone()))
                .unwrap();
        renderer.set_host_capability_client(hosts.capability_client());

        std::fs::write(
            directory.path().join("bridge.cjs"),
            include_str!("../../runtime/client-bridge-bundle.cjs"),
        )
        .unwrap();
        let peer_file = directory.path().join("peer.cjs");
        std::fs::write(&peer_file, r#"
          process.type='browser';let ready=false;
          const bridge=require('./bridge.cjs').startClientBridge({app:{isReady:()=>ready,getAppPath:()=>__dirname}},{token:'a'.repeat(48)});
          ready=true;bridge.endpoint().then(endpoint=>process.stdout.write(JSON.stringify(endpoint)+'\n'));
        "#).unwrap();
        let (peer, stdio) = OwnedPluginProcess::spawn(
            runtime.executable_path(),
            &[peer_file.to_string_lossy().into_owned()],
            directory.path(),
            None,
        )
        .unwrap();
        let mut data = Vec::new();
        let mut buffer = [0; 4096];
        let until = Instant::now() + WAIT;
        while data.last() != Some(&b'\n') {
            let count = stdio.stdout.read_some(&mut buffer, Some(until)).unwrap();
            assert!(count > 0 && data.len() + count < 65536);
            data.extend_from_slice(&buffer[..count]);
        }
        let endpoint: Endpoint = serde_json::from_slice(&data).unwrap();
        endpoint
            .validate(peer.pid(), runtime.executable_path())
            .unwrap();
        let services = crate::core_services::SharedCoreServices::new(&registry_path).unwrap();
        let source = ClientSourceRuntime::new(
            endpoint,
            runtime,
            registry_path.clone(),
            json!({"source":{"operations":["http.intercept"],"protocols":["http"]}}),
            None,
            services.prepare_traffic().unwrap(),
        )
        .unwrap();
        renderer.set_client_source(Some(source.clone()));
        let broker = ControlBroker::new([31; 16], "f".repeat(64));
        broker.set_ready();
        Self {
            hosts,
            control: HostControl::new(registry_path.clone()),
            broker,
            renderer,
            source,
            peer,
            client,
            child,
            _services: services,
            directory,
            registry: registry_path,
        }
    }
    fn rewrite(&self, revision: &str, fail: bool) {
        std::fs::write(
            self.directory.path().join(SOURCE).join("host.cjs"),
            source_host(revision, fail),
        )
        .unwrap();
    }
    fn inspect(&self) -> Value {
        self.source.request(json!({"op":"status"})).unwrap()
    }
    fn command(&mut self, action: Action, permission: Option<Permission>) -> PluginControlReport {
        let prepared = self
            .broker
            .handle(ControlRequest::prepare(PluginControlRequest {
                action,
                plugin_id: SOURCE.into(),
                permission,
                cascade: action == Action::Disable,
                remove_source: None,
                local_import: None,
            }));
        assert_eq!(prepared.status, ControlStatus::Prepared);
        let receipt = prepared.operation_id().unwrap().to_owned();
        assert_eq!(
            self.broker.handle(ControlRequest::submit(&receipt)).status,
            ControlStatus::Queued
        );
        let until = Instant::now() + WAIT;
        loop {
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
            let result = self.broker.handle(ControlRequest::result(&receipt));
            if result.status == ControlStatus::Completed {
                return match result.operation.unwrap().completion.unwrap() {
                    ControlCompletion::Report { report } => report,
                    ControlCompletion::Error { error } => panic!("receipt failed: {error:?}"),
                };
            }
            assert!(
                Instant::now() < until,
                "pending lifecycle: {:?}",
                self.hosts.observations()
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.hosts.stop();
        let _ = self.client.shutdown();
        let _ = self.child.wait(WAIT);
        let _ = self.peer.terminate();
        let _ = self.peer.wait(Duration::from_secs(2));
    }
}

#[test]
fn main_entry_follows_enable_reload_rollback_disable_and_permission_revocation_receipts() {
    let mut f = Fixture::new(false);
    let pid = f.peer.pid();
    assert_eq!(f.command(Action::Enable, None).outcome, Outcome::Applied);
    assert_eq!(f.inspect()["owner"], SOURCE);
    f.rewrite("fixture-two", false);
    assert_eq!(f.command(Action::Reload, None).outcome, Outcome::Applied);
    assert_eq!(
        f.inspect()["activation"]["activatedSources"][0]["coverage"],
        json!(["fixture-two"])
    );
    f.rewrite("fixture-broken", true);
    let failed = f.command(Action::Reload, None);
    assert_eq!(failed.outcome, Outcome::RolledBack, "{failed:?}");
    assert_eq!(
        f.inspect()["activation"]["activatedSources"][0]["coverage"],
        json!(["fixture-two"])
    );
    assert_eq!(f.command(Action::Disable, None).outcome, Outcome::Applied);
    assert!(f.inspect()["owner"].is_null());
    f.rewrite("fixture-three", false);
    assert_eq!(f.command(Action::Enable, None).outcome, Outcome::Applied);
    assert_eq!(
        f.command(Action::Revoke, Some(Permission::CdpRaw)).outcome,
        Outcome::Applied
    );
    assert!(f.inspect()["owner"].is_null());
    assert_eq!(f.inspect()["pid"], pid);
    assert!(
        !PluginRegistry::load(&f.registry).unwrap().local_plugins()[SOURCE]
            .grants
            .contains(&Permission::CdpRaw)
    );
}

#[test]
fn a_degraded_startup_recovers_the_source_and_dependent_closure_in_the_same_client() {
    let mut f = Fixture::new(true);
    let before = std::fs::read(&f.registry).unwrap();
    let pid = f.peer.pid();
    assert!(f.renderer.logical_plugins().is_empty());
    let report = f.command(Action::Reload, None);
    assert_eq!(report.outcome, Outcome::Applied, "{report:?}");
    assert_eq!(
        report.affected_plugin_ids,
        BTreeSet::from([SOURCE.to_owned(), DEPENDENT.to_owned()])
            .into_iter()
            .collect::<Vec<_>>()
    );
    assert_eq!(f.renderer.logical_plugins().len(), 2);
    assert!(!f.renderer.startup_suspended(SOURCE));
    assert!(!f.renderer.startup_suspended(DEPENDENT));
    assert_eq!(std::fs::read(&f.registry).unwrap(), before);
    assert_eq!(f.inspect()["pid"], pid);
}

#[test]
fn authority_changed_during_activation_retires_the_main_entry_and_preserves_the_bridge() {
    let f = Fixture::new(false);
    let code = format!(
        r#"module.exports={{installElectronTraffic(){{
      const fs=require('node:fs'),file={};const registry=JSON.parse(fs.readFileSync(file,'utf8'));
      registry.localPlugins[{}].grants=registry.localPlugins[{}].grants.filter(grant=>grant!=='cdp.raw');
      fs.writeFileSync(file,JSON.stringify(registry));
      return {{ready:async()=>({{installed:true,activatedSources:[{{id:'fixture-main',operations:['http.intercept'],protocols:['http'],coverage:['fixture-revoked']}}],unsupportedSources:[]}}),close(){{}}}};
    }}}};"#,
        serde_json::to_string(&f.registry).unwrap(),
        serde_json::to_string(SOURCE).unwrap(),
        serde_json::to_string(SOURCE).unwrap()
    );
    let root = f.directory.path().join(SOURCE);
    std::fs::write(root.join("host.cjs"), host_for_code(&code)).unwrap();
    let registry = PluginRegistry::load(&f.registry).unwrap();
    let provider = crate::local_plugins::load_local_plugin_with_registration(
        SOURCE,
        &registry.local_plugins()[SOURCE],
        1,
    )
    .unwrap();
    assert_eq!(
        f.source.replace(Some(&provider)).unwrap_err().code,
        "client_launch_authorization_revoked"
    );
    assert!(f.inspect()["owner"].is_null());
    assert_eq!(f.inspect()["pid"], f.peer.pid());
    assert_eq!(f.inspect()["activation"]["installed"], false);
}
