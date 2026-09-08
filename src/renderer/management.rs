//! Foreground lifecycle execution. Transport and CLI code only submit typed
//! requests; all renderer ownership and compensation remain on this thread.

use super::*;
use crate::plugin_control::{
    PluginControlAction, PluginControlError, PluginControlOutcome, PluginControlReport,
    PluginControlRequest, PluginGeneration, PluginTargetFailure,
};
use crate::plugin_lifecycle::{self, ActivationPlan, LifecycleError};

impl RendererRuntime {
    pub fn manage_plugin(
        &mut self,
        request: PluginControlRequest,
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
        let result = self.manage_plugin_inner(&request);
        self.drive_deadline = None;
        self.management_active = false;
        self.publish_status();
        self.flush_host_actions();
        result
    }

    fn manage_plugin_inner(
        &mut self,
        request: &PluginControlRequest,
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
