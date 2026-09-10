use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::capabilities::{
    CapabilityRegistry, CapabilityRegistryError, CapabilityScope, host_provider_id,
};
use crate::local_plugins::{LocalPluginError, load_local_plugin_with_registration};
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
                load_local_plugin_with_registration(id, registration, 1)
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
        let plugin = load_local_plugin_with_registration(id, registration, generation)
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
    if plugin.manifest.renderer.is_none() {
        return Ok(plugin);
    }
    if let Some(requirement) = plugin.manifest.requires.iter().find(|requirement| {
        !matches!(
            requirement.scope,
            CapabilityScope::Target | CapabilityScope::Runtime
        )
    }) {
        return Err(LocalPluginError::Rejected {
            path: path.join("codlet.json"),
            stage: "renderer capability routing",
            reason: format!(
                "plugin {} requires {requirement}; Core supports Runtime and Target requirements",
                plugin.manifest.id
            ),
        });
    }
    if plugin
        .manifest
        .renderer_provides()
        .iter()
        .any(|capability| capability.scope != CapabilityScope::Target)
    {
        return Err(LocalPluginError::Rejected { path:path.join("codlet.json"), stage:"renderer capability routing", reason:"renderer instances provide Target capabilities; Runtime singletons belong to Host/Core".into() });
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
        if plugin.manifest.host.is_some() {
            graph.register_provider(
                &host_provider_id(&plugin.manifest.id),
                plugin.generation,
                plugin.manifest.host_provides(),
                plugin.manifest.host_requires(),
                &grants,
            )?;
        }
        if plugin.manifest.renderer.is_some() {
            graph.register_provider(
                &plugin.manifest.id,
                plugin.generation,
                plugin.manifest.renderer_provides(),
                plugin.manifest.renderer_requires(),
                &grants,
            )?;
        }
    }
    for plugin in plugins
        .iter()
        .filter(|plugin| plugin.manifest.host.is_some() && plugin.manifest.renderer.is_some())
    {
        graph
            .require_provider_before(&plugin.manifest.id, &host_provider_id(&plugin.manifest.id))?;
    }
    Ok(graph)
}

#[cfg(test)]
mod combined_graph_tests {
    use super::*;
    use crate::plugins::PluginManifest;
    use serde_json::json;

    fn plugin(manifest: serde_json::Value) -> LoadedPlugin {
        LoadedPlugin {
            authorization: None,
            manifest: PluginManifest::parse(&manifest.to_string()).unwrap(),
            source: Some("module.exports={};".into()),
            host: None,
            generation: 1,
        }
    }

    #[test]
    fn entry_owners_order_own_native_dependency_without_hiding_a_real_renderer_self_cycle() {
        let native = json!({"name":"dev.native","api":1,"scope":"target"});
        let view = json!({"name":"dev.view","api":1,"scope":"target"});
        let combined = plugin(
            json!({"schema":1,"id":"dev.combined","version":"1","renderer":{"entry":"renderer.js","world":"isolated"},"host":{"entry":"host.js","provides":[native]},"provides":[view],"requires":[native],"permissions":["host.process"]}),
        );
        let consumer = plugin(
            json!({"schema":1,"id":"dev.consumer","version":"1","renderer":{"entry":"renderer.js","world":"isolated"},"requires":[view]}),
        );
        let graph = capability_graph(&[consumer.clone(), combined.clone()]).unwrap();
        let order = graph.resolve_activation_order().unwrap();
        let position = |id| order.iter().position(|current| current == id).unwrap();
        assert!(position("dev.combined:host") < position("dev.combined"));
        assert!(position("dev.combined") < position("dev.consumer"));
        let logical = crate::plugin_lifecycle::order(vec![consumer, combined.clone()]).unwrap();
        assert_eq!(
            logical
                .iter()
                .map(|plugin| plugin.manifest.id.as_str())
                .collect::<Vec<_>>(),
            ["dev.combined", "dev.consumer"]
        );
        let mut cyclic = combined;
        cyclic.manifest.requires = cyclic.manifest.provides.clone();
        assert!(
            capability_graph(&[cyclic])
                .unwrap()
                .resolve_activation_order()
                .is_err()
        );
    }

    #[test]
    fn native_and_renderer_declarations_still_conflict_when_descriptors_are_identical() {
        let descriptor = json!({"name":"dev.same","api":1,"scope":"target"});
        let combined = plugin(
            json!({"schema":1,"id":"dev.combined","version":"1","renderer":{"entry":"renderer.js","world":"isolated"},"host":{"entry":"host.js","provides":[descriptor]},"provides":[descriptor],"permissions":["host.process"]}),
        );
        assert!(capability_graph(&[combined]).is_err());
    }
}
