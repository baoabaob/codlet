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
    /// The updater's authenticated in-process mailbox is the only entrance.
    /// Public plugin operations cannot select or replace Core implementation code.
    pub(super) fn begin_online_core_update(
        &mut self,
        renderer: &mut RendererRuntime,
        hosts: &HostRuntime,
    ) {
        if self.is_pending() {
            return;
        }
        let Some(service) = renderer.core_update_service() else {
            return;
        };
        let Some(request) = service.take_online_modules_request() else {
            return;
        };
        let id = request.id.clone();
        let prepared = (|| -> Result<PendingControl, PluginControlError> {
            let deadline = CoreUpdateDeadline::from_unix_ms(request.deadline_unix_ms);
            deadline.ensure_forward_budget()?;
            if renderer.client_source().is_none() || !renderer.package_has_live_target() {
                return Err(PluginControlError::new(
                    "core_update_not_ready",
                    "A live owned Native source and renderer are required for Core module takeover",
                ));
            }
            let registry = PluginRegistry::load(&self.registry_path).map_err(registry_error)?;
            let previous = renderer.logical_plugins();
            if previous.is_empty() {
                return Err(PluginControlError::new(
                    "core_update_not_ready",
                    "The current Core has no active module generations",
                ));
            }
            let guard =
                crate::runtime_update::activate_online_modules(&request).map_err(|error| {
                    PluginControlError::new("core_modules_preflight", error.to_string())
                })?;
            let providers = crate::codex::internal_plugins().map_err(|error| {
                PluginControlError::new("core_modules_preflight", error.to_string())
            })?;
            let mut generations = self.generations.clone();
            for plugin in &previous {
                generations
                    .entry(plugin.manifest.id.clone())
                    .and_modify(|generation| *generation = (*generation).max(plugin.generation))
                    .or_insert(plugin.generation);
            }
            let mut entries = Vec::new();
            let mut next = Vec::new();
            for old in &previous {
                let entry = renderer
                    .catalog_snapshot()
                    .entries()
                    .iter()
                    .find(|entry| entry.id == old.manifest.id)
                    .ok_or_else(|| {
                        PluginControlError::new(
                            "core_modules_preflight",
                            "A live module has no catalog ownership",
                        )
                    })?;
                let mut candidate = if matches!(entry.source, PluginSource::Core) {
                    providers
                        .iter()
                        .find(|plugin| plugin.manifest.id == old.manifest.id)
                        .cloned()
                        .ok_or_else(|| {
                            PluginControlError::new(
                                "core_modules_preflight",
                                "Core provider contract is missing",
                            )
                        })?
                } else {
                    old.clone()
                };
                candidate.generation =
                    next_host_generation(&mut generations, &candidate.manifest.id)?;
                entries.push(PluginCatalogEntry {
                    id: entry.id.clone(),
                    source: entry.source.clone(),
                    plugin: Ok(candidate.clone()),
                });
                next.push(candidate);
            }
            let next = plugin_lifecycle::order(next).map_err(lifecycle_error)?;
            HostRuntime::validate_plugins(
                &next
                    .iter()
                    .filter(|plugin| plugin.manifest.host.is_some())
                    .cloned()
                    .collect::<Vec<_>>(),
            )
            .map_err(host_error)?;
            renderer.begin_package_management(generations.clone(), &next)?;
            self.generations = generations;
            let affected = previous
                .iter()
                .map(|plugin| plugin.manifest.id.clone())
                .collect();
            let job = ControlJob {
                operation_id: id.clone(),
                request: crate::plugin_control::PluginControlRequest {
                    action: PluginControlAction::Reload,
                    plugin_id: crate::codex::UI_PROVIDER_ID.into(),
                    permission: None,
                    cascade: false,
                    local_import: None,
                    remove_source: None,
                },
            };
            let mut pending = PendingControl::new(
                job,
                registry,
                ActivationPlan {
                    affected,
                    previous,
                    next,
                    entries,
                },
            );
            pending.core_update = Some(CoreUpdateTransaction {
                service: service.clone(),
                request: request.clone(),
                guard: Some(guard),
                receipt: None,
                uncertain: false,
                next_start: None,
                deadline,
                source: renderer.client_source().expect("checked live source"),
                ingress_targets: Vec::new(),
                source_admission_started: false,
                renderer_admission_started: false,
                host_admission_started: false,
                admission_receipt: None,
                release_started: false,
                retain_candidate: false,
            });
            pending.core_transaction = true;
            pending.start_core_admission(renderer, hosts);
            Ok(pending)
        })();
        match prepared {
            Ok(pending) => self.pending = Some(Box::new(pending)),
            Err(error) => {
                service.complete_online_modules(
                    &id,
                    crate::runtime_update::OnlineCoreModulesCompletion::Rejected {
                        error: error.to_string(),
                    },
                );
            }
        }
    }

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
        let recovered = renderer.client_source().is_some() && renderer.startup_suspended(id);
        let full = if recovered {
            renderer
                .catalog_snapshot()
                .enabled_with_suspensions(&registry)
                .map_err(catalog_error)?
        } else {
            current.clone()
        };
        let affected = if recovered {
            plugin_lifecycle::dependent_closure(&full, id)
        } else if job.request.action == PluginControlAction::Reload {
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
            .is_some_and(|selection| !selection.enable);
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
                    affected: affected.clone(),
                    previous: current
                        .iter()
                        .filter(|plugin| affected.contains(&plugin.manifest.id))
                        .cloned()
                        .collect(),
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
            && job.request.local_import.is_none()
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
        let mut pending = PendingControl::new(job, registry, plan);
        pending.start_snapshots(hosts);
        Ok(Prepared::Pending(Box::new(pending)))
    }
}

#[derive(Clone, Copy)]
enum Phase {
    QuiesceCoreHosts,
    QuiesceCoreSource,
    Snapshot,
    ResumePrevious,
    FinalizeCoreSource,
    ReleaseCoreAdmission,
    ResumeCoreHosts,
    ReholdCoreHosts,
    Disable,
    StopPrevious,
    StartCandidates,
    RenderCandidates,
    StopCandidates,
    StartRollback,
    RenderRollback,
    StopRollback,
    NativeCandidates,
    NativeRollback,
    NativeDisable,
    NativeNoRollback,
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
    source_operation:
        Option<std::sync::mpsc::Receiver<Result<serde_json::Value, crate::plugin_host::HostError>>>,
    snapshot_operations: Vec<(String, crate::host_runtime::HostStateOperation)>,
    snapshots: BTreeMap<String, serde_json::Value>,
    core_update: Option<CoreUpdateTransaction>,
    core_transaction: bool,
    state_missing: BTreeSet<String>,
    core_report: Option<PluginControlReport>,
    core_host_operation: Option<crate::host_runtime::HostCoreAdmissionOperation>,
    receipt_poll_after: std::time::Instant,
}

struct CoreUpdateTransaction {
    service: crate::runtime_update::RuntimeUpdateService,
    request: crate::runtime_update::OnlineCoreModulesRequest,
    guard: Option<crate::runtime_update::CoreModulesGuard>,
    receipt: Option<serde_json::Value>,
    uncertain: bool,
    next_start: Option<String>,
    deadline: CoreUpdateDeadline,
    source: crate::client_bridge::ClientSourceRuntime,
    ingress_targets: Vec<crate::renderer::CoreIngressTarget>,
    source_admission_started: bool,
    renderer_admission_started: bool,
    host_admission_started: bool,
    admission_receipt: Option<serde_json::Value>,
    release_started: bool,
    retain_candidate: bool,
}

/// Stop beginning forward work while there is still time to restore the old
/// generations. Once an operation was admitted, its original receipt is drained
/// even after this budget; a timeout must never authorize a duplicate write.
struct CoreUpdateDeadline(std::time::Instant);
impl CoreUpdateDeadline {
    const ROLLBACK_RESERVE: std::time::Duration = std::time::Duration::from_secs(60);
    fn from_unix_ms(deadline: u64) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u64::MAX as u128) as u64;
        Self(
            std::time::Instant::now()
                + std::time::Duration::from_millis(deadline.saturating_sub(now).min(180_000)),
        )
    }
    fn ensure_forward_budget(&self) -> Result<(), PluginControlError> {
        if self.0.saturating_duration_since(std::time::Instant::now()) <= Self::ROLLBACK_RESERVE {
            return Err(PluginControlError::new(
                "core_update_deadline",
                "Core takeover stopped admitting forward work to preserve its restoration budget",
            ));
        }
        Ok(())
    }
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
            source_operation: None,
            snapshot_operations: Vec::new(),
            snapshots: BTreeMap::new(),
            core_update: None,
            core_transaction: false,
            state_missing: BTreeSet::new(),
            core_report: None,
            core_host_operation: None,
            receipt_poll_after: std::time::Instant::now(),
        }
    }

    pub(super) fn is_core_update(&self) -> bool {
        self.core_transaction
    }

    fn ensure_core_forward_budget(&self) -> Result<(), PluginControlError> {
        self.core_update
            .as_ref()
            .map_or(Ok(()), |core| core.deadline.ensure_forward_budget())
    }

    fn ensure_core_forward(&self, renderer: &RendererRuntime) -> Result<(), PluginControlError> {
        self.ensure_core_forward_budget()?;
        self.ensure_core_ownership(renderer)
    }

    fn ensure_core_ownership(&self, renderer: &RendererRuntime) -> Result<(), PluginControlError> {
        if let Some(core) = &self.core_update {
            if renderer
                .client_source()
                .is_none_or(|source| !source.same_owner(&core.source))
            {
                return Err(PluginControlError::new(
                    "core_update_source_changed",
                    "The Native source owner changed during the Core transaction",
                ));
            }
            renderer
                .validate_core_ingress_targets(&core.ingress_targets)
                .map_err(|message| {
                    PluginControlError::new("core_update_target_changed", message)
                })?;
        }
        Ok(())
    }

    fn start_core_admission(&mut self, renderer: &mut RendererRuntime, hosts: &HostRuntime) {
        let id = self
            .core_update
            .as_ref()
            .expect("Core transaction")
            .request
            .id
            .clone();
        let (targets, failures) = renderer.pause_core_ingress(&id);
        self.core_update
            .as_mut()
            .expect("Core transaction")
            .ingress_targets = targets;
        if !failures.is_empty() {
            self.core_update.as_mut().expect("Core transaction").next_start = Some("The current Native renderer cannot hold submissions through a Core provider transfer".into());
            self.failures.extend(failures);
            self.resume_previous(renderer, hosts);
            return;
        }
        match hosts.begin_core_admission(&id) {
            Ok(operation) => {
                self.core_update
                    .as_mut()
                    .expect("Core transaction")
                    .host_admission_started = true;
                self.core_host_operation = Some(operation);
                self.phase = Phase::QuiesceCoreHosts;
            }
            Err(error) => {
                self.failure("core_host_admission", error.to_string());
                self.resume_previous(renderer, hosts);
            }
        }
    }

    fn start_core_source_admission(&mut self) {
        let core = self.core_update.as_mut().expect("Core transaction");
        let id = core.request.id.clone();
        core.source_admission_started = true;
        let source = core.source.clone();
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        self.source_operation = Some(receiver);
        self.phase = Phase::QuiesceCoreSource;
        std::thread::spawn(move || {
            let _ = sender.send(source.begin_core_admission(&id));
        });
    }

    fn start_snapshots(&mut self, hosts: &HostRuntime) {
        let replacing = self
            .job
            .request
            .local_import
            .as_ref()
            .is_some_and(|selection| {
                selection.mode == Some(crate::local_import::InstallMode::Replace)
            });
        self.phase = Phase::Snapshot;
        for observation in hosts.observations().into_iter().filter(|observation| {
            self.plan.affected.contains(&observation.plugin.manifest.id)
                && observation.state == ExecutionState::Active
                && !(replacing && observation.plugin.manifest.id == self.job.request.plugin_id)
        }) {
            let id = observation.plugin.manifest.id;
            match hosts.begin_snapshot(&id, observation.plugin.generation) {
                Ok(operation) => self.snapshot_operations.push((id, operation)),
                Err(error) => self.failures.push(PluginTargetFailure {
                    target_id: String::new(),
                    plugin_id: id,
                    stage: "snapshot".into(),
                    error: error.to_string(),
                }),
            }
        }
    }

    fn resume_previous(&mut self, renderer: &mut RendererRuntime, hosts: &HostRuntime) {
        self.failures
            .extend(renderer.resume_package_state(&self.plan.affected));
        self.snapshot_operations.clear();
        for observation in hosts.observations().into_iter().filter(|observation| {
            self.plan.affected.contains(&observation.plugin.manifest.id)
                && observation.state == ExecutionState::Active
        }) {
            let id = observation.plugin.manifest.id;
            match hosts.begin_resume(&id, observation.plugin.generation) {
                Ok(operation) => self.snapshot_operations.push((id, operation)),
                Err(error) => self.failures.push(PluginTargetFailure {
                    target_id: String::new(),
                    plugin_id: id,
                    stage: "resume".into(),
                    error: error.to_string(),
                }),
            }
        }
        self.phase = Phase::ResumePrevious;
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
                Phase::QuiesceCoreHosts => {
                    let result = self
                        .core_host_operation
                        .as_mut()
                        .expect("Host admission receipt")
                        .try_result()?;
                    self.core_host_operation = None;
                    match result {
                        Ok(_) => {
                            let core = self.core_update.as_mut().expect("Core transaction");
                            core.renderer_admission_started = true;
                            let failures = renderer.begin_core_admission(&core.request.id);
                            if failures.is_empty() {
                                self.start_core_source_admission();
                            } else {
                                self.failures.extend(failures);
                                self.resume_previous(renderer, hosts);
                            }
                        }
                        Err(error) => {
                            if error.code == "core_admission_traffic_busy" {
                                self.core_update.as_mut().expect("Core transaction").next_start = Some("An active plugin owns live traffic resources which cannot be transferred; its running connections were retained".into());
                            }
                            self.failure("core_host_admission", error.to_string());
                            self.resume_previous(renderer, hosts);
                        }
                    }
                }
                Phase::QuiesceCoreSource => {
                    let result = match self
                        .source_operation
                        .as_ref()
                        .expect("Native admission receipt")
                        .try_recv()
                    {
                        Ok(result) => result,
                        Err(std::sync::mpsc::TryRecvError::Empty) => return None,
                        Err(_) => Err(HostError::new(
                            "client_bridge_uncertain",
                            "Native admission worker exited without its original receipt",
                        )),
                    };
                    self.source_operation = None;
                    match result {
                        Ok(receipt)
                            if receipt.get("outcome").and_then(serde_json::Value::as_str)
                                == Some("held") =>
                        {
                            self.core_update
                                .as_mut()
                                .expect("Core transaction")
                                .admission_receipt = Some(receipt);
                            if let Err(error) = self.ensure_core_forward(renderer) {
                                self.failure("core_admission", error.to_string());
                                self.resume_previous(renderer, hosts);
                            } else {
                                self.start_snapshots(hosts);
                            }
                        }
                        Ok(_) => {
                            self.failure(
                                "core_admission",
                                "Native admission did not confirm that accepted writes settled"
                                    .into(),
                            );
                            self.resume_previous(renderer, hosts);
                        }
                        Err(error) => {
                            if matches!(
                                error.code,
                                "core_admission_unavailable" | "core_admission_id_invalid"
                            ) {
                                let core = self.core_update.as_mut().expect("Core transaction");
                                core.source_admission_started = false;
                                core.next_start = Some("The resident Native bridge does not provide the required Core admission contract".into());
                            }
                            self.failure("core_admission", error.to_string());
                            self.resume_previous(renderer, hosts);
                        }
                    }
                }
                Phase::ResumePrevious => {
                    let mut index = 0;
                    while index < self.snapshot_operations.len() {
                        let Some(result) = self.snapshot_operations[index].1.try_result() else {
                            index += 1;
                            continue;
                        };
                        let (id, _) = self.snapshot_operations.remove(index);
                        if let Err(error) = result {
                            self.failures.push(PluginTargetFailure {
                                target_id: String::new(),
                                plugin_id: id,
                                stage: "resume".into(),
                                error: error.to_string(),
                            });
                        }
                    }
                    if !self.snapshot_operations.is_empty() {
                        return None;
                    }
                    let outcome = if self
                        .failures
                        .iter()
                        .any(|failure| failure.stage == "resume")
                    {
                        PluginControlOutcome::Degraded
                    } else {
                        PluginControlOutcome::RolledBack
                    };
                    let message = if outcome == PluginControlOutcome::Degraded {
                        "State preflight failed; previous plugin generations were retained but admission restoration could not be confirmed."
                    } else {
                        "State preflight failed; previous plugin generations were retained and their admission was resumed."
                    };
                    return self.finish(renderer, generations, outcome, Some(message.into()));
                }
                Phase::FinalizeCoreSource => {
                    if self.source_operation.is_none() {
                        if std::time::Instant::now() < self.receipt_poll_after {
                            return None;
                        }
                        let source = self
                            .core_update
                            .as_ref()
                            .expect("Core transaction")
                            .source
                            .clone();
                        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
                        self.source_operation = Some(receiver);
                        std::thread::spawn(move || {
                            let result = source.poll_core_code_receipt().and_then(|receipt| {
                                receipt.ok_or_else(|| {
                                    HostError::new(
                                        "client_bridge_uncertain",
                                        "The original Core source receipt is still pending",
                                    )
                                })
                            });
                            let _ = sender.send(result);
                        });
                    }
                    let result = match self
                        .source_operation
                        .as_ref()
                        .expect("Core source handoff receipt")
                        .try_recv()
                    {
                        Ok(result) => result,
                        Err(std::sync::mpsc::TryRecvError::Empty) => return None,
                        Err(_) => Err(HostError::new(
                            "client_bridge_uncertain",
                            "Core source worker exited without a receipt",
                        )),
                    };
                    self.source_operation = None;
                    match result {
                        Ok(receipt) if receipt["outcome"] == "applied" => {
                            self.core_update.as_mut().expect("Core transaction").receipt =
                                Some(receipt);
                            renderer.commit_package_entries(std::mem::take(&mut self.plan.entries));
                            if let Err(error) = self.ensure_core_ownership(renderer) {
                                self.core_update
                                    .as_mut()
                                    .expect("Core transaction")
                                    .uncertain = true;
                                self.failure("core_source_target_changed", error.to_string());
                                return self.finish(renderer, generations, PluginControlOutcome::Degraded, Some("Native source takeover completed while the document set changed. Admission remains held until ownership can be reconciled; do not replay the update.".into()));
                            }
                            return self.finish(
                                renderer,
                                generations,
                                PluginControlOutcome::Applied,
                                None,
                            );
                        }
                        Ok(receipt)
                            if matches!(
                                receipt["outcome"].as_str(),
                                Some("rejected" | "rolled_back")
                            ) =>
                        {
                            self.failure(
                                "core_source",
                                format!(
                                    "The original Native source operation completed with {}",
                                    receipt["outcome"]
                                ),
                            );
                            self.cleanup_candidates(renderer, hosts);
                        }
                        Ok(_) => {
                            self.core_update
                                .as_mut()
                                .expect("Core transaction")
                                .uncertain = true;
                            renderer.commit_package_entries(std::mem::take(&mut self.plan.entries));
                            return self.finish(renderer, generations, PluginControlOutcome::Degraded, Some("Native source restoration was not confirmed. Active connections and admission gates were retained; do not replay the update.".into()));
                        }
                        Err(error) if error.code == "client_bridge_uncertain" => {
                            // The updater reports its own bounded timeout, but retains
                            // this original receipt channel. Keep reconciling after that
                            // timeout so a late successful owner can release admission.
                            self.receipt_poll_after =
                                std::time::Instant::now() + std::time::Duration::from_millis(500);
                            return None;
                        }
                        Err(error) => {
                            self.failure("core_source", error.to_string());
                            self.cleanup_candidates(renderer, hosts);
                        }
                    }
                }
                Phase::ReleaseCoreAdmission => {
                    if self.core_report.as_ref().expect("Core completion").outcome
                        == PluginControlOutcome::Applied
                        && self.source_operation.is_none()
                        && !self
                            .core_update
                            .as_ref()
                            .expect("Core transaction")
                            .release_started
                        && let Err(error) = self.ensure_core_ownership(renderer)
                    {
                        return Some(self.core_release_failed(
                            renderer,
                            generations,
                            "core_owner_changed",
                            error.to_string(),
                        ));
                    }
                    let core = self.core_update.as_mut().expect("Core transaction");
                    if core.source_admission_started {
                        if self.source_operation.is_none() {
                            if std::time::Instant::now() < self.receipt_poll_after {
                                return None;
                            }
                            let source = core.source.clone();
                            let id = core.request.id.clone();
                            let query_only = core.release_started;
                            let applied =
                                self.core_report.as_ref().expect("Core completion").outcome
                                    == PluginControlOutcome::Applied;
                            core.release_started = true;
                            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
                            self.source_operation = Some(receiver);
                            std::thread::spawn(move || {
                                let result = if query_only {
                                    source.poll_core_admission_release(&id).and_then(|receipt| receipt.ok_or_else(|| HostError::new("client_bridge_uncertain", "The original Native admission release is still pending")))
                                } else {
                                    source.finish_core_admission(
                                        &id,
                                        if applied {
                                            crate::client_bridge::CoreAdmissionOutcome::Applied
                                        } else {
                                            crate::client_bridge::CoreAdmissionOutcome::RolledBack
                                        },
                                    )
                                };
                                let _ = sender.send(result);
                            });
                        }
                        let result = match self
                            .source_operation
                            .as_ref()
                            .expect("Native admission release")
                            .try_recv()
                        {
                            Ok(result) => result,
                            Err(std::sync::mpsc::TryRecvError::Empty) => return None,
                            Err(_) => Err(HostError::new(
                                "client_bridge_uncertain",
                                "Native admission worker exited without a receipt",
                            )),
                        };
                        self.source_operation = None;
                        match result {
                            Ok(_) => {}
                            Err(error)
                                if matches!(
                                    error.code,
                                    "client_bridge_uncertain"
                                        | "core_admission_release_not_started"
                                ) =>
                            {
                                if error.code == "core_admission_release_not_started" {
                                    core.release_started = false;
                                }
                                self.receipt_poll_after = std::time::Instant::now()
                                    + std::time::Duration::from_millis(500);
                                return None;
                            }
                            Err(error) => {
                                core.uncertain = true;
                                let mut report = self.core_report.take().expect("Core completion");
                                report.target_failures.push(PluginTargetFailure {
                                    target_id: String::new(),
                                    plugin_id: crate::codex::DESKTOP_PROVIDER_ID.into(),
                                    stage: "core_admission_resume".into(),
                                    error: error.to_string(),
                                });
                                report.outcome = PluginControlOutcome::Degraded;
                                report.message = Some("Core ownership settled but Native admission could not be confirmed; query the original operation without replay.".into());
                                return Some(self.complete_report(renderer, generations, report));
                            }
                        }
                    }
                    if core.host_admission_started {
                        match hosts.resume_core_admission(&core.request.id) {
                            Ok(operation) => self.core_host_operation = Some(operation),
                            Err(error) => {
                                return Some(self.core_release_failed(
                                    renderer,
                                    generations,
                                    "core_host_resume",
                                    error.to_string(),
                                ));
                            }
                        }
                    }
                    self.phase = Phase::ResumeCoreHosts;
                }
                Phase::ResumeCoreHosts | Phase::ReholdCoreHosts => {
                    if let Some(operation) = &mut self.core_host_operation {
                        let result = operation.try_result()?;
                        self.core_host_operation = None;
                        if let Err(error) = result {
                            return Some(self.core_release_failed(
                                renderer,
                                generations,
                                "core_host_resume",
                                error.to_string(),
                            ));
                        }
                    }
                    if matches!(self.phase, Phase::ReholdCoreHosts) {
                        let report = self.core_report.take().expect("Core completion");
                        return Some(self.complete_report(renderer, generations, report));
                    }
                    let applied = self.core_report.as_ref().expect("Core completion").outcome
                        == PluginControlOutcome::Applied;
                    let mut failures = if applied {
                        self.ensure_core_ownership(renderer)
                            .err()
                            .map(|error| PluginTargetFailure {
                                target_id: String::new(),
                                plugin_id: self.job.request.plugin_id.clone(),
                                stage: "core_owner_changed".into(),
                                error: error.to_string(),
                            })
                            .into_iter()
                            .collect::<Vec<_>>()
                    } else {
                        Vec::new()
                    };
                    let core = self.core_update.as_mut().expect("Core transaction");
                    if failures.is_empty() && core.renderer_admission_started {
                        failures.extend(renderer.resume_core_admission(&core.request.id));
                    }
                    if failures.is_empty() {
                        failures.extend(renderer.resume_core_ingress(
                            &core.request.id,
                            &core.ingress_targets,
                            applied,
                        ));
                    }
                    if failures.is_empty() {
                        let report = self.core_report.take().expect("Core completion");
                        return Some(self.complete_report(renderer, generations, report));
                    }
                    // Re-hold SDK writers if one document could not resume. Source
                    // ownership has settled, but the release is not globally confirmed.
                    if core.renderer_admission_started {
                        failures.extend(renderer.begin_core_admission(&core.request.id));
                    }
                    core.uncertain = true;
                    let report = self.core_report.as_mut().expect("Core completion");
                    report.target_failures.extend(failures);
                    report.outcome = PluginControlOutcome::Degraded;
                    report.message = Some("Core ownership settled but admission could not be confirmed in every document; SDK admission remains held.".into());
                    if core.host_admission_started {
                        match hosts.begin_core_admission(&core.request.id) {
                            Ok(operation) => self.core_host_operation = Some(operation),
                            Err(error) => {
                                return Some(self.core_release_failed(
                                    renderer,
                                    generations,
                                    "core_host_rehold",
                                    error.to_string(),
                                ));
                            }
                        }
                    }
                    self.phase = Phase::ReholdCoreHosts;
                }
                Phase::Snapshot => {
                    let mut index = 0;
                    while index < self.snapshot_operations.len() {
                        let Some(result) = self.snapshot_operations[index].1.try_result() else {
                            index += 1;
                            continue;
                        };
                        let (id, _) = self.snapshot_operations.remove(index);
                        match result {
                            Ok(value) if !value.is_null() => {
                                self.snapshots.insert(id, value);
                            }
                            Ok(_) => {
                                if !renderer.catalog_snapshot().is_core(&id) {
                                    self.state_missing.insert(id);
                                }
                            }
                            Err(error) => self.failures.push(PluginTargetFailure {
                                target_id: String::new(),
                                plugin_id: id,
                                stage: "snapshot".into(),
                                error: error.to_string(),
                            }),
                        }
                    }
                    if !self.snapshot_operations.is_empty() {
                        return None;
                    }
                    if !self.failures.is_empty() {
                        self.resume_previous(renderer, hosts);
                        continue;
                    }
                    if let Err(error) = self.ensure_core_forward(renderer) {
                        self.failure("core_update_deadline", error.to_string());
                        self.resume_previous(renderer, hosts);
                        continue;
                    }
                    let mut transfer = self.plan.affected.clone();
                    if self
                        .job
                        .request
                        .local_import
                        .as_ref()
                        .is_some_and(|selection| {
                            selection.mode == Some(crate::local_import::InstallMode::Replace)
                        })
                    {
                        transfer.remove(&self.job.request.plugin_id);
                    }
                    if let Err(error) = renderer.capture_package_state(&transfer) {
                        self.failure("snapshot", error.to_string());
                        self.resume_previous(renderer, hosts);
                        continue;
                    }
                    self.state_missing
                        .extend(renderer.package_state_missing().iter().cloned());
                    if let Some(core) = &mut self.core_update
                        && !self.state_missing.is_empty()
                    {
                        core.next_start = Some(format!(
                            "Active plugins have not declared explicit state transfer: {}",
                            self.state_missing
                                .iter()
                                .cloned()
                                .collect::<Vec<_>>()
                                .join(", ")
                        ));
                        self.resume_previous(renderer, hosts);
                        continue;
                    }
                    if let Err(error) = self.ensure_core_forward(renderer) {
                        self.failure("core_update_deadline", error.to_string());
                        self.resume_previous(renderer, hosts);
                        continue;
                    }
                    self.failures.extend(
                        renderer.retire_package_renderers(&self.plan.affected, "deactivate"),
                    );
                    self.phase = Phase::StopPrevious;
                    self.batch = HostBatch::stop(hosts, &self.plan.affected, "deactivate");
                }
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
                            if confirmed && self.failures.is_empty() && self.begin_native(renderer,&[],false) {self.phase=Phase::NativeDisable;continue;}
                            return self.finish(renderer, generations, if self.failures.is_empty() { if self.unchanged { PluginControlOutcome::Unchanged } else { PluginControlOutcome::Applied } } else { PluginControlOutcome::Degraded }, None);
                        }
                        Phase::StopPrevious => {
                            if !confirmed { return self.finish(renderer, generations, PluginControlOutcome::Degraded, Some("Previous native retirement could not be confirmed; replacement code was not started.".into())); }
                            if !self.failures.is_empty() { if let Some(report) = self.start_rollback(renderer, hosts, generations) { return Some(report); } continue; }
                            if let Err(error) = self.verify_candidate(renderer) {
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
                            let replacements=self.plan.replacements();
                            if self.begin_native(renderer,&replacements,false){self.phase=Phase::NativeCandidates;}
                            else{self.phase = Phase::StartCandidates;self.batch = HostBatch::start_with_state(&replacements, "activate", &self.snapshots);}
                        }
                        Phase::StopCandidates => {
                            if !confirmed || !self.cleanup_confirmed { return self.finish(renderer, generations, PluginControlOutcome::Degraded, Some("Candidate native cleanup could not be confirmed; prior code was not restarted.".into())); }
                            if let Some(report) = self.start_rollback(renderer, hosts, generations) { return Some(report); }
                        }
                        Phase::StopRollback => return self.finish(renderer, generations, PluginControlOutcome::Degraded, Some("The requested change and restoration failed; affected packages remain stopped.".into())),
                        _ => unreachable!(),
                    }
                }
                Phase::NativeCandidates
                | Phase::NativeRollback
                | Phase::NativeDisable
                | Phase::NativeNoRollback => {
                    let result = match self
                        .source_operation
                        .as_ref()
                        .expect("native entry operation")
                        .try_recv()
                    {
                        Ok(result) => result,
                        Err(std::sync::mpsc::TryRecvError::Empty) => return None,
                        Err(_) => Err(crate::plugin_host::HostError::new(
                            "client_bridge_worker_stopped",
                            "Client entry worker exited before confirming its operation",
                        )),
                    };
                    self.source_operation = None;
                    if let Err(error) = result {
                        self.failure(
                            "client_source",
                            format!("{}: {}", error.code, error.message),
                        );
                        if matches!(self.phase, Phase::NativeCandidates) {
                            if let Some(report) = self.start_rollback(renderer, hosts, generations)
                            {
                                return Some(report);
                            }
                            continue;
                        }
                        return self.finish(
                            renderer,
                            generations,
                            PluginControlOutcome::Degraded,
                            Some(
                                "Client entry cleanup or restoration could not be confirmed."
                                    .into(),
                            ),
                        );
                    }
                    match self.phase{
                        Phase::NativeNoRollback=>return self.finish(renderer,generations,PluginControlOutcome::Degraded,Some("The requested activation failed; its native entry was retired and no previous package was running.".into())),
                        Phase::NativeDisable=>return self.finish(renderer,generations,PluginControlOutcome::Applied,None),
                        Phase::NativeRollback=>{self.phase=Phase::StartRollback;self.batch=HostBatch::start_with_state(&self.rollback,"rollback_activate",&self.snapshots);},
                        _=>{self.phase=Phase::StartCandidates;self.batch=HostBatch::start_with_state(&self.plan.replacements(),"activate",&self.snapshots);}
                    }
                }
                Phase::StartCandidates | Phase::StartRollback => {
                    let restoring = matches!(self.phase, Phase::StartRollback);
                    if !restoring && let Err(error) = self.ensure_core_forward(renderer) {
                        self.batch.queued.clear();
                        let (failures, confirmed) = self.batch.poll(hosts)?;
                        self.failures.extend(failures);
                        self.cleanup_confirmed &= confirmed;
                        self.failure("core_update_deadline", error.to_string());
                        self.cleanup_candidates(renderer, hosts);
                        continue;
                    }
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
                            self.verify_candidate(renderer)
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
                        self.verify_candidate(renderer).and_then(|()| {
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
                        return self.finish(renderer, generations, if self.cleanup_confirmed && !self.failures.iter().any(|failure| matches!(failure.stage.as_str(), "deactivate" | "rollback_cleanup")) { PluginControlOutcome::RolledBack } else { PluginControlOutcome::Degraded }, Some("The requested change failed; previous immutable entry snapshots were restored together with fresh generations under current trust.".into()));
                    }
                    if let Some(core) = &self.core_update {
                        let source = core.source.clone();
                        let code = core.request.client_source.clone();
                        let version = core.request.version.clone();
                        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
                        self.source_operation = Some(receiver);
                        std::thread::spawn(move || {
                            let _ = sender.send(source.replace_core_code(&code, &version));
                        });
                        self.phase = Phase::FinalizeCoreSource;
                        continue;
                    }
                    renderer.commit_package_entries(std::mem::take(&mut self.plan.entries));
                    renderer.resume_startup_plugins(&self.plan.affected);
                    return self.finish(renderer, generations, PluginControlOutcome::Applied, None);
                }
            }
        }
        None
    }

    fn verify_candidate(&mut self, renderer: &RendererRuntime) -> Result<(), PluginControlError> {
        self.ensure_core_forward(renderer)?;
        self.registry = plugin_lifecycle::verify_registrations(&self.registry, &self.plan.affected)
            .map_err(lifecycle_error)?;
        for id in &self.plan.affected {
            if !crate::codex::is_internal_id(id)
                && !self.registry.is_enabled(id)
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
        if self
            .job
            .request
            .local_import
            .as_ref()
            .is_some_and(|selection| {
                selection.mode == Some(crate::local_import::InstallMode::Replace)
            })
        {
            renderer.reset_package_shape(&self.job.request.plugin_id);
        }
        if let Some(core) = &mut self.core_update {
            core.guard.take();
        }
        if let Err(error) = self.restore_managed_registration() {
            self.failure("rollback_registration", error.to_string());
            return self.finish(renderer, generations, PluginControlOutcome::Degraded,
                Some("The requested change failed and concurrent state prevented registration restoration; affected packages remain stopped.".into()));
        }
        if self.plan.previous.is_empty() {
            if self.begin_native(renderer, &[], true) {
                self.phase = Phase::NativeNoRollback;
                return None;
            }
            return self.finish(
                renderer,
                generations,
                PluginControlOutcome::Degraded,
                Some(
                    "The requested change failed; no previous package snapshots were running."
                        .into(),
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
                    return self.finish(renderer, generations, PluginControlOutcome::Degraded, Some("Core rejected the restoration registrations; affected packages remain stopped.".into()));
                }
                let restored = self.rollback.clone();
                if self.begin_native(renderer, &restored, true) {
                    self.phase = Phase::NativeRollback;
                } else {
                    self.batch = HostBatch::start_with_state(
                        &self.rollback,
                        "rollback_activate",
                        &self.snapshots,
                    );
                }
                let _ = hosts;
                None
            }
            Err(error) => {
                self.failure("rollback_validate", error.to_string());
                self.finish(renderer, generations, PluginControlOutcome::Degraded, Some("Previous snapshots are no longer enabled and trusted at their original registrations; affected packages remain stopped.".into()))
            }
        }
    }

    fn cleanup_candidates(&mut self, renderer: &mut RendererRuntime, hosts: &HostRuntime) {
        self.failures
            .extend(renderer.retire_package_renderers(&self.plan.affected, "rollback_cleanup"));
        self.phase = Phase::StopCandidates;
        self.batch = HostBatch::stop(hosts, &self.plan.affected, "rollback_cleanup");
    }

    fn core_release_failed(
        &mut self,
        renderer: &mut RendererRuntime,
        generations: &BTreeMap<String, u64>,
        stage: &str,
        error: String,
    ) -> PluginControlReport {
        self.core_update
            .as_mut()
            .expect("Core transaction")
            .uncertain = true;
        let mut report = self.core_report.take().expect("Core completion");
        report.target_failures.push(PluginTargetFailure {
            target_id: String::new(),
            plugin_id: self.job.request.plugin_id.clone(),
            stage: stage.into(),
            error,
        });
        report.outcome = PluginControlOutcome::Degraded;
        report.message = Some("Core ownership settled but admission restoration could not be confirmed. Original operation ownership is retained; do not replay the update.".into());
        self.complete_report(renderer, generations, report)
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
    fn begin_native(
        &mut self,
        renderer: &RendererRuntime,
        plugins: &[LoadedPlugin],
        restoring: bool,
    ) -> bool {
        if self.core_transaction {
            return false;
        }
        let relevant = self
            .plan
            .entries
            .iter()
            .filter_map(|entry| entry.plugin.as_ref().ok())
            .chain(self.plan.previous.iter())
            .any(client_entry);
        let Some(service) = renderer.client_source() else {
            return false;
        };
        if !relevant && !service.affects(&self.plan.affected) {
            return false;
        }
        let selected = plugins.iter().find(|plugin| client_entry(plugin)).cloned();
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        self.source_operation = Some(receiver);
        let _ = restoring;
        std::thread::spawn(move || {
            let result = service.replace(selected.as_ref());
            let _ = sender.send(result);
        });
        true
    }

    fn publish_managed_installation(&mut self) -> Result<(), PluginControlError> {
        let Some(previous) = &self.managed_previous else {
            return Ok(());
        };
        if self.managed_installation.is_some() {
            return Ok(());
        }
        let id = &self.job.request.plugin_id;
        let reset_data = self
            .job
            .request
            .local_import
            .as_ref()
            .is_some_and(|selection| selection.resets_data(previous, id));
        let (installation, registry, mut entry) =
            crate::managed_storage::Installation::publish_with_reset(
                &self.registry,
                previous,
                id,
                self.job.request.activation_requested(),
                reset_data,
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
    ) -> Option<PluginControlReport> {
        if matches!(
            outcome,
            PluginControlOutcome::Applied | PluginControlOutcome::Unchanged
        ) {
            if let Some(mut installation) = self.managed_installation.take()
                && let Err(error) = installation.commit()
            {
                self.failure("managed_cleanup", error.to_string());
                outcome = PluginControlOutcome::Degraded;
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
        if let Some(core) = &mut self.core_update {
            core.retain_candidate =
                core.uncertain || report.outcome == PluginControlOutcome::Applied;
            if report.outcome == PluginControlOutcome::RolledBack {
                core.guard.take();
            }
            // Keep the package transaction, module ownership and original receipt
            // alive until release is confirmed. A transport timeout is not a new
            // operation and does not allow queued submissions to be replayed.
            if !core.uncertain
                && matches!(
                    report.outcome,
                    PluginControlOutcome::Applied | PluginControlOutcome::RolledBack
                )
            {
                self.core_report = Some(report);
                self.receipt_poll_after = std::time::Instant::now();
                self.phase = Phase::ReleaseCoreAdmission;
                return None;
            }
        }
        Some(self.complete_report(renderer, generations, report))
    }

    fn complete_report(
        &mut self,
        renderer: &mut RendererRuntime,
        generations: &BTreeMap<String, u64>,
        mut report: PluginControlReport,
    ) -> PluginControlReport {
        let core_failure = self
            .core_update
            .as_ref()
            .map(|_| core_failure_summary(&report));
        if !report.target_failures.is_empty()
            && let Some(details) = &core_failure
        {
            crate::runtime_log::error("core_update_lifecycle_failed", details);
        }
        if self.core_update.as_ref().is_some_and(|core| {
            core.uncertain
                || !matches!(
                    report.outcome,
                    PluginControlOutcome::Applied | PluginControlOutcome::RolledBack
                )
        }) {
            renderer.retain_core_management();
        }
        renderer.finish_package_management(self.registry.clone(), generations.clone());
        if let Some(mut core) = self.core_update.take() {
            use crate::runtime_update::OnlineCoreModulesCompletion;
            let completion = if core.uncertain {
                if let Some(guard) = core.guard.take()
                    && core.retain_candidate
                {
                    guard.commit();
                }
                OnlineCoreModulesCompletion::Unknown {
                    error: core_failure
                        .clone()
                        .unwrap_or_else(|| "Core takeover outcome is unknown".into()),
                }
            } else if report.outcome == PluginControlOutcome::Applied {
                if let Some(guard) = core.guard.take() {
                    guard.commit();
                }
                OnlineCoreModulesCompletion::Applied {
                    receipt: serde_json::json!({"plugins":report.generations,"source":core.receipt,"admission":core.admission_receipt,"moduleAbi":core.request.module_abi}),
                }
            } else if report.outcome == PluginControlOutcome::RolledBack
                && core.next_start.is_some()
            {
                OnlineCoreModulesCompletion::NextStart {
                    reason: core.next_start.take().expect("checked next-start reason"),
                }
            } else if report.outcome == PluginControlOutcome::RolledBack {
                OnlineCoreModulesCompletion::RolledBack {
                    error: core_failure
                        .clone()
                        .unwrap_or_else(|| "Core module takeover rolled back".into()),
                }
            } else {
                OnlineCoreModulesCompletion::Unknown {
                    error: core_failure
                        .unwrap_or_else(|| "Core module restoration was not confirmed".into()),
                }
            };
            if !core
                .service
                .complete_online_modules(&core.request.id, completion)
            {
                crate::runtime_log::error(
                    "core_completion_unacknowledged",
                    "The original Core updater receipt channel was unavailable after ownership settled",
                );
                report.target_failures.push(PluginTargetFailure { target_id: String::new(), plugin_id: self.job.request.plugin_id.clone(), stage: "core_completion_unacknowledged".into(), error: "The original updater receipt could not be delivered; active code was not replayed or rolled back".into() });
                report.outcome = PluginControlOutcome::Degraded;
                report.message = Some("Core ownership settled, but the updater could not acknowledge activation persistence. Inspect the original operation before taking further action.".into());
            }
        }
        report
    }
}

/// Keep lifecycle failures in the original completion receipt. The updater
/// cannot recover a dropped synthetic foreground job through public management.
fn core_failure_summary(report: &PluginControlReport) -> String {
    fn bounded(value: &str, bytes: usize) -> &str {
        let mut end = value.len().min(bytes);
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        &value[..end]
    }
    let message = bounded(
        report
            .message
            .as_deref()
            .unwrap_or("Core lifecycle did not settle"),
        512,
    );
    if report.target_failures.is_empty() {
        return message.to_owned();
    }
    let mut failures = Vec::new();
    for failure in report.target_failures.iter().take(8) {
        failures.push(serde_json::json!({
            "pluginId":bounded(&failure.plugin_id,128),
            "stage":bounded(&failure.stage,64),
            "targetId":bounded(&failure.target_id,128),
            "error":bounded(&failure.error,512),
        }));
        // JSON escaping may increase byte size. Bound the serialized result,
        // without cutting a JSON value or a UTF-8 character in half.
        if serde_json::to_vec(&failures)
            .expect("bounded strings serialize")
            .len()
            > 7 * 1024
        {
            failures.pop();
            break;
        }
    }
    format!(
        "{message}; targetFailures={}",
        serde_json::to_string(&failures).expect("bounded strings serialize")
    )
}

fn client_entry(plugin: &LoadedPlugin) -> bool {
    plugin.manifest.host_provides().iter().any(|capability| {
        capability.name.as_str() == crate::client_launch::CAPABILITY
            && capability.api.get() == 1
            && capability.scope == crate::capabilities::CapabilityScope::Runtime
    })
}

fn validate_package_trust(
    plugin: &LoadedPlugin,
    renderer: &RendererRuntime,
    registry: &PluginRegistry,
    require_enabled: bool,
) -> Result<(), PluginControlError> {
    if renderer.catalog_snapshot().is_core(&plugin.manifest.id)
        && crate::codex::is_internal_plugin(plugin)
    {
        return Ok(());
    }
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
    snapshots: BTreeMap<String, serde_json::Value>,
}

impl HostBatch {
    fn empty() -> Self {
        Self {
            queued: VecDeque::new(),
            running: Vec::new(),
            failures: Vec::new(),
            stage: "activate",
            confirmed: true,
            snapshots: BTreeMap::new(),
        }
    }
    #[cfg(test)]
    fn start(plugins: &[LoadedPlugin], stage: &'static str) -> Self {
        Self::start_with_state(plugins, stage, &BTreeMap::new())
    }
    fn start_with_state(
        plugins: &[LoadedPlugin],
        stage: &'static str,
        snapshots: &BTreeMap<String, serde_json::Value>,
    ) -> Self {
        Self {
            queued: plugins
                .iter()
                .filter(|plugin| plugin.manifest.has_runtime_host())
                .cloned()
                .map(|plugin| Work {
                    plugin,
                    start: true,
                })
                .collect(),
            stage,
            snapshots: snapshots.clone(),
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
                if let Some(snapshot) = self.snapshots.get(&id) {
                    hosts.begin_start_restored(work.plugin.clone(), snapshot.clone())
                } else {
                    hosts.begin_start(work.plugin.clone())
                }
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

#[cfg(test)]
mod native_launch_tests {
    use super::*;

    #[test]
    fn expired_core_takeover_reserves_restoration_instead_of_admitting_more_work() {
        assert!(
            CoreUpdateDeadline::from_unix_ms(0)
                .ensure_forward_budget()
                .is_err()
        );
        let now = std::time::Instant::now();
        assert!(
            CoreUpdateDeadline(now + std::time::Duration::from_secs(59))
                .ensure_forward_budget()
                .is_err()
        );
        assert!(
            CoreUpdateDeadline(now + std::time::Duration::from_secs(120))
                .ensure_forward_budget()
                .is_ok()
        );
    }

    #[test]
    fn native_launch_only_hot_updates_do_not_queue_a_host_process() {
        let mut plugin = LoadedPlugin { authorization: None,
            manifest: crate::plugins::PluginManifest::parse(&serde_json::json!({"schema":1,"id":"dev.launch","version":"1","host":{"entry":"host.js"},"provides":[{"name":"codlet.client.launch","api":1,"scope":"runtime"}],"permissions":["host.process"]}).to_string()).unwrap(),
            source: None, host: None, generation: 1 };
        assert!(
            HostBatch::start(std::slice::from_ref(&plugin), "activate")
                .queued
                .is_empty()
        );
        plugin.manifest.provides.push(
            serde_json::from_value(
                serde_json::json!({"name":"dev.ordinary","api":1,"scope":"runtime"}),
            )
            .unwrap(),
        );
        assert_eq!(
            HostBatch::start(std::slice::from_ref(&plugin), "activate")
                .queued
                .len(),
            1
        );
        plugin.manifest.provides.pop();
        plugin.manifest.requires.push(
            serde_json::from_value(
                serde_json::json!({"name":"dev.required","api":1,"scope":"runtime"}),
            )
            .unwrap(),
        );
        assert_eq!(
            HostBatch::start(&[plugin], "rollback_activate")
                .queued
                .len(),
            1
        );
    }
}
