//! Explicit experimental launcher. Normal `codlet launch` never calls this module.
use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf, Prefix};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use thiserror::Error;
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
};

use crate::cdp::{CdpClient, TargetChange, TargetController, TargetSession};
use crate::plugins::PluginRegistry;
use crate::renderer::RendererRuntime;
use crate::windows::environment::{ChildEnvironment, EnvironmentError};
use crate::windows::packages::{
    CODEX_EXECUTABLE_RELATIVE_PATH, CODEX_PACKAGE_FAMILY, InstalledPackage,
    find_unique_current_user_package, resolve_package_executable,
};
use crate::windows::process::{ChildProcess, launch_with_cdp_pipes_in_environment};

mod input;
mod runtime_seed;
mod shell;
mod shutdown;
mod startup;
use input::{ControlInput, InputEvent};
use shutdown::QuitState;
use startup::StartupCheck;

const DISCOVERY_BUDGET: Duration = Duration::from_secs(15);
const WAIT_SLICE: Duration = Duration::from_millis(50);
const EXPERIMENT_FLAG: &str = "--experimental-isolated-client";
const LAB_SHELL: &str = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
const AUDITED_PACKAGE_VERSION: &str = "26.901.6511.0";
const CODEX_CONFIG: &[u8] = b"cli_auth_credentials_store = \"file\"\n";
const CODLET_CONFIG: &[u8] = b"{\"schema\":2,\"plugins\":{},\"localPlugins\":{}}\n";

#[derive(Debug, Error)]
pub enum LabError {
    #[error(
        "use `codlet-lab --experimental-isolated-client --root <empty-or-new-absolute-directory> --expected-package-version 26.901.6511.0 --app-server-url ws://127.0.0.1:<port> [--startup-trace]`; then stdin start or quit"
    )]
    Usage,
    #[error("preflightBlocked: {0}")]
    Preflight(String),
    #[error("isolated client IO: {0}")]
    Io(#[from] io::Error),
    #[error(transparent)]
    Environment(#[from] EnvironmentError),
    #[error("isolated client runtime: {0}")]
    Runtime(String),
}

#[derive(Debug)]
struct LabOptions {
    root: PathBuf,
    expected_version: String,
    app_server_url: Option<String>,
    startup_trace: bool,
}

impl LabOptions {
    fn parse(arguments: impl Iterator<Item = OsString>) -> Result<Self, LabError> {
        let arguments: Vec<_> = arguments.collect();
        let [flag, root_flag, root, version_flag, version, extra @ ..] = arguments.as_slice()
        else {
            return Err(LabError::Usage);
        };
        if flag != OsStr::new(EXPERIMENT_FLAG)
            || root_flag != OsStr::new("--root")
            || version_flag != OsStr::new("--expected-package-version")
        {
            return Err(LabError::Usage);
        }
        let version = version.to_str().ok_or(LabError::Usage)?;
        let pieces: Vec<_> = version.split('.').collect();
        if pieces.len() != 4
            || pieces.iter().any(|piece| {
                piece.parse::<u16>().is_err() || piece.parse::<u16>().unwrap().to_string() != *piece
            })
        {
            return Err(LabError::Usage);
        }
        validate_root_path(Path::new(root))?;
        let (extra, startup_trace) = if extra
            .last()
            .is_some_and(|argument| argument == OsStr::new("--startup-trace"))
        {
            (&extra[..extra.len() - 1], true)
        } else {
            (extra, false)
        };
        if startup_trace
            && root.to_str().is_none_or(|root| {
                !root.is_ascii()
                    || root
                        .chars()
                        .any(|character| character.is_ascii_whitespace() || character == '\'')
            })
        {
            return Err(LabError::Preflight("startup profiling requires an ASCII root without whitespace or quotes for V8's flag parser".into()));
        }
        let app_server_url = match extra {
            [] => None,
            [flag, url] if flag == OsStr::new("--app-server-url") => {
                Some(validate_loopback_url(url)?)
            }
            [argument]
                if argument
                    .to_str()
                    .is_some_and(|text| text.starts_with("--app-server-url=")) =>
            {
                Some(validate_loopback_url(OsStr::new(
                    &argument.to_str().unwrap()[17..],
                ))?)
            }
            _ => return Err(LabError::Usage),
        };
        Ok(Self {
            root: PathBuf::from(root),
            expected_version: version.to_owned(),
            app_server_url,
            startup_trace,
        })
    }
}

pub fn run_cli(arguments: impl Iterator<Item = OsString>) -> Result<(), LabError> {
    let options = LabOptions::parse(arguments)?;
    // Read-only package/version/executable preflight precedes any lab file creation.
    let package = find_unique_current_user_package(CODEX_PACKAGE_FAMILY)
        .map_err(|error| LabError::Preflight(error.to_string()))?;
    check_package_version(&package, &options.expected_version)?;
    require_reviewed_ipc_isolation(&package, options.app_server_url.as_deref())?;
    let executable =
        resolve_package_executable(&package, Path::new(CODEX_EXECUTABLE_RELATIVE_PATH))
            .map_err(|error| LabError::Preflight(error.to_string()))?;
    let root = LabRoot::claim(&options.root)?;
    let mut reporter = Reporter::new(&root)?;
    let runtime_seed = runtime_seed::RuntimeSeed::prepare(
        &package.install_location.join("app/resources"),
        &root.path.join("home/AppData/Local"),
    )?;
    reporter.emit(
        "runtime_assets_prepared",
        json!({"runtime": runtime_seed, "child_created": false}),
    );
    let registry = PluginRegistry::load(root.path.join("codlet/config.json"))
        .map_err(|error| LabError::Preflight(error.to_string()))?;
    let renderer = RendererRuntime::bundled(registry)
        .map_err(|error| LabError::Preflight(error.to_string()))?;
    let environment = lab_environment(
        &root,
        options
            .app_server_url
            .as_deref()
            .expect("audited WS policy"),
    )?;
    let shell_check = shell::check(&environment, &root.path.join("project"))?;
    let environment_manifest = root.write_environment_manifest(&environment)?;
    reporter.write(
        "prepared",
        json!({
            "package_full_name": package.full_name, "package_version": package.version.to_string(),
            "executable": executable, "root": root.path,
            "experimental": true, "isolation_is_not_a_security_boundary": true,
            "gui_mount_verified": false,
            "control": "start after coordinator verifies the dedicated backend; quit cancels before start or requests the owned application's quit bridge afterward; EOF keeps Host alive",
            "shell": LAB_SHELL, "shell_profiles_checked_absent": shell_check.profiles_checked_absent,
            "shell_environment_probe": shell_check,
            "requested_app_server_url": options.app_server_url,
            "environment_manifest": environment_manifest,
            "codex_home": root.path.join("codex-home"),
            "sqlite_home": root.path.join("sqlite"),
            "project": root.path.join("project"),
            "user_data": root.path.join("user-data"),
            "backend_lifecycle_owner": "coordinator",
            "startup_trace": options.startup_trace,
            "startup_trace_path": options.startup_trace.then(|| root.path.join("logs/startup-trace.json"))
        }),
    )?;
    let mut input = ControlInput::new();
    if !wait_for_start(&mut input, &mut reporter) {
        return Ok(());
    }
    // start attests that the coordinator verified the supplied listener belongs to
    // its dedicated backend, created using this lab environment. No listener probe
    // or connection to another process is performed by the harness.
    let current_package = find_unique_current_user_package(CODEX_PACKAGE_FAMILY)
        .map_err(|error| LabError::Preflight(error.to_string()))?;
    check_package_version(&current_package, &options.expected_version)?;
    if current_package.full_name != package.full_name
        || current_package.install_location != package.install_location
    {
        return Err(LabError::Preflight(
            "package changed after prepared; no child was created".into(),
        ));
    }
    let config_guards = root.verify_configuration()?;
    runtime_seed.verify()?;
    let shell_check = shell::check(&environment, &root.path.join("project"))?;
    reporter.emit(
        "shell_preflight_verified",
        json!({"check": shell_check, "child_created": false}),
    );
    // This deliberately bypasses production process-conflict checks only in this
    // explicit lab binary. No existing process is opened, attached or changed.
    let child_arguments = startup_trace_arguments(&root.path, options.startup_trace);
    let (child, pipes) = launch_with_cdp_pipes_in_environment(
        &executable,
        &child_arguments,
        false,
        Some(&environment),
        Some(&root.path.join("project")),
    )
    .map_err(|error| {
        reporter.emit(
            "child_create_failed",
            json!({"error": error.to_string(), "child_created": false, "no_retry": true}),
        );
        LabError::Runtime(error.to_string())
    })?;
    drop(config_guards);
    reporter.child_pid = Some(child.process_id());
    let creation = child.creation_time_filetime();
    reporter.emit(
        "child_created",
        json!({
            "child_pid": child.process_id(),
            "creation_time_windows_100ns": creation.as_ref().ok(),
            "identity_error": creation.as_ref().err().map(ToString::to_string),
            "executable": executable, "package_full_name": package.full_name
        }),
    );
    let client = match CdpClient::spawn(pipes) {
        Ok((client, events)) => {
            reporter.emit(
                "cdp_transport_open",
                json!({"protocol_response_verified": false}),
            );
            Some((client, events))
        }
        Err(error) => {
            reporter.emit(
                "cdp_unavailable",
                json!({"error": error.to_string(), "residual_child_possible": true}),
            );
            None
        }
    };
    let startup = StartupCheck::new(
        root.path.join("home/AppData/Local/Codex/Logs"),
        child.process_id(),
    );
    hold_lab_child(
        child,
        client,
        renderer,
        input,
        startup,
        options.startup_trace,
        &mut reporter,
    )
}

fn wait_for_start(input: &mut ControlInput, reporter: &mut Reporter) -> bool {
    reporter.emit(
        "awaiting_start",
        json!({"stdin_control_available": input.is_open(), "child_created": false}),
    );
    loop {
        let mut events = input.poll().into_iter();
        while let Some(event) = events.next() {
            match event {
                InputEvent::Start => {
                    input.defer(events.collect());
                    reporter.emit(
                        "start_requested",
                        json!({"coordinator_attested_backend_owner": true, "child_created": false}),
                    );
                    return true;
                }
                InputEvent::Quit => {
                    reporter.emit("cancelled_before_start", json!({"child_created": false}));
                    return false;
                }
                InputEvent::Invalid => {
                    reporter.emit("invalid_control", json!({"accepted": ["start", "quit"]}))
                }
                InputEvent::Eof => reporter.emit(
                    "control_eof",
                    json!({"awaiting_start": true, "child_created": false}),
                ),
                InputEvent::Error(error) => reporter.emit(
                    "control_unavailable",
                    json!({"error": error, "awaiting_start": true, "child_created": false}),
                ),
            }
        }
        std::thread::sleep(WAIT_SLICE);
    }
}

fn validate_loopback_url(value: &OsStr) -> Result<String, LabError> {
    let url = value.to_str().ok_or(LabError::Usage)?;
    let port = url.strip_prefix("ws://127.0.0.1:").ok_or_else(|| {
        LabError::Preflight(
            "app-server URL must be ws://127.0.0.1:<port> with no path, credentials or query"
                .into(),
        )
    })?;
    if port.parse::<u16>().ok().filter(|port| *port != 0).is_none()
        || !port.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(LabError::Preflight(
            "app-server URL has an invalid port".into(),
        ));
    }
    Ok(url.to_owned())
}

fn require_absent_profiles(profiles: &[PathBuf]) -> Result<(), LabError> {
    if profiles.len() != 4 || profiles.iter().any(|path| !path.is_absolute()) {
        return Err(LabError::Preflight(
            "expected four absolute WindowsPowerShell profile paths".into(),
        ));
    }
    for profile in profiles {
        match fs::symlink_metadata(profile) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
            Ok(_) => {
                return Err(LabError::Preflight(format!(
                    "shell profile exists and could restore production settings: {}",
                    profile.display()
                )));
            }
        }
    }
    Ok(())
}

fn startup_trace_arguments(root: &Path, enabled: bool) -> Vec<OsString> {
    if !enabled {
        return Vec::new();
    }
    // Chromium's per-browser controller writes only this fresh root's diagnostic file.
    // No network tracing, upload destination, external inspector or caller-supplied flags.
    vec![
        "--trace-startup=-*,toplevel,v8,disabled-by-default-v8.cpu_profiler".into(),
        "--trace-startup-duration=6".into(),
        "--trace-startup-format=json".into(),
        "--trace-startup-owner=controller".into(),
        format!(
            "--js-flags=--prof --no-log-source-code --logfile={}",
            root.join("logs/v8.log").display()
        )
        .into(),
        format!(
            "--trace-startup-file={}",
            root.join("logs/startup-trace.json").display()
        )
        .into(),
    ]
}

fn check_package_version(package: &InstalledPackage, expected: &str) -> Result<(), LabError> {
    if package.version.to_string() != expected {
        return Err(LabError::Preflight(format!(
            "expected package version {expected}, found {}; no child was created",
            package.version
        )));
    }
    Ok(())
}

fn require_reviewed_ipc_isolation(
    package: &InstalledPackage,
    url: Option<&str>,
) -> Result<(), LabError> {
    if package.version.to_string() != AUDITED_PACKAGE_VERSION || url.is_none() {
        return Err(LabError::Preflight(format!(
            "default stdio is blocked: package {} needs the reviewed {} Dev strategy and a dedicated loopback WS app-server; separate directories do not isolate the production codex-ipc router; no lab files or child were created",
            package.version, AUDITED_PACKAGE_VERSION
        )));
    }
    validate_loopback_url(OsStr::new(url.unwrap()))?;
    Ok(())
}

fn hold_lab_child(
    child: ChildProcess,
    connection: Option<(CdpClient, crate::cdp::CdpEventStream)>,
    mut renderer: RendererRuntime,
    mut input: ControlInput,
    mut startup: StartupCheck,
    startup_trace: bool,
    reporter: &mut Reporter,
) -> Result<(), LabError> {
    let mut sessions = BTreeMap::new();
    let (client, mut targets) = if let Some((client, events)) = connection {
        let targets = match TargetController::discover(client.clone(), events, DISCOVERY_BUDGET) {
            Ok((targets, initial_sessions)) => {
                reporter.emit(
                    "cdp_connected",
                    json!({"initial_target_count": initial_sessions.len()}),
                );
                for session in initial_sessions {
                    sessions.insert(session.target_id().to_owned(), session);
                }
                Some(targets)
            }
            Err(error) => {
                reporter.emit("target_discovery_failed", json!({"error": error.to_string(), "child_retained": true, "gui_mount_verified": false}));
                None
            }
        };
        (Some(client), targets)
    } else {
        (None, None)
    };
    reporter.emit(
        "host_waiting",
        json!({"quit_available": client.is_some() && input.is_open(), "gui_mount_verified": false}),
    );
    let mut quit = QuitState::new();
    let mut startup_verified = false;
    let mut failure: Option<String> = None;
    let mut cdp_closed_reported = false;
    let mut renderer_pump_failed = false;
    let mut previous_renderer = None;
    loop {
        let exit = child.wait(Duration::ZERO).map_err(|error| {
            reporter.emit(
                "child_wait_failed",
                json!({"error": error.to_string(), "residual_child_possible": true}),
            );
            LabError::Runtime(error.to_string())
        })?;
        if let Some(exit_code) = exit {
            reporter.emit(
                "child_exited",
                json!({"exit_code": exit_code, "residual_child_possible": false}),
            );
            if let Some(client) = &client {
                match client.shutdown() {
                    Ok(()) => reporter.emit("cdp_workers_reaped", json!({})),
                    Err(error) => return Err(LabError::Runtime(error.to_string())),
                }
            }
            return if let Some(failure) = failure {
                Err(LabError::Runtime(failure))
            } else if exit_code == 0 {
                Ok(())
            } else {
                Err(LabError::Runtime(format!(
                    "own child exited with {exit_code}"
                )))
            };
        }
        for event in input.poll() {
            match event {
                InputEvent::Start => {
                    reporter.emit("already_started", json!({"no_second_child": true}))
                }
                InputEvent::Quit if !quit.requested() => {
                    request_own_child_quit(&mut quit, &sessions, "stdin", reporter);
                }
                InputEvent::Quit => {
                    reporter.emit("quit_already_requested", json!({"no_retry": true}))
                }
                InputEvent::Invalid => {
                    reporter.emit("invalid_control", json!({"accepted": "quit"}))
                }
                InputEvent::Eof => reporter.emit("control_eof", json!({"child_retained": true})),
                InputEvent::Error(error) => reporter.emit(
                    "control_unavailable",
                    json!({"error": error, "child_retained": true}),
                ),
            }
        }
        if let Some(client) = &client {
            if let Some(reason) = client.closed_reason() {
                if !cdp_closed_reported {
                    reporter.emit(
                        "cdp_closed",
                        json!({"reason": reason.to_string(), "child_retained": true}),
                    );
                    cdp_closed_reported = true;
                }
            } else if !quit.requested() {
                if let Some(controller) = targets.as_mut() {
                    match controller.pump(Duration::ZERO) {
                        Ok(changes) => {
                            for change in changes {
                                let target_id = change.target_id().to_owned();
                                update_sessions(&mut sessions, &change);
                                if startup_verified
                                    && let Err(error) = renderer.apply_target_change(change)
                                {
                                    reporter.emit(
                                        "target_change_failed",
                                        json!({"target_id": target_id, "error": error.to_string()}),
                                    );
                                }
                            }
                        }
                        Err(error) => {
                            reporter.emit(
                                "target_pump_failed",
                                json!({"error": error.to_string(), "child_retained": true}),
                            );
                            targets = None;
                        }
                    }
                }
                if startup_verified
                    && !renderer_pump_failed
                    && let Err(error) = renderer.pump_bindings()
                {
                    renderer_pump_failed = true;
                    reporter.emit(
                        "renderer_pump_failed",
                        json!({"error": error.to_string(), "child_retained": true}),
                    );
                }
            }
        }
        if !quit.requested() && !startup_verified {
            match startup.poll() {
                Ok(true) => {
                    startup_verified = true;
                    reporter.emit("startup_verified", json!({"evidence": startup.evidence, "elapsed_ms": startup.elapsed_ms(), "gui_mount_verified": false}));
                    for session in sessions.values().filter(|session| session.is_live()) {
                        match renderer.attach(session) {
                            Ok(report) => reporter.emit("renderer_attached", json!({"target_id": report.target_id, "plugin_count": report.plugin_count, "gui_mount_verified": false})),
                            Err(error) => reporter.emit("renderer_attach_failed", json!({"target_id": session.target_id(), "error": error.to_string(), "child_retained": true})),
                        }
                    }
                }
                Ok(false) => {}
                Err(reason) => {
                    failure = Some(format!("startup verification failed: {reason}"));
                    reporter.emit("startup_failed", json!({"reason": reason, "elapsed_ms": startup.elapsed_ms(), "renderer_plugins_loaded": false}));
                    request_own_child_quit(&mut quit, &sessions, "startup_failed", reporter);
                }
            }
        }
        if startup_trace && !quit.requested() && startup.elapsed_ms() >= 12000 {
            request_own_child_quit(&mut quit, &sessions, "startup_trace_complete", reporter);
        }
        if quit.take_timeout() {
            failure.get_or_insert_with(|| {
                "own client did not exit within the 15-second quit budget".into()
            });
            reporter.emit("quit_timed_out", json!({"budget_ms": 15000, "residual_child_possible": true, "child_retained": true, "no_retry": true}));
        }
        let snapshot = renderer.status_snapshot();
        if previous_renderer.as_ref() != Some(&snapshot) {
            reporter.emit(
                "renderer_snapshot",
                json!({"renderer": snapshot, "gui_mount_verified": false}),
            );
            previous_renderer = Some(snapshot);
        }
        for diagnostic in renderer.take_diagnostics() {
            reporter.emit("renderer_diagnostic", json!({"target_id": diagnostic.target_id, "plugin_id": diagnostic.plugin_id, "error": diagnostic.message}));
        }
        // The exact ChildProcess handle is the only process lifecycle authority.
        std::thread::sleep(WAIT_SLICE);
    }
}

fn update_sessions(sessions: &mut BTreeMap<String, TargetSession>, change: &TargetChange) {
    match change {
        TargetChange::Attached(session) => {
            sessions.insert(session.target_id().to_owned(), session.clone());
        }
        TargetChange::NavigatedAway(session) => {
            sessions.remove(session.target_id());
        }
        TargetChange::SessionEnded {
            target_id,
            session_id,
        } => {
            if sessions
                .get(target_id)
                .is_some_and(|session| session.session_id() == session_id)
            {
                sessions.remove(target_id);
            }
        }
    }
}

fn request_own_child_quit(
    quit: &mut QuitState,
    sessions: &BTreeMap<String, TargetSession>,
    reason: &str,
    reporter: &mut Reporter,
) {
    if !quit.begin() {
        return;
    }
    reporter.emit(
        "quit_requested",
        json!({"method": "electronBridge.quit-app", "reason": reason}),
    );
    let Some(session) = sessions.values().find(|session| session.is_live()) else {
        reporter.emit("quit_unavailable", json!({"reason": "no_live_audited_main_document", "child_retained": true, "no_retry": true}));
        return;
    };
    match shutdown::request(session) {
        Ok(()) => reporter.emit(
            "quit_sent",
            json!({"method": "electronBridge.quit-app", "waiting_for_own_child_exit": true}),
        ),
        Err(error) => reporter.emit(
            "quit_response_unavailable",
            json!({"error": error, "waiting_for_own_child_exit": true, "no_retry": true}),
        ),
    }
}

struct LabRoot {
    path: PathBuf,
    _pins: Vec<File>,
    _claim: File,
}

impl LabRoot {
    fn claim(path: &Path) -> Result<Self, LabError> {
        validate_root_path(path)?;
        let mut pins = Vec::new();
        let mut current = PathBuf::new();
        let components: Vec<_> = path.components().collect();
        for (index, component) in components.iter().enumerate() {
            current.push(component.as_os_str());
            if matches!(component, Component::Prefix(_)) {
                continue;
            }
            if index + 1 == components.len() && !current.try_exists()? {
                fs::create_dir(&current)?;
            }
            pins.push(pin_plain_directory(&current)?);
        }
        if fs::read_dir(path)?.next().is_some() {
            return Err(LabError::Preflight(format!(
                "lab root must be empty/new and is never reused: {}",
                path.display()
            )));
        }
        let mut claim = new_file(&path.join(".codlet-lab-owner.json"))?;
        writeln!(
            claim,
            "{}",
            json!({"schema_version":1,"host_pid":std::process::id(),"experimental":true})
        )?;
        claim.sync_all()?;
        let mut root = Self {
            path: path.to_owned(),
            _pins: pins,
            _claim: claim,
        };
        for directory in [
            "user-data",
            "codex-home",
            "sqlite",
            "codlet",
            "project",
            "logs",
            "home",
            // Windows KnownFolder resolution otherwise yields an empty Documents
            // path for a redirected, newly created profile, including $PROFILE.
            "home/Documents",
            "home/AppData",
            "home/AppData/Roaming",
            "home/AppData/Local",
            "home/AppData/Local/Codex",
            "home/AppData/Local/Codex/Logs",
            "temp",
        ] {
            let directory = root.path.join(directory);
            fs::create_dir(&directory)?;
            root._pins.push(pin_plain_directory(&directory)?);
        }
        let mut config = new_file(&root.path.join("codlet/config.json"))?;
        config.write_all(CODLET_CONFIG)?;
        config.sync_all()?;
        // This fresh configuration intentionally contains no auth/session/account material.
        let mut config = new_file(&root.path.join("codex-home/config.toml"))?;
        config.write_all(CODEX_CONFIG)?;
        config.sync_all()?;
        Ok(root)
    }

    fn write_environment_manifest(
        &self,
        environment: &ChildEnvironment,
    ) -> Result<PathBuf, LabError> {
        let entries = environment
            .entries_os()
            .into_iter()
            .map(|(name, value)| {
                Ok((
                    name.into_string().map_err(|_| {
                        LabError::Preflight("environment name is not Unicode".into())
                    })?,
                    value.into_string().map_err(|_| {
                        LabError::Preflight("environment value is not Unicode".into())
                    })?,
                ))
            })
            .collect::<Result<std::collections::BTreeMap<_, _>, LabError>>()?;
        let path = self.path.join("logs/child-environment.json");
        let mut file = new_file(&path)?;
        serde_json::to_writer_pretty(&mut file, &entries).map_err(io::Error::other)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        Ok(path)
    }

    fn verify_configuration(&self) -> Result<Vec<File>, LabError> {
        let mut guards = Vec::new();
        for (relative, expected) in [
            ("codex-home/config.toml", CODEX_CONFIG),
            ("codlet/config.json", CODLET_CONFIG),
        ] {
            let path = self.path.join(relative);
            let mut file = OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&path)?;
            let metadata = file.metadata()?;
            if !metadata.is_file()
                || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
                || metadata.len() != expected.len() as u64
            {
                return Err(LabError::Preflight(format!(
                    "lab configuration changed before start: {}",
                    path.display()
                )));
            }
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)?;
            if bytes != expected {
                return Err(LabError::Preflight(format!(
                    "lab configuration changed before start: {}",
                    path.display()
                )));
            }
            guards.push(file);
        }
        match fs::symlink_metadata(self.path.join("codex-home/auth.json")) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
            Ok(_) => {
                return Err(LabError::Preflight(
                    "auth.json exists; this is a fresh unlogged experiment only".into(),
                ));
            }
        }
        Ok(guards)
    }
}

fn validate_root_path(path: &Path) -> Result<(), LabError> {
    let rejected = || {
        LabError::Preflight("root must be an absolute Unicode local drive directory without links, aliases, dot/parent components or device names".to_owned())
    };
    let text = path.to_str().ok_or_else(rejected)?;
    if !path.is_absolute()
        || !matches!(path.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_)))
    {
        return Err(rejected());
    }
    let pieces: Vec<_> = text[3..].split(['/', '\\']).collect();
    if pieces.is_empty()
        || pieces.iter().any(|piece| {
            let stem = piece.split('.').next().unwrap_or("").to_ascii_lowercase();
            piece.is_empty()
                || matches!(*piece, "." | "..")
                || piece.ends_with(['.', ' '])
                || piece
                    .chars()
                    .any(|character| character.is_control() || "<>:\"|?*".contains(character))
                || matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
                || (stem.starts_with("com") || stem.starts_with("lpt"))
                    && stem.len() == 4
                    && stem.as_bytes()[3].is_ascii_digit()
        })
    {
        return Err(rejected());
    }
    Ok(())
}

fn pin_plain_directory(path: &Path) -> Result<File, LabError> {
    let pin = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let metadata = pin.metadata()?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(LabError::Preflight(format!(
            "directory is linked/reparsed or not a directory: {}",
            path.display()
        )));
    }
    Ok(pin)
}

fn new_file(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

fn lab_environment(root: &LabRoot, app_server_url: &str) -> Result<ChildEnvironment, LabError> {
    validate_loopback_url(OsStr::new(app_server_url))?;
    // Build from zero. No credential/proxy/bridge variables are retained or
    // backed up in the child manifest, even temporarily as a policy fallback.
    let mut environment =
        ChildEnvironment::from_entries(std::env::vars_os().filter(|(name, _)| {
            let upper = name.to_string_lossy().to_ascii_uppercase();
            matches!(
                upper.as_str(),
                "SYSTEMROOT"
                    | "WINDIR"
                    | "SYSTEMDRIVE"
                    | "COMSPEC"
                    | "PATH"
                    | "PATHEXT"
                    | "OS"
                    | "PROCESSOR_ARCHITECTURE"
                    | "PROCESSOR_ARCHITEW6432"
                    | "PROCESSOR_IDENTIFIER"
                    | "PROCESSOR_LEVEL"
                    | "PROCESSOR_REVISION"
                    | "NUMBER_OF_PROCESSORS"
                    | "USERNAME"
                    | "USERDOMAIN"
                    | "USERDNSDOMAIN"
                    | "PROGRAMFILES"
                    | "PROGRAMFILES(X86)"
                    | "PROGRAMW6432"
                    | "COMMONPROGRAMFILES"
                    | "COMMONPROGRAMFILES(X86)"
                    | "COMMONPROGRAMW6432"
            )
        }))?;
    for (name, relative) in [
        ("CODEX_ELECTRON_USER_DATA_PATH", "user-data"),
        ("CODEX_HOME", "codex-home"),
        ("CODEX_SQLITE_HOME", "sqlite"),
        ("USERPROFILE", "home"),
        ("HOME", "home"),
        ("APPDATA", "home/AppData/Roaming"),
        ("LOCALAPPDATA", "home/AppData/Local"),
        ("TEMP", "temp"),
        ("TMP", "temp"),
    ] {
        environment.set(OsStr::new(name), root.path.join(relative).as_os_str())?;
    }
    environment.set(OsStr::new("SHELL"), OsStr::new(LAB_SHELL))?;
    environment.set(
        OsStr::new("PSModulePath"),
        OsStr::new(shell::SYSTEM_MODULES),
    )?;
    environment.set(
        OsStr::new("CODEX_APP_SERVER_WS_URL"),
        OsStr::new(app_server_url),
    )?;
    environment.set(OsStr::new("BUILD_FLAVOR"), OsStr::new("dev"))?;
    environment.set(OsStr::new("CODEX_SPARKLE_ENABLED"), OsStr::new("false"))?;
    environment.set(
        OsStr::new("CODEX_ELECTRON_PRIMARY_RUNTIME_UPDATE_MODE"),
        OsStr::new("manual"),
    )?;
    environment.set(
        OsStr::new("CODEX_ELECTRON_DESKTOP_FEATURE_OVERRIDES"),
        OsStr::new(&restricted_features().to_string()),
    )?;
    Ok(environment)
}

fn restricted_features() -> Value {
    json!({
        "externalBrowserUseAllowed": false, "externalBrowserUse": false,
        "inAppBrowserUseAllowed": false, "inAppBrowserUse": false,
        "browserExtensions": false, "browserSettingsCloudSync": false,
        "browserPane": false, "computerUse": false, "computerUseAutoInstall": false,
        "computerUseNodeRepl": false, "browserUseTinysky": false, "cuaPIP": false,
        "appshotsEnabled": false, "quickChat": false, "sites": false,
        "autoAuthForSites": false, "control": false, "skysight": false,
        "messages": false, "codexLocalAccess": false, "workCloudAccess": false,
        "workLocalAccess": false, "ambientSuggestions": false,
        "ambientSuggestionsFeatureDiscovery": false, "artifactSession": false,
        "recordAndReplay": false
    })
}

struct Reporter {
    file: File,
    child_pid: Option<u32>,
}
impl Reporter {
    fn new(root: &LabRoot) -> io::Result<Self> {
        Ok(Self {
            file: new_file(&root.path.join("logs/report.jsonl"))?,
            child_pid: None,
        })
    }
    fn write(&mut self, event: &str, detail: Value) -> io::Result<()> {
        let report = json!({
            "schema_version":1,"event":event,"host_pid":std::process::id(),
            "child_pid":self.child_pid,"sampled_at_unix_ms":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
            "detail":detail
        });
        let mut line = serde_json::to_vec(&report)?;
        line.push(b'\n');
        // stdout disappearance must not drop the child or its inherited CDP connection.
        let _ = io::stdout().write_all(&line);
        self.file.write_all(&line)?;
        self.file.flush()
    }
    fn emit(&mut self, event: &str, detail: Value) {
        if let Err(error) = self.write(event, detail) {
            eprintln!(
                "codlet-lab: report write failed; own child PID {:?}: {error}",
                self.child_pid
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windows::packages::PackageVersion;

    #[test]
    fn lab_root_is_fresh_plain_exclusive_and_contains_only_new_configuration() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("空实验 🙂");
        let root = LabRoot::claim(&path).unwrap();
        let registry = PluginRegistry::load(path.join("codlet/config.json")).unwrap();
        assert_eq!(
            RendererRuntime::bundled(registry).unwrap().plugin_count(),
            2
        );
        assert_eq!(
            fs::read_to_string(path.join("codex-home/config.toml")).unwrap(),
            "cli_auth_credentials_store = \"file\"\n"
        );
        assert!(!path.join("codex-home/auth.json").exists());
        assert!(LabRoot::claim(&path).is_err());
        assert!(fs::rename(&path, directory.path().join("moved")).is_err());
        let environment = lab_environment(&root, "ws://127.0.0.1:49233").unwrap();
        let block = String::from_utf16(&environment.block().unwrap()).unwrap();
        assert!(block.contains(&format!(
            "CODEX_HOME={}\0",
            path.join("codex-home").display()
        )));
        assert!(block.contains(&format!(
            "CODEX_ELECTRON_USER_DATA_PATH={}\0",
            path.join("user-data").display()
        )));
        assert!(!block.contains("OPENAI_API_KEY="));
        assert!(!block.contains("HTTP_PROXY="));
        assert!(!block.contains("CODEX_APP_TOOLS_PIPE_PATH="));
        assert!(!block.contains("CODEX_APP_SERVER_FORCE_CLI="));
        let manifest = root.write_environment_manifest(&environment).unwrap();
        let values: Value = serde_json::from_slice(&fs::read(manifest).unwrap()).unwrap();
        assert_eq!(values["CODEX_APP_SERVER_WS_URL"], "ws://127.0.0.1:49233");
        assert_eq!(values["BUILD_FLAVOR"], "dev");
        assert_eq!(values["CODEX_SPARKLE_ENABLED"], "false");
        assert_eq!(
            values["CODEX_ELECTRON_PRIMARY_RUNTIME_UPDATE_MODE"],
            "manual"
        );
        let features: Value = serde_json::from_str(
            values["CODEX_ELECTRON_DESKTOP_FEATURE_OVERRIDES"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(features.as_object().unwrap().len(), 26);
        assert!(
            features
                .as_object()
                .unwrap()
                .values()
                .all(|value| *value == Value::Bool(false))
        );
        drop(root.verify_configuration().unwrap());
        fs::write(
            path.join("codex-home/state.sqlite"),
            b"fixture state created by backend",
        )
        .unwrap();
        drop(root.verify_configuration().unwrap());
        fs::write(path.join("codex-home/auth.json"), b"fixture authentication").unwrap();
        assert!(root.verify_configuration().is_err());
        drop(root);
        // Even after completion, evidence is retained and a used root cannot be reused.
        assert!(LabRoot::claim(&path).is_err());

        let occupied = directory.path().join("occupied");
        fs::create_dir(&occupied).unwrap();
        fs::write(occupied.join("keep.txt"), b"original").unwrap();
        assert!(LabRoot::claim(&occupied).is_err());
        assert_eq!(fs::read(occupied.join("keep.txt")).unwrap(), b"original");
        assert_eq!(fs::read_dir(&occupied).unwrap().count(), 1);
    }

    #[test]
    fn lab_root_rejects_reparse_parents_and_ambiguous_paths() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target");
        fs::create_dir(&target).unwrap();
        let link = directory.path().join("link");
        std::os::windows::fs::symlink_dir(&target, &link).unwrap();
        assert!(LabRoot::claim(&link).is_err());
        assert!(LabRoot::claim(&link.join("nested")).is_err());
        assert!(fs::read_dir(&target).unwrap().next().is_none());
        for path in [
            r"relative",
            r"C:\",
            r"C:relative",
            r"\\server\share\lab",
            r"\\?\C:\lab",
            r"C:\a\..\lab",
            r"C:\a\.\lab",
            r"C:\lab.",
            r"C:\lab ",
            r"C:\nul",
            r"C:\a\file:stream",
        ] {
            assert!(validate_root_path(Path::new(path)).is_err(), "{path}");
        }
    }

    #[test]
    fn exact_version_and_ipc_audit_preflight_refuse_before_any_launch() {
        let package = InstalledPackage {
            family_name: CODEX_PACKAGE_FAMILY.into(),
            full_name: "fixture".into(),
            install_location: PathBuf::from(r"C:\fixture"),
            version: PackageVersion {
                major: 26,
                minor: 901,
                build: 6511,
                revision: 0,
            },
        };
        assert!(check_package_version(&package, "26.901.6511.0").is_ok());
        assert!(check_package_version(&package, "26.901.6512.0").is_err());
        let error = require_reviewed_ipc_isolation(&package, None)
            .unwrap_err()
            .to_string();
        assert!(error.contains("preflightBlocked"));
        assert!(error.contains("codex-ipc"));
        require_reviewed_ipc_isolation(&package, Some("ws://127.0.0.1:49233")).unwrap();
    }

    #[test]
    fn lab_backend_url_is_literal_loopback_and_shell_profiles_must_be_absent() {
        assert_eq!(
            validate_loopback_url(OsStr::new("ws://127.0.0.1:49233")).unwrap(),
            "ws://127.0.0.1:49233"
        );
        for url in [
            "ws://localhost:123",
            "ws://127.0.0.1:0",
            "ws://127.0.0.1:65536",
            "ws://127.0.0.1:123/path",
            "ws://127.0.0.1:123?token=secret",
            "ws://name@127.0.0.1:123",
            "wss://127.0.0.1:123",
            "ws://192.168.0.1:123",
        ] {
            assert!(validate_loopback_url(OsStr::new(url)).is_err(), "{url}");
        }
        let directory = tempfile::tempdir().unwrap();
        let profiles: Vec<_> = (0..4)
            .map(|index| directory.path().join(format!("profile-{index}.ps1")))
            .collect();
        require_absent_profiles(&profiles).unwrap();
        fs::write(&profiles[2], "# fixture").unwrap();
        assert!(require_absent_profiles(&profiles).is_err());
    }

    #[test]
    fn startup_profiling_is_opt_in_and_cannot_choose_an_external_output_or_flags() {
        let base = [
            "--experimental-isolated-client",
            "--root",
            "C:/lab-trace",
            "--expected-package-version",
            "26.901.6511.0",
            "--app-server-url",
            "ws://127.0.0.1:49233",
        ];
        let parse = |extra: &[&str]| {
            LabOptions::parse(
                base.into_iter()
                    .chain(extra.iter().copied())
                    .map(OsString::from),
            )
        };
        assert!(!parse(&[]).unwrap().startup_trace);
        assert!(parse(&["--startup-trace"]).unwrap().startup_trace);
        for extra in [
            vec!["--startup-trace", "--startup-trace"],
            vec!["--trace-startup-file=C:/outside.json"],
            vec!["--js-flags=--expose-gc"],
        ] {
            assert!(parse(&extra).is_err());
        }
        assert!(startup_trace_arguments(Path::new("C:/lab-trace"), false).is_empty());
        let args = startup_trace_arguments(Path::new("C:/lab-trace"), true);
        assert!(
            args.iter()
                .any(|argument| argument.to_string_lossy().contains("--no-log-source-code"))
        );
        assert!(
            args.iter()
                .filter(|argument| argument.to_string_lossy().contains("file="))
                .all(|argument| argument.to_string_lossy().contains("C:/lab-trace"))
        );
    }

    #[test]
    fn prepared_requires_explicit_start_and_preserves_following_quit_input() {
        let directory = tempfile::tempdir().unwrap();
        let root = LabRoot::claim(&directory.path().join("start-fixture")).unwrap();
        let mut reporter = Reporter::new(&root).unwrap();
        let mut input = ControlInput::scripted(vec![
            InputEvent::Invalid,
            InputEvent::Start,
            InputEvent::Start,
            InputEvent::Quit,
        ]);
        assert!(wait_for_start(&mut input, &mut reporter));
        assert!(matches!(
            input.poll().as_slice(),
            [InputEvent::Start, InputEvent::Quit]
        ));
        let mut cancelled = ControlInput::scripted(vec![InputEvent::Quit]);
        assert!(!wait_for_start(&mut cancelled, &mut reporter));
        assert!(reporter.child_pid.is_none());
        let log = fs::read_to_string(root.path.join("logs/report.jsonl")).unwrap();
        assert!(log.contains("start_requested"));
        assert!(log.contains("cancelled_before_start"));
        assert!(!log.contains("child_created\":true"));
    }
}
