//! Read-only doctor report contract. A valid desired configuration is not runtime evidence.

use std::fmt::Write;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::{Value, json};

use crate::capabilities::{CapabilityDescriptor, CapabilityRegistry, CapabilityRegistryError};
use crate::plugins::{LoadedPlugin, ManifestError, PluginRegistry, PluginRegistryError};
use crate::renderer::{BUILTIN_HOST_PROVIDER_ID, builtin_host_capabilities};

pub const DOCTOR_SCHEMA: &str = "codlet.doctor/v1";
const RUNTIME_UNAVAILABLE: &str =
    "Read-only doctor does not launch or attach to Codex; Runtime Host control IPC is unavailable.";

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Check<T> {
    Ok { data: T },
    Failed { error: DiagnosticIssue },
    Unavailable { reason: &'static str },
}

impl<T> Check<T> {
    pub fn ok(data: T) -> Self {
        Self::Ok { data }
    }

    fn is_failed(&self) -> bool {
        matches!(self, Self::Failed { .. })
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticIssue {
    pub code: &'static str,
    pub message: String,
    pub remediation: String,
    pub details: Value,
}

impl DiagnosticIssue {
    pub fn new(
        code: &'static str,
        message: impl Into<String>,
        remediation: impl Into<String>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            remediation: remediation.into(),
            details: json!({}),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInfo {
    pub family_name: String,
    pub full_name: String,
    pub version: String,
    pub install_location: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub process_id: u32,
    pub executable: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSnapshot {
    pub matching_processes: Vec<ProcessInfo>,
    pub match_basis: &'static str,
    pub launch_conflict: bool,
    pub remediation: Option<&'static str>,
}

impl ProcessSnapshot {
    pub fn new(mut matching_processes: Vec<ProcessInfo>) -> Self {
        matching_processes.sort_by_key(|process| process.process_id);
        let launch_conflict = !matching_processes.is_empty();
        Self {
            matching_processes,
            match_basis: "exact_executable_name_and_package_family",
            launch_conflict,
            remediation: launch_conflict.then_some(
                "Existing Codex is compatible with read-only doctor. Before a future codlet launch, close Codex yourself and retry; doctor does not attach, close, or restart it.",
            ),
        }
    }
}

/// Collection is separate from evaluation so unavailable OS data and registry errors
/// can be exercised without discovering, launching, or attaching to a real process.
pub struct DoctorInputs {
    pub package: Check<PackageInfo>,
    pub executable: Check<String>,
    pub processes: Check<ProcessSnapshot>,
    pub registry_path: Option<PathBuf>,
    pub registry: Result<PluginRegistry, PluginRegistryError>,
    pub plugins: Result<Vec<LoadedPlugin>, ManifestError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryInfo {
    pub path: String,
    pub enablement_source: &'static str,
    pub applies_to: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub version: String,
    pub source: &'static str,
    pub default_enabled: bool,
    pub desired_enabled: Option<bool>,
    pub provides: Vec<CapabilityDescriptor>,
    pub requires: Vec<CapabilityDescriptor>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProviderDeclaration {
    pub id: &'static str,
    pub provides: Vec<CapabilityDescriptor>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyGraph {
    pub basis: &'static str,
    pub activation_order: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeObservations {
    pub status: &'static str,
    pub reason: &'static str,
    pub targets: Check<Vec<String>>,
    pub plugin_generations: Check<Value>,
    pub provider_ready: Check<Value>,
    pub compatibility: Check<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorResult {
    pub status: &'static str,
    pub exit_code: u8,
    pub failed_checks: Vec<&'static str>,
    pub launch_preflight: &'static str,
    pub scope: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub schema: &'static str,
    pub mode: &'static str,
    pub package: Check<PackageInfo>,
    pub executable: Check<String>,
    pub processes: Check<ProcessSnapshot>,
    pub registry_path: Option<String>,
    pub registry: Check<RegistryInfo>,
    pub plugins: Check<Vec<PluginInfo>>,
    pub declared_host_providers: Vec<HostProviderDeclaration>,
    pub dependency_graph: Check<DependencyGraph>,
    pub runtime: RuntimeObservations,
    pub result: DoctorResult,
}

impl DoctorReport {
    /// No I/O is performed here. Exit 1 means at least one static/snapshot check
    /// failed; running Codex and unprobed runtime observations alone do not fail doctor.
    pub fn from_inputs(inputs: DoctorInputs) -> Self {
        let registry_path = inputs
            .registry_path
            .map(|path| path.to_string_lossy().into_owned());
        let registry = match &inputs.registry {
            Ok(registry) => Check::ok(RegistryInfo {
                path: registry.path().to_string_lossy().into_owned(),
                enablement_source: "registry_preferences_with_bundled_defaults",
                applies_to: "next_codlet_launch",
            }),
            Err(error) => Check::Failed {
                error: registry_issue(error),
            },
        };
        let declared_host_providers = declared_host_providers();
        let plugins = match &inputs.plugins {
            Ok(plugins) => {
                let mut plugins: Vec<_> = plugins
                    .iter()
                    .map(|plugin| PluginInfo {
                        id: plugin.manifest.id.clone(),
                        version: plugin.manifest.version.clone(),
                        source: "bundled",
                        default_enabled: true,
                        desired_enabled: inputs
                            .registry
                            .as_ref()
                            .ok()
                            .map(|registry| registry.is_enabled(&plugin.manifest.id)),
                        provides: plugin.manifest.provides.clone(),
                        requires: plugin.manifest.requires.clone(),
                    })
                    .collect();
                plugins.sort_by(|left, right| left.id.cmp(&right.id));
                Check::ok(plugins)
            }
            Err(error) => Check::Failed {
                error: DiagnosticIssue::new(
                    "bundled_manifest_invalid",
                    error.to_string(),
                    "Restore or update the Codlet installation so its bundled manifests are valid.",
                ),
            },
        };
        let dependency_graph = match (&inputs.plugins, &inputs.registry) {
            (Ok(plugins), Ok(registry)) => {
                match validate_dependencies(plugins, registry, &declared_host_providers) {
                    Ok(graph) => Check::ok(graph),
                    Err(error) => Check::Failed {
                        error: dependency_issue(error, plugins, registry),
                    },
                }
            }
            _ => Check::Unavailable {
                reason: "Valid bundled manifests and desired enablement are required to evaluate the dependency graph.",
            },
        };
        let mut failed_checks = Vec::new();
        for (name, failed) in [
            ("package", inputs.package.is_failed()),
            ("executable", inputs.executable.is_failed()),
            ("processes", inputs.processes.is_failed()),
            ("registry", registry.is_failed()),
            ("plugins", plugins.is_failed()),
            ("dependencyGraph", dependency_graph.is_failed()),
        ] {
            if failed {
                failed_checks.push(name);
            }
        }
        let failed = !failed_checks.is_empty();
        let launch_preflight = match &inputs.processes {
            Check::Ok { data } if data.launch_conflict => "blocked",
            _ if failed => "blocked",
            Check::Ok { .. } => "not_blocked_by_snapshot",
            _ => "unavailable",
        };
        Self {
            schema: DOCTOR_SCHEMA,
            mode: "read_only",
            package: inputs.package,
            executable: inputs.executable,
            processes: inputs.processes,
            registry_path,
            registry,
            plugins,
            declared_host_providers,
            dependency_graph,
            runtime: RuntimeObservations {
                status: "not_probed",
                reason: RUNTIME_UNAVAILABLE,
                targets: Check::Unavailable {
                    reason: RUNTIME_UNAVAILABLE,
                },
                plugin_generations: Check::Unavailable {
                    reason: RUNTIME_UNAVAILABLE,
                },
                provider_ready: Check::Unavailable {
                    reason: RUNTIME_UNAVAILABLE,
                },
                compatibility: Check::Unavailable {
                    reason: RUNTIME_UNAVAILABLE,
                },
            },
            result: DoctorResult {
                status: if failed { "failed" } else { "passed" },
                exit_code: u8::from(failed),
                failed_checks,
                launch_preflight,
                scope: "Static configuration and read-only OS snapshots only; no runtime readiness or Codex compatibility verdict. Launch must repeat preflight checks.",
            },
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self)
            .expect("doctor report contains only JSON-serializable data")
    }

    pub fn to_human_readable(&self) -> String {
        let mut output = format!("Codlet doctor ({}, read-only)\n", self.schema);
        render_check(&mut output, "package", &self.package, |output, package| {
            let _ = writeln!(
                output,
                "package: {}\nversion: {}\ninstall-location: {}",
                package.full_name, package.version, package.install_location
            );
        });
        render_check(
            &mut output,
            "executable",
            &self.executable,
            |output, executable| {
                let _ = writeln!(output, "executable: {executable}");
            },
        );
        render_check(
            &mut output,
            "processes",
            &self.processes,
            |output, snapshot| {
                let _ = writeln!(
                    output,
                    "process-snapshot: ok; match-basis={}",
                    snapshot.match_basis
                );
                let _ = writeln!(
                    output,
                    "launch-instance-conflict: {}",
                    if snapshot.launch_conflict {
                        "present (doctor remains read-only)"
                    } else {
                        "none in this snapshot"
                    }
                );
                for process in &snapshot.matching_processes {
                    let _ = writeln!(
                        output,
                        "  process: pid={}; executable={}",
                        process.process_id, process.executable
                    );
                }
                if let Some(remediation) = snapshot.remediation {
                    let _ = writeln!(output, "  action: {remediation}");
                }
            },
        );
        if let Some(path) = &self.registry_path {
            let _ = writeln!(output, "plugin-registry: {path}");
        }
        render_check(&mut output, "registry", &self.registry, |output, _| {
            output.push_str("registry: ok; desired enablement uses registry preferences and bundled defaults; applies to next codlet launch\n");
        });
        render_check(&mut output, "plugins", &self.plugins, |output, plugins| {
            for plugin in plugins {
                let desired = match plugin.desired_enabled {
                    Some(true) => "true",
                    Some(false) => "false",
                    None => "unavailable",
                };
                let _ = writeln!(
                    output,
                    "plugin: id={}; version={}; source={}; desired-enabled={desired}",
                    plugin.id, plugin.version, plugin.source
                );
                for descriptor in &plugin.provides {
                    let _ = writeln!(output, "  declares-provider: {descriptor}");
                }
                for descriptor in &plugin.requires {
                    let _ = writeln!(output, "  declares-requirement: {descriptor}");
                }
            }
        });
        for provider in &self.declared_host_providers {
            for descriptor in &provider.provides {
                let _ = writeln!(
                    output,
                    "host-declares-provider: id={}; capability={descriptor}",
                    provider.id
                );
            }
        }
        render_check(
            &mut output,
            "dependency-graph",
            &self.dependency_graph,
            |output, graph| {
                let _ = writeln!(
                    output,
                    "dependency-graph: valid (static desired configuration only)\n  planned-activation-order: {}",
                    graph.activation_order.join(" -> ")
                );
            },
        );
        let _ = writeln!(
            output,
            "runtime: not_probed\ntargets: unavailable\nplugin-generations: unavailable\nprovider-ready: unavailable\ncompatibility: not_probed\n  reason: {}",
            self.runtime.reason
        );
        let _ = writeln!(
            output,
            "result: {}; exit-code={}; failed-checks={:?}; launch-preflight={}\n  scope: {}",
            self.result.status,
            self.result.exit_code,
            self.result.failed_checks,
            self.result.launch_preflight,
            self.result.scope
        );
        output
    }
}

fn render_check<T>(
    output: &mut String,
    name: &str,
    check: &Check<T>,
    render: impl FnOnce(&mut String, &T),
) {
    match check {
        Check::Ok { data } => render(output, data),
        Check::Failed { error } => {
            let _ = writeln!(
                output,
                "{name}: failed [{}]; {}\n  action: {}",
                error.code, error.message, error.remediation
            );
        }
        Check::Unavailable { reason } => {
            let _ = writeln!(output, "{name}: unavailable; {reason}");
        }
    }
}

fn registry_issue(error: &PluginRegistryError) -> DiagnosticIssue {
    let (code, remediation) = match error {
        PluginRegistryError::LocalAppDataUnavailable => (
            "registry_path_unavailable",
            "Set LOCALAPPDATA to your Windows local application data directory and rerun doctor.",
        ),
        PluginRegistryError::Json { .. } => (
            "registry_json_invalid",
            "Back up the reported Codlet registry, then repair its JSON and allowed fields; schema must be 1 and plugins.<id>.enabled must be a boolean. Rerun doctor.",
        ),
        PluginRegistryError::Schema(_) => (
            "registry_schema_unsupported",
            "Use a Codlet version that supports this registry schema, or restore a known-good schema 1 backup after backing up the current file.",
        ),
        PluginRegistryError::PluginId(_) => (
            "registry_plugin_id_invalid",
            "Back up the Codlet registry and repair invalid plugin IDs using lowercase letters, digits, hyphens and dot-separated segments; rerun doctor.",
        ),
        PluginRegistryError::Io { .. } => (
            "registry_read_failed",
            "Check the reported Codlet registry path is a readable file and its parent is a directory; repair access or restore a known-good backup, then rerun doctor.",
        ),
        PluginRegistryError::MissingParent(_) => (
            "registry_path_invalid",
            "Set LOCALAPPDATA to a valid local application data directory and rerun doctor.",
        ),
        PluginRegistryError::Busy { .. } => (
            "registry_busy",
            "Let the current Codlet registry transaction finish, then retry the requested operation.",
        ),
        PluginRegistryError::TemporaryCleanup { .. } => (
            "registry_temporary_cleanup_failed",
            "Inspect the reported temporary registry and its access permissions before retrying the requested operation.",
        ),
    };
    DiagnosticIssue::new(code, error.to_string(), remediation)
}

fn declared_host_providers() -> Vec<HostProviderDeclaration> {
    // These describe RendererRuntime's built-in endpoints, not running providers.
    vec![HostProviderDeclaration {
        id: BUILTIN_HOST_PROVIDER_ID,
        provides: builtin_host_capabilities().to_vec(),
    }]
}

fn validate_dependencies(
    plugins: &[LoadedPlugin],
    registry: &PluginRegistry,
    host: &[HostProviderDeclaration],
) -> Result<DependencyGraph, CapabilityRegistryError> {
    let mut graph = CapabilityRegistry::new();
    for provider in host {
        graph.register_provider(provider.id, 1, &provider.provides, &[], &[])?;
    }
    let mut enabled: Vec<_> = plugins
        .iter()
        .filter(|plugin| registry.is_enabled(&plugin.manifest.id))
        .collect();
    enabled.sort_by(|left, right| left.manifest.id.cmp(&right.manifest.id));
    for plugin in enabled {
        graph.register_provider(
            &plugin.manifest.id,
            plugin.generation,
            &plugin.manifest.provides,
            &plugin.manifest.requires,
            &[],
        )?;
    }
    Ok(DependencyGraph {
        basis: "static_desired_configuration",
        activation_order: graph.resolve_activation_order()?,
    })
}

fn dependency_issue(
    error: CapabilityRegistryError,
    plugins: &[LoadedPlugin],
    registry: &PluginRegistry,
) -> DiagnosticIssue {
    let mut issue = DiagnosticIssue::new(
        "dependency_invalid",
        error.to_string(),
        "Restore or update the bundled Codlet manifests and rerun doctor.",
    );
    match error {
        CapabilityRegistryError::MissingRequirement {
            consumer,
            requirement,
        } => {
            let disabled: Vec<_> = plugins
                .iter()
                .filter(|plugin| {
                    !registry.is_enabled(&plugin.manifest.id)
                        && plugin.manifest.provides.contains(&requirement)
                })
                .map(|plugin| plugin.manifest.id.clone())
                .collect();
            issue.code = if disabled.is_empty() {
                "dependency_missing_provider"
            } else {
                "dependency_provider_disabled"
            };
            issue.remediation = if disabled.is_empty() {
                format!(
                    "Restore a bundled provider for {requirement}, or run `codlet plugin disable {consumer}`; rerun doctor."
                )
            } else {
                format!(
                    "Run `codlet plugin enable {}` to restore the required provider, or `codlet plugin disable {consumer}`; changes apply to the next codlet launch.",
                    disabled[0]
                )
            };
            issue.details = json!({"consumer": consumer, "requirement": requirement, "disabledProviders": disabled});
        }
        CapabilityRegistryError::VersionMismatch {
            consumer,
            provider,
            requirement,
            provided_api,
        } => {
            issue.code = "dependency_api_mismatch";
            issue.details = json!({"consumer": consumer, "provider": provider, "requirement": requirement, "providedApi": provided_api});
        }
        CapabilityRegistryError::DependencyCycle { providers } => {
            issue.code = "dependency_cycle";
            issue.details = json!({"providers": providers});
        }
        CapabilityRegistryError::CapabilityConflict {
            name,
            scope,
            existing_provider,
            conflicting_provider,
        } => {
            issue.code = "dependency_capability_conflict";
            issue.details = json!({"name": name, "scope": scope, "existingProvider": existing_provider, "conflictingProvider": conflicting_provider});
        }
        CapabilityRegistryError::ProviderConflict { provider_id } => {
            issue.code = "dependency_provider_conflict";
            issue.details = json!({"provider": provider_id});
        }
        CapabilityRegistryError::InvalidProviderId(provider_id) => {
            issue.code = "dependency_provider_id_invalid";
            issue.details = json!({"provider": provider_id});
        }
        CapabilityRegistryError::InvalidGeneration {
            provider_id,
            generation,
        } => {
            issue.code = "dependency_generation_invalid";
            issue.details = json!({"provider": provider_id, "declaredGeneration": generation});
        }
        CapabilityRegistryError::ScopeAlreadyActive { .. } => {}
    }
    issue
}
