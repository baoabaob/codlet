use super::*;
use crate::capabilities::CapabilityScope;
use crate::runtime_control::ControlBroker;
use crate::runtime_manage::RuntimeManageService;

// These requests cross the real Renderer builtin dispatch, not a JavaScript RPC
// mock. Invalid payloads reach service validation without opening a picker,
// launching Explorer, downloading a package or requesting a restart.
const FORWARDED_METHODS: &[&str] = &[
    "prepare",
    "submit",
    "operation",
    "previewLocal",
    "permissions",
    "chooseLocalFolder",
    "folderSelection",
    "sourceRemovalPreview",
    "openFolder",
    "openRuntimeFolder",
    "githubDiscover",
    "githubReleases",
    "githubPrepare",
    "githubJob",
    "cancelGitHubJob",
    "managedHistory",
    "previewRollback",
    "runtimeUpdateStatus",
    "getSettings",
    "versionStatus",
    "saveSettings",
    "checkRuntimeUpdate",
    "checkPluginUpdates",
    "downloadRuntimeUpdate",
    "installRuntimeUpdate",
    "installCombinedUpdate",
];

fn request(method: &str, scope: CapabilityScope) -> BindingMessage {
    let mut capability = builtin_manage_capability();
    capability.scope = scope;
    BindingMessage {
        v: 1,
        message_type: "request".to_owned(),
        plugin_id: "dev.manage-dispatch-test".to_owned(),
        generation: 1,
        id: Some(1),
        capability,
        method: method.to_owned(),
        params: json!({"unexpected": true}),
        timeout_ms: None,
        parent_token: None,
    }
}

fn dispatch(
    registry: &mut PluginRegistry,
    service: Option<&RuntimeManageService>,
    message: &BindingMessage,
    granted: bool,
) -> Result<HostEndpointOutcome, HostEndpointFailure> {
    let catalog = PluginCatalog::from_bundled(Vec::new());
    invoke_builtin_host_endpoint(
        HostEndpointContext {
            registry,
            catalog: &catalog,
            plugins: &[],
            external_observations: &[],
            active_plugin_ids: BTreeSet::new(),
            manage_service: service,
        },
        &message.plugin_id,
        granted,
        &message.capability,
        message,
    )
}

#[test]
fn added_management_methods_reach_service_validation_in_both_scopes() {
    let directory = tempfile::tempdir().unwrap();
    let registry_path = directory.path().join("config.json");
    let mut registry = PluginRegistry::load(&registry_path).unwrap();
    let service = RuntimeManageService::new(ControlBroker::new([41; 16], "dispatch-test".into()))
        .with_local_management(registry_path.clone(), false);

    for scope in [CapabilityScope::Target, CapabilityScope::Runtime] {
        for method in FORWARDED_METHODS {
            let message = request(method, scope);
            let direct = service.invoke(method, message.params.clone()).unwrap_err();
            assert_ne!(direct.code, "method_not_found", "service forgot {method}");
            let forwarded = dispatch(&mut registry, Some(&service), &message, true).unwrap_err();
            assert_eq!(
                forwarded.code, direct.code,
                "builtin did not forward {method}"
            );
            assert_eq!(
                forwarded.message, direct.message,
                "params changed for {method}"
            );
        }
    }
    assert!(!registry_path.exists());
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
}

#[test]
fn added_management_methods_keep_grant_receipt_and_service_guards() {
    let directory = tempfile::tempdir().unwrap();
    let mut registry = PluginRegistry::load(directory.path().join("config.json")).unwrap();
    for scope in [CapabilityScope::Target, CapabilityScope::Runtime] {
        for method in FORWARDED_METHODS {
            let mut message = request(method, scope);
            assert_eq!(
                dispatch(&mut registry, None, &message, false)
                    .unwrap_err()
                    .code,
                "permission_denied",
                "{method}"
            );
            message.id = None;
            assert_eq!(
                dispatch(&mut registry, None, &message, true)
                    .unwrap_err()
                    .code,
                "request_required",
                "{method}"
            );
            message.id = Some(1);
            assert_eq!(
                dispatch(&mut registry, None, &message, true)
                    .unwrap_err()
                    .code,
                "runtime_unavailable",
                "{method}"
            );
        }
    }
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
}

#[test]
fn update_status_crosses_renderer_dispatch_as_a_real_read_only_value() {
    let directory = tempfile::tempdir().unwrap();
    let mut registry = PluginRegistry::load(directory.path().join("config.json")).unwrap();
    let service =
        RuntimeManageService::new(ControlBroker::new([42; 16], "status-dispatch-test".into()));
    let updates = crate::runtime_update::RuntimeUpdateService::start(
        directory.path().to_owned(),
        directory.path().join("update-state"),
        None,
    )
    .unwrap();
    service.set_runtime_update(updates);
    for scope in [CapabilityScope::Target, CapabilityScope::Runtime] {
        let mut message = request("runtimeUpdateStatus", scope);
        message.params = json!({});
        let direct = service
            .invoke(&message.method, message.params.clone())
            .unwrap();
        let forwarded = dispatch(&mut registry, Some(&service), &message, true).unwrap();
        assert_eq!(forwarded.value, direct);
        assert_eq!(forwarded.value["currentVersion"], env!("CARGO_PKG_VERSION"));
        assert_eq!(forwarded.value["phase"], "development");
        assert_eq!(forwarded.value["configured"], false);
        assert!(forwarded.after_response.is_none());
    }
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
}
