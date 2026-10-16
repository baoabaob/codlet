//! Logical package hooks used by the foreground host/renderer transaction.

use super::*;
use crate::capabilities::{host_provider_id, host_provider_plugin_id};
use crate::catalog::PluginCatalogEntry;
use crate::plugin_control::{PluginControlError, PluginTargetFailure};
use crate::plugin_execution::ExecutionState;

#[derive(Clone)]
pub(crate) struct CoreIngressTarget {
    target: String,
    epoch: u64,
    context: u64,
    gate_epoch: String,
}

impl RendererRuntime {
    /// Close ordinary SDK admission in every live realm, independently of each
    /// plugin's resumable snapshot. Future candidate/rollback realms inherit it.
    pub(crate) fn begin_core_admission(&mut self, operation: &str) -> Vec<PluginTargetFailure> {
        if operation.is_empty()
            || operation.len() > 256
            || operation.chars().any(|value| value.is_control())
        {
            return vec![failure(
                "core-renderer",
                "core_admission_pause",
                "Invalid Core admission operation identity".into(),
            )];
        }
        if self
            .core_admission_operation
            .as_deref()
            .is_some_and(|current| current != operation)
        {
            return vec![failure(
                "core-renderer",
                "core_admission_pause",
                "Another Core operation holds renderer admission".into(),
            )];
        }
        self.core_admission_operation = Some(operation.to_owned());
        self.set_core_admission_contexts(operation, true)
    }

    pub(crate) fn resume_core_admission(&mut self, operation: &str) -> Vec<PluginTargetFailure> {
        if self.core_admission_operation.as_deref() != Some(operation) {
            return vec![failure(
                "core-renderer",
                "core_admission_resume",
                "This operation does not own renderer admission".into(),
            )];
        }
        let failures = self.set_core_admission_contexts(operation, false);
        if failures.is_empty() {
            self.core_admission_operation = None;
        } else {
            // Keep future realms held and compensate realms which resumed before
            // another realm refused. The coordinator still owns Native ingress.
            let mut failures = failures;
            failures.extend(self.set_core_admission_contexts(operation, true));
            return failures;
        }
        failures
    }

    fn set_core_admission_contexts(
        &mut self,
        operation: &str,
        paused: bool,
    ) -> Vec<PluginTargetFailure> {
        let stage = if paused {
            "core_admission_pause"
        } else {
            "core_admission_resume"
        };
        let mut contexts = BTreeMap::new();
        for (target, session) in &self.sessions {
            if !session.session.is_live() || session.recovery_pending {
                continue;
            }
            for plugin in &session.plugins {
                if let Some(context) = plugin.context_id {
                    contexts
                        .entry((target.clone(), session.document_epoch, context))
                        .or_insert_with(|| plugin.id.clone());
                }
            }
        }
        let expression = core_admission_expression(operation, paused);
        let mut failures = Vec::new();
        for ((target, epoch, context), plugin) in contexts {
            let result = if self.sessions.get(&target).is_none_or(|session| {
                !session.session.is_live()
                    || session.document_epoch != epoch
                    || session.recovery_pending
            }) {
                Err("Renderer document changed during Core admission transfer".into())
            } else {
                self.evaluate_with_binding_pump(&target, &expression, context)
                    .and_then(parse_lifecycle_result)
            };
            if let Err(error) = result {
                failures.push(PluginTargetFailure {
                    target_id: target,
                    plugin_id: plugin,
                    stage: stage.into(),
                    error,
                });
            }
        }
        failures
    }

    /// Hold new Native submissions above the replaceable Desktop hooks. Responses
    /// and already admitted operations keep their original transport/receipt.
    pub(crate) fn pause_core_ingress(
        &mut self,
        operation: &str,
    ) -> (Vec<CoreIngressTarget>, Vec<PluginTargetFailure>) {
        let mut targets = Vec::new();
        let mut failures = Vec::new();
        for (target, session) in &self.sessions {
            if !session.session.is_live() || session.recovery_pending {
                continue;
            }
            let context = session
                .plugins
                .iter()
                .find(|plugin| {
                    plugin.id == crate::codex::DESKTOP_PROVIDER_ID
                        && plugin.activation_confirmed
                        && plugin.world == RendererWorld::Main
                })
                .and_then(|plugin| plugin.context_id);
            if let Some(context) = context {
                targets.push(CoreIngressTarget {
                    target: target.clone(),
                    epoch: session.document_epoch,
                    context,
                    gate_epoch: String::new(),
                });
            } else {
                failures.push(PluginTargetFailure {
                    target_id: target.clone(),
                    plugin_id: crate::codex::DESKTOP_PROVIDER_ID.into(),
                    stage: "core_ingress_pause".into(),
                    error: "Core Desktop ingress is not ready in this document".into(),
                });
            }
        }
        targets.sort_by(|a, b| a.target.cmp(&b.target));
        if targets.is_empty() && failures.is_empty() {
            failures.push(PluginTargetFailure {
                target_id: String::new(),
                plugin_id: crate::codex::DESKTOP_PROVIDER_ID.into(),
                stage: "core_ingress_pause".into(),
                error: "No owned Native ingress target is available".into(),
            });
        }
        if !failures.is_empty() {
            return (Vec::new(), failures);
        }
        let preflight = "(() => { const gate=globalThis[Symbol.for('codlet.core.native-ingress.v1')]; return gate?.api===1 && typeof gate.pause==='function' && typeof gate.resume==='function' && typeof gate.documentEpoch==='string' && gate.documentEpoch.length>0 && gate.documentEpoch.length<=256 ? {ok:true,documentEpoch:gate.documentEpoch} : {ok:false,error:'Core Native ingress does not support coordinated transfer'}; })()";
        for target in &mut targets {
            let result = self
                .evaluate_with_binding_pump(&target.target, preflight, target.context)
                .and_then(|value| {
                    parse_lifecycle_result(value.clone())?;
                    value
                        .pointer("/result/value/documentEpoch")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .ok_or_else(|| "Native ingress did not return its document identity".into())
                });
            match result {
                Ok(epoch) => target.gate_epoch = epoch,
                Err(error) => failures.push(PluginTargetFailure {
                    target_id: target.target.clone(),
                    plugin_id: crate::codex::DESKTOP_PROVIDER_ID.into(),
                    stage: "core_ingress_pause".into(),
                    error,
                }),
            }
        }
        if !failures.is_empty() {
            return (Vec::new(), failures);
        }
        let encoded = serde_json::to_string(operation).expect("operation ID JSON");
        let mut held = Vec::new();
        for target in &targets {
            let gate_epoch =
                serde_json::to_string(&target.gate_epoch).expect("document identity JSON");
            let expression = format!(
                "(() => {{ const gate = globalThis[Symbol.for('codlet.core.native-ingress.v1')]; if (gate?.api !== 1 || gate.documentEpoch !== {gate_epoch} || typeof gate.pause !== 'function') return {{ok:false,error:'Core Native ingress identity changed'}}; const value=gate.pause({encoded}); return value?.ok===true && value.held===true && value.documentEpoch==={gate_epoch} ? {{ok:true}} : {{ok:false,error:value?.message ?? 'Native ingress pause was not confirmed'}}; }})()"
            );
            let raw = self.evaluate_with_binding_pump(&target.target, &expression, target.context);
            // A definite refusal did not acquire this transaction's gate. A lost
            // or malformed reply may have paused it, so retain that exact target
            // for compensation instead of pretending admission stayed open.
            if !raw
                .as_ref()
                .is_ok_and(|value| value.pointer("/result/value/ok") == Some(&Value::Bool(false)))
            {
                held.push(target.clone());
            }
            let result = raw.and_then(parse_lifecycle_result);
            if let Err(error) = result {
                failures.push(PluginTargetFailure {
                    target_id: target.target.clone(),
                    plugin_id: crate::codex::DESKTOP_PROVIDER_ID.into(),
                    stage: "core_ingress_pause".into(),
                    error,
                });
            }
            if self.sessions.get(&target.target).is_none_or(|session| {
                session.document_epoch != target.epoch || session.recovery_pending
            }) {
                failures.push(PluginTargetFailure {
                    target_id: target.target.clone(),
                    plugin_id: crate::codex::DESKTOP_PROVIDER_ID.into(),
                    stage: "core_ingress_pause".into(),
                    error: "Native document changed while admission was being paused".into(),
                });
            }
        }
        (held, failures)
    }

    pub(crate) fn resume_core_ingress(
        &mut self,
        operation: &str,
        targets: &[CoreIngressTarget],
        applied: bool,
    ) -> Vec<PluginTargetFailure> {
        let encoded = serde_json::to_string(operation).expect("operation ID JSON");
        let outcome = if applied { "applied" } else { "rolledBack" };
        let mut failures = Vec::new();
        for target in targets {
            let gate_epoch =
                serde_json::to_string(&target.gate_epoch).expect("document identity JSON");
            let expression = format!(
                "(() => {{ const gate=globalThis[Symbol.for('codlet.core.native-ingress.v1')]; if(gate?.api!==1 || gate.documentEpoch!=={gate_epoch} || typeof gate.resume!=='function') return {{ok:false,error:'Core Native ingress owner changed'}}; const value=gate.resume({encoded},{{outcome:'{outcome}'}}); return value?.ok===true && value.resumed===true && value.documentEpoch==={gate_epoch} ? {{ok:true}} : {{ok:false,error:value?.message ?? 'Native ingress resume was not confirmed'}}; }})()"
            );
            let result = if self.sessions.get(&target.target).is_none_or(|session| {
                !session.session.is_live()
                    || session.document_epoch != target.epoch
                    || session.recovery_pending
            }) {
                Err("Original Native document retired before admission could be resumed".into())
            } else {
                self.evaluate_with_binding_pump(&target.target, &expression, target.context)
                    .and_then(parse_lifecycle_result)
            };
            if let Err(error) = result {
                failures.push(PluginTargetFailure {
                    target_id: target.target.clone(),
                    plugin_id: crate::codex::DESKTOP_PROVIDER_ID.into(),
                    stage: "core_ingress_resume".into(),
                    error,
                });
            }
        }
        failures
    }

    pub(crate) fn validate_core_ingress_targets(
        &self,
        targets: &[CoreIngressTarget],
    ) -> Result<(), String> {
        let held = targets
            .iter()
            .map(|target| (target.target.clone(), target.epoch))
            .collect::<BTreeSet<_>>();
        let current = self
            .sessions
            .iter()
            .filter(|(_, session)| session.session.is_live())
            .map(|(id, session)| (id.clone(), session.document_epoch))
            .collect::<BTreeSet<_>>();
        if current != held
            || self
                .sessions
                .values()
                .any(|session| session.session.is_live() && session.recovery_pending)
        {
            return Err("The owned Native document set changed during Core transfer; new forward work is not admitted".into());
        }
        Ok(())
    }

    pub(crate) fn core_update_service(
        &self,
    ) -> Option<crate::runtime_update::RuntimeUpdateService> {
        self.manage_service.as_ref()?.runtime_update_service()
    }
    pub(crate) fn revoke_package_authority(&mut self, affected: &BTreeSet<String>) {
        self.remove_managed_providers(affected);
        for id in affected {
            let _ = self.capabilities.unregister_provider(&host_provider_id(id));
        }
        let targets = self.sessions.keys().cloned().collect::<Vec<_>>();
        for target in targets {
            for id in affected {
                self.cancel_host_capabilities_for(&target, Some(id));
            }
        }
    }
    pub(crate) fn pending_package_disables(&self) -> Vec<String> {
        self.pending_package_disables.iter().cloned().collect()
    }
    pub(crate) fn acknowledge_package_disable(&mut self, id: &str) {
        self.pending_package_disables.remove(id);
    }

    pub(crate) fn logical_plugins(&self) -> Vec<LoadedPlugin> {
        let plugins: BTreeMap<_, _> = self
            .host_plugins
            .iter()
            .chain(&self.plugins)
            .map(|plugin| (plugin.manifest.id.clone(), plugin.clone()))
            .collect();
        plugins.into_values().collect()
    }

    pub(crate) fn package_generations(&self) -> BTreeMap<String, u64> {
        self.generations.clone()
    }

    pub(crate) fn validate_package_shape(
        &self,
        plugin: &LoadedPlugin,
    ) -> Result<(), PluginControlError> {
        #[cfg(any(windows, target_os = "macos"))]
        if let Some(reason) = self.catalog.startup_suspension(&plugin.manifest.id)
            && self.client_source.is_none()
        {
            return Err(PluginControlError::new(
                "startup_plugin_suspended",
                format!(
                    "Plugin {} is temporarily disabled for this launch ({reason}); restart Codlet to retry after updating its adapter",
                    plugin.manifest.id
                ),
            ));
        }
        let shape = (
            plugin.manifest.renderer.is_some(),
            plugin.manifest.host.is_some(),
        );
        if self
            .entry_shapes
            .get(&plugin.manifest.id)
            .is_some_and(|current| *current != shape)
        {
            return Err(PluginControlError::new(
                "executor_kind_changed",
                format!(
                    "plugin {} already owns a different set of entries; changing entry kinds requires restarting Codlet",
                    plugin.manifest.id
                ),
            ));
        }
        Ok(())
    }
    pub(crate) fn reset_package_shape(&mut self, id: &str) {
        self.entry_shapes.remove(id);
    }
    pub(crate) fn forget_uninstalled_package(&mut self, id: &str) {
        self.entry_shapes.remove(id);
        self.catalog.forget_local_entry(id);
    }

    #[cfg(any(windows, target_os = "macos"))]
    pub(crate) fn set_client_source(
        &mut self,
        source: Option<crate::client_bridge::ClientSourceRuntime>,
    ) {
        self.client_source = source;
    }
    #[cfg(any(windows, target_os = "macos"))]
    pub(crate) fn client_source(&self) -> Option<crate::client_bridge::ClientSourceRuntime> {
        self.client_source.clone()
    }
    pub(crate) fn resume_startup_plugins(&mut self, ids: &BTreeSet<String>) {
        self.catalog.resume_startup(ids);
    }
    pub(crate) fn startup_suspended(&self, id: &str) -> bool {
        self.catalog.startup_suspension(id).is_some()
    }

    pub(crate) fn begin_package_management(
        &mut self,
        generations: BTreeMap<String, u64>,
        plugins: &[LoadedPlugin],
    ) -> Result<(), PluginControlError> {
        self.ensure_core_management_available()?;
        if self.management_active || self.drive_depth != 0 || self.drive_deadline.is_some() {
            return Err(PluginControlError::new(
                "runtime_busy",
                "a renderer lifecycle operation is in progress",
            ));
        }
        self.flush_host_actions();
        self.reserve_world_capacity(plugins)?;
        self.management_active = true;
        self.generations = generations;
        for plugin in plugins {
            self.entry_shapes.insert(
                plugin.manifest.id.clone(),
                (
                    plugin.manifest.renderer.is_some(),
                    plugin.manifest.host.is_some(),
                ),
            );
        }
        self.publish_status();
        Ok(())
    }

    pub(crate) fn finish_package_management(
        &mut self,
        registry: PluginRegistry,
        generations: BTreeMap<String, u64>,
    ) {
        self.world_reservations.clear();
        self.reload_snapshots.clear();
        self.reload_state_missing.clear();
        self.plugin_registry = registry;
        self.generations = generations;
        self.management_active = self.core_management_unsettled;
        self.drive_deadline = None;
        self.publish_status();
        self.flush_host_actions();
    }

    pub(crate) fn ensure_core_management_available(&self) -> Result<(), PluginControlError> {
        if self.core_management_unsettled || self.core_admission_operation.is_some() {
            return Err(PluginControlError::new(
                "core_update_unsettled",
                "Core admission is held by an unresolved update. Read the original update status; new plugin lifecycle work requires confirmed recovery or a natural next start.",
            ));
        }
        Ok(())
    }

    pub(crate) fn retain_core_management(&mut self) {
        self.core_management_unsettled = true;
        self.management_active = true;
    }

    pub(crate) fn package_has_live_target(&self) -> bool {
        self.sessions
            .values()
            .any(|session| session.session.is_live() && !session.recovery_pending)
    }

    pub(crate) fn package_is_active(&self, plugin: &LoadedPlugin) -> bool {
        let host_ready = !plugin.manifest.has_runtime_host()
            || self.external_observations.iter().any(|observation| {
                observation.plugin.manifest.id == plugin.manifest.id
                    && observation.plugin.generation == plugin.generation
                    && observation.state == ExecutionState::Active
            });
        let renderer_ready = plugin.manifest.renderer.is_none()
            || (self.package_has_live_target()
                && self
                    .sessions
                    .values()
                    .filter(|session| session.session.is_live())
                    .all(|session| {
                        !session.recovery_pending
                            && session.plugins.iter().any(|active| {
                                active.id == plugin.manifest.id
                                    && active.generation == plugin.generation
                                    && active.state == RendererPluginState::Active
                                    && active.activation_confirmed
                                    && active.context_id.is_some()
                            })
                    }));
        host_ready && renderer_ready
    }

    pub(crate) fn retire_package_renderers(
        &mut self,
        affected: &BTreeSet<String>,
        stage: &str,
    ) -> Vec<PluginTargetFailure> {
        self.drive_deadline = self.management_phase_deadline();
        let failures = self.retire_managed_plugins(affected, stage);
        self.drive_deadline = None;
        // Native declarations survive renderer cleanup because deactivate may
        // still call its host. All entry leases retire before native stop.
        self.remove_managed_providers(affected);
        for id in affected {
            let _ = self.capabilities.unregister_provider(&host_provider_id(id));
        }
        self.plugins
            .retain(|plugin| !affected.contains(&plugin.manifest.id));
        self.host_plugins
            .retain(|plugin| !affected.contains(&plugin.manifest.id));
        failures
    }

    pub(crate) fn activate_package_renderers(
        &mut self,
        plugins: &[LoadedPlugin],
        stage: &str,
    ) -> Vec<PluginTargetFailure> {
        if let Err(error) = self.register_rpc_plugins(plugins) {
            return vec![failure("core-rpc", stage, error.to_string())];
        }
        for plugin in plugins
            .iter()
            .filter(|plugin| plugin.manifest.host.is_some())
        {
            let grants = plugin
                .manifest
                .permissions
                .iter()
                .map(|permission| permission.as_str().to_owned())
                .collect::<Vec<_>>();
            if let Err(error) = self.capabilities.register_provider(
                &host_provider_id(&plugin.manifest.id),
                plugin.generation,
                &plugin.manifest.runtime_host_provides(),
                plugin.manifest.host_requires(),
                &grants,
            ) {
                return vec![failure(&plugin.manifest.id, stage, error.to_string())];
            }
            self.host_plugins.push(plugin.clone());
        }
        let renderers: Vec<_> = plugins
            .iter()
            .filter(|plugin| plugin.manifest.renderer.is_some())
            .cloned()
            .collect();
        self.plugins.extend(renderers.clone());
        self.drive_deadline = self.management_phase_deadline();
        let failures = self.activate_managed_plugins(&renderers, stage);
        self.drive_deadline = None;
        failures
    }

    pub(crate) fn commit_package_entries(&mut self, entries: Vec<PluginCatalogEntry>) {
        for entry in entries {
            self.catalog.replace_entry(entry);
        }
    }

    pub(crate) fn retire_all_package_renderers(&mut self) -> Vec<PluginTargetFailure> {
        let affected = self
            .logical_plugins()
            .iter()
            .map(|plugin| plugin.manifest.id.clone())
            .collect();
        self.retire_package_renderers(&affected, "shutdown")
    }

    pub(super) fn require_native_ready(
        &self,
        plugin_id: &str,
        generation: u64,
    ) -> Result<(), RendererError> {
        if self.external_observations.iter().any(|observation| {
            observation.plugin.manifest.id == plugin_id
                && observation.plugin.generation == generation
                && observation.state == ExecutionState::Active
        }) {
            Ok(())
        } else {
            Err(RendererError::PluginRejected {
                plugin_id: plugin_id.into(),
                message: "the native host entry has not reached Ready at the required generation"
                    .into(),
            })
        }
    }

    pub(super) fn require_native_dependencies_ready(
        &mut self,
        plugin: &LoadedPlugin,
        authorizations: &TargetAuthorizations,
    ) -> Result<(), RendererError> {
        let mut dependencies = BTreeSet::new();
        if plugin.manifest.has_runtime_host() {
            dependencies.insert((plugin.manifest.id.clone(), plugin.generation));
        }
        if let Some((principal, leases)) = authorizations.get(&plugin.manifest.id) {
            for lease in leases.values() {
                let owner =
                    self.capabilities
                        .invoke_endpoint(principal, lease, |provider, _| provider.to_owned())?;
                if let Some(id) = host_provider_plugin_id(&owner) {
                    dependencies.insert((
                        id.to_owned(),
                        self.capabilities
                            .provider_generation(&owner)
                            .expect("authorized provider exists"),
                    ));
                }
            }
        }
        for (id, generation) in dependencies {
            self.wait_native_ready(&id, generation)?;
        }
        Ok(())
    }
}

fn failure(plugin_id: &str, stage: &str, error: String) -> PluginTargetFailure {
    PluginTargetFailure {
        target_id: String::new(),
        plugin_id: plugin_id.into(),
        stage: stage.into(),
        error,
    }
}

#[cfg(test)]
mod native_launch_tests {
    use super::*;

    #[test]
    fn native_launch_only_combined_renderer_never_waits_for_a_host_ready_receipt() {
        let directory = tempfile::tempdir().unwrap();
        let registry = PluginRegistry::load(directory.path().join("plugins.json")).unwrap();
        let mut plugin = LoadedPlugin { authorization: None,
            manifest: crate::plugins::PluginManifest::parse(&serde_json::json!({"schema":1,"id":"dev.launch","version":"1","renderer":{"entry":"renderer.js","world":"isolated"},"host":{"entry":"host.js","provides":[{"name":"codlet.client.launch","api":1,"scope":"runtime"}]},"permissions":["host.process"]}).to_string()).unwrap(),
            source: Some("module.exports={activate(){},deactivate(){}};".into()),
            host: Some(crate::plugins::LoadedHost { root: directory.path().into(), entry: directory.path().join("host.js"), source: "module.exports={};".into(), authorization: None }), generation: 1 };
        let mut runtime = RendererRuntime::new(vec![plugin.clone()], registry).unwrap();
        assert!(runtime.external_observations.is_empty());
        assert!(
            runtime
                .require_native_dependencies_ready(&plugin, &TargetAuthorizations::default())
                .is_ok()
        );
        assert_eq!(
            runtime.logical_plugins().len(),
            1,
            "Native snapshot stays in the logical catalog"
        );
        assert!(
            !runtime.package_is_active(&plugin),
            "a real renderer target must still activate"
        );
        plugin.manifest.host.as_mut().unwrap().provides.push(
            serde_json::from_value(
                serde_json::json!({"name":"dev.other","api":1,"scope":"runtime"}),
            )
            .unwrap(),
        );
        assert!(plugin.manifest.has_runtime_host());
        assert!(
            runtime
                .require_native_ready(&plugin.manifest.id, plugin.generation)
                .is_err(),
            "ordinary mixed Host still requires its generation's Ready receipt"
        );
    }
}
