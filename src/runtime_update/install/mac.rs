use super::*;

const MAC_HELPER: &[u8] = include_bytes!("../../../scripts/runtime-update-helper-macos.mjs");

/// A restarted Core reclaims only completed helper copies, after the exact
/// helper process has disappeared. Receipts and the small plan remain for audit.
pub(super) fn cleanup_completed_helper(
    receipt_path: &Path,
    plan_sha256: &str,
    identity: &RuntimeProcessIdentity,
) -> bool {
    let work = || -> Result<()> {
        if receipt_path.file_name() != Some(std::ffi::OsStr::new("install-receipt.json"))
            || !package::valid_sha(plan_sha256)
            || identity.pid == 0
            || identity.pid > i32::MAX as u32
            || identity.creation_time.is_empty()
            || identity.creation_time.len() > 32
            || !identity
                .creation_time
                .bytes()
                .all(|digit| digit.is_ascii_digit())
        {
            return Err(error(
                "runtime_update_path_invalid",
                "Invalid helper cleanup identity.",
            ));
        }
        let job = package::canonical_directory(receipt_path.parent().ok_or_else(|| {
            error(
                "runtime_update_path_invalid",
                "Missing helper job directory.",
            )
        })?)?;
        if !job
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with("runtime-install-"))
        {
            return Err(error(
                "runtime_update_path_invalid",
                "Helper cleanup is outside an update job.",
            ));
        }
        let receipt: serde_json::Value =
            serde_json::from_slice(&package::read_file(receipt_path, 256 * 1024)?)
                .map_err(|e| error("runtime_update_metadata", e.to_string()))?;
        if receipt["schema"] != 1
            || receipt["id"].as_str() != job.file_name().and_then(|name| name.to_str())
            || receipt["planSha256"].as_str() != Some(plan_sha256)
            || receipt["phase"].as_str() != Some("installed")
            || receipt["version"].as_str() != Some(CURRENT_VERSION)
            || receipt["helperIdentity"]["pid"].as_u64() != Some(identity.pid as u64)
            || receipt["helperIdentity"]["creationTime"].as_str()
                != Some(identity.creation_time.as_str())
        {
            return Err(error(
                "runtime_update_metadata",
                "Only this completed helper may be cleaned.",
            ));
        }
        match crate::macos::identity::ProcessIdentity::inspect(identity.pid) {
            Ok(running)
                if format!(
                    "{}{:06}",
                    running.started_seconds, running.started_microseconds
                ) == identity.creation_time =>
            {
                return Err(error(
                    "runtime_update_busy",
                    "Update helper is still running.",
                ));
            }
            Err(_) => {
                if unsafe { libc::kill(identity.pid as i32, 0) } == 0
                    || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
                {
                    return Err(error(
                        "runtime_update_busy",
                        "Cannot prove the update helper exited.",
                    ));
                }
            }
            Ok(_) => {}
        }
        let plan_path = job.join("install-plan.json");
        let plan_bytes = package::read_file(&plan_path, 2 * 1024 * 1024)?;
        if format!("{:x}", Sha256::digest(&plan_bytes)) != plan_sha256 {
            return Err(error(
                "runtime_update_changed",
                "Helper plan digest changed.",
            ));
        }
        let plan: serde_json::Value = serde_json::from_slice(&plan_bytes)
            .map_err(|e| error("runtime_update_metadata", e.to_string()))?;
        if plan["schema"] != 1
            || plan["kind"] != "codlet-runtime-install-plan"
            || plan["profile"] != "macApp"
            || plan["platform"] != PLATFORM
            || plan["id"].as_str() != job.file_name().and_then(|name| name.to_str())
        {
            return Err(error(
                "runtime_update_metadata",
                "Helper plan does not match its job.",
            ));
        }
        for (field, filename) in [
            ("helperNode", "helper-node"),
            ("identityProbe", "identity-core"),
        ] {
            let path = job.join(filename);
            let expected_path = path.to_string_lossy();
            if plan[field]["path"].as_str() != Some(expected_path.as_ref()) {
                return Err(error(
                    "runtime_update_path_invalid",
                    "Helper plan redirected a cleanup file.",
                ));
            }
            if !path.exists() {
                continue;
            }
            let actual = package::file_record(&path, "")?;
            if plan[field]["bytes"].as_u64() != Some(actual.bytes)
                || plan[field]["sha256"].as_str() != Some(actual.sha256.as_str())
                || plan[field]["mode"].as_u64() != actual.mode.map(u64::from)
            {
                return Err(error(
                    "runtime_update_changed",
                    "Helper copy changed before cleanup.",
                ));
            }
        }
        let node = job.join("helper-node");
        let probe = job.join("identity-core");
        for pid in crate::macos::identity::process_ids().map_err(io_error)? {
            if let Ok(process) = crate::macos::identity::ProcessIdentity::inspect(pid)
                && (process.executable == node || process.executable == probe)
            {
                return Err(error(
                    "runtime_update_busy",
                    "A helper copy is still executing.",
                ));
            }
        }
        for filename in ["helper-node", "identity-core"] {
            let path = job.join(filename);
            if path.exists() {
                std::fs::remove_file(&path).map_err(io_error)?;
            }
        }
        Ok(())
    };
    work().is_ok()
}

pub(super) fn prepare(
    install_root: &Path,
    state_root: &Path,
    staged: &package::StagedRuntime,
    restart: &RuntimeRestartContext,
    official_update: bool,
) -> Result<RuntimeInstallRequest> {
    if official_update
        || restart.config_pin.is_some()
        || restart.profile != RuntimePayloadProfile::MacApp
    {
        return Err(error(
            "install_unavailable",
            "Mac app updates require a standalone Codlet app owner.",
        ));
    }
    ensure_same_volume(install_root, state_root)?;
    let root = package::canonical_directory(install_root)?;
    let executable = std::env::current_exe()
        .map_err(io_error)?
        .canonicalize()
        .map_err(io_error)?;
    if executable != root.join("Codlet.app/Contents/Resources/codlet") {
        return Err(error(
            "install_unavailable",
            "The running Core is not inside the owned Codlet.app.",
        ));
    }
    let launcher = root.join("Codlet.app/Contents/MacOS/Codlet");
    let parent =
        crate::macos::identity::ProcessIdentity::inspect(unsafe { libc::getppid() } as u32)
            .map_err(io_error)?;
    if parent.uid != unsafe { libc::geteuid() } || parent.executable != launcher {
        return Err(error(
            "install_unavailable",
            "The current Core was not started by its Codlet.app launcher.",
        ));
    }
    let lock = root.join(".codlet-runtime-update.lock.json");
    if std::fs::symlink_metadata(&lock).is_ok() {
        return Err(error(
            "runtime_update_locked",
            "Another app update transaction owns this installation.",
        ));
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
            "Staged app is outside the owned update directory.",
        ));
    }
    package::recheck_staged(staged)?;
    if staged.manifest.profile != RuntimePayloadProfile::MacApp
        || staged.candidate.platform != PLATFORM
    {
        return Err(error(
            "install_unavailable",
            "Update package does not match this Apple Silicon app.",
        ));
    }
    let current = package::inspect_installation(&root, RuntimePayloadProfile::MacApp, false)?;
    let _probe = tempfile::Builder::new()
        .prefix(".codlet-update-probe-")
        .tempfile_in(&root)
        .map_err(|e| {
            error(
                "install_unavailable",
                format!("App directory is not writable: {e}"),
            )
        })?;
    let app = root.join("Codlet.app");
    if std::fs::metadata(&app)
        .map_err(io_error)?
        .permissions()
        .readonly()
    {
        return Err(error(
            "install_unavailable",
            "The installed app is read-only.",
        ));
    }
    let mut wait_for = restart.wait_for.clone();
    let current_process = current_process_identity()?;
    if !wait_for.contains(&current_process) {
        wait_for.push(current_process);
    }
    let parent_identity = RuntimeProcessIdentity {
        pid: parent.pid,
        creation_time: format!(
            "{}{:06}",
            parent.started_seconds, parent.started_microseconds
        ),
    };
    if !wait_for.contains(&parent_identity) {
        wait_for.push(parent_identity);
    }
    if wait_for.len() > 17
        || wait_for.iter().any(|p| {
            p.pid == 0
                || p.creation_time.is_empty()
                || p.creation_time.len() > 32
                || !p.creation_time.bytes().all(|b| b.is_ascii_digit())
        })
    {
        return Err(error(
            "install_unavailable",
            "Owner process identities are invalid.",
        ));
    }
    let mut ids = BTreeSet::new();
    if wait_for.iter().any(|p| !ids.insert(p.pid)) {
        return Err(error(
            "install_unavailable",
            "Owner process identities are duplicated.",
        ));
    }
    let temporary = tempfile::Builder::new()
        .prefix("runtime-install-")
        .tempdir_in(&state_root)
        .map_err(io_error)?;
    let job = temporary.path().canonicalize().map_err(io_error)?;
    let id = job.file_name().unwrap().to_string_lossy().into_owned();
    let node_path = job.join("helper-node");
    let helper_path = job.join("runtime-update-helper-macos.mjs");
    let probe_path = job.join("identity-core");
    let current_node = root.join(format!(
        "Codlet.app/Contents/Resources/runtime/node-v{}-{PLATFORM}/bin/node",
        current.runtime.version
    ));
    std::fs::copy(&current_node, &node_path).map_err(io_error)?;
    std::fs::copy(&executable, &probe_path).map_err(io_error)?;
    std::fs::write(&helper_path, MAC_HELPER).map_err(io_error)?;
    let helper_node = checked(&node_path)?;
    let helper_script = checked(&helper_path)?;
    let identity_probe = checked(&probe_path)?;
    if helper_node.sha256 != current.runtime.executable_sha256
        || identity_probe.sha256
            != current
                .files
                .iter()
                .find(|f| f.path == "Codlet.app/Contents/Resources/codlet")
                .unwrap()
                .sha256
    {
        return Err(error(
            "runtime_update_identity_changed",
            "Copied update helper differs from its installed source.",
        ));
    }
    let command = RuntimeRestartCommand {
        program: launcher.clone(),
        args: Vec::new(),
        working_directory: root.clone(),
        environment: restart.command.environment.clone(),
        timeout_seconds: restart.command.timeout_seconds,
    };
    if !(5..=180).contains(&command.timeout_seconds) || command.environment.len() > 64 {
        return Err(error(
            "install_unavailable",
            "Restart command exceeds its supported bounds.",
        ));
    }
    let created = now_ms();
    let plan = InstallPlan {
        schema: 1,
        kind: "codlet-runtime-install-plan",
        id: id.clone(),
        version: staged.candidate.version.clone(),
        current_version: CURRENT_VERSION,
        platform: PLATFORM,
        profile: RuntimePayloadProfile::MacApp,
        install_root: root.clone(),
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
        identity_probe: Some(identity_probe),
        restart: &command,
        restart_program_sha256: checked(&launcher)?.sha256,
        launcher_files: Vec::new(),
        config_pin: None,
        wait_for,
        handoff_ack_path: job.join("handoff-ack.json"),
        official_update: false,
        install_receipt_path: job.join("install-receipt.json"),
        summary_receipt_path: state_root.join("runtime-update-install-receipt.json"),
        created_at: created,
        expires_at: created + 30 * 60 * 1000,
    };
    let plan_path = job.join("install-plan.json");
    package::atomic_json(&plan_path, &plan)?;
    let plan_sha256 = format!(
        "{:x}",
        Sha256::digest(package::read_file(&plan_path, 2 * 1024 * 1024)?)
    );
    let _ = temporary.keep();
    Ok(RuntimeInstallRequest {
        id,
        version: staged.candidate.version.clone(),
        plan_path,
        plan_sha256,
        helper_path,
        node_path,
        handoff_ack_path: plan.handoff_ack_path,
        official_update: false,
    })
}
