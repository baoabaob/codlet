//! Generation-owned event logs, callback tasks and streaming OS processes.
//! The Core service dispatcher authenticates the caller and checks fresh grants.
//! This module additionally checks every resource's exact owner and policy.
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde_json::{Value, json};

// Only explicit plugin service owners use this budget; Native transport and
// existing Native content never enter CoreResources.
const MAX_RESOURCE_OWNERS: usize = 8192;

mod events;
mod processes;
mod tasks;
#[cfg(test)]
mod tests;

#[derive(Clone, Debug)]
pub struct ResourceOwner {
    pub client_permissions: bool,
    pub plugin_id: String,
    pub source_identity: String,
    pub generation: u64,
    pub default_cwd: PathBuf,
    pub executables: Vec<PathBuf>,
    pub cwd_roots: Vec<PathBuf>,
    pub env_keys: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct OwnerKey {
    plugin: String,
    source: String,
    generation: u64,
}
impl ResourceOwner {
    fn key(&self) -> OwnerKey {
        OwnerKey {
            plugin: self.plugin_id.clone(),
            source: self.source_identity.clone(),
            generation: self.generation,
        }
    }
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
#[error("{code}: {message}")]
pub struct ServiceError {
    pub code: &'static str,
    pub message: String,
}
impl ServiceError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
type Result<T> = std::result::Result<T, ServiceError>;

#[derive(Default)]
struct State {
    closing: bool,
    owners: BTreeSet<OwnerKey>,
    retired: BTreeSet<OwnerKey>,
    retired_hosts: BTreeSet<OwnerKey>,
    events: events::Events,
    tasks: tasks::Tasks,
    processes: processes::Processes,
}
#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    changed: Condvar,
}
#[derive(Clone, Default)]
pub struct CoreResources {
    shared: Arc<Shared>,
}

impl CoreResources {
    #[cfg(test)]
    pub(crate) fn resources_for_test(&self, owner: &ResourceOwner) -> Vec<Value> {
        let key = owner.key();
        let state = self.shared.state.lock().unwrap_or_else(|p| p.into_inner());
        let mut entries = state.events.list(&key);
        entries.extend(state.tasks.list_resources(&key));
        entries.extend(state.processes.list(&key));
        entries
    }

    /// The dispatcher must validate the consumer's requires and the provider's
    /// matching provides before calling this entry point. Subsequent reads use
    /// the consumer-owned subscription; retiring the pinned provider closes it.
    pub fn invoke_events_for(
        &self,
        consumer: &ResourceOwner,
        provider: &ResourceOwner,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        if method != "events.subscribe" {
            return Err(invalid(
                "cross-owner event admission only supports subscribe",
            ));
        }
        let consumer = consumer.key();
        let provider = provider.key();
        let mut state = self.shared.state.lock().unwrap_or_else(|p| p.into_inner());
        admit(&mut state, &consumer)?;
        check(&state, &provider)?;
        let value = events::invoke_for(&mut state.events, &consumer, &provider, method, params)?;
        self.shared.changed.notify_all();
        Ok(value)
    }

    pub fn invoke(&self, owner: &ResourceOwner, method: &str, params: Value) -> Result<Value> {
        self.invoke_from(owner, method, params, false)
    }

    pub(crate) fn invoke_from(
        &self,
        owner: &ResourceOwner,
        method: &str,
        params: Value,
        host: bool,
    ) -> Result<Value> {
        if owner.plugin_id.is_empty()
            || owner.plugin_id.len() > 256
            || owner.source_identity.is_empty()
            || owner.source_identity.len() > 4096
        {
            return Err(invalid("invalid authenticated resource owner"));
        }
        if serde_json::to_vec(&params)
            .map_err(|_| invalid("invalid params"))?
            .len()
            > 512 * 1024
        {
            return Err(ServiceError::new(
                "resource_limit",
                "resource request exceeds 512 KiB",
            ));
        }
        let key = owner.key();
        {
            let mut state = self.shared.state.lock().unwrap_or_else(|p| p.into_inner());
            admit(&mut state, &key)?;
            if host && state.retired_hosts.contains(&key) {
                return Err(ServiceError::new(
                    "stale_generation",
                    "the resource Host has retired",
                ));
            }
        }
        if method.starts_with("processes.") {
            return processes::invoke(self, owner, method, params, host);
        }
        let wait_ms = params.get("waitMs").and_then(Value::as_u64).unwrap_or(0);
        if wait_ms > 1000 {
            return Err(invalid("waitMs must be at most 1000; repeat bounded reads"));
        }
        let deadline = Instant::now() + Duration::from_millis(wait_ms);
        let mut state = self.shared.state.lock().unwrap_or_else(|p| p.into_inner());
        loop {
            check(&state, &key)?;
            let result = if method.starts_with("events.") {
                events::invoke(&mut state.events, &key, method, params.clone())?
            } else if method.starts_with("tasks.") {
                tasks::invoke(&mut state.tasks, &key, method, params.clone())?
            } else if method == "resources.list" {
                let mut entries = state.events.list(&key);
                entries.extend(state.tasks.list_resources(&key));
                entries.extend(state.processes.list(&key));
                json!({"resources":entries,"bounded":true})
            } else {
                return Err(ServiceError::new(
                    "method_not_found",
                    "unknown resource method",
                ));
            };
            let empty_read = matches!(method, "events.read" | "tasks.claim")
                && result
                    .get(if method == "events.read" {
                        "events"
                    } else {
                        "tasks"
                    })
                    .and_then(Value::as_array)
                    .is_some_and(Vec::is_empty)
                && result.get("terminal").is_none_or(Value::is_null);
            if !empty_read || wait_ms == 0 || Instant::now() >= deadline {
                self.shared.changed.notify_all();
                return Ok(result);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            let (next, _) = self
                .shared
                .changed
                .wait_timeout(state, remaining)
                .unwrap_or_else(|p| p.into_inner());
            state = next;
        }
    }

    /// Must be called on revoke, reload, disable and owner/document retirement.
    /// Retired identities are retained so an old caller cannot recreate resources.
    pub fn retire(&self, owner: &ResourceOwner) -> Result<Value> {
        let key = owner.key();
        let processes = {
            let mut state = self.shared.state.lock().unwrap_or_else(|p| p.into_inner());
            // Admission reserves the history slot before an owner can create
            // resources. Cleanup must remain available when that budget is full.
            // An unseen owner at capacity has no resources and cannot be admitted.
            if state.owners.contains(&key) || state.owners.len() < MAX_RESOURCE_OWNERS {
                state.owners.insert(key.clone());
                state.retired.insert(key.clone());
            }
            state.events.retire(&key);
            state.tasks.retire(&key);
            state.processes.retiring(&key, false)
        };
        self.shared.changed.notify_all();
        self.close_processes(processes)?;
        Ok(json!({"retired":true,"cleanupComplete":true}))
    }

    /// A combined plugin's renderer may still own its generation. Only processes
    /// dispatched by the retired Host are closed here.
    pub(crate) fn retire_host_processes(&self, owner: &ResourceOwner) -> Result<Value> {
        let processes = {
            let mut state = self.shared.state.lock().unwrap_or_else(|p| p.into_inner());
            let key = owner.key();
            state.retired_hosts.insert(key.clone());
            state.processes.retiring(&key, true)
        };
        self.close_processes(processes)?;
        Ok(json!({"retired":true,"cleanupComplete":true}))
    }

    fn close_processes(&self, processes: Vec<(String, Arc<processes::Process>)>) -> Result<()> {
        for (_, process) in &processes {
            process.request_close();
        }
        let mut complete = true;
        for (id, process) in processes {
            if process.close().is_ok() {
                self.shared
                    .state
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .processes
                    .confirm_closed(&id, &process);
            } else {
                complete = false;
            }
        }
        if complete {
            Ok(())
        } else {
            Err(ServiceError::new(
                "cleanup_incomplete",
                "a managed process scope or I/O worker has not confirmed exit",
            ))
        }
    }

    pub fn shutdown(&self) -> Result<Value> {
        let processes = {
            let mut state = self.shared.state.lock().unwrap_or_else(|p| p.into_inner());
            state.closing = true;
            state.events = events::Events::default();
            state.tasks = tasks::Tasks::default();
            state.processes.retiring_all()
        };
        self.shared.changed.notify_all();
        self.close_processes(processes)?;
        Ok(json!({"closed":true,"cleanupComplete":true}))
    }
}

fn check(state: &State, owner: &OwnerKey) -> Result<()> {
    if state.closing {
        return Err(ServiceError::new(
            "resource_closed",
            "resource service is closing",
        ));
    }
    if state.retired.contains(owner) {
        return Err(ServiceError::new(
            "stale_generation",
            "resource owner has retired",
        ));
    }
    Ok(())
}
fn admit(state: &mut State, owner: &OwnerKey) -> Result<()> {
    check(state, owner)?;
    if !state.owners.contains(owner) && state.owners.len() >= MAX_RESOURCE_OWNERS {
        return Err(ServiceError::new(
            "resource_limit",
            "resource owner identity bound reached",
        ));
    }
    state.owners.insert(owner.clone());
    Ok(())
}
fn decode<T: DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|e| invalid(e.to_string()))
}
fn invalid(message: impl Into<String>) -> ServiceError {
    ServiceError::new("invalid_params", message)
}
fn missing() -> ServiceError {
    ServiceError::new(
        "resource_not_found",
        "resource is unavailable to this owner",
    )
}
fn bounded(value: Option<usize>, default: usize, max: usize) -> Result<usize> {
    let value = value.unwrap_or(default);
    if value == 0 || value > max {
        Err(invalid(format!("limit must be in 1..={max}")))
    } else {
        Ok(value)
    }
}
fn name(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        Err(invalid("name/key must have 1..128 non-control bytes"))
    } else {
        Ok(())
    }
}
fn bytes(value: &Value, max: usize) -> Result<()> {
    if serde_json::to_vec(value)
        .map_err(|_| invalid("invalid JSON"))?
        .len()
        > max
    {
        Err(ServiceError::new(
            "resource_limit",
            "JSON value exceeds its byte limit",
        ))
    } else {
        Ok(())
    }
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn token() -> Result<String> {
    let mut data = [0_u8; 24];
    #[cfg(windows)]
    {
        use windows_sys::Win32::Security::Cryptography::{
            BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
        };
        if unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                data.as_mut_ptr(),
                data.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        } < 0
        {
            return Err(ServiceError::new(
                "random_failed",
                "cannot issue resource token",
            ));
        }
    }
    #[cfg(target_os = "macos")]
    if unsafe { libc::getentropy(data.as_mut_ptr().cast(), data.len()) } != 0 {
        return Err(ServiceError::new(
            "random_failed",
            "cannot issue resource token",
        ));
    }
    Ok(data.iter().map(|byte| format!("{byte:02x}")).collect())
}
