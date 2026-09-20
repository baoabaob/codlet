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
        if job
            .request
            .local_import
            .as_ref()
            .is_some_and(|selection| selection.managed.is_some())
        {
            self.dispatch_managed(job, renderer, hosts, broker);
            return;
        }
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

    fn dispatch_managed(
        &mut self,
        job: ControlJob,
        renderer: &mut RendererRuntime,
        hosts: &HostRuntime,
        broker: &ControlBroker,
    ) {
        let receipt = job.operation_id.clone();
        let result = (|| {
            job.request.validate()?;
            let id = job.request.plugin_id.clone();
            if job.request.action == PluginControlAction::Import
                && renderer
                    .logical_plugins()
                    .iter()
                    .any(|plugin| plugin.manifest.id == id)
            {
                return Err(PluginControlError::new(
                    "plugin_active",
                    "An active identity must be changed through its existing managed update transaction.",
                ));
            }
            let previous = PluginRegistry::load(&self.registry_path).map_err(registry_error)?;
            let selection = job
                .request
                .local_import
                .as_ref()
                .expect("validated managed selection");
            let (mut candidate, entry) = crate::managed_plugins::stage(&previous, &id, selection)?;
            renderer.validate_package_shape(entry.plugin.as_ref().expect("validated package"))?;
            crate::managed_storage::checkpoint_registration(&candidate, &previous, &id)?;
            candidate.save().map_err(registry_error)?;
            // Both running replacements and stopped registrations use one receipt.
            // Package rollback first restores this exact prior registry snapshot.
            let prepared =
                self.prepare_package(job, candidate.clone(), Some(entry), renderer, hosts);
            match prepared {
                Ok(Prepared::Pending(mut pending)) => {
                    pending.set_managed_previous(previous);
                    self.watch_sources.remove(&id);
                    Ok(Prepared::Pending(pending))
                }
                Ok(complete) => Ok(complete),
                Err(error) => {
                    match crate::managed_plugins::restore_previous(&candidate, &previous, &id) {
                        Ok(restored) => {
                            renderer.finish_package_management(restored, self.generations.clone());
                            Err(PluginControlError::new(
                                "managed_activation_failed",
                                format!(
                                    "The requested change failed and the previous registration was restored: {error}"
                                ),
                            ))
                        }
                        Err(restoration) => {
                            renderer.finish_package_management(candidate, self.generations.clone());
                            Err(PluginControlError::new(
                                "managed_restore_failed",
                                format!(
                                    "The requested change failed: {error}. Registration restoration failed: {restoration}. Review current state before retrying."
                                ),
                            ))
                        }
                    }
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
