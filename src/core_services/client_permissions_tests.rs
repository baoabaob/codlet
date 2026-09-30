use super::*;
use crate::plugins::{LocalPluginRegistration, Permission};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};

#[test]
fn client_permissions_allow_owned_file_operations_without_roots_and_still_check_grants() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("plugin");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("host.js"), "exports.activate=()=>{};").unwrap();
    let permissions = vec![
        Permission::HostProcess,
        Permission::HostFs,
        Permission::HostFsWrite,
        Permission::HostFsWatch,
        Permission::HostNetwork,
    ];
    std::fs::write(root.join("codlet.json"),json!({"schema":1,"id":"test.client-access","version":"1","host":{"entry":"host.js"},"permissions":permissions}).to_string()).unwrap();
    let path = temp.path().join("registry.json");
    let mut registry = PluginRegistry::load(&path).unwrap();
    let registration = LocalPluginRegistration {
        path: root.canonicalize().unwrap(),
        grants: permissions,
        broker_policy: crate::plugin_permissions::BrokerPolicy {
            client_permissions: true,
            ..Default::default()
        },
    };
    registry
        .register_local("test.client-access", registration.clone())
        .unwrap();
    registry.set_enabled("test.client-access", true).unwrap();
    registry.save().unwrap();
    let plugin = crate::local_plugins::load_local_plugin_with_registration(
        "test.client-access",
        &registration,
        1,
    )
    .unwrap();
    let services = SharedCoreServices::new(&path).unwrap();
    services.register(&[plugin]).unwrap();
    let principal = services.0.owners.lock().unwrap()["test.client-access"].clone();
    let call = |method: &str, params: Value| {
        let check = || services.check(&principal, &format!("files.{method}"), true, &params);
        check()?;
        services
            .0
            .files
            .invoke(&principal, method, params.clone(), &check)
    };
    let outside = temp.path().join("outside-plugin");
    std::fs::create_dir(&outside).unwrap();
    let file = outside.join("note.txt");
    let written = call(
        "writeAtomic",
        json!({"path":file,"expectedVersion":null,"data":BASE64.encode(b"hello")}),
    )
    .unwrap();
    assert_eq!(
        call("read", json!({"path":file})).unwrap()["data"],
        BASE64.encode(b"hello")
    );
    let watch = call("watch", json!({"path":outside})).unwrap();
    call("unwatch", json!({"watch":watch["watch"]})).unwrap();
    call(
        "remove",
        json!({"path":file,"expectedVersion":written["version"]}),
    )
    .unwrap();
    assert!(!file.exists());
    assert!(network::authorize_url(&principal, "http://127.0.0.1:12345").is_ok());
    assert!(network::authorize_url(&principal, "https://example.invalid").is_ok());
    assert!(network::authorize_url(&principal, "file:///private").is_err());
    assert_eq!(
        services
            .check(&principal, "desktop.clipboardRead", true, &json!({}))
            .unwrap_err()
            .code,
        "permission_denied"
    );
    registry
        .revoke_permission("test.client-access", Permission::HostFs)
        .unwrap();
    registry.save().unwrap();
    std::fs::write(&file, b"still exists").unwrap();
    assert!(
        call("read", json!({"path":file})).is_err(),
        "client access cannot survive revocation"
    );
}
