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
use crate::plugin_host::HostError;
use crate::plugin_lifecycle::{self, LifecycleError};
use crate::plugin_watch::WatchedReload;
use crate::plugins::{LoadedPlugin, LocalPluginRegistration, PluginRegistry};
use crate::renderer::RendererRuntime;
use crate::runtime_control::{ControlBroker, ControlJob, ControlRequest, ControlStatus};

mod package;
use package::{PendingControl, Prepared};

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
    self_disable_receipts: BTreeMap<String, String>,
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
            self_disable_receipts: BTreeMap::new(),
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
        if selection.request.action != PluginControlAction::Reload {
            return Err(PluginControlError::new(
                "watch_reload_only",
                "watching only submits a reload of a selected loaded package",
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

    /// Preserve response-before-cleanup ordering and retry admission without
    /// losing an already authorized disable when the bounded broker is full.
    pub fn submit_self_disable_requests(
        &mut self,
        renderer: &mut RendererRuntime,
        broker: &ControlBroker,
    ) {
        for id in renderer.pending_package_disables() {
            let operation_id = if let Some(operation_id) = self.self_disable_receipts.get(&id) {
                operation_id.clone()
            } else {
                let prepared = broker.handle(ControlRequest::prepare(
                    crate::plugin_control::PluginControlRequest {
                        action: PluginControlAction::Disable,
                        plugin_id: id.clone(),
                    },
                ));
                if prepared.status != ControlStatus::Prepared {
                    continue;
                }
                let operation_id = prepared
                    .operation_id()
                    .expect("prepared receipt")
                    .to_owned();
                self.self_disable_receipts
                    .insert(id.clone(), operation_id.clone());
                operation_id
            };
            let submitted = broker.handle(ControlRequest::submit(&operation_id));
            if matches!(
                submitted.status,
                ControlStatus::Queued | ControlStatus::Running | ControlStatus::Completed
            ) {
                self.self_disable_receipts.remove(&id);
                renderer.acknowledge_package_disable(&id);
            } else if matches!(
                submitted.status,
                ControlStatus::Expired | ControlStatus::StaleHost
            ) {
                self.self_disable_receipts.remove(&id);
            }
        }
    }

    /// A returned job belongs to the renderer. A consumed job is either already
    /// completed or retained here under the same server-issued receipt.
    pub fn dispatch(
        &mut self,
        job: ControlJob,
        renderer: &mut RendererRuntime,
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
        renderer.set_external_observations(observations.clone());
        for (id, generation) in renderer.package_generations() {
            self.generations
                .entry(id)
                .and_modify(|current| *current = (*current).max(generation))
                .or_insert(generation);
        }
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
        let mut source_attempted = false;
        let prepared = (|| {
            job.request.validate()?;
            let registry = PluginRegistry::load(&self.registry_path).map_err(registry_error)?;
            if let Some(selection) = &watch {
                self.validate_watched_closure(renderer, &registry, &job.request.plugin_id)?;
                if selection.is_host() {
                    self.validate_watched_source(selection, observed.as_ref(), &registry)?;
                } else {
                    let current = renderer.logical_plugins();
                    if !registry.is_enabled(&job.request.plugin_id)
                        || current
                            .iter()
                            .find(|plugin| plugin.manifest.id == job.request.plugin_id)
                            .is_none_or(|plugin| plugin.generation != selection.source.generation)
                        || registry
                            .local_plugins()
                            .get(&job.request.plugin_id)
                            .is_none_or(|registration| registration.path != selection.source.path)
                    {
                        return Err(PluginControlError::new(
                            "watch_source_changed",
                            "the selected renderer source changed before its receipt executed",
                        ));
                    }
                }
            }
            if job.request.action == PluginControlAction::Disable {
                return Ok((registry, None));
            }
            // Only this explicitly selected registration is reread. A launch
            // catalog cannot reject a plugin registered after Codlet started.
            source_attempted = true;
            let entry = renderer
                .catalog_snapshot()
                .reload_entry(&job.request.plugin_id, &registry, 1)
                .map_err(catalog_error)?;
            renderer.validate_package_shape(entry.plugin.as_ref().expect("validated source"))?;
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
            Ok((registry, Some(entry)))
        })();
        match prepared {
            Ok((registry, entry)) => {
                let operation_id = job.operation_id.clone();
                let plugin_id = job.request.plugin_id.clone();
                let action = job.request.action;
                let registration = registry.local_plugins().get(&plugin_id).cloned();
                match self.prepare_package(job, registry, entry, renderer, hosts) {
                    Ok(Prepared::Complete(report)) => {
                        self.capture_selection(&plugin_id, action, registration, watched);
                        self.complete(broker, &operation_id, &plugin_id, Ok(report), watch, true);
                    }
                    Ok(Prepared::Pending(mut pending)) => {
                        self.capture_selection(&plugin_id, action, registration, watched);
                        if !watched {
                            for (id, registration) in pending.watch_anchors() {
                                self.watch_sources.insert(id, registration);
                            }
                        }
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
    pub fn poll(
        &mut self,
        renderer: &mut RendererRuntime,
        hosts: &HostRuntime,
        broker: &ControlBroker,
    ) {
        let Some(mut pending) = self.pending.take() else {
            return;
        };
        if let Some(report) = pending.poll(renderer, hosts, &mut self.generations) {
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

    pub fn needs_renderer_executor(&self) -> bool {
        self.pending
            .as_ref()
            .is_some_and(|pending| pending.needs_renderer_executor())
    }

    pub fn renderer_executor_result(&mut self, result: Result<(), String>) {
        if let Some(pending) = &mut self.pending {
            pending.renderer_executor_result(result);
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

    fn validate_watched_closure(
        &self,
        renderer: &RendererRuntime,
        registry: &PluginRegistry,
        plugin_id: &str,
    ) -> Result<(), PluginControlError> {
        let plugins = renderer.logical_plugins();
        let affected = plugin_lifecycle::dependent_closure(&plugins, plugin_id);
        for plugin in plugins
            .iter()
            .filter(|plugin| affected.contains(&plugin.manifest.id))
        {
            let Some(entry) = renderer
                .catalog_snapshot()
                .entries()
                .iter()
                .find(|entry| entry.id == plugin.manifest.id)
            else {
                continue;
            };
            let PluginSource::Local { path, .. } = &entry.source else {
                continue;
            };
            let current = registry.local_plugins().get(&plugin.manifest.id);
            let changed = if plugin.manifest.host.is_some() {
                let anchor = self.watch_sources.get(&plugin.manifest.id);
                anchor.is_none()
                    || anchor != current
                    || anchor.is_some_and(|anchor| anchor.path != *path)
            } else {
                current.is_none_or(|registration| registration.path != *path)
            };
            if changed {
                return Err(PluginControlError::new(
                    "watch_source_changed",
                    format!(
                        "plugin {} in the affected closure changed its loaded root or host grants; select the source with a manual enable or reload",
                        plugin.manifest.id
                    ),
                ));
            }
        }
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
