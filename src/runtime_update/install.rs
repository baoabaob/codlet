use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{
    CURRENT_VERSION, PLATFORM, Result, RuntimeInstallRequest, RuntimePayloadProfile,
    RuntimeProcessIdentity, RuntimeRestartCommand, RuntimeRestartContext, error, io_error, now_ms,
    package,
};

const HELPER: &[u8] = include_bytes!("../../scripts/runtime-update-helper.mjs");
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckedPath {
    path: PathBuf,
    bytes: u64,
    sha256: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigPinPlan {
    path: PathBuf,
    bytes: u64,
    sha256: String,
    field: &'static str,
    old_value: String,
    new_value: String,
    old_node_relative: String,
    new_node_relative: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallPlan<'a> {
    schema: u32,
    kind: &'static str,
    id: String,
    version: String,
    current_version: &'static str,
    platform: &'static str,
    profile: RuntimePayloadProfile,
    install_root: PathBuf,
    state_root: PathBuf,
    staged_root: PathBuf,
    backup_root: PathBuf,
    manifest_sha256: String,
    current_files: Vec<package::RuntimeFile>,
    new_files: Vec<package::RuntimeFile>,
    current_runtime: package::NodeRuntime,
    new_runtime: package::NodeRuntime,
    helper_node: CheckedPath,
    helper_script: CheckedPath,
    restart: &'a RuntimeRestartCommand,
    restart_program_sha256: String,
    launcher_files: Vec<CheckedPath>,
    config_pin: Option<ConfigPinPlan>,
    wait_for: Vec<RuntimeProcessIdentity>,
    handoff_ack_path: PathBuf,
    official_update: bool,
    install_receipt_path: PathBuf,
    summary_receipt_path: PathBuf,
    created_at: u64,
    expires_at: u64,
}
fn checked(path: &Path) -> Result<CheckedPath> {
    let record = package::file_record(path, "")?;
    Ok(CheckedPath {
        path: path.canonicalize().map_err(io_error)?,
        bytes: record.bytes,
        sha256: record.sha256,
    })
}
#[cfg(test)]
pub(super) fn prepare_install_plan(
    install_root: &Path,
    state_root: &Path,
    staged: &package::StagedRuntime,
    restart: &RuntimeRestartContext,
) -> Result<RuntimeInstallRequest> {
    prepare_install_plan_with_official(install_root, state_root, staged, restart, false)
}
pub(super) fn prepare_install_plan_with_official(
    install_root: &Path, state_root: &Path, staged: &package::StagedRuntime,
    restart: &RuntimeRestartContext, official_update: bool,
) -> Result<RuntimeInstallRequest> {
    ensure_same_volume(install_root, state_root)?;
    let root = package::canonical_directory(install_root)?;
    match std::fs::symlink_metadata(root.join(".codlet-runtime-update.lock.json")) {
        Ok(_) => {
            return Err(error(
                "runtime_update_locked",
                "Another update transaction owns this installation. Keep the current client open and wait for that transaction or owner recovery.",
            ));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(io_error(e)),
    }
    let state_root = package::ensure_state_root(state_root)?;
    if staged.directory.parent() != Some(state_root.as_path())
        || !staged
            .directory
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with("runtime-payload-"))
    {
        return Err(error(
            "runtime_update_path_invalid",
            "Staged payload is not owned by this update service.",
        ));
    }
    package::recheck_staged(staged)?;
    if restart.profile != staged.manifest.profile {
        return Err(error(
            "install_unavailable",
            "Update package profile differs from this launcher's installation.",
        ));
    }
    #[cfg(not(test))]
    {
        let executable = std::env::current_exe()
            .map_err(io_error)?
            .canonicalize()
            .map_err(io_error)?;
        if executable.parent() != Some(root.as_path())
            || !matches!(
                executable.file_name().and_then(|n| n.to_str()),
                Some("codlet.exe" | "codlet-lab.exe")
            )
        {
            return Err(error(
                "install_unavailable",
                "The running executable is not a recognized owner of this payload directory.",
            ));
        }
    }
    let other = if restart.profile == RuntimePayloadProfile::Portable {
        "codlet-lab.exe"
    } else {
        "codlet.exe"
    };
    let include_other = staged.manifest.files.iter().any(|f| f.path == other);
    if include_other && !root.join(other).exists() {
        return Err(error(
            "install_unavailable",
            "An update cannot add an executable outside this owner's existing payload profile.",
        ));
    }
    let current = package::inspect_installation(&root, restart.profile, include_other)?;
    // Exercise only a new owned probe before any owner is asked to quit. Payload
    // files themselves remain unchanged and still have their normal open handles.
    let _probe = tempfile::Builder::new()
        .prefix(".codlet-update-probe-")
        .tempfile_in(&root)
        .map_err(|e| {
            error(
                "install_unavailable",
                format!("The runtime installation directory is not writable: {e}"),
            )
        })?;
    for file in &current.files {
        if std::fs::metadata(root.join(&file.path))
            .map_err(io_error)?
            .permissions()
            .readonly()
        {
            return Err(error(
                "install_unavailable",
                "An owned runtime file is read-only; installation was not started.",
            ));
        }
    }
    let old_paths: BTreeSet<_> = current.files.iter().map(|f| f.path.as_str()).collect();
    for file in &staged.manifest.files {
        let destination = root.join(&file.path);
        package::no_redirect_ancestors(&destination)?;
        if destination.exists() && !old_paths.contains(file.path.as_str()) {
            return Err(error(
                "runtime_update_file_conflict",
                "An unowned file already occupies a new runtime payload path.",
            ));
        }
    }
    if restart.command.args.len() > 128
        || restart
            .command
            .args
            .iter()
            .any(|s| s.len() > 16384 || s.contains('\0'))
        || !(5..=180).contains(&restart.command.timeout_seconds)
        || restart.launcher_files.len() > 16
        || restart.wait_for.len() > 16
        || restart.command.environment.len() > 64
        || restart.command.environment.iter().any(|(k, v)| {
            k.is_empty()
                || k.len() > 128
                || k.contains(['=', '\0'])
                || v.len() > 32768
                || v.contains('\0')
        })
    {
        return Err(error(
            "install_unavailable",
            "The owner restart context exceeds its supported bounds.",
        ));
    }
    package::canonical_directory(&restart.command.working_directory)?;
    let program = package::restart_program_record(&restart.command.program)?;
    let launcher_files = restart
        .launcher_files
        .iter()
        .map(|p| checked(p))
        .collect::<Result<Vec<_>>>()?;
    let config_pin = if let Some(pin) = &restart.config_pin {
        let before = checked(&pin.path)?;
        if before.bytes > 256 * 1024 {
            return Err(error(
                "install_unavailable",
                "Launcher configuration exceeds the pin-patch limit.",
            ));
        }
        let config: serde_json::Value =
            serde_json::from_slice(&package::read_file(&pin.path, 256 * 1024)?)
                .map_err(|e| error("install_unavailable", e.to_string()))?;
        let old_hash = current
            .files
            .iter()
            .find(|f| f.path == "codlet-lab.exe")
            .ok_or_else(|| {
                error(
                    "install_unavailable",
                    "Launcher pin patch requires an existing owned lab executable.",
                )
            })?
            .sha256
            .clone();
        let new_hash = staged
            .manifest
            .files
            .iter()
            .find(|f| f.path == "codlet-lab.exe")
            .ok_or_else(|| {
                error(
                    "install_unavailable",
                    "Launcher pin patch requires an updated lab executable.",
                )
            })?
            .sha256
            .clone();
        let old_pin_value = config
            .get("labBinarySha256")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                error(
                    "install_unavailable",
                    "The owner configuration has no lab executable pin.",
                )
            })?
            .to_owned();
        if !old_pin_value.eq_ignore_ascii_case(&old_hash) {
            return Err(error(
                "runtime_update_identity_changed",
                "The launcher labBinarySha256 pin does not match the current owned executable.",
            ));
        }
        let old_node_relative = config
            .get("nodeRelative")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                error(
                    "install_unavailable",
                    "The owner configuration has no pinned Node path.",
                )
            })?
            .to_owned();
        if old_node_relative.replace('\\', "/")
            != format!(
                "runtime/node-v{}-{PLATFORM}/node.exe",
                current.runtime.version
            )
        {
            return Err(error(
                "runtime_update_identity_changed",
                "The owner Node path does not match the current runtime pin.",
            ));
        }
        let new_node_relative = format!(
            "runtime/node-v{}-{PLATFORM}/node.exe",
            staged.manifest.runtime.version
        );
        if current
            .files
            .iter()
            .any(|f| root.join(&f.path) == before.path)
        {
            return Err(error(
                "install_unavailable",
                "Launcher configuration must not overlap runtime payload files.",
            ));
        }
        Some(ConfigPinPlan {
            path: before.path,
            bytes: before.bytes,
            sha256: before.sha256,
            field: "labBinarySha256",
            old_value: old_pin_value,
            new_value: new_hash,
            old_node_relative,
            new_node_relative,
        })
    } else {
        None
    };
    let mut wait_for = restart.wait_for.clone();
    let current_process = current_process_identity()?;
    if !wait_for.iter().any(|p| p == &current_process) {
        wait_for.push(current_process);
    }
    let mut ids = BTreeSet::new();
    for process in &wait_for {
        if process.pid == 0
            || process.creation_time.is_empty()
            || process.creation_time.len() > 32
            || !process.creation_time.bytes().all(|b| b.is_ascii_digit())
            || !ids.insert(process.pid)
        {
            return Err(error(
                "install_unavailable",
                "Invalid or duplicate owner process identity.",
            ));
        }
    }
    let temporary = tempfile::Builder::new()
        .prefix("runtime-install-")
        .tempdir_in(&state_root)
        .map_err(io_error)?;
    let job = temporary.path().canonicalize().map_err(io_error)?;
    let id = job.file_name().unwrap().to_string_lossy().into_owned();
    let node_path = job.join("helper-node.exe");
    let helper_path = job.join("runtime-update-helper.mjs");
    let current_node = root.join(format!(
        "runtime/node-v{}-{PLATFORM}/node.exe",
        current.runtime.version
    ));
    std::fs::copy(&current_node, &node_path).map_err(io_error)?;
    std::fs::write(&helper_path, HELPER).map_err(io_error)?;
    let helper_node = checked(&node_path)?;
    let helper_script = checked(&helper_path)?;
    if helper_node.sha256 != current.runtime.executable_sha256 {
        return Err(error(
            "runtime_update_identity_changed",
            "The copied helper Node runtime does not match its pin.",
        ));
    }
    let handoff_ack_path = job.join("handoff-ack.json");
    let created = now_ms();
    let plan = InstallPlan {
        schema: 1,
        kind: "codlet-runtime-install-plan",
        id: id.clone(),
        version: staged.candidate.version.clone(),
        current_version: CURRENT_VERSION,
        platform: PLATFORM,
        profile: restart.profile,
        install_root: root,
        state_root: state_root.clone(),
        staged_root: staged.directory.clone(),
        backup_root: job.join("backup"),
        manifest_sha256: staged.manifest_sha256.clone(),
        current_files: current.files,
        new_files: staged.manifest.files.clone(),
        current_runtime: current.runtime,
        new_runtime: staged.manifest.runtime.clone(),
        helper_node,
        helper_script,
        restart: &restart.command,
        restart_program_sha256: program.sha256,
        launcher_files,
        config_pin,
        wait_for,
        handoff_ack_path: handoff_ack_path.clone(),
        official_update,
        install_receipt_path: job.join("install-receipt.json"),
        summary_receipt_path: state_root.join("runtime-update-install-receipt.json"),
        created_at: created,
        expires_at: created + 30 * 60 * 1000,
    };
    let plan_path = job.join("install-plan.json");
    package::atomic_json(&plan_path, &plan)?;
    let plan_sha256 = format!(
        "{:x}",
        Sha256::digest(package::read_file(&plan_path, 256 * 1024)?)
    );
    let _ = temporary.keep();
    Ok(RuntimeInstallRequest {
        id,
        version: staged.candidate.version.clone(),
        plan_path,
        plan_sha256,
        helper_path,
        node_path,
        handoff_ack_path,
        official_update,
    })
}

pub(super) fn ensure_same_volume(install_root: &Path, state_root: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        let drive = |path: &Path| match path.components().next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => {
                    Some(letter.to_ascii_uppercase())
                }
                _ => None,
            },
            _ => None,
        };
        if drive(install_root).is_none() || drive(install_root) != drive(state_root) {
            return Err(error(
                "runtime_update_cross_volume",
                "Runtime update staging and installation must be on the same local volume. The owner must choose an update state directory on the installation drive.",
            ));
        }
    }
    #[cfg(not(windows))]
    let _ = (install_root, state_root);
    Ok(())
}

pub(super) fn current_process_identity() -> Result<RuntimeProcessIdentity> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::FILETIME;
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
        let mut created = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut exited = created;
        let mut kernel = created;
        let mut user = created;
        if unsafe {
            GetProcessTimes(
                GetCurrentProcess(),
                &mut created,
                &mut exited,
                &mut kernel,
                &mut user,
            )
        } == 0
        {
            return Err(io_error(std::io::Error::last_os_error()));
        }
        let ticks = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
        Ok(RuntimeProcessIdentity {
            pid: std::process::id(),
            creation_time: ticks.to_string(),
        })
    }
    #[cfg(not(windows))]
    {
        Err(error(
            "install_unavailable",
            "Runtime installation currently requires a Windows owner process identity.",
        ))
    }
}
