#![cfg(any(windows, target_os = "macos"))]

use std::fs;
use std::path::{Path, PathBuf};

use codlet::plugin_permissions::BrokerPolicy;
use codlet::plugins::{LocalPluginRegistration, Permission, PluginRegistry};
use serde_json::{Value, json};
use tempfile::tempdir;

struct Scopes {
    root: tempfile::TempDir,
    plugin: PathBuf,
    read: PathBuf,
    write: PathBuf,
    watch: PathBuf,
    cwd: PathBuf,
    executable: PathBuf,
}

impl Scopes {
    fn new() -> Self {
        let root = tempdir().unwrap();
        for name in ["plugin", "read", "write", "watch", "cwd"] {
            fs::create_dir(root.path().join(name)).unwrap();
        }
        Self {
            plugin: canonical(root.path().join("plugin")),
            read: canonical(root.path().join("read")),
            write: canonical(root.path().join("write")),
            watch: canonical(root.path().join("watch")),
            cwd: canonical(root.path().join("cwd")),
            executable: canonical(std::env::current_exe().unwrap()),
            root,
        }
    }

    fn full_policy(&self) -> BrokerPolicy {
        BrokerPolicy {
            read_roots: vec![self.read.clone()],
            network_origins: vec!["HTTPS://EXAMPLE.COM:443/".into()],
            executables: vec![self.executable.clone()],
            write_roots: vec![self.write.clone()],
            watch_roots: vec![self.watch.clone()],
            cwd_roots: vec![self.cwd.clone()],
            env_keys: vec!["CODELET_FIXTURE".into()],
            shortcuts: vec!["Ctrl+Shift+9".into()],
        }
    }
}

fn canonical(path: impl AsRef<Path>) -> PathBuf {
    path.as_ref().canonicalize().unwrap()
}

fn full_grants() -> Vec<Permission> {
    vec![
        Permission::HostFs,
        Permission::HostNetwork,
        Permission::HostProcessSpawn,
        Permission::HostFsWrite,
        Permission::HostFsWatch,
        Permission::CoreShortcuts,
    ]
}

#[test]
fn every_new_scope_is_canonicalized_and_uses_the_single_broker_policy_wire_shape() {
    let scopes = Scopes::new();
    let policy = scopes.full_policy().canonicalized().unwrap();
    policy.validate_grants(&full_grants()).unwrap();
    assert_eq!(policy.read_roots, std::slice::from_ref(&scopes.read));
    assert_eq!(policy.write_roots, std::slice::from_ref(&scopes.write));
    assert_eq!(policy.watch_roots, std::slice::from_ref(&scopes.watch));
    assert_eq!(policy.cwd_roots, std::slice::from_ref(&scopes.cwd));
    assert_eq!(policy.executables, std::slice::from_ref(&scopes.executable));
    assert_eq!(policy.network_origins, ["https://example.com"]);

    let registration = LocalPluginRegistration {
        path: scopes.plugin.clone(),
        grants: full_grants(),
        broker_policy: policy.clone(),
    };
    let registration_json = serde_json::to_value(&registration).unwrap();
    let policy_json = serde_json::to_value(&policy).unwrap();
    assert_eq!(registration_json["brokerPolicy"], policy_json);
    assert_eq!(
        policy_json,
        json!({
            "readRoots": [scopes.read],
            "networkOrigins": ["https://example.com"],
            "executables": [scopes.executable],
            "writeRoots": [scopes.write],
            "watchRoots": [scopes.watch],
            "cwdRoots": [scopes.cwd],
            "envKeys": ["CODELET_FIXTURE"],
            "shortcuts": ["Ctrl+Shift+9"]
        })
    );
    assert_eq!(
        serde_json::from_value::<BrokerPolicy>(policy_json).unwrap(),
        policy
    );

    let mut unknown = registration_json["brokerPolicy"].clone();
    unknown["guiMirrorScope"] = json!([scopes.root.path()]);
    assert!(serde_json::from_value::<BrokerPolicy>(unknown).is_err());
}

#[test]
fn legacy_read_and_process_grants_do_not_imply_write_or_spawn_scopes() {
    let scopes = Scopes::new();
    let write = BrokerPolicy {
        write_roots: vec![scopes.write.clone()],
        ..Default::default()
    };
    assert!(write.validate_grants(&[Permission::HostFs]).is_err());
    write.validate_grants(&[Permission::HostFsWrite]).unwrap();

    let spawn = BrokerPolicy {
        executables: vec![scopes.executable.clone()],
        cwd_roots: vec![scopes.cwd.clone()],
        env_keys: vec!["CODELET_FIXTURE".into()],
        ..Default::default()
    };
    assert!(spawn.validate_grants(&[Permission::HostProcess]).is_err());
    spawn
        .validate_grants(&[Permission::HostProcessSpawn])
        .unwrap();

    let executable_only = BrokerPolicy {
        executables: vec![scopes.executable],
        ..Default::default()
    };
    executable_only
        .validate_grants(&[Permission::HostProcessSpawn])
        .unwrap();
    executable_only
        .validate_grants(&[Permission::HostProcess])
        .unwrap();
}

#[test]
fn revoking_each_permission_removes_only_the_scopes_owned_by_that_grant() {
    let scopes = Scopes::new();
    let registry_path = scopes.root.path().join("registry.json");
    let mut registry = PluginRegistry::load(&registry_path).unwrap();
    let mut grants = full_grants();
    grants.push(Permission::HostProcess);
    registry
        .register_local(
            "dev.core-service-permissions",
            LocalPluginRegistration {
                path: scopes.plugin.clone(),
                grants,
                broker_policy: scopes.full_policy().canonicalized().unwrap(),
            },
        )
        .unwrap();
    registry.save().unwrap();

    let mut registry = PluginRegistry::load(&registry_path).unwrap();
    registry
        .revoke_permission("dev.core-service-permissions", Permission::HostFs)
        .unwrap();
    registry.save().unwrap();
    let current = &registry.local_plugins()["dev.core-service-permissions"];
    assert!(current.broker_policy.read_roots.is_empty());
    assert_eq!(
        current.broker_policy.write_roots,
        std::slice::from_ref(&scopes.write)
    );

    registry
        .revoke_permission("dev.core-service-permissions", Permission::HostProcessSpawn)
        .unwrap();
    registry.save().unwrap();
    let current = &registry.local_plugins()["dev.core-service-permissions"];
    assert!(current.broker_policy.cwd_roots.is_empty());
    assert!(current.broker_policy.env_keys.is_empty());
    assert_eq!(
        current.broker_policy.executables,
        std::slice::from_ref(&scopes.executable)
    );
    assert!(current.grants.contains(&Permission::HostProcess));

    registry
        .revoke_permission("dev.core-service-permissions", Permission::HostProcess)
        .unwrap();
    registry
        .revoke_permission("dev.core-service-permissions", Permission::HostFsWrite)
        .unwrap();
    registry.save().unwrap();
    let current = &registry.local_plugins()["dev.core-service-permissions"];
    assert!(current.broker_policy.executables.is_empty());
    assert!(current.broker_policy.write_roots.is_empty());
    assert_eq!(
        current.broker_policy.watch_roots,
        std::slice::from_ref(&scopes.watch)
    );

    let document: Value = serde_json::from_slice(&fs::read(registry_path).unwrap()).unwrap();
    let broker = &document["localPlugins"]["dev.core-service-permissions"]["brokerPolicy"];
    assert!(broker.get("readRoots").is_none());
    assert!(broker.get("executables").is_none());
    assert!(broker.get("cwdRoots").is_none());
    assert!(broker.get("envKeys").is_none());
    assert!(broker.get("writeRoots").is_none());
    assert_eq!(broker["watchRoots"], json!([scopes.watch]));
}
