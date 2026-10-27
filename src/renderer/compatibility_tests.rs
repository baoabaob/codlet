//! Real Core catalog and public managed Host/renderer transports. The peer has
//! no Native object graph; positive owner publications are explicitly controlled.
use super::*;
use crate::cdp::{TargetController, VmPeer};
use crate::host_runtime::{HostCoreServices, HostRuntime};
use crate::plugin_execution::ExecutionState;
use crate::plugins::{LocalPluginRegistration, Permission};
use crate::runtime_control::ControlBroker;
use crate::runtime_manage::RuntimeManageService;
use tempfile::{TempDir, tempdir};

const ID: &str = "test.compatibility-read";
const MANAGE: &str = "codlet.runtime.manage";

struct Fixture {
    renderer: RendererRuntime,
    hosts: HostRuntime,
    peer: VmPeer,
    target: String,
    context: u64,
    service: RuntimeManageService,
    _directory: TempDir,
}

impl Fixture {
    fn new(too_new: bool) -> Self {
        let directory = tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let registry_path = root.join("config.json");
        let manage = json!({"name":MANAGE,"api":1,"scope":"runtime"});
        let host = json!({"name":ID,"api":1,"scope":"runtime"});
        std::fs::write(root.join("codlet.json"),json!({"schema":1,"id":ID,"version":"1","renderer":{"entry":"renderer.js","world":"isolated"},"host":{"entry":"host.js","provides":[host],"requires":[manage]},"requires":[manage,host],"permissions":["host.process","runtime.manage"]}).to_string()).unwrap();
        std::fs::write(root.join("renderer.js"),"exports.activate=context=>{globalThis.__compatibilityContext=context};exports.deactivate=()=>{delete globalThis.__compatibilityContext};").unwrap();
        std::fs::write(root.join("host.js"),format!("exports.activate=async context=>{{const initial=await context.rpc.request({manage},'versionStatus',null);context.rpc.provide({host},'status',params=>params?.initial?initial:context.rpc.request({manage},'versionStatus',null));}};exports.deactivate=()=>{{}};")).unwrap();
        let mut registry = PluginRegistry::load(&registry_path).unwrap();
        registry
            .register_local(
                ID,
                LocalPluginRegistration {
                    path: root.clone(),
                    grants: vec![Permission::HostProcess, Permission::RuntimeManage],
                    broker_policy: Default::default(),
                },
            )
            .unwrap();
        registry.save().unwrap();
        if too_new {
            let mut catalog: Value = serde_json::from_str(include_str!(
                "../../compatibility/tested-client-versions.json"
            ))
            .unwrap();
            catalog["revision"] = json!(catalog["revision"].as_u64().unwrap() + 1);
            let record = catalog["records"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|record| {
                    record["platform"] == "windows-x86_64"
                        && record["clientVersion"] == "26.1021.3705.0"
                })
                .unwrap();
            record["requiredAdapters"]["codex.desktop.adapter"] = json!("0.2.21");
            record["verifiedWith"][0]["adapters"]["codex.desktop.adapter"] = json!("0.2.21");
            let mut cache = registry_path.as_os_str().to_owned();
            cache.push(".compatibility-cache.json");
            std::fs::write(std::path::PathBuf::from(cache),json!({"schema":1,"sourceUrl":"https://raw.githubusercontent.com/baoabaob/codlet/main/compatibility/tested-client-versions.json","checkedAtUnixMs":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64,"etag":null,"catalog":catalog}).to_string()).unwrap();
        }
        let broker = ControlBroker::new([82; 16], "compatibility-vm".into());
        broker.set_ready();
        let service = RuntimeManageService::new(broker).with_local_management(registry_path, false);
        service.observe_client_version("26.1021.3705.0");
        let catalog = PluginCatalog::load_core_for_test(&registry).unwrap();
        let loaded = catalog.enabled_plugins(&registry).unwrap();
        let mut renderer = RendererRuntime::from_catalog(catalog, registry).unwrap();
        renderer.set_manage_service(service.clone());
        let (peer, events) = VmPeer::start();
        let hosts = HostRuntime::start_with_services(
            loaded,
            peer.client.clone(),
            Some(peer.runtime.clone()),
            HostCoreServices {
                runtime_manage: Some(service.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(12);
        while hosts.is_starting() {
            assert!(Instant::now() < deadline, "{:?}", hosts.observations());
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(
            hosts
                .observations()
                .iter()
                .all(|observation| observation.state == ExecutionState::Active),
            "{:?}",
            hosts.observations()
        );
        renderer.set_host_capability_client(hosts.capability_client());
        renderer.set_external_observations(hosts.observations());
        let (_controller, sessions) =
            TargetController::discover(peer.client.clone(), events, Duration::from_secs(5))
                .unwrap();
        let reports = renderer.attach_all(&sessions);
        assert!(
            reports.iter().all(|(_, result)| result.is_ok()),
            "{reports:?}"
        );
        renderer.refresh_management_list();
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
                    .any(|plugin| plugin["id"] == ID)
            })
            .unwrap();
        let fixture = Self {
            target: realm["targetId"].as_str().unwrap().into(),
            context: realm["id"].as_u64().unwrap(),
            renderer,
            hosts,
            peer,
            service,
            _directory: directory,
        };
        // The VM peer correctly cannot activate Native providers. Exercise the
        // positive read model using their real catalog metadata and an explicit
        // owner observation, without claiming Native capability availability.
        let available = fixture
            .renderer
            .catalog
            .entries()
            .iter()
            .filter(|entry| fixture.renderer.catalog.is_core(&entry.id))
            .map(|entry| entry.id.clone())
            .collect();
        fixture.service.publish_list(super::listing::plugin_list(
            &fixture.renderer.catalog,
            &fixture.renderer.plugins,
            &fixture.renderer.plugin_registry,
            &available,
            &fixture.hosts.observations(),
        ));
        fixture
    }

    fn call(&mut self, host: bool, initial: bool) -> Value {
        let (name, method, params) = if host {
            (ID, "status", json!({"initial":initial}))
        } else {
            (MANAGE, "versionStatus", Value::Null)
        };
        let expression = format!(
            "__compatibilityContext.rpc.request({}, {}, {})",
            json!({"name":name,"api":1,"scope":"runtime"}),
            json!(method),
            params
        );
        let result = self
            .renderer
            .evaluate_with_binding_pump(&self.target, &expression, self.context)
            .unwrap();
        assert!(result.get("exceptionDetails").is_none(), "{result}");
        result.pointer("/result/value").unwrap().clone()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        for target in self.renderer.sessions.keys().cloned().collect::<Vec<_>>() {
            let _ = self.renderer.deactivate_target(&target);
        }
        let _ = self.hosts.stop();
        self.service.stop_client_version_checks();
        self.peer.close();
    }
}

#[test]
fn public_host_and_renderer_status_use_core_catalog_owner_publications_and_reject_unavailable_targets()
 {
    let mut fixture = Fixture::new(false);
    let initial = fixture.call(true, true);
    assert_eq!(initial["clientStatus"]["status"], "requirements-unmet");
    assert!(
        initial["clientStatus"]["missingRequirements"]
            .as_array()
            .unwrap()
            .iter()
            .all(|missing| missing["active"] == false && missing["currentVersion"].is_string())
    );
    let host = fixture.call(true, false);
    let renderer = fixture.call(false, false);
    assert_eq!(host["clientStatus"], renderer["clientStatus"]);
    assert_eq!(host["clientStatus"]["status"], "matched", "{host}");
    let list = fixture.service.invoke("list", Value::Null).unwrap();
    assert!(
        list["plugins"]
            .as_array()
            .unwrap()
            .iter()
            .all(|plugin| !crate::codex::is_internal_id(plugin["id"].as_str().unwrap()))
    );
    for provider in list["coreProviders"].as_array().unwrap() {
        assert_eq!(provider["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(provider["available"], true);
        assert_ne!(provider["compatibilityVersion"], provider["version"]);
    }
    fixture
        .renderer
        .deactivate_plugin(&fixture.target, crate::codex::UI_PROVIDER_ID)
        .unwrap();
    fixture.renderer.refresh_management_list();
    let host = fixture.call(true, false);
    let renderer = fixture.call(false, false);
    assert_eq!(host["clientStatus"], renderer["clientStatus"]);
    let missing = &host["clientStatus"]["missingRequirements"];
    assert_eq!(missing.as_array().unwrap().len(), 2, "{host}");
    let ui = missing
        .as_array()
        .unwrap()
        .iter()
        .find(|missing| missing["id"] == crate::codex::UI_PROVIDER_ID)
        .unwrap();
    assert_eq!(ui["currentVersion"], "0.1.17");
    assert_eq!(ui["active"], false);
}

#[test]
fn public_status_preserves_insufficient_core_implementation_version() {
    let mut fixture = Fixture::new(true);
    for host in [true, false] {
        let value = fixture.call(host, false);
        assert_eq!(
            value["clientStatus"]["status"], "requirements-unmet",
            "{value}"
        );
        let missing = &value["clientStatus"]["missingRequirements"];
        assert_eq!(missing.as_array().unwrap().len(), 1, "{value}");
        assert_eq!(missing[0]["id"], crate::codex::DESKTOP_PROVIDER_ID);
        assert_eq!(missing[0]["currentVersion"], "0.2.20");
        assert_eq!(missing[0]["minimumVersion"], "0.2.21");
        assert_eq!(missing[0]["active"], true);
    }
}
