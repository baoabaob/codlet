//! One receipt owns every entry of a logical package and its dependent closure.
//! Native batches are polled; renderer cleanup/activation keeps its binding pump.

use std::collections::VecDeque;

use super::*;
use crate::plugin_lifecycle::ActivationPlan;

pub(super) enum Prepared {
    Complete(PluginControlReport),
    Pending(Box<PendingControl>),
}

impl HostControl {
    pub(super) fn prepare_package(
        &mut self,
        job: ControlJob,
        registry: PluginRegistry,
        selected: Option<PluginCatalogEntry>,
        renderer: &mut RendererRuntime,
        hosts: &HostRuntime,
    ) -> Result<Prepared, PluginControlError> {
        let id = &job.request.plugin_id;
        let current = renderer.logical_plugins();
        let affected = if job.request.action == PluginControlAction::Reload {
            if !registry.is_enabled(id)
                || (!current.iter().any(|plugin| plugin.manifest.id == *id)
                    && !self.generations.contains_key(id))
            {
                return Err(lifecycle_error(LifecycleError::NotEnabled(id.clone())));
            }
            plugin_lifecycle::dependent_closure(&current, id)
        } else if current.iter().any(|plugin| plugin.manifest.id == *id) {
            plugin_lifecycle::dependent_closure(&current, id)
        } else {
            BTreeSet::from([id.clone()])
        };
        let managed_stop = job
            .request
            .local_import
            .as_ref()
            .is_some_and(|selection| selection.managed.is_some() && !selection.enable);
        if job.request.action == PluginControlAction::Disable || managed_stop {
            if !job.request.cascade && !managed_stop {
                plugin_lifecycle::validate_disable(
                    &current,
                    renderer.catalog_snapshot(),
                    &registry,
                    id,
                )
                .map_err(lifecycle_error)?;
            }
            let affected = plugin_lifecycle::disable_closure(
                &current,
                renderer.catalog_snapshot(),
                &registry,
                id,
            )
            .map_err(lifecycle_error)?;
            let was_running = current
                .iter()
                .any(|plugin| affected.contains(&plugin.manifest.id));
            let was_enabled = affected.iter().any(|id| registry.is_enabled(id));
            renderer.begin_package_management(self.generations.clone(), &[])?;
            let registry = match plugin_lifecycle::persist_disabled_closure(&registry, &affected)
                .map_err(lifecycle_error)
            {
                Ok(registry) => registry,
                Err(error) => {
                    renderer.finish_package_management(registry, self.generations.clone());
                    return Err(error);
                }
            };
            let failures = renderer.retire_package_renderers(&affected, "deactivate");
            let mut pending = PendingControl::new(
                job,
                registry,
                ActivationPlan {
                    affected,
                    previous: Vec::new(),
                    next: Vec::new(),
                    entries: if managed_stop {
                        selected.into_iter().collect()
                    } else {
                        Vec::new()
                    },
                },
            );
            pending.failures = failures;
            pending.unchanged = !managed_stop && !was_running && !was_enabled;
            pending.phase = Phase::Disable;
            pending.batch = HostBatch::stop(hosts, &pending.plan.affected, "deactivate");
            return Ok(Prepared::Pending(Box::new(pending)));
        }

        if job.request.action.starts_plugin()
            && let Some(plugin) = current.iter().find(|plugin| plugin.manifest.id == *id)
            && renderer.package_is_active(plugin)
        {
            validate_package_trust(plugin, renderer, &registry, false)?;
            let was_enabled = registry.is_enabled(id);
            let registry = plugin_lifecycle::persist_preference(&registry, id, true)
                .map_err(lifecycle_error)?;
            let report = PluginControlReport {
                action: job.request.action,
                plugin_id: id.clone(),
                outcome: if was_enabled {
                    PluginControlOutcome::Unchanged
                } else {
                    PluginControlOutcome::Applied
                },
                desired_enabled: true,
                affected_plugin_ids: vec![id.clone()],
                generations: vec![PluginGeneration {
                    plugin_id: id.clone(),
                    generation: plugin.generation,
                }],
                target_failures: Vec::new(),
                message: None,
            };
            renderer.finish_package_management(registry, self.generations.clone());
            return Ok(Prepared::Complete(report));
        }

        // The selected entry is the exact snapshot whose watch fingerprint was
        // checked. Do not reread it between that guard and the transaction.
        let mut selected = Some(selected.expect("activation validated selected source"));
        let mut entries = Vec::with_capacity(affected.len());
        for affected_id in &affected {
            let entry = if affected_id == id {
                selected.take().expect("selected entry used once")
            } else {
                renderer
                    .catalog_snapshot()
                    .reload_entry(affected_id, &registry, 1)
                    .map_err(catalog_error)?
            };
            renderer.validate_package_shape(entry.plugin.as_ref().expect("validated source"))?;
            entries.push(entry);
        }
        let mut generations = self.generations.clone();
        for entry in &mut entries {
            entry.plugin.as_mut().expect("validated source").generation =
                next_host_generation(&mut generations, &entry.id)?;
        }
        let previous = current
            .iter()
            .filter(|plugin| affected.contains(&plugin.manifest.id))
            .cloned()
            .collect();
        let mut next = current
            .into_iter()
            .filter(|plugin| !affected.contains(&plugin.manifest.id))
            .collect::<Vec<_>>();
        next.extend(
            entries
                .iter()
                .map(|entry| entry.plugin.as_ref().expect("validated source").clone()),
        );
        HostRuntime::validate_plugins(
            &next
                .iter()
                .filter(|plugin| plugin.manifest.host.is_some())
                .cloned()
                .collect::<Vec<_>>(),
        )
        .map_err(host_error)?;
        let next = plugin_lifecycle::order(next).map_err(lifecycle_error)?;
        let registry = plugin_lifecycle::verify_registrations(&registry, &affected)
            .map_err(lifecycle_error)?;
        let plan = ActivationPlan {
            affected,
            previous,
            next,
            entries,
        };
        let replacements = plan.replacements();
        renderer.begin_package_management(generations.clone(), &replacements)?;
        self.generations = generations;
        let failures = renderer.retire_package_renderers(&plan.affected, "deactivate");
        let mut pending = PendingControl::new(job, registry, plan);
        pending.failures = failures;
        pending.phase = Phase::StopPrevious;
        pending.batch = HostBatch::stop(hosts, &pending.plan.affected, "deactivate");
        Ok(Prepared::Pending(Box::new(pending)))
    }
}

#[derive(Clone, Copy)]
enum Phase {
    Disable,
    StopPrevious,
    StartCandidates,
    RenderCandidates,
    StopCandidates,
    StartRollback,
    RenderRollback,
    StopRollback,
}

pub(super) struct PendingControl {
    pub(super) job: ControlJob,
    registry: PluginRegistry,
    plan: ActivationPlan,
    rollback: Vec<LoadedPlugin>,
    phase: Phase,
    batch: HostBatch,
    failures: Vec<PluginTargetFailure>,
    pub(super) watch: Option<WatchedReload>,
    unchanged: bool,
    request_renderer: bool,
    renderer_attempted: bool,
    renderer_error: Option<String>,
    cleanup_confirmed: bool,
    renderers_started: bool,
    managed_previous: Option<PluginRegistry>,
    managed_restored: bool,
    managed_installation: Option<crate::managed_storage::Installation>,
}

impl PendingControl {
    fn new(job: ControlJob, registry: PluginRegistry, plan: ActivationPlan) -> Self {
        Self {
            job,
            registry,
            plan,
            rollback: Vec::new(),
            phase: Phase::StopPrevious,
            batch: HostBatch::empty(),
            failures: Vec::new(),
            watch: None,
            unchanged: false,
            request_renderer: false,
            renderer_attempted: false,
            renderer_error: None,
            cleanup_confirmed: true,
            renderers_started: false,
            managed_previous: None,
            managed_restored: false,
            managed_installation: None,
        }
    }

    pub(super) fn set_managed_previous(&mut self, registry: PluginRegistry) {
        self.managed_previous = Some(registry);
    }

    pub(super) fn needs_renderer_executor(&self) -> bool {
        self.request_renderer && !self.renderer_attempted
    }
    pub(super) fn watch_anchors(&self) -> Vec<(String, LocalPluginRegistration)> {
        self.plan
            .replacements()
            .into_iter()
            .filter(|plugin| plugin.manifest.host.is_some())
            .filter_map(|plugin| {
                self.registry
                    .local_plugins()
                    .get(&plugin.manifest.id)
                    .cloned()
                    .map(|registration| (plugin.manifest.id, registration))
            })
            .collect()
    }
    pub(super) fn renderer_executor_result(&mut self, result: Result<(), String>) {
        self.renderer_attempted = true;
        self.renderer_error = result.err();
    }

    pub(super) fn poll(
        &mut self,
        renderer: &mut RendererRuntime,
        hosts: &HostRuntime,
        generations: &mut BTreeMap<String, u64>,
    ) -> Option<PluginControlReport> {
        renderer.set_external_observations(hosts.observations());
        for _ in 0..12 {
            match self.phase {
                Phase::Disable
                | Phase::StopPrevious
                | Phase::StopCandidates
                | Phase::StopRollback => {
                    let (failures, confirmed) = self.batch.poll(hosts)?;
                    self.failures.extend(failures);
                    self.cleanup_confirmed &= confirmed;
                    renderer.set_external_observations(hosts.observations());
                    match self.phase {
                        Phase::Disable => {
                            if confirmed && self.failures.is_empty() && let Err(error)=self.publish_managed_installation() { self.failure("managed_install",error.to_string()); }
                            return Some(self.finish(renderer, generations, if self.failures.is_empty() { if self.unchanged { PluginControlOutcome::Unchanged } else { PluginControlOutcome::Applied } } else { PluginControlOutcome::Degraded }, None));
                        }
                        Phase::StopPrevious => {
                            if !confirmed { return Some(self.finish(renderer, generations, PluginControlOutcome::Degraded, Some("Previous native retirement could not be confirmed; replacement code was not started.".into()))); }
                            if !self.failures.is_empty() { if let Some(report) = self.start_rollback(renderer, hosts, generations) { return Some(report); } continue; }
                            if let Err(error) = self.verify_candidate() {
                                self.failure("activate_validate", error.to_string());
                                if let Some(report) = self.start_rollback(renderer, hosts, generations) { return Some(report); }
                                continue;
                            }
                            if let Err(error)=self.publish_managed_installation() {
                                self.failure("managed_install",error.to_string());
                                if let Some(report)=self.start_rollback(renderer,hosts,generations) { return Some(report); }
                                continue;
                            }
                            if let Err(error) = renderer.register_rpc_plugins(&self.plan.replacements()) {
                                self.failure("activate_validate", error.to_string());
                                if let Some(report) = self.start_rollback(renderer, hosts, generations) { return Some(report); }
                                continue;
                            }
                            self.phase = Phase::StartCandidates;
                            self.batch = HostBatch::start(&self.plan.replacements(), "activate");
                        }
                        Phase::StopCandidates => {
                            if !confirmed || !self.cleanup_confirmed { return Some(self.finish(renderer, generations, PluginControlOutcome::Degraded, Some("Candidate native cleanup could not be confirmed; prior code was not restarted.".into()))); }
                            if let Some(report) = self.start_rollback(renderer, hosts, generations) { return Some(report); }
                        }
                        Phase::StopRollback => return Some(self.finish(renderer, generations, PluginControlOutcome::Degraded, Some("The requested change and restoration failed; affected packages remain stopped.".into()))),
                        _ => unreachable!(),
                    }
                }
                Phase::StartCandidates | Phase::StartRollback => {
                    let restoring = matches!(self.phase, Phase::StartRollback);
                    if let Some((failures, confirmed)) = self.batch.poll(hosts) {
                        self.cleanup_confirmed &= confirmed;
                        if !failures.is_empty() {
                            self.failures.extend(failures);
                            if restoring {
                                self.cleanup_rollback(renderer, hosts);
                            } else {
                                self.cleanup_candidates(renderer, hosts);
                            }
                            continue;
                        }
                    }
                    if !self.batch.queued.is_empty() {
                        return None;
                    }
                    self.phase = if restoring {
                        Phase::RenderRollback
                    } else {
                        Phase::RenderCandidates
                    };
                }
                Phase::RenderCandidates | Phase::RenderRollback => {
                    let restoring = matches!(self.phase, Phase::RenderRollback);
                    let plugins = if restoring {
                        self.rollback.clone()
                    } else {
                        self.plan.replacements()
                    };
                    if !self.renderers_started {
                        if plugins
                            .iter()
                            .any(|plugin| plugin.manifest.renderer.is_some())
                            && !renderer.package_has_live_target()
                        {
                            self.request_renderer = true;
                            if !self.renderer_attempted {
                                return None;
                            }
                            let error = self.renderer_error.take().unwrap_or_else(|| {
                                "no live main renderer target is available".into()
                            });
                            self.failure(
                                if restoring {
                                    "rollback_activate"
                                } else {
                                    "activate"
                                },
                                error,
                            );
                            if restoring {
                                self.cleanup_rollback(renderer, hosts);
                            } else {
                                self.cleanup_candidates(renderer, hosts);
                            }
                            continue;
                        }
                        let validation = if restoring {
                            self.verify_rollback(renderer)
                        } else {
                            self.verify_candidate()
                        };
                        if let Err(error) = validation {
                            self.failure(
                                if restoring {
                                    "rollback_validate"
                                } else {
                                    "activate_validate"
                                },
                                error.to_string(),
                            );
                            if restoring {
                                self.cleanup_rollback(renderer, hosts);
                            } else {
                                self.cleanup_candidates(renderer, hosts);
                            }
                            continue;
                        }
                        let failures = renderer.activate_package_renderers(
                            &plugins,
                            if restoring {
                                "rollback_activate"
                            } else {
                                "activate"
                            },
                        );
                        if !failures.is_empty() {
                            self.failures.extend(failures);
                            if restoring {
                                self.cleanup_rollback(renderer, hosts);
                            } else {
                                self.cleanup_candidates(renderer, hosts);
                            }
                            continue;
                        }
                        self.renderers_started = true;
                    }
                    let (failures, confirmed) = self.batch.poll(hosts)?;
                    self.cleanup_confirmed &= confirmed;
                    if !failures.is_empty() {
                        self.failures.extend(failures);
                        if restoring {
                            self.cleanup_rollback(renderer, hosts);
                        } else {
                            self.cleanup_candidates(renderer, hosts);
                        }
                        continue;
                    }
                    renderer.set_external_observations(hosts.observations());
                    let committed = if restoring {
                        self.verify_rollback(renderer)
                    } else {
                        self.verify_candidate().and_then(|()| {
                            if self.job.request.activation_requested() {
                                self.registry = plugin_lifecycle::persist_preference_with_guards(
                                    &self.registry,
                                    &self.job.request.plugin_id,
                                    true,
                                    &self.plan.affected,
                                )
                                .map_err(lifecycle_error)?;
                            }
                            Ok(())
                        })
                    };
                    if let Err(error) = committed {
                        self.failure(
                            if restoring {
                                "rollback_validate"
                            } else {
                                "commit"
                            },
                            error.to_string(),
                        );
                        if restoring {
                            self.cleanup_rollback(renderer, hosts);
                        } else {
                            self.cleanup_candidates(renderer, hosts);
                        }
                        continue;
                    }
                    if restoring {
                        return Some(self.finish(renderer, generations, if self.cleanup_confirmed && !self.failures.iter().any(|failure| matches!(failure.stage.as_str(), "deactivate" | "rollback_cleanup")) { PluginControlOutcome::RolledBack } else { PluginControlOutcome::Degraded }, Some("The requested change failed; previous immutable entry snapshots were restored together with fresh generations under current trust.".into())));
                    }
                    renderer.commit_package_entries(std::mem::take(&mut self.plan.entries));
                    return Some(self.finish(
                        renderer,
                        generations,
                        PluginControlOutcome::Applied,
                        None,
                    ));
                }
            }
        }
        None
    }

    fn verify_candidate(&mut self) -> Result<(), PluginControlError> {
        self.registry = plugin_lifecycle::verify_registrations(&self.registry, &self.plan.affected)
            .map_err(lifecycle_error)?;
        for id in &self.plan.affected {
            if !self.registry.is_enabled(id)
                && !(id == &self.job.request.plugin_id && self.job.request.activation_requested())
            {
                return Err(PluginControlError::new(
                    "plugin_disabled",
                    format!("plugin {id} was disabled while replacement initialized"),
                ));
            }
        }
        Ok(())
    }

    fn verify_rollback(&mut self, renderer: &RendererRuntime) -> Result<(), PluginControlError> {
        self.registry = plugin_lifecycle::verify_registrations(&self.registry, &self.plan.affected)
            .map_err(lifecycle_error)?;
        for plugin in &self.rollback {
            validate_package_trust(plugin, renderer, &self.registry, true)?;
        }
        Ok(())
    }

    fn start_rollback(
        &mut self,
        renderer: &mut RendererRuntime,
        hosts: &HostRuntime,
        generations: &mut BTreeMap<String, u64>,
    ) -> Option<PluginControlReport> {
        if let Err(error) = self.restore_managed_registration() {
            self.failure("rollback_registration", error.to_string());
            return Some(self.finish(renderer, generations, PluginControlOutcome::Degraded,
                Some("The requested change failed and concurrent state prevented registration restoration; affected packages remain stopped.".into())));
        }
        if self.plan.previous.is_empty() {
            return Some(
                self.finish(
                    renderer,
                    generations,
                    PluginControlOutcome::Degraded,
                    Some(
                        "The requested change failed; no previous package snapshots were running."
                            .into(),
                    ),
                ),
            );
        }
        let prepared = (|| {
            let registry = PluginRegistry::load(self.registry.path()).map_err(registry_error)?;
            let mut restored = self.plan.previous.clone();
            let mut next_generations = generations.clone();
            for plugin in &mut restored {
                validate_package_trust(plugin, renderer, &registry, true)?;
                plugin.generation =
                    next_host_generation(&mut next_generations, &plugin.manifest.id)?;
            }
            let mut all = renderer.logical_plugins();
            all.extend(restored);
            let restored = plugin_lifecycle::order(all)
                .map_err(lifecycle_error)?
                .into_iter()
                .filter(|plugin| self.plan.affected.contains(&plugin.manifest.id))
                .collect::<Vec<_>>();
            Ok::<_, PluginControlError>((registry, restored, next_generations))
        })();
        match prepared {
            Ok((registry, restored, next_generations)) => {
                self.registry = registry;
                *generations = next_generations;
                self.rollback = restored;
                self.phase = Phase::StartRollback;
                self.request_renderer = false;
                self.renderer_attempted = false;
                self.renderer_error = None;
                self.renderers_started = false;
                if let Err(error) = renderer.register_rpc_plugins(&self.rollback) {
                    self.failure("rollback_validate", error.to_string());
                    return Some(self.finish(renderer, generations, PluginControlOutcome::Degraded, Some("Core rejected the restoration registrations; affected packages remain stopped.".into())));
                }
                self.batch = HostBatch::start(&self.rollback, "rollback_activate");
                let _ = hosts;
                None
            }
            Err(error) => {
                self.failure("rollback_validate", error.to_string());
                Some(self.finish(renderer, generations, PluginControlOutcome::Degraded, Some("Previous snapshots are no longer enabled and trusted at their original registrations; affected packages remain stopped.".into())))
            }
        }
    }

    fn cleanup_candidates(&mut self, renderer: &mut RendererRuntime, hosts: &HostRuntime) {
        self.failures
            .extend(renderer.retire_package_renderers(&self.plan.affected, "rollback_cleanup"));
        self.phase = Phase::StopCandidates;
        self.batch = HostBatch::stop(hosts, &self.plan.affected, "rollback_cleanup");
    }
    fn cleanup_rollback(&mut self, renderer: &mut RendererRuntime, hosts: &HostRuntime) {
        self.failures
            .extend(renderer.retire_package_renderers(&self.plan.affected, "rollback_retire"));
        self.phase = Phase::StopRollback;
        self.batch = HostBatch::stop(hosts, &self.plan.affected, "rollback_retire");
    }
    fn failure(&mut self, stage: &str, error: String) {
        self.failures.push(PluginTargetFailure {
            target_id: String::new(),
            plugin_id: self.job.request.plugin_id.clone(),
            stage: stage.into(),
            error,
        });
    }

    fn publish_managed_installation(&mut self) -> Result<(), PluginControlError> {
        let Some(previous) = &self.managed_previous else {
            return Ok(());
        };
        if self.managed_installation.is_some() {
            return Ok(());
        }
        let id = &self.job.request.plugin_id;
        let (installation, registry, mut entry) = crate::managed_storage::Installation::publish(
            &self.registry,
            previous,
            id,
            self.job.request.activation_requested(),
        )?;
        let generation = self
            .plan
            .entries
            .iter()
            .find(|e| e.id == *id)
            .and_then(|e| e.plugin.as_ref().ok())
            .map_or(1, |p| p.generation);
        entry
            .plugin
            .as_mut()
            .expect("checked installation")
            .generation = generation;
        for plugin in &mut self.plan.next {
            if plugin.manifest.id == *id {
                *plugin = entry.plugin.as_ref().unwrap().clone();
            }
        }
        if let Some(selected) = self
            .plan
            .entries
            .iter_mut()
            .find(|selected| selected.id == *id)
        {
            *selected = entry;
        }
        self.registry = registry;
        self.managed_installation = Some(installation);
        Ok(())
    }
    fn restore_managed_registration(&mut self) -> Result<(), PluginControlError> {
        if let Some(installation) = &mut self.managed_installation {
            self.registry = installation.rollback()?;
            self.managed_installation = None;
            self.managed_previous = None;
            self.managed_restored = true;
        }
        if let Some(previous) = &self.managed_previous {
            self.registry = crate::managed_plugins::restore_previous(
                &self.registry,
                previous,
                &self.job.request.plugin_id,
            )?;
            self.managed_previous = None;
            self.managed_restored = true;
        }
        Ok(())
    }
    fn finish(
        &mut self,
        renderer: &mut RendererRuntime,
        generations: &BTreeMap<String, u64>,
        mut outcome: PluginControlOutcome,
        message: Option<String>,
    ) -> PluginControlReport {
        if matches!(
            outcome,
            PluginControlOutcome::Applied | PluginControlOutcome::Unchanged
        ) {
            if let Some(mut installation) = self.managed_installation.take()
                && let Err(error) = installation.commit()
            {
                self.failure("managed_cleanup", error.to_string());
            }
            // Disabled managed selections still commit their new catalog entry.
            if self.managed_previous.is_some() && !self.plan.entries.is_empty() {
                renderer.commit_package_entries(std::mem::take(&mut self.plan.entries));
            }
            self.managed_previous = None;
        } else if self.managed_previous.is_some()
            && let Err(error) = self.restore_managed_registration()
        {
            self.failure("rollback_registration", error.to_string());
            outcome = PluginControlOutcome::Degraded;
        }
        if outcome == PluginControlOutcome::Degraded && self.managed_restored {
            match plugin_lifecycle::persist_disabled_closure(&self.registry, &self.plan.affected) {
                Ok(registry) => self.registry = registry,
                Err(error) => self.failure("rollback_disable", error.to_string()),
            }
        }
        if let Ok(registry) = PluginRegistry::load(self.registry.path()) {
            self.registry = registry;
        }
        let mut surviving = renderer
            .logical_plugins()
            .into_iter()
            .filter(|plugin| {
                self.plan.affected.contains(&plugin.manifest.id)
                    && renderer.package_is_active(plugin)
            })
            .map(|plugin| PluginGeneration {
                plugin_id: plugin.manifest.id,
                generation: plugin.generation,
            })
            .collect::<Vec<_>>();
        surviving.sort_by(|left, right| left.plugin_id.cmp(&right.plugin_id));
        let report = PluginControlReport {
            action: self.job.request.action,
            plugin_id: self.job.request.plugin_id.clone(),
            outcome,
            desired_enabled: self.registry.is_enabled(&self.job.request.plugin_id),
            affected_plugin_ids: self.plan.affected.iter().cloned().collect(),
            generations: surviving,
            target_failures: std::mem::take(&mut self.failures),
            message,
        };
        renderer.finish_package_management(self.registry.clone(), generations.clone());
        report
    }
}

fn validate_package_trust(
    plugin: &LoadedPlugin,
    renderer: &RendererRuntime,
    registry: &PluginRegistry,
    require_enabled: bool,
) -> Result<(), PluginControlError> {
    if require_enabled && !registry.is_enabled(&plugin.manifest.id) {
        return Err(PluginControlError::new(
            "plugin_disabled",
            "the current registry disables this package",
        ));
    }
    if plugin.manifest.host.is_some() {
        validate_snapshot_trust(plugin, registry, require_enabled)
    } else {
        plugin_lifecycle::validate_snapshot_trust(plugin, renderer.catalog_snapshot(), registry)
            .map_err(lifecycle_error)
    }
}

struct Work {
    plugin: LoadedPlugin,
    start: bool,
}
struct Running {
    id: String,
    generation: u64,
    start: bool,
    operation: HostOperation,
}
struct HostBatch {
    queued: VecDeque<Work>,
    running: Vec<Running>,
    failures: Vec<PluginTargetFailure>,
    stage: &'static str,
    confirmed: bool,
}

impl HostBatch {
    fn empty() -> Self {
        Self {
            queued: VecDeque::new(),
            running: Vec::new(),
            failures: Vec::new(),
            stage: "activate",
            confirmed: true,
        }
    }
    fn start(plugins: &[LoadedPlugin], stage: &'static str) -> Self {
        Self {
            queued: plugins
                .iter()
                .filter(|plugin| plugin.manifest.host.is_some())
                .cloned()
                .map(|plugin| Work {
                    plugin,
                    start: true,
                })
                .collect(),
            stage,
            ..Self::empty()
        }
    }
    fn stop(hosts: &HostRuntime, affected: &BTreeSet<String>, stage: &'static str) -> Self {
        Self {
            queued: hosts
                .observations()
                .into_iter()
                .filter(|observation| {
                    affected.contains(&observation.plugin.manifest.id) && is_live(observation.state)
                })
                .map(|observation| Work {
                    plugin: observation.plugin,
                    start: false,
                })
                .collect(),
            stage,
            ..Self::empty()
        }
    }
    fn poll(&mut self, hosts: &HostRuntime) -> Option<(Vec<PluginTargetFailure>, bool)> {
        while self.running.len() < 16 {
            let Some(work) = self.queued.pop_front() else {
                break;
            };
            let id = work.plugin.manifest.id.clone();
            let generation = work.plugin.generation;
            let result = if work.start {
                hosts.begin_start(work.plugin.clone())
            } else {
                hosts.begin_stop(&id, generation)
            };
            match result {
                Ok(operation) => self.running.push(Running {
                    id,
                    generation,
                    start: work.start,
                    operation,
                }),
                Err(error) if matches!(error.code, "operation_queue_full" | "operation_limit") => {
                    self.queued.push_front(work);
                    break;
                }
                Err(error) => {
                    self.confirmed &= work.start && error.code != "cleanup_incomplete";
                    self.failures.push(PluginTargetFailure {
                        target_id: String::new(),
                        plugin_id: id,
                        stage: self.stage.into(),
                        error: error.to_string(),
                    });
                }
            }
        }
        let mut index = 0;
        while index < self.running.len() {
            let Some(result) = self.running[index].operation.try_result() else {
                index += 1;
                continue;
            };
            let running = self.running.remove(index);
            let failure = match result {
                Ok(HostOperationResult::Started { plugin_id, generation, .. }) if running.start && plugin_id == running.id && generation == running.generation => None,
                Ok(HostOperationResult::Stopped { plugin_id, generation, report }) if !running.start && plugin_id == running.id && generation == running.generation && report.workers_reaped => {
                    (report.forced || report.exit_code != 0).then(|| format!("host retired: process_id={}, exit_code={}, forced={}, workers_reaped={}", report.process_id, report.exit_code, report.forced, report.workers_reaped))
                }
                Ok(_) => { self.confirmed = false; Some("host executor returned an unrelated or unconfirmed lifecycle result".into()) }
                Err(error) => { self.confirmed &= running.start && error.code != "cleanup_incomplete"; Some(error.to_string()) }
            };
            if let Some(error) = failure {
                self.failures.push(PluginTargetFailure {
                    target_id: String::new(),
                    plugin_id: running.id,
                    stage: self.stage.into(),
                    error,
                });
            }
        }
        if self.queued.is_empty() && self.running.is_empty() {
            Some((std::mem::take(&mut self.failures), self.confirmed))
        } else {
            None
        }
    }
}
