use super::application::Application;
use super::control_pipe::{RegistryScope, query_execution_inspection};
use crate::catalog::PluginCatalog;
use crate::diagnostics::{
    Check, DiagnosticIssue, DoctorInputs, DoctorReport, DoctorRuntimeInput, PackageInfo,
    ProcessInfo, ProcessSnapshot,
};
use crate::plugins::{PluginRegistry, bundled_plugins, default_registry_path};
use crate::runtime_control::ControlStatus;
use std::ffi::{OsStr, OsString};
use std::path::Path;
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const USAGE: &str = "Use codlet launch [--app /Applications/ChatGPT.app] [--watch | --safe-mode], doctor [--json], status [--json], diagnostics --output <absolute.zip> [--json], or plugin <command>";

pub fn run(arguments: impl Iterator<Item = OsString>) -> Result<()> {
    let arguments = arguments.collect::<Vec<_>>();
    match arguments.as_slice() {
        [command] if command == "__codlet_process_owner" => Ok(super::process_owner::run()?),
        [command, ..] if command == "plugin" => Ok(crate::plugin_commands::run(&arguments)?),
        [command, options @ ..] if command == "launch" => {
            let mut options = options.iter();
            let mut app = None;
            let mut watch = false;
            let mut safe = false;
            while let Some(option) = options.next() {
                match option.to_str() {
                    Some("--app") if app.is_none() => app = Some(options.next().ok_or(USAGE)?),
                    Some("--watch") if !watch && !safe => watch = true,
                    Some("--safe-mode") if !safe && !watch => safe = true,
                    _ => return Err(USAGE.into()),
                }
            }
            let app = if let Some(path) = app {
                Application::inspect(Path::new(path))?
            } else {
                Application::discover()?
            };
            super::runtime::launch(app, watch, safe)
        }
        [command, options @ ..] if command == "doctor" => {
            let json = json_option(options)?;
            let report = doctor();
            if json {
                println!("{}", serde_json::to_string(&report)?);
            } else {
                println!("{}", report.to_human_readable());
            }
            if report.result.exit_code == 0 {
                Ok(())
            } else {
                Err("Doctor found failed checks; see the report".into())
            }
        }
        [command, options @ ..] if command == "status" => {
            let json = json_option(options)?;
            let report =
                query_execution_inspection(&RegistryScope::for_path(&default_registry_path()?)?);
            if json {
                println!("{}", serde_json::to_string(&report)?);
            } else {
                println!("{}", serde_json::to_string_pretty(&report)?);
            }
            if matches!(
                report.status,
                ControlStatus::Inspected | ControlStatus::NotRunning
            ) {
                Ok(())
            } else {
                Err("Runtime status was not verified".into())
            }
        }
        [command, flag, output, options @ ..] if command == "diagnostics" && flag == "--output" => {
            json_option(options)?;
            crate::diagnostic_bundle::validate_output(Path::new(output))?;
            let receipt = crate::diagnostic_bundle::export(Path::new(output), &doctor())?;
            println!("{}", serde_json::to_string(&receipt)?);
            Ok(())
        }
        [command] if command == "--version" => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        [command] if command == "--help" => {
            println!("{USAGE}");
            Ok(())
        }
        _ => Err(USAGE.into()),
    }
}
fn json_option(options: &[OsString]) -> Result<bool> {
    match options {
        [] => Ok(false),
        [option] if option == OsStr::new("--json") => Ok(true),
        _ => Err(USAGE.into()),
    }
}

fn doctor() -> DoctorReport {
    let discovered = Application::discover();
    let (package, executable, processes) = match discovered {
        Ok(app) => {
            let processes = match app.running() {
                Ok(processes) => {
                    let mut snapshot = ProcessSnapshot::new(
                        processes
                            .into_iter()
                            .map(|p| ProcessInfo {
                                process_id: p.pid,
                                executable: p.executable.to_string_lossy().into_owned(),
                            })
                            .collect(),
                    );
                    snapshot.match_basis = "kernel_image_path_and_application_bundle_identifier";
                    Check::ok(snapshot)
                }
                Err(e) => Check::Failed {
                    error: DiagnosticIssue::new(
                        "process_snapshot_failed",
                        e.to_string(),
                        "Retry after checking access to the current user's application processes",
                    ),
                },
            };
            (
                Check::ok(PackageInfo {
                    family_name: app.identifier.clone(),
                    full_name: format!("{} {} ({})", app.identifier, app.version, app.build),
                    version: app.version,
                    install_location: app.bundle.to_string_lossy().into_owned(),
                }),
                Check::ok(app.executable.to_string_lossy().into_owned()),
                processes,
            )
        }
        Err(e) => (
            Check::Failed {
                error: DiagnosticIssue::new(
                    "application_discovery_failed",
                    e.to_string(),
                    "Install the official ARM64 application in Applications; modified or unsigned copies are refused",
                ),
            },
            Check::Unavailable {
                reason: "No verified application executable",
            },
            Check::Unavailable {
                reason: "No verified application for process matching",
            },
        ),
    };
    let (path, registry) = match default_registry_path() {
        Ok(path) => (Some(path.clone()), PluginRegistry::load(path)),
        Err(e) => (None, Err(e)),
    };
    let catalog = match &registry {
        Ok(registry) => PluginCatalog::load(registry),
        Err(_) => bundled_plugins().map(PluginCatalog::from_bundled),
    };
    let runtime = path
        .as_ref()
        .map(|path| match RegistryScope::for_path(path) {
            Ok(scope) => {
                let mut report = query_execution_inspection(&scope);
                let queried_at_unix_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                match (
                    report.status,
                    report.inspection.take(),
                    report.host_inspection.take(),
                ) {
                    (ControlStatus::Inspected, Some(inspection), Some(hosts)) => {
                        DoctorRuntimeInput::ExecutionInspected {
                            inspection: Box::new(inspection),
                            hosts: Box::new(hosts),
                            queried_at_unix_ms,
                        }
                    }
                    (ControlStatus::Inspected, Some(inspection), None) => {
                        DoctorRuntimeInput::Inspected {
                            inspection: Box::new(inspection),
                            queried_at_unix_ms,
                        }
                    }
                    (ControlStatus::NotRunning, _, _) => DoctorRuntimeInput::NotRunning,
                    _ => DoctorRuntimeInput::Unavailable {
                        code: "runtime_unavailable",
                        message: report
                            .error
                            .unwrap_or_else(|| "Runtime identity was not verified".into()),
                    },
                }
            }
            Err(e) => DoctorRuntimeInput::Unavailable {
                code: "runtime_scope",
                message: e.to_string(),
            },
        })
        .unwrap_or(DoctorRuntimeInput::NotProbed);
    DoctorReport::from_inputs(DoctorInputs {
        package,
        executable,
        processes,
        registry_path: path,
        registry,
        catalog,
    })
    .with_runtime(runtime)
}
