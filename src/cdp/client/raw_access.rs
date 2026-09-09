//! Bounded, nonblocking access for optional plugin runtimes. The established
//! renderer request and event APIs keep their existing behavior.

use super::*;

pub(super) const MAX_RAW_FRAME_BYTES: usize = 1024 * 1024;
const MAX_RAW_QUEUED_WRITES: usize = 16;
const MAX_RAW_EVENT_SUBSCRIPTIONS: usize = 32;
const MAX_RAW_EVENTS: usize = 4;
const RAW_WRITE_TIMEOUT: Duration = Duration::from_secs(15);

pub(super) type RawWriteDeadline = Arc<Mutex<Option<(Instant, Arc<ConnectionError>)>>>;

pub(super) struct RawWritePermit {
    count: Arc<AtomicUsize>,
    // 0 queued, 1 writing, 2 cancelled before writing.
    pub(super) state: Arc<AtomicUsize>,
    deadline: RawWriteDeadline,
    writing: bool,
}

impl RawWritePermit {
    pub(super) fn acquire(
        count: &Arc<AtomicUsize>,
        deadline: &RawWriteDeadline,
    ) -> Result<Self, ClientError> {
        count
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (current < MAX_RAW_QUEUED_WRITES).then_some(current + 1)
            })
            .map_err(|_| ClientError::RequestQueueFull)?;
        Ok(Self {
            count: Arc::clone(count),
            state: Arc::new(AtomicUsize::new(0)),
            deadline: Arc::clone(deadline),
            writing: false,
        })
    }

    pub(super) fn begin(&mut self, error: Arc<ConnectionError>) -> bool {
        if self
            .state
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return false;
        }
        self.writing = true;
        *self.deadline.lock().unwrap() = Some((Instant::now() + RAW_WRITE_TIMEOUT, error));
        true
    }
}

impl Drop for RawWritePermit {
    fn drop(&mut self) {
        if self.writing {
            self.deadline.lock().unwrap().take();
        }
        self.count.fetch_sub(1, Ordering::AcqRel);
    }
}

pub struct QueuedCdpRequest {
    request: Option<CdpRequest>,
    write_ack: Option<mpsc::Receiver<Result<(), Arc<ConnectionError>>>>,
    timeout_error: Arc<ConnectionError>,
    raw_state: Option<Arc<AtomicUsize>>,
}

impl QueuedCdpRequest {
    pub(super) fn new(
        request: CdpRequest,
        write_ack: mpsc::Receiver<Result<(), Arc<ConnectionError>>>,
        timeout_error: Arc<ConnectionError>,
        raw_state: Option<Arc<AtomicUsize>>,
    ) -> Self {
        Self {
            request: Some(request),
            write_ack: Some(write_ack),
            timeout_error,
            raw_state,
        }
    }

    /// Does not wait for either the shared CDP writer or a response. A request
    /// keeps its original deadline, including its time spent queued for writing.
    pub fn try_response(&mut self) -> Result<Option<CdpResponse>, ClientError> {
        let request = self
            .request
            .as_mut()
            .expect("request remains present while polling");
        request.client.poll_raw_io();
        if let Some(ack) = &self.write_ack {
            match ack.try_recv() {
                Ok(Ok(())) => self.write_ack = None,
                Ok(Err(error)) => return Err(request_error(error, request.id, &request.method)),
                Err(mpsc::TryRecvError::Empty) if Instant::now() < request.expires_at => {
                    return Ok(None);
                }
                Err(mpsc::TryRecvError::Empty) => {
                    if let Some(state) = &self.raw_state {
                        let _ = state.compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire);
                    } else {
                        request
                            .client
                            .inner
                            .runtime
                            .stop(Arc::clone(&self.timeout_error));
                    }
                    return Err(ClientError::RequestTimedOut {
                        id: request.id,
                        method: request.method.clone(),
                    });
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Err(ClientError::Connection(request.client.terminal_reason()));
                }
            }
        }
        request.try_response()
    }

    pub(super) fn wait_written(mut self) -> Result<CdpRequest, ClientError> {
        let request = self.request.as_ref().unwrap();
        match self
            .write_ack
            .take()
            .unwrap()
            .recv_timeout(remaining(request.expires_at))
        {
            Ok(Ok(())) => Ok(self.request.take().unwrap()),
            Ok(Err(error)) => Err(request_error(error, request.id, &request.method)),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                request
                    .client
                    .inner
                    .runtime
                    .stop(Arc::clone(&self.timeout_error));
                Err(ClientError::RequestTimedOut {
                    id: request.id,
                    method: request.method.clone(),
                })
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err(ClientError::Connection(request.client.terminal_reason()))
            }
        }
    }
}

impl Drop for QueuedCdpRequest {
    fn drop(&mut self) {
        if let Some(state) = &self.raw_state {
            let _ = state.compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CdpEventFilter {
    Root,
    Session(String),
    All,
}

pub(super) struct BoundedEventSink {
    id: u64,
    filter: CdpEventFilter,
    sender: mpsc::SyncSender<EventItem>,
    overflowed: Arc<AtomicBool>,
}

impl BoundedEventSink {
    pub(super) fn publish(&self, event: &CdpEvent, ended: &[String]) -> bool {
        let matches = match &self.filter {
            CdpEventFilter::Root => event.session_id.is_none(),
            CdpEventFilter::Session(id) => {
                event.session_id.as_ref() == Some(id) || ended.contains(id)
            }
            CdpEventFilter::All => true,
        };
        if !matches {
            return true;
        }
        // Bound before cloning into the subscriber's queue. An overflow retires
        // this subscription, without blocking or closing the shared CDP reader.
        if serde_json::to_vec(event).map_or(true, |bytes| bytes.len() > MAX_RAW_FRAME_BYTES) {
            self.overflowed.store(true, Ordering::Release);
            return false;
        }
        match self.sender.try_send(Ok(event.clone())) {
            Ok(()) => true,
            Err(mpsc::TrySendError::Full(_)) => {
                self.overflowed.store(true, Ordering::Release);
                false
            }
            Err(mpsc::TrySendError::Disconnected(_)) => false,
        }
    }

    pub(super) fn close(self, error: Arc<ConnectionError>) {
        if matches!(
            self.sender.try_send(Err(error)),
            Err(mpsc::TrySendError::Full(_))
        ) {
            self.overflowed.store(true, Ordering::Release);
        }
    }
}

pub struct BoundedCdpEvents {
    receiver: mpsc::Receiver<EventItem>,
    overflowed: Arc<AtomicBool>,
    registration_id: u64,
    shared: Weak<Shared>,
}

impl BoundedCdpEvents {
    pub fn try_event(&self) -> Result<Option<CdpEvent>, EventStreamError> {
        if self.overflowed.load(Ordering::Acquire) {
            return Err(EventStreamError::Overflow);
        }
        match self.receiver.try_recv() {
            Ok(Ok(event)) => Ok(Some(event)),
            Ok(Err(error)) => Err(EventStreamError::Connection(error)),
            Err(mpsc::TryRecvError::Empty) => Ok(None),
            Err(mpsc::TryRecvError::Disconnected) => Err(EventStreamError::Disconnected),
        }
    }
}

impl Drop for BoundedCdpEvents {
    fn drop(&mut self) {
        if let Some(shared) = self.shared.upgrade() {
            shared
                .state
                .lock()
                .expect("CDP state poisoned")
                .bounded_events
                .retain(|sink| sink.id != self.registration_id);
        }
    }
}

impl CdpClient {
    /// The optional raw owner calls this even after callers have cancelled their
    /// requests. A partially written frame has a transport budget independent of
    /// a plugin's short RPC timeout; only a stuck shared pipe closes the connection.
    pub fn poll_raw_io(&self) {
        let expired = self
            .inner
            .raw_write_deadline
            .lock()
            .unwrap()
            .as_ref()
            .filter(|(until, _)| Instant::now() >= *until)
            .map(|(_, error)| Arc::clone(error));
        if let Some(error) = expired {
            self.inner.runtime.stop(error);
        }
    }

    pub fn begin_raw_request(
        &self,
        method: &str,
        params: Option<Value>,
        session_id: Option<&str>,
        expires_at: Instant,
    ) -> Result<QueuedCdpRequest, ClientError> {
        self.enqueue_request_until(method, params, session_id, expires_at, true)
    }

    pub fn subscribe_bounded(
        &self,
        filter: CdpEventFilter,
    ) -> Result<BoundedCdpEvents, ClientError> {
        let (sender, receiver) = mpsc::sync_channel(MAX_RAW_EVENTS);
        let overflowed = Arc::new(AtomicBool::new(false));
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
        if state.bounded_events.len() >= MAX_RAW_EVENT_SUBSCRIPTIONS {
            return Err(ClientError::RequestQueueFull);
        }
        let id = state.next_event_registration_id;
        state.next_event_registration_id = id
            .checked_add(1)
            .expect("CDP event registration id overflowed");
        state.bounded_events.push(BoundedEventSink {
            id,
            filter,
            sender,
            overflowed: Arc::clone(&overflowed),
        });
        Ok(BoundedCdpEvents {
            receiver,
            overflowed,
            registration_id: id,
            shared: Arc::downgrade(&self.inner.runtime.shared),
        })
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn overflow_retires_only_one_raw_subscription_and_all_includes_session_events() {
        let _serial = super::super::tests::SPAWN_TEST_LOCK.lock().unwrap();
        let (reader, _feed) = super::super::tests::blocking_pipe_reader();
        let (client, _legacy) =
            CdpClient::spawn_io(reader, io::sink(), SpawnConfig::default()).unwrap();
        let all = client.subscribe_bounded(CdpEventFilter::All).unwrap();
        let root = client.subscribe_bounded(CdpEventFilter::Root).unwrap();
        for index in 0..=MAX_RAW_EVENTS {
            route_message(
                &client.inner.runtime.shared,
                json!({"method":"Runtime.fixture","sessionId":"any-page","params":{"index":index}}),
            )
            .unwrap();
        }
        assert!(matches!(all.try_event(), Err(EventStreamError::Overflow)));
        assert!(root.try_event().unwrap().is_none());
        assert!(client.closed_reason().is_none());
        route_message(
            &client.inner.runtime.shared,
            json!({"method":"Target.fixture","params":{}}),
        )
        .unwrap();
        assert_eq!(root.try_event().unwrap().unwrap().method, "Target.fixture");
        client.shutdown().unwrap();
    }

    #[test]
    fn raw_queue_does_not_block_owner_or_grow_when_callers_drop_requests() {
        let _serial = super::super::tests::SPAWN_TEST_LOCK.lock().unwrap();
        let (reader, _feed) = super::super::tests::blocking_pipe_reader();
        let (writer, _drain) = super::super::tests::blocking_pipe_writer();
        let (client, _events) =
            CdpClient::spawn_io(reader, writer, SpawnConfig::default()).unwrap();
        let started = Instant::now();
        let deadline = started + Duration::from_secs(5);
        let _blocked = client
            .begin_raw_request(
                "Fixture.blocked",
                Some(json!({"data":"x".repeat(64 * 1024)})),
                None,
                deadline,
            )
            .unwrap();
        for _ in 1..MAX_RAW_QUEUED_WRITES {
            let mut request = client
                .begin_raw_request(
                    "Fixture.blocked",
                    Some(json!({"data":"x".repeat(64 * 1024)})),
                    None,
                    deadline,
                )
                .unwrap();
            assert!(request.try_response().unwrap().is_none());
            // Cancelling the consumer must not release a frame still in the writer.
            drop(request);
        }
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(matches!(
            client.begin_raw_request("Fixture.full", None, None, deadline),
            Err(ClientError::RequestQueueFull)
        ));
        assert!(client.closed_reason().is_none());
        client.shutdown().unwrap();
    }

    #[test]
    fn a_queued_raw_timeout_is_local_and_does_not_close_another_inflight_write() {
        let _serial = super::super::tests::SPAWN_TEST_LOCK.lock().unwrap();
        let (reader, _feed) = super::super::tests::blocking_pipe_reader();
        let (writer, _drain) = super::super::tests::blocking_pipe_writer();
        let (client, _events) =
            CdpClient::spawn_io(reader, writer, SpawnConfig::default()).unwrap();
        let _blocked = client
            .begin_raw_request(
                "Fixture.blocked",
                Some(json!({"data":"x".repeat(64 * 1024)})),
                None,
                Instant::now() + Duration::from_secs(5),
            )
            .unwrap();
        let mut queued = client
            .begin_raw_request(
                "Fixture.expired",
                None,
                None,
                Instant::now() + Duration::from_millis(10),
            )
            .unwrap();
        thread::sleep(Duration::from_millis(20));
        assert!(matches!(
            queued.try_response(),
            Err(ClientError::RequestTimedOut { .. })
        ));
        assert_eq!(
            queued.raw_state.as_ref().unwrap().load(Ordering::Acquire),
            2
        );
        assert!(client.closed_reason().is_none());
        // The actual stuck-write deadline remains a transport failure even if
        // its original consumer has stopped polling.
        let wait_until = Instant::now() + Duration::from_secs(1);
        loop {
            let mut deadline = client.inner.raw_write_deadline.lock().unwrap();
            if let Some((until, _)) = deadline.as_mut() {
                *until = Instant::now();
                break;
            }
            drop(deadline);
            assert!(Instant::now() < wait_until);
            thread::sleep(Duration::from_millis(1));
        }
        client.poll_raw_io();
        assert!(matches!(
            client.closed_reason().as_deref(),
            Some(ConnectionError::RequestTimedOut { .. })
        ));
        client.shutdown().unwrap();
    }
}
