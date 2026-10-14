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
pub(super) const CODEX_SDK_SOURCE: &str = include_str!("../../bundled/runtime/codex.js");
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

pub(super) fn bootstrap_expressions_with_core_admission(
    world: RendererWorld,
    operation: Option<&str>,
) -> [String; 2] {
    let module = crate::runtime_update::core_module_source;
    let bootstrap_source = module("renderer-bootstrap", BOOTSTRAP_SOURCE);
    let ui_source = module("renderer-ui", UI_HELPERS_SOURCE);
    let helpers_source = module("renderer-helpers", HELPERS_OWNER_SOURCE);
    let facade_source = module("renderer-facade", FACADE_SOURCE);
    let page_source = module("renderer-page", PAGE_HELPERS_SOURCE);
    let i18n_source = module("renderer-i18n", I18N_SOURCE);
    let services_source = module("renderer-core-services", CORE_SERVICES_SOURCE);
    let codex_source = module("renderer-codex-sdk", CODEX_SDK_SOURCE);
    let options = json!({"world": world, "lazyUI": true, "retireOnEmpty": true, "coreAdmissionId": operation});
    // Keep the large SDK in a different V8 Script. A retired isolated world's
    // immutable ABI methods still reference their defining Script and its entire
    // source; inlining helpers would pin the SDK source even after its functions
    // were released. Both persisted scripts belong to the same generation.
    compose_bootstrap_expressions(
        [
            &bootstrap_source,
            &ui_source,
            &helpers_source,
            &facade_source,
            &page_source,
            &i18n_source,
            &services_source,
            &codex_source,
        ],
        &options,
    )
}

fn compose_bootstrap_expressions(
    [bootstrap, ui, helpers, facade, page, i18n, services, codex]: [&str; 8],
    options: &serde_json::Value,
) -> [String; 2] {
    // Valid module bytes can end in a line comment without a final newline.
    // Keep every source boundary on its own line so comments cannot consume
    // the enclosing syntax. Expression factories also get their own grouping.
    let helpers = format!(
        "(\n{helpers}\n)((MessageChannel) => (\n{ui}\n), (\n{i18n}\n), (()=>{{const module={{exports:{{}}}};\n{services}\n;return module.exports.createCoreServicesRuntime;}})(), (\n{page}\n), (\n{bootstrap}\n), (\n{codex}\n))"
    );
    let bootstrap = format!("(\n{facade}\n)({options})");
    [helpers, bootstrap]
}

#[cfg(all(test, windows))]
#[test]
fn bootstrap_composition_preserves_trailing_line_comments_in_all_modules() {
    use std::io::Write;
    let paths = [
        "renderer-bootstrap.js",
        "renderer-ui.js",
        "renderer-helpers.js",
        "renderer-facade.js",
        "renderer-page.js",
        "renderer-i18n.js",
        "renderer-core-services.cjs",
        "renderer-codex-sdk.js",
    ];
    let embedded = [
        BOOTSTRAP_SOURCE,
        UI_HELPERS_SOURCE,
        HELPERS_OWNER_SOURCE,
        FACADE_SOURCE,
        PAGE_HELPERS_SOURCE,
        I18N_SOURCE,
        CORE_SERVICES_SOURCE,
        CODEX_SDK_SOURCE,
    ];
    let generated = paths.map(|path| {
        std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("runtime/core-modules")
                .join(path),
        )
        .unwrap()
    });
    for sources in [embedded, generated.each_ref().map(String::as_str)] {
        let commented = sources.map(|source| format!("{source}\n// no final newline"));
        let expressions = compose_bootstrap_expressions(
            commented.each_ref().map(String::as_str),
            &json!({"world":"isolated","lazyUI":true,"retireOnEmpty":true}),
        );
        let mut child = std::process::Command::new("node")
            .args(["-e", "const vm=require('node:vm'),fs=require('node:fs');for(const source of JSON.parse(fs.readFileSync(0,'utf8')))new vm.Script(source);"])
            .stdin(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(&expressions).unwrap())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[cfg(test)]
pub(super) fn activation_expression(plugin: &LoadedPlugin, binding_name: &str) -> String {
    activation_expression_with_snapshot(plugin, binding_name, None)
}

pub(super) fn snapshot_expression(id: &str, generation: u64) -> String {
    format!(
        "globalThis.__codletRendererV1.__snapshot({}, {generation})",
        json!(id)
    )
}

pub(super) fn resume_expression(id: &str, generation: u64) -> String {
    format!(
        "globalThis.__codletRendererV1.__resume({}, {generation})",
        json!(id)
    )
}

pub(super) fn core_admission_expression(operation: &str, paused: bool) -> String {
    let method = if paused {
        "__coreAdmissionPause"
    } else {
        "__coreAdmissionResume"
    };
    format!(
        "(() => {{ const runtime=globalThis.__codletRendererV1; if(typeof runtime?.{method}!== 'function') return {{ok:false,error:'Renderer does not support Core transaction admission'}}; return runtime.{method}({}); }})()",
        json!(operation)
    )
}

pub(super) fn parse_snapshot_result(result: Value) -> Result<Option<Value>, String> {
    if result.get("exceptionDetails").is_some() {
        return Err("Runtime.evaluate reported exceptionDetails while saving plugin state".into());
    }
    let value = result
        .pointer("/result/value")
        .ok_or("Runtime.evaluate did not return plugin state")?;
    if value["ok"] != true {
        return Err(value["error"]
            .as_str()
            .unwrap_or("renderer state snapshot failed")
            .into());
    }
    let snapshot = value
        .get("snapshot")
        .ok_or("renderer state snapshot is absent")?;
    if snapshot.is_null() {
        return Ok(None);
    }
    if snapshot
        .as_object()
        .is_none_or(|object| object.len() != 2 || !object.contains_key("value"))
        || snapshot["schema"]
            .as_u64()
            .is_none_or(|schema| schema == 0 || schema > 9_007_199_254_740_991)
        || serde_json::to_vec(snapshot)
            .map_err(|error| error.to_string())?
            .len()
            > 256 * 1024
    {
        return Err("renderer returned an invalid plugin state snapshot".into());
    }
    Ok(Some(snapshot.clone()))
}

pub(super) fn activation_expression_with_snapshot(
    plugin: &LoadedPlugin,
    binding_name: &str,
    snapshot: Option<&Value>,
) -> String {
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
                return await runtime.activate({metadata}, module.exports, {snapshot});
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
        snapshot = snapshot.map_or_else(|| "null".to_owned(), Value::to_string),
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
