//! Generation-owned event logs, callback tasks and streaming OS processes.
//! The Core service dispatcher authenticates the caller and checks fresh grants.
//! This module additionally checks every resource's exact owner and policy.
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde_json::{Value, json};

mod events;
mod processes;
mod tasks;
#[cfg(test)]
mod tests;

#[derive(Clone, Debug)]
pub struct ResourceOwner {
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
    retired: BTreeSet<OwnerKey>,
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
        check(&state, &consumer)?;
        check(&state, &provider)?;
        let value = events::invoke_for(&mut state.events, &consumer, &provider, method, params)?;
        self.shared.changed.notify_all();
        Ok(value)
    }

    pub fn invoke(&self, owner: &ResourceOwner, method: &str, params: Value) -> Result<Value> {
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
        if method.starts_with("processes.") {
            return processes::invoke(self, owner, method, params);
        }
        let key = owner.key();
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
            if state.retired.len() >= 8192 && !state.retired.contains(&key) {
                return Err(ServiceError::new(
                    "resource_limit",
                    "retired owner identity bound reached",
                ));
            }
            state.retired.insert(key.clone());
            state.events.retire(&key);
            state.tasks.retire(&key);
            state.processes.retire(&key)
        };
        self.shared.changed.notify_all();
        for process in &processes {
            process.request_close();
        }
        let mut complete = true;
        for process in processes {
            complete &= process.close().is_ok();
        }
        if !complete {
            return Err(ServiceError::new(
                "cleanup_incomplete",
                "a managed process did not confirm cleanup",
            ));
        }
        Ok(json!({"retired":true,"cleanupComplete":true}))
    }

    pub fn shutdown(&self) -> Result<Value> {
        let processes = {
            let mut state = self.shared.state.lock().unwrap_or_else(|p| p.into_inner());
            state.closing = true;
            state.events = events::Events::default();
            state.tasks = tasks::Tasks::default();
            state.processes.drain()
        };
        self.shared.changed.notify_all();
        for process in &processes {
            process.request_close();
        }
        let mut complete = true;
        for process in processes {
            complete &= process.close().is_ok();
        }
        if !complete {
            return Err(ServiceError::new(
                "cleanup_incomplete",
                "resource shutdown could not confirm process cleanup",
            ));
        }
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
