//! Foreground lifecycle execution. Transport and CLI code only submit typed
//! requests; all renderer ownership and compensation remain on this thread.

use super::*;
use crate::plugin_control::{
    PluginControlAction, PluginControlError, PluginControlOutcome, PluginControlReport,
    PluginControlRequest, PluginGeneration, PluginTargetFailure,
};
use crate::plugin_lifecycle::{self, ActivationPlan, LifecycleError};

#[derive(Clone, Copy, PartialEq, Eq)]
enum SourcePolicy {
    CurrentRegistration,
    LoadedLocalPaths,
}

impl RendererRuntime {
    pub fn manage_plugin(
        &mut self,
        request: PluginControlRequest,
    ) -> Result<PluginControlReport, PluginControlError> {
        self.manage_plugin_with_policy(request, SourcePolicy::CurrentRegistration)
    }

    pub(crate) fn manage_watched_plugin(
        &mut self,
        request: PluginControlRequest,
    ) -> Result<PluginControlReport, PluginControlError> {
        if request.action != PluginControlAction::Reload {
            return Err(PluginControlError::new(
                "watch_reload_only",
                "file watching can only reload a currently loaded plugin",
            ));
        }
        self.manage_plugin_with_policy(request, SourcePolicy::LoadedLocalPaths)
    }

    fn manage_plugin_with_policy(
        &mut self,
        request: PluginControlRequest,
        source_policy: SourcePolicy,
    ) -> Result<PluginControlReport, PluginControlError> {
        request.validate()?;
        if self.management_active || self.drive_depth != 0 || self.drive_deadline.is_some() {
            return Err(PluginControlError::new(
                "runtime_busy",
                "a renderer lifecycle operation is in progress",
            ));
        }
        self.flush_host_actions();
        self.management_active = true;
        self.drive_deadline = self.management_phase_deadline();
        let result = self.manage_plugin_inner(&request, source_policy);
        self.drive_deadline = None;
        self.management_active = false;
        self.publish_status();
        self.flush_host_actions();
        result
    }

    fn manage_plugin_inner(
        &mut self,
        request: &PluginControlRequest,
        source_policy: SourcePolicy,
    ) -> Result<PluginControlReport, PluginControlError> {
        let registry = PluginRegistry::load(self.plugin_registry.path())
            .map_err(|error| control_error(error.into()))?;
        let id = &request.plugin_id;
        match request.action {
            PluginControlAction::Disable => {
                plugin_lifecycle::validate_disable(&self.plugins, &self.catalog, &registry, id)
                    .map_err(control_error)?;
                let was_enabled = registry.is_enabled(id);
                let was_running = self.plugins.iter().any(|plugin| plugin.manifest.id == *id);
                self.plugin_registry = plugin_lifecycle::persist_preference(&registry, id, false)
                    .map_err(control_error)?;
                let affected = BTreeSet::from([id.clone()]);
                let failures = self.disable_committed(id);
                Ok(self.control_report(
                    request,
                    if !failures.is_empty() {
                        PluginControlOutcome::Degraded
                    } else if !was_enabled && !was_running {
                        PluginControlOutcome::Unchanged
                    } else {
                        PluginControlOutcome::Applied
                    },
                    &affected,
                    failures,
                    None,
                ))
            }
            PluginControlAction::Enable | PluginControlAction::Reload => {
                if source_policy == SourcePolicy::LoadedLocalPaths {
                    self.verify_watched_paths(id, &registry)?;
                }
                let exists = self.plugins.iter().any(|plugin| plugin.manifest.id == *id);
                if request.action == PluginControlAction::Enable
                    && exists
                    && self
                        .sessions
                        .values()
                        .filter(|session| session.session.is_live())
                        .all(|session| {
                            !session.recovery_pending
                                && session.plugins.iter().any(|plugin| {
                                    plugin.id == *id
                                        && plugin.state == RendererPluginState::Active
                                        && plugin.activation_confirmed
                                        && plugin.context_id.is_some()
                                })
                        })
                {
                    let current = self
                        .plugins
                        .iter()
                        .find(|plugin| plugin.manifest.id == *id)
                        .expect("running plugin exists");
                    plugin_lifecycle::validate_snapshot_trust(current, &self.catalog, &registry)
                        .map_err(control_error)?;
                    let already_enabled = registry.is_enabled(id);
                    self.plugin_registry =
                        plugin_lifecycle::persist_preference(&registry, id, true)
                            .map_err(control_error)?;
                    return Ok(self.control_report(
                        request,
                        if already_enabled {
                            PluginControlOutcome::Unchanged
                        } else {
                            PluginControlOutcome::Applied
                        },
                        &BTreeSet::from([id.clone()]),
                        Vec::new(),
                        None,
                    ));
                }
                let plan = ActivationPlan::prepare(
                    id,
                    request.action == PluginControlAction::Reload || exists,
                    &self.plugins,
                    &self.catalog,
                    &registry,
                    &mut self.generations,
                )
                .map_err(control_error)?;
                plugin_lifecycle::verify_registrations(&registry, &plan.affected)
                    .map_err(control_error)?;
                self.plugin_registry = registry.clone();
                Ok(self.execute_activation(request, plan, registry))
            }
        }
    }

    fn verify_watched_paths(
        &self,
        plugin_id: &str,
        registry: &PluginRegistry,
    ) -> Result<(), PluginControlError> {
        let affected = plugin_lifecycle::dependent_closure(&self.plugins, plugin_id);
        for entry in self
            .catalog
            .entries()
            .iter()
            .filter(|entry| affected.contains(&entry.id))
        {
            if let crate::catalog::PluginSource::Local { path, .. } = &entry.source
                && registry
                    .local_plugins()
                    .get(&entry.id)
                    .is_none_or(|registration| registration.path != *path)
            {
                return Err(PluginControlError::new(
                    "watch_source_changed",
                    format!(
                        "plugin {} no longer has its loaded local directory registered; select the source with a manual enable or reload",
                        entry.id
                    ),
                ));
            }
        }
        Ok(())
    }

    /// Called only after the disable preference was durably committed. The GUI
    /// schedules this same executor after delivering disableSelf's response.
    pub(super) fn disable_committed(&mut self, plugin_id: &str) -> Vec<PluginTargetFailure> {
        let previous_deadline = self.drive_deadline;
        self.drive_deadline = previous_deadline.or_else(|| self.management_phase_deadline());
        let affected = BTreeSet::from([plugin_id.to_owned()]);
        let failures = self.retire_managed_plugins(&affected, "deactivate");
        self.remove_managed_providers(&affected);
        self.plugins
            .retain(|plugin| !affected.contains(&plugin.manifest.id));
        self.drive_deadline = previous_deadline;
        failures
    }

    fn management_phase_deadline(&self) -> Option<Instant> {
        self.sessions
            .values()
            .filter(|session| session.session.is_live())
            .filter_map(|session| session.session.request_deadline().ok())
            .min()
    }

    fn execute_activation(
        &mut self,
        request: &PluginControlRequest,
        mut plan: ActivationPlan,
        expected_registry: PluginRegistry,
    ) -> PluginControlReport {
        let mut failures = self.retire_managed_plugins(&plan.affected, "deactivate");
        self.remove_managed_providers(&plan.affected);
        let replacements = plan.replacements();
        self.plugins = plan.next.clone();
        if failures.is_empty() {
            failures.extend(self.activate_managed_plugins(&replacements, "activate"));
        }
        if failures.is_empty() {
            let commit = if request.action == PluginControlAction::Enable {
                plugin_lifecycle::persist_preference_with_guards(
                    &expected_registry,
                    &request.plugin_id,
                    true,
                    &plan.affected,
                )
            } else {
                plugin_lifecycle::verify_registrations(&expected_registry, &plan.affected)
            };
            match commit {
                Ok(registry) => self.plugin_registry = registry,
                Err(error) => failures.push(global_failure(
                    &request.plugin_id,
                    "commit",
                    error.to_string(),
                )),
            }
        }
        if failures.is_empty() {
            for entry in plan.entries.drain(..) {
                self.catalog.replace_entry(entry);
            }
            return self.control_report(
                request,
                PluginControlOutcome::Applied,
                &plan.affected,
                failures,
                None,
            );
        }

        // Every candidate resource is retired before any old code is restored.
        // Re-registering old code always consumes a fresh generation and fresh
        // capability epochs; prior worlds, bindings and leases remain retired.
        self.drive_deadline = self.management_phase_deadline();
        failures.extend(self.retire_managed_plugins(&plan.affected, "rollback_cleanup"));
        self.remove_managed_providers(&plan.affected);
        self.plugins
            .retain(|plugin| !plan.affected.contains(&plugin.manifest.id));
        let compensation_start = failures.len();
        if !plan.previous.is_empty() {
            let restored = PluginRegistry::load(self.plugin_registry.path())
                .map_err(LifecycleError::from)
                .and_then(|registry| {
                    self.plugin_registry = registry.clone();
                    let plugins = plugin_lifecycle::rollback_plugins(
                        &plan.previous,
                        &self.catalog,
                        &registry,
                        &mut self.generations,
                    )?;
                    Ok(plugins)
                });
            match restored {
                Ok(restored) => {
                    let mut next = self.plugins.clone();
                    next.extend(restored.clone());
                    match plugin_lifecycle::order(next) {
                        Ok(next) => {
                            self.plugins = next;
                            failures.extend(
                                self.activate_managed_plugins(&restored, "rollback_activate"),
                            );
                            if failures.len() == compensation_start
                                && let Err(error) = plugin_lifecycle::verify_registrations(
                                    &self.plugin_registry,
                                    &plan.affected,
                                )
                            {
                                failures.push(global_failure(
                                    &request.plugin_id,
                                    "rollback_validate",
                                    error.to_string(),
                                ));
                            }
                        }
                        Err(error) => failures.push(global_failure(
                            &request.plugin_id,
                            "rollback_validate",
                            error.to_string(),
                        )),
                    }
                }
                Err(error) => failures.push(global_failure(
                    &request.plugin_id,
                    "rollback_validate",
                    error.to_string(),
                )),
            }
        }
        let restored = failures.len() == compensation_start;
        if !restored {
            failures.extend(self.retire_managed_plugins(&plan.affected, "rollback_retire"));
            self.remove_managed_providers(&plan.affected);
            self.plugins
                .retain(|plugin| !plan.affected.contains(&plugin.manifest.id));
        }
        let cleanup_unconfirmed = failures.iter().any(|failure| {
            matches!(
                failure.stage.as_str(),
                "deactivate" | "rollback_cleanup" | "rollback_retire"
            )
        });
        let message = if restored && cleanup_unconfirmed {
            "The prior runtime code was restored, but renderer cleanup failed; affected targets require inspection."
        } else if restored {
            "The requested change failed; the prior runtime state was restored with fresh generations."
        } else {
            "The requested change and its compensation failed; affected plugins remain stopped in this runtime."
        };
        self.control_report(
            request,
            if restored && !cleanup_unconfirmed {
                PluginControlOutcome::RolledBack
            } else {
                PluginControlOutcome::Degraded
            },
            &plan.affected,
            failures,
            Some(message.into()),
        )
    }

    fn retire_managed_plugins(
        &mut self,
        affected: &BTreeSet<String>,
        stage: &str,
    ) -> Vec<PluginTargetFailure> {
        let mut target_ids: Vec<_> = self.sessions.keys().cloned().collect();
        target_ids.sort();
        let mut failures = Vec::new();
        for target_id in target_ids {
            let plugins: Vec<_> = self
                .sessions
                .get(&target_id)
                .into_iter()
                .flat_map(|session| session.plugins.iter().rev())
                .filter(|plugin| affected.contains(&plugin.id))
                .map(|plugin| plugin.id.clone())
                .collect();
            for plugin_id in plugins {
                if let Err(error) = self.deactivate_plugin(&target_id, &plugin_id) {
                    failures.push(PluginTargetFailure {
                        target_id: target_id.clone(),
                        plugin_id,
                        stage: stage.into(),
                        error: error.to_string(),
                    });
                }
            }
        }
        failures
    }

    fn remove_managed_providers(&mut self, affected: &BTreeSet<String>) {
        for id in affected {
            let _ = self.capabilities.unregister_provider(id);
        }
    }

    fn activate_managed_plugins(
        &mut self,
        plugins: &[LoadedPlugin],
        stage: &str,
    ) -> Vec<PluginTargetFailure> {
        for plugin in plugins {
            let grants: Vec<_> = plugin
                .manifest
                .permissions
                .iter()
                .map(|permission| permission.as_str().to_owned())
                .collect();
            if let Err(error) = self.capabilities.register_provider(
                &plugin.manifest.id,
                plugin.generation,
                &plugin.manifest.provides,
                &plugin.manifest.requires,
                &grants,
            ) {
                return vec![global_failure(
                    &plugin.manifest.id,
                    stage,
                    error.to_string(),
                )];
            }
        }
        let mut target_ids: Vec<_> = self.sessions.keys().cloned().collect();
        target_ids.sort();
        let mut failures = Vec::new();
        for target_id in target_ids {
            if self.ensure_live_target(&target_id).is_err() {
                continue;
            }
            let result = if self.sessions[&target_id].recovery_pending {
                Err(RendererError::PluginRejected {
                    plugin_id: plugins
                        .first()
                        .map(|plugin| plugin.manifest.id.clone())
                        .unwrap_or_default(),
                    message: "main document recovery is pending".into(),
                })
            } else {
                self.resolve_plugin_authorizations(
                    plugins,
                    &CapabilityScopeInstance::Target(target_id.clone()),
                )
                .map_err(RendererError::from)
                .and_then(|authorizations| {
                    self.install_plugins(&target_id, plugins.to_vec(), authorizations)
                })
            };
            if let Err(error) = result {
                let plugin_id = match &error {
                    RendererError::PluginRejected { plugin_id, .. }
                    | RendererError::BootstrapRejected { plugin_id, .. } => plugin_id.clone(),
                    _ => plugins
                        .first()
                        .map(|plugin| plugin.manifest.id.clone())
                        .unwrap_or_default(),
                };
                failures.push(PluginTargetFailure {
                    target_id,
                    plugin_id,
                    stage: stage.into(),
                    error: error.to_string(),
                });
            }
        }
        failures
    }

    fn control_report(
        &self,
        request: &PluginControlRequest,
        outcome: PluginControlOutcome,
        affected: &BTreeSet<String>,
        target_failures: Vec<PluginTargetFailure>,
        message: Option<String>,
    ) -> PluginControlReport {
        PluginControlReport {
            action: request.action,
            plugin_id: request.plugin_id.clone(),
            outcome,
            desired_enabled: self.plugin_registry.is_enabled(&request.plugin_id),
            affected_plugin_ids: affected.iter().cloned().collect(),
            generations: self
                .plugins
                .iter()
                .filter(|plugin| affected.contains(&plugin.manifest.id))
                .map(|plugin| PluginGeneration {
                    plugin_id: plugin.manifest.id.clone(),
                    generation: plugin.generation,
                })
                .collect(),
            target_failures,
            message,
        }
    }
}

fn control_error(error: LifecycleError) -> PluginControlError {
    PluginControlError::new(error.code(), error.to_string())
}

fn global_failure(plugin_id: &str, stage: &str, error: String) -> PluginTargetFailure {
    PluginTargetFailure {
        target_id: String::new(),
        plugin_id: plugin_id.to_owned(),
        stage: stage.to_owned(),
        error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_watch::PluginWatcher;
    use crate::plugins::LocalPluginRegistration;
    use tempfile::tempdir;

    #[test]
    fn watched_reload_rejects_a_consumer_path_changed_after_poll_before_reading_sources() {
        let directory = tempdir().unwrap();
        let registry_path = directory.path().join("config.json");
        let mut registry = PluginRegistry::load(&registry_path).unwrap();
        for id in ["codlet", "codex.ui.adapter"] {
            registry.set_enabled(id, false).unwrap();
        }
        for id in ["dev.provider", "dev.consumer"] {
            let root = directory.path().join(id);
            std::fs::create_dir(&root).unwrap();
            let descriptor = json!([{"name":"dev.api","api":1,"scope":"target"}]);
            let mut manifest = json!({"schema":1,"id":id,"version":"1","renderer":{"entry":"renderer.js","world":"isolated"}});
            manifest[if id == "dev.provider" {
                "provides"
            } else {
                "requires"
            }] = descriptor;
            std::fs::write(root.join("plugin.json"), manifest.to_string()).unwrap();
            std::fs::write(root.join("renderer.js"), "module.exports = {};").unwrap();
            registry
                .register_local(
                    id,
                    LocalPluginRegistration {
                        path: root,
                        grants: vec![],
                    },
                )
                .unwrap();
        }
        registry.save().unwrap();
        let catalog = PluginCatalog::load(&registry).unwrap();
        let mut runtime = RendererRuntime::from_catalog(catalog, registry.clone()).unwrap();
        let mut watcher = PluginWatcher::new(registry_path.clone());
        let now = Instant::now();
        assert!(watcher.poll(now, &runtime.local_watch_sources()).is_none());
        std::fs::write(
            directory.path().join("dev.provider/renderer.js"),
            "// saved\nmodule.exports = {};",
        )
        .unwrap();
        assert!(
            watcher
                .poll(
                    now + Duration::from_millis(250),
                    &runtime.local_watch_sources()
                )
                .is_none()
        );
        let request = watcher
            .poll(
                now + Duration::from_millis(500),
                &runtime.local_watch_sources(),
            )
            .unwrap();
        let replacement = directory.path().join("replacement-consumer");
        std::fs::create_dir(&replacement).unwrap();
        std::fs::copy(
            directory.path().join("dev.consumer/plugin.json"),
            replacement.join("plugin.json"),
        )
        .unwrap();
        std::fs::write(
            replacement.join("renderer.js"),
            "// different trusted root\nmodule.exports = {};",
        )
        .unwrap();
        registry.remove_local("dev.consumer").unwrap();
        registry.save().unwrap();
        registry
            .register_local(
                "dev.consumer",
                LocalPluginRegistration {
                    path: replacement.clone(),
                    grants: vec![],
                },
            )
            .unwrap();
        registry.save().unwrap();

        let provider_manifest = directory.path().join("dev.provider/plugin.json");
        let original = std::fs::read(&provider_manifest).unwrap();
        std::fs::write(&provider_manifest, "invalid source after the poll").unwrap();
        let error = runtime.manage_watched_plugin(request.clone()).unwrap_err();
        assert_eq!(error.code, "watch_source_changed");
        assert!(
            runtime
                .generations
                .values()
                .all(|generation| *generation == 1)
        );
        assert_eq!(
            runtime
                .local_watch_sources()
                .iter()
                .find(|source| source.plugin.manifest.id == "dev.consumer")
                .unwrap()
                .path,
            directory.path().join("dev.consumer")
        );
        std::fs::write(provider_manifest, original).unwrap();
        assert_eq!(
            runtime.manage_plugin(request).unwrap().outcome,
            PluginControlOutcome::Applied
        );
        assert_eq!(
            runtime
                .local_watch_sources()
                .iter()
                .find(|source| source.plugin.manifest.id == "dev.consumer")
                .unwrap()
                .path,
            replacement
        );
        assert_eq!(
            runtime
                .manage_watched_plugin(PluginControlRequest {
                    action: PluginControlAction::Enable,
                    plugin_id: "dev.consumer".into()
                })
                .unwrap_err()
                .code,
            "watch_reload_only"
        );
    }
}
