//! Bounded status and inspection sampled from the same foreground state.
use super::{BUILTIN_HOST_PROVIDER_ID, RendererPluginState, RendererRuntime};
use crate::capabilities::CapabilityScopeInstance;
use crate::runtime_inspection::{
    InspectedTarget, MAX_INSPECTION_CAPABILITIES, MAX_INSPECTION_CAPABILITIES_PER_PROVIDER,
    MAX_INSPECTION_ID_BYTES, MAX_INSPECTION_PROVIDERS, ProviderKind, RegisteredProvider,
    RendererInspection,
};
use crate::runtime_status::{
    MAX_STATUS_PLUGINS_PER_TARGET, MAX_STATUS_TARGETS, PluginStatus, RendererStatus, TargetStatus,
};

impl RendererRuntime {
    pub fn status_snapshot(&self) -> RendererStatus {
        self.sample_runtime_observation().0
    }

    pub(super) fn sample_runtime_observation(&self) -> (RendererStatus, RendererInspection) {
        let mut target_ids: Vec<_> = self.sessions.keys().collect();
        target_ids.sort();
        let mut truncated = target_ids.len() > MAX_STATUS_TARGETS;
        let mut targets = Vec::new();
        let mut inspected_targets = Vec::new();
        for target_id in target_ids.into_iter().take(MAX_STATUS_TARGETS) {
            let session = &self.sessions[target_id];
            // This flag is changed by the CDP worker. Both views must use the
            // same read rather than taking two independent runtime snapshots.
            let session_live = session.session.is_live();
            let session_id = session.session.session_id();
            truncated |= session.plugins.len() > MAX_STATUS_PLUGINS_PER_TARGET;
            truncated |= target_id.len() > 1024 || session_id.len() > 1024;
            truncated |= session
                .plugins
                .iter()
                .any(|plugin| plugin.id.len() > 1024 || plugin.version.len() > 1024);
            let mut plugins = Vec::new();
            let mut inspected_plugins = Vec::new();
            for plugin in session.plugins.iter().take(MAX_STATUS_PLUGINS_PER_TARGET) {
                let status = PluginStatus {
                    id: status_text(&plugin.id),
                    version: status_text(&plugin.version),
                    generation: plugin.generation,
                    lifecycle: plugin.state,
                    context_present: plugin.context_id.is_some(),
                    activation_confirmed: plugin.activation_confirmed,
                    active: session_live
                        && !session.recovery_pending
                        && plugin.context_id.is_some()
                        && plugin.activation_confirmed
                        && plugin.state == RendererPluginState::Active,
                };
                if plugin.id.len() <= MAX_INSPECTION_ID_BYTES
                    && plugin.version.len() <= MAX_INSPECTION_ID_BYTES
                {
                    inspected_plugins.push(status.clone());
                }
                plugins.push(status);
            }
            targets.push(TargetStatus {
                target_id: status_text(target_id),
                session_id: status_text(session_id),
                session_live,
                plugins,
            });
            // Inspection never turns a truncated identity into a join key.
            if target_id.len() <= MAX_INSPECTION_ID_BYTES
                && session_id.len() <= MAX_INSPECTION_ID_BYTES
            {
                inspected_targets.push(InspectedTarget {
                    target_id: target_id.clone(),
                    session_id: session_id.to_owned(),
                    session_live,
                    document_epoch: session.document_epoch,
                    recovery_pending: session.recovery_pending,
                    scope_active: self
                        .capabilities
                        .scope_is_active(&CapabilityScopeInstance::Target(target_id.clone())),
                    plugins: inspected_plugins,
                });
            }
        }
        let (providers, providers_truncated) = self.sample_registered_providers();
        (
            RendererStatus {
                targets,
                recent_events: self.status_events.clone(),
                truncated,
                isolated_worlds: Some(crate::runtime_status::RendererWorldBudget {
                    attempted: self.world_attempts,
                    limit: self.world_limit,
                    reserved: self.world_reservations.values().sum(),
                }),
            },
            RendererInspection {
                providers,
                targets: inspected_targets,
                recent_events: self.status_events.clone(),
                truncated: truncated || providers_truncated,
                lifecycle_busy: self.management_active
                    || self.has_pending_host_capabilities()
                    || self.owner_lifecycle_depth != 0
                    || self.drive_depth != 0
                    || self.drive_deadline.is_some()
                    || self
                        .sessions
                        .values()
                        .any(|session| session.recovery_pending),
            },
        )
    }

    fn sample_registered_providers(&self) -> (Vec<RegisteredProvider>, bool) {
        let mut providers = Vec::new();
        let mut remaining_capabilities = MAX_INSPECTION_CAPABILITIES;
        let mut truncated = false;
        for (index, (id, generation, provides)) in self
            .capabilities
            .registered_providers()
            .filter(|(_, _, provides)| !provides.is_empty())
            .enumerate()
        {
            if index == MAX_INSPECTION_PROVIDERS {
                truncated = true;
                break;
            }
            let mut descriptors: Vec<_> = provides.iter().collect();
            descriptors.sort();
            let keep = descriptors
                .len()
                .min(MAX_INSPECTION_CAPABILITIES_PER_PROVIDER)
                .min(remaining_capabilities);
            let capabilities_truncated = keep < descriptors.len();
            remaining_capabilities -= keep;
            truncated |= capabilities_truncated;
            providers.push(RegisteredProvider {
                id: id.to_owned(),
                generation,
                kind: if id == BUILTIN_HOST_PROVIDER_ID
                    || crate::capabilities::host_provider_plugin_id(id).is_some()
                {
                    ProviderKind::Host
                } else {
                    ProviderKind::Renderer
                },
                provides: descriptors.into_iter().take(keep).cloned().collect(),
                capabilities_truncated,
            });
        }
        (providers, truncated)
    }
}

pub(super) fn status_text(text: &str) -> String {
    let mut end = text.len().min(1024);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}
