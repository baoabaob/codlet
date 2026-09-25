//! One-use, bounded byte streams. Bytes stay native unless a peer reads them.
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use std::pin::Pin;
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

pub(super) const BODY_LIMIT: usize = 64 * 1024 * 1024;
pub(super) const CHUNK: usize = 32 * 1024;
pub(super) type ByteStream = Pin<Box<dyn Stream<Item = Result<Bytes>> + Send>>;

#[derive(Clone)]
pub(super) struct Body(Arc<BodyInner>);
struct BodyInner {
    stream: Mutex<Option<ByteStream>>,
    stopped: CancellationToken,
    finished: AtomicBool,
    absent: bool,
}
impl Body {
    pub fn new(stream: ByteStream, stopped: CancellationToken) -> Self {
        Self(Arc::new(BodyInner {
            stream: Mutex::new(Some(stream)),
            stopped,
            finished: AtomicBool::new(false),
            absent: false,
        }))
    }
    pub fn bytes(bytes: Bytes) -> Self {
        Self::new(
            Box::pin(futures_util::stream::once(async move { Ok(bytes) })),
            CancellationToken::new(),
        )
    }
    pub fn empty() -> Self {
        Self(Arc::new(BodyInner {
            stream: Mutex::new(Some(Box::pin(futures_util::stream::empty()))),
            stopped: CancellationToken::new(),
            finished: AtomicBool::new(false),
            absent: true,
        }))
    }
    pub fn cancel(&self) {
        self.0.finished.store(true, Ordering::Release);
        self.0.stopped.cancel();
        self.0
            .stream
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
    }
    pub fn finished(&self) -> bool {
        self.0.finished.load(Ordering::Acquire)
    }
    pub fn reader(&self, limit: usize) -> Result<Reader> {
        let stream = self
            .0
            .stream
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
            .ok_or_else(|| error("body_already_consumed", "body is one-use"))?;
        Ok(Reader {
            body: self.clone(),
            stream,
            tail: Bytes::new(),
            total: 0,
            limit,
            ended: false,
        })
    }
    pub fn stream(&self, limit: usize) -> Result<ByteStream> {
        let reader = self.reader(limit)?;
        Ok(Box::pin(futures_util::stream::unfold(
            reader,
            |mut reader| async move {
                match reader.next().await {
                    Ok(Some(bytes)) => Some((Ok(bytes), reader)),
                    Ok(None) => None,
                    Err(e) => {
                        reader.ended = true;
                        Some((Err(e), reader))
                    }
                }
            },
        )))
    }
    pub async fn collect(&self, limit: usize) -> Result<Bytes> {
        let mut reader = self.reader(limit)?;
        let mut out = bytes::BytesMut::new();
        while let Some(bytes) = reader.next().await? {
            out.extend_from_slice(&bytes);
        }
        Ok(out.freeze())
    }
}
pub(super) struct Reader {
    body: Body,
    stream: ByteStream,
    tail: Bytes,
    total: usize,
    limit: usize,
    ended: bool,
}
impl Reader {
    pub async fn next(&mut self) -> Result<Option<Bytes>> {
        if self.ended {
            return Ok(None);
        }
        if self.body.0.stopped.is_cancelled() {
            return Err(error("stream_retired", "body retired"));
        }
        if !self.tail.is_empty() {
            return Ok(Some(self.tail.split_to(self.tail.len().min(CHUNK))));
        }
        for _ in 0..128 {
            let next = tokio::select! {
                biased;
                _ = self.body.0.stopped.cancelled() => return Err(error("stream_retired", "body retired")),
                next = self.stream.next() => next,
            };
            let Some(bytes) = next else {
                self.ended = true;
                self.body.0.finished.store(true, Ordering::Release);
                return Ok(None);
            };
            let bytes = bytes?;
            self.total = self
                .total
                .checked_add(bytes.len())
                .filter(|n| *n <= self.limit)
                .ok_or_else(|| error("body_too_large", "body limit exceeded"))?;
            if bytes.is_empty() {
                continue;
            }
            self.tail = bytes;
            return Ok(Some(self.tail.split_to(self.tail.len().min(CHUNK))));
        }
        Err(error("invalid_body", "empty producer exceeded bound"))
    }
}
impl Drop for Reader {
    fn drop(&mut self) {
        self.body.0.finished.store(true, Ordering::Release);
    }
}
struct Exported {
    body: Body,
    reader: AsyncMutex<Option<Reader>>,
}
pub(super) struct Streams {
    bodies: Mutex<BTreeMap<String, Arc<Exported>>>,
    stopped: CancellationToken,
}
impl Streams {
    pub fn new(stopped: CancellationToken) -> Self {
        Self {
            bodies: Mutex::new(BTreeMap::new()),
            stopped,
        }
    }
    pub fn export(&self, body: Body) -> Result<Value> {
        if self.stopped.is_cancelled() {
            return Err(error("stream_retired", "stream owner retired"));
        }
        if body.0.absent {
            return Ok(Value::Null);
        }
        let key = files::token("stream")?;
        // The existing JS wire validates 32 lower-case hexadecimal characters.
        let key = format!("{:x}", sha2::Sha256::digest(key.as_bytes()))[..32].to_owned();
        let mut bodies = self.bodies.lock().unwrap_or_else(|p| p.into_inner());
        if bodies.len() >= 8 {
            return Err(error("resource_limit", "stream limit reached"));
        }
        bodies.insert(
            key.clone(),
            Arc::new(Exported {
                body,
                reader: AsyncMutex::new(None),
            }),
        );
        Ok(json!({"stream":key}))
    }
    pub async fn handle(&self, operation: &str, payload: &Value) -> Result<Value> {
        if self.stopped.is_cancelled() {
            return Err(error("stream_retired", "stream owner retired"));
        }
        let key = string(payload, "stream")?;
        let entry = self
            .bodies
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(key)
            .cloned()
            .ok_or_else(|| error("stream_retired", "stream retired"))?;
        if operation == "stream.cancel" {
            self.bodies
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(key);
            // Cancellation must wake a pending read, not wait behind its lock.
            entry.body.cancel();
            return Ok(json!({"cancelled":true}));
        }
        if operation != "stream.read" {
            return Err(error("invalid_method", "unknown stream operation"));
        }
        let mut reader = entry
            .reader
            .try_lock()
            .map_err(|_| error("body_read_pending", "stream read already pending"))?;
        if reader.is_none() {
            *reader = Some(entry.body.reader(BODY_LIMIT)?);
        }
        let value = tokio::select! {
            biased;
            _ = self.stopped.cancelled() => Err(error("stream_retired", "stream owner retired")),
            value = reader.as_mut().expect("reader initialized").next() => value,
        }?;
        if let Some(bytes) = value {
            Ok(json!({"done":false,"bytes":BASE64.encode(bytes)}))
        } else {
            self.bodies
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(key);
            Ok(json!({"done":true}))
        }
    }
    pub fn close(&self) {
        self.stopped.cancel();
        self.bodies
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
    }
}
use sha2::Digest;

pub(super) fn decode_inline(value: &Value, limit: usize) -> Result<Option<Bytes>> {
    if value.is_null() {
        return Ok(Some(Bytes::new()));
    }
    let object = value
        .as_object()
        .filter(|v| v.len() == 1)
        .ok_or_else(|| error("invalid_body", "invalid body reference"))?;
    if let Some(encoded) = object.get("inline") {
        let encoded = encoded
            .as_str()
            .filter(|v| v.len() <= 1368)
            .ok_or_else(|| error("invalid_body", "invalid inline body"))?;
        let bytes = BASE64
            .decode(encoded)
            .map_err(|_| error("invalid_body", "invalid base64"))?;
        if BASE64.encode(&bytes) != encoded {
            return Err(error("invalid_body", "invalid inline body"));
        }
        if bytes.len() > limit {
            return Err(error(
                "body_too_large",
                "inline body exceeds configured limit",
            ));
        }
        return Ok(Some(Bytes::from(bytes)));
    }
    let key = string(value, "stream")?;
    if key.len() != 32
        || !key
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(error("invalid_body", "invalid stream reference"));
    }
    Ok(None)
}

pub(super) fn remote_body(
    peer: Arc<super::rpc::Rpc>,
    lease: String,
    reference: Value,
    stopped: CancellationToken,
    limit: usize,
) -> Result<Body> {
    if reference.is_null() {
        return Ok(Body::empty());
    }
    if let Some(bytes) = decode_inline(&reference, limit)? {
        return Ok(Body::bytes(bytes));
    }
    struct Remote {
        peer: Arc<super::rpc::Rpc>,
        lease: String,
        reference: Value,
        stopped: CancellationToken,
        ended: bool,
        runtime: tokio::runtime::Handle,
    }
    impl Drop for Remote {
        fn drop(&mut self) {
            if self.ended || self.peer.stopped.is_cancelled() {
                return;
            }
            let peer = self.peer.clone();
            let lease = self.lease.clone();
            let reference = self.reference.clone();
            self.runtime.spawn(async move {
                let _ = peer
                    .request(
                        "relay",
                        json!({"lease":lease,"operation":"stream.cancel","payload":reference}),
                        &peer.stopped,
                        Duration::from_secs(2),
                    )
                    .await;
            });
        }
    }
    let state = Remote {
        peer,
        lease,
        reference,
        stopped: stopped.clone(),
        ended: false,
        runtime: tokio::runtime::Handle::current(),
    };
    let stream = futures_util::stream::unfold(state, |mut state| async move {
        if state.ended {
            return None;
        }
        let result = state
            .peer
            .request(
                "relay",
                json!({"lease":state.lease,"operation":"stream.read","payload":state.reference}),
                &state.stopped,
                Duration::from_secs(300),
            )
            .await;
        let next = (|| {
            let result = result?;
            if result["done"] == true {
                return Ok(None);
            }
            let encoded = result["bytes"]
                .as_str()
                .ok_or_else(|| error("invalid_body", "invalid body chunk"))?;
            if encoded.is_empty() || encoded.len() > CHUNK.div_ceil(3) * 4 {
                return Err(error("invalid_body", "invalid body chunk"));
            }
            let bytes = BASE64
                .decode(encoded)
                .map_err(|_| error("invalid_body", "invalid chunk encoding"))?;
            if bytes.len() > CHUNK || BASE64.encode(&bytes) != encoded {
                return Err(error("invalid_body", "invalid body chunk"));
            }
            Ok(Some(Bytes::from(bytes)))
        })();
        match next {
            Ok(None) => {
                state.ended = true;
                drop(state); // Drop uses ended to suppress a redundant remote cancel.
                None
            }
            Ok(Some(bytes)) => Some((Ok(bytes), state)),
            Err(e) => {
                state.ended = true;
                Some((Err(e), state))
            }
        }
    });
    Ok(Body::new(Box::pin(stream), stopped))
}
