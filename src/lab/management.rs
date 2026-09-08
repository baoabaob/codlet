//! Experimental stdin control shares the lifecycle owner, not the production IPC endpoint.
use crate::plugin_control::{PluginControlError, PluginControlReport, PluginControlRequest};
use crate::plugins::bundled_plugins;
use crate::renderer::RendererRuntime;

pub(super) fn execute(
    runtime: &mut RendererRuntime,
    request: PluginControlRequest,
) -> Result<PluginControlReport, PluginControlError> {
    request.validate()?;
    let bundled = bundled_plugins()
        .map_err(|error| PluginControlError::new("invalid_bundled_catalog", error.to_string()))?;
    if !bundled
        .iter()
        .any(|plugin| plugin.manifest.id == request.plugin_id)
    {
        return Err(PluginControlError::new(
            "unsupported_lab_plugin",
            "experimental control only supports this build's bundled plugins",
        ));
    }
    runtime.manage_plugin(request)
}
