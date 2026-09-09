//! Foreground coordination for JS host lifecycle receipts. The host executor
//! owns processes and pumps CDP; this owner validates registry intent, selects
//! generations and compensates failed replacements without blocking that pump.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use crate::catalog::{CatalogError, PluginCatalogEntry, PluginSource};
use crate::host_runtime::{HostOperation, HostOperationResult, HostRuntime, MAX_HOST_IDENTITIES};
use crate::local_plugins::{
    LocalWatchSource, checked_host_watch_root, loaded_watch_fingerprint, validate_grants,
};
use crate::plugin_control::{
    PluginControlAction, PluginControlError, PluginControlOutcome, PluginControlReport,
    PluginGeneration, PluginTargetFailure,
};
use crate::plugin_execution::{ExecutionState, PluginExecutionObservation};
use crate::plugin_host::{HostError, HostExitReport};
use crate::plugin_lifecycle::{self, LifecycleError};
use crate::plugin_watch::WatchedReload;
use crate::plugins::{LoadedPlugin, LocalPluginRegistration, PluginRegistry};
use crate::renderer::RendererRuntime;
use crate::runtime_control::{ControlBroker, ControlJob, ControlRequest, ControlStatus};

const MAX_WATCH_RESULTS: usize = 32;

pub struct HostWatchResult {
    pub operation_id: String,
    pub plugin_id: String,
    pub result: Result<PluginControlReport, PluginControlError>,
    /// An explicit pre-source rejection, not a failed validation or activation.
    pub not_attempted: Option<WatchedReload>,
}

struct WatchReceipt {
    operation_id: String,
    selection: WatchedReload,
}

/// There is at most one foreground host transaction. Its receipt remains
/// Running while renderer events and the other host owners continue pumping.
pub struct HostControl {
    registry_path: PathBuf,
    generations: BTreeMap<String, u64>,
    pending: Option<Box<PendingControl>>,
    watch_sources: BTreeMap<String, LocalPluginRegistration>,
    watch_receipt: Option<WatchReceipt>,
    watch_results: Vec<HostWatchResult>,
}

impl HostControl {
    pub fn new(registry_path: PathBuf) -> Self {
        Self {
            registry_path,
            generations: BTreeMap::new(),
            pending: None,
            watch_sources: BTreeMap::new(),
            watch_receipt: None,
            watch_results: Vec::new(),
        }
    }

    pub fn is_pending(&self) -> bool {
        self.pending.is_some()
    }

    /// Capture initial loader trust without rereading registrations or source.
    /// Manual lifecycle selections replace these anchors; automatic watch never
    /// adopts a changed root or full grant record on its own.
    pub fn seed_watch_sources(&mut self, renderer: &RendererRuntime, plugins: &[LoadedPlugin]) {
        for plugin in plugins {
            let Some(host) = &plugin.host else { continue };
            let Some(entry) = renderer
                .catalog_snapshot()
                .entries()
                .iter()
                .find(|entry| entry.id == plugin.manifest.id)
            else {
                continue;
            };
            let PluginSource::Local { path, grants } = &entry.source else {
                continue;
            };
            if *path == host.root {
                self.watch_sources.insert(
                    plugin.manifest.id.clone(),
                    LocalPluginRegistration {
                        path: path.clone(),
                        grants: grants.clone(),
                    },
                );
            }
        }
    }

    pub fn local_watch_sources<'a>(
        &'a self,
        observations: &'a [PluginExecutionObservation],
    ) -> Vec<LocalWatchSource<'a>> {
        observations
            .iter()
            .filter(|observation| {
                !matches!(
                    observation.state,
                    ExecutionState::Starting | ExecutionState::Stopping
                )
            })
            .filter_map(|observation| {
                let registration = self.watch_sources.get(&observation.plugin.manifest.id)?;
                let host = observation.plugin.host.as_ref()?;
                (host.root == registration.path).then_some(LocalWatchSource {
                    path: &registration.path,
                    grants: &registration.grants,
                    plugin: &observation.plugin,
                })
            })
            .collect()
    }

    pub fn has_watch_receipt(&self) -> bool {
        self.watch_receipt.is_some()
    }

    /// Reserve and submit through the same broker once. The queued receipt
    /// carries only the usual action/id; trusted in-process metadata pins the
    /// source when that receipt reaches the foreground executor.
    pub fn submit_watched(
        &mut self,
        selection: WatchedReload,
        broker: &ControlBroker,
    ) -> Result<String, PluginControlError> {
        if self.is_pending() || self.watch_receipt.is_some() {
            return Err(PluginControlError::new(
                "watch_runtime_busy",
                "another host lifecycle or watch receipt is pending",
            ));
        }
        if !selection.is_host() || selection.request.action != PluginControlAction::Reload {
            return Err(PluginControlError::new(
                "watch_reload_only",
                "host watching only submits a reload of a selected loaded host",
            ));
        }
        let prepared = broker.handle(ControlRequest::prepare(selection.request.clone()));
        if prepared.status != ControlStatus::Prepared {
            return Err(PluginControlError::new(
                "watch_not_submitted",
                format!(
                    "host watch could not reserve a receipt: {:?}",
                    prepared.status
                ),
            ));
        }
        let operation_id = prepared
            .operation_id()
            .expect("prepared broker reply has a receipt")
            .to_owned();
        let submitted = broker.handle(ControlRequest::submit(&operation_id));
        if submitted.status != ControlStatus::Queued {
            return Err(PluginControlError::new(
                "watch_not_submitted",
                format!("host watch receipt was not queued: {:?}", submitted.status),
            ));
        }
        self.watch_receipt = Some(WatchReceipt {
            operation_id: operation_id.clone(),
            selection,
        });
        Ok(operation_id)
    }

    pub fn take_watch_results(&mut self) -> Vec<HostWatchResult> {
        std::mem::take(&mut self.watch_results)
    }

    /// A returned job belongs to the renderer. A consumed job is either already
    /// completed or retained here under the same server-issued receipt.
    pub fn dispatch(
        &mut self,
        job: ControlJob,
        renderer: &RendererRuntime,
        hosts: &HostRuntime,
        broker: &ControlBroker,
    ) -> Option<ControlJob> {
        let watch = self
            .watch_receipt
            .take_if(|receipt| receipt.operation_id == job.operation_id)
            .map(|receipt| receipt.selection);
        let watched = watch.is_some();
        if self.is_pending() {
            self.complete(
                broker,
                &job.operation_id,
                &job.request.plugin_id,
                Err(PluginControlError::new(
                    "runtime_busy",
                    "a host lifecycle operation is already in progress",
                )),
                watch,
                false,
            );
            return None;
        }
        let observations = hosts.observations();
        for observation in &observations {
            self.generations
                .entry(observation.plugin.manifest.id.clone())
                .and_modify(|generation| {
                    *generation = (*generation).max(observation.plugin.generation)
                })
                .or_insert(observation.plugin.generation);
        }
        let observed = observations
            .into_iter()
            .find(|observation| observation.plugin.manifest.id == job.request.plugin_id);
        // Actual or previously allocated owners decide executor affinity before
        // consulting disk. Type changes cannot silently retire another executor.
        if observed.is_none()
            && !self.generations.contains_key(&job.request.plugin_id)
            && renderer
                .allocated_generation(&job.request.plugin_id)
                .is_some()
        {
            if watched {
                self.complete(
                    broker,
                    &job.operation_id,
                    &job.request.plugin_id,
                    Err(PluginControlError::new(
                        "watch_source_changed",
                        "the selected host owner is no longer available",
                    )),
                    watch,
                    false,
                );
                return None;
            }
            return Some(job);
        }
        let mut source_attempted = false;
        let prepared = (|| {
            job.request.validate()?;
            let registry = PluginRegistry::load(&self.registry_path).map_err(registry_error)?;
            if let Some(selection) = &watch {
                self.validate_watched_source(selection, observed.as_ref(), &registry)?;
            }
            let known_host = observed.is_some()
                || self.generations.contains_key(&job.request.plugin_id)
                || (job.request.action == PluginControlAction::Disable
                    && renderer.catalog_snapshot().entries().iter().any(|entry| {
                        entry.id == job.request.plugin_id
                            && entry.plugin.as_ref().is_ok_and(is_host)
                    }));
            if job.request.action == PluginControlAction::Disable {
                return Ok((known_host, registry, None));
            }
            // Only this explicitly selected registration is reread. A launch
            // catalog cannot reject a plugin registered after Codlet started.
            source_attempted = true;
            let entry = renderer
                .catalog_snapshot()
                .reload_entry(&job.request.plugin_id, &registry, 1)
                .map_err(catalog_error)?;
            let host = entry.plugin.as_ref().is_ok_and(is_host);
            if let Some(selection) = &watch
                && entry.plugin.as_ref().is_ok_and(|plugin| {
                    plugin
                        .host
                        .as_ref()
                        .is_some_and(|host| host.root != selection.source.path)
                })
            {
                source_attempted = false;
                return Err(PluginControlError::new(
                    "watch_root_changed",
                    "the loaded candidate resolved outside the selected canonical host root",
                ));
            }
            if known_host && !host {
                return Err(PluginControlError::new(
                    "executor_kind_changed",
                    format!(
                        "plugin {} already belongs to the host executor; changing executor kind requires restarting Codlet",
                        job.request.plugin_id
                    ),
                ));
            }
            if let Some(selection) = &watch
                && entry.plugin.as_ref().is_ok_and(|plugin| {
                    loaded_watch_fingerprint(plugin) != selection.source.fingerprint
                })
            {
                source_attempted = false;
                return Err(PluginControlError::new(
                    "watch_source_unsettled",
                    "plugin bytes changed after the stable watch observation; waiting for a fresh settled source",
                ));
            }
            Ok((known_host || host, registry, Some(entry)))
        })();
        match prepared {
            Ok((false, _, _)) => Some(job),
            Ok((true, registry, entry)) => {
                let operation_id = job.operation_id.clone();
                let plugin_id = job.request.plugin_id.clone();
                let action = job.request.action;
                let registration = registry.local_plugins().get(&plugin_id).cloned();
                match self.prepare(job, registry, entry, observed, hosts) {
                    Ok(Prepared::Complete(report)) => {
                        self.capture_selection(&plugin_id, action, registration, watched);
                        self.complete(broker, &operation_id, &plugin_id, Ok(report), watch, true);
                    }
                    Ok(Prepared::Pending(mut pending)) => {
                        self.capture_selection(&plugin_id, action, registration, watched);
                        pending.watch = watch;
                        self.pending = Some(pending);
                    }
                    Err(error) => {
                        self.complete(broker, &operation_id, &plugin_id, Err(error), watch, true)
                    }
                }
                None
            }
            Err(error) => {
                self.complete(
                    broker,
                    &job.operation_id,
                    &job.request.plugin_id,
                    Err(error),
                    watch,
                    source_attempted,
                );
                None
            }
        }
    }

    /// Nonblocking progress. No receipt is resubmitted when a CLI reader times
    /// out; completion is published exactly once through the original broker.
    pub fn poll(&mut self, hosts: &HostRuntime, broker: &ControlBroker) {
        let Some(mut pending) = self.pending.take() else {
            return;
        };
        if let Some(report) = pending.poll(hosts, &mut self.generations) {
            self.complete(
                broker,
                &pending.job.operation_id,
                &pending.job.request.plugin_id,
                Ok(report),
                pending.watch.take(),
                true,
            );
        } else {
            self.pending = Some(pending);
        }
    }

    fn capture_selection(
        &mut self,
        id: &str,
        action: PluginControlAction,
        registration: Option<LocalPluginRegistration>,
        watched: bool,
    ) {
        if action == PluginControlAction::Disable {
            self.watch_sources.remove(id);
        } else if !watched && let Some(registration) = registration {
            self.watch_sources.insert(id.to_owned(), registration);
        }
    }

    fn validate_watched_source(
        &self,
        selection: &WatchedReload,
        observed: Option<&PluginExecutionObservation>,
        registry: &PluginRegistry,
    ) -> Result<(), PluginControlError> {
        let id = &selection.request.plugin_id;
        let source = &selection.source;
        let observation = observed
            .filter(|observation| observation.plugin.generation == source.generation)
            .ok_or_else(|| {
                PluginControlError::new(
                    "watch_generation_changed",
                    "the selected host generation changed before its watch receipt executed",
                )
            })?;
        if matches!(
            observation.state,
            ExecutionState::Starting | ExecutionState::Stopping
        ) {
            return Err(PluginControlError::new(
                "watch_owner_busy",
                "the selected host generation is already starting or stopping",
            ));
        }
        let matches_source = |registration: &LocalPluginRegistration| {
            registration.path == source.path && registration.grants == source.grants
        };
        if observation
            .plugin
            .host
            .as_ref()
            .is_none_or(|host| host.root != source.path)
            || self
                .watch_sources
                .get(id)
                .is_none_or(|registration| !matches_source(registration))
            || registry
                .local_plugins()
                .get(id)
                .is_none_or(|registration| !matches_source(registration))
        {
            return Err(PluginControlError::new(
                "watch_source_changed",
                "the loaded root or full grant record changed; select the source with a manual enable or reload",
            ));
        }
        if !registry.is_enabled(id) {
            return Err(PluginControlError::new(
                "plugin_not_enabled",
                "the selected host was disabled before its watch receipt executed",
            ));
        }
        checked_host_watch_root(&source.path)
            .map_err(|error| PluginControlError::new(error.code(), error.to_string()))?;
        Ok(())
    }

    fn complete(
        &mut self,
        broker: &ControlBroker,
        operation_id: &str,
        plugin_id: &str,
        result: Result<PluginControlReport, PluginControlError>,
        watch: Option<WatchedReload>,
        source_attempted: bool,
    ) {
        if let Some(selection) = watch {
            if self.watch_results.len() == MAX_WATCH_RESULTS {
                self.watch_results.remove(0);
            }
            self.watch_results.push(HostWatchResult {
                operation_id: operation_id.to_owned(),
                plugin_id: plugin_id.to_owned(),
                result: result.clone(),
                not_attempted: (!source_attempted).then_some(selection),
            });
        }
        broker.complete(operation_id, result);
    }

    fn prepare(
        &mut self,
        job: ControlJob,
        registry: PluginRegistry,
        entry: Option<PluginCatalogEntry>,
        observed: Option<PluginExecutionObservation>,
        hosts: &HostRuntime,
    ) -> Result<Prepared, PluginControlError> {
        let id = job.request.plugin_id.clone();
        let live = observed
            .as_ref()
            .filter(|observation| is_live(observation.state));
        let active = observed
            .as_ref()
            .filter(|observation| observation.state == ExecutionState::Active);
        if job.request.action == PluginControlAction::Disable {
            let was_enabled = registry.is_enabled(&id);
            let registry = plugin_lifecycle::persist_preference(&registry, &id, false)
                .map_err(lifecycle_error)?;
            let mut pending = PendingControl::new(job, registry, None, None);
            if let Some(live) = live {
                pending.remaining_generation = Some(live.plugin.generation);
                pending.phase = Phase::Disable;
                pending.launch(hosts.begin_stop(&id, live.plugin.generation));
                return Ok(Prepared::Pending(Box::new(pending)));
            }
            return Ok(Prepared::Complete(pending.report(
                if was_enabled {
                    PluginControlOutcome::Applied
                } else {
                    PluginControlOutcome::Unchanged
                },
                None,
            )));
        }
        // Retired observations are bounded; generation history still identifies
        // an enabled host whose old observation has been evicted.
        if job.request.action == PluginControlAction::Reload
            && ((observed.is_none() && !self.generations.contains_key(&id))
                || !registry.is_enabled(&id))
        {
            return Err(lifecycle_error(LifecycleError::NotEnabled(id.clone())));
        }
        let mut candidate = entry
            .expect("host activation has a selected entry")
            .plugin
            .expect("selected entry was validated");
        HostRuntime::validate_plugins(std::slice::from_ref(&candidate)).map_err(host_error)?;
        if job.request.action == PluginControlAction::Enable
            && let Some(active) = active
        {
            validate_snapshot_trust(&active.plugin, &registry, false)?;
            let was_enabled = registry.is_enabled(&id);
            let registry = plugin_lifecycle::persist_preference(&registry, &id, true)
                .map_err(lifecycle_error)?;
            let mut completed = PendingControl::new(job, registry, None, None);
            completed.remaining_generation = Some(active.plugin.generation);
            return Ok(Prepared::Complete(completed.report(
                if was_enabled {
                    PluginControlOutcome::Unchanged
                } else {
                    PluginControlOutcome::Applied
                },
                None,
            )));
        }
        let registry = verify(&registry, &id)?;
        candidate.generation = next_host_generation(&mut self.generations, &id)?;
        let previous = active.map(|observation| observation.plugin.clone());
        let mut pending = PendingControl::new(job, registry, Some(candidate), previous);
        if let Some(live) = live {
            pending.remaining_generation = Some(live.plugin.generation);
            pending.phase = Phase::RetirePrevious;
            pending
                .launch(hosts.begin_stop(&pending.job.request.plugin_id, live.plugin.generation));
        } else {
            pending.start_candidate(hosts);
        }
        Ok(Prepared::Pending(Box::new(pending)))
    }
}

enum Prepared {
    Complete(PluginControlReport),
    Pending(Box<PendingControl>),
}

#[derive(Clone, Copy)]
enum Phase {
    Disable,
    RetirePrevious,
    StartCandidate,
    RetireCandidate,
    StartRollback,
    RetireRollback,
}

struct PendingControl {
    job: ControlJob,
    registry: PluginRegistry,
    candidate: Option<LoadedPlugin>,
    previous: Option<LoadedPlugin>,
    rollback: Option<LoadedPlugin>,
    phase: Phase,
    operation: Option<HostOperation>,
    immediate_error: Option<HostError>,
    failures: Vec<PluginTargetFailure>,
    remaining_generation: Option<u64>,
    watch: Option<WatchedReload>,
}

impl PendingControl {
    fn new(
        job: ControlJob,
        registry: PluginRegistry,
        candidate: Option<LoadedPlugin>,
        previous: Option<LoadedPlugin>,
    ) -> Self {
        Self {
            job,
            registry,
            candidate,
            previous,
            rollback: None,
            phase: Phase::StartCandidate,
            operation: None,
            immediate_error: None,
            failures: Vec::new(),
            remaining_generation: None,
            watch: None,
        }
    }

    fn launch(&mut self, operation: Result<HostOperation, HostError>) {
        match operation {
            Ok(operation) => self.operation = Some(operation),
            Err(error) => self.immediate_error = Some(error),
        }
    }

    fn start_candidate(&mut self, hosts: &HostRuntime) {
        self.phase = Phase::StartCandidate;
        match verify(&self.registry, &self.job.request.plugin_id) {
            Ok(registry) => {
                self.registry = registry;
                self.launch(hosts.begin_start(self.candidate.as_ref().unwrap().clone()));
            }
            Err(error) => {
                self.immediate_error =
                    Some(HostError::new("registration_changed", error.to_string()));
            }
        }
    }

    fn poll(
        &mut self,
        hosts: &HostRuntime,
        generations: &mut BTreeMap<String, u64>,
    ) -> Option<PluginControlReport> {
        // Immediate admission/validation errors can move through compensation
        // without waiting another tick. The transaction still has a fixed bound.
        for _ in 0..8 {
            let result = if let Some(error) = self.immediate_error.take() {
                Err(error)
            } else {
                let result = self.operation.as_mut()?.try_result()?;
                self.operation.take();
                result
            };
            match self.phase {
                Phase::Disable => {
                    let cleaned = self.stopped(result, "deactivate");
                    return Some(self.report(
                        if cleaned && self.failures.is_empty() {
                            PluginControlOutcome::Applied
                        } else {
                            PluginControlOutcome::Degraded
                        },
                        (!cleaned).then(|| "Disable was saved, but host retirement could not be confirmed.".into()),
                    ));
                }
                Phase::RetirePrevious => {
                    if !self.stopped(result, "deactivate") {
                        return Some(self.report(PluginControlOutcome::Degraded, Some(
                            "The previous generation could not be retired; replacement code was not started.".into(),
                        )));
                    }
                    self.start_candidate(hosts);
                }
                Phase::StartCandidate => match self.started(result, "activate") {
                    Ok(()) => {
                        let committed = (|| {
                            let registry = verify(&self.registry, &self.job.request.plugin_id)?;
                            if self.job.request.action == PluginControlAction::Enable {
                                plugin_lifecycle::persist_preference(
                                    &registry,
                                    &self.job.request.plugin_id,
                                    true,
                                ).map_err(lifecycle_error)
                            } else if !registry.is_enabled(&self.job.request.plugin_id) {
                                Err(PluginControlError::new("plugin_disabled", "the plugin was disabled while replacement initialized"))
                            } else {
                                Ok(registry)
                            }
                        })();
                        match committed {
                            Ok(registry) => {
                                self.registry = registry;
                                return Some(self.report(
                                    if self.failures.is_empty() { PluginControlOutcome::Applied } else { PluginControlOutcome::Degraded },
                                    None,
                                ));
                            }
                            Err(error) => {
                                self.failure("commit", error.to_string());
                                self.phase = Phase::RetireCandidate;
                                self.launch(hosts.begin_stop(&self.job.request.plugin_id, self.candidate.as_ref().unwrap().generation));
                            }
                        }
                    }
                    Err(cleanup_uncertain) => {
                        if cleanup_uncertain {
                            return Some(self.inactive_report("Candidate cleanup was not confirmed; prior code was not restarted."));
                        }
                        if let Some(report) = self.start_rollback(hosts, generations) {
                            return Some(report);
                        }
                    }
                },
                Phase::RetireCandidate => {
                    if !self.stopped(result, "rollback_cleanup") {
                        return Some(self.inactive_report("Candidate cleanup was not confirmed; prior code was not restarted."));
                    }
                    if let Some(report) = self.start_rollback(hosts, generations) {
                        return Some(report);
                    }
                }
                Phase::StartRollback => match self.started(result, "rollback_activate") {
                    Ok(()) => {
                        let trusted = (|| {
                            let registry = verify(&self.registry, &self.job.request.plugin_id)?;
                            validate_snapshot_trust(self.rollback.as_ref().unwrap(), &registry, true)?;
                            Ok::<_, PluginControlError>(registry)
                        })();
                        match trusted {
                            Ok(registry) => {
                                self.registry = registry;
                                let cleanup_unconfirmed = self.failures.iter().any(|failure| matches!(failure.stage.as_str(), "deactivate" | "rollback_cleanup"));
                                return Some(self.report(
                                    if cleanup_unconfirmed { PluginControlOutcome::Degraded } else { PluginControlOutcome::RolledBack },
                                    Some("The requested change failed; the prior JS source snapshot was restored with a fresh generation under current trust settings.".into()),
                                ));
                            }
                            Err(error) => {
                                self.failure("rollback_validate", error.to_string());
                                self.phase = Phase::RetireRollback;
                                self.launch(hosts.begin_stop(&self.job.request.plugin_id, self.rollback.as_ref().unwrap().generation));
                            }
                        }
                    }
                    Err(_) => return Some(self.inactive_report("The requested change and restoration failed; inspect the host execution state.")),
                },
                Phase::RetireRollback => {
                    self.stopped(result, "rollback_retire");
                    return Some(self.inactive_report("Trust changed while prior code was restarting; that generation was retired instead of keeping revoked access."));
                }
            }
        }
        None
    }

    fn start_rollback(
        &mut self,
        hosts: &HostRuntime,
        generations: &mut BTreeMap<String, u64>,
    ) -> Option<PluginControlReport> {
        let Some(previous) = &self.previous else {
            return Some(self.inactive_report("The requested change failed; no previously active host snapshot is available to restore."));
        };
        let prepared = (|| {
            let registry = PluginRegistry::load(self.registry.path()).map_err(registry_error)?;
            validate_snapshot_trust(previous, &registry, true)?;
            let mut rollback = previous.clone();
            rollback.generation = next_host_generation(generations, &self.job.request.plugin_id)?;
            Ok::<_, PluginControlError>((registry, rollback))
        })();
        match prepared {
            Ok((registry, rollback)) => {
                self.registry = registry;
                self.phase = Phase::StartRollback;
                self.rollback = Some(rollback.clone());
                self.launch(hosts.begin_start(rollback));
                None
            }
            Err(error) => {
                self.failure("rollback_validate", error.to_string());
                Some(self.inactive_report("The prior host snapshot is no longer enabled and trusted at its original registration; it remains inactive."))
            }
        }
    }

    fn started(
        &mut self,
        result: Result<HostOperationResult, HostError>,
        stage: &str,
    ) -> Result<(), bool> {
        match result {
            Ok(HostOperationResult::Started {
                plugin_id,
                generation,
                ..
            }) if plugin_id == self.job.request.plugin_id
                && Some(generation) == self.phase_generation() =>
            {
                self.remaining_generation = Some(generation);
                Ok(())
            }
            Ok(_) => {
                self.failure(
                    stage,
                    "host executor returned an unrelated lifecycle result".into(),
                );
                Err(true)
            }
            Err(error) => {
                let cleanup_uncertain = error.code == "cleanup_incomplete";
                self.failure(stage, error.to_string());
                Err(cleanup_uncertain)
            }
        }
    }

    fn stopped(&mut self, result: Result<HostOperationResult, HostError>, stage: &str) -> bool {
        match result {
            Ok(HostOperationResult::Stopped {
                plugin_id,
                generation,
                report,
            }) if plugin_id == self.job.request.plugin_id
                && Some(generation) == self.phase_generation()
                && report.workers_reaped =>
            {
                self.remaining_generation = None;
                self.record_exit(stage, &report);
                true
            }
            Ok(_) => {
                self.failure(
                    stage,
                    "host executor did not confirm the expected generation's retirement".into(),
                );
                false
            }
            Err(error) => {
                self.failure(stage, error.to_string());
                false
            }
        }
    }

    fn record_exit(&mut self, stage: &str, report: &HostExitReport) {
        if report.forced || report.exit_code != 0 {
            self.failure(
                stage,
                format!(
                    "host retired: process_id={}, exit_code={}, forced={}, workers_reaped={}",
                    report.process_id, report.exit_code, report.forced, report.workers_reaped
                ),
            );
        }
    }

    fn phase_generation(&self) -> Option<u64> {
        match self.phase {
            Phase::Disable | Phase::RetirePrevious => self.remaining_generation,
            Phase::StartCandidate | Phase::RetireCandidate => {
                self.candidate.as_ref().map(|plugin| plugin.generation)
            }
            Phase::StartRollback | Phase::RetireRollback => {
                self.rollback.as_ref().map(|plugin| plugin.generation)
            }
        }
    }

    fn failure(&mut self, stage: &str, error: String) {
        self.failures.push(PluginTargetFailure {
            // This is a process lifecycle failure, never a fabricated renderer target.
            target_id: String::new(),
            plugin_id: self.job.request.plugin_id.clone(),
            stage: stage.into(),
            error,
        });
    }

    fn inactive_report(&mut self, message: &str) -> PluginControlReport {
        self.report(PluginControlOutcome::Degraded, Some(message.into()))
    }

    fn report(
        &mut self,
        outcome: PluginControlOutcome,
        message: Option<String>,
    ) -> PluginControlReport {
        // Intent and active state are distinct. Report the latest readable
        // preference; generations contain only confirmed surviving activations.
        if let Ok(registry) = PluginRegistry::load(self.registry.path()) {
            self.registry = registry;
        }
        PluginControlReport {
            action: self.job.request.action,
            plugin_id: self.job.request.plugin_id.clone(),
            outcome,
            desired_enabled: self.registry.is_enabled(&self.job.request.plugin_id),
            affected_plugin_ids: vec![self.job.request.plugin_id.clone()],
            generations: self
                .remaining_generation
                .into_iter()
                .map(|generation| PluginGeneration {
                    plugin_id: self.job.request.plugin_id.clone(),
                    generation,
                })
                .collect(),
            target_failures: std::mem::take(&mut self.failures),
            message,
        }
    }
}

fn is_host(plugin: &LoadedPlugin) -> bool {
    plugin.manifest.host.is_some() || plugin.host.is_some()
}
fn next_host_generation(
    generations: &mut BTreeMap<String, u64>,
    id: &str,
) -> Result<u64, PluginControlError> {
    if !generations.contains_key(id) && generations.len() >= MAX_HOST_IDENTITIES {
        return Err(PluginControlError::new(
            "identity_limit",
            "this runtime has exhausted its bounded host identity history",
        ));
    }
    plugin_lifecycle::next_generation(generations, id).map_err(lifecycle_error)
}
fn is_live(state: ExecutionState) -> bool {
    matches!(
        state,
        ExecutionState::Starting | ExecutionState::Active | ExecutionState::Stopping
    )
}
fn verify(registry: &PluginRegistry, id: &str) -> Result<PluginRegistry, PluginControlError> {
    plugin_lifecycle::verify_registrations(registry, &BTreeSet::from([id.to_owned()]))
        .map_err(lifecycle_error)
}
fn validate_snapshot_trust(
    plugin: &LoadedPlugin,
    registry: &PluginRegistry,
    require_enabled: bool,
) -> Result<(), PluginControlError> {
    let host = plugin
        .host
        .as_ref()
        .expect("host snapshot has a loaded entry");
    let registration = registry
        .local_plugins()
        .get(&plugin.manifest.id)
        .filter(|registration| registration.path == host.root)
        .ok_or_else(|| {
            PluginControlError::new(
                "rollback_trust_changed",
                "the original local directory is no longer registered",
            )
        })?;
    if require_enabled && !registry.is_enabled(&plugin.manifest.id) {
        return Err(PluginControlError::new(
            "plugin_disabled",
            "the current registry disables this plugin",
        ));
    }
    validate_grants(&plugin.manifest, &registration.grants)
        .map_err(|error| PluginControlError::new("rollback_trust_changed", error.to_string()))
}
fn lifecycle_error(error: LifecycleError) -> PluginControlError {
    PluginControlError::new(error.code(), error.to_string())
}
fn registry_error(error: crate::plugins::PluginRegistryError) -> PluginControlError {
    PluginControlError::new("registry_error", error.to_string())
}
fn catalog_error(error: CatalogError) -> PluginControlError {
    PluginControlError::new(
        if matches!(error, CatalogError::UnknownPlugin(_)) {
            "plugin_not_found"
        } else {
            "local_plugin_invalid"
        },
        error.to_string(),
    )
}
fn host_error(error: HostError) -> PluginControlError {
    PluginControlError::new(error.code, error.message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_identity_capacity_rejects_only_new_ids_without_consuming_generations() {
        let mut generations: BTreeMap<_, _> = (0..MAX_HOST_IDENTITIES)
            .map(|index| (format!("dev.capacity.{index}"), 1))
            .collect();
        let error = next_host_generation(&mut generations, "dev.capacity.overflow").unwrap_err();
        assert_eq!(error.code, "identity_limit");
        assert_eq!(generations.len(), MAX_HOST_IDENTITIES);
        assert!(!generations.contains_key("dev.capacity.overflow"));
        assert_eq!(
            next_host_generation(&mut generations, "dev.capacity.0").unwrap(),
            2
        );
        assert_eq!(generations.len(), MAX_HOST_IDENTITIES);
        assert_eq!(generations["dev.capacity.1"], 1);
    }
}
