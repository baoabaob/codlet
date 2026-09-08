use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use thiserror::Error;

use crate::catalog::{PluginCatalog, PluginSource};
use crate::cdp::{
    CdpClient, ClientSpawnError, ShutdownError, TargetChange, TargetController, TargetError,
    TargetSession,
};
use crate::diagnostics::{
    Check, DiagnosticIssue, DoctorInputs, DoctorReport, PackageInfo, ProcessInfo, ProcessSnapshot,
};
use crate::local_plugins::{LocalPluginError, inspect_local_plugin};
use crate::plugin_control::{PluginControlAction, PluginControlRequest};
use crate::plugins::{
    LocalPluginRegistration, ManifestError, Permission, PluginRegistry, PluginRegistryError,
    bundled_plugins, default_registry_path,
};
use crate::renderer::{RendererBootstrapReport, RendererError, RendererRuntime};
use crate::runtime_control::ControlBroker;
use crate::runtime_status::{CodexStatus, StatusCode, StatusPublisher};
use crate::windows::control_pipe::{ControlServer, RegistryScope, RegistryScopeGuard};
use crate::windows::launch_mutex::{LaunchMutexError, LaunchMutexGuard};
use crate::windows::packages::{
    CODEX_EXECUTABLE_RELATIVE_PATH, CODEX_PACKAGE_FAMILY, InstalledPackage, PackageError,
    find_unique_current_user_package, resolve_package_executable,
};
use crate::windows::process::{
    ChildProcess, ProcessError, RunningProcess, launch_with_cdp_pipes,
    running_processes_for_package,
};
use crate::windows::status_pipe::{StatusPipeError, StatusServer, query_current_user};

const REQUEST_DEADLINE: Duration = Duration::from_secs(15);
const LAUNCH_MUTEX_DEADLINE: Duration = Duration::from_secs(30);
const REGISTRY_LEASE_DEADLINE: Duration = Duration::from_millis(1500);
const REAL_PROBE_CONFIRMATION: &str = "--launch-codex";
const RUNTIME_WAIT_SLICE: Duration = Duration::from_millis(50);

#[derive(Debug, Error)]
pub enum ProbeError {
    #[error(transparent)]
    Package(#[from] PackageError),
    #[error(transparent)]
    Process(#[from] ProcessError),
    #[error(transparent)]
    LaunchMutex(#[from] LaunchMutexError),
    #[error(transparent)]
    Target(#[from] TargetError),
    #[error(transparent)]
    ClientSpawn(#[from] ClientSpawnError),
    #[error(transparent)]
    Shutdown(#[from] ShutdownError),
    #[error(
        "Codex instance conflict: process(es) {process_ids:?} already use {executable}; existing processes were not modified"
    )]
    InstanceConflict {
        executable: PathBuf,
        process_ids: Vec<u32>,
    },
    #[error(transparent)]
    Marker(#[from] MarkerFailure),
    #[error(transparent)]
    Renderer(#[from] RendererError),
    #[error(transparent)]
    Manifest(#[from] ManifestError),
    #[error(transparent)]
    PluginRegistry(#[from] PluginRegistryError),
    #[error(transparent)]
    LocalPlugin(#[from] LocalPluginError),
    #[error(transparent)]
    StatusPipe(#[from] StatusPipeError),
    #[error(transparent)]
    PluginCli(#[from] crate::plugin_cli::PluginCliError),
    #[error(
        "runtime registry {path} is already owned by a Codlet Host or offline editor; check status before launching"
    )]
    RegistryOwned { path: PathBuf },
    #[error("Host status query failed: {status:?}; see the status report")]
    StatusFailed { status: StatusCode },
    #[error("marker cleanup also failed after {primary}: {cleanup}")]
    MarkerCleanupAfterFailure {
        primary: Box<MarkerFailure>,
        cleanup: Box<MarkerFailure>,
    },
    #[error(
        "unrecognized arguments; use `codlet launch`, `codlet status [--json]`, `codlet doctor [--json]`, `codlet plugin list`, `codlet plugin add <directory> [--trust] [--grant <permission>]...`, `codlet plugin remove <id>`, `codlet plugin enable <id> [--json]`, `codlet plugin disable <id> [--json]`, `codlet plugin reload <id> [--json]`, `codlet plugin operation <receipt> [--json]`, `codlet m0-probe --launch-codex`, or `codlet m0-runtime --launch-codex`"
    )]
    Usage,
    #[error(
        "local plugin {0} was inspected but not registered; review its directory and requested permissions, then explicitly supply --trust and --grant for each requested permission"
    )]
    PluginTrustRequired(String),
    #[error("unrecognized plugin permission {0}")]
    UnknownPermission(String),
    #[error("bundled plugin {0} cannot be removed; use `codlet plugin disable <id>`")]
    CannotRemoveBundledPlugin(String),
    #[error("Codex exited with nonzero status {exit_code} after CDP workers were reaped")]
    CodexExit { exit_code: u32 },
    #[error(
        "doctor found {failed_checks} failed check(s); see the report for repair actions (exit code 1)"
    )]
    DoctorFailed { failed_checks: usize },
}

#[derive(Debug)]
pub struct ProbeReport {
    pub package: InstalledPackage,
    pub executable: PathBuf,
    pub process_id: u32,
    pub target_id: String,
    pub marker_inserted: bool,
    pub marker_removed: bool,
}

#[derive(Debug, Error)]
pub enum MarkerFailure {
    #[error("Runtime.evaluate request failed during marker {phase}: {source}")]
    Request {
        phase: &'static str,
        #[source]
        source: TargetError,
    },
    #[error("Runtime.evaluate returned an invalid marker result during {phase}")]
    Invalid { phase: &'static str },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MarkerReport {
    pub inserted: bool,
    pub removed: bool,
}

struct ProbedCodex {
    report: ProbeReport,
    process: ChildProcess,
    client: CdpClient,
    targets: TargetController,
    marker_id: String,
}

struct AttachedCodex {
    package: InstalledPackage,
    executable: PathBuf,
    process: ChildProcess,
    client: CdpClient,
    targets: TargetController,
    sessions: Vec<TargetSession>,
}

struct RendererOutcome {
    target_id: String,
    result: Result<RendererBootstrapReport, RendererError>,
}

struct CodletRuntime {
    status: StatusPublisher,
    control: ControlBroker,
    package: InstalledPackage,
    executable: PathBuf,
    process: ChildProcess,
    client: CdpClient,
    targets: TargetController,
    renderer: RendererRuntime,
    initial_outcomes: Vec<RendererOutcome>,
    // Keep listeners and the registry lease until renderer cleanup has finished.
    _servers: HostServers,
}

struct PreparedServices {
    status: StatusPublisher,
    lease: RegistryScopeGuard,
}

struct HostServers {
    _status: StatusServer,
    control: ControlServer,
}

pub fn run_cli(arguments: impl Iterator<Item = OsString>) -> Result<(), ProbeError> {
    let arguments: Vec<_> = arguments.collect();
    match arguments.as_slice() {
        [command] if command == OsStr::new("launch") => {
            let runtime = start_codlet_runtime()?;
            runtime.print_identity_and_initial_state();
            println!("runtime-state: active; Codlet renderer runtime attached");
            println!(
                "action: use Codex normally, then close Codex to stop this foreground runtime"
            );
            let exit_code = runtime.wait()?;
            println!("codex-exit-code: {exit_code}");
            println!("runtime-state: stopped; CDP workers reaped");
            Ok(())
        }
        [command] if command == OsStr::new("doctor") => run_doctor(false),
        [command] if command == OsStr::new("status") => run_status(false),
        [command, format] if command == OsStr::new("status") && format == OsStr::new("--json") => {
            run_status(true)
        }
        [command, format] if command == OsStr::new("doctor") && format == OsStr::new("--json") => {
            run_doctor(true)
        }
        [command, action] if command == OsStr::new("plugin") && action == OsStr::new("list") => {
            let registry = PluginRegistry::load_default()?;
            print_plugin_registry(&registry)
        }
        [command, action, plugin_id, options @ ..]
            if command == OsStr::new("plugin")
                && matches!(
                    action.to_str(),
                    Some("enable" | "disable" | "reload" | "operation")
                ) =>
        {
            let json = match options {
                [] => false,
                [option] if option == OsStr::new("--json") => true,
                _ => return Err(ProbeError::Usage),
            };
            let plugin_id = plugin_id.to_str().ok_or(ProbeError::Usage)?;
            if action == OsStr::new("operation") {
                crate::plugin_cli::operation(plugin_id, json)?;
            } else {
                let action = match action.to_str().unwrap() {
                    "enable" => PluginControlAction::Enable,
                    "disable" => PluginControlAction::Disable,
                    "reload" => PluginControlAction::Reload,
                    _ => unreachable!(),
                };
                crate::plugin_cli::manage(
                    PluginControlRequest {
                        action,
                        plugin_id: plugin_id.into(),
                    },
                    json,
                )?;
            }
            Ok(())
        }
        [command, action, directory, options @ ..]
            if command == OsStr::new("plugin") && action == OsStr::new("add") =>
        {
            let options = parse_plugin_trust_options(options)?;
            add_local_plugin(Path::new(directory), options)
        }
        [command, action, plugin_id]
            if command == OsStr::new("plugin") && action == OsStr::new("remove") =>
        {
            remove_local_plugin(plugin_id.to_str().ok_or(ProbeError::Usage)?)
        }
        [command, confirmation]
            if command == OsStr::new("m0-probe")
                && confirmation == OsStr::new(REAL_PROBE_CONFIRMATION) =>
        {
            let report = run_real_probe()?;
            print_probe_report(&report);
            println!(
                "lifecycle: probe completion closes the remote-debugging pipe; Electron receives a cooperative quit request, but Codex may remain running"
            );
            println!(
                "result: inherited-pipe transport smoke succeeded; this is not the production launcher and M0 remains externally gated"
            );
            Ok(())
        }
        [command, confirmation]
            if command == OsStr::new("m0-runtime")
                && confirmation == OsStr::new(REAL_PROBE_CONFIRMATION) =>
        {
            let runtime = start_probed_codex()?;
            print_probe_report(&runtime.report);
            println!(
                "runtime-state: active; holding inherited CDP pipes until the launched Codex exits"
            );
            println!(
                "action: use Codex normally, then close Codex to stop this foreground runtime"
            );
            let exit_code = runtime.wait()?;
            println!("codex-exit-code: {exit_code}");
            println!("runtime-state: stopped; CDP workers reaped");
            Ok(())
        }
        _ => Err(ProbeError::Usage),
    }
}

fn run_status(json: bool) -> Result<(), ProbeError> {
    let report = query_current_user();
    if json {
        println!(
            "{}",
            serde_json::to_string(&report).expect("status is serializable")
        );
    } else {
        print!("{}", report.to_human_readable());
    }
    if report.is_success() {
        Ok(())
    } else {
        Err(ProbeError::StatusFailed {
            status: report.status,
        })
    }
}

fn run_doctor(json: bool) -> Result<(), ProbeError> {
    let report = collect_doctor_report();
    if json {
        println!("{}", report.to_json());
    } else {
        print!("{}", report.to_human_readable());
    }
    if report.result.exit_code == 0 {
        Ok(())
    } else {
        Err(ProbeError::DoctorFailed {
            failed_checks: report.result.failed_checks.len(),
        })
    }
}

/// Collect independent read-only checks even when another check fails. Exact
/// process matching needs a resolved package executable; it never falls back to
/// broad process-name guesses when discovery fails.
pub fn collect_doctor_report() -> DoctorReport {
    let discovered = find_unique_current_user_package(CODEX_PACKAGE_FAMILY);
    let executable = match &discovered {
        Ok(package) => {
            match resolve_package_executable(package, Path::new(CODEX_EXECUTABLE_RELATIVE_PATH)) {
                Ok(path) => Check::ok(path),
                Err(error) => Check::Failed {
                    error: package_issue(&error),
                },
            }
        }
        Err(_) => Check::Unavailable {
            reason: "Package discovery failed; no executable path was guessed.",
        },
    };
    let processes = match &executable {
        Check::Ok { data } => match running_processes_for_package(CODEX_PACKAGE_FAMILY, data) {
            Ok(processes) => Check::ok(ProcessSnapshot::new(
                processes
                    .into_iter()
                    .map(|process| ProcessInfo {
                        process_id: process.process_id,
                        executable: process.executable.to_string_lossy().into_owned(),
                    })
                    .collect(),
            )),
            Err(error) => Check::Failed {
                error: DiagnosticIssue::new(
                    "process_snapshot_failed",
                    error.to_string(),
                    "Check current-user access to the named candidate process and rerun doctor. Launch is blocked until an exact process snapshot succeeds; existing processes were not changed.",
                ),
            },
        },
        _ => Check::Unavailable {
            reason: "Exact package process matching requires a resolved executable; no process snapshot was taken.",
        },
    };
    let package = match discovered {
        Ok(package) => Check::ok(PackageInfo {
            family_name: package.family_name,
            full_name: package.full_name,
            version: package.version.to_string(),
            install_location: package.install_location.to_string_lossy().into_owned(),
        }),
        Err(error) => Check::Failed {
            error: package_issue(&error),
        },
    };
    let (registry_path, registry) = match default_registry_path() {
        Ok(path) => (Some(path.clone()), PluginRegistry::load(path)),
        Err(error) => (None, Err(error)),
    };
    let executable = match executable {
        Check::Ok { data } => Check::ok(data.to_string_lossy().into_owned()),
        Check::Failed { error } => Check::Failed { error },
        Check::Unavailable { reason } => Check::Unavailable { reason },
    };
    let catalog = match &registry {
        Ok(registry) => PluginCatalog::load(registry),
        Err(_) => bundled_plugins().map(PluginCatalog::from_bundled),
    };
    DoctorReport::from_inputs(DoctorInputs {
        package,
        executable,
        processes,
        registry_path,
        registry,
        catalog,
    })
}

fn package_issue(error: &PackageError) -> DiagnosticIssue {
    let (code, remediation) = match error {
        PackageError::NotFound(_) => (
            "package_not_installed",
            "Install the official Codex Desktop package for the current Windows user, then rerun doctor.",
        ),
        PackageError::Ambiguous { .. } => (
            "package_ambiguous",
            "Resolve the multiple Codex package registrations for the current user using Windows app management, then rerun doctor; Codlet will not guess a package.",
        ),
        PackageError::ExecutableNotFound(_)
        | PackageError::InvalidInstallLocation(_)
        | PackageError::Canonicalize { .. } => (
            "package_path_unavailable",
            "Check access to the reported package path and use Windows app management to repair the official Codex installation if files are missing; rerun doctor.",
        ),
        PackageError::ExecutableOutsidePackage(_) | PackageError::InvalidRelativeExecutable(_) => (
            "package_path_invalid",
            "Restore the official Codex installation and update Codlet if its expected executable layout has changed; rerun doctor.",
        ),
        _ => (
            "package_discovery_failed",
            "Check current-user Windows package registration and access, then rerun doctor; retain this error when reporting a Codlet discovery issue.",
        ),
    };
    DiagnosticIssue::new(code, error.to_string(), remediation)
}

pub fn run_real_probe() -> Result<ProbeReport, ProbeError> {
    Ok(start_probed_codex()?.report)
}

fn start_probed_codex() -> Result<ProbedCodex, ProbeError> {
    let attached = start_attached_codex()?;
    let marker_id = marker_id();
    let markers = bootstrap_probe_sessions(&attached.sessions, &marker_id)?;
    let session = attached
        .sessions
        .first()
        .expect("successful target discovery must return at least one session");
    let marker = markers
        .first()
        .expect("every discovered target must receive the probe bootstrap");

    Ok(ProbedCodex {
        report: ProbeReport {
            package: attached.package,
            executable: attached.executable,
            process_id: attached.process.process_id(),
            target_id: session.target_id().to_owned(),
            marker_inserted: marker.inserted,
            marker_removed: marker.removed,
        },
        process: attached.process,
        client: attached.client,
        targets: attached.targets,
        marker_id,
    })
}

fn start_attached_codex() -> Result<AttachedCodex, ProbeError> {
    start_attached_codex_with_services(None).map(|(attached, _)| attached)
}

fn start_attached_codex_with_services(
    services: Option<PreparedServices>,
) -> Result<(AttachedCodex, Option<HostServers>), ProbeError> {
    let status = services.as_ref().map(|services| services.status.clone());
    let launch_guard = LaunchMutexGuard::acquire_current_user(LAUNCH_MUTEX_DEADLINE)?;
    let (package, executable, running) = inspect_environment()?;
    let ((process, pipes), server) = checked_launch_prepared(
        &executable,
        running,
        || running_processes_for_package(CODEX_PACKAGE_FAMILY, &executable),
        || {
            services
                .map(|services| {
                    Ok::<_, ProbeError>(HostServers {
                        _status: StatusServer::bind_current_user(services.status)?,
                        control: ControlServer::bind_current_user(services.lease)?,
                    })
                })
                .transpose()
        },
        |server| Ok((launch_with_cdp_pipes(&executable, &[], false)?, server)),
    )?;
    if let Some(status) = status {
        status.set_codex(CodexStatus {
            pid: process.process_id(),
            package_full_name: package.full_name.clone(),
            package_version: package.version.to_string(),
            executable: executable.to_string_lossy().into_owned(),
        });
    }
    drop(launch_guard);
    let (client, events) = CdpClient::spawn(pipes)?;
    let (targets, sessions) = TargetController::discover(client.clone(), events, REQUEST_DEADLINE)?;

    Ok((
        AttachedCodex {
            package,
            executable,
            process,
            client,
            targets,
            sessions,
        },
        server,
    ))
}

fn start_codlet_runtime() -> Result<CodletRuntime, ProbeError> {
    let scope = RegistryScope::for_path(&default_registry_path()?)?;
    let lease = scope
        .acquire(REGISTRY_LEASE_DEADLINE)
        .map_err(|error| match error {
            StatusPipeError::Timeout => ProbeError::RegistryOwned {
                path: scope.path().to_owned(),
            },
            other => ProbeError::from(other),
        })?;
    let registry = PluginRegistry::load(scope.path())?;
    let mut renderer = prepare_renderer_runtime(registry)?;
    let status = StatusPublisher::new();
    renderer.set_status_publisher(status.clone());
    let (attached, servers) = start_attached_codex_with_services(Some(PreparedServices {
        status: status.clone(),
        lease,
    }))?;
    let initial_outcomes = attached
        .sessions
        .iter()
        .map(|session| RendererOutcome {
            target_id: session.target_id().to_owned(),
            result: renderer.attach(session),
        })
        .collect();
    status.set_ready();
    let servers = servers.expect("runtime launch prepared its IPC servers");
    let control = servers.control.broker();
    control.set_ready();
    Ok(CodletRuntime {
        _servers: servers,
        status,
        control,
        package: attached.package,
        executable: attached.executable,
        process: attached.process,
        client: attached.client,
        targets: attached.targets,
        renderer,
        initial_outcomes,
    })
}

/// Validate configured plugins and build the renderer manager before any Codex
/// discovery or launch. This only reads plugin files and never executes their source.
pub fn prepare_renderer_runtime(registry: PluginRegistry) -> Result<RendererRuntime, ProbeError> {
    let catalog = PluginCatalog::load(&registry)?;
    Ok(RendererRuntime::from_catalog(catalog, registry)?)
}

fn print_plugin_registry(registry: &PluginRegistry) -> Result<(), ProbeError> {
    println!("plugin-registry: {}", registry.path().display());
    let catalog = PluginCatalog::load(registry)?;
    for entry in catalog.entries() {
        let source = match entry.source {
            PluginSource::Bundled => "bundled",
            PluginSource::Local { .. } => "local",
        };
        let version = entry
            .plugin
            .as_ref()
            .map(|plugin| plugin.manifest.version.as_str())
            .unwrap_or("unavailable");
        println!(
            "plugin: id={}; version={version}; source={source}; enabled={}",
            entry.id,
            registry.is_enabled(&entry.id)
        );
        if let PluginSource::Local { path, grants } = &entry.source {
            println!("plugin-directory: {}", path.display());
            println!("granted-permissions: {}", permission_list(grants));
        }
        if let Err(error) = &entry.plugin {
            println!(
                "plugin-validation: id={}; state=failed; error={error}",
                entry.id
            );
        }
    }
    Ok(())
}

#[derive(Default)]
struct PluginTrustOptions {
    trusted: bool,
    grants: Vec<Permission>,
}

fn parse_plugin_trust_options(arguments: &[OsString]) -> Result<PluginTrustOptions, ProbeError> {
    let mut options = PluginTrustOptions::default();
    let mut arguments = arguments.iter();
    while let Some(argument) = arguments.next() {
        if argument == OsStr::new("--trust") && !options.trusted {
            options.trusted = true;
        } else if argument == OsStr::new("--grant") {
            let permission = arguments
                .next()
                .and_then(|permission| permission.to_str())
                .ok_or(ProbeError::Usage)?;
            let grant: Permission = serde_json::from_value(Value::String(permission.to_owned()))
                .map_err(|_| ProbeError::UnknownPermission(permission.to_owned()))?;
            if options.grants.contains(&grant) {
                return Err(ProbeError::Usage);
            }
            options.grants.push(grant);
        } else {
            return Err(ProbeError::Usage);
        }
    }
    Ok(options)
}

fn permission_list(permissions: &[Permission]) -> String {
    if permissions.is_empty() {
        "none".to_owned()
    } else {
        permissions
            .iter()
            .map(|permission| permission.as_str())
            .collect::<Vec<_>>()
            .join(",")
    }
}

fn add_local_plugin(directory: &Path, options: PluginTrustOptions) -> Result<(), ProbeError> {
    let candidate = inspect_local_plugin(directory)?;
    let plugin_id = &candidate.manifest.id;
    if !options.trusted {
        println!(
            "plugin-candidate: id={plugin_id}; version={}; source=local",
            candidate.manifest.version
        );
        println!("plugin-directory: {}", candidate.root.display());
        println!(
            "requested-permissions: {}",
            permission_list(&candidate.manifest.permissions)
        );
        return Err(ProbeError::PluginTrustRequired(plugin_id.clone()));
    }
    candidate.validate_grants(&options.grants)?;
    let mut registry = PluginRegistry::load_default()?;
    registry.register_local(
        plugin_id,
        LocalPluginRegistration {
            path: candidate.root,
            grants: options.grants,
        },
    )?;
    registry.save()?;
    println!(
        "plugin-added: id={plugin_id}; enabled={}; applies=next-codlet-launch",
        registry.is_enabled(plugin_id)
    );
    Ok(())
}

fn remove_local_plugin(plugin_id: &str) -> Result<(), ProbeError> {
    if bundled_plugins()?
        .iter()
        .any(|plugin| plugin.manifest.id == plugin_id)
    {
        return Err(ProbeError::CannotRemoveBundledPlugin(plugin_id.to_owned()));
    }
    let mut registry = PluginRegistry::load_default()?;
    registry.remove_local(plugin_id)?;
    registry.save()?;
    println!("plugin-removed: id={plugin_id}; applies=next-codlet-launch; directory=preserved");
    Ok(())
}

impl ProbedCodex {
    fn wait(mut self) -> Result<u32, ProbeError> {
        let exit_code = loop {
            if let Some(exit_code) = self.process.wait(Duration::ZERO)? {
                break exit_code;
            }

            let changes = match self.targets.pump(Duration::ZERO) {
                Ok(changes) => changes,
                Err(error) => {
                    if let Some(exit_code) = self.process.wait(RUNTIME_WAIT_SLICE)? {
                        break exit_code;
                    }
                    return Err(error.into());
                }
            };
            let mut sessions = Vec::new();
            for change in changes {
                match change {
                    TargetChange::Attached(session) => sessions.push(session),
                    TargetChange::NavigatedAway(session) => session.detach()?,
                    TargetChange::SessionEnded { .. } => {}
                }
            }
            let markers = bootstrap_probe_sessions(&sessions, &self.marker_id)?;
            for (session, marker) in sessions.iter().zip(markers) {
                println!(
                    "renderer-bootstrap: target-id={}; marker-inserted={}; marker-removed={}",
                    session.target_id(),
                    marker.inserted,
                    marker.removed
                );
            }

            if let Some(exit_code) = self.process.wait(RUNTIME_WAIT_SLICE)? {
                break exit_code;
            }
        };
        self.client.shutdown()?;
        if exit_code == 0 {
            Ok(exit_code)
        } else {
            Err(ProbeError::CodexExit { exit_code })
        }
    }
}

impl CodletRuntime {
    fn print_identity_and_initial_state(&self) {
        println!("package: {}", self.package.full_name);
        println!("version: {}", self.package.version);
        println!("executable: {}", self.executable.display());
        println!("launched-process-id: {}", self.process.process_id());
        for outcome in &self.initial_outcomes {
            print_renderer_outcome(outcome);
        }
    }

    fn wait(mut self) -> Result<u32, ProbeError> {
        let result = self.wait_inner();
        if let Err(error) = &result {
            self.status.terminate(format!("runtime_error: {error}"));
        }
        result
    }

    fn wait_inner(&mut self) -> Result<u32, ProbeError> {
        let exit_code = loop {
            if let Some(exit_code) = self.process.wait(Duration::ZERO)? {
                break exit_code;
            }

            let changes = match self.targets.pump(Duration::ZERO) {
                Ok(changes) => changes,
                Err(error) => {
                    if let Some(exit_code) = self.process.wait(RUNTIME_WAIT_SLICE)? {
                        break exit_code;
                    }
                    return Err(error.into());
                }
            };
            for change in changes {
                let target_id = change.target_id().to_owned();
                match self.renderer.apply_target_change(change) {
                    Ok(Some(report)) => print_renderer_outcome(&RendererOutcome {
                        target_id,
                        result: Ok(report),
                    }),
                    Ok(None) => {}
                    Err(error) => print_renderer_outcome(&RendererOutcome {
                        target_id,
                        result: Err(error),
                    }),
                }
            }
            let _ = self.renderer.pump_bindings()?;
            if let Some(job) = self.control.take_next() {
                let result = self.renderer.manage_plugin(job.request);
                self.control.complete(&job.operation_id, result);
            }
            self.renderer.publish_status();
            for diagnostic in self.renderer.take_diagnostics() {
                eprintln!(
                    "renderer-plugin: target-id={}; plugin-id={}; state=cleanup-failed; error={}",
                    diagnostic.target_id, diagnostic.plugin_id, diagnostic.message
                );
            }
            if let Some(exit_code) = self.process.wait(RUNTIME_WAIT_SLICE)? {
                break exit_code;
            }
        };
        self.control.stop();
        self.status.terminate(format!("child_exited: {exit_code}"));
        self.client.shutdown()?;
        if exit_code == 0 {
            Ok(exit_code)
        } else {
            Err(ProbeError::CodexExit { exit_code })
        }
    }
}

impl Drop for CodletRuntime {
    fn drop(&mut self) {
        self.control.stop();
        self.status.terminate("host_dropped");
    }
}

fn print_renderer_outcome(outcome: &RendererOutcome) {
    match &outcome.result {
        Ok(report) => println!(
            "renderer-bootstrap: target-id={}; state=active; plugins={}",
            report.target_id, report.plugin_count
        ),
        Err(error) => eprintln!(
            "renderer-bootstrap: target-id={}; state=failed; error={error}",
            outcome.target_id
        ),
    }
}

/// Keeps the inherited CDP connection alive until this exact child exits, then joins its workers.
pub fn hold_cdp_until_child_exit(
    process: &ChildProcess,
    client: &CdpClient,
) -> Result<u32, ProbeError> {
    let exit_code = loop {
        if let Some(exit_code) = process.wait(RUNTIME_WAIT_SLICE)? {
            break exit_code;
        }
    };
    client.shutdown()?;
    if exit_code == 0 {
        Ok(exit_code)
    } else {
        Err(ProbeError::CodexExit { exit_code })
    }
}

fn print_probe_report(report: &ProbeReport) {
    println!("package: {}", report.package.full_name);
    println!("version: {}", report.package.version);
    println!("executable: {}", report.executable.display());
    println!("launched-process-id: {}", report.process_id);
    println!("target-id: {}", report.target_id);
    println!("marker-inserted: {}", report.marker_inserted);
    println!("marker-removed: {}", report.marker_removed);
}

pub fn probe_marker(session: &TargetSession, marker_id: &str) -> Result<MarkerReport, ProbeError> {
    let (insert, remove) = marker_expressions(marker_id);
    let insert_result = evaluate_marker_phase(session, &insert, "insert");
    let cleanup_result = evaluate_marker_phase(session, &remove, "remove");

    match (insert_result, cleanup_result) {
        (Ok(()), Ok(())) => Ok(MarkerReport {
            inserted: true,
            removed: true,
        }),
        (Err(primary), Ok(())) => Err(ProbeError::Marker(primary)),
        (Ok(()), Err(cleanup)) => Err(ProbeError::Marker(cleanup)),
        (Err(primary), Err(cleanup)) => Err(ProbeError::MarkerCleanupAfterFailure {
            primary: Box::new(primary),
            cleanup: Box::new(cleanup),
        }),
    }
}

fn bootstrap_probe_sessions(
    sessions: &[TargetSession],
    marker_id: &str,
) -> Result<Vec<MarkerReport>, ProbeError> {
    sessions
        .iter()
        .map(|session| probe_marker(session, marker_id))
        .collect()
}

fn marker_expressions(marker_id: &str) -> (String, String) {
    let encoded_id = serde_json::to_string(marker_id).expect("string serialization cannot fail");
    let insert = format!(
        r#"(() => {{
            const id = {encoded_id};
            if (document.getElementById(id)) return false;
            const marker = document.createElement('div');
            marker.id = id;
            marker.textContent = 'Codlet M0';
            marker.setAttribute('data-codlet-m0-probe', 'true');
            Object.assign(marker.style, {{
                position: 'fixed', top: '8px', right: '8px', zIndex: '2147483647',
                padding: '4px 8px', borderRadius: '4px',
                background: '#202124', color: '#f1f3f4', font: '12px sans-serif'
            }});
            document.documentElement.appendChild(marker);
            return document.getElementById(id) === marker;
        }})()"#
    );
    let remove = format!(
        r#"(() => {{
            const id = {encoded_id};
            const marker = document.getElementById(id);
            if (marker) marker.remove();
            return marker !== null && document.getElementById(id) === null;
        }})()"#
    );

    (insert, remove)
}

fn evaluate_marker_phase(
    session: &TargetSession,
    expression: &str,
    phase: &'static str,
) -> Result<(), MarkerFailure> {
    let result = session
        .evaluate(expression)
        .map_err(|source| MarkerFailure::Request { phase, source })?;
    if evaluation_boolean(&result) == Some(true) {
        Ok(())
    } else {
        Err(MarkerFailure::Invalid { phase })
    }
}

#[cfg(test)]
fn checked_launch<T, Scan, Launch>(
    executable: &Path,
    initial_scan: Vec<RunningProcess>,
    second_scan: Scan,
    launch: Launch,
) -> Result<T, ProbeError>
where
    Scan: FnMut() -> Result<Vec<RunningProcess>, ProcessError>,
    Launch: FnOnce() -> Result<T, ProcessError>,
{
    checked_launch_prepared(
        executable,
        initial_scan,
        second_scan,
        || Ok(()),
        |()| Ok(launch()?),
    )
}

fn checked_launch_prepared<T, P, Scan, Prepare, Launch>(
    executable: &Path,
    initial_scan: Vec<RunningProcess>,
    mut second_scan: Scan,
    prepare: Prepare,
    launch: Launch,
) -> Result<T, ProbeError>
where
    Scan: FnMut() -> Result<Vec<RunningProcess>, ProcessError>,
    Prepare: FnOnce() -> Result<P, ProbeError>,
    Launch: FnOnce(P) -> Result<T, ProbeError>,
{
    reject_instance_conflict(executable, initial_scan)?;
    reject_instance_conflict(executable, second_scan()?)?;
    launch(prepare()?)
}

fn reject_instance_conflict(
    executable: &Path,
    running: Vec<RunningProcess>,
) -> Result<(), ProbeError> {
    if running.is_empty() {
        Ok(())
    } else {
        Err(ProbeError::InstanceConflict {
            executable: executable.to_owned(),
            process_ids: running
                .into_iter()
                .map(|process| process.process_id)
                .collect(),
        })
    }
}

fn inspect_environment() -> Result<
    (
        InstalledPackage,
        PathBuf,
        Vec<crate::windows::process::RunningProcess>,
    ),
    ProbeError,
> {
    let package = find_unique_current_user_package(CODEX_PACKAGE_FAMILY)?;
    let executable =
        resolve_package_executable(&package, Path::new(CODEX_EXECUTABLE_RELATIVE_PATH))?;
    let running = running_processes_for_package(CODEX_PACKAGE_FAMILY, &executable)?;
    Ok((package, executable, running))
}

fn evaluation_boolean(result: &Value) -> Option<bool> {
    if result.get("exceptionDetails").is_some() {
        return None;
    }
    result.pointer("/result/value").and_then(Value::as_bool)
}

fn marker_id() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is before UNIX_EPOCH")
        .as_nanos();
    format!("codlet-m0-probe-{}-{timestamp}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier, Mutex};

    #[test]
    fn extracts_only_successful_boolean_evaluation() {
        assert_eq!(
            evaluation_boolean(&json!({"result": {"type": "boolean", "value": true}})),
            Some(true)
        );
        assert_eq!(
            evaluation_boolean(&json!({
                "result": {"type": "boolean", "value": true},
                "exceptionDetails": {}
            })),
            None
        );
        assert_eq!(evaluation_boolean(&json!({"result": {"value": 1}})), None);
    }

    #[test]
    fn package_instance_conflict_does_not_launch_or_change_existing_processes() {
        let executable = PathBuf::from(r"C:\Program Files\WindowsApps\Codex\ChatGPT.exe");
        let processes = Arc::new(Mutex::new(vec![RunningProcess {
            process_id: 4100,
            executable: executable.clone(),
        }]));
        let before = processes.lock().unwrap().clone();
        let launch_calls = AtomicUsize::new(0);
        let result = checked_launch(
            &executable,
            before.clone(),
            || Ok(processes.lock().unwrap().clone()),
            || {
                launch_calls.fetch_add(1, Ordering::SeqCst);
                processes.lock().unwrap().push(RunningProcess {
                    process_id: 4200,
                    executable: executable.clone(),
                });
                Ok(())
            },
        );

        assert!(matches!(
            result,
            Err(ProbeError::InstanceConflict { process_ids, .. }) if process_ids == vec![4100]
        ));
        assert_eq!(launch_calls.load(Ordering::SeqCst), 0);
        assert_eq!(*processes.lock().unwrap(), before);
    }

    #[test]
    fn second_process_scan_prevents_launch() {
        let executable = PathBuf::from(r"C:\Program Files\WindowsApps\Codex\ChatGPT.exe");
        let launch_calls = AtomicUsize::new(0);
        let result = checked_launch(
            &executable,
            Vec::new(),
            || {
                Ok(vec![RunningProcess {
                    process_id: 4300,
                    executable: executable.clone(),
                }])
            },
            || {
                launch_calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        );

        assert!(matches!(
            result,
            Err(ProbeError::InstanceConflict { process_ids, .. }) if process_ids == vec![4300]
        ));
        assert_eq!(launch_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn conflicts_precede_ipc_and_ipc_failure_precedes_child_creation() {
        let executable = PathBuf::from(r"C:\fixture\child.exe");
        for conflict_scan in [0, 1, 2] {
            let prepared = AtomicUsize::new(0);
            let launched = AtomicUsize::new(0);
            let running = || {
                vec![RunningProcess {
                    process_id: 42,
                    executable: executable.clone(),
                }]
            };
            let result = checked_launch_prepared(
                &executable,
                if conflict_scan == 1 {
                    running()
                } else {
                    Vec::new()
                },
                || {
                    Ok(if conflict_scan == 2 {
                        running()
                    } else {
                        Vec::new()
                    })
                },
                || {
                    prepared.fetch_add(1, Ordering::SeqCst);
                    Err::<(), _>(ProbeError::StatusPipe(StatusPipeError::Invalid(
                        "fixture IPC allocation failure".into(),
                    )))
                },
                |()| {
                    launched.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
            );
            assert_eq!(launched.load(Ordering::SeqCst), 0);
            assert_eq!(
                prepared.load(Ordering::SeqCst),
                usize::from(conflict_scan == 0)
            );
            if conflict_scan == 0 {
                assert!(matches!(result, Err(ProbeError::StatusPipe(_))));
            } else {
                assert!(matches!(result, Err(ProbeError::InstanceConflict { .. })));
            }
        }
    }

    #[test]
    fn concurrent_codlet_launch_attempts_start_only_one_child() {
        let mutex_name = OsString::from(format!(r"Local\Codlet.ProbeLaunchTest.{}", marker_id()));
        let executable = Arc::new(PathBuf::from(
            r"C:\Program Files\WindowsApps\Codex\ChatGPT.exe",
        ));
        let running = Arc::new(AtomicBool::new(false));
        let launches = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(3));
        let attempts: Vec<_> = (0..2)
            .map(|_| {
                let mutex_name = mutex_name.clone();
                let executable = Arc::clone(&executable);
                let running = Arc::clone(&running);
                let launches = Arc::clone(&launches);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    let _guard =
                        LaunchMutexGuard::acquire_named(&mutex_name, Duration::from_secs(2))?;
                    let scan = || {
                        Ok(if running.load(Ordering::SeqCst) {
                            vec![RunningProcess {
                                process_id: 4400,
                                executable: (*executable).clone(),
                            }]
                        } else {
                            Vec::new()
                        })
                    };
                    checked_launch(&executable, scan()?, scan, || {
                        launches.fetch_add(1, Ordering::SeqCst);
                        running.store(true, Ordering::SeqCst);
                        Ok(())
                    })
                })
            })
            .collect();
        barrier.wait();

        let results: Vec<_> = attempts
            .into_iter()
            .map(|attempt| attempt.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(ProbeError::InstanceConflict { .. })))
                .count(),
            1
        );
        assert_eq!(launches.load(Ordering::SeqCst), 1);
    }
}
