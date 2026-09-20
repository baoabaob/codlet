use std::fs;
use std::path::PathBuf;

use codlet::plugin_permissions::{BrokerPolicy, normalize_origin};
use codlet::plugins::{LocalPluginRegistration, Permission, PluginRegistry};
use serde_json::json;
use tempfile::tempdir;

#[test]
fn policy_normalization_is_explicit_and_rejects_ambiguous_or_unbounded_authority() {
    assert_eq!(
        normalize_origin("HTTPS://EXAMPLE.COM:443/").unwrap(),
        "https://example.com"
    );
    for value in [
        "file:///tmp/x",
        "https://user:pass@example.com",
        "https://example.com/path",
        "https://example.com?query=1",
        "https://example.com#hash",
        "*",
    ] {
        assert!(normalize_origin(value).is_err(), "{value}");
    }
    let directory = tempdir().unwrap();
    let canonical = directory.path().canonicalize().unwrap();
    let policy = BrokerPolicy::from_explicit_inputs(
        std::slice::from_ref(&canonical),
        &["http://127.0.0.1:8765/".into()],
        &[],
    )
    .unwrap();
    assert_eq!(
        policy.read_roots.as_slice(),
        std::slice::from_ref(&canonical)
    );
    assert_eq!(policy.network_origins, ["http://127.0.0.1:8765"]);
    assert!(policy.validate_grants(&[Permission::HostFs]).is_err());
    policy
        .validate_grants(&[Permission::HostFs, Permission::HostNetwork])
        .unwrap();
    assert!(
        BrokerPolicy {
            read_roots: vec![canonical.clone(), canonical],
            ..Default::default()
        }
        .validate()
        .is_err()
    );
    assert!(
        BrokerPolicy {
            read_roots: vec![PathBuf::from("relative")],
            ..Default::default()
        }
        .validate()
        .is_err()
    );
}

#[test]
fn policy_is_one_atomic_registration_record_and_scope_revocation_preserves_other_grants() {
    let directory = tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let path = root.join("registry.json");
    let original = LocalPluginRegistration {
        path: root.clone(),
        grants: vec![
            Permission::HostProcess,
            Permission::HostFs,
            Permission::HostNetwork,
        ],
        broker_policy: BrokerPolicy {
            read_roots: vec![root.clone()],
            network_origins: vec!["https://example.com".into()],
            executables: vec![],
            ..Default::default()
        },
    };
    let mut registry = PluginRegistry::load(&path).unwrap();
    registry
        .register_local("dev.policy", original.clone())
        .unwrap();
    registry.save().unwrap();
    let document: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(document["schema"], 2);
    assert_eq!(
        document["localPlugins"]["dev.policy"]["brokerPolicy"]["networkOrigins"],
        json!(["https://example.com"])
    );
    let mut stale = PluginRegistry::load(&path).unwrap();
    let mut competing = PluginRegistry::load(&path).unwrap();
    stale
        .revoke_permission("dev.policy", Permission::HostFs)
        .unwrap();
    let mut changed = original.clone();
    changed.broker_policy.network_origins = vec!["https://other.example".into()];
    competing
        .register_local("dev.policy", changed.clone())
        .unwrap();
    competing.save().unwrap();
    assert!(
        stale
            .save()
            .unwrap_err()
            .to_string()
            .contains("broker policy changed")
    );
    assert_eq!(
        PluginRegistry::load(&path).unwrap().local_plugins()["dev.policy"],
        changed
    );
    let mut current = PluginRegistry::load(&path).unwrap();
    current
        .revoke_permission("dev.policy", Permission::HostFs)
        .unwrap();
    current.save().unwrap();
    let saved = &current.local_plugins()["dev.policy"];
    assert!(!saved.grants.contains(&Permission::HostFs));
    assert!(saved.broker_policy.read_roots.is_empty());
    assert_eq!(
        saved.broker_policy.network_origins,
        ["https://other.example"]
    );
    assert!(saved.grants.contains(&Permission::HostProcess));
}

#[test]
fn old_schema_two_registration_omits_policy_and_invalid_scope_records_do_not_load() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("registry.json");
    let root = directory.path().canonicalize().unwrap();
    let old = json!({"schema":2,"plugins":{},"localPlugins":{"dev.legacy":{"path":root,"grants":["host.process"]}}});
    fs::write(&path, old.to_string()).unwrap();
    let registry = PluginRegistry::load(&path).unwrap();
    assert!(
        registry.local_plugins()["dev.legacy"]
            .broker_policy
            .is_empty()
    );
    assert!(
        serde_json::to_value(&registry.local_plugins()["dev.legacy"])
            .unwrap()
            .get("brokerPolicy")
            .is_none()
    );
    let mut invalid = old;
    invalid["localPlugins"]["dev.legacy"]["brokerPolicy"] = json!({"readRoots":[root]});
    fs::write(&path, invalid.to_string()).unwrap();
    assert!(PluginRegistry::load(&path).is_err());
    invalid["localPlugins"]["dev.legacy"]["grants"] = json!(["host.process", "host.network"]);
    invalid["localPlugins"]["dev.legacy"]["brokerPolicy"] =
        json!({"networkOrigins":["https://example.com/"]});
    fs::write(&path, invalid.to_string()).unwrap();
    assert!(PluginRegistry::load(&path).is_err());
}
