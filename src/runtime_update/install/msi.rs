use super::*;

const MSI_HELPER: &[u8] = include_bytes!("../../../scripts/runtime-msi-update-helper.mjs");

pub(super) fn prepare(
    install_root: &Path,
    state_root: &Path,
    staged: &package::StagedRuntime,
    restart: &RuntimeRestartContext,
    official_update: bool,
) -> Result<RuntimeInstallRequest> {
    let root = package::canonical_directory(install_root)?;
    let state_root = package::ensure_state_root(state_root)?;
    package::recheck_staged(staged)?;
    if restart.profile != RuntimePayloadProfile::Portable || restart.config_pin.is_some() {
        return Err(error(
            "core_update_installer_owned",
            "MSI updates require the installed Codlet launcher.",
        ));
    }
    let setup = staged.installer.as_ref().ok_or_else(|| {
        error(
            "core_update_installer_missing",
            "This release does not include a verified Codlet setup executable.",
        )
    })?;
    let installer = checked(&setup.path)?;
    if installer.bytes != setup.bytes
        || installer.sha256 != setup.sha256
        || installer.path.parent() != Some(state_root.as_path())
    {
        return Err(error(
            "runtime_update_changed",
            "The verified setup executable changed.",
        ));
    }
    let expected_files = staged
        .manifest
        .files
        .iter()
        .filter(|file| {
            matches!(
                file.path.as_str(),
                "codlet.exe" | "runtime/node-runtime.json"
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    if !expected_files.iter().any(|file| file.path == "codlet.exe") {
        return Err(error(
            "core_update_installer_missing",
            "MSI updates require the complete release payload.",
        ));
    }
    let current_executable = checked(&root.join("codlet.exe"))?;
    let marker = checked(&root.join("msi-install.json"))?;
    let marker_value: serde_json::Value =
        serde_json::from_slice(&package::read_file(&marker.path, 64 * 1024)?)
            .map_err(|failure| error("runtime_update_manifest_invalid", failure.to_string()))?;
    if marker_value["schema"] != 1 || marker_value["kind"] != "codlet-msi-install" {
        return Err(error(
            "core_update_installer_owned",
            "The MSI installation marker is invalid.",
        ));
    }
    crate::js_runtime::JsRuntime::ensure_from_distribution(&staged.directory)
        .map_err(|failure| error("runtime_update_runtime_unavailable", failure.message))?;
    let runtime = crate::js_runtime::JsRuntime::ensure_from_distribution(&root)
        .map_err(|failure| error("runtime_update_runtime_unavailable", failure.message))?;
    let original_node = checked(runtime.executable_path())?;
    if original_node.sha256 != runtime.verified_executable_sha256() {
        return Err(error(
            "runtime_update_identity_changed",
            "The helper runtime changed.",
        ));
    }
    let temporary = tempfile::Builder::new()
        .prefix("runtime-install-")
        .tempdir_in(&state_root)
        .map_err(io_error)?;
    let job = temporary.path().canonicalize().map_err(io_error)?;
    let id = job.file_name().unwrap().to_string_lossy().into_owned();
    let node_path = job.join("helper-node.exe");
    let helper_path = job.join("runtime-msi-update-helper.mjs");
    let primitives_path = job.join("runtime-update-helper.mjs");
    std::fs::copy(runtime.executable_path(), &node_path).map_err(io_error)?;
    std::fs::write(&helper_path, MSI_HELPER).map_err(io_error)?;
    std::fs::write(&primitives_path, HELPER).map_err(io_error)?;
    let mut command = restart.command.clone();
    let mut launchers = Vec::new();
    for (index, source) in restart.launcher_files.iter().enumerate() {
        let before = checked(source)?;
        let target = job.join(format!(
            "restart-{index}.{}",
            source
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("bin")
        ));
        std::fs::copy(&before.path, &target).map_err(io_error)?;
        let copied = checked(&target)?;
        if before.sha256 != copied.sha256 {
            return Err(error(
                "runtime_update_identity_changed",
                "Restart helper changed during staging.",
            ));
        }
        for argument in &mut command.args {
            if Path::new(argument).canonicalize().ok().as_ref() == Some(&before.path) {
                *argument = copied.path.to_string_lossy().into_owned();
            }
        }
        launchers.push(copied);
    }
    let mut wait_for = restart.wait_for.clone();
    let current = current_process_identity()?;
    if !wait_for.contains(&current) {
        wait_for.push(current);
    }
    let handoff_ack_path = job.join("handoff-ack.json");
    let plan_path = job.join("install-plan.json");
    let created = now_ms();
    let plan = serde_json::json!({"schema":1,"kind":"codlet-msi-install-plan","id":id,"version":staged.candidate.version,"installRoot":root,"stateRoot":state_root,
        "installer":installer,"marker":marker,"currentExecutable":current_executable,"expectedFiles":expected_files,
        "helperNode":checked(&node_path)?,"helperScript":checked(&helper_path)?,"primitives":checked(&primitives_path)?,
        "restartProgram":checked(&command.program)?,"restart":command,"launcherFiles":launchers,"waitFor":wait_for,
        "handoffAckPath":handoff_ack_path,"officialUpdate":official_update,"activateOnNextStart":false,
        "installReceiptPath":job.join("install-receipt.json"),"summaryReceiptPath":state_root.join("runtime-update-install-receipt.json"),"createdAt":created,"expiresAt":created+30*60*1000});
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
        activate_on_next_start: false,
    })
}
