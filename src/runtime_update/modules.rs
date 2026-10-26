//! Immutable verified module overlays and the foreground installation mailbox.
use super::{Result, error, package};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

pub(super) const MODULE_LIMIT: usize = 11;
const PATHS: [(&str, &str); MODULE_LIMIT] = [
    (
        "renderer-bootstrap",
        "runtime/core-modules/renderer-bootstrap.js",
    ),
    (
        "renderer-helpers",
        "runtime/core-modules/renderer-helpers.js",
    ),
    ("renderer-ui", "runtime/core-modules/renderer-ui.js"),
    ("renderer-facade", "runtime/core-modules/renderer-facade.js"),
    ("renderer-page", "runtime/core-modules/renderer-page.js"),
    ("renderer-i18n", "runtime/core-modules/renderer-i18n.js"),
    (
        "renderer-codex-sdk",
        "runtime/core-modules/renderer-codex-sdk.js",
    ),
    (
        "renderer-core-services",
        "runtime/core-modules/renderer-core-services.cjs",
    ),
    (
        "core-ui-provider",
        "runtime/core-modules/core-ui-provider.cjs",
    ),
    (
        "core-desktop-provider",
        "runtime/core-modules/core-desktop-provider.cjs",
    ),
    ("host-bootstrap", "runtime/core-modules/host-bootstrap.cjs"),
];
pub(super) fn module_paths() -> impl Iterator<Item = (&'static str, &'static str)> {
    PATHS.into_iter()
}
pub(super) fn module_path(id: &str) -> Option<&'static str> {
    PATHS
        .iter()
        .find(|(name, _)| *name == id)
        .map(|(_, path)| *path)
}
const MODULE_BYTES: u64 = 8 * 1024 * 1024;
static ACTIVE: OnceLock<Mutex<ModuleOverlay>> = OnceLock::new();
static VERIFIED: OnceLock<Mutex<BTreeSet<(String, String)>>> = OnceLock::new();
static INSTALLED: OnceLock<BTreeMap<String, String>> = OnceLock::new();
#[derive(Default)]
struct ModuleOverlay {
    current: Option<BTreeMap<String, String>>,
    owner: Option<String>,
}
impl ModuleOverlay {
    fn claim(&mut self, id: &str) -> Result<Option<BTreeMap<String, String>>> {
        if self.owner.is_some() {
            return Err(error(
                "core_modules_owner_busy",
                "Another foreground transaction owns the Core module set.",
            ));
        }
        let previous = self.current.clone();
        self.owner = Some(id.into());
        Ok(previous)
    }
    fn retire(&mut self, id: &str, previous: Option<BTreeMap<String, String>>, committed: bool) {
        if self.owner.as_deref() == Some(id) {
            if !committed {
                self.current = previous;
            }
            self.owner = None;
        }
    }
}
fn active() -> &'static Mutex<ModuleOverlay> {
    ACTIVE.get_or_init(|| Mutex::new(ModuleOverlay::default()))
}
fn verified() -> &'static Mutex<BTreeSet<(String, String)>> {
    VERIFIED.get_or_init(|| Mutex::new(BTreeSet::new()))
}
fn digest(source: &str) -> String {
    format!("{:x}", Sha256::digest(source.as_bytes()))
}
fn remember(modules: &BTreeMap<String, String>) {
    if let Ok(mut hashes) = verified().lock() {
        for (id, source) in modules {
            hashes.insert((id.clone(), digest(source)));
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct OnlineCoreModulesRequest {
    pub id: String,
    pub version: String,
    pub module_abi: u32,
    pub modules: BTreeMap<String, String>,
    pub client_source: String,
    /// One transaction budget; callers reserve time for restoring the old set.
    pub deadline_unix_ms: u64,
}
#[derive(Debug)]
pub(crate) enum OnlineCoreModulesCompletion {
    Applied { receipt: Value },
    RolledBack { error: String },
    Rejected { error: String },
    NextStart { reason: String },
    Unknown { error: String },
}
pub(crate) struct CoreModulesGuard {
    previous: Option<BTreeMap<String, String>>,
    committed: bool,
    owner: String,
}
impl CoreModulesGuard {
    pub(crate) fn commit(mut self) {
        self.committed = true;
    }
}
impl Drop for CoreModulesGuard {
    fn drop(&mut self) {
        if let Ok(mut held) = active().lock() {
            held.retire(&self.owner, self.previous.take(), self.committed);
        }
    }
}
pub(crate) fn activate_online_modules(
    request: &OnlineCoreModulesRequest,
) -> Result<CoreModulesGuard> {
    if request.module_abi != 1
        || request.modules.is_empty()
        || request.modules.len() > MODULE_LIMIT
        || request
            .modules
            .iter()
            .any(|(id, source)| module_path(id).is_none() || source.len() as u64 > MODULE_BYTES)
        || request.client_source.len() > 1024 * 1024
    {
        return Err(error(
            "core_modules_contract_invalid",
            "Unsupported verified Core module overlay.",
        ));
    }
    // Seed the existing verified installation before replacing the active map;
    // a later partial module update must retain previously updated components.
    let prior = active()
        .lock()
        .map_err(|_| {
            error(
                "core_modules_owner_poisoned",
                "Core module owner is unavailable.",
            )
        })?
        .claim(&request.id)?;
    let guard = CoreModulesGuard {
        previous: prior.clone(),
        committed: false,
        owner: request.id.clone(),
    };
    let mut next = prior
        .clone()
        .unwrap_or_else(|| installed_current().unwrap_or_default());
    remember(&next);
    next.extend(request.modules.clone());
    next.insert("client-source".into(), request.client_source.clone());
    remember(&next);
    active()
        .lock()
        .map_err(|_| {
            error(
                "core_modules_owner_poisoned",
                "Core module owner is unavailable.",
            )
        })?
        .current = Some(next);
    Ok(guard)
}
fn installed_current() -> Result<BTreeMap<String, String>> {
    if let Some(modules) = INSTALLED.get() {
        return Ok(modules.clone());
    }
    let executable = std::env::current_exe().map_err(super::io_error)?;
    let root = executable.parent().ok_or_else(|| {
        error(
            "core_modules_location_invalid",
            "Core module installation is unavailable.",
        )
    })?;
    let modules = installed_modules(root)?;
    let _ = INSTALLED.set(modules.clone());
    Ok(modules)
}
pub(crate) fn core_module_override(id: &str) -> Option<String> {
    active().lock().ok()?.current.as_ref()?.get(id).cloned()
}
pub(crate) fn core_module_source(id: &str, embedded: &str) -> String {
    if let Some(source) = core_module_override(id) {
        return source;
    }
    if let Ok(modules) = installed_current() {
        remember(&modules);
        if let Some(source) = modules.get(id) {
            return source.clone();
        }
    }
    embedded.into()
}
pub(crate) fn core_module_source_trusted(id: &str, source: &str, embedded: &str) -> bool {
    if source == embedded {
        return true;
    }
    if let Ok(modules) = installed_current() {
        remember(&modules)
    }
    verified()
        .lock()
        .is_ok_and(|hashes| hashes.contains(&(id.into(), digest(source))))
}
pub(super) fn installed_modules(root: &Path) -> Result<BTreeMap<String, String>> {
    if super::online::installed_source(root)?.is_none() {
        return Ok(BTreeMap::new());
    }
    let Some(pin) = super::online::load_pin(root)? else {
        return Ok(BTreeMap::new());
    };
    read_pinned_modules(root, &pin.modules)
}
pub(super) fn read_pinned_modules(
    root: &Path,
    pins: &[super::online::InstalledModule],
) -> Result<BTreeMap<String, String>> {
    let mut modules = BTreeMap::new();
    for record in pins {
        if module_path(&record.id) != Some(record.file.path.as_str())
            || record.file.bytes > MODULE_BYTES
            || modules.contains_key(&record.id)
            || package::file_record(&root.join(&record.file.path), &record.file.path)?
                != record.file
        {
            return Err(error(
                "core_modules_pin_changed",
                "Installed Core module differs from its verified pin.",
            ));
        }
        let code = String::from_utf8(package::read_file(
            &root.join(&record.file.path),
            MODULE_BYTES,
        )?)
        .map_err(|_| error("core_modules_pin_invalid", "Core module must be UTF-8."))?;
        modules.insert(record.id.clone(), code);
    }
    Ok(modules)
}
pub(super) fn prepare(
    staged: &package::StagedRuntime,
    target: &crate::client_bridge::ClientSourceRuntime,
) -> Result<OnlineCoreModulesRequest> {
    package::recheck_staged(staged)?;
    let contract = staged.manifest.online.as_ref().ok_or_else(|| {
        error(
            "core_modules_contract_invalid",
            "Online module contract is missing.",
        )
    })?;
    if contract.module_abi != 1 {
        return Err(error(
            "core_update_next_start_required",
            "Core module ABI changed.",
        ));
    }
    let mut modules = BTreeMap::new();
    let mut syntax_paths = vec![];
    for module in &contract.modules {
        let record = staged
            .manifest
            .files
            .iter()
            .find(|file| file.path == module.path)
            .ok_or_else(|| {
                error(
                    "core_modules_contract_invalid",
                    "Core module file is missing.",
                )
            })?;
        if record.bytes > MODULE_BYTES {
            return Err(error(
                "runtime_update_size_limit",
                "Core module exceeds its size limit.",
            ));
        }
        let file = staged.directory.join(&module.path);
        let code = String::from_utf8(package::read_file(&file, MODULE_BYTES)?).map_err(|_| {
            error(
                "core_modules_contract_invalid",
                "Core module must be UTF-8.",
            )
        })?;
        modules.insert(module.id.clone(), code);
        syntax_paths.push(file);
    }
    let source = staged.directory.join(package::ONLINE_CLIENT_SOURCE);
    syntax_paths.push(source.clone());
    target
        .check_core_module_syntax(&syntax_paths)
        .map_err(|failure| error(failure.code, failure.message))?;
    let client_source =
        String::from_utf8(package::read_file(&source, 1024 * 1024)?).map_err(|_| {
            error(
                "core_modules_contract_invalid",
                "Core client source must be UTF-8.",
            )
        })?;
    target
        .preflight_core_source(&client_source)
        .map_err(|failure| error(failure.code, failure.message))?;
    Ok(OnlineCoreModulesRequest {
        id: format!("core-online-{}-{}", std::process::id(), super::now_ms()),
        version: staged.candidate.version.clone(),
        module_abi: contract.module_abi,
        modules,
        client_source,
        deadline_unix_ms: super::now_ms() + 180_000,
    })
}

pub(super) fn foreground(
    shared: &std::sync::Arc<Mutex<super::State>>,
    request: OnlineCoreModulesRequest,
) -> OnlineCoreModulesCompletion {
    let budget =
        std::time::Duration::from_millis(request.deadline_unix_ms.saturating_sub(super::now_ms()));
    foreground_wait(shared, request, budget)
}
pub(super) fn foreground_wait(
    shared: &std::sync::Arc<Mutex<super::State>>,
    request: OnlineCoreModulesRequest,
    budget: std::time::Duration,
) -> OnlineCoreModulesCompletion {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let version = request.version.clone();
    let components = request.modules.keys().cloned().collect();
    let previous_activation = {
        let mut state = shared.lock().expect("update owner");
        let previous = state.status.activation.clone();
        state.online_modules = Some(super::PendingOnlineModules {
            request,
            taken: false,
            completion: Some(sender),
        });
        previous
    };
    let completion = match receiver.recv_timeout(budget) {
        Ok(completion) => completion,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            // Retain this exact mailbox after the visible deadline. A late
            // definitive receipt settles the original operation; it does not
            // authorize a second evaluation or retirement transaction.
            {
                let mut state = shared.lock().expect("update owner");
                state.install_blocked = true;
                state.status.install_available = false;
                state.status.phase = super::RuntimeUpdatePhase::Failed;
                state.status.error = Some(error(
                    "core_modules_takeover_unknown",
                    "Foreground Core module deadline elapsed; waiting for its original receipt without replay.",
                ));
                state.status.activation = Some(super::RuntimeActivation {
                    mode: "unknown".into(),
                    version,
                    components,
                    retained_components: super::online::retained_components(),
                    next_start_reason: Some("Foreground takeover outcome is not confirmed.".into()),
                    persistence_pending: true,
                });
            }
            receiver.recv().unwrap_or_else(|_|OnlineCoreModulesCompletion::Unknown{error:"Foreground Core module takeover was not acknowledged; no second transaction is allowed.".into()})
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            OnlineCoreModulesCompletion::Unknown {
                error: "Foreground completion channel is unavailable.".into(),
            }
        }
    };
    let mut state = shared.lock().expect("update owner");
    if matches!(completion, OnlineCoreModulesCompletion::Unknown { .. }) {
        state.install_blocked = true;
        state.status.install_available = false;
    } else {
        state.install_blocked = false;
        state.status.install_available = true;
        if matches!(
            completion,
            OnlineCoreModulesCompletion::RolledBack { .. }
                | OnlineCoreModulesCompletion::Rejected { .. }
                | OnlineCoreModulesCompletion::NextStart { .. }
        ) {
            state.status.activation = previous_activation;
        }
    }
    state.online_modules = None;
    completion
}

#[cfg(test)]
mod overlay_tests {
    use super::*;
    use std::sync::{Arc, mpsc};

    #[test]
    fn partial_transactions_capture_the_latest_committed_overlay_and_rollback_to_it() {
        let overlay = Arc::new(Mutex::new(ModuleOverlay {
            current: Some(BTreeMap::from([(
                "renderer-ui".into(),
                "initial-ui".into(),
            )])),
            owner: None,
        }));
        let previous = overlay.lock().unwrap().claim("first").unwrap();
        overlay.lock().unwrap().current = Some(BTreeMap::from([
            ("renderer-ui".into(), "updated-ui".into()),
            ("renderer-i18n".into(), "updated-i18n".into()),
        ]));
        let (send, receive) = mpsc::sync_channel(1);
        let competing = overlay.clone();
        let contender = std::thread::spawn(move || {
            send.send(competing.lock().unwrap().claim("second").unwrap_err().code)
                .unwrap();
        });
        assert_eq!(receive.recv().unwrap(), "core_modules_owner_busy");
        contender.join().unwrap();
        overlay.lock().unwrap().retire("first", previous, true);

        let mut held = overlay.lock().unwrap();
        let committed = held.current.clone();
        let previous = held.claim("second").unwrap();
        assert_eq!(previous, committed);
        let mut partial = previous.clone().unwrap();
        partial.insert("renderer-ui".into(), "candidate-ui".into());
        assert_eq!(
            partial.get("renderer-i18n").map(String::as_str),
            Some("updated-i18n")
        );
        held.current = Some(partial);
        held.retire("retired-owner", None, false);
        assert_eq!(held.owner.as_deref(), Some("second"));
        held.retire("second", previous, false);
        assert_eq!(held.current, committed);
        assert!(held.owner.is_none());
    }
}
