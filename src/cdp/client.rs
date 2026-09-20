use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Map, Value};
use thiserror::Error;

#[cfg(all(test, windows))]
use super::framing::MAX_CDP_FRAME_BYTES;
use super::framing::{FramingError, NulJsonDecoder, encode_json_frame};

const DEFAULT_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

mod contexts;
#[cfg(all(test, windows))]
mod core_rpc_vm_tests;
#[cfg(all(test, windows))]
mod host_attachment_vm_tests;
#[cfg(all(test, windows))]
mod host_renderer_vm_tests;
#[cfg(all(test, windows))]
mod m2_raw_vm_tests;
#[cfg(all(test, windows))]
mod main_world_vm_tests;
mod raw_access;
pub use raw_access::{BoundedCdpEvents, CdpEventFilter, QueuedCdpRequest};
use raw_access::{BoundedEventSink, RawWritePermit};

#[derive(Debug, Clone, PartialEq)]
pub struct RemoteError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CdpResponse {
    pub id: u64,
    pub result: Option<Value>,
    pub error: Option<RemoteError>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CdpEvent {
    pub method: String,
    pub params: Option<Value>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum ConnectionError {
    #[error("CDP pipe reached EOF")]
    Eof,
    #[error("failed to read CDP pipe: {message}")]
    Read { message: String },
    #[error(transparent)]
    Framing(FramingError),
    #[error("invalid CDP message: {0}")]
    Protocol(String),
    #[error("received response for unknown request id {0}")]
    UnexpectedResponseId(u64),
    #[error("response {id} used sessionId {actual:?}, but the request expected {expected:?}")]
    ResponseSessionMismatch {
        id: u64,
        expected: Option<String>,
        actual: Option<String>,
    },
    #[error("CDP request {id} ({method}) exceeded its deadline while writing")]
    RequestTimedOut { id: u64, method: String },
    #[error("CDP client was shut down")]
    Shutdown,
}

#[derive(Debug, Error)]
pub enum ClientError {
    #[error("CDP target session {0} has ended")]
    SessionEnded(String),
    #[error("CDP connection closed: {0}")]
    Connection(Arc<ConnectionError>),
    #[error("CDP request {id} ({method}) exceeded its deadline")]
    RequestTimedOut { id: u64, method: String },
    #[error("CDP request deadline cannot be represented")]
    DeadlineOutOfRange,
    #[error("CDP request frame exceeds the {max_bytes}-byte limit")]
    RequestFrameTooLarge { max_bytes: usize },
    #[error("the bounded raw CDP request queue is full")]
    RequestQueueFull,
    #[error(
        "CDP event method filter must contain 1..32 distinct nonempty method names of at most 256 bytes"
    )]
    InvalidEventFilter,
    #[error("CDP method {method} failed with code {error_code}: {message}")]
    Remote {
        method: String,
        error_code: i64,
        message: String,
        data: Option<Value>,
    },
}

#[derive(Debug, Error)]
pub enum EventStreamError {
    #[error("timed out waiting for a CDP event")]
    Timeout,
    #[error("CDP connection closed: {0}")]
    Connection(Arc<ConnectionError>),
    #[error("CDP event stream disconnected")]
    Disconnected,
    #[error("CDP event subscription overflowed; resubscribe and obtain a fresh snapshot")]
    Overflow,
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum ShutdownError {
    #[error("failed to cancel {worker} CDP I/O: OS error {code}")]
    CancelIo { worker: &'static str, code: u32 },
    #[error("{worker} CDP worker panicked")]
    WorkerPanicked { worker: &'static str },
    #[error(
        "CDP workers did not stop within {timeout_ms}ms (reader active: {reader_active}, writer active: {writer_active}); first cancellation failure: {cancellation_failure:?}"
    )]
    WorkersDidNotStop {
        timeout_ms: u64,
        reader_active: bool,
        writer_active: bool,
        cancellation_failure: Option<CancelIoFailure>,
    },
    #[error("another CDP shutdown call did not finish within {timeout_ms}ms")]
    ConcurrentShutdownTimedOut { timeout_ms: u64 },
}

#[derive(Debug, Error)]
pub enum ClientSpawnError {
    #[error("failed to spawn the CDP {worker} thread: {source}")]
    ThreadSpawn {
        worker: &'static str,
        #[source]
        source: io::Error,
    },
    #[error("failed to prepare CDP {worker} I/O cancellation: OS error {code}")]
    CancellationHandle { worker: &'static str, code: u32 },
    #[error("the CDP {worker} thread exited during startup")]
    StartupDisconnected { worker: &'static str },
    #[error("CDP startup failed ({primary}) and worker cleanup also failed ({cleanup})")]
    Cleanup {
        primary: Box<ClientSpawnError>,
        cleanup: ShutdownError,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CancelIoFailure {
    pub worker: &'static str,
    pub code: u32,
}

type PendingSender = mpsc::Sender<Result<CdpResponse, Arc<ConnectionError>>>;
type EventItem = Result<CdpEvent, Arc<ConnectionError>>;

struct PendingRequest {
    expected_session: Option<String>,
    sender: PendingSender,
}

struct EventSink {
    registration_id: u64,
    session_id: Option<String>,
    sender: mpsc::Sender<EventItem>,
}

struct State {
    terminal: Option<Arc<ConnectionError>>,
    pending: HashMap<u64, PendingRequest>,
    // Request IDs are committed contiguously only after their frame enters the writer queue.
    // An absent ID at or below this watermark is therefore retired or a duplicate, never a gap.
    last_issued_id: u64,
    events: Vec<EventSink>,
    bounded_events: Vec<BoundedEventSink>,
    next_event_registration_id: u64,
    activity_epoch: u64,
    sessions: HashMap<String, (String, Weak<AtomicBool>)>,
    default_contexts: contexts::DefaultContexts,
}

struct Shared {
    state: Mutex<State>,
    closed: Condvar,
    activity: Condvar,
}

enum WriterCommand {
    Frame {
        bytes: Vec<u8>,
        expires_at: Instant,
        timeout_error: Arc<ConnectionError>,
        completion: mpsc::Sender<Result<(), Arc<ConnectionError>>>,
        raw_permit: Option<RawWritePermit>,
    },
    Shutdown,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WorkerKind {
    Reader,
    Writer,
}

impl WorkerKind {
    fn name(self) -> &'static str {
        match self {
            Self::Reader => "reader",
            Self::Writer => "writer",
        }
    }
}

#[derive(Default)]
struct CancellationSlots {
    reader: Option<platform::ThreadCancelHandle>,
    writer: Option<platform::ThreadCancelHandle>,
}

#[derive(Default)]
struct WorkerCancellation {
    slots: Mutex<CancellationSlots>,
    #[cfg(test)]
    forced_failure: Mutex<Option<(WorkerKind, u32)>>,
}

impl WorkerCancellation {
    fn register_current(&self, worker: WorkerKind) -> Result<(), u32> {
        let mut slots = self.slots.lock().expect("CDP cancellation state poisoned");
        let slot = match worker {
            WorkerKind::Reader => &mut slots.reader,
            WorkerKind::Writer => &mut slots.writer,
        };
        if slot.is_none() {
            *slot = Some(platform::ThreadCancelHandle::current()?);
        }
        Ok(())
    }

    fn cancel(&self, worker: WorkerKind) -> Result<(), u32> {
        #[cfg(test)]
        if let Some((forced_worker, code)) = *self
            .forced_failure
            .lock()
            .expect("CDP cancellation test state poisoned")
            && forced_worker == worker
        {
            return Err(code);
        }

        let slots = self.slots.lock().expect("CDP cancellation state poisoned");
        let handle = match worker {
            WorkerKind::Reader => slots.reader.as_ref(),
            WorkerKind::Writer => slots.writer.as_ref(),
        };
        match handle {
            Some(handle) => handle.cancel(),
            None => Ok(()),
        }
    }

    #[cfg(all(test, windows))]
    fn force_failure(&self, failure: Option<(WorkerKind, u32)>) {
        *self
            .forced_failure
            .lock()
            .expect("CDP cancellation test state poisoned") = failure;
    }
}

struct Runtime {
    shared: Arc<Shared>,
    writer_sender: mpsc::Sender<WriterCommand>,
    cancellation: Arc<WorkerCancellation>,
    #[cfg(test)]
    worker_activity: Arc<TestWorkers>,
}

impl Runtime {
    fn stop(&self, error: Arc<ConnectionError>) {
        terminate(&self.shared, error);
        let _ = self.writer_sender.send(WriterCommand::Shutdown);
        let _ = self.cancellation.cancel(WorkerKind::Reader);
        let _ = self.cancellation.cancel(WorkerKind::Writer);
    }
}

struct WorkerHandles {
    reader: Option<JoinHandle<()>>,
    writer: Option<JoinHandle<()>>,
    completed_error: Option<ShutdownError>,
}

enum ShutdownStatus {
    Running(WorkerHandles),
    Joining,
    Done(Result<(), ShutdownError>),
}

struct ClientInner {
    runtime: Arc<Runtime>,
    next_id: Mutex<u64>,
    raw_writes: Arc<AtomicUsize>,
    raw_write_deadline: raw_access::RawWriteDeadline,
    shutdown: Mutex<ShutdownStatus>,
    shutdown_complete: Condvar,
    shutdown_timeout: Duration,
}

impl ClientInner {
    fn shutdown(&self) -> Result<(), ShutdownError> {
        self.runtime.stop(Arc::new(ConnectionError::Shutdown));

        let workers = {
            let wait_deadline = Instant::now() + self.shutdown_timeout;
            let mut status = self.shutdown.lock().expect("CDP shutdown state poisoned");
            loop {
                match &*status {
                    ShutdownStatus::Joining => {
                        let (next_status, wait_result) = self
                            .shutdown_complete
                            .wait_timeout(status, remaining(wait_deadline))
                            .expect("CDP shutdown state poisoned while waiting");
                        status = next_status;
                        if (wait_result.timed_out() || Instant::now() >= wait_deadline)
                            && matches!(&*status, ShutdownStatus::Joining)
                        {
                            return Err(ShutdownError::ConcurrentShutdownTimedOut {
                                timeout_ms: duration_millis(self.shutdown_timeout),
                            });
                        }
                    }
                    ShutdownStatus::Done(result) => return result.clone(),
                    ShutdownStatus::Running(_) => {
                        match std::mem::replace(&mut *status, ShutdownStatus::Joining) {
                            ShutdownStatus::Running(workers) => break workers,
                            _ => unreachable!(),
                        }
                    }
                }
            }
        };

        let outcome = join_workers(workers, &self.runtime.cancellation, self.shutdown_timeout);
        let mut status = self.shutdown.lock().expect("CDP shutdown state poisoned");
        let result = match outcome {
            JoinOutcome::Finished(result) => {
                *status = ShutdownStatus::Done(result.clone());
                result
            }
            JoinOutcome::TimedOut(workers, error) => {
                *status = ShutdownStatus::Running(workers);
                Err(error)
            }
        };
        self.shutdown_complete.notify_all();
        result
    }
}

impl Drop for ClientInner {
    fn drop(&mut self) {
        if let Err(error) = self.shutdown() {
            if matches!(
                &error,
                ShutdownError::WorkersDidNotStop { .. }
                    | ShutdownError::ConcurrentShutdownTimedOut { .. }
            ) {
                eprintln!(
                    "fatal: Codlet CDP shutdown did not complete ({error}); aborting Codlet so no detached worker thread survives; inherited CDP pipe disconnect only requests cooperative Electron shutdown, so Codex may remain alive"
                );
                std::process::abort();
            }
            eprintln!("Codlet CDP shutdown completed with an error: {error}");
        }
    }
}

#[derive(Clone)]
pub struct CdpClient {
    inner: Arc<ClientInner>,
}

pub(crate) struct CdpRequest {
    client: CdpClient,
    id: u64,
    method: String,
    expires_at: Instant,
    receiver: mpsc::Receiver<Result<CdpResponse, Arc<ConnectionError>>>,
    completed: bool,
}

pub struct CdpEventStream {
    receiver: mpsc::Receiver<EventItem>,
    session_id: Option<String>,
    shared: Weak<Shared>,
    registration_id: Option<u64>,
}

#[derive(Clone, Copy)]
struct SpawnConfig {
    shutdown_timeout: Duration,
    fail_thread_spawn: Option<WorkerKind>,
}

impl Default for SpawnConfig {
    fn default() -> Self {
        Self {
            shutdown_timeout: DEFAULT_SHUTDOWN_TIMEOUT,
            fail_thread_spawn: None,
        }
    }
}

#[derive(Serialize)]
struct OutgoingRequest<'a> {
    id: u64,
    method: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    session_id: Option<&'a str>,
}

impl CdpClient {
    /// Wake the existing renderer drive when another owned executor has a local
    /// completion. This publishes no CDP event and does not complete any request.
    #[cfg(any(windows, target_os = "macos"))]
    pub(crate) fn notify_runtime_activity(&self) {
        let shared = &self.inner.runtime.shared;
        let mut state = shared
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.activity_epoch = state.activity_epoch.wrapping_add(1);
        drop(state);
        shared.activity.notify_all();
    }

    #[cfg(windows)]
    /// Starts CDP workers for the exact pipe pair created by Codlet's Windows launcher.
    pub fn spawn(
        pipes: crate::windows::pipes::ParentCdpPipes,
    ) -> Result<(Self, CdpEventStream), ClientSpawnError> {
        let (reader, writer) = pipes.into_parts();
        Self::spawn_io(reader, writer, SpawnConfig::default())
    }

    #[cfg(target_os = "macos")]
    /// macOS workers retain their own socket shutdown handles. Cancellation
    /// interrupts both blocked reads and blocked writes without closing a reused fd.
    pub fn spawn(
        pipes: crate::macos::pipes::ParentCdpPipes,
    ) -> Result<(Self, CdpEventStream), ClientSpawnError> {
        let (reader, writer) = pipes.into_parts();
        let cancel = |stream: &std::os::unix::net::UnixStream, worker| {
            stream
                .try_clone()
                .map(platform::ThreadCancelHandle::socket)
                .map_err(|e| ClientSpawnError::CancellationHandle {
                    worker,
                    code: e.raw_os_error().unwrap_or(0) as u32,
                })
        };
        let slots = CancellationSlots {
            reader: Some(cancel(&reader, "reader")?),
            writer: Some(cancel(&writer, "writer")?),
        };
        Self::spawn_with_cancellation(reader, writer, SpawnConfig::default(), slots)
    }

    #[cfg(windows)]
    fn spawn_io<R, W>(
        reader: R,
        writer: W,
        config: SpawnConfig,
    ) -> Result<(Self, CdpEventStream), ClientSpawnError>
    where
        R: Read + Send + 'static,
        W: Write + Send + 'static,
    {
        Self::spawn_with_cancellation(reader, writer, config, CancellationSlots::default())
    }

    fn spawn_with_cancellation<R, W>(
        reader: R,
        writer: W,
        config: SpawnConfig,
        slots: CancellationSlots,
    ) -> Result<(Self, CdpEventStream), ClientSpawnError>
    where
        R: Read + Send + 'static,
        W: Write + Send + 'static,
    {
        let (event_sender, event_receiver) = mpsc::channel();
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                terminal: None,
                pending: HashMap::new(),
                last_issued_id: 0,
                events: vec![EventSink {
                    registration_id: 1,
                    session_id: None,
                    sender: event_sender,
                }],
                bounded_events: Vec::new(),
                next_event_registration_id: 2,
                activity_epoch: 0,
                sessions: HashMap::new(),
                default_contexts: contexts::DefaultContexts::default(),
            }),
            closed: Condvar::new(),
            activity: Condvar::new(),
        });
        let (writer_sender, writer_receiver) = mpsc::channel();
        let cancellation = Arc::new(WorkerCancellation {
            slots: Mutex::new(slots),
            #[cfg(test)]
            forced_failure: Mutex::default(),
        });
        let runtime = Arc::new(Runtime {
            shared,
            writer_sender,
            cancellation,
            #[cfg(test)]
            worker_activity: TEST_WORKERS.with(Arc::clone),
        });

        let writer_runtime = Arc::clone(&runtime);
        let writer_thread = spawn_worker(
            WorkerKind::Writer,
            Arc::clone(&runtime),
            config.fail_thread_spawn,
            move || writer_loop(writer, writer_receiver, &writer_runtime),
        )?;

        let reader_runtime = Arc::clone(&runtime);
        let reader_thread = match spawn_worker(
            WorkerKind::Reader,
            Arc::clone(&runtime),
            config.fail_thread_spawn,
            move || reader_loop(reader, &reader_runtime),
        ) {
            Ok(thread) => thread,
            Err(primary) => {
                let cleanup = cleanup_failed_startup(
                    &runtime,
                    WorkerHandles {
                        reader: None,
                        writer: Some(writer_thread),
                        completed_error: None,
                    },
                    primary,
                    config.shutdown_timeout,
                );
                return Err(startup_cleanup_error_or_abort(cleanup));
            }
        };

        Ok((
            Self {
                inner: Arc::new(ClientInner {
                    runtime: Arc::clone(&runtime),
                    next_id: Mutex::new(1),
                    raw_writes: Arc::new(AtomicUsize::new(0)),
                    raw_write_deadline: Arc::new(Mutex::new(None)),
                    shutdown: Mutex::new(ShutdownStatus::Running(WorkerHandles {
                        reader: Some(reader_thread),
                        writer: Some(writer_thread),
                        completed_error: None,
                    })),
                    shutdown_complete: Condvar::new(),
                    shutdown_timeout: config.shutdown_timeout,
                }),
            },
            CdpEventStream {
                receiver: event_receiver,
                session_id: None,
                shared: Arc::downgrade(&runtime.shared),
                registration_id: Some(1),
            },
        ))
    }

    pub fn request(
        &self,
        method: &str,
        params: Option<Value>,
        session_id: Option<&str>,
        deadline: Duration,
    ) -> Result<CdpResponse, ClientError> {
        self.start_request(method, params, session_id, deadline)?
            .wait()
    }

    pub(crate) fn start_request(
        &self,
        method: &str,
        params: Option<Value>,
        session_id: Option<&str>,
        deadline: Duration,
    ) -> Result<CdpRequest, ClientError> {
        let expires_at = Instant::now()
            .checked_add(deadline)
            .ok_or(ClientError::DeadlineOutOfRange)?;
        self.start_request_until(method, params, session_id, expires_at)
    }

    pub(crate) fn start_request_until(
        &self,
        method: &str,
        params: Option<Value>,
        session_id: Option<&str>,
        expires_at: Instant,
    ) -> Result<CdpRequest, ClientError> {
        self.enqueue_request_until(method, params, session_id, expires_at, false)?
            .wait_written()
    }

    fn enqueue_request_until(
        &self,
        method: &str,
        params: Option<Value>,
        session_id: Option<&str>,
        expires_at: Instant,
        bounded: bool,
    ) -> Result<QueuedCdpRequest, ClientError> {
        let raw_permit = bounded
            .then(|| {
                RawWritePermit::acquire(&self.inner.raw_writes, &self.inner.raw_write_deadline)
            })
            .transpose()?;
        let raw_state = raw_permit.as_ref().map(|permit| Arc::clone(&permit.state));
        let mut next_id = self
            .inner
            .next_id
            .lock()
            .expect("CDP request issuer poisoned");
        let id = *next_id;
        let following_id = id.checked_add(1).expect("CDP request id overflowed");
        let timeout_error = Arc::new(ConnectionError::RequestTimedOut {
            id,
            method: method.to_owned(),
        });
        let request = OutgoingRequest {
            id,
            method,
            params,
            session_id,
        };
        let bytes = match encode_json_frame(&request) {
            Ok(bytes) => bytes,
            Err(FramingError::FrameTooLarge { max_bytes }) => {
                return Err(ClientError::RequestFrameTooLarge { max_bytes });
            }
            Err(error) => {
                let error = Arc::new(ConnectionError::Framing(error));
                self.inner.runtime.stop(Arc::clone(&error));
                return Err(ClientError::Connection(error));
            }
        };
        if bounded && bytes.len() > raw_access::MAX_RAW_FRAME_BYTES {
            return Err(ClientError::RequestFrameTooLarge {
                max_bytes: raw_access::MAX_RAW_FRAME_BYTES,
            });
        }
        let (response_sender, response_receiver) = mpsc::channel();
        let (write_sender, write_receiver) = mpsc::channel();
        {
            let mut state = self
                .inner
                .runtime
                .shared
                .state
                .lock()
                .expect("CDP state poisoned");
            if let Some(error) = &state.terminal {
                return Err(ClientError::Connection(Arc::clone(error)));
            }
            if let Some(session_id) = session_id
                && state
                    .sessions
                    .get(session_id)
                    .and_then(|(_, live)| live.upgrade())
                    .is_some_and(|live| !live.load(Ordering::Acquire))
            {
                return Err(ClientError::SessionEnded(session_id.to_owned()));
            }
            // An exhausted nested budget must not enqueue a zero-budget write:
            // the transport treats a write timeout as a connection failure.
            if Instant::now() >= expires_at {
                return Err(ClientError::RequestTimedOut {
                    id,
                    method: method.to_owned(),
                });
            }
            if self
                .inner
                .runtime
                .writer_sender
                .send(WriterCommand::Frame {
                    bytes,
                    expires_at,
                    timeout_error: Arc::clone(&timeout_error),
                    completion: write_sender,
                    raw_permit,
                })
                .is_err()
            {
                drop(state);
                let error = Arc::new(ConnectionError::Protocol(
                    "CDP writer stopped before accepting a request".to_owned(),
                ));
                self.inner.runtime.stop(Arc::clone(&error));
                return Err(ClientError::Connection(error));
            }
            assert_eq!(
                state.last_issued_id.checked_add(1),
                Some(id),
                "CDP request ids must be issued contiguously"
            );
            assert!(
                state
                    .pending
                    .insert(
                        id,
                        PendingRequest {
                            expected_session: session_id.map(str::to_owned),
                            sender: response_sender,
                        },
                    )
                    .is_none()
            );
            state.last_issued_id = id;
        }
        *next_id = following_id;
        drop(next_id);

        Ok(QueuedCdpRequest::new(
            CdpRequest {
                client: self.clone(),
                id,
                method: method.to_owned(),
                expires_at,
                receiver: response_receiver,
                completed: false,
            },
            write_receiver,
            timeout_error,
            raw_state,
        ))
    }

    pub fn subscribe_events(&self, session_id: Option<&str>) -> CdpEventStream {
        let (sender, receiver) = mpsc::channel();
        let session_id = session_id.map(str::to_owned);
        let mut state = self
            .inner
            .runtime
            .shared
            .state
            .lock()
            .expect("CDP state poisoned");
        let registration_id = if let Some(error) = &state.terminal {
            let _ = sender.send(Err(Arc::clone(error)));
            None
        } else {
            let registration_id = state.next_event_registration_id;
            state.next_event_registration_id = state
                .next_event_registration_id
                .checked_add(1)
                .expect("CDP event registration id overflowed");
            state.events.push(EventSink {
                registration_id,
                session_id: session_id.clone(),
                sender,
            });
            Some(registration_id)
        };
        drop(state);
        CdpEventStream {
            receiver,
            session_id,
            shared: Arc::downgrade(&self.inner.runtime.shared),
            registration_id,
        }
    }

    pub(crate) fn track_session(&self, target_id: &str, session_id: &str) -> Arc<AtomicBool> {
        let live = Arc::new(AtomicBool::new(true));
        let mut state = self
            .inner
            .runtime
            .shared
            .state
            .lock()
            .expect("CDP state poisoned");
        state
            .sessions
            .retain(|_, (_, live)| live.strong_count() > 0);
        let retained: Vec<_> = state.sessions.keys().cloned().collect();
        state
            .default_contexts
            .retain(|session| retained.iter().any(|id| id == session));
        state.default_contexts.forget(session_id);
        state.sessions.insert(
            session_id.to_owned(),
            (target_id.to_owned(), Arc::downgrade(&live)),
        );
        live
    }

    pub(crate) fn default_context(&self, session_id: &str, frame_id: &str) -> Option<u64> {
        let state = self
            .inner
            .runtime
            .shared
            .state
            .lock()
            .expect("CDP state poisoned");
        if state.terminal.is_some()
            || !state
                .sessions
                .get(session_id)
                .and_then(|(_, live)| live.upgrade())
                .is_some_and(|live| live.load(Ordering::Acquire))
        {
            return None;
        }
        state.default_contexts.get(session_id, frame_id)
    }

    pub fn shutdown(&self) -> Result<(), ShutdownError> {
        self.inner.shutdown()
    }

    pub fn closed_reason(&self) -> Option<Arc<ConnectionError>> {
        self.inner
            .runtime
            .shared
            .state
            .lock()
            .expect("CDP state poisoned")
            .terminal
            .clone()
    }

    pub fn wait_closed(&self, timeout: Duration) -> Option<Arc<ConnectionError>> {
        let state = self
            .inner
            .runtime
            .shared
            .state
            .lock()
            .expect("CDP state poisoned");
        let (state, _) = self
            .inner
            .runtime
            .shared
            .closed
            .wait_timeout_while(state, timeout, |state| state.terminal.is_none())
            .expect("CDP state poisoned while waiting for close");
        state.terminal.clone()
    }

    fn terminal_reason(&self) -> Arc<ConnectionError> {
        self.closed_reason()
            .expect("CDP worker disconnected without a terminal reason")
    }

    fn expire_request(
        &self,
        id: u64,
        receiver: &mpsc::Receiver<Result<CdpResponse, Arc<ConnectionError>>>,
    ) -> Result<Option<CdpResponse>, Arc<ConnectionError>> {
        let mut state = self
            .inner
            .runtime
            .shared
            .state
            .lock()
            .expect("CDP state poisoned");
        if let Some(error) = &state.terminal {
            return Err(Arc::clone(error));
        }
        if state.pending.remove(&id).is_some() {
            return Ok(None);
        }
        drop(state);
        match receiver.try_recv() {
            Ok(Ok(response)) => Ok(Some(response)),
            Ok(Err(error)) => Err(error),
            Err(mpsc::TryRecvError::Disconnected) => Err(self.terminal_reason()),
            Err(mpsc::TryRecvError::Empty) => {
                unreachable!("response sender removed the pending request before sending")
            }
        }
    }
}

impl CdpRequest {
    pub(crate) fn activity_epoch(&self) -> u64 {
        self.client
            .inner
            .runtime
            .shared
            .state
            .lock()
            .expect("CDP state poisoned")
            .activity_epoch
    }

    pub(crate) fn wait_for_activity(&self, observed_epoch: u64) {
        let shared = &self.client.inner.runtime.shared;
        let state = shared.state.lock().expect("CDP state poisoned");
        let _ = shared
            .activity
            .wait_timeout_while(state, remaining(self.expires_at), |state| {
                state.terminal.is_none() && state.activity_epoch == observed_epoch
            })
            .expect("CDP state poisoned while waiting for activity");
    }

    pub(crate) fn try_response(&mut self) -> Result<Option<CdpResponse>, ClientError> {
        match self.receiver.try_recv() {
            Ok(Ok(response)) => self.complete_response(response).map(Some),
            Ok(Err(error)) => {
                self.completed = true;
                Err(ClientError::Connection(error))
            }
            Err(mpsc::TryRecvError::Empty) if Instant::now() < self.expires_at => Ok(None),
            Err(mpsc::TryRecvError::Empty) => self.expire().map(Some),
            Err(mpsc::TryRecvError::Disconnected) => {
                self.completed = true;
                Err(ClientError::Connection(self.client.terminal_reason()))
            }
        }
    }

    pub(crate) fn wait(mut self) -> Result<CdpResponse, ClientError> {
        match self.receiver.recv_timeout(remaining(self.expires_at)) {
            Ok(Ok(response)) => self.complete_response(response),
            Ok(Err(error)) => {
                self.completed = true;
                Err(ClientError::Connection(error))
            }
            Err(mpsc::RecvTimeoutError::Timeout) => self.expire(),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                self.completed = true;
                Err(ClientError::Connection(self.client.terminal_reason()))
            }
        }
    }

    fn expire(&mut self) -> Result<CdpResponse, ClientError> {
        match self.client.expire_request(self.id, &self.receiver) {
            Ok(Some(response)) => self.complete_response(response),
            Ok(None) => {
                self.completed = true;
                Err(ClientError::RequestTimedOut {
                    id: self.id,
                    method: self.method.clone(),
                })
            }
            Err(error) => {
                self.completed = true;
                Err(ClientError::Connection(error))
            }
        }
    }

    fn complete_response(&mut self, response: CdpResponse) -> Result<CdpResponse, ClientError> {
        self.completed = true;
        if let Some(error) = response.error {
            return Err(ClientError::Remote {
                method: self.method.clone(),
                error_code: error.code,
                message: error.message,
                data: error.data,
            });
        }
        Ok(response)
    }
}

impl Drop for CdpRequest {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        self.client
            .inner
            .runtime
            .shared
            .state
            .lock()
            .expect("CDP state poisoned")
            .pending
            .remove(&self.id);
    }
}

impl CdpEventStream {
    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    pub fn recv_timeout(&self, timeout: Duration) -> Result<CdpEvent, EventStreamError> {
        match self.receiver.recv_timeout(timeout) {
            Ok(Ok(event)) => Ok(event),
            Ok(Err(error)) => Err(EventStreamError::Connection(error)),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(EventStreamError::Timeout),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(EventStreamError::Disconnected),
        }
    }
}

impl Drop for CdpEventStream {
    fn drop(&mut self) {
        let Some(registration_id) = self.registration_id.take() else {
            return;
        };
        let Some(shared) = self.shared.upgrade() else {
            return;
        };
        shared
            .state
            .lock()
            .expect("CDP state poisoned")
            .events
            .retain(|sink| sink.registration_id != registration_id);
    }
}

fn request_error(error: Arc<ConnectionError>, id: u64, method: &str) -> ClientError {
    if matches!(&*error, ConnectionError::RequestTimedOut { id: timed_out_id, .. } if *timed_out_id == id)
    {
        ClientError::RequestTimedOut {
            id,
            method: method.to_owned(),
        }
    } else {
        ClientError::Connection(error)
    }
}

fn spawn_worker<F>(
    worker: WorkerKind,
    runtime: Arc<Runtime>,
    fail_thread_spawn: Option<WorkerKind>,
    body: F,
) -> Result<JoinHandle<()>, ClientSpawnError>
where
    F: FnOnce() + Send + 'static,
{
    if fail_thread_spawn == Some(worker) {
        return Err(ClientSpawnError::ThreadSpawn {
            worker: worker.name(),
            source: io::Error::other("injected thread spawn failure"),
        });
    }

    let (ready_sender, ready_receiver) = mpsc::channel();
    let thread = thread::Builder::new()
        .name(format!("codlet-cdp-{}", worker.name()))
        .spawn(move || {
            if let Err(code) = runtime.cancellation.register_current(worker) {
                let _ = ready_sender.send(Err(code));
                return;
            }
            if ready_sender.send(Ok(())).is_err() {
                return;
            }
            body();
        })
        .map_err(|source| ClientSpawnError::ThreadSpawn {
            worker: worker.name(),
            source,
        })?;

    match ready_receiver.recv() {
        Ok(Ok(())) => Ok(thread),
        Ok(Err(code)) => {
            let _ = thread.join();
            Err(ClientSpawnError::CancellationHandle {
                worker: worker.name(),
                code,
            })
        }
        Err(_) => {
            let _ = thread.join();
            Err(ClientSpawnError::StartupDisconnected {
                worker: worker.name(),
            })
        }
    }
}

fn cleanup_failed_startup(
    runtime: &Arc<Runtime>,
    workers: WorkerHandles,
    primary: ClientSpawnError,
    timeout: Duration,
) -> StartupCleanupOutcome {
    runtime.stop(Arc::new(ConnectionError::Shutdown));
    match join_workers(workers, &runtime.cancellation, timeout) {
        JoinOutcome::Finished(Ok(())) => StartupCleanupOutcome::Recovered(primary),
        JoinOutcome::Finished(Err(cleanup)) => {
            StartupCleanupOutcome::Recovered(ClientSpawnError::Cleanup {
                primary: Box::new(primary),
                cleanup,
            })
        }
        JoinOutcome::TimedOut(workers, cleanup) => StartupCleanupOutcome::Stalled {
            workers,
            primary,
            cleanup,
        },
    }
}

fn startup_cleanup_error_or_abort(outcome: StartupCleanupOutcome) -> ClientSpawnError {
    match outcome {
        StartupCleanupOutcome::Recovered(error) => error,
        StartupCleanupOutcome::Stalled {
            workers,
            primary,
            cleanup,
        } => {
            eprintln!(
                "fatal: Codlet CDP startup failed ({primary}) and worker cleanup did not complete ({cleanup}); aborting Codlet so no detached worker thread survives; no Codex termination API is called, and inherited CDP pipe disconnect only requests cooperative Electron shutdown"
            );
            let _owned_until_abort = workers;
            std::process::abort();
        }
    }
}

fn writer_loop<W: Write>(
    mut writer: W,
    receiver: mpsc::Receiver<WriterCommand>,
    runtime: &Arc<Runtime>,
) {
    let _activity = WorkerActivity::new(WorkerKind::Writer, runtime);
    while let Ok(command) = receiver.recv() {
        match command {
            WriterCommand::Shutdown => return,
            WriterCommand::Frame {
                bytes,
                expires_at,
                timeout_error,
                completion,
                mut raw_permit,
            } => {
                if runtime
                    .shared
                    .state
                    .lock()
                    .expect("CDP state poisoned")
                    .terminal
                    .is_some()
                {
                    return;
                }
                if Instant::now() >= expires_at {
                    let _ = completion.send(Err(Arc::clone(&timeout_error)));
                    if raw_permit.is_some() {
                        continue;
                    }
                    runtime.stop(timeout_error);
                    return;
                }
                if let Some(permit) = &mut raw_permit
                    && !permit.begin(Arc::clone(&timeout_error))
                {
                    let _ = completion.send(Err(timeout_error));
                    continue;
                }
                if let Err(error) = writer.write_all(&bytes).and_then(|()| writer.flush()) {
                    let error = Arc::new(ConnectionError::Framing(FramingError::Write {
                        message: error.to_string(),
                    }));
                    let _ = completion.send(Err(Arc::clone(&error)));
                    runtime.stop(error);
                    return;
                }
                let _ = completion.send(Ok(()));
            }
        }
    }
}

fn reader_loop<R: Read>(mut reader: R, runtime: &Arc<Runtime>) {
    let _activity = WorkerActivity::new(WorkerKind::Reader, runtime);
    let mut decoder = NulJsonDecoder::new();
    let mut chunk = [0_u8; 8192];

    loop {
        match reader.read(&mut chunk) {
            Ok(0) => {
                let error = match decoder.finish() {
                    Ok(()) => ConnectionError::Eof,
                    Err(error) => ConnectionError::Framing(error),
                };
                runtime.stop(Arc::new(error));
                return;
            }
            Ok(read) => match decoder.push(&chunk[..read]) {
                Ok(messages) => {
                    for message in messages {
                        if let Err(error) = route_message(&runtime.shared, message) {
                            runtime.stop(Arc::new(error));
                            return;
                        }
                    }
                }
                Err(error) => {
                    runtime.stop(Arc::new(ConnectionError::Framing(error)));
                    return;
                }
            },
            Err(error) => {
                runtime.stop(Arc::new(ConnectionError::Read {
                    message: error.to_string(),
                }));
                return;
            }
        }
    }
}

fn route_message(shared: &Arc<Shared>, message: Value) -> Result<(), ConnectionError> {
    let object = message
        .as_object()
        .ok_or_else(|| ConnectionError::Protocol("top-level value is not an object".to_owned()))?;

    if let Some(id_value) = object.get("id") {
        return route_response(shared, object, id_value);
    }

    let method = required_string(object, "method")?;
    let event = CdpEvent {
        method: method.to_owned(),
        params: object.get("params").cloned(),
        session_id: optional_string(object, "sessionId")?,
    };
    let mut state = shared.state.lock().expect("CDP state poisoned");
    let ended: Vec<_> = state
        .sessions
        .iter()
        .filter_map(|(session_id, (target_id, live))| {
            let matches = event.session_id.is_none()
                && match event.method.as_str() {
                    "Target.targetDestroyed" => {
                        event
                            .params
                            .as_ref()
                            .and_then(|p| p.get("targetId"))
                            .and_then(Value::as_str)
                            == Some(target_id)
                    }
                    "Target.detachedFromTarget" => {
                        event
                            .params
                            .as_ref()
                            .and_then(|p| p.get("sessionId"))
                            .and_then(Value::as_str)
                            == Some(session_id)
                    }
                    _ => false,
                };
            if matches {
                if let Some(live) = live.upgrade() {
                    live.store(false, Ordering::Release);
                }
                Some(session_id.clone())
            } else {
                None
            }
        })
        .collect();
    for session in &ended {
        state.default_contexts.forget(session);
    }
    if event.session_id.as_ref().is_some_and(|id| {
        state
            .sessions
            .get(id)
            .and_then(|(_, live)| live.upgrade())
            .is_some_and(|live| live.load(Ordering::Acquire))
    }) {
        state.default_contexts.observe(&event);
    }
    state.events.retain(|sink| {
        (sink.session_id != event.session_id
            && !sink
                .session_id
                .as_ref()
                .is_some_and(|id| ended.contains(id)))
            || sink.sender.send(Ok(event.clone())).is_ok()
    });
    state
        .bounded_events
        .retain(|sink| sink.publish(&event, &ended));
    state.activity_epoch = state
        .activity_epoch
        .checked_add(1)
        .expect("CDP activity epoch overflowed");
    drop(state);
    shared.activity.notify_all();
    Ok(())
}

fn route_response(
    shared: &Arc<Shared>,
    object: &Map<String, Value>,
    id_value: &Value,
) -> Result<(), ConnectionError> {
    let id = id_value
        .as_u64()
        .ok_or_else(|| ConnectionError::Protocol("response id is not a u64".to_owned()))?;
    let mut state = shared.state.lock().expect("CDP state poisoned");
    let Some(pending) = state.pending.get(&id) else {
        // Retired and duplicate responses may arrive arbitrarily late. The contiguous issued-ID
        // watermark is O(1), while zero and IDs above it are known never-issued and fail closed.
        if id != 0 && id <= state.last_issued_id {
            return Ok(());
        }
        return Err(ConnectionError::UnexpectedResponseId(id));
    };

    let result = object.get("result").cloned();
    let error = object.get("error").map(parse_remote_error).transpose()?;
    if result.is_some() == error.is_some() {
        return Err(ConnectionError::Protocol(format!(
            "response {id} must contain exactly one of result or error"
        )));
    }
    let session_id = optional_string(object, "sessionId")?;
    let response = CdpResponse {
        id,
        result,
        error,
        session_id: session_id.clone(),
    };
    ensure_response_session(id, &pending.expected_session, &session_id)?;
    let pending = state
        .pending
        .remove(&id)
        .expect("pending CDP request disappeared while routing its response");
    let _ = pending.sender.send(Ok(response));
    state.activity_epoch = state
        .activity_epoch
        .checked_add(1)
        .expect("CDP activity epoch overflowed");
    drop(state);
    shared.activity.notify_all();
    Ok(())
}

fn ensure_response_session(
    id: u64,
    expected: &Option<String>,
    actual: &Option<String>,
) -> Result<(), ConnectionError> {
    if expected == actual {
        Ok(())
    } else {
        Err(ConnectionError::ResponseSessionMismatch {
            id,
            expected: expected.clone(),
            actual: actual.clone(),
        })
    }
}

fn parse_remote_error(value: &Value) -> Result<RemoteError, ConnectionError> {
    let object = value
        .as_object()
        .ok_or_else(|| ConnectionError::Protocol("response error is not an object".to_owned()))?;
    let code = object
        .get("code")
        .and_then(Value::as_i64)
        .ok_or_else(|| ConnectionError::Protocol("response error code is not an i64".to_owned()))?;
    let message = required_string(object, "message")?.to_owned();
    Ok(RemoteError {
        code,
        message,
        data: object.get("data").cloned(),
    })
}

fn required_string<'a>(
    object: &'a Map<String, Value>,
    key: &str,
) -> Result<&'a str, ConnectionError> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ConnectionError::Protocol(format!("{key} is not a string")))
}

fn optional_string(
    object: &Map<String, Value>,
    key: &str,
) -> Result<Option<String>, ConnectionError> {
    object
        .get(key)
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| ConnectionError::Protocol(format!("{key} is not a string")))
        })
        .transpose()
}

fn terminate(shared: &Arc<Shared>, error: Arc<ConnectionError>) {
    let (pending, events, bounded_events) = {
        let mut state = shared.state.lock().expect("CDP state poisoned");
        if state.terminal.is_some() {
            return;
        }
        state.terminal = Some(Arc::clone(&error));
        state.activity_epoch = state
            .activity_epoch
            .checked_add(1)
            .expect("CDP activity epoch overflowed");
        (
            std::mem::take(&mut state.pending),
            std::mem::take(&mut state.events),
            std::mem::take(&mut state.bounded_events),
        )
    };

    for pending in pending.into_values() {
        let _ = pending.sender.send(Err(Arc::clone(&error)));
    }
    for sink in events {
        let _ = sink.sender.send(Err(Arc::clone(&error)));
    }
    for sink in bounded_events {
        sink.close(Arc::clone(&error));
    }
    shared.closed.notify_all();
    shared.activity.notify_all();
}

fn remaining(deadline: Instant) -> Duration {
    deadline.saturating_duration_since(Instant::now())
}

enum JoinOutcome {
    Finished(Result<(), ShutdownError>),
    TimedOut(WorkerHandles, ShutdownError),
}

enum StartupCleanupOutcome {
    Recovered(ClientSpawnError),
    Stalled {
        workers: WorkerHandles,
        primary: ClientSpawnError,
        cleanup: ShutdownError,
    },
}

fn join_workers(
    mut workers: WorkerHandles,
    cancellation: &WorkerCancellation,
    timeout: Duration,
) -> JoinOutcome {
    let deadline = Instant::now() + timeout;
    let mut cancellation_failure = None;

    loop {
        reap_finished_workers(&mut workers);
        if workers.reader.is_none() && workers.writer.is_none() {
            let result = workers.completed_error.map_or_else(
                || {
                    cancellation_failure.map_or(Ok(()), |failure: CancelIoFailure| {
                        Err(ShutdownError::CancelIo {
                            worker: failure.worker,
                            code: failure.code,
                        })
                    })
                },
                Err,
            );
            return JoinOutcome::Finished(result);
        }

        for (kind, active) in [
            (WorkerKind::Reader, workers.reader.is_some()),
            (WorkerKind::Writer, workers.writer.is_some()),
        ] {
            if active
                && let Err(code) = cancellation.cancel(kind)
                && cancellation_failure.is_none()
            {
                cancellation_failure = Some(CancelIoFailure {
                    worker: kind.name(),
                    code,
                });
            }
        }

        reap_finished_workers(&mut workers);
        if workers.reader.is_none() && workers.writer.is_none() {
            continue;
        }
        if Instant::now() >= deadline {
            let error = ShutdownError::WorkersDidNotStop {
                timeout_ms: duration_millis(timeout),
                reader_active: workers.reader.is_some(),
                writer_active: workers.writer.is_some(),
                cancellation_failure,
            };
            return JoinOutcome::TimedOut(workers, error);
        }
        thread::sleep(remaining(deadline).min(Duration::from_millis(1)));
    }
}

fn reap_finished_workers(workers: &mut WorkerHandles) {
    for (worker, handle) in [
        (WorkerKind::Reader, &mut workers.reader),
        (WorkerKind::Writer, &mut workers.writer),
    ] {
        if handle.as_ref().is_some_and(JoinHandle::is_finished)
            && handle.take().unwrap().join().is_err()
            && workers.completed_error.is_none()
        {
            workers.completed_error = Some(ShutdownError::WorkerPanicked {
                worker: worker.name(),
            });
        }
    }
}

fn duration_millis(duration: Duration) -> u64 {
    duration.as_millis().min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
#[derive(Default)]
struct TestWorkers {
    readers: AtomicUsize,
    writers: AtomicUsize,
}

#[cfg(test)]
thread_local! {
    // Each harness test counts only its own clients. VM integration tests run
    // concurrently and must not look like leaked workers from this test.
    static TEST_WORKERS: Arc<TestWorkers> = Arc::default();
}

#[cfg(test)]
struct WorkerActivity<'a>(&'a AtomicUsize);

#[cfg(test)]
impl<'a> WorkerActivity<'a> {
    fn new(kind: WorkerKind, runtime: &'a Runtime) -> Self {
        let counter = match kind {
            WorkerKind::Reader => &runtime.worker_activity.readers,
            WorkerKind::Writer => &runtime.worker_activity.writers,
        };
        counter.fetch_add(1, Ordering::SeqCst);
        Self(counter)
    }
}

#[cfg(test)]
impl Drop for WorkerActivity<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[cfg(not(test))]
struct WorkerActivity;

#[cfg(not(test))]
impl WorkerActivity {
    fn new(_kind: WorkerKind, _runtime: &Runtime) -> Self {
        Self
    }
}

#[cfg(windows)]
mod platform {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

    use windows_sys::Win32::Foundation::{ERROR_NOT_FOUND, GetLastError};
    use windows_sys::Win32::System::IO::CancelSynchronousIo;
    use windows_sys::Win32::System::Threading::{GetCurrentThreadId, OpenThread, THREAD_TERMINATE};

    pub(super) struct ThreadCancelHandle {
        handle: OwnedHandle,
    }

    impl ThreadCancelHandle {
        pub(super) fn current() -> Result<Self, u32> {
            // SAFETY: GetCurrentThreadId has no preconditions. OpenThread receives that live ID.
            let handle = unsafe { OpenThread(THREAD_TERMINATE, 0, GetCurrentThreadId()) };
            if handle.is_null() {
                // SAFETY: called immediately after OpenThread failed.
                return Err(unsafe { GetLastError() });
            }
            // SAFETY: OpenThread returned a new owned handle.
            Ok(Self {
                handle: unsafe { OwnedHandle::from_raw_handle(handle.cast()) },
            })
        }

        pub(super) fn cancel(&self) -> Result<(), u32> {
            // SAFETY: the handle names the live worker thread that issued the synchronous I/O.
            if unsafe { CancelSynchronousIo(self.handle.as_raw_handle().cast()) } != 0 {
                return Ok(());
            }
            // SAFETY: called immediately after CancelSynchronousIo failed.
            let code = unsafe { GetLastError() };
            if code == ERROR_NOT_FOUND {
                Ok(())
            } else {
                Err(code)
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::net::Shutdown;
    use std::os::unix::net::UnixStream;
    pub(super) struct ThreadCancelHandle(UnixStream);
    impl ThreadCancelHandle {
        pub(super) fn current() -> Result<Self, u32> {
            // No thread-cancellation equivalent is used on macOS. Production
            // transports must supply an owned socket before workers are started.
            Err(libc::ENOTSUP as u32)
        }
        pub(super) fn socket(stream: UnixStream) -> Self {
            Self(stream)
        }
        pub(super) fn cancel(&self) -> Result<(), u32> {
            self.0
                .shutdown(Shutdown::Both)
                .or_else(|e| {
                    if e.raw_os_error() == Some(libc::ENOTCONN) {
                        Ok(())
                    } else {
                        Err(e)
                    }
                })
                .map_err(|e| e.raw_os_error().unwrap_or(0) as u32)
        }
    }
}

#[cfg(all(not(windows), not(target_os = "macos")))]
mod platform {
    pub(super) struct ThreadCancelHandle;

    impl ThreadCancelHandle {
        pub(super) fn current() -> Result<Self, u32> {
            Err(95)
        }

        pub(super) fn cancel(&self) -> Result<(), u32> {
            Err(95)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn shared_with_pending(
        id: u64,
        expected_session: Option<&str>,
    ) -> (
        Arc<Shared>,
        mpsc::Receiver<Result<CdpResponse, Arc<ConnectionError>>>,
    ) {
        let (response_sender, response_receiver) = mpsc::channel();
        let mut pending = HashMap::new();
        pending.insert(
            id,
            PendingRequest {
                expected_session: expected_session.map(str::to_owned),
                sender: response_sender,
            },
        );
        (
            Arc::new(Shared {
                state: Mutex::new(State {
                    terminal: None,
                    pending,
                    last_issued_id: id,
                    events: Vec::new(),
                    bounded_events: Vec::new(),
                    next_event_registration_id: 1,
                    activity_epoch: 0,
                    sessions: HashMap::new(),
                    default_contexts: contexts::DefaultContexts::default(),
                }),
                closed: Condvar::new(),
                activity: Condvar::new(),
            }),
            response_receiver,
        )
    }

    #[test]
    fn routes_response_by_id_and_expected_session() {
        let (shared, receiver) = shared_with_pending(9, Some("session-a"));
        route_message(
            &shared,
            json!({"id": 9, "result": {"ok": true}, "sessionId": "session-a"}),
        )
        .unwrap();
        assert_eq!(
            receiver.recv().unwrap().unwrap().result,
            Some(json!({"ok": true}))
        );
    }

    #[test]
    fn rejects_response_with_mismatched_session_id() {
        let (shared, _) = shared_with_pending(9, Some("session-a"));
        assert_eq!(
            route_message(
                &shared,
                json!({"id": 9, "result": {}, "sessionId": "session-b"})
            ),
            Err(ConnectionError::ResponseSessionMismatch {
                id: 9,
                expected: Some("session-a".to_owned()),
                actual: Some("session-b".to_owned()),
            })
        );
    }

    #[test]
    fn rejects_zero_and_future_response_ids() {
        let (shared, _) = shared_with_pending(9, None);
        assert_eq!(
            route_message(&shared, json!({"id": 10, "result": {}})),
            Err(ConnectionError::UnexpectedResponseId(10))
        );
        assert_eq!(
            route_message(&shared, json!({"id": 0, "result": {}})),
            Err(ConnectionError::UnexpectedResponseId(0))
        );
    }

    #[test]
    fn retired_and_duplicate_responses_are_ignored_without_retention_state() {
        let (shared, _) = shared_with_pending(1_024, None);
        {
            let mut state = shared.state.lock().unwrap();
            state.pending.clear();
        }

        route_message(&shared, json!({"id": 1, "sessionId": "session-other"})).unwrap();
        route_message(&shared, json!({"id": 1, "result": {}})).unwrap();
        route_message(&shared, json!({"id": 1_024, "result": {}})).unwrap();
        assert_eq!(shared.state.lock().unwrap().last_issued_id, 1_024);
    }

    #[test]
    fn routes_events_only_to_the_matching_session() {
        let (root_sender, root_receiver) = mpsc::channel();
        let (a_sender, a_receiver) = mpsc::channel();
        let (b_sender, b_receiver) = mpsc::channel();
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                terminal: None,
                pending: HashMap::new(),
                last_issued_id: 0,
                events: vec![
                    EventSink {
                        registration_id: 1,
                        session_id: None,
                        sender: root_sender,
                    },
                    EventSink {
                        registration_id: 2,
                        session_id: Some("session-a".to_owned()),
                        sender: a_sender,
                    },
                    EventSink {
                        registration_id: 3,
                        session_id: Some("session-b".to_owned()),
                        sender: b_sender,
                    },
                ],
                bounded_events: Vec::new(),
                next_event_registration_id: 4,
                activity_epoch: 0,
                sessions: HashMap::new(),
                default_contexts: contexts::DefaultContexts::default(),
            }),
            closed: Condvar::new(),
            activity: Condvar::new(),
        });

        route_message(
            &shared,
            json!({"method": "Page.ready", "sessionId": "session-a"}),
        )
        .unwrap();

        assert_eq!(a_receiver.recv().unwrap().unwrap().method, "Page.ready");
        assert!(matches!(
            root_receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        assert!(matches!(
            b_receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
    }

    #[test]
    fn terminal_transition_drains_every_pending_request_and_event_stream() {
        let (event_sender, event_receiver) = mpsc::channel();
        let mut pending = HashMap::new();
        let mut receivers = Vec::new();
        for id in 1..=3 {
            let (sender, receiver) = mpsc::channel();
            pending.insert(
                id,
                PendingRequest {
                    expected_session: None,
                    sender,
                },
            );
            receivers.push(receiver);
        }
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                terminal: None,
                pending,
                last_issued_id: 3,
                events: vec![EventSink {
                    registration_id: 1,
                    session_id: None,
                    sender: event_sender,
                }],
                bounded_events: Vec::new(),
                next_event_registration_id: 2,
                activity_epoch: 0,
                sessions: HashMap::new(),
                default_contexts: contexts::DefaultContexts::default(),
            }),
            closed: Condvar::new(),
            activity: Condvar::new(),
        });

        terminate(&shared, Arc::new(ConnectionError::Eof));

        for receiver in receivers {
            assert_eq!(*receiver.recv().unwrap().unwrap_err(), ConnectionError::Eof);
        }
        assert_eq!(
            *event_receiver.recv().unwrap().unwrap_err(),
            ConnectionError::Eof
        );
        assert!(shared.state.lock().unwrap().pending.is_empty());
    }

    #[cfg(windows)]
    pub(super) static SPAWN_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[cfg(windows)]
    #[test]
    fn repeated_spawn_and_shutdown_joins_every_reader_and_writer() {
        let _serial = SPAWN_TEST_LOCK.lock().unwrap();
        for _ in 0..32 {
            let (reader, _open_remote_writer) = blocking_pipe_reader();
            let (client, _events) =
                CdpClient::spawn_io(reader, std::io::sink(), SpawnConfig::default()).unwrap();
            client.shutdown().unwrap();
        }
        assert_eq!(
            TEST_WORKERS.with(|counts| counts.readers.load(Ordering::SeqCst)),
            0
        );
        assert_eq!(
            TEST_WORKERS.with(|counts| counts.writers.load(Ordering::SeqCst)),
            0
        );
    }

    #[cfg(windows)]
    #[test]
    fn expired_nested_budget_retires_locally_without_issuing_or_closing_transport() {
        let _serial = SPAWN_TEST_LOCK.lock().unwrap();
        let (reader, _remote_writer) = blocking_pipe_reader();
        let (client, _events) =
            CdpClient::spawn_io(reader, std::io::sink(), SpawnConfig::default()).unwrap();
        let error = client
            .start_request_until("Runtime.evaluate", None, Some("session-a"), Instant::now())
            .err()
            .unwrap();
        assert!(matches!(error, ClientError::RequestTimedOut { .. }));
        assert!(client.closed_reason().is_none());
        let state = client.inner.runtime.shared.state.lock().unwrap();
        assert_eq!(state.last_issued_id, 0);
        assert!(state.pending.is_empty());
        drop(state);
        client.shutdown().unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn destruction_and_exact_detach_invalidate_session_clones_before_dispatch() {
        let _serial = SPAWN_TEST_LOCK.lock().unwrap();
        let (reader, _remote_writer) = blocking_pipe_reader();
        let (client, _events) =
            CdpClient::spawn_io(reader, std::io::sink(), SpawnConfig::default()).unwrap();
        let old = client.track_session("target", "old");
        let events = client.subscribe_events(Some("old"));
        route_message(
            &client.inner.runtime.shared,
            json!({"method":"Target.targetDestroyed","params":{"targetId":"target"}}),
        )
        .unwrap();
        assert!(!old.load(Ordering::Acquire));
        assert_eq!(
            events.recv_timeout(Duration::ZERO).unwrap().method,
            "Target.targetDestroyed"
        );
        let replacement = client.track_session("target", "new");
        route_message(
            &client.inner.runtime.shared,
            json!({"method":"Target.detachedFromTarget","params":{"sessionId":"old"}}),
        )
        .unwrap();
        assert!(replacement.load(Ordering::Acquire));
        assert!(!old.load(Ordering::Acquire));
        assert!(matches!(
            client.start_request(
                "Runtime.evaluate",
                None,
                Some("old"),
                Duration::from_secs(1)
            ),
            Err(ClientError::SessionEnded(_))
        ));
        assert!(client.closed_reason().is_none());
        client.shutdown().unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn request_deadline_covers_a_blocked_pipe_write() {
        let _serial = SPAWN_TEST_LOCK.lock().unwrap();
        let (reader, _open_remote_writer) = blocking_pipe_reader();
        let (writer, _open_remote_reader) = blocking_pipe_writer();
        let (client, _events) =
            CdpClient::spawn_io(reader, writer, SpawnConfig::default()).unwrap();
        let started = Instant::now();
        let error = client
            .request(
                "Fake.blockedWrite",
                Some(json!({"payload": "x".repeat(4 * 1024 * 1024)})),
                None,
                Duration::from_millis(500),
            )
            .unwrap_err();
        assert!(matches!(error, ClientError::RequestTimedOut { .. }));
        assert!(started.elapsed() < Duration::from_secs(3));
        client.shutdown().unwrap();
        assert_eq!(
            TEST_WORKERS.with(|counts| counts.readers.load(Ordering::SeqCst)),
            0
        );
        assert_eq!(
            TEST_WORKERS.with(|counts| counts.writers.load(Ordering::SeqCst)),
            0
        );
    }

    #[cfg(windows)]
    #[test]
    fn many_never_responding_requests_leave_only_a_scalar_retired_watermark() {
        let _serial = SPAWN_TEST_LOCK.lock().unwrap();
        let (reader, _remote_writer) = blocking_pipe_reader();
        let (client, _events) =
            CdpClient::spawn_io(reader, std::io::sink(), SpawnConfig::default()).unwrap();

        for id in 1..=4_096 {
            let (sender, receiver) = mpsc::channel();
            {
                let mut state = client.inner.runtime.shared.state.lock().unwrap();
                state.pending.insert(
                    id,
                    PendingRequest {
                        expected_session: Some("session-a".to_owned()),
                        sender,
                    },
                );
                state.last_issued_id = id;
            }
            assert!(client.expire_request(id, &receiver).unwrap().is_none());
        }

        let state = client.inner.runtime.shared.state.lock().unwrap();
        assert!(state.pending.is_empty());
        assert_eq!(state.last_issued_id, 4_096);
        drop(state);
        route_message(
            &client.inner.runtime.shared,
            json!({"id": 1, "result": {}, "sessionId": "session-other"}),
        )
        .unwrap();
        client.shutdown().unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn shutdown_returns_on_cancellation_failure_and_can_be_retried_after_unblock() {
        let _serial = SPAWN_TEST_LOCK.lock().unwrap();
        let (reader, remote_writer) = blocking_pipe_reader();
        let config = SpawnConfig {
            shutdown_timeout: Duration::from_millis(50),
            fail_thread_spawn: None,
        };
        let (client, _events) = CdpClient::spawn_io(reader, std::io::sink(), config).unwrap();
        client
            .inner
            .runtime
            .cancellation
            .force_failure(Some((WorkerKind::Reader, 5)));

        let started = Instant::now();
        let error = client.shutdown().unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(matches!(
            error,
            ShutdownError::WorkersDidNotStop {
                reader_active: true,
                cancellation_failure: Some(CancelIoFailure {
                    worker: "reader",
                    code: 5,
                }),
                ..
            }
        ));

        client.inner.runtime.cancellation.force_failure(None);
        drop(remote_writer);
        client.shutdown().unwrap();
        assert_eq!(
            TEST_WORKERS.with(|counts| counts.readers.load(Ordering::SeqCst)),
            0
        );
        assert_eq!(
            TEST_WORKERS.with(|counts| counts.writers.load(Ordering::SeqCst)),
            0
        );
    }

    #[cfg(windows)]
    #[test]
    fn reader_thread_spawn_failure_cleans_up_started_writer() {
        let _serial = SPAWN_TEST_LOCK.lock().unwrap();
        let (reader, _remote_writer) = blocking_pipe_reader();
        let result = CdpClient::spawn_io(
            reader,
            std::io::sink(),
            SpawnConfig {
                shutdown_timeout: Duration::from_millis(250),
                fail_thread_spawn: Some(WorkerKind::Reader),
            },
        );

        assert!(matches!(
            result,
            Err(ClientSpawnError::ThreadSpawn {
                worker: "reader",
                ..
            })
        ));
        assert_eq!(
            TEST_WORKERS.with(|counts| counts.readers.load(Ordering::SeqCst)),
            0
        );
        assert_eq!(
            TEST_WORKERS.with(|counts| counts.writers.load(Ordering::SeqCst)),
            0
        );
    }

    #[test]
    fn stalled_startup_cleanup_retains_worker_ownership_at_fail_fast_boundary() {
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                terminal: None,
                pending: HashMap::new(),
                last_issued_id: 0,
                events: Vec::new(),
                bounded_events: Vec::new(),
                next_event_registration_id: 1,
                activity_epoch: 0,
                sessions: HashMap::new(),
                default_contexts: contexts::DefaultContexts::default(),
            }),
            closed: Condvar::new(),
            activity: Condvar::new(),
        });
        let (writer_sender, _writer_receiver) = mpsc::channel();
        let cancellation = Arc::new(WorkerCancellation::default());
        let runtime = Arc::new(Runtime {
            shared,
            writer_sender,
            cancellation: Arc::clone(&cancellation),
            worker_activity: TEST_WORKERS.with(Arc::clone),
        });
        let (release_sender, release_receiver) = mpsc::channel();
        let writer = thread::spawn(move || {
            release_receiver.recv().unwrap();
        });
        let primary = ClientSpawnError::ThreadSpawn {
            worker: "reader",
            source: io::Error::other("injected reader startup failure"),
        };

        let outcome = cleanup_failed_startup(
            &runtime,
            WorkerHandles {
                reader: None,
                writer: Some(writer),
                completed_error: None,
            },
            primary,
            Duration::from_millis(10),
        );
        let workers = match outcome {
            StartupCleanupOutcome::Stalled {
                workers,
                cleanup:
                    ShutdownError::WorkersDidNotStop {
                        reader_active: false,
                        writer_active: true,
                        ..
                    },
                ..
            } => workers,
            StartupCleanupOutcome::Stalled { cleanup, .. } => {
                panic!("unexpected startup cleanup error: {cleanup}")
            }
            StartupCleanupOutcome::Recovered(error) => {
                panic!("stalled worker was reported as recovered: {error}")
            }
        };
        assert!(
            workers
                .writer
                .as_ref()
                .is_some_and(|worker| !worker.is_finished())
        );

        release_sender.send(()).unwrap();
        assert!(matches!(
            join_workers(workers, &cancellation, Duration::from_secs(1)),
            JoinOutcome::Finished(Ok(()))
        ));
    }

    #[test]
    fn stalled_startup_cleanup_fail_fast_boundary_does_not_return() {
        const CHILD_ENV: &str = "CODLET_TEST_STARTUP_CLEANUP_ABORT";
        const FAIL_FAST_STDERR: &str = "aborting Codlet so no detached worker thread survives; no Codex termination API is called, and inherited CDP pipe disconnect only requests cooperative Electron shutdown";
        const RETURNED_SENTINEL: &str = "CODLET_TEST_STARTUP_CLEANUP_RETURNED";
        const RETURNED_EXIT_CODE: i32 = 86;
        if std::env::var_os(CHILD_ENV).is_some() {
            let (_hold_sender, hold_receiver) = mpsc::channel::<()>();
            let writer = thread::spawn(move || {
                let _ = hold_receiver.recv();
            });
            let outcome = StartupCleanupOutcome::Stalled {
                workers: WorkerHandles {
                    reader: None,
                    writer: Some(writer),
                    completed_error: None,
                },
                primary: ClientSpawnError::ThreadSpawn {
                    worker: "reader",
                    source: io::Error::other("injected reader startup failure"),
                },
                cleanup: ShutdownError::WorkersDidNotStop {
                    timeout_ms: 10,
                    reader_active: false,
                    writer_active: true,
                    cancellation_failure: None,
                },
            };

            let _ = startup_cleanup_error_or_abort(outcome);
            eprintln!("{RETURNED_SENTINEL}");
            std::process::exit(RETURNED_EXIT_CODE);
        }

        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "cdp::client::tests::stalled_startup_cleanup_fail_fast_boundary_does_not_return",
                "--nocapture",
            ])
            .env(CHILD_ENV, "1")
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains(FAIL_FAST_STDERR),
            "child did not reach the startup-cleanup fail-fast branch; stderr: {stderr}"
        );
        assert!(
            !stderr.contains(RETURNED_SENTINEL),
            "startup-cleanup fail-fast branch returned normally; stderr: {stderr}"
        );
        assert!(
            !stderr.contains("panicked at"),
            "child panicked instead of aborting in the fail-fast branch; stderr: {stderr}"
        );
        assert_ne!(output.status.code(), Some(RETURNED_EXIT_CODE));
        assert!(!output.status.success());
    }

    #[cfg(windows)]
    #[test]
    fn dropping_event_subscriptions_unregisters_without_receiving_an_event() {
        let _serial = SPAWN_TEST_LOCK.lock().unwrap();
        let (reader, _remote_writer) = blocking_pipe_reader();
        let (client, root_events) =
            CdpClient::spawn_io(reader, std::io::sink(), SpawnConfig::default()).unwrap();

        for _ in 0..1_000 {
            drop(client.subscribe_events(Some("session-a")));
        }
        assert_eq!(
            client
                .inner
                .runtime
                .shared
                .state
                .lock()
                .unwrap()
                .events
                .len(),
            1
        );
        drop(root_events);
        assert!(
            client
                .inner
                .runtime
                .shared
                .state
                .lock()
                .unwrap()
                .events
                .is_empty()
        );

        client.shutdown().unwrap();
        assert_eq!(
            TEST_WORKERS.with(|counts| counts.readers.load(Ordering::SeqCst)),
            0
        );
        assert_eq!(
            TEST_WORKERS.with(|counts| counts.writers.load(Ordering::SeqCst)),
            0
        );
    }

    #[cfg(windows)]
    #[test]
    fn oversized_outbound_request_is_rejected_without_closing_connection() {
        let _serial = SPAWN_TEST_LOCK.lock().unwrap();
        let (reader, _remote_writer) = blocking_pipe_reader();
        let (client, _events) =
            CdpClient::spawn_io(reader, std::io::sink(), SpawnConfig::default()).unwrap();

        let error = client
            .request(
                "Fake.oversized",
                Some(json!({"payload": "x".repeat(MAX_CDP_FRAME_BYTES)})),
                None,
                Duration::from_secs(1),
            )
            .unwrap_err();
        assert!(matches!(
            error,
            ClientError::RequestFrameTooLarge {
                max_bytes: MAX_CDP_FRAME_BYTES
            }
        ));
        assert!(client.closed_reason().is_none());

        client.shutdown().unwrap();
    }

    #[cfg(windows)]
    pub(super) fn blocking_pipe_reader() -> (std::fs::File, std::os::windows::io::OwnedHandle) {
        use std::os::windows::io::FromRawHandle;
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::System::Pipes::CreatePipe;

        let mut read: HANDLE = std::ptr::null_mut();
        let mut write: HANDLE = std::ptr::null_mut();
        // SAFETY: output pointers are valid and null security attributes are permitted.
        assert_ne!(
            unsafe { CreatePipe(&mut read, &mut write, std::ptr::null(), 0) },
            0
        );
        // SAFETY: CreatePipe returned two independently owned handles.
        unsafe {
            (
                std::fs::File::from_raw_handle(read.cast()),
                std::os::windows::io::OwnedHandle::from_raw_handle(write.cast()),
            )
        }
    }

    #[cfg(windows)]
    pub(super) fn blocking_pipe_writer() -> (std::fs::File, std::os::windows::io::OwnedHandle) {
        let (reader, writer) = blocking_pipe_reader();
        use std::os::windows::io::{FromRawHandle, IntoRawHandle};
        let reader = reader.into_raw_handle();
        let writer = writer.into_raw_handle();
        // SAFETY: ownership is transferred from the two values above into the swapped return types.
        unsafe {
            (
                std::fs::File::from_raw_handle(writer),
                std::os::windows::io::OwnedHandle::from_raw_handle(reader),
            )
        }
    }
}
