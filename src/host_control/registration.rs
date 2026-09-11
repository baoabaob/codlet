//! Import commits explicit trust through the foreground coordinator, then uses
//! the same package activation transaction as Enable under the original receipt.
use super::*;

impl HostControl {
    pub(super) fn dispatch_import(
        &mut self,
        job: ControlJob,
        renderer: &mut RendererRuntime,
        hosts: &HostRuntime,
        broker: &ControlBroker,
    ) {
        let receipt = job.operation_id.clone();
        let result = (|| {
            job.request.validate()?;
            let id = &job.request.plugin_id;
            if renderer
                .logical_plugins()
                .iter()
                .any(|plugin| plugin.manifest.id == *id)
                || hosts.observations().iter().any(|observation| {
                    observation.plugin.manifest.id == *id
                        && matches!(
                            observation.state,
                            ExecutionState::Starting
                                | ExecutionState::Active
                                | ExecutionState::Stopping
                        )
                })
            {
                return Err(PluginControlError::new(
                    "plugin_active",
                    "Stop the existing package before importing or changing its grants.",
                ));
            }
            let registry = PluginRegistry::load(&self.registry_path).map_err(registry_error)?;
            let selection = job.request.local_import.as_ref().expect("validated import");
            let (mut registry, entry) = crate::local_import::stage(&registry, id, selection)?;
            let plugin = entry.plugin.as_ref().expect("import validated source");
            renderer.validate_package_shape(plugin)?;
            if selection.enable {
                let mut next = renderer.logical_plugins();
                next.push(plugin.clone());
                HostRuntime::validate_plugins(
                    &next
                        .iter()
                        .filter(|plugin| plugin.host.is_some())
                        .cloned()
                        .collect::<Vec<_>>(),
                )
                .map_err(host_error)?;
                plugin_lifecycle::order(next).map_err(lifecycle_error)?;
            }
            registry.save().map_err(registry_error)?;
            renderer.commit_package_entries(vec![PluginCatalogEntry {
                id: entry.id.clone(),
                source: entry.source.clone(),
                plugin: Ok(plugin.clone()),
            }]);
            let enable = selection.enable;
            if !enable {
                let report = PluginControlReport {
                    action: PluginControlAction::Import, plugin_id: id.clone(), outcome: PluginControlOutcome::Applied,
                    desired_enabled: false, affected_plugin_ids: vec![id.clone()], generations: Vec::new(), target_failures: Vec::new(),
                    message: Some("Local development directory registered and left disabled. Author files are preserved.".into()),
                };
                renderer.finish_package_management(registry, self.generations.clone());
                return Ok(Prepared::Complete(report));
            }
            self.watch_sources
                .insert(id.clone(), registry.local_plugins()[id].clone());
            // The receipt remains Import; starts_plugin gives it normal Enable semantics.
            match self.prepare_package(job, registry.clone(), Some(entry), renderer, hosts) {
                Ok(prepared) => Ok(prepared),
                Err(error) => {
                    renderer.finish_package_management(registry, self.generations.clone());
                    Err(PluginControlError::new(
                        "import_activation_failed",
                        format!(
                            "The directory was registered and remains disabled. Activation failed: {error}"
                        ),
                    ))
                }
            }
        })();
        match result {
            Ok(Prepared::Complete(report)) => broker.complete(&receipt, Ok(report)),
            Ok(Prepared::Pending(pending)) => self.pending = Some(pending),
            Err(error) => broker.complete(&receipt, Err(error)),
        }
    }
}
