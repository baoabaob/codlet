//! Opt-in, foreground local-source observation. The watcher never loads a
//! plugin into an executor: it selects a stable source for the existing typed
//! lifecycle transaction. Host selections also carry internal source guards.

use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, BTreeSet};
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::local_plugins::{
    LocalWatchExecutor, LocalWatchFingerprint, LocalWatchSource, inspect_watch_fingerprint,
    loaded_watch_fingerprint,
};
use crate::plugin_control::{PluginControlAction, PluginControlRequest};
use crate::plugin_lifecycle::dependent_closure_refs;
use crate::plugins::{Permission, PluginRegistry};

const POLL_INTERVAL: Duration = Duration::from_millis(250);
const QUIET_PERIOD: Duration = Duration::from_millis(250);
const MAX_SOURCES_PER_POLL: usize = 4;
const MAX_DIAGNOSTICS: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchDiagnostic {
    pub plugin_id: String,
    pub code: String,
    pub message: String,
}

/// Internal observation evidence, never a control-protocol payload or authority
/// to select an arbitrary path. The executor still checks its own loaded owner.
#[derive(Debug, Clone)]
pub struct WatchedReload {
    pub request: PluginControlRequest,
    pub(crate) executor: LocalWatchExecutor,
    pub(crate) source: WatchSourceGuard,
}

impl WatchedReload {
    pub fn is_host(&self) -> bool {
        matches!(
            self.executor,
            LocalWatchExecutor::Host | LocalWatchExecutor::Combined
        )
    }
}

#[derive(Debug, Clone)]
pub(crate) struct WatchSourceGuard {
    pub(crate) path: PathBuf,
    pub(crate) grants: Vec<Permission>,
    pub(crate) generation: u64,
    pub(crate) fingerprint: LocalWatchFingerprint,
    pub(crate) attempt_signature: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Observation {
    Ready {
        fingerprint: LocalWatchFingerprint,
        grants: Vec<Permission>,
    },
    Paused {
        code: &'static str,
        message: String,
    },
}

struct WatchState {
    path: PathBuf,
    generation: u64,
    installed: Observation,
    observed: Option<Observation>,
    observed_since: Instant,
    stable_samples: u8,
    last_attempted: Option<u64>,
    announced_pause: Option<Observation>,
}

impl WatchState {
    fn new(source: &LocalWatchSource<'_>, now: Instant) -> Self {
        Self {
            path: source.path.to_owned(),
            generation: source.plugin.generation,
            installed: installed_observation(source),
            observed: None,
            observed_since: now,
            stable_samples: 0,
            last_attempted: None,
            announced_pause: None,
        }
    }

    fn synchronize(&mut self, source: &LocalWatchSource<'_>, now: Instant) {
        if self.path != source.path {
            *self = Self::new(source, now);
        } else if self.generation != source.plugin.generation
            || matches!(&self.installed, Observation::Ready { grants, .. } if grants.as_slice() != source.grants)
        {
            self.generation = source.plugin.generation;
            // The baseline is the immutable source actually loaded by the host,
            // never a post-operation read that could swallow a concurrent save.
            self.installed = installed_observation(source);
            self.observed_since = now;
            self.stable_samples = 0;
            // Keep the failed attempt across compensating generation changes.
        }
    }

    fn observe(&mut self, observation: Observation, now: Instant) {
        if self.observed.as_ref() == Some(&observation) {
            self.stable_samples = self.stable_samples.saturating_add(1);
        } else {
            self.observed = Some(observation);
            self.observed_since = now;
            self.stable_samples = 1;
        }
        if self.observed.as_ref() == Some(&self.installed) {
            self.last_attempted = None;
        }
        if matches!(self.observed, Some(Observation::Ready { .. })) {
            self.announced_pause = None;
        }
    }

    fn settled(&self, now: Instant) -> bool {
        self.stable_samples >= 2
            && now.saturating_duration_since(self.observed_since) >= QUIET_PERIOD
    }
}

struct RegistryProblem {
    message: String,
    since: Instant,
    samples: u8,
    announced: bool,
}

pub struct PluginWatcher {
    registry_path: PathBuf,
    states: BTreeMap<String, WatchState>,
    next_poll: Option<Instant>,
    cursor: usize,
    registry_problem: Option<RegistryProblem>,
    diagnostics: Vec<WatchDiagnostic>,
}

/// Toggle observation only; pending lifecycle receipts remain coordinator-owned.
pub(crate) fn configure_watcher(
    slot: &mut Option<PluginWatcher>,
    enabled: bool,
    registry: &std::path::Path,
) {
    if !enabled {
        *slot = None;
    } else if slot.is_none() {
        *slot = Some(PluginWatcher::new(registry.to_owned()));
    }
}

impl PluginWatcher {
    pub fn new(registry_path: PathBuf) -> Self {
        Self {
            registry_path,
            states: BTreeMap::new(),
            next_poll: None,
            cursor: 0,
            registry_problem: None,
            diagnostics: Vec::new(),
        }
    }

    /// Call only on an idle owner-loop turn. At most four sources are sampled,
    /// at most one reload is returned, and that content is marked attempted
    /// before returning. No success/failure callback is required.
    pub fn poll(
        &mut self,
        now: Instant,
        sources: &[LocalWatchSource<'_>],
    ) -> Option<PluginControlRequest> {
        self.poll_guarded(now, sources)
            .map(|selection| selection.request)
    }

    pub fn poll_guarded(
        &mut self,
        now: Instant,
        sources: &[LocalWatchSource<'_>],
    ) -> Option<WatchedReload> {
        let sources: BTreeMap<_, _> = sources
            .iter()
            .filter(|source| source.executor().is_some())
            .map(|source| (source.plugin.manifest.id.as_str(), source))
            .collect();
        self.states
            .retain(|id, _| sources.contains_key(id.as_str()));
        for (id, source) in &sources {
            self.states
                .entry((*id).to_owned())
                .and_modify(|state| state.synchronize(source, now))
                .or_insert_with(|| WatchState::new(source, now));
        }
        if sources.is_empty() || self.next_poll.is_some_and(|next| now < next) {
            return None;
        }
        self.next_poll = now.checked_add(POLL_INTERVAL);
        let registry = match PluginRegistry::load(&self.registry_path) {
            Ok(registry) => {
                self.registry_problem = None;
                registry
            }
            Err(error) => {
                self.observe_registry_problem(error.to_string(), now);
                return None;
            }
        };
        let ids: Vec<_> = sources.keys().copied().collect();
        let count = ids.len().min(MAX_SOURCES_PER_POLL);
        let start = self.cursor % ids.len();
        for step in 0..count {
            let id = ids[(start + step) % ids.len()];
            let source = sources[id];
            let observation = match registration_pause(source, &registry) {
                Some(observation) => observation,
                None => match inspect_watch_fingerprint(
                    source.path,
                    source.entry().expect("watch source has a JS entry"),
                    source.executor().expect("watch source has an executor"),
                ) {
                    Ok(fingerprint) => Observation::Ready {
                        fingerprint,
                        grants: registry.local_plugins()[id].grants.clone(),
                    },
                    Err(error) => Observation::Paused {
                        code: error.code(),
                        message: error.to_string(),
                    },
                },
            };
            self.states
                .get_mut(id)
                .expect("watch source was synchronized")
                .observe(observation, now);
        }
        self.cursor = (start + count) % ids.len();

        for (id, state) in &mut self.states {
            if state.settled(now)
                && let Some(observation @ Observation::Paused { code, message }) = &state.observed
                && state.announced_pause.as_ref() != Some(observation)
            {
                push_diagnostic(
                    &mut self.diagnostics,
                    WatchDiagnostic {
                        plugin_id: id.clone(),
                        code: (*code).to_owned(),
                        message: message.clone(),
                    },
                );
                state.announced_pause = Some(observation.clone());
            }
        }

        let mut candidates: Vec<_> = self
            .states
            .iter()
            .filter(|(_, state)| {
                state.settled(now)
                    && matches!(state.observed, Some(Observation::Ready { .. }))
                    && state.observed.as_ref() != Some(&state.installed)
            })
            .map(|(id, _)| id.clone())
            .collect();
        let closures: BTreeMap<_, _> = candidates
            .iter()
            .map(|id| {
                (
                    id.clone(),
                    dependent_closure_refs(sources.values().map(|source| source.plugin), id),
                )
            })
            .collect();
        // Prefer a provider when both it and its consumers changed. A single
        // management request then revalidates and installs the whole closure.
        candidates.sort_by(|left, right| {
            closures[right]
                .len()
                .cmp(&closures[left].len())
                .then_with(|| left.cmp(right))
        });
        for id in candidates {
            let affected = &closures[&id];
            // A root reload must not follow a replaced/removed consumer path
            // indirectly through dependency cascading either.
            if affected.iter().any(|affected_id| {
                sources
                    .get(affected_id.as_str())
                    .is_some_and(|source| registration_pause(source, &registry).is_some())
            }) {
                continue;
            }
            if affected.iter().any(|affected_id| {
                self.states.get(affected_id).is_none_or(|state| {
                    !state.settled(now)
                        || !matches!(state.observed, Some(Observation::Ready { .. }))
                })
            }) {
                continue;
            }
            let signature = self.attempt_signature(affected, &registry);
            if self.states[&id].last_attempted == Some(signature) {
                continue;
            }
            for affected_id in affected {
                let closure = dependent_closure_refs(
                    sources.values().map(|source| source.plugin),
                    affected_id,
                );
                let signature = self.attempt_signature(&closure, &registry);
                if let Some(state) = self.states.get_mut(affected_id) {
                    state.last_attempted = Some(signature);
                }
            }
            let selected = sources[id.as_str()];
            let Observation::Ready {
                fingerprint,
                grants,
            } = self.states[&id]
                .observed
                .as_ref()
                .expect("selected source was observed")
            else {
                unreachable!("selected source is ready")
            };
            return Some(WatchedReload {
                request: PluginControlRequest {
                    action: PluginControlAction::Reload,
                    plugin_id: id,
                    permission: None,
                    cascade: false,
                    remove_source: None,
                    local_import: None,
                },
                executor: selected.executor().expect("watch source has an executor"),
                source: WatchSourceGuard {
                    path: selected.path.to_owned(),
                    grants: grants.clone(),
                    generation: selected.plugin.generation,
                    fingerprint: *fingerprint,
                    attempt_signature: signature,
                },
            });
        }
        None
    }

    pub fn take_diagnostics(&mut self) -> Vec<WatchDiagnostic> {
        std::mem::take(&mut self.diagnostics)
    }

    /// Admission or a pre-source guard proved this selection was never tried.
    /// Invalidate only that attempt, then require two fresh observations. An
    /// actual source-validation/activation failure retains its failure signature.
    pub fn not_attempted(&mut self, selection: &WatchedReload) {
        if selection.is_host()
            && let Some(state) = self.states.get_mut(&selection.request.plugin_id)
            && state.path == selection.source.path
            && state.last_attempted == Some(selection.source.attempt_signature)
        {
            state.last_attempted = None;
            state.observed = None;
            state.stable_samples = 0;
        }
    }

    fn attempt_signature(&self, affected: &BTreeSet<String>, registry: &PluginRegistry) -> u64 {
        let mut hash = DefaultHasher::new();
        for id in affected {
            id.hash(&mut hash);
            if let Some(state) = self.states.get(id) {
                state.path.hash(&mut hash);
                match &state.observed {
                    Some(Observation::Ready { fingerprint, .. }) => fingerprint.hash(&mut hash),
                    Some(Observation::Paused { message, .. }) => message.hash(&mut hash),
                    None => 0_u8.hash(&mut hash),
                }
            }
            if let Some(registration) = registry.local_plugins().get(id) {
                serde_json::to_vec(&registration.grants)
                    .expect("typed grants serialize")
                    .hash(&mut hash);
            }
        }
        hash.finish()
    }

    fn observe_registry_problem(&mut self, message: String, now: Instant) {
        if let Some(problem) = &mut self.registry_problem
            && problem.message == message
        {
            problem.samples = problem.samples.saturating_add(1);
        } else {
            self.registry_problem = Some(RegistryProblem {
                message,
                since: now,
                samples: 1,
                announced: false,
            });
        }
        let problem = self
            .registry_problem
            .as_mut()
            .expect("registry problem exists");
        if problem.samples >= 2
            && now.saturating_duration_since(problem.since) >= QUIET_PERIOD
            && !problem.announced
        {
            push_diagnostic(
                &mut self.diagnostics,
                WatchDiagnostic {
                    plugin_id: String::new(),
                    code: "watch_registry_unavailable".into(),
                    message: format!(
                        "File watching is paused until the plugin registry can be read: {}",
                        problem.message
                    ),
                },
            );
            problem.announced = true;
        }
    }
}

fn push_diagnostic(diagnostics: &mut Vec<WatchDiagnostic>, diagnostic: WatchDiagnostic) {
    if let Some(current) = diagnostics.iter_mut().find(|current| {
        current.plugin_id == diagnostic.plugin_id && current.code == diagnostic.code
    }) {
        *current = diagnostic;
    } else {
        if diagnostics.len() == MAX_DIAGNOSTICS {
            diagnostics.remove(0);
        }
        diagnostics.push(diagnostic);
    }
}

fn installed_observation(source: &LocalWatchSource<'_>) -> Observation {
    Observation::Ready {
        fingerprint: loaded_watch_fingerprint(source.plugin),
        grants: source.grants.to_vec(),
    }
}

fn registration_pause(
    source: &LocalWatchSource<'_>,
    registry: &PluginRegistry,
) -> Option<Observation> {
    let id = &source.plugin.manifest.id;
    match registry.local_plugins().get(id) {
        None => Some(Observation::Paused {
            code: "watch_registration_removed",
            message: format!(
                "Watching {id} is paused because its registration was removed; explicitly register and enable or reload the plugin to select its source."
            ),
        }),
        Some(registration) if registration.path != source.path => Some(Observation::Paused {
            code: "watch_registration_path_changed",
            message: format!(
                "Watching {id} is paused because its registered directory changed; enable or reload it manually to select that source."
            ),
        }),
        Some(_) if !registry.is_enabled(id) => Some(Observation::Paused {
            code: "watch_plugin_disabled",
            message: format!(
                "Watching {id} is paused because its current preference is disabled; enable it explicitly before reloading."
            ),
        }),
        Some(registration)
            if matches!(
                source.executor(),
                Some(LocalWatchExecutor::Host | LocalWatchExecutor::Combined)
            ) && registration.grants.as_slice() != source.grants =>
        {
            Some(Observation::Paused {
                code: "watch_grants_changed",
                message: format!(
                    "Watching {id} is paused because its grants changed; enable or reload it manually to select the current trust settings."
                ),
            })
        }
        Some(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_plugins::load_local_plugin;
    use crate::plugins::{LoadedPlugin, LocalPluginRegistration};
    use serde_json::json;
    use tempfile::{TempDir, tempdir};

    struct Watched {
        path: PathBuf,
        grants: Vec<Permission>,
        plugin: LoadedPlugin,
    }

    struct Fixture {
        directory: TempDir,
        registry_path: PathBuf,
        plugins: Vec<Watched>,
    }

    impl Fixture {
        fn new(ids: &[&str]) -> Self {
            let directory = tempdir().unwrap();
            let registry_path = directory.path().join("config.json");
            let mut registry = PluginRegistry::load(&registry_path).unwrap();
            let mut plugins = Vec::new();
            for id in ids {
                let path = directory.path().join(id);
                std::fs::create_dir(&path).unwrap();
                let mut manifest = json!({"schema":1,"id":id,"version":"1","renderer":{"entry":"renderer.js","world":"isolated"}});
                if *id == "dev.provider" || (*id == "dev.a" && ids.contains(&"dev.z")) {
                    manifest["provides"] = json!([{"name":"dev.api","api":1,"scope":"target"}]);
                }
                if matches!(*id, "dev.consumer" | "dev.z") {
                    manifest["requires"] = json!([{"name":"dev.api","api":1,"scope":"target"}]);
                }
                std::fs::write(path.join("codlet.json"), manifest.to_string()).unwrap();
                std::fs::write(
                    path.join("renderer.js"),
                    "module.exports = { activate() {}, deactivate() {} };",
                )
                .unwrap();
                registry
                    .register_local(
                        id,
                        LocalPluginRegistration {
                            broker_policy: Default::default(),
                            path: path.clone(),
                            grants: vec![],
                        },
                    )
                    .unwrap();
                plugins.push(Watched {
                    plugin: load_local_plugin(id, &path, &[], 1).unwrap(),
                    path,
                    grants: vec![],
                });
            }
            registry.save().unwrap();
            Self {
                directory,
                registry_path,
                plugins,
            }
        }

        fn sources(&self) -> Vec<LocalWatchSource<'_>> {
            self.plugins
                .iter()
                .map(|source| LocalWatchSource {
                    path: &source.path,
                    grants: &source.grants,
                    plugin: &source.plugin,
                })
                .collect()
        }

        fn poll(
            &self,
            watcher: &mut PluginWatcher,
            start: Instant,
            tick: u64,
        ) -> Option<PluginControlRequest> {
            watcher.poll(start + Duration::from_millis(250 * tick), &self.sources())
        }

        fn source(&self, index: usize, text: &str) {
            let plugin = &self.plugins[index];
            let entry = plugin
                .plugin
                .manifest
                .renderer
                .as_ref()
                .map(|entry| entry.entry.as_str())
                .or_else(|| {
                    plugin
                        .plugin
                        .manifest
                        .host
                        .as_ref()
                        .map(|entry| entry.entry.as_str())
                })
                .unwrap();
            std::fs::write(plugin.path.join(entry), text).unwrap();
        }

        fn load_generation(&mut self, index: usize, generation: u64) {
            let source = &mut self.plugins[index];
            source.plugin = load_local_plugin(
                &source.plugin.manifest.id,
                &source.path,
                &source.grants,
                generation,
            )
            .unwrap();
        }
    }

    #[test]
    fn persisted_switch_starts_stops_and_restores_real_source_observation() {
        use crate::runtime_control::ControlBroker;
        use crate::runtime_manage::RuntimeManageService;
        let mut fixture = Fixture::new(&["dev.plugin"]);
        let broker = ControlBroker::new([71; 16], "watch-settings".into());
        broker.set_ready();
        let api = RuntimeManageService::new(broker.clone())
            .with_local_management(fixture.registry_path.clone(), false);
        let mut watcher = None;
        configure_watcher(
            &mut watcher,
            api.local_watch_enabled(),
            &fixture.registry_path,
        );
        assert!(watcher.is_none());
        let values = json!({"checkPluginUpdatesOnStartup":true,"automaticUpdateChecks":true,"showPluginTags":true,"updateCheckIntervalSeconds":null,"localSourceAutoReload":true});
        api.invoke(
            "saveSettings",
            json!({"expectedRevision":0,"values":values}),
        )
        .unwrap();
        configure_watcher(
            &mut watcher,
            api.local_watch_enabled(),
            &fixture.registry_path,
        );
        let start = Instant::now();
        assert!(fixture.poll(watcher.as_mut().unwrap(), start, 0).is_none());
        fixture.source(
            0,
            "// changed\nmodule.exports = {activate(){},deactivate(){}};",
        );
        assert!(fixture.poll(watcher.as_mut().unwrap(), start, 1).is_none());
        assert_eq!(
            fixture
                .poll(watcher.as_mut().unwrap(), start, 2)
                .unwrap()
                .plugin_id,
            "dev.plugin"
        );
        let mut off = values.clone();
        off["localSourceAutoReload"] = json!(false);
        api.invoke("saveSettings", json!({"expectedRevision":1,"values":off}))
            .unwrap();
        configure_watcher(
            &mut watcher,
            api.local_watch_enabled(),
            &fixture.registry_path,
        );
        assert!(watcher.is_none());
        api.invoke(
            "saveSettings",
            json!({"expectedRevision":2,"values":values}),
        )
        .unwrap();
        let restarted = RuntimeManageService::new(broker)
            .with_local_management(fixture.registry_path.clone(), false);
        fixture.load_generation(0, 2);
        configure_watcher(
            &mut watcher,
            restarted.local_watch_enabled(),
            &fixture.registry_path,
        );
        assert!(watcher.is_some());
        let start = Instant::now();
        assert!(fixture.poll(watcher.as_mut().unwrap(), start, 0).is_none());
        fixture.source(
            0,
            "// saved after restart\nmodule.exports = {activate(){},deactivate(){}};",
        );
        assert!(fixture.poll(watcher.as_mut().unwrap(), start, 1).is_none());
        assert!(fixture.poll(watcher.as_mut().unwrap(), start, 2).is_some());
    }

    #[test]
    fn watch_coalesces_writes_atomic_replacement_deletion_and_distinct_invalid_json() {
        let fixture = Fixture::new(&["dev.plugin"]);
        let mut watcher = PluginWatcher::new(fixture.registry_path.clone());
        let start = Instant::now();
        assert!(fixture.poll(&mut watcher, start, 0).is_none());
        fixture.source(0, "// edit one\nmodule.exports = {};");
        assert!(fixture.poll(&mut watcher, start, 1).is_none());
        fixture.source(0, "// edit two\nmodule.exports = {};");
        assert!(fixture.poll(&mut watcher, start, 2).is_none());
        assert!(
            watcher
                .poll(start + Duration::from_millis(600), &fixture.sources())
                .is_none()
        );
        assert_eq!(
            fixture.poll(&mut watcher, start, 3).unwrap().plugin_id,
            "dev.plugin"
        );
        assert!(fixture.poll(&mut watcher, start, 4).is_none());
        assert!(fixture.poll(&mut watcher, start, 5).is_none());

        let staged = fixture.plugins[0].path.join("replacement.js");
        std::fs::write(&staged, "// atomic replacement\nmodule.exports = {};").unwrap();
        std::fs::rename(&staged, fixture.plugins[0].path.join("renderer.js")).unwrap();
        assert!(fixture.poll(&mut watcher, start, 6).is_none());
        assert!(fixture.poll(&mut watcher, start, 7).is_some());
        std::fs::remove_file(fixture.plugins[0].path.join("renderer.js")).unwrap();
        assert!(fixture.poll(&mut watcher, start, 8).is_none());
        assert!(fixture.poll(&mut watcher, start, 9).is_some());
        assert!(fixture.poll(&mut watcher, start, 10).is_none());
        fixture.source(0, fixture.plugins[0].plugin.source.as_deref().unwrap());
        assert!(fixture.poll(&mut watcher, start, 11).is_none());
        assert!(fixture.poll(&mut watcher, start, 12).is_none());

        let manifest = fixture.plugins[0].path.join("codlet.json");
        std::fs::write(&manifest, r#"{"unexpected":1}"#).unwrap();
        assert!(fixture.poll(&mut watcher, start, 13).is_none());
        assert!(fixture.poll(&mut watcher, start, 14).is_some());
        std::fs::write(&manifest, r#"{"unexpected":2}"#).unwrap();
        assert!(fixture.poll(&mut watcher, start, 15).is_none());
        assert!(fixture.poll(&mut watcher, start, 16).is_some());
        assert!(fixture.poll(&mut watcher, start, 17).is_none());
        assert!(watcher.take_diagnostics().is_empty());
    }

    #[test]
    fn watch_keeps_failed_attempts_across_rollback_and_observes_grants_and_manual_baselines() {
        let mut fixture = Fixture::new(&["dev.plugin"]);
        let mut watcher = PluginWatcher::new(fixture.registry_path.clone());
        let start = Instant::now();
        assert!(fixture.poll(&mut watcher, start, 0).is_none());
        fixture.source(0, "// failed candidate\nmodule.exports = {};");
        assert!(fixture.poll(&mut watcher, start, 1).is_none());
        assert!(fixture.poll(&mut watcher, start, 2).is_some());
        fixture.plugins[0].plugin.generation = 3; // Old source restored after candidate 2.
        for tick in 3..=5 {
            assert!(fixture.poll(&mut watcher, start, tick).is_none());
        }

        let manifest_path = fixture.plugins[0].path.join("codlet.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        manifest["permissions"] = json!(["ui.dom"]);
        std::fs::write(&manifest_path, manifest.to_string()).unwrap();
        assert!(fixture.poll(&mut watcher, start, 6).is_none());
        assert!(fixture.poll(&mut watcher, start, 7).is_some());
        assert!(fixture.poll(&mut watcher, start, 8).is_none());
        let mut registry = PluginRegistry::load(&fixture.registry_path).unwrap();
        registry
            .register_local(
                "dev.plugin",
                LocalPluginRegistration {
                    broker_policy: Default::default(),
                    path: fixture.plugins[0].path.clone(),
                    grants: vec![Permission::UiDom],
                },
            )
            .unwrap();
        registry.save().unwrap();
        assert!(fixture.poll(&mut watcher, start, 9).is_none());
        assert!(fixture.poll(&mut watcher, start, 10).is_some());

        fixture.plugins[0].grants = vec![Permission::UiDom];
        fixture.load_generation(0, 4);
        assert!(fixture.poll(&mut watcher, start, 11).is_none());
        assert!(fixture.poll(&mut watcher, start, 12).is_none());
        fixture.source(
            0,
            "// source captured by a manual reload\nmodule.exports = {};",
        );
        assert!(fixture.poll(&mut watcher, start, 13).is_none());
        fixture.load_generation(0, 5);
        fixture.source(
            0,
            "// saved again while that manual activation was running\nmodule.exports = {};",
        );
        assert!(fixture.poll(&mut watcher, start, 14).is_none());
        assert!(fixture.poll(&mut watcher, start, 15).is_some());
        assert!(watcher.poll(start + Duration::from_secs(4), &[]).is_none());
        fixture.load_generation(0, 6);
        assert!(fixture.poll(&mut watcher, start, 17).is_none());
        assert!(fixture.poll(&mut watcher, start, 18).is_none());
    }

    #[test]
    fn watch_prefers_provider_groups_and_retries_a_failed_group_only_after_another_stable_edit() {
        let mut fixture = Fixture::new(&["dev.provider", "dev.consumer"]);
        let mut watcher = PluginWatcher::new(fixture.registry_path.clone());
        let start = Instant::now();
        assert!(fixture.poll(&mut watcher, start, 0).is_none());
        fixture.source(0, "// revised provider\nmodule.exports = {};");
        fixture.source(1, "// revised consumer\nmodule.exports = {};");
        assert!(fixture.poll(&mut watcher, start, 1).is_none());
        assert_eq!(
            fixture.poll(&mut watcher, start, 2).unwrap().plugin_id,
            "dev.provider"
        );
        for plugin in &mut fixture.plugins {
            plugin.plugin.generation = 3;
        }
        for tick in 3..=5 {
            assert!(fixture.poll(&mut watcher, start, tick).is_none());
        }
        fixture.source(
            1,
            "// consumer corrected after the group failed\nmodule.exports = {};",
        );
        assert!(fixture.poll(&mut watcher, start, 6).is_none());
        assert_eq!(
            fixture.poll(&mut watcher, start, 7).unwrap().plugin_id,
            "dev.provider"
        );
        assert!(fixture.poll(&mut watcher, start, 8).is_none());
    }

    #[test]
    fn watch_pins_loaded_paths_including_dependents_and_does_not_adopt_new_registrations() {
        let mut fixture = Fixture::new(&["dev.provider", "dev.consumer"]);
        let mut watcher = PluginWatcher::new(fixture.registry_path.clone());
        let start = Instant::now();
        assert!(fixture.poll(&mut watcher, start, 0).is_none());
        fixture.source(
            0,
            "// provider pending while consumer trust changes\nmodule.exports = {};",
        );
        assert!(fixture.poll(&mut watcher, start, 1).is_none());
        let mut registry = PluginRegistry::load(&fixture.registry_path).unwrap();
        registry.remove_local("dev.consumer").unwrap();
        registry.save().unwrap();
        assert!(fixture.poll(&mut watcher, start, 2).is_none());
        assert!(fixture.poll(&mut watcher, start, 3).is_none());
        assert_eq!(
            watcher.take_diagnostics()[0].code,
            "watch_registration_removed"
        );
        assert!(fixture.poll(&mut watcher, start, 4).is_none());
        assert!(watcher.take_diagnostics().is_empty());

        let replacement = fixture.directory.path().join("replacement-consumer");
        std::fs::create_dir(&replacement).unwrap();
        std::fs::copy(
            fixture.plugins[1].path.join("codlet.json"),
            replacement.join("codlet.json"),
        )
        .unwrap();
        std::fs::write(
            replacement.join("renderer.js"),
            "// manually selected replacement\nmodule.exports = {};",
        )
        .unwrap();
        registry
            .register_local(
                "dev.consumer",
                LocalPluginRegistration {
                    broker_policy: Default::default(),
                    path: replacement.clone(),
                    grants: vec![],
                },
            )
            .unwrap();
        registry
            .register_local(
                "dev.unloaded",
                LocalPluginRegistration {
                    broker_policy: Default::default(),
                    path: fixture.directory.path().join("unloaded"),
                    grants: vec![],
                },
            )
            .unwrap();
        registry.save().unwrap();
        assert!(fixture.poll(&mut watcher, start, 5).is_none());
        assert!(fixture.poll(&mut watcher, start, 6).is_none());
        assert_eq!(
            watcher.take_diagnostics()[0].code,
            "watch_registration_path_changed"
        );
        assert!(!watcher.states.contains_key("dev.unloaded"));
        fixture.plugins[1].path = replacement;
        fixture.load_generation(1, 2);
        assert!(fixture.poll(&mut watcher, start, 7).is_none());
        assert_eq!(
            fixture.poll(&mut watcher, start, 8).unwrap().plugin_id,
            "dev.provider"
        );

        let saved_registry = std::fs::read(&fixture.registry_path).unwrap();
        std::fs::write(&fixture.registry_path, "invalid registry").unwrap();
        assert!(fixture.poll(&mut watcher, start, 9).is_none());
        assert!(fixture.poll(&mut watcher, start, 10).is_none());
        assert_eq!(
            watcher.take_diagnostics()[0].code,
            "watch_registry_unavailable"
        );
        assert!(fixture.poll(&mut watcher, start, 11).is_none());
        assert!(watcher.take_diagnostics().is_empty());
        std::fs::write(&fixture.registry_path, saved_registry).unwrap();
        assert!(fixture.poll(&mut watcher, start, 12).is_none());
    }

    #[test]
    fn watch_scan_work_is_bounded_and_round_robin_does_not_starve_later_sources() {
        let fixture = Fixture::new(&[
            "dev.a", "dev.b", "dev.c", "dev.d", "dev.e", "dev.f", "dev.g", "dev.h", "dev.i",
        ]);
        let mut watcher = PluginWatcher::new(fixture.registry_path.clone());
        let start = Instant::now();
        for index in 0..fixture.plugins.len() {
            fixture.source(index, "// edited\nmodule.exports = {};");
        }
        assert!(fixture.poll(&mut watcher, start, 0).is_none());
        assert_eq!(
            watcher
                .states
                .values()
                .filter(|state| state.stable_samples != 0)
                .count(),
            MAX_SOURCES_PER_POLL
        );
        let mut requested = BTreeSet::new();
        for tick in 1..=15 {
            if let Some(request) = fixture.poll(&mut watcher, start, tick) {
                assert!(requested.insert(request.plugin_id));
            }
        }
        assert_eq!(requested.len(), fixture.plugins.len());
    }

    #[test]
    fn watch_waits_for_consumers_outside_the_providers_first_scan_batch() {
        let fixture = Fixture::new(&["dev.a", "dev.b", "dev.c", "dev.d", "dev.z"]);
        let mut watcher = PluginWatcher::new(fixture.registry_path.clone());
        let start = Instant::now();
        fixture.source(0, "// provider changed\nmodule.exports = {};");
        fixture.source(4, "// consumer changed\nmodule.exports = {};");
        assert!(fixture.poll(&mut watcher, start, 0).is_none());
        // A has two samples here, but Z has only just been sampled once.
        assert!(fixture.poll(&mut watcher, start, 1).is_none());
        assert_eq!(
            fixture.poll(&mut watcher, start, 2).unwrap().plugin_id,
            "dev.a"
        );
        let mut registry = PluginRegistry::load(&fixture.registry_path).unwrap();
        let registration = registry.local_plugins()["dev.z"].clone();
        registry.remove_local("dev.z").unwrap();
        registry.save().unwrap();
        fixture.source(
            0,
            "// another provider edit while its consumer is paused\nmodule.exports = {};",
        );
        assert!(fixture.poll(&mut watcher, start, 3).is_none());
        assert!(fixture.poll(&mut watcher, start, 4).is_none());
        registry.register_local("dev.z", registration).unwrap();
        registry.save().unwrap();
        // Z is not sampled in this batch. Its old settled Paused observation
        // must not count as stable source bytes merely because trust returned.
        assert!(fixture.poll(&mut watcher, start, 5).is_none());
        assert!(fixture.poll(&mut watcher, start, 6).is_none());
        assert_eq!(
            fixture.poll(&mut watcher, start, 7).unwrap().plugin_id,
            "dev.a"
        );
    }

    #[test]
    fn watch_ignores_manifest_layout_but_follows_a_validated_entry_change() {
        let mut fixture = Fixture::new(&["dev.plugin"]);
        let mut watcher = PluginWatcher::new(fixture.registry_path.clone());
        let start = Instant::now();
        assert!(fixture.poll(&mut watcher, start, 0).is_none());
        let manifest = fixture.plugins[0].path.join("codlet.json");
        let mut parsed: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
        std::fs::write(&manifest, serde_json::to_vec_pretty(&parsed).unwrap()).unwrap();
        assert!(fixture.poll(&mut watcher, start, 1).is_none());
        assert!(fixture.poll(&mut watcher, start, 2).is_none());
        parsed["renderer"]["entry"] = json!("replacement.js");
        std::fs::write(&manifest, parsed.to_string()).unwrap();
        std::fs::write(
            fixture.plugins[0].path.join("replacement.js"),
            "// new entry\nmodule.exports = {};",
        )
        .unwrap();
        assert!(fixture.poll(&mut watcher, start, 3).is_none());
        assert!(fixture.poll(&mut watcher, start, 4).is_some());
        fixture.load_generation(0, 2);
        std::fs::write(
            fixture.plugins[0].path.join("renderer.js"),
            "// old entry edits no longer matter",
        )
        .unwrap();
        assert!(fixture.poll(&mut watcher, start, 5).is_none());
        assert!(fixture.poll(&mut watcher, start, 6).is_none());
    }

    #[test]
    fn mixed_host_and_renderer_sources_share_one_bounded_round_robin_scan() {
        let mut fixture = Fixture::new(&[
            "dev.p0", "dev.p1", "dev.p2", "dev.p3", "dev.p4", "dev.p5", "dev.p6", "dev.p7",
            "dev.p8",
        ]);
        let mut registry = PluginRegistry::load(&fixture.registry_path).unwrap();
        for index in (0..fixture.plugins.len()).step_by(2) {
            let source = &mut fixture.plugins[index];
            let id = source.plugin.manifest.id.clone();
            // Production host watch anchors are the loader's canonical root.
            // Renderer fixtures retain their existing path contract.
            registry.remove_local(&id).unwrap();
            source.path = std::fs::canonicalize(&source.path).unwrap();
            std::fs::write(source.path.join("codlet.json"), json!({"schema":1,"id":id,"version":"1","host":{"entry":"host.js"},"permissions":["host.process"]}).to_string()).unwrap();
            std::fs::write(
                source.path.join("host.js"),
                "module.exports = { activate() {}, deactivate() {} };",
            )
            .unwrap();
            source.grants = vec![Permission::HostProcess];
            registry
                .register_local(
                    &id,
                    LocalPluginRegistration {
                        broker_policy: Default::default(),
                        path: source.path.clone(),
                        grants: source.grants.clone(),
                    },
                )
                .unwrap();
            source.plugin = load_local_plugin(&id, &source.path, &source.grants, 1).unwrap();
        }
        registry.save().unwrap();
        let mut watcher = PluginWatcher::new(fixture.registry_path.clone());
        let start = Instant::now();
        assert!(fixture.poll(&mut watcher, start, 0).is_none());
        assert_eq!(
            watcher
                .states
                .values()
                .filter(|state| state.stable_samples != 0)
                .count(),
            MAX_SOURCES_PER_POLL
        );
        for index in 0..fixture.plugins.len() {
            fixture.source(
                index,
                "// changed\nmodule.exports = { activate() {}, deactivate() {} };",
            );
        }
        let mut requested = BTreeSet::new();
        for tick in 1..=20 {
            if let Some(request) = fixture.poll(&mut watcher, start, tick) {
                assert!(requested.insert(request.plugin_id));
            }
        }
        assert_eq!(requested.len(), fixture.plugins.len());
        assert!(watcher.take_diagnostics().is_empty());
    }
}
