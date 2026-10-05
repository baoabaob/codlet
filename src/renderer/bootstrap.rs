//! CDP bootstrap, bindings and generation-specific renderer scripts.
use super::RendererError;
use crate::cdp::{TargetSession, is_main_renderer_url};
use crate::plugins::{LoadedPlugin, RendererWorld};
use serde::Deserialize;
use serde_json::{Value, json};
use std::fmt::Write as _;

pub(super) const BOOTSTRAP_SOURCE: &str = include_str!("../../bundled/runtime/bootstrap.js");
pub(super) const UI_HELPERS_SOURCE: &str = include_str!("../../bundled/runtime/ui.js");
pub(super) const HELPERS_OWNER_SOURCE: &str = include_str!("../../bundled/runtime/helpers.js");
pub(super) const FACADE_SOURCE: &str = include_str!("../../bundled/runtime/facade.js");
pub(super) const PAGE_HELPERS_SOURCE: &str = include_str!("../../bundled/runtime/page.js");
pub(super) const I18N_SOURCE: &str = include_str!("../../bundled/runtime/i18n.js");
pub(super) const CORE_SERVICES_SOURCE: &str = include_str!("../../runtime/core-services.cjs");
#[derive(Deserialize)]
struct LifecycleResult {
    ok: bool,
    error: Option<String>,
}

pub(super) fn current_renderer_context(
    session: &TargetSession,
    world: RendererWorld,
    world_name: &str,
) -> Result<(u64, String), RendererError> {
    let frame_tree = session.request("Page.getFrameTree", None)?;
    if !frame_tree
        .pointer("/frameTree/frame/url")
        .and_then(Value::as_str)
        .is_some_and(is_main_renderer_url)
    {
        return Err(RendererError::InvalidResponse {
            method: "Page.getFrameTree",
            message: "main frame is outside the supported document",
        });
    }
    let frame_id = frame_tree
        .pointer("/frameTree/frame/id")
        .and_then(Value::as_str)
        .ok_or(RendererError::InvalidResponse {
            method: "Page.getFrameTree",
            message: "frameTree.frame.id is not a string",
        })?;
    if world == RendererWorld::Main {
        let context_id =
            session
                .default_context(frame_id)
                .ok_or(RendererError::InvalidResponse {
                    method: "Runtime.executionContextCreated",
                    message: "the main frame has no live default execution context",
                })?;
        return Ok((context_id, frame_id.to_owned()));
    }
    let result = session.request(
        "Page.createIsolatedWorld",
        Some(json!({"frameId": frame_id, "worldName": world_name})),
    )?;
    let context_id = result
        .get("executionContextId")
        .and_then(Value::as_u64)
        .ok_or(RendererError::InvalidResponse {
            method: "Page.createIsolatedWorld",
            message: "executionContextId is not an unsigned integer",
        })?;
    Ok((context_id, frame_id.to_owned()))
}

pub(super) fn add_new_document_script(
    session: &TargetSession,
    expression: &str,
    world: RendererWorld,
    world_name: &str,
) -> Result<String, RendererError> {
    let source = new_document_expression(expression);
    let mut params = json!({"source": source});
    if world == RendererWorld::Isolated {
        params["worldName"] = json!(world_name);
    }
    let result = session.request("Page.addScriptToEvaluateOnNewDocument", Some(params))?;
    result
        .get("identifier")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(RendererError::InvalidResponse {
            method: "Page.addScriptToEvaluateOnNewDocument",
            message: "identifier is not a string",
        })
}

pub(super) fn remove_new_document_script(
    session: &TargetSession,
    identifier: &str,
) -> Result<(), RendererError> {
    session.request(
        "Page.removeScriptToEvaluateOnNewDocument",
        Some(json!({"identifier": identifier})),
    )?;
    Ok(())
}

pub(super) fn remove_bootstrap_scripts(
    session: &TargetSession,
    identifiers: &[String],
) -> Result<(), RendererError> {
    let mut first_error = None;
    // Remove the helper producer first. A navigation between removals must not
    // stage a large helper graph after its consuming bootstrap was removed.
    for identifier in identifiers {
        if let Err(error) = remove_new_document_script(session, identifier) {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

pub(super) fn add_renderer_binding(
    session: &TargetSession,
    binding_name: &str,
    world: RendererWorld,
    world_name: &str,
    context_id: u64,
) -> Result<(), RendererError> {
    let mut params = json!({"name": binding_name});
    match world {
        RendererWorld::Isolated => params["executionContextName"] = json!(world_name),
        RendererWorld::Main => params["executionContextId"] = json!(context_id),
    }
    session.request("Runtime.addBinding", Some(params))?;
    Ok(())
}

pub(super) fn remove_renderer_binding(
    session: &TargetSession,
    binding_name: &str,
) -> Result<(), RendererError> {
    session.request("Runtime.removeBinding", Some(json!({"name": binding_name})))?;
    Ok(())
}

pub(super) fn evaluate_lifecycle(
    session: &TargetSession,
    expression: &str,
    context_id: u64,
) -> Result<(), String> {
    let result = session
        .evaluate_in_context(expression, Some(context_id))
        .map_err(|error| error.to_string())?;
    parse_lifecycle_result(result)
}

pub(super) fn parse_lifecycle_result(result: Value) -> Result<(), String> {
    if result.get("exceptionDetails").is_some() {
        return Err("Runtime.evaluate reported exceptionDetails".to_owned());
    }
    let value = result
        .pointer("/result/value")
        .cloned()
        .ok_or_else(|| "Runtime.evaluate did not return a value".to_owned())?;
    let lifecycle: LifecycleResult = serde_json::from_value(value)
        .map_err(|error| format!("Runtime.evaluate returned invalid lifecycle data: {error}"))?;
    if lifecycle.ok {
        Ok(())
    } else {
        Err(lifecycle
            .error
            .unwrap_or_else(|| "renderer lifecycle returned ok=false".to_owned()))
    }
}

pub(super) const CLEAR_STAGED_HELPERS: &str = "(() => { const helpers=globalThis.__codletRendererHelpersV1; delete globalThis.__codletRendererHelpersV1; helpers?.dispose(); return {ok:true}; })()";

pub(super) fn bootstrap_expressions(world: RendererWorld) -> [String; 2] {
    let options = json!({"world": world, "lazyUI": true, "retireOnEmpty": true});
    // Keep the large SDK in a different V8 Script. A retired isolated world's
    // immutable ABI methods still reference their defining Script and its entire
    // source; inlining helpers would pin the SDK source even after its functions
    // were released. Both persisted scripts belong to the same generation.
    let helpers = format!(
        "({HELPERS_OWNER_SOURCE})((MessageChannel) => ({UI_HELPERS_SOURCE}), {I18N_SOURCE}, (()=>{{const module={{exports:{{}}}};{CORE_SERVICES_SOURCE};return module.exports.createCoreServicesRuntime;}})(), {PAGE_HELPERS_SOURCE}, {BOOTSTRAP_SOURCE})"
    );
    let bootstrap = format!("({FACADE_SOURCE})({options})");
    [helpers, bootstrap]
}

pub(super) fn activation_expression(plugin: &LoadedPlugin, binding_name: &str) -> String {
    let metadata = json!({
        "id": plugin.manifest.id,
        "version": plugin.manifest.version,
        "generation": plugin.generation,
        "binding": binding_name,
        "provides": plugin.manifest.provides,
        "requires": plugin.manifest.requires
    });
    format!(
        r#"(async () => {{
            try {{
                const runtime = globalThis.__codletRendererV1;
                if (!runtime || runtime.abi !== 1) return {{ ok: false, error: 'renderer bootstrap is unavailable' }};
                const module = {{ exports: {{}} }};
                ((module, exports) => {{
{source}
                }})(module, module.exports);
                return await runtime.activate({metadata}, module.exports);
            }} catch (error) {{
                return {{ ok: false, error: error instanceof Error ? error.message : String(error) }};
            }}
        }})()
//# sourceURL=codlet://{id}/renderer.js"#,
        source = plugin
            .source
            .as_deref()
            .expect("renderer entry was validated before installation"),
        metadata = metadata,
        id = plugin.manifest.id
    )
}

pub(super) fn require_renderer_entry(plugin: &LoadedPlugin) -> Result<(), RendererError> {
    let message = if plugin.manifest.renderer.is_none() {
        "a renderer entry is required; host-only entries belong to the Host executor"
    } else if plugin.source.is_none() {
        "renderer source was not loaded"
    } else if plugin.manifest.host.is_some() && plugin.host.is_none() {
        "combined host source was not loaded"
    } else if plugin
        .manifest
        .renderer_provides()
        .iter()
        .any(|capability| capability.scope != crate::capabilities::CapabilityScope::Target)
    {
        "renderer instances may provide only Target capabilities"
    } else {
        return Ok(());
    };
    Err(RendererError::UnsupportedEntry {
        plugin_id: plugin.manifest.id.clone(),
        message,
    })
}

pub(super) fn deactivation_expression(plugin_id: &str, generation: u64) -> String {
    let plugin_id = serde_json::to_string(plugin_id).expect("string serialization cannot fail");
    format!(
        "globalThis.__codletRendererV1 ? globalThis.__codletRendererV1.deactivate({plugin_id}, {generation}) : ({{ ok: true, inactive: true }})"
    )
}

pub(super) fn document_name(base: String, epoch: u64) -> String {
    if epoch == 1 {
        base
    } else {
        format!("{base}.d{epoch}")
    }
}

pub(super) fn new_document_expression(expression: &str) -> String {
    format!(
        r#"(() => {{
            if (globalThis.top !== globalThis) return;
            const url = new URL(globalThis.location.href);
            if (url.protocol !== 'app:' || url.host !== '-' || url.pathname !== '/index.html') return;
            void ({expression});
        }})()"#
    )
}

pub(super) fn renderer_world_name(plugin: &LoadedPlugin) -> String {
    format!(
        "codlet.plugin.{}.g{}",
        plugin.manifest.id, plugin.generation
    )
}

pub(super) fn renderer_binding_name(
    target_id: &str,
    session_id: &str,
    plugin: &LoadedPlugin,
) -> String {
    format!(
        "codlet_rpc_v1_p_{}_t_{}_s_{}_g_{}{}",
        hex_component(&plugin.manifest.id),
        hex_component(target_id),
        hex_component(session_id),
        plugin.generation,
        if plugin
            .manifest
            .renderer
            .as_ref()
            .is_some_and(|renderer| renderer.world == RendererWorld::Main)
        {
            "_main"
        } else {
            ""
        }
    )
}

pub(super) fn hex_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len() * 2);
    for byte in value.bytes() {
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}
