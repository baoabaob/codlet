//! Bounded duplex peer used by the launch source and the in-process gateway.
use super::*;
use futures_util::future::BoxFuture;
use std::collections::BTreeSet;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Semaphore, oneshot};
use tokio_util::sync::CancellationToken;

pub(super) type Handler =
    Arc<dyn Fn(String, Value) -> BoxFuture<'static, Result<Value>> + Send + Sync>;
pub(super) type Event = Arc<dyn Fn(Value) + Send + Sync>;
type Prepare = Box<dyn FnOnce(&Value) -> Result<()> + Send>;
struct Call {
    reply: oneshot::Sender<Result<Value>>,
    prepare: Option<Prepare>,
}
pub(super) struct Rpc {
    send: Arc<dyn Fn(Value) -> Result<()> + Send + Sync>,
    calls: Mutex<BTreeMap<String, Call>>,
    inbound: Mutex<BTreeSet<String>>,
    sequence: std::sync::atomic::AtomicU64,
    pub stopped: CancellationToken,
    limit: usize,
}
impl Rpc {
    pub fn new(
        send: impl Fn(Value) -> Result<()> + Send + Sync + 'static,
        stopped: CancellationToken,
        limit: usize,
    ) -> Arc<Self> {
        Arc::new(Self {
            send: Arc::new(send),
            calls: Mutex::new(BTreeMap::new()),
            inbound: Mutex::new(BTreeSet::new()),
            sequence: std::sync::atomic::AtomicU64::new(0),
            stopped,
            limit,
        })
    }
    pub fn send(&self, value: Value) -> Result<()> {
        if self.stopped.is_cancelled() {
            return Err(error("peer_closed", "peer retired"));
        }
        (self.send)(value)
    }
    pub async fn request(
        &self,
        method: &str,
        params: Value,
        stopped: &CancellationToken,
        timeout: Duration,
    ) -> Result<Value> {
        self.request_prepared(method, params, stopped, timeout, None)
            .await
    }
    pub async fn request_prepared(
        &self,
        method: &str,
        params: Value,
        stopped: &CancellationToken,
        timeout: Duration,
        prepare: Option<Prepare>,
    ) -> Result<Value> {
        if stopped.is_cancelled() || self.stopped.is_cancelled() {
            return Err(error(
                "request_cancelled",
                "request retired before dispatch",
            ));
        }
        let id = format!("n{}", self.sequence.fetch_add(1, Ordering::Relaxed));
        let (sender, receiver) = oneshot::channel();
        {
            let mut calls = self.calls.lock().unwrap_or_else(|p| p.into_inner());
            if calls.len() >= self.limit {
                return Err(error("resource_limit", "peer request limit reached"));
            }
            calls.insert(
                id.clone(),
                Call {
                    reply: sender,
                    prepare,
                },
            );
        }
        struct Guard<'a>(&'a Rpc, String, bool);
        impl Drop for Guard<'_> {
            fn drop(&mut self) {
                let pending = self
                    .0
                    .calls
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&self.1)
                    .is_some();
                if pending && self.2 && !self.0.stopped.is_cancelled() {
                    let id = format!("n{}", self.0.sequence.fetch_add(1, Ordering::Relaxed));
                    let _ = self
                        .0
                        .send(json!({"id":id,"method":"cancelOpen","params":{"request":self.1}}));
                }
            }
        }
        let _guard = Guard(self, id.clone(), method == "open");
        self.send(json!({"id":id,"method":method,"params":params}))?;
        tokio::select! {
            biased;
            // A terminal error is ordered before lease retirement. Preserve
            // it when both the reply and cancellation are already ready.
            result = receiver => result.unwrap_or_else(|_| Err(error("peer_closed", "peer retired"))),
            _ = stopped.cancelled() => Err(error("request_cancelled", "request cancelled")),
            _ = self.stopped.cancelled() => Err(error("peer_closed", "peer retired")),
            _ = tokio::time::sleep(timeout) => Err(error("traffic_timeout", "peer request expired")),
        }
    }
    pub fn close(&self) {
        self.stopped.cancel();
        self.calls.lock().unwrap_or_else(|p| p.into_inner()).clear();
    }
    pub fn receive(
        self: &Arc<Self>,
        value: Value,
        handler: &Handler,
        event: &Event,
        slots: &Arc<Semaphore>,
    ) -> Result<()> {
        if value.get("event").is_some() {
            event(value);
            return Ok(());
        }
        let id = value
            .get("id")
            .filter(|id| super::wire::valid_id(id))
            .cloned()
            .ok_or_else(|| error("invalid_frame", "missing request identity"))?;
        if let Some(method) = value["method"].as_str() {
            let permit = slots
                .clone()
                .try_acquire_owned()
                .map_err(|_| error("traffic_backpressure", "peer inbound limit reached"))?;
            let handler = handler.clone();
            let peer = self.clone();
            let method = method.to_owned();
            let inbound_id = id.to_string();
            if !self
                .inbound
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(inbound_id.clone())
            {
                return Err(error(
                    "invalid_frame",
                    "duplicate in-flight request identity",
                ));
            }
            tokio::spawn(async move {
                let _permit = permit;
                struct Inbound(Arc<Rpc>, String);
                impl Drop for Inbound {
                    fn drop(&mut self) {
                        self.0
                            .inbound
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .remove(&self.1);
                    }
                }
                let _inbound = Inbound(peer.clone(), inbound_id);
                let result = tokio::select! {
                    biased;
                    _ = peer.stopped.cancelled() => return,
                    result = handler(method, value.get("params").cloned().unwrap_or(Value::Null)) => result,
                };
                let frame = match result {
                    Ok(result) => json!({"id":id,"result":result}),
                    Err(e) => {
                        json!({"id":id,"error":{"code":e.data.as_ref().and_then(|v|v["wireCode"].as_str()).unwrap_or(e.code)}})
                    }
                };
                if peer.send(frame).is_err() {
                    peer.close();
                }
            });
        } else {
            let key = if let Some(id) = id.as_str() {
                id.to_owned()
            } else {
                id.to_string()
            };
            let call = self
                .calls
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&key);
            if let Some(mut call) = call {
                let result = if value.get("error").is_some() {
                    Err(remote_error(value["error"]["code"].as_str()))
                } else {
                    let result = value.get("result").cloned().unwrap_or(Value::Null);
                    match call.prepare.take().map(|f| f(&result)).transpose() {
                        Ok(_) => Ok(result),
                        Err(e) => Err(e),
                    }
                };
                let _ = call.reply.send(result);
            }
        }
        Ok(())
    }
}
pub(super) fn remote_error(code: Option<&str>) -> ServiceError {
    let original = code;
    let code = match code {
        Some("body_too_large") => "body_too_large",
        Some("body_already_consumed") => "body_already_consumed",
        Some("stream_retired") => "stream_retired",
        Some("request_cancelled") => "request_cancelled",
        Some("invalid_body") => "invalid_body",
        Some("invalid_frame") => "invalid_frame",
        Some("permission_denied") => "permission_denied",
        Some("stale_generation") => "stale_generation",
        Some("interceptor_retired") => "interceptor_retired",
        Some("invalid_decision") => "invalid_decision",
        Some("traffic_timeout") => "traffic_timeout",
        Some("peer_closed") => "peer_closed",
        Some("forward_already_dispatched") => "forward_already_dispatched",
        Some("websocket_rejected") => "websocket_rejected",
        Some("invalid_response") => "invalid_response",
        Some("upstream_failed") => "upstream_failed",
        Some("handler_timeout") => "handler_timeout",
        Some("policy_denied") => "policy_denied",
        Some("authorization_revoked") => "authorization_revoked",
        Some("stream_failed") => "stream_failed",
        _ => "traffic_callback_failed",
    };
    let mut result = error(code, "peer operation failed");
    if let Some(code) = original.filter(|s| {
        !s.is_empty() && s.len() <= 64 && s.bytes().all(|c| c.is_ascii_lowercase() || c == b'_')
    }) {
        result.data = Some(json!({"wireCode":code}));
    }
    result
}
pub(super) async fn read_frame(reader: &mut (impl tokio::io::AsyncRead + Unpin)) -> Result<Value> {
    let length = reader
        .read_u32()
        .await
        .map_err(|_| error("peer_closed", "peer closed"))? as usize;
    if length == 0 || length > MAX_FRAME {
        return Err(error("invalid_frame", "frame exceeds limit"));
    }
    let mut bytes = vec![0; length];
    tokio::time::timeout(Duration::from_secs(30), reader.read_exact(&mut bytes))
        .await
        .map_err(|_| error("traffic_timeout", "frame deadline expired"))?
        .map_err(|_| error("peer_closed", "peer closed"))?;
    serde_json::from_slice(&bytes).map_err(|_| error("invalid_frame", "invalid frame"))
}
pub(super) struct Packet {
    bytes: Vec<u8>,
    _permit: tokio::sync::OwnedSemaphorePermit,
}
pub(super) fn socket_peer(stopped: CancellationToken) -> (Arc<Rpc>, async_mpsc::Receiver<Packet>) {
    let (sender, receiver) = async_mpsc::channel(QUEUED_FRAMES);
    let bytes = Arc::new(Semaphore::new(QUEUED_BYTES));
    let peer = Rpc::new(
        move |value| {
            let data =
                serde_json::to_vec(&value).map_err(|_| error("invalid_frame", "invalid frame"))?;
            if data.len() > MAX_FRAME {
                return Err(error("frame_too_large", "frame exceeds limit"));
            }
            let permit = bytes
                .clone()
                .try_acquire_many_owned(data.len() as u32)
                .map_err(|_| error("traffic_backpressure", "peer queue full"))?;
            sender
                .try_send(Packet {
                    bytes: data,
                    _permit: permit,
                })
                .map_err(|_| error("traffic_backpressure", "peer queue full"))
        },
        stopped,
        64,
    );
    (peer, receiver)
}
pub(super) async fn serve_socket(
    stream: tokio::net::TcpStream,
    peer: Arc<Rpc>,
    mut outgoing: async_mpsc::Receiver<Packet>,
    handler: Handler,
    event: Event,
) {
    let _ = stream.set_nodelay(true);
    let (mut reader, mut writer) = stream.into_split();
    let incoming = async {
        let slots = Arc::new(Semaphore::new(256));
        loop {
            let value = read_frame(&mut reader).await?;
            peer.receive(value, &handler, &event, &slots)?;
        }
        #[allow(unreachable_code)]
        Ok::<(), ServiceError>(())
    };
    let output = async {
        while let Some(packet) = outgoing.recv().await {
            writer.write_u32(packet.bytes.len() as u32).await?;
            writer.write_all(&packet.bytes).await?;
        }
        Ok::<(), std::io::Error>(())
    };
    tokio::select! { _ = peer.stopped.cancelled() => {}, _ = incoming => {}, _ = output => {} }
    peer.close();
}
