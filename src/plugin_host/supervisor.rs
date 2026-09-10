use std::collections::{BTreeMap, VecDeque};
use std::os::windows::io::OwnedHandle;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use windows_sys::Win32::Foundation::{ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_PIPE_NOT_CONNECTED};
use windows_sys::Win32::System::Threading::SetEvent;

use super::protocol::{
    HostIdentity, HostRpcError, LineDecoder, MAX_HOST_PENDING_REQUESTS, MAX_SAFE_INTEGER,
    WireMessage, decode_frame, encode_frame, validate_method,
};
use crate::windows::local_ipc::{Channel, LocalIpcError, raw};
use crate::windows::plugin_process::{OwnedPluginProcess, PluginStdio};

const QUEUE_FRAMES: usize = 4;
const STDERR_TAIL_BYTES: usize = 64 * 1024;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
const STOP_GRACE: Duration = Duration::from_millis(1500);
const EXIT_DRAIN: Duration = Duration::from_millis(100);
const IO_POLL: Duration = Duration::from_millis(20);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{code}: {message}")]
pub struct HostError {
    pub code: &'static str,
    pub message: String,
}

impl HostError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostState {
    Starting,
    Ready,
    Stopping,
    Exited,
    Failed,
}

#[derive(Debug, Clone, PartialEq)]
pub enum HostEvent {
    Request {
        id: u64,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    Response {
        id: u64,
        result: Result<Value, HostRpcError>,
    },
    RequestTimedOut {
        id: u64,
    },
    Exited {
        exit_code: u32,
    },
    Failed {
        error: HostError,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostExitReport {
    pub process_id: u32,
    pub exit_code: u32,
    pub forced: bool,
    pub workers_reaped: bool,
}

struct Outbound {
    frame: Vec<u8>,
    expires_at: Instant,
    cancelled: Option<Arc<AtomicBool>>,
}

struct Inbound {
    frame: Vec<u8>,
    received_at: Instant,
}

struct IoState {
    stop: Arc<OwnedHandle>,
    stopping: AtomicBool,
    failure: Mutex<Option<HostError>>,
    partial_since: Mutex<Option<Instant>>,
    write_deadline: Mutex<Option<Instant>>,
    stdout_closed: AtomicBool,
    stderr_tail: Mutex<VecDeque<u8>>,
}

impl IoState {
    fn fail(&self, error: HostError) {
        let mut failure = self.failure.lock().unwrap_or_else(|p| p.into_inner());
        if failure.is_none() {
            *failure = Some(error);
        }
    }
    fn cancel(&self) {
        self.stopping.store(true, Ordering::Release);
        unsafe {
            SetEvent(raw(&self.stop));
        }
    }
    fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::Acquire)
    }
}

/// The caller owns this state machine and interprets incoming methods. IO workers
/// only transfer bytes; they never receive application handles or execute requests.
pub struct HostSupervisor {
    identity: HostIdentity,
    process: OwnedPluginProcess,
    state: HostState,
    io: Arc<IoState>,
    incoming: mpsc::Receiver<Inbound>,
    outgoing: Option<mpsc::SyncSender<Outbound>>,
    workers: Vec<JoinHandle<()>>,
    outgoing_pending: BTreeMap<u64, Instant>,
    outgoing_cancellation: BTreeMap<u64, Arc<AtomicBool>>,
    incoming_pending: BTreeMap<u64, Instant>,
    last_issued_id: u64,
    last_received_id: u64,
    startup_deadline: Instant,
    failure: Option<HostError>,
    failure_reported: bool,
    exit_code: Option<u32>,
    job_empty: bool,
    process_exited_at: Option<Instant>,
    exit_reported: bool,
    stdout_closed_since: Option<Instant>,
    forced: bool,
    shutdown_sent: bool,
    shutdown_request_id: Option<u64>,
    allow_shutdown_requests: bool,
    stop_grace_until: Option<Instant>,
}

impl HostSupervisor {
    pub fn spawn(
        identity: HostIdentity,
        executable: &Path,
        args: &[String],
        cwd: &Path,
    ) -> Result<Self, HostError> {
        Self::spawn_with_environment(identity, executable, args, cwd, None)
    }

    pub(crate) fn spawn_with_environment(
        identity: HostIdentity,
        executable: &Path,
        args: &[String],
        cwd: &Path,
        environment: Option<&[(std::ffi::OsString, std::ffi::OsString)]>,
    ) -> Result<Self, HostError> {
        identity
            .validate()
            .map_err(|message| HostError::new("invalid_identity", message))?;
        let (process, stdio) = OwnedPluginProcess::spawn(executable, args, cwd, environment)
            .map_err(|error| HostError::new("spawn_failed", error.to_string()))?;
        let PluginStdio {
            stdin,
            stdout,
            stderr,
            stop,
        } = stdio;
        let (incoming_sender, incoming) = mpsc::sync_channel(QUEUE_FRAMES);
        let (outgoing, outgoing_receiver) = mpsc::sync_channel(QUEUE_FRAMES);
        let io = Arc::new(IoState {
            stop,
            stopping: AtomicBool::new(false),
            failure: Mutex::new(None),
            partial_since: Mutex::new(None),
            write_deadline: Mutex::new(None),
            stdout_closed: AtomicBool::new(false),
            stderr_tail: Mutex::new(VecDeque::new()),
        });
        let mut supervisor = Self {
            identity,
            process,
            state: HostState::Starting,
            io: Arc::clone(&io),
            incoming,
            outgoing: Some(outgoing),
            workers: Vec::new(),
            outgoing_pending: BTreeMap::new(),
            outgoing_cancellation: BTreeMap::new(),
            incoming_pending: BTreeMap::new(),
            last_issued_id: 0,
            last_received_id: 0,
            startup_deadline: Instant::now() + STARTUP_TIMEOUT,
            failure: None,
            failure_reported: false,
            exit_code: None,
            job_empty: false,
            process_exited_at: None,
            exit_reported: false,
            stdout_closed_since: None,
            forced: false,
            shutdown_sent: false,
            shutdown_request_id: None,
            allow_shutdown_requests: false,
            stop_grace_until: None,
        };
        let startup = (|| {
            supervisor
                .workers
                .push(spawn_worker("stdout", Arc::clone(&io), move |io| {
                    read_stdout(stdout, incoming_sender, io)
                })?);
            supervisor
                .workers
                .push(spawn_worker("stdin", Arc::clone(&io), move |io| {
                    write_stdin(stdin, outgoing_receiver, io)
                })?);
            supervisor
                .workers
                .push(spawn_worker("stderr", io, move |io| {
                    read_stderr(stderr, io)
                })?);
            Ok::<_, HostError>(())
        })();
        if let Err(error) = startup {
            supervisor.fail(error.clone());
            let _ = supervisor.stop();
            return Err(error);
        }
        Ok(supervisor)
    }

    pub fn identity(&self) -> &HostIdentity {
        &self.identity
    }
    pub fn process_id(&self) -> u32 {
        self.process.pid()
    }
    pub fn state(&self) -> HostState {
        self.state
    }

    /// The original receipt deadline follows a child request through any Core
    /// dispatch. Reading it never renews the budget or admits another request.
    pub fn incoming_deadline(&self, id: u64) -> Option<Instant> {
        self.incoming_pending.get(&id).copied()
    }

    /// stderr is deliberately not printed by the supervisor. A caller may choose
    /// how to display this bounded diagnostic tail without treating it as protocol.
    pub fn stderr_tail(&self) -> Vec<u8> {
        self.io
            .stderr_tail
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .copied()
            .collect()
    }

    pub fn mark_ready(&mut self) -> Result<(), HostError> {
        if self.state != HostState::Starting || Instant::now() >= self.startup_deadline {
            return Err(HostError::new(
                "host_not_starting",
                "only a live initializing Host may become ready",
            ));
        }
        self.state = HostState::Ready;
        Ok(())
    }

    pub fn send_request(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<u64, HostError> {
        self.send_request_until(method, params, deadline(timeout)?, None)
    }

    /// Carries the caller's original budget and cancellation through the bounded
    /// stdin queue. Expired/cancelled frames are skipped before a write starts.
    pub(crate) fn send_cancellable_request_until(
        &mut self,
        method: &str,
        params: Value,
        expires_at: Instant,
        cancelled: Arc<AtomicBool>,
    ) -> Result<u64, HostError> {
        self.send_request_until(method, params, expires_at, Some(cancelled))
    }

    fn send_request_until(
        &mut self,
        method: &str,
        params: Value,
        expires_at: Instant,
        cancelled: Option<Arc<AtomicBool>>,
    ) -> Result<u64, HostError> {
        self.ensure_admission()?;
        validate_method(method).map_err(|message| HostError::new("invalid_method", message))?;
        if self.outgoing_pending.len() >= MAX_HOST_PENDING_REQUESTS {
            return Err(HostError::new(
                "request_limit",
                "this Host has too many pending requests",
            ));
        }
        let remaining = expires_at.saturating_duration_since(Instant::now());
        if remaining.is_zero() || remaining > REQUEST_TIMEOUT {
            return Err(HostError::new(
                "request_expired",
                "the original Host request budget is unavailable",
            ));
        }
        if cancelled
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Acquire))
        {
            return Err(HostError::new(
                "invocation_cancelled",
                "the Host request was cancelled before dispatch",
            ));
        }
        let id = self
            .last_issued_id
            .checked_add(1)
            .filter(|id| *id <= MAX_SAFE_INTEGER)
            .ok_or_else(|| {
                HostError::new("request_ids_exhausted", "this Host exhausted request ids")
            })?;
        self.enqueue_cancellable(
            WireMessage::request(&self.identity, id, method.into(), params),
            expires_at,
            cancelled.clone(),
        )?;
        self.last_issued_id = id;
        self.outgoing_pending.insert(id, expires_at);
        if let Some(cancelled) = cancelled {
            self.outgoing_cancellation.insert(id, cancelled);
        }
        Ok(id)
    }

    pub(crate) fn cancel_request(&mut self, id: u64) {
        self.outgoing_pending.remove(&id);
        if let Some(cancelled) = self.outgoing_cancellation.remove(&id) {
            cancelled.store(true, Ordering::Release);
        }
    }

    pub(crate) fn abandon_incoming(&mut self, id: u64) {
        self.incoming_pending.remove(&id);
    }

    fn cancel_outgoing(&mut self) {
        self.outgoing_pending.clear();
        for (_, cancelled) in std::mem::take(&mut self.outgoing_cancellation) {
            cancelled.store(true, Ordering::Release);
        }
    }

    pub fn respond(
        &mut self,
        id: u64,
        result: Result<Value, HostRpcError>,
    ) -> Result<(), HostError> {
        if !(self.state == HostState::Stopping
            && self.allow_shutdown_requests
            && self
                .stop_grace_until
                .is_some_and(|deadline| Instant::now() < deadline))
        {
            self.ensure_admission()?;
        }
        let expires_at = *self.incoming_pending.get(&id).ok_or_else(|| {
            HostError::new(
                "unknown_request",
                "the Host request was not received or was already answered",
            )
        })?;
        if Instant::now() >= expires_at {
            self.incoming_pending.remove(&id);
            return Err(HostError::new(
                "request_expired",
                "the Host request deadline has expired",
            ));
        }
        self.enqueue(
            WireMessage::response(&self.identity, id, result),
            expires_at,
        )?;
        self.incoming_pending.remove(&id);
        Ok(())
    }

    pub fn notify(&mut self, method: &str, params: Value) -> Result<(), HostError> {
        self.ensure_admission()?;
        validate_method(method).map_err(|message| HostError::new("invalid_method", message))?;
        self.enqueue(
            WireMessage::notification(&self.identity, method.into(), params),
            Instant::now() + REQUEST_TIMEOUT,
        )
    }

    /// Processes at most four frames per owner turn. Child requests are delivered
    /// during initialization too, allowing initialize -> Core RPC -> reply flows.
    pub fn poll(&mut self) -> Vec<HostEvent> {
        let now = Instant::now();
        let mut events = Vec::new();
        if self.exit_code.is_none() && self.stop_grace_until.is_some_and(|until| now >= until) {
            self.forced = true;
            if let Err(error) = self.process.terminate() {
                self.fail(HostError::new("terminate_failed", error.to_string()));
            }
            self.io.cancel();
            self.outgoing.take();
            self.stop_grace_until = None;
        }
        // Only a queue read after all workers have joined proves no final frame
        // can arrive later. Exit is reported after that last bounded drain.
        let input_final = self.workers.is_empty();
        let mut input_exhausted = self.state == HostState::Failed;
        let io_failure = self
            .io
            .failure
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if let Some(error) = io_failure {
            self.fail(error);
        }
        if matches!(
            self.state,
            HostState::Starting | HostState::Ready | HostState::Stopping
        ) || (self.state == HostState::Exited && !self.exit_reported)
        {
            for _ in 0..QUEUE_FRAMES {
                let inbound = match self.incoming.try_recv() {
                    Ok(inbound) => inbound,
                    Err(_) => {
                        input_exhausted = true;
                        break;
                    }
                };
                match decode_frame(&inbound.frame, &self.identity)
                    .and_then(|message| self.accept(message, inbound.received_at, now, &mut events))
                {
                    Ok(()) => {}
                    Err(message) => {
                        self.fail(HostError::new("protocol_error", message));
                        break;
                    }
                }
            }
        }
        if matches!(self.state, HostState::Starting | HostState::Ready)
            || (self.state == HostState::Stopping
                && self.allow_shutdown_requests
                && self.stop_grace_until.is_some_and(|deadline| now < deadline))
        {
            if self.state == HostState::Starting && now >= self.startup_deadline {
                self.fail(HostError::new(
                    "startup_timeout",
                    "Host initialization did not finish within 5 seconds",
                ));
            }
            let partial = *self
                .io
                .partial_since
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if partial
                .is_some_and(|started| now.saturating_duration_since(started) >= REQUEST_TIMEOUT)
            {
                self.fail(HostError::new(
                    "frame_timeout",
                    "Host left an incomplete stdout frame beyond its absolute deadline",
                ));
            }
            let writing = *self
                .io
                .write_deadline
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if writing.is_some_and(|expires| now >= expires) {
                self.fail(HostError::new(
                    "write_timeout",
                    "Host did not consume its stdin frame before the deadline",
                ));
            }
            let expired: Vec<_> = self
                .outgoing_pending
                .iter()
                .filter_map(|(id, expires)| (now >= *expires).then_some(*id))
                .collect();
            for id in expired {
                self.cancel_request(id);
                events.push(HostEvent::RequestTimedOut { id });
            }
            let unanswered: Vec<_> = self
                .incoming_pending
                .iter()
                .filter_map(|(id, expires)| (now >= *expires).then_some(*id))
                .collect();
            for id in unanswered {
                self.incoming_pending.remove(&id);
                let _ = self.enqueue(
                    WireMessage::response(
                        &self.identity,
                        id,
                        Err(HostRpcError::new(
                            "request_timeout",
                            "Core did not answer before the Host request deadline",
                        )),
                    ),
                    now + REQUEST_TIMEOUT,
                );
            }
        }
        match self.process.wait(Duration::ZERO) {
            Ok(Some(exit_code)) => {
                if self.process_exited_at.is_none() {
                    self.process_exited_at = Some(now);
                    // Job closure also releases descendants holding stdio open.
                    // Let workers consume the bounded OS pipe tail before EOF;
                    // cancelling immediately could hide a final truncated frame.
                    let _ = self.process.terminate();
                    self.outgoing.take();
                    self.incoming_pending.clear();
                }
                self.exit_code = Some(exit_code);
                if self.state != HostState::Failed {
                    self.state = HostState::Exited;
                }
                if now.saturating_duration_since(self.process_exited_at.unwrap()) >= EXIT_DRAIN {
                    self.io.cancel();
                }
            }
            Ok(None)
                if self.io.stdout_closed.load(Ordering::Acquire)
                    && matches!(self.state, HostState::Starting | HostState::Ready) =>
            {
                let since = self.stdout_closed_since.get_or_insert(now);
                if now.saturating_duration_since(*since) >= IO_POLL {
                    self.fail(HostError::new(
                        "stdout_closed",
                        "Host closed its protocol stream while its process remained alive",
                    ));
                }
            }
            Ok(None) => {}
            Err(error) => self.fail(HostError::new("process_wait_failed", error.to_string())),
        }
        self.join_finished();
        if self.exit_code.is_some() && !self.job_empty {
            match self.process.job_is_empty() {
                Ok(empty) => self.job_empty = empty,
                Err(error) => self.fail(HostError::new("job_query_failed", error.to_string())),
            }
        }
        if let Some(error) = &self.failure
            && !self.failure_reported
        {
            self.failure_reported = true;
            events.push(HostEvent::Failed {
                error: error.clone(),
            });
        }
        if let Some(exit_code) = self.exit_code
            && !self.exit_reported
            && self.workers.is_empty()
            && self.job_empty
            && (self.state == HostState::Failed || (input_final && input_exhausted))
        {
            self.cancel_outgoing();
            self.exit_reported = true;
            events.push(HostEvent::Exited { exit_code });
        }
        events
    }

    /// Begins bounded shutdown without waiting. The owner must continue polling;
    /// this lets one failing plugin retire without blocking another plugin's RPC.
    pub fn begin_stop(&mut self) {
        let grace_until = *self
            .stop_grace_until
            .get_or_insert_with(|| Instant::now() + STOP_GRACE);
        if self.exit_code.is_none() && matches!(self.state, HostState::Starting | HostState::Ready)
        {
            if !self.shutdown_sent {
                self.shutdown_sent = true;
                self.incoming_pending.clear();
                self.cancel_outgoing();
                let params = if self.allow_shutdown_requests {
                    serde_json::json!({"cleanupBudgetMs":grace_until.saturating_duration_since(Instant::now()).as_millis()})
                } else {
                    Value::Null
                };
                match self.send_request("shutdown", params, STOP_GRACE) {
                    Ok(id) => {
                        self.shutdown_request_id = Some(id);
                        self.outgoing_pending.insert(id, grace_until);
                    }
                    Err(error) => self.fail(error),
                }
            }
            if self.state != HostState::Failed {
                self.state = HostState::Stopping;
            }
        }
    }

    /// Opt-in request delivery during the same finite shutdown budget. The
    /// caller must admit only its explicit cleanup protocol and existing grants.
    pub(crate) fn begin_stop_with_requests(&mut self) -> Option<Instant> {
        if matches!(self.state, HostState::Starting | HostState::Ready) {
            self.allow_shutdown_requests = true;
        }
        self.begin_stop();
        (self.allow_shutdown_requests && self.state == HostState::Stopping)
            .then_some(self.stop_grace_until)
            .flatten()
    }

    pub(crate) fn shutdown_request_id(&self) -> Option<u64> {
        self.shutdown_request_id
    }

    pub fn exit_report(&self) -> Option<HostExitReport> {
        if !self.exit_reported || !self.workers.is_empty() || !self.job_empty {
            return None;
        }
        Some(HostExitReport {
            process_id: self.process.pid(),
            exit_code: self.exit_code?,
            forced: self.forced,
            workers_reaped: true,
        })
    }

    /// Sends shutdown once, reserving the end of the two-second budget for job
    /// termination and cancellable worker cleanup. Repeated calls never respawn.
    pub fn stop(&mut self) -> Result<HostExitReport, HostError> {
        self.begin_stop();
        let started = Instant::now();
        let expires_at = started + STOP_TIMEOUT;
        let grace_until = self.stop_grace_until.unwrap_or(started);
        while self.exit_code.is_none()
            && self.state != HostState::Failed
            && Instant::now() < grace_until
        {
            let _ = self.poll();
            if self.exit_code.is_none() {
                thread::sleep(Duration::from_millis(1));
            }
        }
        if self.exit_code.is_none() {
            self.forced = true;
            self.process
                .terminate()
                .map_err(|error| HostError::new("terminate_failed", error.to_string()))?;
        }
        self.outgoing.take();
        while (self.exit_code.is_none() || !self.workers.is_empty() || !self.exit_reported)
            && Instant::now() < expires_at
        {
            let _ = self.poll();
            if self.exit_code.is_none() || !self.workers.is_empty() || !self.exit_reported {
                thread::sleep(Duration::from_millis(1));
            }
        }
        let Some(exit_code) = self.exit_code else {
            return Err(HostError::new(
                "cleanup_incomplete",
                "owned Host process exit was not observed before the shutdown deadline",
            ));
        };
        if !self.workers.is_empty() || !self.job_empty || !self.exit_reported {
            return Err(HostError::new(
                "cleanup_incomplete",
                "owned plugin job and stdio workers have not completed retirement",
            ));
        }
        Ok(HostExitReport {
            process_id: self.process.pid(),
            exit_code,
            forced: self.forced,
            workers_reaped: true,
        })
    }

    fn ensure_admission(&self) -> Result<(), HostError> {
        if matches!(self.state, HostState::Starting | HostState::Ready) {
            Ok(())
        } else {
            Err(HostError::new(
                "host_unavailable",
                "this Host no longer accepts requests",
            ))
        }
    }

    fn enqueue(&mut self, message: WireMessage, expires_at: Instant) -> Result<(), HostError> {
        self.enqueue_cancellable(message, expires_at, None)
    }

    fn enqueue_cancellable(
        &mut self,
        message: WireMessage,
        expires_at: Instant,
        cancelled: Option<Arc<AtomicBool>>,
    ) -> Result<(), HostError> {
        let frame =
            encode_frame(&message).map_err(|message| HostError::new("frame_too_large", message))?;
        let result = self
            .outgoing
            .as_ref()
            .ok_or_else(|| HostError::new("host_unavailable", "Host stdin is closed"))?
            .try_send(Outbound {
                frame,
                expires_at,
                cancelled,
            });
        match result {
            Ok(()) => Ok(()),
            Err(error) => {
                let error = HostError::new(
                    "outgoing_queue_full",
                    format!("Host stdin queue refused a frame: {error}"),
                );
                self.fail(error.clone());
                Err(error)
            }
        }
    }

    fn accept(
        &mut self,
        message: WireMessage,
        received_at: Instant,
        now: Instant,
        events: &mut Vec<HostEvent>,
    ) -> Result<(), String> {
        match message {
            WireMessage::Request {
                id,
                method,
                params,
                timeout_ms,
                ..
            } => {
                if self.exit_code.is_some() {
                    return Ok(());
                }
                if id <= self.last_received_id {
                    return Err("Host request ids must increase and cannot be repeated".into());
                }
                if self.incoming_pending.len() >= MAX_HOST_PENDING_REQUESTS {
                    return Err("Host exceeded its pending request limit".into());
                }
                self.last_received_id = id;
                if self.state == HostState::Stopping
                    && !(self.allow_shutdown_requests
                        && self.stop_grace_until.is_some_and(|deadline| now < deadline))
                {
                    self.enqueue(
                        WireMessage::response(
                            &self.identity,
                            id,
                            Err(HostRpcError::new(
                                "host_stopping",
                                "Core is stopping this Host",
                            )),
                        ),
                        now + STOP_TIMEOUT,
                    )
                    .map_err(|error| error.to_string())?;
                } else {
                    let requested_deadline = received_at
                        + timeout_ms
                            .map(Duration::from_millis)
                            .unwrap_or(REQUEST_TIMEOUT);
                    if now >= requested_deadline {
                        self.enqueue(
                            WireMessage::response(
                                &self.identity,
                                id,
                                Err(HostRpcError::new(
                                    "request_timeout",
                                    "Host request expired before owner dispatch",
                                )),
                            ),
                            now + REQUEST_TIMEOUT,
                        )
                        .map_err(|error| error.to_string())?;
                        return Ok(());
                    }
                    let deadline = if self.state == HostState::Stopping {
                        requested_deadline.min(
                            self.stop_grace_until
                                .expect("admitted shutdown request has a deadline"),
                        )
                    } else {
                        requested_deadline
                    };
                    self.incoming_pending.insert(id, deadline);
                    events.push(HostEvent::Request { id, method, params });
                }
            }
            WireMessage::Response {
                id,
                ok,
                result,
                error,
                ..
            } => {
                if id > self.last_issued_id {
                    return Err("Host answered a request id that Core never issued".into());
                }
                if let Some(expires_at) = self.outgoing_pending.remove(&id) {
                    self.outgoing_cancellation.remove(&id);
                    if now >= expires_at {
                        events.push(HostEvent::RequestTimedOut { id });
                    } else {
                        events.push(HostEvent::Response {
                            id,
                            result: if ok {
                                Ok(result.unwrap_or(Value::Null))
                            } else {
                                Err(error.expect("wire error was validated"))
                            },
                        });
                    }
                }
                // An old response has no pending request and cannot revive it.
            }
            WireMessage::Notification { method, params, .. } => {
                if self.state != HostState::Stopping {
                    events.push(HostEvent::Notification { method, params });
                }
            }
        }
        Ok(())
    }

    fn fail(&mut self, error: HostError) {
        if self.failure.is_none() {
            self.failure = Some(error);
        }
        self.state = HostState::Failed;
        self.cancel_outgoing();
        self.incoming_pending.clear();
        self.forced = true;
        let _ = self.process.terminate();
        self.io.cancel();
        self.outgoing.take();
    }

    fn join_finished(&mut self) {
        let mut index = 0;
        while index < self.workers.len() {
            if self.workers[index].is_finished() {
                let worker = self.workers.swap_remove(index);
                if worker.join().is_err() {
                    self.fail(HostError::new(
                        "worker_panicked",
                        "Host stdio worker panicked",
                    ));
                }
            } else {
                index += 1;
            }
        }
    }
}

impl Drop for HostSupervisor {
    fn drop(&mut self) {
        let _ = self.stop();
        // These workers perform only local overlapped pipe IO and channel waits.
        // Cancellation removes their external wait; never detach an owned worker.
        self.io.cancel();
        self.outgoing.take();
        let _ = self.process.terminate();
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}

fn deadline(timeout: Duration) -> Result<Instant, HostError> {
    if timeout.is_zero() || timeout > REQUEST_TIMEOUT {
        return Err(HostError::new(
            "invalid_timeout",
            "Host request timeout must be greater than zero and at most 15 seconds",
        ));
    }
    Instant::now().checked_add(timeout).ok_or_else(|| {
        HostError::new(
            "invalid_timeout",
            "Host request deadline cannot be represented",
        )
    })
}

fn spawn_worker(
    name: &'static str,
    io: Arc<IoState>,
    run: impl FnOnce(Arc<IoState>) + Send + 'static,
) -> Result<JoinHandle<()>, HostError> {
    thread::Builder::new()
        .name(format!("codlet-host-{name}"))
        .spawn(move || run(io))
        .map_err(|error| HostError::new("worker_spawn_failed", error.to_string()))
}

fn read_stdout(channel: Channel, sender: mpsc::SyncSender<Inbound>, io: Arc<IoState>) {
    let mut decoder = LineDecoder::default();
    let mut chunk = [0_u8; 4096];
    while !io.is_stopping() {
        match channel.read_some(&mut chunk, None) {
            Ok(0) => break,
            Ok(count) => {
                let was_partial = decoder.has_partial_frame();
                let frames = match decoder.push(&chunk[..count]) {
                    Ok(frames) => frames,
                    Err(message) => {
                        io.fail(HostError::new("protocol_error", message));
                        break;
                    }
                };
                let mut partial = io.partial_since.lock().unwrap_or_else(|p| p.into_inner());
                if decoder.has_partial_frame() {
                    if !was_partial || chunk[..count].contains(&b'\n') {
                        *partial = Some(Instant::now());
                    }
                } else {
                    *partial = None;
                }
                drop(partial);
                for frame in frames {
                    if sender
                        .try_send(Inbound {
                            frame,
                            received_at: Instant::now(),
                        })
                        .is_err()
                    {
                        io.fail(HostError::new(
                            "incoming_queue_full",
                            "Host stdout exceeded its four-frame queue",
                        ));
                        io.stdout_closed.store(true, Ordering::Release);
                        return;
                    }
                }
            }
            Err(error) if stream_closed(&error) => break,
            Err(LocalIpcError::Stopping) => break,
            Err(error) => {
                io.fail(HostError::new("stdout_read_failed", error.to_string()));
                break;
            }
        }
    }
    if decoder.has_partial_frame() && !io.is_stopping() {
        io.fail(HostError::new(
            "protocol_error",
            "Host stdout ended with an incomplete JSONL frame",
        ));
    }
    io.stdout_closed.store(true, Ordering::Release);
}

fn write_stdin(channel: Channel, receiver: mpsc::Receiver<Outbound>, io: Arc<IoState>) {
    while !io.is_stopping() {
        let outbound = match receiver.recv_timeout(IO_POLL) {
            Ok(outbound) => outbound,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        if Instant::now() >= outbound.expires_at
            || outbound
                .cancelled
                .as_ref()
                .is_some_and(|flag| flag.load(Ordering::Acquire))
        {
            continue;
        }
        *io.write_deadline.lock().unwrap_or_else(|p| p.into_inner()) = Some(outbound.expires_at);
        let result = channel.write_all(&outbound.frame, outbound.expires_at);
        *io.write_deadline.lock().unwrap_or_else(|p| p.into_inner()) = None;
        if let Err(error) = result {
            if !io.is_stopping() {
                io.fail(HostError::new("stdin_write_failed", error.to_string()));
            }
            break;
        }
    }
}

fn read_stderr(channel: Channel, io: Arc<IoState>) {
    let mut chunk = [0_u8; 4096];
    while !io.is_stopping() {
        match channel.read_some(&mut chunk, None) {
            Ok(0) => break,
            Ok(count) => {
                let mut tail = io.stderr_tail.lock().unwrap_or_else(|p| p.into_inner());
                let discard = tail
                    .len()
                    .saturating_add(count)
                    .saturating_sub(STDERR_TAIL_BYTES);
                tail.drain(..discard);
                tail.extend(&chunk[..count]);
            }
            Err(error) if stream_closed(&error) => break,
            Err(LocalIpcError::Stopping) => break,
            Err(error) => {
                io.fail(HostError::new("stderr_read_failed", error.to_string()));
                break;
            }
        }
    }
}

fn stream_closed(error: &LocalIpcError) -> bool {
    matches!(
        error,
        LocalIpcError::Win32 {
            code: ERROR_BROKEN_PIPE | ERROR_NO_DATA | ERROR_PIPE_NOT_CONNECTED,
            ..
        }
    )
}
