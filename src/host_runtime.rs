//! Optional native plugin executor over Core's raw CDP transport. This module
//! knows no renderer URLs, JavaScript bootstrap, DOM, or official adapters.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::cdp::{BoundedCdpEvents, CdpClient, CdpEventFilter, ClientError, QueuedCdpRequest};
use crate::local_plugins::revalidate_host_executable;
use crate::plugin_execution::{ExecutionState, PluginExecutionObservation};
use crate::plugin_host::{
    HostError, HostEvent, HostExitReport, HostIdentity, HostRpcError, HostSupervisor,
};
use crate::plugins::{LoadedPlugin, Permission};

const TICK: Duration = Duration::from_millis(10);
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PENDING: usize = 4;
const MAX_OUTBOX: usize = 8;
const MAX_HOSTS: usize = 16;
// Leave space for the host identity and the JSONL envelope.
const MAX_PAYLOAD: usize = 1024 * 1024 - 4096;

#[derive(Debug, Clone)]
pub struct HostDiagnostic {
    pub plugin_id: String,
    pub state: ExecutionState,
    pub process_id: Option<u32>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct HostStopReport {
    pub plugin_id: String,
    pub result: Result<HostExitReport, HostError>,
}

#[derive(Default)]
struct Published {
    observations: Vec<PluginExecutionObservation>,
    diagnostics: Vec<HostDiagnostic>,
}

/// One owner thread pumps all host RPC independently of any optional renderer
/// executor. It never creates a thread per request. The handle owns its worker.
pub struct HostRuntime {
    published: Arc<Mutex<Published>>,
    stopping: Arc<AtomicBool>,
    worker: Option<JoinHandle<Vec<HostStopReport>>>,
}

impl HostRuntime {
    pub fn validate_plugins(plugins: &[LoadedPlugin]) -> Result<(), HostError> {
        if plugins.len() > MAX_HOSTS {
            return Err(HostError::new(
                "host_limit",
                "at most 16 native host plugins may run in this executor",
            ));
        }
        let mut ids = std::collections::BTreeSet::new();
        for plugin in plugins {
            if plugin.manifest.host.is_none()
                || plugin.host.is_none()
                || plugin.manifest.renderer.is_some()
                || plugin.source.is_some()
                || !plugin
                    .manifest
                    .permissions
                    .contains(&Permission::HostProcess)
                || !plugin.manifest.requires.is_empty()
                || !plugin.manifest.provides.is_empty()
                || !ids.insert(&plugin.manifest.id)
            {
                return Err(HostError::new(
                    "host_entry_required",
                    format!(
                        "{} must be a distinct, loaded host-only plugin with host.process and no cross-executor declarations",
                        plugin.manifest.id
                    ),
                ));
            }
            HostIdentity {
                plugin_id: plugin.manifest.id.clone(),
                generation: plugin.generation,
            }
            .validate()
            .map_err(|error| HostError::new("invalid_identity", error))?;
        }
        Ok(())
    }

    pub fn start(plugins: Vec<LoadedPlugin>, client: CdpClient) -> Result<Self, HostError> {
        Self::validate_plugins(&plugins)?;
        let published = Arc::new(Mutex::new(Published::default()));
        let stopping = Arc::new(AtomicBool::new(false));
        if plugins.is_empty() {
            return Ok(Self {
                published,
                stopping,
                worker: None,
            });
        }
        let owners: Vec<_> = plugins.into_iter().map(HostOwner::start).collect();
        publish(&published, &owners);
        let worker_published = Arc::clone(&published);
        let worker_stopping = Arc::clone(&stopping);
        let worker = thread::Builder::new()
            .name("codlet-core-host-rpc".into())
            .spawn(move || {
                let mut owners = owners;
                while !worker_stopping.load(Ordering::Acquire) {
                    client.poll_raw_io();
                    for owner in &mut owners {
                        owner.pump(&client);
                    }
                    publish(&worker_published, &owners);
                    thread::sleep(TICK);
                }
                // Broadcast shutdown before waiting on any one child, so every
                // plugin gets the same opportunity to exit cooperatively.
                for owner in &mut owners {
                    if let Some(supervisor) = &mut owner.supervisor {
                        supervisor.begin_stop();
                    }
                }
                let reports = owners.iter_mut().filter_map(HostOwner::stop).collect();
                publish(&worker_published, &owners);
                reports
            })
            .map_err(|error| HostError::new("owner_spawn_failed", error.to_string()))?;
        Ok(Self {
            published,
            stopping,
            worker: Some(worker),
        })
    }

    pub fn observations(&self) -> Vec<PluginExecutionObservation> {
        let mut observations = self
            .published
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .observations
            .clone();
        if !self.stopping.load(Ordering::Acquire)
            && self
                .worker
                .as_ref()
                .is_some_and(|worker| worker.is_finished())
        {
            for observation in &mut observations {
                if matches!(
                    observation.state,
                    ExecutionState::Starting | ExecutionState::Active | ExecutionState::Stopping
                ) {
                    observation.state = ExecutionState::Failed;
                    observation.error =
                        Some("owner_stopped: Core host RPC owner exited unexpectedly".into());
                }
            }
        }
        observations
    }

    pub fn is_starting(&self) -> bool {
        self.observations()
            .iter()
            .any(|observation| observation.state == ExecutionState::Starting)
    }

    pub fn take_diagnostics(&self) -> Vec<HostDiagnostic> {
        std::mem::take(
            &mut self
                .published
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .diagnostics,
        )
    }

    pub fn stop(&mut self) -> Result<Vec<HostStopReport>, HostError> {
        self.stopping.store(true, Ordering::Release);
        self.worker.take().map_or_else(
            || Ok(Vec::new()),
            |worker| {
                worker
                    .join()
                    .map_err(|_| HostError::new("owner_panicked", "Core host RPC owner panicked"))
            },
        )
    }
}

impl Drop for HostRuntime {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn publish(published: &Mutex<Published>, owners: &[HostOwner]) {
    let mut current = published.lock().unwrap_or_else(|p| p.into_inner());
    for (index, owner) in owners.iter().enumerate() {
        if current.observations.get(index).is_none_or(|old| {
            old.state != owner.observation.state || old.error != owner.observation.error
        }) {
            if current.diagnostics.len() == 64 {
                current.diagnostics.remove(0);
            }
            current.diagnostics.push(HostDiagnostic {
                plugin_id: owner.observation.plugin.manifest.id.clone(),
                state: owner.observation.state,
                process_id: owner.observation.process_id,
                error: owner.observation.error.clone(),
            });
        }
    }
    current.observations = owners
        .iter()
        .map(|owner| owner.observation.clone())
        .collect();
}

enum Outbound {
    Reply(u64, Result<Value, HostRpcError>),
    Event(Value),
    SubscriptionEnded(Value),
}

struct HostOwner {
    observation: PluginExecutionObservation,
    supervisor: Option<HostSupervisor>,
    initialize_id: u64,
    initialize_deadline: Instant,
    pending: Vec<(u64, QueuedCdpRequest)>,
    subscription: Option<(u64, BoundedCdpEvents)>,
    subscription_id: u64,
    outbox: VecDeque<Outbound>,
    stop_report: Option<HostStopReport>,
}

impl HostOwner {
    fn start(plugin: LoadedPlugin) -> Self {
        let mut owner = Self {
            observation: PluginExecutionObservation {
                plugin,
                state: ExecutionState::Starting,
                process_id: None,
                error: None,
            },
            supervisor: None,
            initialize_id: 0,
            initialize_deadline: Instant::now() + INITIALIZE_TIMEOUT,
            pending: Vec::new(),
            subscription: None,
            subscription_id: 0,
            outbox: VecDeque::new(),
            stop_report: None,
        };
        let result = (|| {
            let plugin = &owner.observation.plugin;
            let host = plugin.host.as_ref().expect("validated host entry");
            revalidate_host_executable(host)
                .map_err(|error| HostError::new("executable_changed", error.to_string()))?;
            let supervisor = HostSupervisor::spawn(
                HostIdentity {
                    plugin_id: plugin.manifest.id.clone(),
                    generation: plugin.generation,
                },
                &host.executable,
                &host.args,
                &host.root,
            )?;
            owner.observation.process_id = Some(supervisor.process_id());
            owner.supervisor = Some(supervisor);
            owner.initialize_deadline = Instant::now() + INITIALIZE_TIMEOUT;
            owner.initialize_id = owner.supervisor.as_mut().unwrap().send_request(
                "initialize",
                json!({
                    "protocolVersion":1, "coreVersion":env!("CARGO_PKG_VERSION"),
                    "permissions":plugin.manifest.permissions,
                    "methods":["cdp.request","cdp.subscribe","cdp.unsubscribe"],
                }),
                INITIALIZE_TIMEOUT,
            )?;
            Ok::<_, HostError>(())
        })();
        if let Err(error) = result {
            owner.fail(error.to_string());
        }
        owner
    }

    fn pump(&mut self, client: &CdpClient) {
        if matches!(
            self.observation.state,
            ExecutionState::Failed | ExecutionState::Exited
        ) {
            return;
        }
        let Some(supervisor) = &mut self.supervisor else {
            return;
        };
        let events = supervisor.poll();
        if self.observation.state == ExecutionState::Stopping {
            if let Some(report) = supervisor.exit_report() {
                self.stop_report = Some(HostStopReport {
                    plugin_id: self.observation.plugin.manifest.id.clone(),
                    result: Ok(report),
                });
                self.supervisor.take();
                self.observation.state = ExecutionState::Failed;
            }
            return;
        }
        // A terminal event retires the generation before queued requests can act.
        if let Some(error) = events.iter().find_map(|event| match event {
            HostEvent::Failed { error } => Some(error.to_string()),
            HostEvent::Exited { exit_code } => Some(format!("host_exited: {exit_code}")),
            _ => None,
        }) {
            self.fail(error);
            return;
        }
        for event in events {
            match event {
                HostEvent::Request { id, method, params } => {
                    let outcome = self.dispatch(client, id, &method, params);
                    if let Some(outcome) = outcome {
                        self.queue(Outbound::Reply(id, outcome));
                    }
                }
                HostEvent::Response { id, result } if id == self.initialize_id => match result {
                    Ok(value) if value.get("ready") == Some(&Value::Bool(true)) => {
                        match self.supervisor.as_mut().unwrap().mark_ready() {
                            Ok(()) => self.observation.state = ExecutionState::Active,
                            Err(error) => self.fail(error.to_string()),
                        }
                    }
                    Ok(_) => {
                        self.fail("initialize_failed: response must contain ready=true".into())
                    }
                    Err(error) => self.fail(format!(
                        "initialize_failed: {}",
                        error.message.chars().take(4096).collect::<String>()
                    )),
                },
                HostEvent::RequestTimedOut { id } if id == self.initialize_id => {
                    self.fail("initialize_timeout".into())
                }
                // Notifications never authorize Core actions; RPC requires a reply id.
                _ => {}
            }
            if matches!(
                self.observation.state,
                ExecutionState::Stopping | ExecutionState::Failed | ExecutionState::Exited
            ) {
                return;
            }
        }
        let mut index = 0;
        while index < self.pending.len() {
            let outcome = match self.pending[index].1.try_response() {
                Ok(None) => {
                    index += 1;
                    continue;
                }
                Ok(Some(response)) => bounded_result(Ok(response.result.unwrap_or(Value::Null))),
                Err(error) => Err(cdp_error(error)),
            };
            let (id, _) = self.pending.swap_remove(index);
            self.queue(Outbound::Reply(id, outcome));
            if self.observation.state == ExecutionState::Stopping {
                return;
            }
        }
        // Reserve queue space for replies. Pull at most one event per owner tick.
        if self.outbox.len() < MAX_OUTBOX - 1
            && let Some((id, events)) = &self.subscription
        {
            let subscription_id = *id;
            match events.try_event() {
                Ok(Some(event)) => {
                    let params = json!({"subscriptionId":subscription_id,"event":event});
                    if payload_fits(&params) {
                        self.queue(Outbound::Event(params));
                    } else {
                        self.end_subscription("event_too_large");
                    }
                }
                Ok(None) => {}
                Err(error) => self.end_subscription(&error.to_string()),
            }
        }
        if let Some(outbound) = self.outbox.pop_front() {
            let supervisor = self.supervisor.as_mut().unwrap();
            let result = match outbound {
                Outbound::Reply(id, result) => supervisor.respond(id, result),
                Outbound::Event(params) => supervisor.notify("cdp.event", params),
                Outbound::SubscriptionEnded(params) => {
                    supervisor.notify("cdp.subscriptionEnded", params)
                }
            };
            if let Err(error) = result
                && !matches!(error.code, "unknown_request" | "request_expired")
            {
                self.fail(error.to_string());
            }
        }
    }

    fn dispatch(
        &mut self,
        client: &CdpClient,
        id: u64,
        method: &str,
        params: Value,
    ) -> Option<Result<Value, HostRpcError>> {
        if !matches!(method, "cdp.request" | "cdp.subscribe" | "cdp.unsubscribe") {
            return Some(Err(HostRpcError::new(
                "method_not_found",
                "Core does not expose this host method",
            )));
        }
        if !self
            .observation
            .plugin
            .manifest
            .permissions
            .contains(&Permission::CdpRaw)
        {
            return Some(Err(HostRpcError::new(
                "permission_denied",
                "cdp.raw must be declared and granted before using Core CDP",
            )));
        }
        let outcome = (|| match method {
            "cdp.request" => {
                let input: RawRequest = decode_params(params)?;
                input.validate()?;
                if self.pending.len() >= MAX_PENDING {
                    return Err(HostRpcError::new(
                        "request_limit",
                        "this plugin has four pending CDP requests",
                    ));
                }
                let mut deadline = self
                    .supervisor
                    .as_ref()
                    .unwrap()
                    .incoming_deadline(id)
                    .ok_or_else(|| {
                        HostRpcError::new("request_expired", "the Host request has retired")
                    })?;
                deadline = deadline.min(Instant::now() + Duration::from_millis(input.timeout_ms));
                if self.observation.state == ExecutionState::Starting {
                    deadline = deadline.min(self.initialize_deadline);
                }
                let request = client
                    .begin_raw_request(
                        &input.method,
                        input.params,
                        input.session_id.as_deref(),
                        deadline,
                    )
                    .map_err(cdp_error)?;
                self.pending.push((id, request));
                Ok(None)
            }
            "cdp.subscribe" => {
                let input: Subscribe = decode_params(params)?;
                if self.subscription.is_some() {
                    return Err(HostRpcError::new(
                        "subscription_exists",
                        "unsubscribe before opening another CDP event subscription",
                    ));
                }
                let filter = match (input.scope.as_str(), input.session_id) {
                    ("root", None) => CdpEventFilter::Root,
                    ("all", None) => CdpEventFilter::All,
                    ("session", Some(session)) if valid_identifier(&session) => {
                        CdpEventFilter::Session(session)
                    }
                    _ => {
                        return Err(HostRpcError::new(
                            "invalid_params",
                            "scope is root, all, or session with a nonempty sessionId",
                        ));
                    }
                };
                let events = client.subscribe_bounded(filter).map_err(cdp_error)?;
                self.subscription_id = self
                    .subscription_id
                    .checked_add(1)
                    .filter(|id| *id <= 9_007_199_254_740_991)
                    .ok_or_else(|| {
                        HostRpcError::new(
                            "subscription_ids_exhausted",
                            "restart this host before opening another subscription",
                        )
                    })?;
                self.subscription = Some((self.subscription_id, events));
                Ok(Some(json!({"subscriptionId":self.subscription_id})))
            }
            "cdp.unsubscribe" => {
                let input: Unsubscribe = decode_params(params)?;
                if self.subscription.as_ref().map(|(id, _)| *id) != Some(input.subscription_id) {
                    return Err(HostRpcError::new(
                        "unknown_subscription",
                        "this generation does not own that active subscription",
                    ));
                }
                self.subscription.take();
                self.outbox
                    .retain(|entry| !matches!(entry, Outbound::Event(_)));
                Ok(Some(json!({"unsubscribed":true})))
            }
            _ => unreachable!(),
        })();
        match outcome {
            Ok(None) => None,
            Ok(Some(value)) => Some(Ok(value)),
            Err(error) => Some(Err(error)),
        }
    }

    fn queue(&mut self, message: Outbound) {
        if self.outbox.len() == MAX_OUTBOX {
            self.fail("outgoing_queue_full: Core host bridge queue exceeded eight frames".into());
        } else {
            self.outbox.push_back(message);
        }
    }

    fn end_subscription(&mut self, reason: &str) {
        if let Some((id, _)) = self.subscription.take() {
            self.outbox
                .retain(|entry| !matches!(entry, Outbound::Event(_)));
            self.queue(Outbound::SubscriptionEnded(
                json!({"subscriptionId":id,"reason":reason}),
            ));
        }
    }

    fn fail(&mut self, error: String) {
        self.observation.error = Some(error);
        self.pending.clear();
        self.subscription.take();
        self.outbox.clear();
        if let Some(supervisor) = &mut self.supervisor {
            supervisor.begin_stop();
            self.observation.state = ExecutionState::Stopping;
        } else {
            self.observation.state = ExecutionState::Failed;
        }
    }

    fn stop(&mut self) -> Option<HostStopReport> {
        self.pending.clear();
        self.subscription.take();
        self.outbox.clear();
        if let Some(mut supervisor) = self.supervisor.take() {
            let result = supervisor.stop();
            self.observation.state = if result.is_ok() && self.observation.error.is_none() {
                ExecutionState::Exited
            } else {
                ExecutionState::Failed
            };
            if let Err(error) = &result {
                self.observation.error = Some(error.to_string());
            }
            drop(supervisor);
            Some(HostStopReport {
                plugin_id: self.observation.plugin.manifest.id.clone(),
                result,
            })
        } else {
            self.stop_report.take()
        }
    }
}

impl Drop for HostOwner {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawRequest {
    method: String,
    params: Option<Value>,
    session_id: Option<String>,
    #[serde(default = "default_timeout_ms")]
    timeout_ms: u64,
}

fn default_timeout_ms() -> u64 {
    15_000
}
fn valid_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 1024 && !value.chars().any(char::is_control)
}

impl RawRequest {
    fn validate(&self) -> Result<(), HostRpcError> {
        if !valid_identifier(&self.method)
            || self.method.len() > 256
            || self
                .session_id
                .as_ref()
                .is_some_and(|session| !valid_identifier(session))
            || !(1..=15_000).contains(&self.timeout_ms)
            || self
                .params
                .as_ref()
                .is_some_and(|params| !params.is_object())
        {
            return Err(HostRpcError::new(
                "invalid_params",
                "method/sessionId must be nonempty, params an object, and timeoutMs between 1 and 15000",
            ));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Subscribe {
    scope: String,
    session_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Unsubscribe {
    subscription_id: u64,
}

fn decode_params<T: serde::de::DeserializeOwned>(params: Value) -> Result<T, HostRpcError> {
    serde_json::from_value(params)
        .map_err(|error| HostRpcError::new("invalid_params", error.to_string()))
}

fn payload_fits(value: &Value) -> bool {
    serde_json::to_vec(value).is_ok_and(|bytes| bytes.len() <= MAX_PAYLOAD)
}

fn bounded_result(result: Result<Value, HostRpcError>) -> Result<Value, HostRpcError> {
    match result {
        Ok(value) if payload_fits(&value) => Ok(value),
        Ok(_) => Err(HostRpcError::new(
            "response_too_large",
            "CDP response exceeds the host JSONL payload limit",
        )),
        Err(error) => Err(error),
    }
}

fn cdp_error(error: ClientError) -> HostRpcError {
    match error {
        ClientError::Remote {
            error_code,
            message,
            data,
            ..
        } => {
            let detail = json!({"code":error_code,"data":data});
            let mut error = HostRpcError {
                code: "cdp_error".into(),
                message: if message.is_empty() {
                    "CDP method failed".into()
                } else {
                    message.chars().take(4096).collect()
                },
                data: Some(detail),
            };
            if serde_json::to_vec(&error).map_or(true, |bytes| bytes.len() > MAX_PAYLOAD) {
                error.data = None;
            }
            error
        }
        ClientError::RequestTimedOut { .. } => {
            HostRpcError::new("request_timeout", error.to_string())
        }
        ClientError::RequestQueueFull => HostRpcError::new("request_limit", error.to_string()),
        _ => HostRpcError::new("cdp_unavailable", error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_remote_errors_drop_data_without_retiring_the_host() {
        let error = cdp_error(ClientError::Remote {
            method: "Fixture.error".into(),
            error_code: -32000,
            message: "\n界".repeat(4096),
            data: Some(json!("x".repeat(MAX_PAYLOAD - 1024))),
        });
        assert_eq!(error.code, "cdp_error");
        assert!(error.data.is_none());
        assert!(serde_json::to_vec(&error).unwrap().len() <= MAX_PAYLOAD);
    }
}
