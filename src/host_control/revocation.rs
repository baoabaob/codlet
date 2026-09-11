//! Revoked authority is never restored by a replacement failure.
use super::*;
use crate::plugin_control::PluginControlRequest;
use std::time::{Duration, Instant};

pub(super) struct PendingRevocation {
    job: Option<ControlJob>,
    request: PluginControlRequest,
    registry: PluginRegistry,
    affected: BTreeSet<String>,
    retiring: Vec<Retiring>,
    failures: Vec<PluginTargetFailure>,
    unchanged: bool,
    deadline: Instant,
}
struct Retiring {
    id: String,
    generation: u64,
    operation: Option<HostOperation>,
}
struct RevocationPlan {
    job: Option<ControlJob>,
    request: PluginControlRequest,
    registry: PluginRegistry,
    affected: BTreeSet<String>,
    unchanged: bool,
}

impl HostControl {
    pub(super) fn dispatch_revoke(
        &mut self,
        job: ControlJob,
        renderer: &mut RendererRuntime,
        hosts: &HostRuntime,
        broker: &ControlBroker,
    ) {
        let receipt = job.operation_id.clone();
        let result = (|| {
            job.request.validate()?;
            if self.is_pending() {
                return Err(PluginControlError::new(
                    "runtime_busy",
                    "Another lifecycle transaction is in progress.",
                ));
            }
            let request = job.request.clone();
            let id = &request.plugin_id;
            let mut registry = PluginRegistry::load(&self.registry_path).map_err(registry_error)?;
            let current = renderer.logical_plugins();
            if !registry.local_plugins().contains_key(id)
                && !current.iter().any(|plugin| plugin.manifest.id == *id)
            {
                return Err(PluginControlError::new(
                    "plugin_not_found",
                    "No local registration or running package has this ID.",
                ));
            }
            if renderer
                .catalog_snapshot()
                .entries()
                .iter()
                .any(|entry| entry.id == *id && matches!(entry.source, PluginSource::Bundled))
            {
                return Err(PluginControlError::new(
                    "bundled_registration",
                    "Bundled installations cannot be removed or have permissions revoked; disable the package instead.",
                ));
            }
            let removing = request.action == PluginControlAction::Remove;
            let affected = if removing {
                if !request.cascade {
                    plugin_lifecycle::validate_disable(
                        &current,
                        renderer.catalog_snapshot(),
                        &registry,
                        id,
                    )
                    .map_err(lifecycle_error)?;
                }
                plugin_lifecycle::disable_closure(
                    &current,
                    renderer.catalog_snapshot(),
                    &registry,
                    id,
                )
                .map_err(lifecycle_error)?
            } else {
                plugin_lifecycle::dependent_closure(&current, id)
            };
            self.prepare_authority_retirement(renderer)?;
            let changed = if removing {
                let changed = registry.local_plugins().contains_key(id) || registry.is_enabled(id);
                let saved = (|| {
                    for affected_id in &affected {
                        if let Some(registration) =
                            registry.local_plugins().get(affected_id).cloned()
                        {
                            registry.register_local(affected_id, registration)?;
                        }
                        registry.set_enabled(affected_id, false)?;
                    }
                    if registry.local_plugins().contains_key(id) {
                        registry.remove_local(id)?;
                    }
                    registry.save()
                })();
                if let Err(error) = saved {
                    renderer.finish_package_management(registry, self.generations.clone());
                    return Err(registry_error(error));
                }
                changed
            } else if registry.local_plugins().contains_key(id) {
                match registry
                    .revoke_permission(id, request.permission.expect("validated revoke"))
                    .and_then(|changed| registry.save().map(|()| changed))
                {
                    Ok(changed) => changed,
                    Err(error) => {
                        renderer.finish_package_management(registry, self.generations.clone());
                        return Err(registry_error(error));
                    }
                }
            } else {
                false
            };
            let unchanged = !changed
                && !current
                    .iter()
                    .any(|plugin| affected.contains(&plugin.manifest.id));
            Ok(self.retire_authority(
                RevocationPlan {
                    job: Some(job),
                    request,
                    registry,
                    affected,
                    unchanged,
                },
                renderer,
                hosts,
            ))
        })();
        match result {
            Ok(pending) => self.revoking = Some(pending),
            Err(error) => broker.complete(&receipt, Err(error)),
        }
    }

    fn prepare_authority_retirement(
        &mut self,
        renderer: &mut RendererRuntime,
    ) -> Result<(), PluginControlError> {
        for (id, generation) in renderer.package_generations() {
            self.generations
                .entry(id)
                .and_modify(|value| *value = (*value).max(generation))
                .or_insert(generation);
        }
        renderer.begin_package_management(self.generations.clone(), &[])
    }

    fn retire_authority(
        &mut self,
        plan: RevocationPlan,
        renderer: &mut RendererRuntime,
        hosts: &HostRuntime,
    ) -> PendingRevocation {
        let RevocationPlan {
            job,
            request,
            registry,
            affected,
            unchanged,
        } = plan;
        let observations = hosts.observations();
        let mut failures = Vec::new();
        for observation in observations.iter().filter(|observation| {
            affected.contains(&observation.plugin.manifest.id) && is_live(observation.state)
        }) {
            if let Err(error) = hosts.revoke_authorization(
                &observation.plugin.manifest.id,
                observation.plugin.generation,
            ) {
                failures.push(failure(
                    &observation.plugin.manifest.id,
                    "revoke_authority",
                    error.to_string(),
                ));
            }
        }
        renderer.revoke_package_authority(&affected);
        failures.extend(renderer.retire_package_renderers(&affected, "revoke_cleanup"));
        let retiring = observations
            .into_iter()
            .filter(|observation| {
                affected.contains(&observation.plugin.manifest.id) && is_live(observation.state)
            })
            .map(|observation| Retiring {
                id: observation.plugin.manifest.id,
                generation: observation.plugin.generation,
                operation: None,
            })
            .collect();
        for id in &affected {
            self.watch_sources.remove(id);
        }
        PendingRevocation {
            job,
            request,
            registry,
            affected,
            retiring,
            failures,
            unchanged,
            deadline: Instant::now() + Duration::from_secs(30),
        }
    }

    /// Detect changed/removed registrations without adopting their new grants.
    /// Explicit revoke uses its receipt immediately; this scan also covers a
    /// registration edited by another process while a package is idle.
    pub fn reconcile_authorization(
        &mut self,
        renderer: &mut RendererRuntime,
        hosts: &HostRuntime,
        now: Instant,
    ) -> Result<(), PluginControlError> {
        if self.is_pending() || now < self.next_authorization_scan {
            return Ok(());
        }
        self.next_authorization_scan = now + Duration::from_millis(250);
        let registry = PluginRegistry::load(&self.registry_path).map_err(registry_error)?;
        let plugins = renderer.logical_plugins();
        let mut affected = BTreeSet::new();
        let mut first_changed = None;
        for plugin in &plugins {
            let id = &plugin.manifest.id;
            let entry = renderer
                .catalog_snapshot()
                .entries()
                .iter()
                .find(|entry| entry.id == *id);
            if entry.is_some_and(|entry| matches!(entry.source, PluginSource::Bundled)) {
                continue;
            }
            let registration = registry.local_plugins().get(id);
            let changed = if let Some(expected) = plugin.authorization.as_ref().or_else(|| {
                plugin
                    .host
                    .as_ref()
                    .and_then(|host| host.authorization.as_ref())
            }) {
                registration != Some(expected)
            } else {
                entry.is_some_and(|entry| match &entry.source {
                    PluginSource::Local { path, grants } => {
                        registration.is_none_or(|registration| {
                            registration.path != *path || registration.grants != *grants
                        })
                    }
                    PluginSource::Bundled => false,
                })
            };
            if changed {
                first_changed.get_or_insert_with(|| id.clone());
                affected.extend(plugin_lifecycle::dependent_closure(&plugins, id));
            }
        }
        let Some(id) = first_changed else {
            return Ok(());
        };
        self.prepare_authority_retirement(renderer)?;
        let request = PluginControlRequest {
            action: PluginControlAction::Revoke,
            plugin_id: id,
            permission: None,
            cascade: false,
            local_import: None,
        };
        self.revoking = Some(self.retire_authority(
            RevocationPlan {
                job: None,
                request,
                registry,
                affected,
                unchanged: false,
            },
            renderer,
            hosts,
        ));
        Ok(())
    }

    pub fn take_authorization_reports(&mut self) -> Vec<PluginControlReport> {
        std::mem::take(&mut self.authorization_reports)
    }

    pub(super) fn poll_revocation(
        &mut self,
        renderer: &mut RendererRuntime,
        hosts: &HostRuntime,
        broker: &ControlBroker,
    ) -> bool {
        let Some(mut pending) = self.revoking.take() else {
            return false;
        };
        if let Some(report) = pending.poll(renderer, hosts, &self.generations) {
            if let Some(job) = &pending.job {
                broker.complete(&job.operation_id, Ok(report));
            } else {
                if self.authorization_reports.len() == 32 {
                    self.authorization_reports.remove(0);
                }
                self.authorization_reports.push(report);
            }
        } else {
            self.revoking = Some(pending);
        }
        true
    }
}

impl PendingRevocation {
    fn poll(
        &mut self,
        renderer: &mut RendererRuntime,
        hosts: &HostRuntime,
        generations: &BTreeMap<String, u64>,
    ) -> Option<PluginControlReport> {
        let observations = hosts.observations();
        renderer.set_external_observations(observations.clone());
        let mut index = 0;
        let mut admitted = self
            .retiring
            .iter()
            .filter(|owner| owner.operation.is_some())
            .count();
        while index < self.retiring.len() {
            let owner = &mut self.retiring[index];
            if let Some(operation) = &mut owner.operation {
                let Some(result) = operation.try_result() else {
                    index += 1;
                    continue;
                };
                admitted -= 1;
                match result {
                    Ok(HostOperationResult::Stopped {
                        plugin_id,
                        generation,
                        report,
                    }) if plugin_id == owner.id
                        && generation == owner.generation
                        && report.workers_reaped =>
                    {
                        if report.forced || report.exit_code != 0 {
                            self.failures.push(failure(
                                &owner.id,
                                "revoke_cleanup",
                                format!(
                                    "Host retired with exit_code={}, forced={}",
                                    report.exit_code, report.forced
                                ),
                            ));
                        }
                    }
                    Err(error) => {
                        self.failures
                            .push(failure(&owner.id, "revoke_cleanup", error.to_string()))
                    }
                    Ok(_) => self.failures.push(failure(
                        &owner.id,
                        "revoke_cleanup",
                        "The native retirement result was unrelated or incomplete.",
                    )),
                }
                self.retiring.remove(index);
                continue;
            }
            if let Some(observation) = observations
                .iter()
                .find(|observation| observation.plugin.manifest.id == owner.id)
            {
                if observation.plugin.generation != owner.generation {
                    self.failures.push(failure(
                        &owner.id,
                        "revoke_cleanup",
                        "A different generation appeared during revocation.",
                    ));
                    self.retiring.remove(index);
                    continue;
                }
                if !is_live(observation.state) {
                    self.retiring.remove(index);
                    continue;
                }
            }
            if admitted < 4 {
                match hosts.begin_stop(&owner.id, owner.generation) {
                    Ok(operation) => {
                        owner.operation = Some(operation);
                        admitted += 1;
                    }
                    Err(error)
                        if matches!(error.code, "operation_limit" | "operation_queue_full") => {}
                    Err(error) => {
                        self.failures
                            .push(failure(&owner.id, "revoke_cleanup", error.to_string()));
                        self.retiring.remove(index);
                        continue;
                    }
                }
            }
            index += 1;
        }
        if !self.retiring.is_empty() {
            if Instant::now() < self.deadline {
                return None;
            }
            for owner in self.retiring.drain(..) {
                self.failures.push(failure(&owner.id, "revoke_cleanup", "Authority is revoked, but native retirement was not confirmed within the receipt budget."));
            }
        }
        if let Ok(registry) = PluginRegistry::load(self.registry.path()) {
            self.registry = registry;
        }
        let removing = self.request.action == PluginControlAction::Remove;
        let reason = self
            .request
            .permission
            .map(|permission| format!("{} is revoked.", permission.as_str()))
            .unwrap_or_else(|| "The selected authorization record changed.".into());
        let report = PluginControlReport {
            action: self.request.action,
            plugin_id: self.request.plugin_id.clone(),
            outcome: if self.failures.is_empty() {
                if self.unchanged {
                    PluginControlOutcome::Unchanged
                } else {
                    PluginControlOutcome::Applied
                }
            } else {
                PluginControlOutcome::Degraded
            },
            desired_enabled: self.registry.is_enabled(&self.request.plugin_id),
            affected_plugin_ids: self.affected.iter().cloned().collect(),
            generations: Vec::new(),
            target_failures: std::mem::take(&mut self.failures),
            message: Some(if removing {
                "Local registration removed and affected packages disabled. Author files are preserved.".into()
            } else {
                format!(
                    "{reason} Old managed authority is invalid; enabled preferences are retained, and source restoration was not attempted."
                )
            }),
        };
        renderer.finish_package_management(self.registry.clone(), generations.clone());
        Some(report)
    }
}
fn failure(id: &str, stage: &str, message: impl Into<String>) -> PluginTargetFailure {
    PluginTargetFailure {
        target_id: String::new(),
        plugin_id: id.into(),
        stage: stage.into(),
        error: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn revocation_requires_exactly_one_permission_and_old_requests_keep_their_fields() {
        let old = PluginControlRequest {
            action: PluginControlAction::Reload,
            plugin_id: "dev.fixture".into(),
            permission: None,
            cascade: false,
            local_import: None,
        };
        assert_eq!(
            serde_json::to_value(old).unwrap(),
            serde_json::json!({"action":"reload","plugin_id":"dev.fixture"})
        );
        let mut revoke = PluginControlRequest {
            action: PluginControlAction::Revoke,
            plugin_id: "dev.fixture".into(),
            permission: Some(crate::plugins::Permission::CdpRaw),
            cascade: false,
            local_import: None,
        };
        revoke.validate().unwrap();
        revoke.permission = None;
        assert_eq!(revoke.validate().unwrap_err().code, "invalid_permission");
        revoke.action = PluginControlAction::Enable;
        revoke.permission = Some(crate::plugins::Permission::CdpRaw);
        assert_eq!(revoke.validate().unwrap_err().code, "invalid_permission");
    }
}
