use super::{
    CoreResources, OwnerKey, ResourceOwner, Result, ServiceError, bounded, check, decode, invalid,
    missing, name, token,
};
use crate::platform::host::{
    Channel, LocalIpcError, OwnedPluginProcess, PluginStdio, StopSignal, signal, stream_closed,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, VecDeque};
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const BUFFER_BYTES: usize = 256 * 1024;
const CHUNK_BYTES: usize = 32 * 1024;
#[derive(Default)]
pub(super) struct Processes {
    entries: BTreeMap<String, (OwnerKey, Arc<Process>)>,
    operations: BTreeMap<(OwnerKey, String), (Value, String)>,
}
#[derive(Default)]
struct IoState {
    stdout: VecDeque<u8>,
    stderr: VecDeque<u8>,
    stdout_eof: bool,
    stderr_eof: bool,
    exit_code: Option<u32>,
    reaped: bool,
    worker_done: bool,
    streams_closed: bool,
    error: Option<String>,
    output_discarded: bool,
    next_write: u64,
    last_write: Option<(u64, Vec<u8>, Result<usize>)>,
}
pub(super) struct Process {
    child: Arc<OwnedPluginProcess>,
    stdin: Mutex<Option<Channel>>,
    stop: StopSignal,
    io: Arc<(Mutex<IoState>, Condvar)>,
    worker: Mutex<Option<JoinHandle<()>>>,
    closed: AtomicBool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Spawn {
    executable: PathBuf,
    args: Vec<String>,
    cwd: Option<PathBuf>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default = "pipe")]
    stdin: String,
    operation_key: String,
}
fn pipe() -> String {
    "pipe".into()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Selected {
    process: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Read {
    process: String,
    stream: String,
    max_bytes: Option<usize>,
    #[serde(default)]
    wait_ms: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Write {
    process: String,
    bytes: Vec<u8>,
    sequence: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Wait {
    process: String,
    #[serde(default)]
    wait_ms: u64,
}

pub(super) fn invoke(
    core: &CoreResources,
    owner: &ResourceOwner,
    method: &str,
    params: Value,
) -> Result<Value> {
    let key = owner.key();
    if method == "processes.spawn" {
        let input: Spawn = decode(params.clone())?;
        name(&input.operation_key)?;
        let mut state = core.shared.state.lock().unwrap_or_else(|p| p.into_inner());
        check(&state, &key)?;
        let op = (key.clone(), input.operation_key.clone());
        if let Some((original, id)) = state.processes.operations.get(&op) {
            if original != &params {
                return Err(ServiceError::new(
                    "operation_conflict",
                    "operationKey has different process input",
                ));
            }
            return Ok(match state.processes.entries.get(id) {
                Some((_, process)) => with_id(id, process.status()),
                None => json!({"process":id,"operationId":id,"closed":true}),
            });
        }
        if state.processes.entries.len() >= 16
            || state
                .processes
                .entries
                .values()
                .filter(|(o, _)| o == &key)
                .count()
                >= 4
            || state.processes.operations.len() >= 256
            || state
                .processes
                .operations
                .keys()
                .filter(|(o, _)| o == &key)
                .count()
                >= 64
        {
            return Err(ServiceError::new(
                "resource_limit",
                "process or retained operation limit reached",
            ));
        }
        let id = token()?;
        let process = Arc::new(spawn(owner, input)?);
        let result = with_id(&id, process.status());
        state.processes.entries.insert(id.clone(), (key, process));
        state.processes.operations.insert(op, (params, id));
        return Ok(result);
    }
    let id = params
        .get("process")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("process handle required"))?
        .to_owned();
    let process = {
        let state = core.shared.state.lock().unwrap_or_else(|p| p.into_inner());
        check(&state, &key)?;
        state
            .processes
            .entries
            .get(&id)
            .filter(|(o, _)| o == &key)
            .map(|(_, p)| Arc::clone(p))
            .ok_or_else(missing)?
    };
    let result = match method {
        "processes.status" => {
            let _: Selected = decode(params)?;
            Ok(with_id(&id, process.status()))
        }
        "processes.read" => {
            let input: Read = decode(params)?;
            debug_assert_eq!(input.process, id);
            process.read(
                &input.stream,
                bounded(input.max_bytes, 8192, CHUNK_BYTES)?,
                input.wait_ms,
            )
        }
        "processes.write" => {
            let input: Write = decode(params)?;
            debug_assert_eq!(input.process, id);
            let sequence = input
                .sequence
                .parse::<u64>()
                .map_err(|_| invalid("sequence must be an unsigned decimal string"))?;
            process.write(input.bytes, sequence)
        }
        "processes.endInput" => {
            let input: Selected = decode(params)?;
            debug_assert_eq!(input.process, id);
            process
                .stdin
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .take();
            Ok(json!({"closed":true}))
        }
        "processes.terminate" => {
            let input: Selected = decode(params)?;
            debug_assert_eq!(input.process, id);
            signal(&process.stop);
            process
                .child
                .terminate()
                .map_err(|e| ServiceError::new("process_error", e.to_string()))?;
            Ok(json!({"requested":true}))
        }
        "processes.wait" => {
            let input: Wait = decode(params)?;
            debug_assert_eq!(input.process, id);
            if input.wait_ms > 1000 {
                return Err(invalid("waitMs exceeds 1000"));
            }
            {
                let (lock, changed) = &*process.io;
                let state = lock.lock().unwrap_or_else(|p| p.into_inner());
                if !state.worker_done && input.wait_ms > 0 {
                    drop(
                        changed
                            .wait_timeout_while(state, Duration::from_millis(input.wait_ms), |s| {
                                !s.worker_done
                            })
                            .unwrap_or_else(|p| p.into_inner()),
                    );
                }
            }
            Ok(with_id(&id, process.status()))
        }
        "processes.close" => {
            let input: Selected = decode(params)?;
            debug_assert_eq!(input.process, id);
            let result = process.close()?;
            let mut state = core.shared.state.lock().unwrap_or_else(|p| p.into_inner());
            state.processes.entries.remove(&id);
            Ok(result)
        }
        _ => Err(ServiceError::new(
            "method_not_found",
            "unknown process method",
        )),
    }?;
    let state = core.shared.state.lock().unwrap_or_else(|p| p.into_inner());
    check(&state, &key)?;
    Ok(result)
}
fn with_id(id: &str, mut value: Value) -> Value {
    value["process"] = json!(id);
    value["operationId"] = json!(id);
    value
}
fn spawn(owner: &ResourceOwner, input: Spawn) -> Result<Process> {
    if input.args.len() > 64
        || input
            .args
            .iter()
            .any(|s| s.len() > 8192 || s.contains('\0'))
        || input.args.iter().map(String::len).sum::<usize>() > 64 * 1024
    {
        return Err(invalid("process args exceed their bound or contain NUL"));
    }
    if !matches!(input.stdin.as_str(), "pipe" | "closed") {
        return Err(invalid("stdin must be pipe or closed"));
    }
    let executable =
        crate::os_broker::filesystem::pin_exact_grant(&input.executable, &owner.executables)
            .map_err(|e| ServiceError::new(e.code, e.message))?;
    let cwd = input.cwd.as_ref().unwrap_or(&owner.default_cwd);
    let cwd_guard = if cwd == &owner.default_cwd {
        crate::os_broker::filesystem::pin_exact_grant(cwd, std::slice::from_ref(&owner.default_cwd))
    } else {
        crate::os_broker::filesystem::pin_within_grants(cwd, &owner.cwd_roots)
    }
    .map_err(|e| ServiceError::new(e.code, e.message))?;
    let mut environment: BTreeMap<OsString, OsString> = [
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
        "LC_CTYPE",
    ]
    .into_iter()
    .filter_map(|key| std::env::var_os(key).map(|value| (OsString::from(key), value)))
    .collect();
    if input.env.len() > 32
        || input
            .env
            .iter()
            .map(|(k, v)| k.len() + v.len())
            .sum::<usize>()
            > 32 * 1024
    {
        return Err(invalid("process environment exceeds its bound"));
    }
    for (key, value) in input.env {
        if key.is_empty()
            || key.len() > 128
            || key.contains(['\0', '='])
            || value.contains('\0')
            || !owner.env_keys.contains(&key)
        {
            return Err(ServiceError::new(
                "policy_denied",
                "environment key is not explicitly allowed or is invalid",
            ));
        }
        #[cfg(windows)]
        environment.retain(|existing, _| !existing.to_string_lossy().eq_ignore_ascii_case(&key));
        environment.insert(OsString::from(key), OsString::from(value));
    }
    executable
        .check_location()
        .map_err(|e| ServiceError::new(e.code, e.message))?;
    cwd_guard
        .check_location()
        .map_err(|e| ServiceError::new(e.code, e.message))?;
    let environment: Vec<_> = environment.into_iter().collect();
    let (child, stdio) = OwnedPluginProcess::spawn(
        &executable.path,
        &input.args,
        &cwd_guard.path,
        Some(&environment),
    )
    .map_err(|e| ServiceError::new("process_start_failed", e.to_string()))?;
    let child = Arc::new(child);
    let PluginStdio {
        stdin,
        stdout,
        stderr,
        stop,
    } = stdio;
    let io = Arc::new((Mutex::new(IoState::default()), Condvar::new()));
    let child_worker = Arc::clone(&child);
    let io_worker = Arc::clone(&io);
    let stop_worker = Arc::clone(&stop);
    let worker = thread::Builder::new()
        .name("codlet-process-stream".into())
        .spawn(move || monitor(child_worker, stdout, stderr, stop_worker, io_worker))
        .map_err(|e| {
            let _ = child.terminate();
            ServiceError::new("process_start_failed", e.to_string())
        })?;
    Ok(Process {
        child,
        stdin: Mutex::new(if input.stdin == "pipe" {
            Some(stdin)
        } else {
            None
        }),
        stop,
        io,
        worker: Mutex::new(Some(worker)),
        closed: AtomicBool::new(false),
    })
}

impl Process {
    fn status(&self) -> Value {
        let state = self.io.0.lock().unwrap_or_else(|p| p.into_inner());
        #[cfg(windows)]
        let ownership = "windows-job";
        #[cfg(target_os = "macos")]
        let ownership = "posix-process-group";
        json!({"pid":self.child.pid(),"closed":self.closed.load(Ordering::Acquire),"exitCode":state.exit_code,
            "processesReaped":state.reaped,"ownershipScope":ownership,"workerDone":state.worker_done,"streamsClosed":state.streams_closed,
            "stdoutEof":state.stdout_eof,"stderrEof":state.stderr_eof,"stdoutBuffered":state.stdout.len(),"stderrBuffered":state.stderr.len(),
            "outputDiscarded":state.output_discarded,"error":state.error,"nextWriteSequence":state.next_write.to_string()})
    }
    fn read(&self, stream: &str, max: usize, wait_ms: u64) -> Result<Value> {
        if wait_ms > 1000 || !matches!(stream, "stdout" | "stderr") {
            return Err(invalid("invalid stream or waitMs"));
        }
        if self.closed.load(Ordering::Acquire) {
            return Err(ServiceError::new(
                "resource_closed",
                "process stream is closed",
            ));
        }
        let (lock, changed) = &*self.io;
        let mut state = lock.lock().unwrap_or_else(|p| p.into_inner());
        let empty = |s: &IoState| {
            if stream == "stdout" {
                s.stdout.is_empty() && !s.stdout_eof
            } else {
                s.stderr.is_empty() && !s.stderr_eof
            }
        };
        if wait_ms > 0 && empty(&state) && !state.worker_done {
            let (next, _) = changed
                .wait_timeout_while(state, Duration::from_millis(wait_ms), |s| {
                    empty(s) && !s.worker_done
                })
                .unwrap_or_else(|p| p.into_inner());
            state = next;
        }
        let eof = if stream == "stdout" {
            state.stdout_eof
        } else {
            state.stderr_eof
        };
        let buffer = if stream == "stdout" {
            &mut state.stdout
        } else {
            &mut state.stderr
        };
        let count = max.min(buffer.len());
        let output: Vec<u8> = buffer.drain(..count).collect();
        let exhausted = buffer.is_empty();
        let result = json!({"bytes":output,"eof":eof && exhausted,"closed":state.streams_closed && exhausted,"error":state.error});
        changed.notify_all();
        Ok(result)
    }
    fn write(&self, data: Vec<u8>, sequence: u64) -> Result<Value> {
        if data.len() > CHUNK_BYTES {
            return Err(invalid("stdin chunk exceeds 32768 bytes"));
        }
        let fingerprint = Sha256::digest(&data).to_vec();
        let mut stdin = self.stdin.lock().unwrap_or_else(|p| p.into_inner());
        {
            let state = self.io.0.lock().unwrap_or_else(|p| p.into_inner());
            if let Some((previous, hash, result)) = &state.last_write
                && sequence == *previous
            {
                if hash != &fingerprint {
                    return Err(ServiceError::new(
                        "operation_conflict",
                        "stdin sequence has different bytes",
                    ));
                }
                return result.clone().map(|count|json!({"acceptedBytes":count,"nextSequence":state.next_write.to_string(),"replayedReceipt":true}));
            }
            if sequence != state.next_write {
                return Err(ServiceError::new(
                    "operation_conflict",
                    "stdin sequence is stale or out of order",
                ));
            }
        }
        if self.closed.load(Ordering::Acquire) {
            return Err(ServiceError::new("resource_closed", "process is closed"));
        }
        let channel = stdin
            .as_ref()
            .ok_or_else(|| ServiceError::new("resource_closed", "stdin is closed"))?;
        let result = channel
            .write_all(&data, Instant::now() + Duration::from_secs(1))
            .map(|()| data.len())
            .map_err(|_| {
                ServiceError::new(
                    "outcome_unknown",
                    "stdin write did not fully confirm; do not resend this chunk",
                )
            });
        let mut state = self.io.0.lock().unwrap_or_else(|p| p.into_inner());
        state.next_write = state
            .next_write
            .checked_add(1)
            .ok_or_else(|| ServiceError::new("resource_limit", "stdin sequence exhausted"))?;
        state.last_write = Some((sequence, fingerprint, result.clone()));
        if result.is_err() {
            state.error = Some("stdin_write_unconfirmed".into());
            stdin.take();
            signal(&self.stop);
            let _ = self.child.terminate();
        }
        result
            .map(|count| json!({"acceptedBytes":count,"nextSequence":state.next_write.to_string()}))
    }
    pub(super) fn request_close(&self) {
        self.closed.store(true, Ordering::Release);
        signal(&self.stop);
        let _ = self.child.terminate();
    }
    pub(super) fn close(&self) -> Result<Value> {
        self.request_close();
        self.stdin.lock().unwrap_or_else(|p| p.into_inner()).take();
        let (lock, changed) = &*self.io;
        let state = lock.lock().unwrap_or_else(|p| p.into_inner());
        let (state, _) = changed
            .wait_timeout_while(state, Duration::from_millis(2500), |s| !s.worker_done)
            .unwrap_or_else(|p| p.into_inner());
        let complete = state.worker_done && state.reaped;
        drop(state);
        let mut worker = self.worker.lock().unwrap_or_else(|p| p.into_inner());
        if worker.as_ref().is_some_and(JoinHandle::is_finished)
            && let Some(worker) = worker.take()
        {
            let _ = worker.join();
        }
        if !complete {
            return Err(ServiceError::new(
                "cleanup_incomplete",
                "process scope or I/O worker has not confirmed exit",
            ));
        }
        Ok(json!({"closed":true,"processesReaped":true}))
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

fn monitor(
    child: Arc<OwnedPluginProcess>,
    stdout: Channel,
    stderr: Channel,
    stop: StopSignal,
    io: Arc<(Mutex<IoState>, Condvar)>,
) {
    let mut terminated_descendants = false;
    let mut aborted = false;
    loop {
        #[cfg(windows)]
        let stopping = stdout.is_stopping() || stderr.is_stopping();
        #[cfg(target_os = "macos")]
        let stopping = stop.load(Ordering::Acquire);
        if stopping {
            aborted = true;
            break;
        }
        if let Err(error) = pump(&stdout, true, &io).and_then(|()| pump(&stderr, false, &io)) {
            let mut state = io.0.lock().unwrap_or_else(|p| p.into_inner());
            state.error = Some(error.code.into());
            aborted = true;
            break;
        }
        match child.wait(Duration::ZERO) {
            Ok(Some(code)) => {
                let empty = child.process_scope_is_empty().unwrap_or(false);
                let mut state = io.0.lock().unwrap_or_else(|p| p.into_inner());
                state.exit_code = Some(code);
                state.reaped = empty;
                if empty && state.stdout_eof && state.stderr_eof {
                    break;
                }
                if !empty && !terminated_descendants {
                    let _ = child.terminate();
                    terminated_descendants = true;
                }
            }
            Ok(None) => {}
            Err(_) => {
                io.0.lock().unwrap_or_else(|p| p.into_inner()).error =
                    Some("process_wait_failed".into());
                aborted = true;
                break;
            }
        }
        let state = io.0.lock().unwrap_or_else(|p| p.into_inner());
        drop(
            io.1.wait_timeout(state, Duration::from_millis(5))
                .unwrap_or_else(|p| p.into_inner()),
        );
    }
    if aborted {
        signal(&stop);
        let _ = child.terminate();
    }
    drop(stdout);
    drop(stderr);
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut code = None;
    let mut reaped = false;
    while Instant::now() < deadline {
        code = child.wait(Duration::ZERO).ok().flatten();
        reaped = child.process_scope_is_empty().unwrap_or(false);
        if code.is_some() && reaped {
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    let mut state = io.0.lock().unwrap_or_else(|p| p.into_inner());
    state.exit_code = code.or(state.exit_code);
    state.reaped = reaped;
    state.worker_done = true;
    state.streams_closed = true;
    state.output_discarded = aborted && (!state.stdout_eof || !state.stderr_eof);
    if !reaped {
        state.error = Some("cleanup_incomplete".into());
    }
    io.1.notify_all();
}
fn pump(channel: &Channel, is_stdout: bool, io: &Arc<(Mutex<IoState>, Condvar)>) -> Result<()> {
    let capacity = {
        let state = io.0.lock().unwrap_or_else(|p| p.into_inner());
        let (size, eof) = if is_stdout {
            (state.stdout.len(), state.stdout_eof)
        } else {
            (state.stderr.len(), state.stderr_eof)
        };
        if eof {
            return Ok(());
        }
        (BUFFER_BYTES - size).min(8192)
    };
    if capacity == 0 {
        return Ok(());
    }
    let mut buffer = vec![0; capacity];
    let read = channel.read_some(&mut buffer, Some(Instant::now() + Duration::from_millis(5)));
    let mut state = io.0.lock().unwrap_or_else(|p| p.into_inner());
    match read {
        Ok(0) => {
            if is_stdout {
                state.stdout_eof = true;
            } else {
                state.stderr_eof = true;
            }
        }
        Ok(count) => {
            if is_stdout {
                state.stdout.extend(&buffer[..count]);
            } else {
                state.stderr.extend(&buffer[..count]);
            }
        }
        Err(LocalIpcError::Timeout) => return Ok(()),
        Err(error) if stream_closed(&error) => {
            if is_stdout {
                state.stdout_eof = true;
            } else {
                state.stderr_eof = true;
            }
        }
        Err(_) => {
            return Err(ServiceError::new(
                "process_io_error",
                "managed process pipe failed",
            ));
        }
    }
    io.1.notify_all();
    Ok(())
}
impl Processes {
    pub(super) fn retire(&mut self, owner: &OwnerKey) -> Vec<Arc<Process>> {
        let ids: Vec<_> = self
            .entries
            .iter()
            .filter(|(_, (key, _))| key == owner)
            .map(|(id, _)| id.clone())
            .collect();
        let retired = ids
            .into_iter()
            .filter_map(|id| self.entries.remove(&id).map(|(_, p)| p))
            .collect();
        self.operations.retain(|(key, _), _| key != owner);
        retired
    }
    pub(super) fn drain(&mut self) -> Vec<Arc<Process>> {
        self.operations.clear();
        std::mem::take(&mut self.entries)
            .into_values()
            .map(|(_, p)| p)
            .collect()
    }
    pub(super) fn list(&self, owner: &OwnerKey) -> Vec<Value> {
        self.entries
            .iter()
            .filter(|(_, (key, _))| key == owner)
            .map(|(id, (_, p))| {
                let mut value = with_id(id, p.status());
                value["id"] = json!(id);
                value["kind"] = json!("process");
                value
            })
            .collect()
    }
}
