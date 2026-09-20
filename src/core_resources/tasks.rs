//! A task control plane. JS executes callbacks after claiming work; Core owns
//! admission, deadlines, claims, progress, cancellation and immutable outcomes.
use super::{
    OwnerKey, Result, ServiceError, bounded, bytes, decode, invalid, missing, name, now_ms, token,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

#[derive(Default)]
pub(super) struct Tasks {
    runners: BTreeMap<String, Runner>,
    tasks: BTreeMap<String, Task>,
    operations: BTreeMap<(OwnerKey, String), (Value, String)>,
}
struct Runner {
    owner: OwnerKey,
    name: String,
}
struct Task {
    owner: OwnerKey,
    runner: String,
    input: Value,
    state: &'static str,
    claim: Option<String>,
    cancel_requested: bool,
    progress: Value,
    result: Option<Value>,
    error: Option<Value>,
    revision: u64,
    created_at: u64,
    deadline: Instant,
    deadline_at: u64,
}
impl Task {
    fn terminal(&self) -> bool {
        !matches!(self.state, "queued" | "running")
    }
    fn snapshot(&self, id: &str) -> Value {
        json!({"task":id,"operationId":id,"runner":self.runner,"state":self.state,"cancelRequested":self.cancel_requested,
            "progress":self.progress,"result":self.result,"error":self.error,"revision":self.revision.to_string(),
            "createdAt":self.created_at,"deadlineAt":self.deadline_at,"outcomeKnown":self.state!="interrupted","terminal":self.terminal()})
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Register {
    name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Start {
    runner: String,
    input: Value,
    operation_key: String,
    timeout_ms: Option<u64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Claim {
    runner: String,
    limit: Option<usize>,
    #[serde(default)]
    wait_ms: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Progress {
    task: String,
    claim: String,
    progress: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Finish {
    task: String,
    claim: String,
    state: String,
    result: Option<Value>,
    error: Option<Value>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Selected {
    task: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Unregister {
    runner: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct List {
    limit: Option<usize>,
    after: Option<String>,
}

pub(super) fn invoke(
    store: &mut Tasks,
    owner: &OwnerKey,
    method: &str,
    params: Value,
) -> Result<Value> {
    store.expire();
    match method {
        "tasks.register" => {
            let input: Register = decode(params)?;
            name(&input.name)?;
            if store.runners.len() >= 128
                || store.runners.values().filter(|r| &r.owner == owner).count() >= 16
            {
                return Err(ServiceError::new("resource_limit", "runner limit reached"));
            }
            if store
                .runners
                .values()
                .any(|r| &r.owner == owner && r.name == input.name)
            {
                return Err(ServiceError::new(
                    "resource_conflict",
                    "runner name already registered",
                ));
            }
            let id = token()?;
            store.runners.insert(
                id.clone(),
                Runner {
                    owner: owner.clone(),
                    name: input.name,
                },
            );
            Ok(json!({"runner":id}))
        }
        "tasks.start" => {
            let input: Start = decode(params.clone())?;
            name(&input.operation_key)?;
            bytes(&input.input, 64 * 1024)?;
            let operation = (owner.clone(), input.operation_key);
            if let Some((original, id)) = store.operations.get(&operation) {
                if original != &params {
                    return Err(ServiceError::new(
                        "operation_conflict",
                        "operationKey has different task input",
                    ));
                }
                return Ok(store.tasks.get(id).ok_or_else(missing)?.snapshot(id));
            }
            if !store
                .runners
                .get(&input.runner)
                .is_some_and(|r| &r.owner == owner)
            {
                return Err(missing());
            }
            if store.tasks.len() >= 256
                || store.tasks.values().filter(|t| &t.owner == owner).count() >= 64
            {
                return Err(ServiceError::new(
                    "resource_limit",
                    "retained task limit reached",
                ));
            }
            let timeout = input.timeout_ms.unwrap_or(60 * 60 * 1000);
            if !(1..=24 * 60 * 60 * 1000).contains(&timeout) {
                return Err(invalid("task timeout must be 1..86400000 ms"));
            }
            let id = token()?;
            let at = now_ms();
            let task = Task {
                owner: owner.clone(),
                runner: input.runner,
                input: input.input,
                state: "queued",
                claim: None,
                cancel_requested: false,
                progress: Value::Null,
                result: None,
                error: None,
                revision: 1,
                created_at: at,
                deadline: Instant::now() + Duration::from_millis(timeout),
                deadline_at: at + timeout,
            };
            let result = task.snapshot(&id);
            store.tasks.insert(id.clone(), task);
            store.operations.insert(operation, (params, id));
            Ok(result)
        }
        "tasks.claim" => {
            let input: Claim = decode(params)?;
            if input.wait_ms > 1000 {
                return Err(invalid("waitMs exceeds 1000"));
            }
            let limit = bounded(input.limit, 1, 4)?;
            if !store
                .runners
                .get(&input.runner)
                .is_some_and(|r| &r.owner == owner)
            {
                return Err(missing());
            }
            let active = store
                .tasks
                .values()
                .filter(|t| &t.owner == owner && t.state == "running")
                .count();
            let capacity = 4_usize.saturating_sub(active).min(limit);
            let mut claimed = Vec::new();
            for (id, task) in &mut store.tasks {
                if claimed.len() >= capacity {
                    break;
                }
                if &task.owner != owner || task.runner != input.runner || task.state != "queued" {
                    continue;
                }
                let claim = token()?;
                task.claim = Some(claim.clone());
                task.state = "running";
                task.revision += 1;
                claimed.push(json!({"task":id,"claim":claim,"input":task.input,"remainingMs":task.deadline.saturating_duration_since(Instant::now()).as_millis(),"deadlineAt":task.deadline_at}));
            }
            let cancellations: Vec<_> = store
                .tasks
                .iter()
                .filter(|(_, t)| {
                    &t.owner == owner
                        && t.runner == input.runner
                        && t.claim.is_some()
                        && t.cancel_requested
                })
                .map(|(id, t)| json!({"task":id,"state":t.state,"cancelRequested":true}))
                .collect();
            Ok(json!({"tasks":claimed,"cancellations":cancellations}))
        }
        "tasks.progress" => {
            let input: Progress = decode(params)?;
            bytes(&input.progress, 16 * 1024)?;
            let task = claimed(store, owner, &input.task, &input.claim)?;
            task.progress = input.progress;
            task.revision += 1;
            Ok(task.snapshot(&input.task))
        }
        "tasks.finish" => {
            let input: Finish = decode(params)?;
            let task = claimed(store, owner, &input.task, &input.claim)?;
            if let Some(value) = &input.result {
                bytes(value, 128 * 1024)?;
            }
            if let Some(value) = &input.error {
                bytes(value, 16 * 1024)?;
            }
            match input.state.as_str() {
                "succeeded" => {
                    if input.error.is_some() {
                        return Err(invalid("successful task cannot carry an error"));
                    }
                    task.state = "succeeded";
                }
                "failed" => {
                    if input.result.is_some() {
                        return Err(invalid("failed task cannot carry a result"));
                    }
                    task.state = "failed";
                }
                "cancelled" if task.cancel_requested => {
                    if input.result.is_some() {
                        return Err(invalid("cancelled task cannot carry a result"));
                    }
                    task.state = "cancelled";
                }
                _ => {
                    return Err(invalid(
                        "finish requires succeeded, failed or acknowledged cancelled",
                    ));
                }
            }
            task.result = input.result;
            task.error = input.error;
            task.revision += 1;
            Ok(task.snapshot(&input.task))
        }
        "tasks.cancel" => {
            let input: Selected = decode(params)?;
            let task = store
                .tasks
                .get_mut(&input.task)
                .filter(|t| &t.owner == owner)
                .ok_or_else(missing)?;
            if !task.terminal() {
                task.cancel_requested = true;
                if task.state == "queued" {
                    task.state = "cancelled";
                }
                task.revision += 1;
            }
            Ok(task.snapshot(&input.task))
        }
        "tasks.get" | "tasks.result" => {
            let input: Selected = decode(params)?;
            let task = store
                .tasks
                .get(&input.task)
                .filter(|t| &t.owner == owner)
                .ok_or_else(missing)?;
            Ok(task.snapshot(&input.task))
        }
        "tasks.list" => {
            let input: List = decode(params)?;
            let limit = bounded(input.limit, 32, 64)?;
            let mut values = Vec::new();
            let mut response_bytes = 0;
            let mut more = false;
            for (id, task) in store.tasks.iter().filter(|(id, t)| {
                &t.owner == owner && input.after.as_ref().is_none_or(|after| *id > after)
            }) {
                let value = task.snapshot(id);
                let size = serde_json::to_vec(&value)
                    .map_err(|_| invalid("invalid task snapshot"))?
                    .len();
                if values.len() >= limit || response_bytes + size > 192 * 1024 {
                    more = true;
                    break;
                }
                response_bytes += size;
                values.push(value);
            }
            let cursor = if more {
                values
                    .last()
                    .and_then(|v| v["task"].as_str())
                    .map(str::to_owned)
            } else {
                None
            };
            Ok(json!({"tasks":values,"cursor":cursor}))
        }
        "tasks.unregister" => {
            let input: Unregister = decode(params)?;
            if !store
                .runners
                .get(&input.runner)
                .is_some_and(|r| &r.owner == owner)
            {
                return Err(missing());
            }
            store.runners.remove(&input.runner);
            for task in store
                .tasks
                .values_mut()
                .filter(|t| &t.owner == owner && t.runner == input.runner && !t.terminal())
            {
                task.cancel_requested = true;
                task.state = if task.claim.is_some() {
                    "interrupted"
                } else {
                    "cancelled"
                };
                task.error = Some(json!({"code":"runner_retired"}));
                task.revision += 1;
            }
            Ok(json!({"unregistered":true}))
        }
        _ => Err(ServiceError::new("method_not_found", "unknown task method")),
    }
}
fn claimed<'a>(
    store: &'a mut Tasks,
    owner: &OwnerKey,
    id: &str,
    claim: &str,
) -> Result<&'a mut Task> {
    let task = store
        .tasks
        .get_mut(id)
        .filter(|t| &t.owner == owner)
        .ok_or_else(missing)?;
    if task.claim.as_deref() != Some(claim) {
        return Err(ServiceError::new(
            "claim_denied",
            "task claim does not belong to this runner",
        ));
    }
    if task.terminal() {
        return Err(ServiceError::new(
            "task_terminal",
            "task outcome is already final",
        ));
    }
    Ok(task)
}
impl Tasks {
    fn expire(&mut self) {
        let now = Instant::now();
        for task in self
            .tasks
            .values_mut()
            .filter(|t| !t.terminal() && now >= t.deadline)
        {
            task.cancel_requested = true;
            task.state = if task.claim.is_some() {
                "interrupted"
            } else {
                "cancelled"
            };
            task.error = Some(json!({"code":"task_timeout"}));
            task.revision += 1;
        }
    }
    pub(super) fn retire(&mut self, owner: &OwnerKey) {
        self.runners.retain(|_, r| &r.owner != owner);
        self.tasks.retain(|_, t| &t.owner != owner);
        self.operations.retain(|(key, _), _| key != owner);
    }
    pub(super) fn list_resources(&self, owner: &OwnerKey) -> Vec<Value> {
        self.tasks.iter().filter(|(_,t)| &t.owner==owner).map(|(id,t)|json!({"id":id,"kind":"task","state":t.state,"cancelRequested":t.cancel_requested})).collect()
    }
}
