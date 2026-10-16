//! Folder imports and downloaded packages share one installation transaction.
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
            let id = job.request.plugin_id.clone();
            let previous = PluginRegistry::load(&self.registry_path).map_err(registry_error)?;
            let selection = job
                .request
                .local_import
                .as_ref()
                .expect("validated installation");
            let (mut candidate, entry) = crate::local_import::stage(&previous, &id, selection)?;
            if selection.resets_data(&previous, &id) {
                renderer.reset_package_shape(&id);
            }
            let prepared = (|| {
                renderer
                    .validate_package_shape(entry.plugin.as_ref().expect("validated package"))?;
                crate::managed_storage::checkpoint_registration(&candidate, &previous, &id)?;
                candidate.save().map_err(registry_error)?;
                self.prepare_package(job, candidate.clone(), Some(entry), renderer, hosts)
            })();
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
                            crate::installation_files::discard_folder_stage(&candidate, &id)?;
                            Err(PluginControlError::new(
                                "installation_failed",
                                format!(
                                    "Installation failed; the previous registration was restored: {error}"
                                ),
                            ))
                        }
                        Err(restoration) => {
                            renderer.finish_package_management(candidate, self.generations.clone());
                            Err(PluginControlError::new(
                                "installation_restore_failed",
                                format!(
                                    "Installation failed: {error}. Restoration failed: {restoration}"
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
