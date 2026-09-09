//! Pure evaluation of authenticated runtime observations for doctor.
//! Collection and transport authentication stay outside the diagnostic model.

use std::fmt::Write;

use serde::Serialize;
use serde_json::json;

use super::{Check, DiagnosticIssue, DoctorReport, RuntimeObservations, render_check};
use crate::capabilities::CapabilityDescriptor;
use crate::plugin_execution::HostRuntimeSnapshot;
use crate::runtime_inspection::{
    InspectedTarget, ProviderKind, RegisteredProvider, RuntimeInspection,
};
use crate::runtime_status::{CodexStatus, HostState};

const FRESHNESS_LIMIT_MS: u64 = 5_000;
const MAX_FAILURE_EXAMPLES: usize = 16;
const NO_SAMPLE: &str = "No authenticated runtime sample is available for this registry.";
const COMPATIBILITY_UNPROBED: &str = "GUI compatibility remains unprobed; it requires the real Codex acceptance gate. Activation observations do not probe provider endpoints.";

#[derive(Debug)]
pub enum DoctorRuntimeInput {
    NotProbed,
    NotRunning,
    OtherRegistry {
        host_pid: u32,
        registry_scope: String,
    },
    Unsupported {
        host_pid: Option<u32>,
        message: String,
    },
    Unavailable {
        code: &'static str,
        message: String,
    },
    Inspected {
        inspection: Box<RuntimeInspection>,
        queried_at_unix_ms: u64,
    },
    ExecutionInspected {
        inspection: Box<RuntimeInspection>,
        hosts: Box<HostRuntimeSnapshot>,
        queried_at_unix_ms: u64,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSample {
    pub host_pid: u32,
    pub host_incarnation: String,
    pub registry_scope: String,
    pub codlet_version: String,
    pub host_state: HostState,
    pub sequence: u64,
    pub sampled_at_unix_ms: u64,
    pub queried_at_unix_ms: u64,
    pub age_ms: Option<u64>,
    pub freshness: &'static str,
    pub freshness_limit_ms: u64,
    pub complete: bool,
    pub lifecycle_busy: Option<bool>,
    pub codex: Option<CodexStatus>,
    pub termination: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeGenerations {
    pub basis: &'static str,
    pub complete: bool,
    /// Target records retain the native Inspect field names and activation facts.
    pub targets: Vec<InspectedTarget>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProviders {
    pub basis: &'static str,
    pub assessment: &'static str,
    pub complete: bool,
    pub providers: Vec<RuntimeProvider>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProvider {
    pub id: String,
    pub generation: u64,
    pub kind: ProviderKind,
    pub provides: Vec<CapabilityDescriptor>,
    pub capabilities_truncated: bool,
    pub targets: Vec<ProviderTargetReadiness>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTargetReadiness {
    pub target_id: String,
    pub observed_generation: Option<u64>,
    pub readiness: &'static str,
}

impl DoctorReport {
    /// A pure assessment of an already authenticated observation. This does not
    /// perform I/O, combine disk declarations with registrations, or execute plugins.
    pub fn with_runtime(mut self, input: DoctorRuntimeInput) -> Self {
        let probed = !matches!(input, DoctorRuntimeInput::NotProbed);
        self.runtime = RuntimeObservations::from_runtime(input);
        self.result
            .failed_checks
            .retain(|check| *check != "runtime");
        if !self.runtime.issues.is_empty() {
            self.result.failed_checks.push("runtime");
        }
        let failed = !self.result.failed_checks.is_empty();
        self.result.status = if failed { "failed" } else { "passed" };
        self.result.exit_code = u8::from(failed);
        if probed {
            self.result.scope = "Static configuration and read-only OS checks, plus authenticated Host observations when available. Runtime inventory is independent of disk declarations. No endpoint health or GUI compatibility verdict; launch must repeat preflight checks.";
        }
        self
    }
}

impl RuntimeObservations {
    pub(super) fn not_probed() -> Self {
        Self::unavailable(
            "not_probed",
            "Runtime collection was not requested for this report.",
        )
    }

    fn unavailable(status: &'static str, reason: impl Into<String>) -> Self {
        Self {
            status,
            reason: reason.into(),
            targets: Check::Unavailable { reason: NO_SAMPLE },
            plugin_generations: Check::Unavailable { reason: NO_SAMPLE },
            provider_ready: Check::Unavailable { reason: NO_SAMPLE },
            compatibility: Check::Unavailable {
                reason: COMPATIBILITY_UNPROBED,
            },
            host_processes: None,
            sample: None,
            issues: Vec::new(),
            recent_events: Vec::new(),
        }
    }

    fn from_runtime(input: DoctorRuntimeInput) -> Self {
        match input {
            DoctorRuntimeInput::NotProbed => Self::not_probed(),
            DoctorRuntimeInput::NotRunning => Self::unavailable(
                "not_running",
                "No Runtime Host was found. Static checks remain available; runtime readiness is unknown.",
            ),
            DoctorRuntimeInput::OtherRegistry {
                host_pid,
                registry_scope,
            } => Self::unavailable(
                "other_registry",
                format!(
                    "Host pid={host_pid} belongs to registry scope {registry_scope}; its runtime facts do not describe this registry. Use that registry's configuration path to inspect it."
                ),
            ),
            DoctorRuntimeInput::Unsupported { host_pid, message } => Self::unavailable(
                "unsupported",
                format!(
                    "Host {} does not support runtime Inspect: {message}. Use `codlet status` for its legacy snapshot; update the Host on your next launch for Inspect.",
                    host_pid
                        .map(|pid| format!("pid={pid}"))
                        .unwrap_or_else(|| "identity unavailable".to_owned())
                ),
            ),
            DoctorRuntimeInput::Unavailable { code, message } => {
                let mut runtime = Self::unavailable(
                    "unavailable",
                    "Runtime Inspect could not produce a trustworthy sample; static checks remain independent.",
                );
                runtime.issues.push(DiagnosticIssue::new(
                    code,
                    message,
                    transport_remediation(code),
                ));
                runtime
            }
            DoctorRuntimeInput::Inspected {
                inspection,
                queried_at_unix_ms,
            } => Self::inspected(*inspection, queried_at_unix_ms),
            DoctorRuntimeInput::ExecutionInspected {
                inspection,
                hosts,
                queried_at_unix_ms,
            } => Self::inspected(*inspection, queried_at_unix_ms)
                .with_hosts(*hosts, queried_at_unix_ms),
        }
    }

    fn inspected(inspection: RuntimeInspection, queried_at_unix_ms: u64) -> Self {
        let mut runtime = Self::unavailable(
            "inspected",
            "One authenticated Host publication supplies the observed targets, generations, and kernel registrations. Readiness describes sampled activation only.",
        );
        let age_ms = queried_at_unix_ms.checked_sub(inspection.sampled_at_unix_ms);
        let freshness = match age_ms {
            None => "clock_skew",
            Some(age) if age > FRESHNESS_LIMIT_MS => "stale",
            Some(_) => "fresh",
        };
        let complete = inspection.renderer.as_ref().is_some_and(|renderer| {
            !renderer.truncated
                && !renderer
                    .providers
                    .iter()
                    .any(|provider| provider.capabilities_truncated)
        });
        let sample = RuntimeSample {
            host_pid: inspection.host_pid,
            host_incarnation: inspection.host_incarnation,
            registry_scope: inspection.registry_scope,
            codlet_version: inspection.codlet_version,
            host_state: inspection.state,
            sequence: inspection.sequence,
            sampled_at_unix_ms: inspection.sampled_at_unix_ms,
            queried_at_unix_ms,
            age_ms,
            freshness,
            freshness_limit_ms: FRESHNESS_LIMIT_MS,
            complete,
            lifecycle_busy: inspection
                .renderer
                .as_ref()
                .map(|renderer| renderer.lifecycle_busy),
            codex: inspection.codex,
            termination: inspection.termination,
        };
        if let Some(renderer) = inspection.renderer {
            let blocked = match sample.host_state {
                HostState::Starting => Some("host_starting"),
                HostState::Terminated => Some("host_terminated"),
                HostState::Ready if freshness != "fresh" => Some(freshness),
                HostState::Ready if renderer.lifecycle_busy => Some("lifecycle_busy"),
                HostState::Ready if !complete => Some("incomplete_sample"),
                HostState::Ready => None,
            };
            let mut failure_count = 0;
            let mut examples = Vec::new();
            // Consumers may expose no capabilities. Their observed activation
            // still matters, but no expected generation is invented from disk.
            if blocked.is_none() {
                for target in &renderer.targets {
                    if target_block(target).is_some() {
                        continue;
                    }
                    for plugin in &target.plugins {
                        if !plugin.active
                            && !renderer
                                .providers
                                .iter()
                                .any(|provider| provider.id == plugin.id)
                        {
                            failure_count += 1;
                            if examples.len() < MAX_FAILURE_EXAMPLES {
                                examples.push(json!({
                                    "targetId": target.target_id,
                                    "pluginId": plugin.id,
                                    "code": "plugin_inactive",
                                    "registeredGeneration": null,
                                    "observedGeneration": plugin.generation,
                                }));
                            }
                        }
                    }
                }
            }
            let mut provider_failure_count = 0;
            let providers: Vec<_> = renderer
                .providers
                .into_iter()
                .map(|provider| {
                    let targets = renderer
                        .targets
                        .iter()
                        .map(|target| {
                            let plugin = target
                                .plugins
                                .iter()
                                .find(|plugin| plugin.id == provider.id);
                            let readiness = readiness(&provider, target, blocked);
                            if matches!(
                                readiness,
                                "generation_mismatch" | "plugin_inactive" | "plugin_not_observed"
                            ) {
                                failure_count += 1;
                                provider_failure_count += 1;
                                if examples.len() < MAX_FAILURE_EXAMPLES {
                                    examples.push(json!({
                                "targetId": target.target_id,
                                "providerId": provider.id,
                                "code": readiness,
                                "registeredGeneration": provider.generation,
                                "observedGeneration": plugin.map(|plugin| plugin.generation),
                            }));
                                }
                            }
                            ProviderTargetReadiness {
                                target_id: target.target_id.clone(),
                                observed_generation: plugin.map(|plugin| plugin.generation),
                                readiness,
                            }
                        })
                        .collect();
                    RuntimeProvider {
                        id: provider.id,
                        generation: provider.generation,
                        kind: provider.kind,
                        provides: provider.provides,
                        capabilities_truncated: provider.capabilities_truncated,
                        targets,
                    }
                })
                .collect();
            let assessment = blocked.unwrap_or_else(|| {
                if renderer.targets.is_empty() {
                    "no_targets"
                } else if providers.is_empty() {
                    "no_providers"
                } else if provider_failure_count > 0 {
                    "activation_unready"
                } else if renderer
                    .targets
                    .iter()
                    .any(|target| target_block(target).is_some())
                {
                    "partial_target_readiness"
                } else {
                    "activation_ready"
                }
            });
            if failure_count > 0 {
                let mut issue = DiagnosticIssue::new(
                    "runtime_activation_unready",
                    format!(
                        "{failure_count} target/plugin activation observation(s) are missing, inactive, or at a different registered generation in a fresh, complete, quiet Host sample."
                    ),
                    "Use the listed target/plugin or provider IDs and Host logs to investigate activation or generation failures. Retry doctor after recovery; reload an affected plugin only after identifying the cause.",
                );
                issue.details = json!({"count": failure_count, "examples": examples, "examplesTruncated": failure_count > MAX_FAILURE_EXAMPLES});
                runtime.issues.push(issue);
            }
            runtime.targets = Check::ok(
                renderer
                    .targets
                    .iter()
                    .map(|target| target.target_id.clone())
                    .collect(),
            );
            runtime.plugin_generations = Check::ok(RuntimeGenerations {
                basis: "authenticated_owner_observation",
                complete,
                targets: renderer.targets,
            });
            runtime.provider_ready = Check::ok(RuntimeProviders {
                basis: "actual_kernel_registrations_and_same_sample_target_activation",
                assessment,
                complete,
                providers,
            });
            runtime.recent_events = renderer.recent_events;
        } else {
            runtime.reason = "The authenticated Host has no current renderer publication. Runtime target, generation, and provider facts remain unavailable until the owner publishes them.".to_owned();
        }
        runtime.sample = Some(sample);
        runtime
    }

    pub(super) fn render(&self, output: &mut String) {
        let _ = writeln!(
            output,
            "runtime: {}\n  reason: {}",
            self.status, self.reason
        );
        if let Some(sample) = &self.sample {
            let _ = writeln!(
                output,
                "  host: pid={}; incarnation={}; registry-scope={}; state={:?}; sequence={}\n  sample: unix-ms={}; queried-at-unix-ms={}; age-ms={}; freshness={}; freshness-limit-ms={}; complete={}; lifecycle-busy={:?}",
                sample.host_pid,
                sample.host_incarnation,
                sample.registry_scope,
                sample.host_state,
                sample.sequence,
                sample.sampled_at_unix_ms,
                sample.queried_at_unix_ms,
                sample
                    .age_ms
                    .map(|age| age.to_string())
                    .unwrap_or_else(|| "unavailable".to_owned()),
                sample.freshness,
                sample.freshness_limit_ms,
                sample.complete,
                sample.lifecycle_busy,
            );
            if let Some(termination) = &sample.termination {
                let _ = writeln!(output, "  termination: {termination}");
            }
        }
        self.render_hosts(output);
        render_check(output, "targets", &self.targets, |output, targets| {
            let _ = writeln!(output, "targets: {} observed", targets.len());
        });
        render_check(
            output,
            "plugin-generations",
            &self.plugin_generations,
            |output, data| {
                let _ = writeln!(
                    output,
                    "plugin-generations: observed; complete={}",
                    data.complete
                );
                for target in &data.targets {
                    let _ = writeln!(
                        output,
                        "  target: {}; session={}; live={}; document-epoch={}; recovery-pending={}; scope-active={}",
                        target.target_id,
                        target.session_id,
                        target.session_live,
                        target.document_epoch,
                        target.recovery_pending,
                        target.scope_active
                    );
                    for plugin in &target.plugins {
                        let _ = writeln!(
                            output,
                            "    plugin: {}; generation={}; lifecycle={:?}; context-present={}; activation-confirmed={}; active={}",
                            plugin.id,
                            plugin.generation,
                            plugin.lifecycle,
                            plugin.context_present,
                            plugin.activation_confirmed,
                            plugin.active
                        );
                    }
                }
            },
        );
        render_check(
            output,
            "provider-ready",
            &self.provider_ready,
            |output, data| {
                let _ = writeln!(
                    output,
                    "provider-ready: {}; complete={}; basis={}",
                    data.assessment, data.complete, data.basis
                );
                for provider in &data.providers {
                    let _ = writeln!(
                        output,
                        "  registered-provider: {}; generation={}; kind={:?}; capabilities-truncated={}",
                        provider.id,
                        provider.generation,
                        provider.kind,
                        provider.capabilities_truncated
                    );
                    for capability in &provider.provides {
                        let _ = writeln!(output, "    capability: {capability}");
                    }
                    for target in &provider.targets {
                        let _ = writeln!(
                            output,
                            "    target: {}; readiness={}; observed-generation={:?}",
                            target.target_id, target.readiness, target.observed_generation
                        );
                    }
                }
            },
        );
        for event in &self.recent_events {
            let _ = writeln!(
                output,
                "  recent-event (history only): target={}; code={}; message={}",
                event.target_id, event.code, event.message
            );
        }
        for issue in &self.issues {
            let _ = writeln!(
                output,
                "runtime: failed [{}] {}\n  action: {}\n  details: {}",
                issue.code, issue.message, issue.remediation, issue.details
            );
        }
        let _ = writeln!(
            output,
            "compatibility: not_probed\n  reason: {COMPATIBILITY_UNPROBED}"
        );
    }
}

fn transport_remediation(code: &str) -> &'static str {
    match code {
        "runtime_registry_unavailable" => {
            "Restore the user profile's LOCALAPPDATA setting or resolve the intended registry path, then retry `codlet doctor`."
        }
        "runtime_inspection_too_large" => {
            "Reduce the number of open targets or loaded provider declarations before retrying; use `codlet status` and Host logs to inspect the current session if the full inventory exceeds the response limit."
        }
        "runtime_busy" | "runtime_timeout" | "runtime_not_ready" | "runtime_stopping" => {
            "Retry after the Host finishes its current startup, recovery, or management operation. If it stays unavailable, inspect `codlet status` and Host logs."
        }
        "runtime_identity_mismatch" | "runtime_untrusted_host" => {
            "Use the Codlet executable and registry associated with the running Host, then retry. Inspect Host logs if the authenticated identity still differs."
        }
        _ => {
            "Confirm the registry path and Host version, then retry `codlet doctor`. Use `codlet status` and Host logs to investigate the transport error; doctor does not restart the Host."
        }
    }
}

fn target_block(target: &InspectedTarget) -> Option<&'static str> {
    if !target.session_live {
        Some("session_not_live")
    } else if target.recovery_pending {
        Some("recovery_pending")
    } else if !target.scope_active {
        Some("scope_inactive")
    } else {
        None
    }
}

fn readiness(
    provider: &RegisteredProvider,
    target: &InspectedTarget,
    blocked: Option<&'static str>,
) -> &'static str {
    if let Some(reason) = blocked.or_else(|| target_block(target)) {
        return reason;
    }
    if provider.kind == ProviderKind::Host {
        return "activation_ready";
    }
    match target
        .plugins
        .iter()
        .find(|plugin| plugin.id == provider.id)
    {
        None => "plugin_not_observed",
        Some(plugin) if plugin.generation != provider.generation => "generation_mismatch",
        Some(plugin) if !plugin.active => "plugin_inactive",
        Some(_) => "activation_ready",
    }
}
