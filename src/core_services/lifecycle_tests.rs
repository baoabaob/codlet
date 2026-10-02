use super::*;
use crate::plugins::LocalPluginRegistration;

const ID: &str = "test.staged-services";

struct Fixture {
    services: SharedCoreServices,
    registry: PluginRegistry,
    principal: Principal,
    _directory: tempfile::TempDir,
}

impl Fixture {
    fn new(enabled: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("plugin");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("host.js"), "exports.activate=()=>{};").unwrap();
        let permissions = vec![
            Permission::HostProcess,
            Permission::CoreStorage,
            Permission::TrafficIntercept,
        ];
        std::fs::write(
            root.join("codlet.json"),
            json!({"schema":1,"id":ID,"version":"1","host":{"entry":"host.js"},"permissions":permissions}).to_string(),
        )
        .unwrap();
        let registration = LocalPluginRegistration {
            path: root.canonicalize().unwrap(),
            grants: permissions,
            ..Default::default()
        };
        let path = directory.path().join("registry.json");
        let mut registry = PluginRegistry::load(&path).unwrap();
        registry.register_local(ID, registration.clone()).unwrap();
        registry.set_enabled(ID, enabled).unwrap();
        registry.save().unwrap();
        let plugin =
            crate::local_plugins::load_local_plugin_with_registration(ID, &registration, 1)
                .unwrap();
        let services = SharedCoreServices::new(&path).unwrap();
        services.register(&[plugin]).unwrap();
        services.prepare_traffic().unwrap();
        let principal = services.0.owners.lock().unwrap()[ID].clone();
        Self {
            services,
            registry,
            principal,
            _directory: directory,
        }
    }

    fn storage(&self) -> Result<Value> {
        self.services
            .check(&self.principal, "storage.snapshot", true, &Value::Null)?;
        self.services
            .0
            .persistent
            .invoke_storage(&self.principal.owner, "snapshot", Value::Null)
    }

    fn traffic(&self, method: &str) -> Result<Value> {
        self.services.check(
            &self.principal,
            &format!("traffic.{method}"),
            true,
            &Value::Null,
        )?;
        self.services
            .traffic_operation(&self.principal, method, Value::Null)
    }

    fn monitor_ticks(&self) {
        // Observe the actual 500 ms lifetime monitor, not a copy of its logic.
        std::thread::sleep(Duration::from_millis(1100));
    }
}

#[test]
fn a_staged_traffic_plugin_keeps_core_services_until_enable_is_committed() {
    let mut fixture = Fixture::new(false);
    assert_eq!(fixture.storage().unwrap()["schema"], 1);
    assert_eq!(
        fixture.traffic("status").unwrap_err().code,
        "authorization_revoked"
    );

    fixture.monitor_ticks();
    assert_eq!(
        fixture.storage().unwrap()["schema"],
        1,
        "activation precedes the enable preference commit; that window must not retire the generation"
    );
    assert_eq!(
        fixture.traffic("status").unwrap_err().code,
        "authorization_revoked"
    );

    fixture.registry.set_enabled(ID, true).unwrap();
    fixture.registry.save().unwrap();
    assert_eq!(fixture.traffic("status").unwrap()["registered"], 0);

    fixture
        .registry
        .revoke_permission(ID, Permission::CoreStorage)
        .unwrap();
    fixture.registry.save().unwrap();
    fixture.monitor_ticks();
    assert_eq!(fixture.storage().unwrap_err().code, "stale_generation");
}

#[test]
fn disable_closes_traffic_before_package_cleanup_without_retiring_other_services() {
    let mut fixture = Fixture::new(true);
    let traffic = fixture.services.prepare_traffic().unwrap();
    fixture.traffic("connect").unwrap();
    assert_eq!(traffic.resources()["tickets"], 1);

    fixture.registry.set_enabled(ID, false).unwrap();
    fixture.registry.save().unwrap();
    fixture.monitor_ticks();
    assert_eq!(traffic.resources()["tickets"], 0);
    assert_eq!(
        fixture.traffic("status").unwrap_err().code,
        "authorization_revoked"
    );
    assert_eq!(fixture.storage().unwrap()["schema"], 1);

    fixture
        .services
        .retire(ID, fixture.principal.plugin.generation);
    assert_eq!(fixture.storage().unwrap_err().code, "stale_generation");
}
