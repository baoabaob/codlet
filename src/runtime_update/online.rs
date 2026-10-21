//! Compatible Core module installation keeps the compiled traffic owner and
//! Native lease live. Executable, Node and bootstrap changes use the checked
//! next-start installer instead of pretending their live state was migrated.
use super::{Result, RuntimePayloadProfile, error, io_error, package};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::Digest;
use std::io::Write;
use std::path::Path;
const RETAINED_COMPONENTS: [&str; 16] = [
    "core-executable",
    "rust-traffic",
    "client-bridge",
    "module-observer",
    "renderer-ingress-forwarder",
    "renderer-bootstrap",
    "renderer-helpers",
    "renderer-ui",
    "renderer-facade",
    "renderer-page",
    "renderer-i18n",
    "renderer-codex-sdk",
    "renderer-core-services",
    "host-bootstrap",
    "core-ui-provider",
    "core-desktop-provider",
];
pub(super) fn retained_components() -> Vec<String> {
    RETAINED_COMPONENTS
        .iter()
        .map(|component| (*component).into())
        .collect()
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct InstalledPin {
    pub schema: u32,
    pub version: String,
    pub contract: package::OnlineRuntime,
    pub source: package::RuntimeFile,
    pub resident_files: Vec<package::RuntimeFile>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modules: Vec<InstalledModule>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct InstalledModule {
    pub id: String,
    pub file: package::RuntimeFile,
}
pub(super) fn load_pin(root: &Path) -> Result<Option<InstalledPin>> {
    let path = root.join("runtime/core-modules/activation.json");
    if !path.exists() {
        return Ok(None);
    }
    serde_json::from_slice(&package::read_file(&path, 256 * 1024)?)
        .map(Some)
        .map_err(|_| {
            error(
                "core_update_pin_invalid",
                "Installed online Core pin is invalid.",
            )
        })
}

pub(super) fn installed_source(root: &Path) -> Result<Option<String>> {
    let path = root.join("runtime/core-modules/activation.json");
    if !path.exists() {
        return Ok(None);
    }
    let pin: InstalledPin = serde_json::from_slice(&package::read_file(&path, 256 * 1024)?)
        .map_err(|_| {
            error(
                "core_update_pin_invalid",
                "Installed online Core pin is invalid.",
            )
        })?;
    let current = package::OnlineRuntime::current();
    if pin.schema != 1
        || pin.contract.schema != 1
        || pin.contract.client_source_path != package::ONLINE_CLIENT_SOURCE
        || pin.source.path != package::ONLINE_CLIENT_SOURCE
        || pin.source.bytes > 1024 * 1024
        || pin.resident_files.is_empty()
        || pin.resident_files.len() > 8
        || pin.modules.len() > super::modules::MODULE_LIMIT
        || !pin
            .resident_files
            .iter()
            .any(|file| file.path == "codlet.exe" || file.path == "codlet-lab.exe")
        || !pin
            .resident_files
            .iter()
            .any(|file| file.path == "runtime/node-runtime.json")
        || pin
            .resident_files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != pin.resident_files.len()
    {
        return Err(error(
            "core_update_pin_incompatible",
            "Installed online Core belongs to another resident build.",
        ));
    }
    if pin.contract.bridge_protocol != current.bridge_protocol
        || pin.contract.bridge_sha256 != current.bridge_sha256
        || pin.contract.bootstrap_sha256 != current.bootstrap_sha256
        || pin.contract.module_abi != 1
    {
        return Ok(None);
    }
    // Paths come from a validated install allowlist, but the persisted pin is
    // read as untrusted input on each new start.
    for file in &pin.resident_files {
        if !(file.path == "codlet.exe"
            || file.path == "codlet-lab.exe"
            || file.path == "runtime/node-runtime.json"
            || file.path.starts_with("runtime/node-v")
                && (file.path.ends_with("/node.exe") || file.path.ends_with("/LICENSE")))
            || file.path.contains("..")
            || file.path.contains('\\')
            || file.path.starts_with('/')
        {
            return Err(error(
                "core_update_pin_invalid",
                "Installed online Core pin includes a non-owned path.",
            ));
        }
        if !root.join(&file.path).exists()
            || package::file_record(&root.join(&file.path), &file.path)? != *file
        {
            return Ok(None);
        }
    }
    if package::file_record(&root.join(&pin.source.path), &pin.source.path)? != pin.source {
        return Err(error(
            "core_update_pin_changed",
            "Installed online Core source differs from its receipt.",
        ));
    }
    Ok(Some(
        String::from_utf8(package::read_file(
            &root.join(pin.source.path),
            1024 * 1024,
        )?)
        .map_err(|_| {
            error(
                "core_update_pin_invalid",
                "Installed online Core source must be UTF-8.",
            )
        })?,
    ))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeActivation {
    pub mode: String,
    pub version: String,
    pub components: Vec<String>,
    pub retained_components: Vec<String>,
    pub next_start_reason: Option<String>,
    pub persistence_pending: bool,
}

pub(super) fn installed_activation(root: &Path) -> Result<Option<RuntimeActivation>> {
    if installed_source(root)?.is_none() {
        return Ok(None);
    }
    let pin: InstalledPin = serde_json::from_slice(&package::read_file(
        &root.join("runtime/core-modules/activation.json"),
        256 * 1024,
    )?)
    .map_err(|_| {
        error(
            "core_update_pin_invalid",
            "Installed online Core pin is invalid.",
        )
    })?;
    super::source::newer(&pin.version, super::CURRENT_VERSION)?;
    Ok(Some(RuntimeActivation {
        mode: "online".into(),
        version: pin.version,
        components: std::iter::once("native-client-source".into())
            .chain(pin.modules.iter().map(|module| module.id.clone()))
            .collect(),
        retained_components: retained_components()
            .into_iter()
            .filter(|id| !pin.modules.iter().any(|module| module.id == *id))
            .collect(),
        next_start_reason: None,
        persistence_pending: false,
    }))
}

pub(super) fn compatible(root: &Path, staged: &package::StagedRuntime) -> Result<bool> {
    let Some(online) = &staged.manifest.online else {
        return Ok(false);
    };
    let current = package::OnlineRuntime::current();
    if online.schema != current.schema
        || online.bridge_protocol != current.bridge_protocol
        || online.bridge_sha256 != current.bridge_sha256
        || online.bootstrap_sha256 != current.bootstrap_sha256
        || online.module_abi != 1
    {
        return Ok(false);
    }
    if staged.manifest.profile == RuntimePayloadProfile::MacApp {
        return Ok(false);
    };
    // Actual file hashes, including every executable/Node pin, decide whether
    // the resident Rust TLS and Native bootstrap can continue unchanged.
    for file in &staged.manifest.files {
        if file.path == package::ONLINE_CLIENT_SOURCE
            || online.modules.iter().any(|module| module.path == file.path)
        {
            continue;
        }
        if package::file_record(&root.join(&file.path), &file.path)? != *file {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(super) fn apply(
    root: &Path,
    state_root: &Path,
    staged: &package::StagedRuntime,
    target: &crate::client_bridge::ClientSourceRuntime,
) -> Result<RuntimeActivation> {
    package::recheck_staged(staged)?;
    if !compatible(root, staged)? {
        return Err(error(
            "core_update_next_start_required",
            "Resident Core files or protocol changed; activation requires the next start.",
        ));
    }
    let source_record = staged
        .manifest
        .files
        .iter()
        .find(|file| file.path == package::ONLINE_CLIENT_SOURCE)
        .ok_or_else(|| {
            error(
                "runtime_update_manifest_invalid",
                "Online Core source is missing.",
            )
        })?;
    let prior_modules = load_pin(root)?.map_or_else(Vec::new, |pin| pin.modules);
    if source_record.bytes > 1024 * 1024 {
        return Err(error(
            "runtime_update_size_limit",
            "Online Core source exceeds the IPC limit.",
        ));
    }
    let bytes = package::read_file(
        &staged.directory.join(package::ONLINE_CLIENT_SOURCE),
        1024 * 1024,
    )?;
    let code = std::str::from_utf8(&bytes).map_err(|_| {
        error(
            "runtime_update_manifest_invalid",
            "Online Core source must be UTF-8.",
        )
    })?;
    let destination = root.join(package::ONLINE_CLIENT_SOURCE);
    package::no_redirect_ancestors(&destination)?;
    let parent = destination.parent().expect("fixed component path");
    std::fs::create_dir_all(parent).map_err(io_error)?;
    package::canonical_directory(parent)?;
    let lock_path = root.join(".codlet-runtime-update.lock.json");
    let mut lock = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)
        .map_err(|failure| {
            if failure.kind() == std::io::ErrorKind::AlreadyExists {
                error(
                    "runtime_update_locked",
                    "Another installation transaction owns Core.",
                )
            } else {
                io_error(failure)
            }
        })?;
    let lock_bytes=serde_json::to_vec(&json!({"schema":1,"kind":"codlet-online-install-lock","pid":std::process::id(),"candidate":staged.candidate.id}))
        .expect("lock serializes");
    lock.write_all(&lock_bytes)
        .and_then(|()| lock.sync_all())
        .map_err(io_error)?;
    // Prepare durable bytes and a receipt before touching hook authority. An
    // activation failure leaves the installed component file unchanged.
    let result = (|| {
        let mut prepared = tempfile::NamedTempFile::new_in(parent).map_err(io_error)?;
        prepared
            .write_all(&bytes)
            .and_then(|()| prepared.as_file().sync_all())
            .map_err(io_error)?;
        let previous = if destination.exists() {
            Some(package::file_record(
                &destination,
                package::ONLINE_CLIENT_SOURCE,
            )?)
        } else {
            None
        };
        let receipt_path = state_root.join("runtime-update-online-receipt.json");
        let mut receipt = json!({"schema":1,"kind":"codlet-online-runtime-update","candidateId":staged.candidate.id,
            "version":staged.candidate.version,"manifestSha256":staged.manifest_sha256,"sourceSha256":source_record.sha256,
            "phase":"prepared","nativeSessionPreserved":false,"updatedAt":super::now_ms()});
        package::atomic_json(&receipt_path, &receipt)?;
        // Recheck the unchanged transport and destination immediately before
        // admission closes. No code is reissued after an uncertain response.
        if !compatible(root, staged)? {
            return Err(error(
                "runtime_update_changed",
                "Resident Core changed after online preflight.",
            ));
        }
        if let Some(record) = &previous
            && package::file_record(&destination, package::ONLINE_CLIENT_SOURCE)? != *record
        {
            return Err(error(
                "runtime_update_changed",
                "Installed Core source changed after preflight.",
            ));
        }
        let takeover = target
            .replace_core_code(code, &staged.candidate.version)
            .map_err(|failure| error(failure.code, failure.message))?;
        if takeover["outcome"] != "applied" {
            receipt["phase"] = json!("onlineNotApplied");
            receipt["takeover"] = takeover.clone();
            receipt["updatedAt"] = json!(super::now_ms());
            package::atomic_json(&receipt_path, &receipt)?;
            return Err(error(
                if takeover["outcome"] == "degraded" {
                    "client_bridge_uncertain"
                } else {
                    "core_update_not_applied"
                },
                "Native source takeover did not confirm application; the receipt preserves its exact outcome.",
            ));
        }
        receipt["phase"] = json!("onlineApplied");
        receipt["nativeSessionPreserved"] = json!(true);
        receipt["takeover"] = takeover;
        receipt["updatedAt"] = json!(super::now_ms());
        // Once acknowledged, resume admits new writes. Never speculatively
        // reverse the live module because a subsequent disk rename failed.
        let persisted = prepared.persist(&destination).is_ok();
        receipt["persistencePending"] = json!(!persisted);
        let pin = InstalledPin {
            schema: 1,
            version: staged.candidate.version.clone(),
            contract: staged.manifest.online.clone().expect("online preflight"),
            source: source_record.clone(),
            resident_files: staged
                .manifest
                .files
                .iter()
                .filter(|file| {
                    file.path != package::ONLINE_CLIENT_SOURCE
                        && !staged
                            .manifest
                            .online
                            .as_ref()
                            .expect("online preflight")
                            .modules
                            .iter()
                            .any(|module| module.path == file.path)
                })
                .cloned()
                .collect(),
            modules: prior_modules,
        };
        let pin_persisted =
            persisted && package::atomic_json(&parent.join("activation.json"), &pin).is_ok();
        receipt["persistencePending"] = json!(!persisted || !pin_persisted);
        let journal_persisted = package::atomic_json(&receipt_path, &receipt).is_ok();
        Ok(RuntimeActivation {
            mode: "online".into(),
            version: staged.candidate.version.clone(),
            components: vec!["native-client-source".into()],
            retained_components: retained_components(),
            next_start_reason: None,
            persistence_pending: !persisted || !pin_persisted || !journal_persisted,
        })
    })();
    drop(lock);
    // Remove only this exact lock's bytes; another owner cannot be unlinked.
    if std::fs::read(&lock_path).is_ok_and(|current| current == lock_bytes) {
        let _ = std::fs::remove_file(lock_path);
    }
    result
}

pub(super) fn apply_modules(
    root: &Path,
    state_root: &Path,
    staged: &package::StagedRuntime,
    target: &crate::client_bridge::ClientSourceRuntime,
    shared: &std::sync::Arc<std::sync::Mutex<super::State>>,
) -> Result<RuntimeActivation> {
    let request = super::modules::prepare(staged, target)?;
    if !compatible(root, staged)? {
        return Err(error(
            "core_update_next_start_required",
            "Resident Core changed during module preflight.",
        ));
    }
    let parent = root.join("runtime/core-modules");
    package::no_redirect_ancestors(&parent)?;
    std::fs::create_dir_all(&parent).map_err(io_error)?;
    package::canonical_directory(&parent)?;
    let lock_path = root.join(".codlet-runtime-update.lock.json");
    let mut lock = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)
        .map_err(|failure| {
            if failure.kind() == std::io::ErrorKind::AlreadyExists {
                error("runtime_update_locked", "Another transaction owns Core.")
            } else {
                io_error(failure)
            }
        })?;
    let lock_bytes=serde_json::to_vec(&json!({"schema":1,"kind":"codlet-online-modules-lock","id":request.id,"pid":std::process::id()})).expect("lock serializes");
    lock.write_all(&lock_bytes)
        .and_then(|()| lock.sync_all())
        .map_err(io_error)?;
    let result = (|| {
        let mut module_pins = load_pin(root)?.map_or_else(Vec::new, |pin| pin.modules);
        let mut prepared = Vec::new();
        let contract = staged
            .manifest
            .online
            .as_ref()
            .expect("verified online contract");
        let source_record = staged
            .manifest
            .files
            .iter()
            .find(|file| file.path == package::ONLINE_CLIENT_SOURCE)
            .expect("verified source")
            .clone();
        let files = std::iter::once(("client-source", &source_record)).chain(
            contract.modules.iter().map(|module| {
                (
                    module.id.as_str(),
                    staged
                        .manifest
                        .files
                        .iter()
                        .find(|file| file.path == module.path)
                        .expect("verified module"),
                )
            }),
        );
        for (id, record) in files {
            let code = if id == "client-source" {
                &request.client_source
            } else {
                request.modules.get(id).expect("prepared module")
            };
            if format!("{:x}", sha2::Sha256::digest(code.as_bytes())) != record.sha256 {
                return Err(error(
                    "core_modules_preflight_changed",
                    "Core module differs from its prepared bytes.",
                ));
            }
            let destination = root.join(&record.path);
            package::no_redirect_ancestors(&destination)?;
            let previous = if destination.exists() {
                Some(package::file_record(&destination, &record.path)?)
            } else {
                None
            };
            let mut temporary = tempfile::NamedTempFile::new_in(&parent).map_err(io_error)?;
            temporary
                .write_all(code.as_bytes())
                .and_then(|()| temporary.as_file().sync_all())
                .map_err(io_error)?;
            prepared.push((destination, record.clone(), previous, temporary));
            if id != "client-source" {
                module_pins.retain(|pin| pin.id != id);
                module_pins.push(InstalledModule {
                    id: id.into(),
                    file: record.clone(),
                });
            }
        }
        let receipt_path = state_root.join("runtime-update-online-receipt.json");
        let mut receipt = json!({"schema":1,"kind":"codlet-online-runtime-update","id":request.id,"candidateId":staged.candidate.id,
            "version":request.version,"manifestSha256":staged.manifest_sha256,"phase":"waitingForForeground","components":request.modules.keys().collect::<Vec<_>>(),"updatedAt":super::now_ms()});
        package::atomic_json(&receipt_path, &receipt)?;
        let completion = super::modules::foreground(shared, request.clone());
        let outcome = match completion {
            super::OnlineCoreModulesCompletion::Applied {
                receipt: foreground_receipt,
            } => match target.confirm_core_code(&request.client_source) {
                Ok(native) => {
                    receipt["foreground"] = foreground_receipt;
                    receipt["native"] = native;
                    "onlineApplied"
                }
                Err(failure) => {
                    receipt["error"] = json!(failure.code);
                    "unknown"
                }
            },
            super::OnlineCoreModulesCompletion::RolledBack { error } => {
                receipt["error"] = json!(error);
                "rolledBack"
            }
            super::OnlineCoreModulesCompletion::Rejected { error } => {
                receipt["error"] = json!(error);
                "rejected"
            }
            super::OnlineCoreModulesCompletion::NextStart { reason } => {
                receipt["error"] = json!(reason);
                "nextStart"
            }
            super::OnlineCoreModulesCompletion::Unknown { error } => {
                receipt["error"] = json!(error);
                "unknown"
            }
        };
        receipt["phase"] = json!(outcome);
        receipt["updatedAt"] = json!(super::now_ms());
        if outcome != "onlineApplied" {
            package::atomic_json(&receipt_path, &receipt)?;
            if outcome == "unknown" {
                let mut state = shared.lock().expect("update owner");
                state.install_blocked = true;
                state.status.install_available = false;
                state.status.activation = Some(RuntimeActivation {
                    mode: "unknown".into(),
                    version: request.version.clone(),
                    components: request.modules.keys().cloned().collect(),
                    retained_components: retained_components(),
                    next_start_reason: Some("Foreground takeover outcome is not confirmed.".into()),
                    persistence_pending: true,
                });
            }
            return Err(error(
                if outcome == "unknown" {
                    "core_modules_takeover_unknown"
                } else if outcome == "nextStart" {
                    "core_update_next_start_required"
                } else {
                    "core_modules_not_applied"
                },
                receipt["error"]
                    .as_str()
                    .unwrap_or("Core module takeover was not applied."),
            ));
        }
        // A positive foreground acknowledgment is the only authority to publish
        // these exact immutable files. Every uncertain persistence result is
        // explicit; it never authorizes replaying the module/source transaction.
        let mut persisted = true;
        for (destination, record, previous, temporary) in prepared {
            let unchanged = match previous {
                Some(previous) => package::file_record(&destination, &record.path)
                    .is_ok_and(|actual| actual == previous),
                None => !destination.exists(),
            };
            if !unchanged || temporary.persist(destination).is_err() {
                persisted = false;
                break;
            }
        }
        let pin = InstalledPin {
            schema: 1,
            version: request.version.clone(),
            contract: contract.clone(),
            source: source_record,
            resident_files: staged
                .manifest
                .files
                .iter()
                .filter(|file| {
                    file.path != package::ONLINE_CLIENT_SOURCE
                        && !contract
                            .modules
                            .iter()
                            .any(|module| module.path == file.path)
                })
                .cloned()
                .collect(),
            modules: module_pins,
        };
        let pin_persisted =
            persisted && package::atomic_json(&parent.join("activation.json"), &pin).is_ok();
        receipt["nativeSessionPreserved"] = json!(true);
        receipt["persistencePending"] = json!(!pin_persisted);
        let journal_persisted = package::atomic_json(&receipt_path, &receipt).is_ok();
        let components: Vec<String> = std::iter::once("native-client-source".into())
            .chain(request.modules.keys().cloned())
            .collect();
        Ok(RuntimeActivation {
            mode: "online".into(),
            version: request.version,
            retained_components: retained_components()
                .into_iter()
                .filter(|id| !components.contains(id))
                .collect(),
            components,
            next_start_reason: None,
            persistence_pending: !pin_persisted || !journal_persisted,
        })
    })();
    drop(lock);
    if std::fs::read(&lock_path).is_ok_and(|current| current == lock_bytes) {
        let _ = std::fs::remove_file(lock_path);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binary_or_bootstrap_changes_cannot_claim_online_activation() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("codlet.exe"), b"old-transport").unwrap();
        let old = package::file_record(&root.path().join("codlet.exe"), "codlet.exe").unwrap();
        let mut staged = package::StagedRuntime {
            directory: root.path().to_owned(),
            manifest: package::RuntimePackageManifest {
                schema: 1,
                kind: "codlet-runtime-update".into(),
                version: "1.0.1".into(),
                platform: super::super::PLATFORM.into(),
                profile: RuntimePayloadProfile::Portable,
                runtime: package::NodeRuntime {
                    version: "24.18.1".into(),
                    executable_sha256: "a".repeat(64),
                    license_sha256: "b".repeat(64),
                    mode: package::NodeRuntimeMode::Managed,
                },
                files: vec![old],
                online: Some(package::OnlineRuntime::current()),
            },
            manifest_sha256: "a".repeat(64),
            candidate: super::super::RuntimeUpdateCandidate {
                online_only: false,
                id: "a".repeat(64),
                version: "1.0.1".into(),
                platform: super::super::PLATFORM.into(),
                size: 1,
                sha256: "b".repeat(64),
                release_url: None,
            },
        };
        assert!(compatible(root.path(), &staged).unwrap());
        staged.manifest.online.as_mut().unwrap().bootstrap_sha256 = "f".repeat(64);
        assert!(!compatible(root.path(), &staged).unwrap());
        staged.manifest.online = Some(package::OnlineRuntime::current());
        std::fs::write(root.path().join("codlet.exe"), b"new-transport").unwrap();
        assert!(!compatible(root.path(), &staged).unwrap());
    }
}
