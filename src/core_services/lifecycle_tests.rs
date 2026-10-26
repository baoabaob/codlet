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
        .retire(ID, fixture.principal.plugin.generation)
        .unwrap();
    assert_eq!(fixture.storage().unwrap_err().code, "stale_generation");
}

#[test]
fn cancelled_event_creation_releases_the_exact_topic_or_subscription() {
    let fixture = Fixture::new(true);
    let resources = &fixture.services.0.resources;
    let owner = &fixture.principal.resources;
    let topic = resources
        .invoke(owner, "events.createTopic", json!({"name":"cancelled"}))
        .unwrap();
    fixture
        .services
        .rollback_resource(&fixture.principal, "events.createTopic", &topic);
    assert!(
        resources
            .invoke(owner, "resources.list", json!({}))
            .unwrap()["resources"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    let topic = resources
        .invoke(owner, "events.createTopic", json!({"name":"retained"}))
        .unwrap();
    let subscription = resources
        .invoke(owner, "events.subscribe", json!({"topic":topic["topic"]}))
        .unwrap();
    fixture
        .services
        .rollback_resource(&fixture.principal, "events.subscribe", &subscription);
    let remaining = resources
        .invoke(owner, "resources.list", json!({}))
        .unwrap();
    let remaining = remaining["resources"].as_array().unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0]["id"], topic["topic"]);
}

#[test]
fn stale_service_registration_cannot_replace_a_newer_or_retired_generation() {
    let fixture = Fixture::new(true);
    let original = fixture.principal.plugin.clone();
    let mut replacement = original.clone();
    replacement.generation = 2;
    fixture.services.register(&[replacement]).unwrap();
    assert_eq!(
        fixture
            .services
            .register(std::slice::from_ref(&original))
            .unwrap_err()
            .code,
        "stale_generation"
    );
    assert_eq!(
        fixture.services.0.owners.lock().unwrap()[ID]
            .plugin
            .generation,
        2
    );
    fixture.services.retire(ID, 2).unwrap();
    assert_eq!(
        fixture.services.register(&[original]).unwrap_err().code,
        "stale_generation"
    );
    assert!(!fixture.services.0.owners.lock().unwrap().contains_key(ID));
}

#[test]
fn racing_launch_registration_and_retirement_never_republish_the_retired_owner() {
    let fixture = Fixture::new(true);
    for generation in 1..=24 {
        let mut plugin = fixture.principal.plugin.clone();
        plugin.generation = generation;
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let register = fixture.services.clone();
        let register_barrier = barrier.clone();
        let registration = std::thread::spawn(move || {
            register_barrier.wait();
            register.register(&[plugin])
        });
        let retire = fixture.services.clone();
        let retire_barrier = barrier.clone();
        let retirement = std::thread::spawn(move || {
            retire_barrier.wait();
            retire.retire(ID, generation).unwrap();
        });
        barrier.wait();
        let result = registration.join().unwrap();
        assert!(result.is_ok() || result.is_err_and(|error| error.code == "stale_generation"));
        retirement.join().unwrap();
        assert!(!fixture.services.0.owners.lock().unwrap().contains_key(ID));
    }
}

#[test]
fn retirement_publishes_pending_before_unlocking_and_never_blocks_unrelated_generation_checks() {
    let fixture = Fixture::new(true);
    let published = Arc::new(std::sync::Barrier::new(2));
    let resume = Arc::new(std::sync::Barrier::new(2));
    *fixture.services.0.retirement_pause.lock().unwrap() =
        Some((published.clone(), resume.clone()));
    let retiring = fixture.services.clone();
    let retirement = std::thread::spawn(move || retiring.retire(ID, 1));
    published.wait();
    struct ResumeOnDrop(Arc<std::sync::Barrier>);
    impl Drop for ResumeOnDrop {
        fn drop(&mut self) {
            self.0.wait();
        }
    }
    let resume = ResumeOnDrop(resume);
    assert!(!fixture.services.0.owners.lock().unwrap().contains_key(ID));
    let pending = fixture.services.0.retiring.lock().unwrap()[&(ID.into(), 1, false)].clone();

    let mut replacement = fixture.principal.plugin.clone();
    replacement.generation = 2;
    let registering = fixture.services.clone();
    let (sender, receiver) = mpsc::channel();
    let registration = std::thread::spawn(move || {
        sender.send(registering.register(&[replacement])).unwrap();
    });
    assert_eq!(
        receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .unwrap_err()
            .code,
        "cleanup_incomplete",
        "pending ownership must reject admission without waiting for slow scope cleanup"
    );
    registration.join().unwrap();
    assert_eq!(
        fixture.services.retire(ID, 3).unwrap_err().code,
        "cleanup_incomplete"
    );
    fixture.monitor_ticks();
    assert!(Arc::ptr_eq(
        &fixture.services.0.retiring.lock().unwrap()[&(ID.into(), 1, false)],
        &pending,
    ));
    assert_eq!(
        fixture
            .services
            .register(std::slice::from_ref(&fixture.principal.plugin))
            .unwrap_err()
            .code,
        "stale_generation"
    );

    drop(resume);
    retirement.join().unwrap().unwrap();
    assert!(fixture.services.0.retiring.lock().unwrap().is_empty());
    fixture.services.retry_cleanup(&pending).unwrap();
    assert!(
        fixture.services.0.retiring.lock().unwrap().is_empty(),
        "a delayed monitor snapshot must not recreate completed cleanup ownership"
    );
    let mut replacement = fixture.principal.plugin.clone();
    replacement.generation = 4;
    fixture.services.register(&[replacement]).unwrap();
    assert_eq!(
        fixture.services.0.owners.lock().unwrap()[ID]
            .plugin
            .generation,
        4
    );
    assert_eq!(
        fixture
            .services
            .register(std::slice::from_ref(&fixture.principal.plugin))
            .unwrap_err()
            .code,
        "stale_generation"
    );
}
