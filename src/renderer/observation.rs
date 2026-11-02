//! Bounded status and inspection sampled from the same foreground state.
use super::{
    ActivePlugin, BUILTIN_HOST_PROVIDER_ID, RendererPluginState, RendererReportedDiagnostic,
    RendererRuntime, RendererSession,
};
use crate::capabilities::CapabilityScopeInstance;
use crate::runtime_inspection::{
    InspectedTarget, MAX_INSPECTION_CAPABILITIES, MAX_INSPECTION_CAPABILITIES_PER_PROVIDER,
    MAX_INSPECTION_ID_BYTES, MAX_INSPECTION_PROVIDERS, ProviderKind, RegisteredProvider,
    RendererInspection,
};
use crate::runtime_status::{
    MAX_STATUS_DIAGNOSTICS_PER_PLUGIN, MAX_STATUS_PLUGINS_PER_TARGET, MAX_STATUS_TARGETS,
    PluginDiagnostic, PluginStatus, RendererStatus, TargetStatus,
};

impl RendererRuntime {
    pub(super) fn target_status(&self, target_id: &str) -> Option<TargetStatus> {
        let session = self.sessions.get(target_id)?;
        let live = session.session.is_live();
        Some(TargetStatus {
            target_id: target_id.to_owned(),
            session_id: session.session.session_id().to_owned(),
            session_live: live,
            plugins: session.plugin_statuses(live),
        })
    }

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
            let observed = session.plugin_statuses(session_live);
            truncated |= observed.len() > MAX_STATUS_PLUGINS_PER_TARGET;
            truncated |= target_id.len() > 1024 || session_id.len() > 1024;
            truncated |= observed.iter().any(|plugin| {
                plugin.id.len() > 1024
                    || plugin.version.len() > 1024
                    || plugin.diagnostics_truncated
            });
            let mut plugins = Vec::new();
            let mut inspected_plugins = Vec::new();
            for mut status in observed.into_iter().take(MAX_STATUS_PLUGINS_PER_TARGET) {
                if status.id.len() <= MAX_INSPECTION_ID_BYTES
                    && status.version.len() <= MAX_INSPECTION_ID_BYTES
                {
                    inspected_plugins.push(status.clone());
                } else {
                    truncated = true;
                }
                // The legacy display is bounded; the inspection above keeps
                // only complete identities that can safely be used as join keys.
                status.id = status_text(&status.id);
                status.version = status_text(&status.version);
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

impl RendererSession {
    fn plugin_statuses(&self, live: bool) -> Vec<PluginStatus> {
        let mut plugins: Vec<_> = self
            .plugins
            .iter()
            .map(|plugin| plugin.status(live, self.recovery_pending))
            .collect();
        plugins.extend(
            self.failed_plugins
                .values()
                .filter(|failed| !self.plugins.iter().any(|plugin| plugin.id == failed.id))
                .cloned(),
        );
        plugins.sort_by(|a, b| a.id.cmp(&b.id));
        plugins
    }
}

impl ActivePlugin {
    pub(super) fn status(&self, session_live: bool, recovery_pending: bool) -> PluginStatus {
        let diagnostics = self.diagnostics.borrow();
        let (diagnostics, diagnostics_truncated) = diagnostic_status(diagnostics.values());
        PluginStatus {
            id: self.id.clone(),
            version: self.version.clone(),
            generation: self.generation,
            lifecycle: self.state,
            context_present: self.context_id.is_some(),
            activation_confirmed: self.activation_confirmed,
            active: session_live
                && !recovery_pending
                && self.context_id.is_some()
                && self.activation_confirmed
                && self.state == RendererPluginState::Active,
            error: None,
            diagnostics,
            diagnostics_truncated,
        }
    }

    pub(super) fn apply_diagnostic(&self, diagnostic: &RendererReportedDiagnostic) {
        let mut diagnostics = self.diagnostics.borrow_mut();
        if diagnostic.resolved {
            diagnostics.remove(&diagnostic.code);
        } else if diagnostic.level == "error"
            || diagnostics
                .get(&diagnostic.code)
                .is_none_or(|prior| prior.level != "error")
        {
            // Informational activity is not a recovery receipt. Keep an error
            // until its owner explicitly resolves that exact code.
            diagnostics.insert(
                diagnostic.code.clone(),
                crate::runtime_status::PluginDiagnostic {
                    code: diagnostic.code.clone(),
                    message: diagnostic.message.clone(),
                    level: diagnostic.level.clone(),
                },
            );
        }
    }
}

fn diagnostic_status<'a>(
    values: impl Iterator<Item = &'a PluginDiagnostic>,
) -> (Vec<PluginDiagnostic>, bool) {
    let mut values: Vec<_> = values.collect();
    values.sort_by(|left, right| {
        (left.level != "error", &left.code).cmp(&(right.level != "error", &right.code))
    });
    let mut truncated = values.len() > MAX_STATUS_DIAGNOSTICS_PER_PLUGIN;
    let diagnostics = values
        .into_iter()
        .take(MAX_STATUS_DIAGNOSTICS_PER_PLUGIN)
        .map(|value| {
            truncated |= value.message.len() > 1024;
            PluginDiagnostic {
                code: value.code.clone(),
                message: status_text(&value.message),
                level: value.level.clone(),
            }
        })
        .collect();
    (diagnostics, truncated)
}

pub(super) fn status_text(text: &str) -> String {
    let mut end = text.len().min(1024);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_status::{
        HostSnapshot, HostState, MAX_STATUS_RESPONSE_BYTES, StatusCode, StatusReport,
    };

    #[test]
    fn diagnostic_exports_keep_errors_and_report_omissions_within_the_status_budget() {
        let mut source: Vec<_> = (0..31)
            .map(|index| PluginDiagnostic {
                code: format!("info_{index:02}"),
                message: "详".repeat(1365),
                level: "info".into(),
            })
            .collect();
        source.push(PluginDiagnostic {
            code: "zz_current_error".into(),
            message: "Native toolbar unavailable".into(),
            level: "error".into(),
        });
        let (diagnostics, incomplete) = diagnostic_status(source.iter());
        assert!(incomplete);
        assert_eq!(diagnostics.len(), MAX_STATUS_DIAGNOSTICS_PER_PLUGIN);
        assert_eq!(diagnostics[0].code, "zz_current_error");
        assert_eq!(diagnostics[0].message, "Native toolbar unavailable");
        assert!(diagnostics.iter().all(|item| item.message.len() <= 1024));
        let plugin = PluginStatus {
            id: "test.example".into(),
            version: "1".into(),
            generation: 1,
            lifecycle: RendererPluginState::Active,
            context_present: true,
            activation_confirmed: true,
            active: true,
            error: None,
            diagnostics,
            diagnostics_truncated: incomplete,
        };
        let target = TargetStatus {
            target_id: "target".into(),
            session_id: "session".into(),
            session_live: true,
            plugins: vec![plugin; 3],
        };
        let report = StatusReport {
            schema_version: crate::runtime_status::STATUS_SCHEMA_VERSION,
            status: StatusCode::Running,
            error: None,
            snapshot: Some(HostSnapshot {
                host_pid: 1,
                codlet_version: "test".into(),
                state: HostState::Ready,
                sequence: 1,
                sampled_at_unix_ms: 1,
                codex: None,
                termination: None,
                renderer: RendererStatus {
                    targets: vec![target; 2],
                    recent_events: Vec::new(),
                    truncated: true,
                    isolated_worlds: None,
                },
            }),
        };
        let encoded = serde_json::to_vec(&report).unwrap();
        assert!(
            encoded.len() < MAX_STATUS_RESPONSE_BYTES / 2,
            "three plugins in two documents must leave response headroom"
        );
        let restored: StatusReport = serde_json::from_slice(&encoded).unwrap();
        assert!(restored.snapshot.unwrap().renderer.targets[0].plugins[0].diagnostics_truncated);
        let (message_only, incomplete) = diagnostic_status(source[..1].iter());
        assert!(
            incomplete,
            "truncated text is explicit even when no records were omitted"
        );
        assert_eq!(message_only.len(), 1);
    }
}
