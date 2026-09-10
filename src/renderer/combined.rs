//! Logical package hooks used by the foreground host/renderer transaction.

use super::*;
use crate::capabilities::{host_provider_id, host_provider_plugin_id};
use crate::catalog::PluginCatalogEntry;
use crate::plugin_control::{PluginControlError, PluginTargetFailure};
use crate::plugin_execution::ExecutionState;

impl RendererRuntime {
    pub(crate) fn pending_package_disables(&self) -> Vec<String> {
        self.pending_package_disables.iter().cloned().collect()
    }
    pub(crate) fn acknowledge_package_disable(&mut self, id: &str) {
        self.pending_package_disables.remove(id);
    }

    pub(crate) fn logical_plugins(&self) -> Vec<LoadedPlugin> {
        let plugins: BTreeMap<_, _> = self
            .host_plugins
            .iter()
            .chain(&self.plugins)
            .map(|plugin| (plugin.manifest.id.clone(), plugin.clone()))
            .collect();
        plugins.into_values().collect()
    }

    pub(crate) fn package_generations(&self) -> BTreeMap<String, u64> {
        self.generations.clone()
    }

    pub(crate) fn validate_package_shape(
        &self,
        plugin: &LoadedPlugin,
    ) -> Result<(), PluginControlError> {
        let shape = (
            plugin.manifest.renderer.is_some(),
            plugin.manifest.host.is_some(),
        );
        if self
            .entry_shapes
            .get(&plugin.manifest.id)
            .is_some_and(|current| *current != shape)
        {
            return Err(PluginControlError::new(
                "executor_kind_changed",
                format!(
                    "plugin {} already owns a different set of entries; changing entry kinds requires restarting Codlet",
                    plugin.manifest.id
                ),
            ));
        }
        Ok(())
    }

    pub(crate) fn begin_package_management(
        &mut self,
        generations: BTreeMap<String, u64>,
        plugins: &[LoadedPlugin],
    ) -> Result<(), PluginControlError> {
        if self.management_active || self.drive_depth != 0 || self.drive_deadline.is_some() {
            return Err(PluginControlError::new(
                "runtime_busy",
                "a renderer lifecycle operation is in progress",
            ));
        }
        self.flush_host_actions();
        self.management_active = true;
        self.generations = generations;
        for plugin in plugins {
            self.entry_shapes.insert(
                plugin.manifest.id.clone(),
                (
                    plugin.manifest.renderer.is_some(),
                    plugin.manifest.host.is_some(),
                ),
            );
        }
        self.publish_status();
        Ok(())
    }

    pub(crate) fn finish_package_management(
        &mut self,
        registry: PluginRegistry,
        generations: BTreeMap<String, u64>,
    ) {
        self.plugin_registry = registry;
        self.generations = generations;
        self.management_active = false;
        self.drive_deadline = None;
        self.publish_status();
        self.flush_host_actions();
    }

    pub(crate) fn package_has_live_target(&self) -> bool {
        self.sessions
            .values()
            .any(|session| session.session.is_live() && !session.recovery_pending)
    }

    pub(crate) fn package_is_active(&self, plugin: &LoadedPlugin) -> bool {
        let host_ready = plugin.manifest.host.is_none()
            || self.external_observations.iter().any(|observation| {
                observation.plugin.manifest.id == plugin.manifest.id
                    && observation.plugin.generation == plugin.generation
                    && observation.state == ExecutionState::Active
            });
        let renderer_ready = plugin.manifest.renderer.is_none()
            || (self.package_has_live_target()
                && self
                    .sessions
                    .values()
                    .filter(|session| session.session.is_live())
                    .all(|session| {
                        !session.recovery_pending
                            && session.plugins.iter().any(|active| {
                                active.id == plugin.manifest.id
                                    && active.generation == plugin.generation
                                    && active.state == RendererPluginState::Active
                                    && active.activation_confirmed
                                    && active.context_id.is_some()
                            })
                    }));
        host_ready && renderer_ready
    }

    pub(crate) fn retire_package_renderers(
        &mut self,
        affected: &BTreeSet<String>,
        stage: &str,
    ) -> Vec<PluginTargetFailure> {
        self.drive_deadline = self.management_phase_deadline();
        let failures = self.retire_managed_plugins(affected, stage);
        self.drive_deadline = None;
        // Native declarations survive renderer cleanup because deactivate may
        // still call its host. All entry leases retire before native stop.
        self.remove_managed_providers(affected);
        for id in affected {
            let _ = self.capabilities.unregister_provider(&host_provider_id(id));
        }
        self.plugins
            .retain(|plugin| !affected.contains(&plugin.manifest.id));
        self.host_plugins
            .retain(|plugin| !affected.contains(&plugin.manifest.id));
        failures
    }

    pub(crate) fn activate_package_renderers(
        &mut self,
        plugins: &[LoadedPlugin],
        stage: &str,
    ) -> Vec<PluginTargetFailure> {
        for plugin in plugins
            .iter()
            .filter(|plugin| plugin.manifest.host.is_some())
        {
            if let Err(error) = self.require_native_ready(&plugin.manifest.id, plugin.generation) {
                return vec![failure(&plugin.manifest.id, stage, error.to_string())];
            }
            let grants = plugin
                .manifest
                .permissions
                .iter()
                .map(|permission| permission.as_str().to_owned())
                .collect::<Vec<_>>();
            if let Err(error) = self.capabilities.register_provider(
                &host_provider_id(&plugin.manifest.id),
                plugin.generation,
                plugin.manifest.host_provides(),
                &[],
                &grants,
            ) {
                return vec![failure(&plugin.manifest.id, stage, error.to_string())];
            }
            self.host_plugins.push(plugin.clone());
        }
        let renderers: Vec<_> = plugins
            .iter()
            .filter(|plugin| plugin.manifest.renderer.is_some())
            .cloned()
            .collect();
        self.plugins.extend(renderers.clone());
        self.drive_deadline = self.management_phase_deadline();
        let failures = self.activate_managed_plugins(&renderers, stage);
        self.drive_deadline = None;
        failures
    }

    pub(crate) fn commit_package_entries(&mut self, entries: Vec<PluginCatalogEntry>) {
        for entry in entries {
            self.catalog.replace_entry(entry);
        }
    }

    pub(crate) fn retire_all_package_renderers(&mut self) -> Vec<PluginTargetFailure> {
        let affected = self
            .logical_plugins()
            .iter()
            .map(|plugin| plugin.manifest.id.clone())
            .collect();
        self.retire_package_renderers(&affected, "shutdown")
    }

    fn require_native_ready(&self, plugin_id: &str, generation: u64) -> Result<(), RendererError> {
        if self.external_observations.iter().any(|observation| {
            observation.plugin.manifest.id == plugin_id
                && observation.plugin.generation == generation
                && observation.state == ExecutionState::Active
        }) {
            Ok(())
        } else {
            Err(RendererError::PluginRejected {
                plugin_id: plugin_id.into(),
                message: "the native host entry has not reached Ready at the required generation"
                    .into(),
            })
        }
    }

    pub(super) fn require_native_dependencies_ready(
        &self,
        plugin: &LoadedPlugin,
        authorizations: &TargetAuthorizations,
    ) -> Result<(), RendererError> {
        if plugin.manifest.host.is_some() {
            self.require_native_ready(&plugin.manifest.id, plugin.generation)?;
        }
        if let Some((principal, leases)) = authorizations.get(&plugin.manifest.id) {
            for lease in leases.values() {
                let owner =
                    self.capabilities
                        .invoke_endpoint(principal, lease, |provider, _| provider.to_owned())?;
                if let Some(id) = host_provider_plugin_id(&owner) {
                    self.require_native_ready(
                        id,
                        self.capabilities
                            .provider_generation(&owner)
                            .expect("authorized provider exists"),
                    )?;
                }
            }
        }
        Ok(())
    }
}

fn failure(plugin_id: &str, stage: &str, error: String) -> PluginTargetFailure {
    PluginTargetFailure {
        target_id: String::new(),
        plugin_id: plugin_id.into(),
        stage: stage.into(),
        error,
    }
}
