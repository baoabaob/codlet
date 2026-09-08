//! Planning and trust checks for renderer plugin lifecycle operations.
//!
//! This module has no CDP, GUI, or transport knowledge. The renderer executes a
//! validated plan; shared persistence helpers retain the registry's existing
//! concurrency contract, while callers choose the point of commitment.

use std::collections::{BTreeMap, BTreeSet};

use thiserror::Error;

use crate::catalog::{
    CatalogError, PluginCatalog, PluginCatalogEntry, PluginSource, capability_graph,
};
use crate::local_plugins::validate_grants;
use crate::plugins::{LoadedPlugin, PluginRegistry, PluginRegistryError};

const MAX_GENERATION: u64 = 9_007_199_254_740_991;

#[derive(Debug, Error)]
pub(crate) enum LifecycleError {
    #[error(transparent)]
    Catalog(#[from] CatalogError),
    #[error(transparent)]
    Registry(#[from] PluginRegistryError),
    #[error("plugin {plugin_id} still has enabled or running dependents: {dependents}")]
    Dependents {
        plugin_id: String,
        dependents: String,
    },
    #[error("plugin {0} is not enabled in this runtime; enable it before reloading")]
    NotEnabled(String),
    #[error("plugin {0} exhausted its renderer generation range")]
    GenerationExhausted(String),
    #[error("plugin dependency validation failed: {0}")]
    Dependency(String),
    #[error(
        "plugin {0} registration changed during this operation; retry with the current trust settings"
    )]
    RegistrationChanged(String),
    #[error("cannot restore plugin {plugin_id} under its current trust settings: {message}")]
    RollbackTrust { plugin_id: String, message: String },
}

impl LifecycleError {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Catalog(CatalogError::UnknownPlugin(_)) => "plugin_not_found",
            Self::Catalog(_) => "local_plugin_invalid",
            Self::Registry(_) => "registry_error",
            Self::Dependents { .. } | Self::Dependency(_) => "dependency_conflict",
            Self::NotEnabled(_) => "plugin_not_enabled",
            Self::GenerationExhausted(_) => "generation_exhausted",
            Self::RegistrationChanged(_) => "registration_changed",
            Self::RollbackTrust { .. } => "rollback_trust_changed",
        }
    }
}

/// Includes the root. The existing validated graph uniquely identifies each
/// capability provider, so traversing declared descriptors is deterministic.
pub(crate) fn dependent_closure(plugins: &[LoadedPlugin], root: &str) -> BTreeSet<String> {
    dependent_closure_refs(plugins.iter(), root)
}

pub(crate) fn dependent_closure_refs<'a>(
    plugins: impl IntoIterator<Item = &'a LoadedPlugin>,
    root: &str,
) -> BTreeSet<String> {
    let plugins: Vec<_> = plugins.into_iter().collect();
    let mut affected = BTreeSet::from([root.to_owned()]);
    loop {
        let provided: Vec<_> = plugins
            .iter()
            .filter(|plugin| affected.contains(&plugin.manifest.id))
            .flat_map(|plugin| &plugin.manifest.provides)
            .collect();
        let dependents: Vec<_> = plugins
            .iter()
            .filter(|plugin| {
                plugin
                    .manifest
                    .requires
                    .iter()
                    .any(|requirement| provided.contains(&requirement))
            })
            .map(|plugin| plugin.manifest.id.clone())
            .collect();
        let before = affected.len();
        affected.extend(dependents);
        if affected.len() == before {
            return affected;
        }
    }
}

pub(crate) fn validate_disable(
    plugins: &[LoadedPlugin],
    catalog: &PluginCatalog,
    registry: &PluginRegistry,
    plugin_id: &str,
) -> Result<(), LifecycleError> {
    if !catalog.entries().iter().any(|entry| entry.id == plugin_id)
        && !registry.local_plugins().contains_key(plugin_id)
    {
        return Err(CatalogError::UnknownPlugin(plugin_id.to_owned()).into());
    }
    // Running records win over disk preferences; enabled catalog snapshots also
    // cover dependents that are temporarily inactive after a lifecycle failure.
    let mut candidates: BTreeMap<_, _> = catalog
        .entries()
        .iter()
        .filter(|entry| entry.id == plugin_id || registry.is_enabled(&entry.id))
        .filter_map(|entry| entry.plugin.as_ref().ok())
        .map(|plugin| (plugin.manifest.id.clone(), plugin.clone()))
        .collect();
    for plugin in plugins {
        candidates.insert(plugin.manifest.id.clone(), plugin.clone());
    }
    let closure = dependent_closure(&candidates.into_values().collect::<Vec<_>>(), plugin_id);
    let dependents: Vec<_> = closure.into_iter().filter(|id| id != plugin_id).collect();
    if !dependents.is_empty() {
        return Err(LifecycleError::Dependents {
            plugin_id: plugin_id.to_owned(),
            dependents: dependents.join(", "),
        });
    }
    Ok(())
}

pub(crate) fn next_generation(
    generations: &mut BTreeMap<String, u64>,
    plugin_id: &str,
) -> Result<u64, LifecycleError> {
    let generation = generations
        .get(plugin_id)
        .copied()
        .unwrap_or(0)
        .checked_add(1)
        .filter(|generation| *generation <= MAX_GENERATION)
        .ok_or_else(|| LifecycleError::GenerationExhausted(plugin_id.to_owned()))?;
    generations.insert(plugin_id.to_owned(), generation);
    Ok(generation)
}

pub(crate) struct ActivationPlan {
    pub affected: BTreeSet<String>,
    pub previous: Vec<LoadedPlugin>,
    pub next: Vec<LoadedPlugin>,
    pub entries: Vec<PluginCatalogEntry>,
}

impl ActivationPlan {
    pub(crate) fn prepare(
        plugin_id: &str,
        reload: bool,
        current: &[LoadedPlugin],
        catalog: &PluginCatalog,
        registry: &PluginRegistry,
        generations: &mut BTreeMap<String, u64>,
    ) -> Result<Self, LifecycleError> {
        if reload && !current.iter().any(|plugin| plugin.manifest.id == plugin_id) {
            return Err(LifecycleError::NotEnabled(plugin_id.to_owned()));
        }
        let affected = if reload {
            dependent_closure(current, plugin_id)
        } else {
            BTreeSet::from([plugin_id.to_owned()])
        };
        let previous = current
            .iter()
            .filter(|plugin| affected.contains(&plugin.manifest.id))
            .cloned()
            .collect();
        let mut entries = Vec::with_capacity(affected.len());
        // Validation has no runtime side effects. Unknown IDs and invalid source
        // snapshots must not consume generations or grow the high-water map.
        let mut prepared_generations = generations.clone();
        for id in &affected {
            let generation = next_generation(&mut prepared_generations, id)?;
            entries.push(catalog.reload_entry(id, registry, generation)?);
        }
        let mut next: Vec<_> = current
            .iter()
            .filter(|plugin| !affected.contains(&plugin.manifest.id))
            .cloned()
            .collect();
        next.extend(entries.iter().map(|entry| {
            entry
                .plugin
                .as_ref()
                .expect("reloaded entry is valid")
                .clone()
        }));
        let next = order(next)?;
        *generations = prepared_generations;
        Ok(Self {
            affected,
            previous,
            next,
            entries,
        })
    }

    pub(crate) fn replacements(&self) -> Vec<LoadedPlugin> {
        self.next
            .iter()
            .filter(|plugin| self.affected.contains(&plugin.manifest.id))
            .cloned()
            .collect()
    }
}

pub(crate) fn order(plugins: Vec<LoadedPlugin>) -> Result<Vec<LoadedPlugin>, LifecycleError> {
    let graph = capability_graph(&plugins)
        .map_err(|error| LifecycleError::Dependency(error.to_string()))?;
    let order = graph
        .resolve_activation_order()
        .map_err(|error| LifecycleError::Dependency(error.to_string()))?;
    let mut by_id: BTreeMap<_, _> = plugins
        .into_iter()
        .map(|plugin| (plugin.manifest.id.clone(), plugin))
        .collect();
    Ok(order
        .into_iter()
        .filter_map(|id| by_id.remove(&id))
        .collect())
}

pub(crate) fn verify_registrations(
    expected: &PluginRegistry,
    affected: &BTreeSet<String>,
) -> Result<PluginRegistry, LifecycleError> {
    let current = PluginRegistry::load(expected.path())?;
    for id in affected {
        if current.local_plugins().get(id) != expected.local_plugins().get(id) {
            return Err(LifecycleError::RegistrationChanged(id.clone()));
        }
    }
    Ok(current)
}

/// Reuse the registry's complete-record compare under its existing file lock.
/// Even an equal local assignment is intentionally staged to guard trust.
pub(crate) fn persist_preference(
    expected: &PluginRegistry,
    plugin_id: &str,
    enabled: bool,
) -> Result<PluginRegistry, LifecycleError> {
    persist_preference_with_guards(
        expected,
        plugin_id,
        enabled,
        &BTreeSet::from([plugin_id.to_owned()]),
    )
}

pub(crate) fn persist_preference_with_guards(
    expected: &PluginRegistry,
    plugin_id: &str,
    enabled: bool,
    affected: &BTreeSet<String>,
) -> Result<PluginRegistry, LifecycleError> {
    let mut candidate = expected.clone();
    for id in affected {
        if let Some(registration) = expected.local_plugins().get(id) {
            candidate.register_local(id, registration.clone())?;
        }
    }
    candidate.set_enabled(plugin_id, enabled)?;
    candidate.save()?;
    Ok(candidate)
}

pub(crate) fn rollback_plugins(
    previous: &[LoadedPlugin],
    catalog: &PluginCatalog,
    registry: &PluginRegistry,
    generations: &mut BTreeMap<String, u64>,
) -> Result<Vec<LoadedPlugin>, LifecycleError> {
    let mut restored = Vec::with_capacity(previous.len());
    for plugin in previous {
        validate_snapshot_trust(plugin, catalog, registry)?;
        let mut plugin = plugin.clone();
        plugin.generation = next_generation(generations, &plugin.manifest.id)?;
        restored.push(plugin);
    }
    Ok(restored)
}

pub(crate) fn validate_snapshot_trust(
    plugin: &LoadedPlugin,
    catalog: &PluginCatalog,
    registry: &PluginRegistry,
) -> Result<(), LifecycleError> {
    let source = &catalog
        .entries()
        .iter()
        .find(|entry| entry.id == plugin.manifest.id)
        .expect("runtime plugin has a catalog source")
        .source;
    if let PluginSource::Local { path, .. } = source {
        let registration = registry
            .local_plugins()
            .get(&plugin.manifest.id)
            .filter(|registration| registration.path == *path)
            .ok_or_else(|| LifecycleError::RollbackTrust {
                plugin_id: plugin.manifest.id.clone(),
                message: "the original local directory is no longer registered".into(),
            })?;
        validate_grants(&plugin.manifest, &registration.grants).map_err(|error| {
            LifecycleError::RollbackTrust {
                plugin_id: plugin.manifest.id.clone(),
                message: error.to_string(),
            }
        })?;
    }
    Ok(())
}
