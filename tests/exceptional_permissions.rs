use codlet::local_plugins::load_local_plugin_with_registration;
use codlet::plugin_permissions::BrokerPolicy;
use codlet::plugins::{
    HostMode, LocalPluginRegistration, Permission, PluginManifest, PluginRegistry,
};
use serde_json::json;

#[test]
fn sdk_compute_needs_no_raw_permission_and_explicit_node_does_not_inherit_legacy_or_standard_grants()
 {
    let mut manifest = json!({"schema":1,"id":"test.host-mode","version":"1","host":{"entry":"host.cjs","mode":"sdk"}});
    let sdk = PluginManifest::parse(&manifest.to_string()).unwrap();
    assert_eq!(sdk.host_mode(), Some(HostMode::Sdk));
    assert!(sdk.permissions.is_empty());
    assert!(sdk.host_execution_authorized());
    manifest["host"]["mode"] = json!("node");
    for grants in [
        json!([]),
        json!(["host.process"]),
        json!([
            "host.fs",
            "host.network",
            "host.process.spawn",
            "core.storage",
            "core.clipboard.read"
        ]),
    ] {
        manifest["permissions"] = grants;
        assert!(
            PluginManifest::parse(&manifest.to_string())
                .unwrap_err()
                .to_string()
                .contains("host.raw")
        );
    }
    manifest["permissions"] = json!(["host.raw"]);
    assert!(
        PluginManifest::parse(&manifest.to_string())
            .unwrap()
            .host_execution_authorized()
    );
}

#[test]
fn old_records_preserve_raw_legacy_authority_without_silent_grant_conversion() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    std::fs::write(
        root.join("host.cjs"),
        "module.exports={activate(){},deactivate(){}};",
    )
    .unwrap();
    let mut manifest = json!({"schema":1,"id":"test.legacy","version":"1","host":{"entry":"host.cjs"},"permissions":["host.process"]});
    std::fs::write(root.join("codlet.json"), manifest.to_string()).unwrap();
    let registry_path = root.join("registry.json");
    let record = json!({"schema":2,"plugins":{},"localPlugins":{"test.legacy":{"path":root,"grants":["host.process"]}}});
    std::fs::write(&registry_path, record.to_string()).unwrap();
    let registry = PluginRegistry::load(&registry_path).unwrap();
    let registration = &registry.local_plugins()["test.legacy"];
    let loaded = load_local_plugin_with_registration("test.legacy", registration, 1).unwrap();
    assert_eq!(loaded.manifest.host_mode(), None);
    assert_eq!(registration.grants, [Permission::HostProcess]);
    assert!(registration.broker_policy.is_empty());
    assert_eq!(
        serde_json::to_value(registration).unwrap()["grants"],
        json!(["host.process"])
    );
    // Opting into the explicit new raw mode is a reviewable manifest/grant
    // transition, never an automatic upgrade of a stored legacy grant.
    manifest["host"]["mode"] = json!("node");
    manifest["permissions"] = json!(["host.raw"]);
    std::fs::write(root.join("codlet.json"), manifest.to_string()).unwrap();
    assert!(load_local_plugin_with_registration("test.legacy", registration, 2).is_err());
    manifest["host"]["mode"] = json!("sdk");
    manifest["permissions"] = json!([]);
    std::fs::write(root.join("codlet.json"), manifest.to_string()).unwrap();
    let sdk_registration = LocalPluginRegistration {
        grants: vec![],
        ..registration.clone()
    };
    assert!(load_local_plugin_with_registration("test.legacy", &sdk_registration, 2).is_ok());
}

#[test]
fn exception_metadata_distinguishes_native_dom_declaration_from_enforced_boundaries() {
    assert!(Permission::UiDom.exceptional_boundary().is_none());
    for standard in [
        Permission::HostFs,
        Permission::HostNetwork,
        Permission::CoreClipboardRead,
        Permission::CoreTasks,
    ] {
        assert!(standard.exceptional_boundary().is_none());
    }
    assert_eq!(
        Permission::UiNativeDom
            .exceptional_boundary()
            .unwrap()
            .enforcement,
        "declaration"
    );
    assert_eq!(
        Permission::UiMainWorld
            .exceptional_boundary()
            .unwrap()
            .enforcement,
        "admission"
    );
    assert_eq!(
        Permission::CdpRaw
            .exceptional_boundary()
            .unwrap()
            .enforcement,
        "broker"
    );
    assert_eq!(
        Permission::HostRaw
            .exceptional_boundary()
            .unwrap()
            .enforcement,
        "admission"
    );
    assert!(
        Permission::HostProcess
            .exceptional_boundary()
            .unwrap()
            .legacy
    );
    assert_eq!(
        Permission::HostProcessSpawn
            .exceptional_boundary()
            .unwrap()
            .boundary,
        "executable"
    );
}

#[test]
fn broad_standard_consent_can_only_combine_with_explicit_executable_selections() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().canonicalize().unwrap();
    let executable = std::env::current_exe().unwrap().canonicalize().unwrap();
    let policy = BrokerPolicy {
        client_permissions: true,
        executables: vec![executable],
        cwd_roots: vec![path],
        env_keys: vec!["CODLET_SELECTED".into()],
        ..Default::default()
    };
    policy
        .validate_grants(&[Permission::HostProcessSpawn])
        .unwrap();
    assert!(policy.validate_grants(&[Permission::HostRaw]).is_err());
    assert_eq!(policy.canonicalized().unwrap(), policy);
    let mixed = BrokerPolicy {
        network_origins: vec!["https://example.com".into()],
        ..policy
    };
    assert!(mixed.validate().is_err());
}

#[cfg(any(windows, target_os = "macos"))]
#[test]
fn sdk_broker_cannot_inherit_executable_authority_from_standard_or_raw_host_grants() {
    use codlet::os_broker::OsBroker;
    use std::time::{Duration, Instant};
    for permissions in [
        vec![Permission::HostFs, Permission::HostNetwork],
        vec![Permission::HostRaw],
        vec![Permission::HostProcessSpawn],
    ] {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        std::fs::write(
            root.join("host.cjs"),
            "module.exports={activate(){},deactivate(){}};",
        )
        .unwrap();
        std::fs::write(root.join("codlet.json"), json!({"schema":1,"id":"test.denied","version":"1","host":{"entry":"host.cjs","mode":"sdk"},"permissions":permissions}).to_string()).unwrap();
        let registration = LocalPluginRegistration {
            path: root,
            grants: permissions,
            broker_policy: BrokerPolicy {
                client_permissions: true,
                ..Default::default()
            },
        };
        let plugin = load_local_plugin_with_registration("test.denied", &registration, 1).unwrap();
        let broker = OsBroker::new().unwrap();
        let client = broker.client();
        let authority = client.authorize(&plugin).unwrap();
        let operation = client.begin_request(
            &authority,
            "host.process.run",
            json!({"executable":std::env::current_exe().unwrap(),"args":[]}),
            Instant::now() + Duration::from_secs(3),
        );
        if registration.grants.contains(&Permission::HostProcessSpawn) {
            let mut operation = operation.unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                if let Some(result) = operation.try_result() {
                    assert_eq!(result.unwrap_err().code, "policy_denied");
                    break;
                }
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(5));
            }
        } else {
            assert_eq!(operation.err().unwrap().code, "permission_denied");
        }
    }
}
