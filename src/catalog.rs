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
    #[error("plugin {0} is not bundled or registered")]
    UnknownPlugin(String),
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
                load_local_plugin(id, &registration.path, &registration.grants, 1)
                    .and_then(|plugin| validate_renderer_requirements(plugin, &registration.path))
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

    /// Read only the explicitly selected registration. Unrelated entries remain
    /// launch snapshots, including disabled or invalid local plugins.
    pub(crate) fn reload_entry(
        &self,
        id: &str,
        registry: &PluginRegistry,
        generation: u64,
    ) -> Result<PluginCatalogEntry, CatalogError> {
        if let Some(entry) = self
            .entries
            .iter()
            .find(|entry| entry.id == id && matches!(entry.source, PluginSource::Bundled))
        {
            let mut plugin = entry
                .plugin
                .as_ref()
                .expect("bundled entry is valid")
                .clone();
            plugin.generation = generation;
            return Ok(PluginCatalogEntry {
                id: id.to_owned(),
                source: PluginSource::Bundled,
                plugin: Ok(plugin),
            });
        }
        let registration = registry
            .local_plugins()
            .get(id)
            .ok_or_else(|| CatalogError::UnknownPlugin(id.to_owned()))?;
        let plugin = load_local_plugin(id, &registration.path, &registration.grants, generation)
            .and_then(|plugin| validate_renderer_requirements(plugin, &registration.path))
            .map_err(|error| CatalogError::InvalidPlugin {
                id: id.to_owned(),
                message: error.to_string(),
            })?;
        Ok(PluginCatalogEntry {
            id: id.to_owned(),
            source: PluginSource::Local {
                path: registration.path.clone(),
                grants: registration.grants.clone(),
            },
            plugin: Ok(plugin),
        })
    }

    pub(crate) fn replace_entry(&mut self, entry: PluginCatalogEntry) {
        if let Some(current) = self
            .entries
            .iter_mut()
            .find(|current| current.id == entry.id)
        {
            *current = entry;
        } else {
            self.entries.push(entry);
            self.entries.sort_by(|left, right| left.id.cmp(&right.id));
        }
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

fn validate_renderer_requirements(
    plugin: LoadedPlugin,
    path: &Path,
) -> Result<LoadedPlugin, LocalPluginError> {
    if let Some(requirement) = plugin
        .manifest
        .requires
        .iter()
        .find(|requirement| requirement.scope != CapabilityScope::Target)
    {
        return Err(LocalPluginError::Rejected {
            path: path.join("plugin.json"),
            stage: "renderer capability routing",
            reason: format!(
                "plugin {} requires {requirement}; this renderer runtime only supports target-scoped requirements",
                plugin.manifest.id
            ),
        });
    }
    Ok(plugin)
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
