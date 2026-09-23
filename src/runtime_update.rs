//! Developer-configured Codlet updates. RPC callers choose actions, never URLs,
//! payload paths, process IDs or restart commands. All I/O runs on one worker.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

mod install;
#[cfg(all(test, target_os = "macos"))]
mod macos_tests;
mod package;
mod source;
pub(crate) use source::newer as newer_version;

pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_EXPANDED_BYTES: u64 = 1024 * 1024 * 1024;
pub const MAX_FILES: usize = 4096;
#[cfg(windows)]
pub const PLATFORM: &str = "win-x64";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub const PLATFORM: &str = "darwin-arm64";
#[cfg(not(any(windows, all(target_os = "macos", target_arch = "aarch64"))))]
pub const PLATFORM: &str = "unsupported";

#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
pub struct RuntimeUpdateError {
    pub code: String,
    pub message: String,
}
type Result<T> = std::result::Result<T, RuntimeUpdateError>;
fn error(code: &str, message: impl Into<String>) -> RuntimeUpdateError {
    RuntimeUpdateError {
        code: code.into(),
        message: message.into(),
    }
}
fn io_error(e: std::io::Error) -> RuntimeUpdateError {
    error("runtime_update_io", e.to_string())
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimePayloadProfile {
    Portable,
    IsolatedClient,
    MacApp,
}

/// Only a trusted launcher constructs this value; it is intentionally not an RPC
/// deserialization type. Exit zero means the launcher's readiness check succeeded.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRestartContext {
    pub profile: RuntimePayloadProfile,
    pub command: RuntimeRestartCommand,
    pub wait_for: Vec<RuntimeProcessIdentity>,
    pub launcher_files: Vec<PathBuf>,
    pub config_pin: Option<RuntimeConfigPin>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRestartCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub working_directory: PathBuf,
    pub environment: BTreeMap<String, String>,
    pub timeout_seconds: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProcessIdentity {
    pub pid: u32,
    /// Windows FILETIME, or Darwin kernel start seconds/microseconds packed into
    /// a decimal string. Never a JS Number.
    pub creation_time: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfigPin {
    pub path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeUpdateCandidate {
    pub id: String,
    pub version: String,
    pub platform: String,
    pub size: u64,
    pub sha256: String,
    pub release_url: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeUpdatePhase {
    Development,
    Idle,
    Checking,
    UpToDate,
    Available,
    Downloading,
    Downloaded,
    InstallRequested,
    Failed,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeUpdateStatus {
    pub current_version: String,
    pub phase: RuntimeUpdatePhase,
    pub configured: bool,
    pub channel: String,
    pub last_checked_at: Option<u64>,
    pub next_check_at: Option<u64>,
    pub candidate: Option<RuntimeUpdateCandidate>,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub install_available: bool,
    pub unavailable_reason: Option<String>,
    pub error: Option<RuntimeUpdateError>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInstallRequest {
    pub id: String,
    pub version: String,
    pub plan_path: PathBuf,
    pub plan_sha256: String,
    pub helper_path: PathBuf,
    pub node_path: PathBuf,
    pub handoff_ack_path: PathBuf,
    pub official_update: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeUpdateChannel {
    pub schema: u32,
    pub channel: String,
    #[serde(default = "default_interval")]
    pub check_interval_seconds: u64,
    pub source: Option<RuntimeUpdateSource>,
}
fn default_interval() -> u64 {
    900
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum RuntimeUpdateSource {
    #[serde(rename_all = "camelCase")]
    Github {
        repository_url: String,
        manifest_asset: String,
    },
    #[serde(rename_all = "camelCase")]
    Https {
        manifest_url: String,
        allowed_asset_origins: Vec<String>,
    },
}

#[derive(Clone)]
pub struct RuntimeUpdateService {
    sender: mpsc::Sender<Command>,
    shared: Arc<Mutex<State>>,
    default_check_interval_seconds: u64,
}
enum Command {
    Check,
    AutomaticCheck,
    Download,
    Install { official: bool },
    Reschedule,
}
struct State {
    status: RuntimeUpdateStatus,
    busy: bool,
    candidate: Option<source::Candidate>,
    staged: Option<package::StagedRuntime>,
    install_request: Option<RuntimeInstallRequest>,
    install_id: Option<String>,
    install_receipt: Option<(PathBuf, String)>,
    install_blocked: bool,
    settings_revision: u64,
    automatic_checks: bool,
    check_interval_seconds: u64,
}

impl RuntimeUpdateService {
    /// `install_root` comes from the running executable; `state_root` comes from
    /// the owner/registry. The only source is runtime/update-channel.json below
    /// that installation. Missing/null source is an offline development state.
    pub fn start(
        install_root: PathBuf,
        state_root: PathBuf,
        restart: Option<RuntimeRestartContext>,
    ) -> Result<Self> {
        Self::start_with_preferences(
            install_root,
            state_root,
            restart,
            crate::runtime_settings::SettingsDocument::default(),
        )
    }
    pub fn start_with_preferences(
        install_root: PathBuf,
        state_root: PathBuf,
        restart: Option<RuntimeRestartContext>,
        preferences: crate::runtime_settings::SettingsDocument,
    ) -> Result<Self> {
        preferences
            .values
            .validate()
            .map_err(|error| self::error(error.code, error.message))?;
        let install_root = package::canonical_directory(&install_root)?;
        let channel = read_channel(&install_root)?;
        let configured = channel.source.is_some();
        let automatic_checks = preferences.values.automatic_update_checks;
        let default_check_interval_seconds = channel.check_interval_seconds;
        let check_interval_seconds = preferences
            .values
            .update_check_interval_seconds
            .unwrap_or(default_check_interval_seconds);
        let mut unavailable_reason = restart
            .as_ref()
            .map(|_| ())
            .ok_or_else(|| "The launcher has not supplied a verified restart context.".to_owned())
            .err();
        if let Err(e) = install::ensure_same_volume(&install_root, &state_root) {
            unavailable_reason = Some(e.message);
        }
        let status = RuntimeUpdateStatus {
            current_version: CURRENT_VERSION.into(),
            phase: if configured && automatic_checks {
                RuntimeUpdatePhase::Checking
            } else if configured {
                RuntimeUpdatePhase::Idle
            } else {
                RuntimeUpdatePhase::Development
            },
            configured,
            channel: channel.channel.clone(),
            last_checked_at: None,
            next_check_at: (configured && automatic_checks).then_some(now_ms()),
            candidate: None,
            downloaded_bytes: 0,
            total_bytes: 0,
            install_available: restart.is_some() && unavailable_reason.is_none(),
            unavailable_reason,
            error: None,
        };
        let shared = Arc::new(Mutex::new(State {
            status,
            busy: configured,
            candidate: None,
            staged: None,
            install_request: None,
            install_id: None,
            install_receipt: None,
            install_blocked: false,
            settings_revision: preferences.revision,
            automatic_checks,
            check_interval_seconds,
        }));
        let (sender, receiver) = mpsc::channel();
        let worker_shared = shared.clone();
        std::thread::Builder::new()
            .name("codlet-runtime-update".into())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(e) => {
                        fail_state(
                            &worker_shared,
                            error("runtime_update_worker", e.to_string()),
                        );
                        return;
                    }
                };
                let client = match source::UpdateClient::new(&channel) {
                    Ok(client) => client,
                    Err(e) => {
                        fail_state(&worker_shared, e);
                        return;
                    }
                };
                let mut next =
                    (configured && automatic_checks).then_some(std::time::Instant::now());
                let mut failures = 0u32;
                if configured {
                    match package::restore_staged(
                        &state_root,
                        &channel,
                        restart.as_ref().map(|r| r.profile),
                    ) {
                        Ok(Some(staged)) => {
                            let mut state = worker_shared.lock().unwrap();
                            state.status.phase = RuntimeUpdatePhase::Downloaded;
                            state.status.downloaded_bytes = staged.candidate.size;
                            state.status.total_bytes = staged.candidate.size;
                            state.status.candidate = Some(staged.candidate.clone());
                            state.staged = Some(staged);
                            state.busy = false;
                            next = automatic_checks.then(|| {
                                std::time::Instant::now()
                                    + Duration::from_secs(check_interval_seconds)
                            });
                        }
                        Ok(None) => {
                            worker_shared.lock().unwrap().busy = false;
                        }
                        Err(e) => fail_state(&worker_shared, e),
                    }
                    restore_install_receipt(&worker_shared, &state_root);
                }
                loop {
                    let watching = worker_shared.lock().unwrap().install_receipt.is_some();
                    let timeout = if watching {
                        Some(Duration::from_secs(1))
                    } else {
                        next.map(|at| at.saturating_duration_since(std::time::Instant::now()))
                    };
                    let command = match timeout {
                        Some(wait) => match receiver.recv_timeout(wait) {
                            Ok(command) => command,
                            Err(mpsc::RecvTimeoutError::Timeout) => {
                                if watching {
                                    poll_install_receipt(&worker_shared);
                                    continue;
                                }
                                Command::AutomaticCheck
                            }
                            Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        },
                        None => match receiver.recv() {
                            Ok(command) => command,
                            Err(_) => break,
                        },
                    };
                    if matches!(command, Command::Reschedule) {
                        let mut state = worker_shared.lock().unwrap();
                        next = (configured && state.automatic_checks).then(|| {
                            std::time::Instant::now()
                                + Duration::from_secs(state.check_interval_seconds)
                        });
                        state.status.next_check_at =
                            next.map(|_| now_ms() + state.check_interval_seconds * 1000);
                        continue;
                    }
                    let checking = matches!(command, Command::Check | Command::AutomaticCheck);
                    if checking {
                        let mut state = worker_shared.lock().unwrap();
                        // A completed candidate stays fixed while awaiting a user
                        // install. No periodic check replaces it behind that click.
                        if !reserve_check(
                            &mut state,
                            configured,
                            matches!(command, Command::AutomaticCheck),
                        ) {
                            next = state.automatic_checks.then(|| {
                                std::time::Instant::now()
                                    + Duration::from_secs(state.check_interval_seconds)
                            });
                            state.status.next_check_at =
                                next.map(|_| now_ms() + state.check_interval_seconds * 1000);
                            continue;
                        }
                    }
                    let result = runtime.block_on(run_command(
                        command,
                        &client,
                        &channel,
                        &install_root,
                        &state_root,
                        restart.as_ref(),
                        &worker_shared,
                    ));
                    if let Err(e) = result {
                        failures = failures.saturating_add(1);
                        fail_state(&worker_shared, e);
                    } else if checking {
                        failures = 0;
                    }
                    if checking {
                        let mut state = worker_shared.lock().unwrap();
                        let delay = check_delay(state.check_interval_seconds, failures);
                        next = (configured && state.automatic_checks)
                            .then(|| std::time::Instant::now() + Duration::from_secs(delay));
                        state.status.next_check_at = next.map(|_| now_ms() + delay * 1000);
                    }
                    let snapshot = {
                        let mut state = worker_shared.lock().unwrap();
                        state.busy = false;
                        state.status.clone()
                    };
                    // No directory is created for an unconfigured development run.
                    if configured {
                        let _ = package::persist_status(&state_root, &snapshot);
                    }
                }
            })
            .map_err(|e| error("runtime_update_worker", e.to_string()))?;
        Ok(Self {
            sender,
            shared,
            default_check_interval_seconds,
        })
    }
    pub fn default_check_interval_seconds(&self) -> u64 {
        self.default_check_interval_seconds
    }
    pub fn configure_checks(
        &self,
        preferences: &crate::runtime_settings::SettingsDocument,
    ) -> Result<()> {
        preferences
            .values
            .validate()
            .map_err(|error| self::error(error.code, error.message))?;
        let mut state = self.shared.lock().unwrap();
        if preferences.revision < state.settings_revision {
            return Ok(());
        }
        let interval = preferences
            .values
            .update_check_interval_seconds
            .unwrap_or(self.default_check_interval_seconds);
        let automatic = preferences.values.automatic_update_checks;
        if state.settings_revision == preferences.revision
            && state.automatic_checks == automatic
            && state.check_interval_seconds == interval
        {
            return Ok(());
        }
        // Keep the last successfully applied revision if the worker has gone
        // away. A later read/retry must not turn an apply failure into success.
        // The worker takes this same lock before processing the queued change.
        self.sender.send(Command::Reschedule).map_err(|_| {
            error(
                "runtime_update_worker",
                "Runtime update worker is unavailable.",
            )
        })?;
        state.settings_revision = preferences.revision;
        state.automatic_checks = automatic;
        state.check_interval_seconds = interval;
        state.status.next_check_at =
            (state.status.configured && automatic).then(|| now_ms() + interval * 1000);
        Ok(())
    }
    pub fn status(&self) -> RuntimeUpdateStatus {
        self.shared.lock().unwrap().status.clone()
    }
    pub fn check(&self) -> Result<RuntimeUpdateStatus> {
        self.enqueue(Command::Check)
    }
    pub fn download(&self) -> Result<RuntimeUpdateStatus> {
        self.enqueue(Command::Download)
    }
    pub fn request_install(&self) -> Result<RuntimeUpdateStatus> {
        self.enqueue(Command::Install { official: false })
    }
    #[cfg(windows)]
    pub(crate) fn request_combined_install(&self) -> Result<RuntimeUpdateStatus> {
        self.enqueue(Command::Install { official: true })
    }
    /// The owner starts the returned checked helper command, then requests normal
    /// shutdown of only its processes. Returning a request never kills anything.
    pub fn take_install_request(&self) -> Option<RuntimeInstallRequest> {
        self.take_install_request_for(false)
    }
    pub(crate) fn take_install_request_for(&self, official: bool) -> Option<RuntimeInstallRequest> {
        let mut state = self.shared.lock().unwrap();
        if state
            .install_request
            .as_ref()
            .is_some_and(|r| r.official_update == official)
        {
            state.install_request.take()
        } else {
            None
        }
    }
    /// Only the owner reports a helper launch/ready failure. It retains the verified
    /// candidate and permits retry; a matching helper must not have been armed.
    pub fn install_handoff_failed(&self, id: &str, message: impl Into<String>) -> bool {
        let mut state = self.shared.lock().unwrap();
        if state.install_id.as_deref() != Some(id) {
            return false;
        }
        state.install_request = None;
        state.install_id = None;
        state.install_receipt = None;
        state.busy = false;
        state.status.phase = RuntimeUpdatePhase::Downloaded;
        state.status.error = Some(error(
            "runtime_update_handoff_failed",
            message.into().chars().take(4096).collect::<String>(),
        ));
        true
    }
    fn enqueue(&self, command: Command) -> Result<RuntimeUpdateStatus> {
        let mut state = self.shared.lock().unwrap();
        if state.install_blocked {
            return Err(error(
                "runtime_update_needs_attention",
                "The previous installation needs owner attention before another update can run.",
            ));
        }
        if state.busy {
            return Err(error(
                "runtime_update_busy",
                "A runtime update operation is already running.",
            ));
        }
        match command {
            Command::Reschedule | Command::AutomaticCheck => {
                unreachable!("internal worker command")
            }
            Command::Check => {
                if matches!(
                    state.status.phase,
                    RuntimeUpdatePhase::Downloaded | RuntimeUpdatePhase::InstallRequested
                ) {
                    return Ok(state.status.clone());
                }
                state.status.phase = if state.status.configured {
                    RuntimeUpdatePhase::Checking
                } else {
                    RuntimeUpdatePhase::Development
                };
            }
            Command::Download => {
                if !state.status.configured {
                    return Err(error(
                        "runtime_update_unconfigured",
                        "This development build has no configured release channel.",
                    ));
                }
                if state.staged.is_some() {
                    return Ok(state.status.clone());
                }
                if state.candidate.is_none() {
                    return Err(error(
                        "runtime_update_missing",
                        "Check for a released update first.",
                    ));
                }
                state.status.phase = RuntimeUpdatePhase::Downloading;
            }
            Command::Install { .. } => {
                if !state.status.install_available {
                    return Err(error(
                        "install_unavailable",
                        state.status.unavailable_reason.clone().unwrap_or_else(|| {
                            "The launcher has not supplied a verified restart context.".into()
                        }),
                    ));
                }
                if state.staged.is_none() {
                    return Err(error(
                        "runtime_update_not_downloaded",
                        "Download and verify a released update first.",
                    ));
                }
                if state.install_request.is_some()
                    || state.status.phase == RuntimeUpdatePhase::InstallRequested
                {
                    return Err(error(
                        "runtime_update_busy",
                        "An install handoff is already pending.",
                    ));
                }
                state.status.phase = RuntimeUpdatePhase::InstallRequested;
            }
        }
        state.busy = true;
        state.status.error = None;
        self.sender.send(command).map_err(|_| {
            state.busy = false;
            error(
                "runtime_update_worker",
                "Runtime update worker is unavailable.",
            )
        })?;
        Ok(state.status.clone())
    }
}

fn check_delay(interval: u64, failures: u32) -> u64 {
    interval
        .saturating_mul(1u64 << failures.min(5))
        .min(interval.max(21600))
}

fn reserve_check(state: &mut State, configured: bool, automatic: bool) -> bool {
    if automatic && (!state.automatic_checks || state.busy)
        || state.install_blocked
        || state.staged.is_some()
        || matches!(
            state.status.phase,
            RuntimeUpdatePhase::Downloading
                | RuntimeUpdatePhase::Downloaded
                | RuntimeUpdatePhase::InstallRequested
        )
    {
        // Do not release the busy flag of a manual command already in the queue.
        if !automatic {
            state.busy = false;
        }
        return false;
    }
    state.busy = true;
    state.status.phase = if configured {
        RuntimeUpdatePhase::Checking
    } else {
        RuntimeUpdatePhase::Development
    };
    true
}

fn fail_state(shared: &Arc<Mutex<State>>, e: RuntimeUpdateError) {
    let mut state = shared.lock().unwrap();
    state.status.phase = RuntimeUpdatePhase::Failed;
    state.status.error = Some(e);
    state.busy = false;
}

async fn run_command(
    command: Command,
    client: &source::UpdateClient,
    channel: &RuntimeUpdateChannel,
    install_root: &Path,
    state_root: &Path,
    restart: Option<&RuntimeRestartContext>,
    shared: &Arc<Mutex<State>>,
) -> Result<()> {
    match command {
        Command::Reschedule => unreachable!("rescheduling does not fetch or install"),
        Command::Check | Command::AutomaticCheck => {
            if channel.source.is_none() {
                let mut state = shared.lock().unwrap();
                state.status.phase = RuntimeUpdatePhase::Development;
                state.status.error = None;
                return Ok(());
            }
            let result = client.check(channel, restart.map(|r| r.profile)).await;
            shared.lock().unwrap().status.last_checked_at = Some(now_ms());
            let candidate = result?;
            let mut state = shared.lock().unwrap();
            state.status.phase = if candidate.is_some() {
                RuntimeUpdatePhase::Available
            } else {
                RuntimeUpdatePhase::UpToDate
            };
            state.status.total_bytes = candidate.as_ref().map_or(0, |c| c.public.size);
            state.status.downloaded_bytes = 0;
            state.status.candidate = candidate.as_ref().map(|c| c.public.clone());
            state.candidate = candidate;
            state.status.error = None;
        }
        Command::Download => {
            let candidate = shared.lock().unwrap().candidate.clone().ok_or_else(|| {
                error("runtime_update_missing", "No released update is selected.")
            })?;
            let staged = client
                .download(&candidate, state_root, |bytes| {
                    shared.lock().unwrap().status.downloaded_bytes = bytes
                })
                .await?;
            package::persist_staged(state_root, &staged, channel)?;
            let mut state = shared.lock().unwrap();
            state.staged = Some(staged);
            state.status.phase = RuntimeUpdatePhase::Downloaded;
            state.status.error = None;
        }
        Command::Install { official } => {
            let restart = restart.ok_or_else(|| {
                error(
                    "install_unavailable",
                    "The launcher has not supplied a verified restart context.",
                )
            })?;
            let staged = shared.lock().unwrap().staged.clone().ok_or_else(|| {
                error(
                    "runtime_update_not_downloaded",
                    "No verified update is staged.",
                )
            })?;
            let request = install::prepare_install_plan_with_official(
                install_root,
                state_root,
                &staged,
                restart,
                official,
            )?;
            let mut state = shared.lock().unwrap();
            state.install_id = Some(request.id.clone());
            state.install_receipt = Some((
                request
                    .plan_path
                    .parent()
                    .unwrap()
                    .join("install-receipt.json"),
                request.plan_sha256.clone(),
            ));
            state.install_request = Some(request);
            state.status.phase = RuntimeUpdatePhase::InstallRequested;
            state.status.error = None;
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperReceipt {
    schema: u32,
    id: String,
    plan_sha256: String,
    phase: String,
    version: Option<String>,
    moved_old: Vec<String>,
    moved_new: Vec<String>,
    config_patched: bool,
    error: Option<RuntimeUpdateError>,
    #[cfg(target_os = "macos")]
    helper_identity: Option<RuntimeProcessIdentity>,
}
fn restore_install_receipt(shared: &Arc<Mutex<State>>, state_root: &Path) {
    let Ok(bytes) = package::read_file(
        &state_root.join("runtime-update-install-receipt.json"),
        256 * 1024,
    ) else {
        return;
    };
    let Ok(receipt) = serde_json::from_slice::<HelperReceipt>(&bytes) else {
        return;
    };
    if receipt.schema != 1
        || !receipt.id.starts_with("runtime-install-")
        || receipt.id.len() > 128
        || !receipt
            .id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        || !package::valid_sha(&receipt.plan_sha256)
    {
        return;
    }
    let path = state_root.join(&receipt.id).join("install-receipt.json");
    if !path.exists() {
        let mut state = shared.lock().unwrap();
        if receipt.phase == "installed" && receipt.version.as_deref() == Some(CURRENT_VERSION) {
            state.status.phase = RuntimeUpdatePhase::UpToDate;
            state.status.error = None;
            return;
        }
        state.install_blocked = true;
        state.status.phase = RuntimeUpdatePhase::Failed;
        state.status.install_available = false;
        state.status.error = Some(error(
            "runtime_update_receipt_missing",
            "The previous update transaction receipt is missing; owner attention is required.",
        ));
        return;
    }
    {
        let mut state = shared.lock().unwrap();
        state.install_id = Some(receipt.id);
        state.install_receipt = Some((path, receipt.plan_sha256));
        state.status.phase = RuntimeUpdatePhase::InstallRequested;
        state.busy = false;
    }
    poll_install_receipt(shared);
}
fn poll_install_receipt(shared: &Arc<Mutex<State>>) {
    let pending = {
        let state = shared.lock().unwrap();
        state.install_receipt.clone().zip(state.install_id.clone())
    };
    let Some(((path, expected_sha), id)) = pending else {
        return;
    };
    let Ok(bytes) = package::read_file(&path, 256 * 1024) else {
        return;
    };
    let Ok(receipt) = serde_json::from_slice::<HelperReceipt>(&bytes) else {
        return;
    };
    if receipt.schema != 1 || receipt.id != id || receipt.plan_sha256 != expected_sha {
        return;
    }
    let retry = matches!(
        receipt.phase.as_str(),
        "failed" | "rolledBack" | "oldRuntimeRestarted"
    ) && receipt.moved_old.is_empty()
        && receipt.moved_new.is_empty()
        && !receipt.config_patched;
    let blocked = matches!(
        receipt.phase.as_str(),
        "rollbackBlocked" | "rollbackRestartFailed" | "installed"
    );
    let completed =
        receipt.phase == "installed" && receipt.version.as_deref() == Some(CURRENT_VERSION);
    if !retry && !blocked && !completed {
        return;
    }
    let mut state = shared.lock().unwrap();
    if state.install_id.as_deref() != Some(id.as_str()) {
        return;
    }
    state.install_id = None;
    state.install_receipt = None;
    state.install_request = None;
    state.busy = false;
    if completed {
        #[cfg(target_os = "macos")]
        if let Some(identity) = receipt.helper_identity {
            let receipt_path = path.clone();
            let plan_sha256 = expected_sha.clone();
            std::thread::spawn(move || {
                for _ in 0..120 {
                    if install::cleanup_completed_mac_helper(&receipt_path, &plan_sha256, &identity)
                    {
                        break;
                    }
                    std::thread::sleep(Duration::from_secs(1));
                }
            });
        }
        state.status.phase = RuntimeUpdatePhase::UpToDate;
        state.status.candidate = None;
        state.candidate = None;
        state.staged = None;
        state.status.error = None;
        return;
    }
    state.status.error = receipt.error.or_else(|| {
        Some(error(
            "runtime_update_install_not_completed",
            "The install helper did not complete the owner restart.",
        ))
    });
    if retry {
        state.status.phase = if state.staged.is_some() {
            RuntimeUpdatePhase::Downloaded
        } else {
            RuntimeUpdatePhase::Failed
        };
    } else {
        state.install_blocked = true;
        state.status.phase = RuntimeUpdatePhase::Failed;
        state.status.install_available = false;
        state.status.unavailable_reason = Some(
            "The previous update requires owner attention; no second launcher will be started."
                .into(),
        );
    }
}

fn read_channel(install_root: &Path) -> Result<RuntimeUpdateChannel> {
    let path = if PLATFORM == "darwin-arm64" {
        install_root.join("Codlet.app/Contents/Resources/runtime/update-channel.json")
    } else {
        install_root.join("runtime/update-channel.json")
    };
    let channel = match package::read_file(&path, 32 * 1024) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| error("runtime_update_channel_invalid", e.to_string()))?,
        Err(_) if !path.exists() => RuntimeUpdateChannel {
            schema: 1,
            channel: "stable".into(),
            check_interval_seconds: 900,
            source: None,
        },
        Err(e) => return Err(e),
    };
    if channel.schema != 1
        || !matches!(channel.channel.as_str(), "stable" | "preview")
        || !(300..=86400).contains(&channel.check_interval_seconds)
    {
        return Err(error(
            "runtime_update_channel_invalid",
            "Invalid update channel schema, name or check interval.",
        ));
    }
    Ok(channel)
}

#[cfg(test)]
mod tests;
