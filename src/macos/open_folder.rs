use crate::plugin_control::PluginControlError;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
fn open(path: &Path) -> Result<Value, PluginControlError> {
    super::command::output(
        std::process::Command::new("/usr/bin/open")
            .arg("--")
            .arg(path),
        std::time::Duration::from_secs(5),
    )
    .map_err(|e| PluginControlError::new("open_folder", e.to_string()))?;
    Ok(json!({"opened":true}))
}
pub(crate) fn open_registered_source(
    registry: &crate::plugins::PluginRegistry,
    id: &str,
) -> Result<Value, PluginControlError> {
    crate::source_removal::with_registered_directory(registry, id, open)
}
pub(crate) fn open_runtime_directory(directory: PathBuf) -> Result<Value, PluginControlError> {
    let directory = directory
        .canonicalize()
        .map_err(|e| PluginControlError::new("open_folder", e.to_string()))?;
    let pinned = super::filesystem::open_checked(&directory)
        .map_err(|e| PluginControlError::new("open_folder", e.to_string()))?;
    if !pinned
        .file
        .metadata()
        .map_err(|e| PluginControlError::new("open_folder", e.to_string()))?
        .is_dir()
    {
        return Err(PluginControlError::new(
            "open_folder",
            "Expected a directory",
        ));
    }
    open(&pinned.path)
}
