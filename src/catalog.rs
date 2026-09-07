use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::capabilities::{CapabilityRegistry, CapabilityRegistryError, CapabilityScope};
use crate::local_plugins::{LocalPluginError, load_local_plugin};
use crate::plugins::{LoadedPlugin, ManifestError, Permission, PluginRegistry, bundled_plugins};
use crate::renderer::{BUILTIN_HOST_PROVIDER_ID, builtin_host_capabilities};

#[derive(Debug, Clone)]
pub enum PluginSource {
    Bundled,
    Local {
        path: PathBuf,
        grants: Vec<Permission>,
    },
}

impl PluginSource {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Bundled => "bundled",
            Self::Local { .. } => "local",
        }
    }

    pub fn path(&self) -> Option<&Path> {
        match self {
            Self::Bundled => None,
            Self::Local { path, .. } => Some(path),
        }
    }
}

#[derive(Debug)]
pub struct PluginCatalogEntry {
    pub id: String,
    pub source: PluginSource,
    pub plugin: Result<LoadedPlugin, LocalPluginError>,
}

impl PluginCatalogEntry {
    pub fn grants(&self) -> &[Permission] {
        match &self.source {
            PluginSource::Bundled => self
                .plugin
                .as_ref()
                .map(|plugin| plugin.manifest.permissions.as_slice())
                .unwrap_or_default(),
            PluginSource::Local { grants, .. } => grants,
        }
    }
}

/// A launch/diagnostic snapshot. Inspecting its entries never rereads plugin code.
#[derive(Debug)]
pub struct PluginCatalog {
    entries: Vec<PluginCatalogEntry>,
}

#[derive(Debug, Error)]
pub enum CatalogError {
    #[error(
        "enabled plugin {id} failed validation: {message}; repair its registration or disable it before launching"
    )]
    InvalidPlugin { id: String, message: String },
}

impl PluginCatalog {
    pub fn load(registry: &PluginRegistry) -> Result<Self, ManifestError> {
        let mut catalog = Self::from_bundled(bundled_plugins()?);
        let bundled_ids: BTreeSet<_> = catalog
            .entries
            .iter()
            .map(|entry| entry.id.clone())
            .collect();
        for (id, registration) in registry.local_plugins() {
            let plugin = if bundled_ids.contains(id) || id == BUILTIN_HOST_PROVIDER_ID {
                Err(LocalPluginError::ReservedId(id.clone()))
            } else {
                load_local_plugin(id, &registration.path, &registration.grants, 1).and_then(|plugin| {
                    if let Some(requirement) = plugin.manifest.requires.iter().find(|requirement| requirement.scope != CapabilityScope::Target) {
                        return Err(LocalPluginError::Rejected {
                            path: registration.path.join("plugin.json"),
                            stage: "renderer capability routing",
                            reason: format!("plugin {id} requires {requirement}; this renderer runtime only supports target-scoped requirements"),
                        });
                    }
                    Ok(plugin)
                })
            };
            catalog.entries.push(PluginCatalogEntry {
                id: id.clone(),
                source: PluginSource::Local {
                    path: registration.path.clone(),
                    grants: registration.grants.clone(),
                },
                plugin,
            });
        }
        catalog
            .entries
            .sort_by(|left, right| left.id.cmp(&right.id));
        Ok(catalog)
    }

    pub fn from_bundled(plugins: Vec<LoadedPlugin>) -> Self {
        let mut entries: Vec<_> = plugins
            .into_iter()
            .map(|plugin| PluginCatalogEntry {
                id: plugin.manifest.id.clone(),
                source: PluginSource::Bundled,
                plugin: Ok(plugin),
            })
            .collect();
        entries.sort_by(|left, right| left.id.cmp(&right.id));
        Self { entries }
    }

    pub fn entries(&self) -> &[PluginCatalogEntry] {
        &self.entries
    }

    pub fn enabled_plugins(
        &self,
        registry: &PluginRegistry,
    ) -> Result<Vec<LoadedPlugin>, CatalogError> {
        self.entries
            .iter()
            .filter(|entry| registry.is_enabled(&entry.id))
            .map(|entry| {
                entry
                    .plugin
                    .as_ref()
                    .cloned()
                    .map_err(|error| CatalogError::InvalidPlugin {
                        id: entry.id.clone(),
                        message: error.to_string(),
                    })
            })
            .collect()
    }
}

/// Doctor and the renderer use the same scoped declarations and graph rules.
pub(crate) fn capability_graph(
    plugins: &[LoadedPlugin],
) -> Result<CapabilityRegistry, CapabilityRegistryError> {
    let mut graph = CapabilityRegistry::new();
    graph.register_provider(
        BUILTIN_HOST_PROVIDER_ID,
        1,
        &builtin_host_capabilities(),
        &[],
        &[],
    )?;
    for plugin in plugins {
        let grants: Vec<_> = plugin
            .manifest
            .permissions
            .iter()
            .map(|permission| permission.as_str().to_owned())
            .collect();
        graph.register_provider(
            &plugin.manifest.id,
            plugin.generation,
            &plugin.manifest.provides,
            &plugin.manifest.requires,
            &grants,
        )?;
    }
    Ok(graph)
}
