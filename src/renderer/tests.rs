use super::*;
use crate::capabilities::{CapabilityRegistryError, CapabilityScope};
use crate::plugins::{PluginManifest, bundled_codex_ui_adapter, bundled_codlet, bundled_plugins};
use crate::runtime_inspection::{
    MAX_INSPECTION_CAPABILITIES, MAX_INSPECTION_CAPABILITIES_PER_PROVIDER, MAX_INSPECTION_ID_BYTES,
    MAX_INSPECTION_PROVIDERS, ProviderKind,
};
use tempfile::{TempDir, tempdir};

#[test]
fn provider_bootstrap_failure_codes_preserve_the_original_diagnostic() {
    for code in ["ui_host_drift", "request_timeout", "invocation_cancelled"] {
        assert_eq!(
            parse_provider_result(json!({"result":{"value":{
                "ok":false,"code":code,"error":"provider stopped"
            }}})),
            Err(format!("{code}: provider stopped"))
        );
    }
    assert_eq!(
        parse_provider_result(json!({"result":{"value":{"ok":false,"error":"legacy"}}})),
        Err("legacy".to_owned())
    );
    assert_eq!(
        parse_provider_result(json!({"result":{"value":{"ok":true,"value":null}}})),
        Ok(Value::Null)
    );
    for value in [
        json!({"ok":false,"code":7,"error":"bad code"}),
        json!({"ok":false,"code":"provider_error","error":"failed","unknown":true}),
        json!({"ok":true}),
    ] {
        assert!(parse_provider_result(json!({"result":{"value":value}})).is_err());
    }
}

fn test_registry() -> (TempDir, PluginRegistry) {
    let directory = tempdir().unwrap();
    let registry = PluginRegistry::load(directory.path().join("config.json")).unwrap();
    (directory, registry)
}

#[test]
fn inspection_provider_evidence_comes_from_current_kernel_registrations_not_catalog_caches() {
    let (_directory, registry) = test_registry();
    let mut runtime = RendererRuntime::bundled(registry).unwrap();
    let publisher = StatusPublisher::new();
    publisher
        .bind_runtime_identity([1; 16], "fixture-scope")
        .unwrap();
    runtime.set_status_publisher(publisher.clone());
    let original = publisher.inspection_snapshot().unwrap();
    let original_provider = original
        .renderer
        .as_ref()
        .unwrap()
        .providers
        .iter()
        .find(|provider| provider.id == "codex.ui.adapter")
        .unwrap()
        .clone();
    let cached = runtime
        .plugins
        .iter_mut()
        .find(|plugin| plugin.manifest.id == "codex.ui.adapter")
        .unwrap();
    cached.generation = 99;
    cached.manifest.provides =
        vec![CapabilityDescriptor::new("dev.cached.only", 1, CapabilityScope::Target).unwrap()];
    runtime.publish_status();
    let current = publisher.inspection_snapshot().unwrap().renderer.unwrap();
    assert_eq!(
        current
            .providers
            .iter()
            .find(|provider| provider.id == "codex.ui.adapter")
            .unwrap(),
        &original_provider
    );
    runtime
        .capabilities
        .unregister_provider("codex.ui.adapter")
        .unwrap();
    runtime.publish_status();
    assert!(
        publisher
            .inspection_snapshot()
            .unwrap()
            .renderer
            .unwrap()
            .providers
            .iter()
            .all(|provider| provider.id != "codex.ui.adapter")
    );
    let actual =
        CapabilityDescriptor::new("dev.actual.registration", 1, CapabilityScope::Target).unwrap();
    runtime
        .capabilities
        .register_provider(
            "codex.ui.adapter",
            7,
            std::slice::from_ref(&actual),
            &[],
            &[],
        )
        .unwrap();
    runtime.publish_status();
    let current = publisher.inspection_snapshot().unwrap().renderer.unwrap();
    let provider = current
        .providers
        .iter()
        .find(|provider| provider.id == "codex.ui.adapter")
        .unwrap();
    assert_eq!(provider.generation, 7);
    assert_eq!(provider.provides, [actual]);
    assert_eq!(provider.kind, ProviderKind::Renderer);
    assert!(
        current
            .providers
            .iter()
            .any(|provider| provider.id == BUILTIN_HOST_PROVIDER_ID
                && provider.kind == ProviderKind::Host)
    );
    assert!(
        current
            .providers
            .iter()
            .all(|provider| provider.id != "codlet-gui")
    ); // A consumer is not a capability provider.
    assert_eq!(
        original
            .renderer
            .unwrap()
            .providers
            .iter()
            .find(|provider| provider.id == "codex.ui.adapter")
            .unwrap(),
        &original_provider
    );
}

#[test]
fn inspection_truncates_complete_provider_records_without_changing_legacy_status_limits() {
    let (_directory, registry) = test_registry();
    let mut runtime = RendererRuntime::new(Vec::new(), registry).unwrap();
    let wide: Vec<_> = (0..MAX_INSPECTION_CAPABILITIES_PER_PROVIDER + 7)
        .map(|index| {
            CapabilityDescriptor::new(format!("dev.cap{index:03}"), 1, CapabilityScope::Target)
                .unwrap()
        })
        .collect();
    runtime
        .capabilities
        .register_provider("dev.wide", 1, &wide, &[], &[])
        .unwrap();
    let (legacy, inspection) = runtime.sample_runtime_observation();
    assert!(!legacy.truncated);
    assert!(inspection.truncated);
    let provider = inspection
        .providers
        .iter()
        .find(|provider| provider.id == "dev.wide")
        .unwrap();
    assert_eq!(
        provider.provides.len(),
        MAX_INSPECTION_CAPABILITIES_PER_PROVIDER
    );
    assert!(provider.capabilities_truncated);
    assert_eq!(provider.provides[0], wide[0]);
    for group in 0..8 {
        let provides: Vec<_> = (0..MAX_INSPECTION_CAPABILITIES_PER_PROVIDER)
            .map(|index| {
                CapabilityDescriptor::new(
                    format!("dev.group{group}.cap{index:03}"),
                    1,
                    CapabilityScope::Target,
                )
                .unwrap()
            })
            .collect();
        runtime
            .capabilities
            .register_provider(&format!("dev.group{group}"), 1, &provides, &[], &[])
            .unwrap();
    }
    let (_, inspection) = runtime.sample_runtime_observation();
    assert_eq!(
        inspection
            .providers
            .iter()
            .map(|provider| provider.provides.len())
            .sum::<usize>(),
        MAX_INSPECTION_CAPABILITIES
    );
    for index in 0..MAX_INSPECTION_PROVIDERS + 1 {
        let descriptor =
            CapabilityDescriptor::new(format!("dev.small{index:03}"), 1, CapabilityScope::Target)
                .unwrap();
        runtime
            .capabilities
            .register_provider(&format!("dev.small{index:03}"), 1, &[descriptor], &[], &[])
            .unwrap();
    }
    let (legacy, inspection) = runtime.sample_runtime_observation();
    assert!(!legacy.truncated);
    assert!(inspection.truncated);
    assert_eq!(inspection.providers.len(), MAX_INSPECTION_PROVIDERS);
    assert!(
        inspection
            .providers
            .windows(2)
            .all(|pair| pair[0].id < pair[1].id)
    );
    assert!(
        inspection
            .providers
            .iter()
            .all(|provider| provider.id.len() < MAX_INSPECTION_ID_BYTES)
    );
}

#[test]
fn generated_plugin_script_carries_generation_and_main_frame_guard() {
    let plugin = bundled_codlet().unwrap();
    let activation = activation_expression(&plugin, "codlet_rpc_test");
    assert!(activation.contains("runtime.activate"));
    assert!(activation.contains("\"generation\":1"));
    assert!(activation.contains("module.exports"));

    let persisted = new_document_expression(&activation);
    assert!(persisted.contains("globalThis.top !== globalThis"));
    assert!(persisted.contains("url.protocol !== 'app:'"));
    assert!(persisted.contains("url.pathname !== '/index.html'"));
    assert!(BOOTSTRAP_SOURCE.contains("runExclusive"));
    assert!(!activation.contains("CapabilityPrincipal"));
    assert!(activation.contains("\"binding\""));
    assert!(activation.contains("\"provides\""));
    assert!(activation.contains("\"requires\""));
    assert!(!BOOTSTRAP_SOURCE.contains("context.capabilities"));
}

#[test]
fn bundled_capability_graph_orders_adapter_before_gui() {
    let (ordered, _) = order_plugins(bundled_plugins().unwrap()).unwrap();
    assert_eq!(
        ordered
            .iter()
            .map(|plugin| plugin.manifest.id.as_str())
            .collect::<Vec<_>>(),
        ["codex.ui.adapter", "codlet-gui"]
    );
}

#[test]
fn every_plugin_generation_gets_a_distinct_world() {
    let plugins = bundled_plugins().unwrap();
    assert_eq!(
        renderer_world_name(&plugins[0]),
        "codlet.plugin.codex.ui.adapter.g1"
    );
    assert_eq!(
        renderer_world_name(&plugins[1]),
        "codlet.plugin.codlet-gui.g1"
    );
    assert_ne!(
        renderer_world_name(&plugins[0]),
        renderer_world_name(&plugins[1])
    );
}

#[test]
fn binding_namespace_is_unique_per_plugin_target_session_and_generation() {
    let plugin = bundled_codlet().unwrap();
    let first = renderer_binding_name("target-a", "session-a", &plugin);
    let mut replacement = plugin.clone();
    replacement.generation = 2;

    let variants = [
        first.clone(),
        renderer_binding_name("target-b", "session-a", &plugin),
        renderer_binding_name("target-a", "session-b", &plugin),
        renderer_binding_name("target-a", "session-a", &replacement),
    ];
    assert_eq!(
        variants
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        4
    );
    assert!(variants.iter().all(|binding| {
        binding.starts_with("codlet_rpc_v1_")
            && binding
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    }));
}

#[test]
fn binding_messages_reject_ids_outside_javascript_safe_range() {
    let payload = format!(
        r#"{{"v":1,"type":"request","pluginId":"dev.consumer","generation":1,"id":{},"capability":{{"name":"renderer.example","api":1,"scope":"target"}},"method":"call","params":null}}"#,
        MAX_JAVASCRIPT_SAFE_INTEGER + 1
    );
    let error = parse_binding_message(&payload)
        .err()
        .expect("an unsafe request id must be rejected");
    assert!(error.contains("between 1 and"));
}

#[test]
fn renderer_runtime_rejects_an_unresolved_capability() {
    let manifest = PluginManifest::parse(
        r#"{
            "schema": 1,
            "id": "dev.consumer",
            "version": "1",
            "renderer": {"entry": "dist/renderer.js", "world": "isolated"},
            "requires": [
                {"name": "runtime.missing", "api": 1, "scope": "runtime"}
            ]
        }"#,
    )
    .unwrap();
    let plugin = LoadedPlugin {
        authorization: None,
        manifest,
        source: Some("module.exports = {};".into()),
        host: None,
        generation: 1,
    };
    let (_registry_directory, registry) = test_registry();

    assert!(matches!(
        RendererRuntime::new(vec![plugin], registry),
        Err(RendererError::Capability(
            CapabilityRegistryError::MissingRequirement { requirement, .. }
        )) if requirement.scope == CapabilityScope::Runtime
    ));
}

#[test]
fn renderer_runtime_rejects_generation_above_javascript_safe_integer() {
    let mut plugin = bundled_codex_ui_adapter().unwrap();
    plugin.generation = 9_007_199_254_740_992;
    let (_registry_directory, registry) = test_registry();

    assert!(matches!(
        RendererRuntime::new(vec![plugin], registry),
        Err(RendererError::InvalidGeneration {
            plugin_id,
            generation: 9_007_199_254_740_992,
        }) if plugin_id == "codex.ui.adapter"
    ));
}

#[test]
fn renderer_runtime_rejects_missing_source_and_incomplete_combined_snapshots_before_registration() {
    let mut missing_source = bundled_codex_ui_adapter().unwrap();
    missing_source.source = None;
    let mut combined = bundled_codex_ui_adapter().unwrap();
    combined.manifest.host = Some(crate::plugins::HostManifest {
        entry: "host.js".to_owned(),
        provides: Vec::new(),
        requires: Vec::new(),
    });
    for plugin in [missing_source, combined] {
        let (_directory, registry) = test_registry();
        assert!(matches!(
            RendererRuntime::new(vec![plugin], registry),
            Err(RendererError::UnsupportedEntry { plugin_id, .. }) if plugin_id == "codex.ui.adapter"
        ));
    }
}

#[test]
fn built_in_host_ping_is_strict_and_side_effect_free() {
    let (_registry_directory, mut registry) = test_registry();
    let catalog = PluginCatalog::from_bundled(Vec::new());
    let descriptor = builtin_host_capability();
    let request = BindingMessage {
        v: 1,
        message_type: "request".to_owned(),
        plugin_id: "dev.consumer".to_owned(),
        generation: 1,
        id: Some(1),
        capability: descriptor.clone(),
        method: "ping".to_owned(),
        params: Value::Null,
        timeout_ms: None,
        parent_token: None,
    };
    let result = invoke_builtin_host_endpoint(
        HostEndpointContext {
            registry: &mut registry,
            catalog: &catalog,
            plugins: &[],
            external_observations: &[],
            manage_service: None,
            active_plugin_ids: BTreeSet::new(),
        },
        "dev.consumer",
        false,
        &descriptor,
        &request,
    )
    .unwrap();
    assert_eq!(result.value, json!({"pong": true, "abi": 1}));
    assert!(result.after_response.is_none());

    let mut unknown_method = request;
    unknown_method.method = "anything-else".to_owned();
    assert_eq!(
        invoke_builtin_host_endpoint(
            HostEndpointContext {
                registry: &mut registry,
                catalog: &catalog,
                plugins: &[],
                external_observations: &[],
                manage_service: None,
                active_plugin_ids: BTreeSet::new(),
            },
            "dev.consumer",
            false,
            &descriptor,
            &unknown_method,
        )
        .unwrap_err()
        .code,
        "method_not_found"
    );
}

#[test]
fn runtime_manage_persists_before_scheduling_self_disable() {
    let (registry_directory, mut registry) = test_registry();
    let path = registry.path().to_owned();
    let plugins = bundled_plugins().unwrap();
    let descriptor = builtin_manage_capability();
    let catalog = PluginCatalog::from_bundled(plugins.clone());
    let request = BindingMessage {
        v: 1,
        message_type: "request".to_owned(),
        plugin_id: "codlet-gui".to_owned(),
        generation: 1,
        id: Some(1),
        capability: descriptor.clone(),
        method: "disableSelf".to_owned(),
        params: Value::Null,
        timeout_ms: None,
        parent_token: None,
    };

    let denied = invoke_builtin_host_endpoint(
        HostEndpointContext {
            registry: &mut registry,
            catalog: &catalog,
            plugins: &plugins,
            external_observations: &[],
            manage_service: None,
            active_plugin_ids: BTreeSet::from(["codlet-gui".to_owned()]),
        },
        "codlet-gui",
        false,
        &descriptor,
        &request,
    )
    .unwrap_err();
    assert_eq!(denied.code, "permission_denied");
    assert!(!path.exists());

    let result = invoke_builtin_host_endpoint(
        HostEndpointContext {
            registry: &mut registry,
            catalog: &catalog,
            plugins: &plugins,
            external_observations: &[],
            manage_service: None,
            active_plugin_ids: BTreeSet::from(["codlet-gui".to_owned()]),
        },
        "codlet-gui",
        true,
        &descriptor,
        &request,
    )
    .unwrap();
    assert_eq!(
        result.value,
        json!({"pluginId": "codlet-gui", "enabled": false})
    );
    assert_eq!(
        result.after_response,
        Some(HostAction::DisablePlugin {
            plugin_id: "codlet-gui".to_owned()
        })
    );
    assert!(
        !PluginRegistry::load(&path)
            .unwrap()
            .is_enabled("codlet-gui")
    );
    drop(registry_directory);
}

#[test]
fn host_requirement_is_resolved_without_exposing_a_renderer_provider() {
    let manifest = PluginManifest::parse(
        r#"{
            "schema": 1,
            "id": "dev.consumer",
            "version": "1",
            "renderer": {"entry": "dist/renderer.js", "world": "isolated"},
            "requires": [
                {"name": "codlet.runtime.ping", "api": 1, "scope": "target"}
            ]
        }"#,
    )
    .unwrap();
    let (ordered, _) = order_plugins(vec![LoadedPlugin {
        authorization: None,
        manifest,
        source: Some("module.exports = {};".into()),
        host: None,
        generation: 1,
    }])
    .unwrap();
    assert_eq!(
        ordered
            .iter()
            .map(|plugin| plugin.manifest.id.as_str())
            .collect::<Vec<_>>(),
        ["dev.consumer"]
    );
}

#[test]
fn renderer_rpc_payload_limit_is_enforced_before_json_parsing() {
    let payload = "{".repeat(MAX_RENDERER_RPC_PAYLOAD_BYTES + 1);
    let error = parse_binding_message(&payload)
        .err()
        .expect("an oversized payload must be rejected");
    assert!(error.contains("payload exceeds"));
}
