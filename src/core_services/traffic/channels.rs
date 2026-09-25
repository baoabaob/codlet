//! Explicit plugin-owned channels use the same native transport and data peer.
use super::*;
use super::{
    engine::{Completion, Engine, Exchange, LeaseContext},
    model::*,
    streams::{self, Body, Streams},
    transport::{self, Trust, WsConnection},
};
use tokio_util::sync::CancellationToken;
pub(super) type Resolve = Arc<dyn Fn(Value) -> Result<Value> + Send + Sync>;
pub(super) struct Options {
    pub http: usize,
    pub ws: usize,
    pub request: usize,
    pub response: usize,
    pub attempts: usize,
    pub timeout: u64,
    pub max_message: usize,
    pub queue_bytes: usize,
}
impl Options {
    pub fn parse(value: &Value) -> Result<Self> {
        fields(
            value,
            &[
                "maxConcurrent",
                "maxWebSocketConcurrent",
                "maxRequestBytes",
                "maxResponseBytes",
                "maxForwardAttempts",
                "handlerTimeoutMs",
                "maxWebSocketMessageBytes",
                "maxWebSocketQueueBytes",
                "maxWebSocketQueueFrames",
            ],
        )?;
        let http = number(value, "maxConcurrent", 4, 4)?;
        let _ = number(value, "maxWebSocketQueueFrames", 32, 256)?;
        Ok(Self {
            http,
            ws: number(value, "maxWebSocketConcurrent", http, 32)?,
            request: number(
                value,
                "maxRequestBytes",
                8 * 1024 * 1024,
                streams::BODY_LIMIT,
            )?,
            response: number(
                value,
                "maxResponseBytes",
                32 * 1024 * 1024,
                streams::BODY_LIMIT,
            )?,
            attempts: number(value, "maxForwardAttempts", 1, 8)?,
            timeout: number(value, "handlerTimeoutMs", 15000, 300000)? as u64,
            max_message: number(
                value,
                "maxWebSocketMessageBytes",
                1024 * 1024,
                8 * 1024 * 1024,
            )?,
            queue_bytes: number(
                value,
                "maxWebSocketQueueBytes",
                2 * 1024 * 1024,
                16 * 1024 * 1024,
            )?,
        })
    }
}
fn number(value: &Value, key: &str, default: usize, max: usize) -> Result<usize> {
    match value.get(key) {
        None => Ok(default),
        Some(value) => value
            .as_u64()
            .filter(|n| *n > 0 && *n <= max as u64)
            .map(|n| n as usize)
            .ok_or_else(|| error("invalid_argument", "invalid channel budget")),
    }
}
pub(super) struct Channel {
    pub id: String,
    pub owner: String,
    pub options: Options,
    pub handlers: Vec<String>,
    pub stopped: CancellationToken,
    pub check: Check,
    pub resolve: Resolve,
    pub registration: Arc<Registration>,
    pub http: Arc<tokio::sync::Semaphore>,
    pub ws: Arc<tokio::sync::Semaphore>,
    pub active: Mutex<BTreeMap<String, Weak<Exchange>>>,
    pub forwards: std::sync::atomic::AtomicU64,
}
#[derive(Default)]
pub(super) struct Outbound {
    pub attempts: usize,
    pub pending: Option<Body>,
    pub preparing: bool,
    pub ws: Option<WsConnection>,
    pub forwarded: bool,
    pub transforms: Value,
    pub rejection: Option<ServiceError>,
}
impl Channel {
    pub fn close(&self, engine: &Engine) {
        self.stopped.cancel();
        engine
            .channels
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.id);
        let active = self
            .active
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .filter_map(Weak::upgrade)
            .collect::<Vec<_>>();
        for value in active {
            value.retire(false);
        }
        engine.host_event(
            &self.owner,
            json!({"event":"channelClosed","channel":self.id}),
        );
    }
    pub fn completed(&self, engine: &Engine, exchange: &Exchange) {
        self.active
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&exchange.id);
        engine.host_event(&self.owner,json!({"event":"channelExchangeClosed","channel":self.id,"exchange":exchange.id,"code":"closed"}));
        engine.channel_state(self);
    }
}
impl Engine {
    pub fn open_channel(
        self: &Arc<Self>,
        p: &Principal,
        params: Value,
        check: Check,
        resolve: Resolve,
    ) -> Result<Value> {
        fields(&params, &["options", "handlers"])?;
        let options = Options::parse(params.get("options").unwrap_or(&json!({})))?;
        let handlers = params["handlers"]
            .as_array()
            .filter(|v| !v.is_empty() && v.len() <= 2)
            .ok_or_else(|| error("invalid_handler", "channel handlers required"))?
            .iter()
            .map(|v| {
                v.as_str()
                    .filter(|v| matches!(*v, "http" | "webSocket"))
                    .map(str::to_owned)
                    .ok_or_else(|| error("invalid_handler", "unknown channel handler"))
            })
            .collect::<Result<Vec<_>>>()?;
        if !(check)("channel", "")? {
            return Err(error("permission_denied", "channel grant denied"));
        }
        let id = files::token("channel")?;
        let owner = owner_key(p);
        let stopped = self.stopped.child_token();
        let original = check.clone();
        let live = stopped.clone();
        let authority: Check = Arc::new(move |_, _| {
            if live.is_cancelled() {
                Ok(false)
            } else {
                original("channel", "")
            }
        });
        let registration = Arc::new(Registration {
            key: id.clone(),
            owner: owner.clone(),
            plugin_id: p.owner.plugin_id.clone(),
            generation: p.plugin.generation,
            options: json!({"timeoutMs":options.timeout,"handlers":[]}),
            check: authority,
            active: AtomicBool::new(true),
            order: 0,
        });
        let channel = Arc::new(Channel {
            id: id.clone(),
            owner: owner.clone(),
            http: Arc::new(tokio::sync::Semaphore::new(options.http)),
            ws: Arc::new(tokio::sync::Semaphore::new(options.ws)),
            options,
            handlers: handlers.clone(),
            stopped,
            check,
            resolve,
            registration,
            active: Mutex::new(BTreeMap::new()),
            forwards: std::sync::atomic::AtomicU64::new(0),
        });
        let mut channels = self.channels.lock().unwrap_or_else(|p| p.into_inner());
        if channels.values().filter(|c| c.owner == owner).count() >= 4 || channels.len() >= 64 {
            return Err(error("channel_limit", "channel limit reached"));
        }
        channels.insert(id.clone(), channel);
        Ok(
            json!({"id":id,"endpoint":format!("http://127.0.0.1:{}/{id}",self.port),"protocols":handlers.iter().map(|v|if v=="http"{"http"}else{"websocket"}).collect::<Vec<_>>() }),
        )
    }
    pub fn close_channel(&self, owner: &str, id: &str) -> Result<Value> {
        let channel = self
            .channels
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
            .cloned();
        if let Some(channel) = channel {
            if channel.owner != owner {
                return Err(error(
                    "permission_denied",
                    "channel belongs to another owner",
                ));
            }
            channel.close(self);
        }
        Ok(json!({"closed":true}))
    }
    pub fn host_event(&self, owner: &str, value: Value) {
        if let Some(hub) = self.hub.upgrade() {
            let state = hub.state.lock().unwrap_or_else(|p| p.into_inner());
            if let Some((id, _)) = state
                .peers
                .iter()
                .find(|(_, p)| p.role == Role::Host(owner.to_owned()))
            {
                let _ = hub.send(&state, id, value);
            }
        }
    }
    fn channel_state(&self, channel: &Channel) {
        self.host_event(&channel.owner,json!({"event":"channelState","channel":channel.id,"activeRequests":channel.active.lock().unwrap_or_else(|p|p.into_inner()).len(),"forwardAttempts":channel.forwards.load(Ordering::Acquire)}));
    }
    pub async fn channel_incoming(
        self: &Arc<Self>,
        id: &str,
        path: &str,
        input: &mut http::Request<Option<hyper::body::Incoming>>,
    ) -> Result<http::Response<transport::WireBody>> {
        let channel = self
            .channels
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| error("target_not_found", "channel unavailable"))?;
        let ws = transport::is_upgrade(input.headers());
        let kind = if ws { "webSocket" } else { "http" };
        if !channel.handlers.iter().any(|v| v == kind) {
            return transport::wire_response(
                Response {
                    status: if ws { 426 } else { 405 },
                    headers: vec![],
                    body: Body::empty(),
                    final_url: None,
                },
                None,
                false,
            );
        }
        let check = channel.check.clone();
        let allowed = tokio::task::spawn_blocking(move || check("channel", ""))
            .await
            .map_err(|_| error("traffic_unavailable", "authority failed"))??;
        if !allowed || channel.stopped.is_cancelled() {
            return Err(error("permission_denied", "channel retired"));
        }
        let permit = if ws {
            channel.ws.clone()
        } else {
            channel.http.clone()
        }
        .try_acquire_owned()
        .map_err(|_| error("resource_limit", "channel concurrency reached"))?;
        let exchange = self.exchange(&channel.stopped, permit, None, Some(channel.clone()), ws)?;
        let completion = Completion(exchange.clone());
        let lease = Arc::new(LeaseContext {
            id: files::token("channel-lease")?,
            streams: Arc::new(Streams::new(exchange.stopped.child_token())),
        });
        {
            let hub = self
                .hub
                .upgrade()
                .ok_or_else(|| error("traffic_unavailable", "authority retired"))?;
            let mut state = hub.state.lock().unwrap_or_else(|p| p.into_inner());
            state.leases.insert(
                lease.id.clone(),
                Lease {
                    registration: channel.registration.clone(),
                    opening_request: Value::Null,
                    url: String::new(),
                    // Explicit channels retain the original socket-owned
                    // lifetime. Callback/read deadlines still apply; an open
                    // WebSocket is not forcibly ended after five minutes.
                    expires: None,
                },
            );
        }
        exchange
            .leases
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(channel.id.clone(), lease.clone());
        self.leases
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(lease.id.clone(), Arc::downgrade(&exchange));
        channel
            .active
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(exchange.id.clone(), Arc::downgrade(&exchange));
        self.channel_state(&channel);
        let method = input.method().to_string();
        let headers = from_map(input.headers())?;
        let body = if ws {
            Value::Null
        } else {
            let body = transport::take_incoming(input, exchange.stopped.child_token())?;
            lease.streams.export(Body::new(
                body.stream(channel.options.request)?,
                exchange.stopped.child_token(),
            ))?
        };
        let value = json!({"id":exchange.id,"path":path,"method":method,"headers":headers,"body":body,"protocols":transport::protocols(input.headers())?});
        if ws {
            // Forward completes the upgrade independently of the callback's
            // remaining work (which may itself await the bridge close promise).
            let (sender, mut receiver) = tokio::sync::oneshot::channel();
            let engine = self.clone();
            let current = exchange.clone();
            let registration = channel.registration.clone();
            let budget = channel.options.attempts;
            self.spawn(async move {
                let result = engine
                    .callback(
                        &registration,
                        &lease,
                        "channel.webSocket",
                        value,
                        json!({"maxForwardAttempts":budget}),
                        &current,
                    )
                    .await;
                let failed = result.is_err();
                if sender.send(result).is_err() && failed {
                    current.retire(false);
                }
            });
            let upstream = loop {
                let ready = exchange.ws_ready.notified();
                if let Some(upstream) = exchange.outbound.lock().await.ws.take() {
                    break upstream;
                }
                tokio::select! {
                    biased;
                    result=&mut receiver=>{
                        match result.map_err(|_|error("stream_retired","callback retired"))? {
                            Ok(_)=>{if let Some(upstream)=exchange.outbound.lock().await.ws.take(){break upstream;}return Err(error("websocket_not_forwarded","channel did not forward WebSocket"));},
                            Err(error)=>{let rejection=exchange.outbound.lock().await.rejection.take();return Err(if error.code=="websocket_rejected"{rejection.unwrap_or(error)}else{error});}
                        }
                    },
                    _=exchange.stopped.cancelled()=>return Err(error("request_cancelled","channel retired")),
                    _=ready=>{},
                }
            };
            self.finish_ws(input, upstream, vec![], exchange, completion, Some(channel))
                .await
        } else {
            let response = self
                .callback(
                    &channel.registration,
                    &lease,
                    "channel.http",
                    value,
                    json!({"maxForwardAttempts":channel.options.attempts}),
                    &exchange,
                )
                .await?;
            fields(&response, &["status", "headers", "body"])?;
            let body = streams::remote_body(
                self.gateway.clone(),
                lease.id.clone(),
                response.get("body").cloned().unwrap_or(Value::Null),
                exchange.stopped.child_token(),
                channel.options.response,
            )?;
            let body = Body::new(
                body.stream(channel.options.response)?,
                exchange.stopped.child_token(),
            );
            transport::wire_response(
                Self::headers_response(&response, body)?,
                Some(completion),
                method == "HEAD",
            )
        }
    }
    pub async fn channel_operation(
        self: &Arc<Self>,
        owner: String,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        let lease_id = string(&params, "lease")?;
        let exchange = self
            .leases
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(lease_id)
            .and_then(Weak::upgrade)
            .ok_or_else(|| error("stream_retired", "exchange retired"))?;
        let channel = exchange
            .channel
            .clone()
            .filter(|c| c.owner == owner)
            .ok_or_else(|| error("permission_denied", "exchange owner mismatch"))?;
        exchange.check()?;
        if method == "channel.cancel" {
            exchange.retire(false);
            return Ok(json!({"cancelled":true}));
        }
        if method != "channel.forward" {
            return Err(error("invalid_method", "unknown channel method"));
        }
        let value = &params["request"];
        let ws = params["webSocket"] == true;
        if params["webSocket"].as_bool() != Some(exchange.web_socket) {
            return Err(error(
                "invalid_frame",
                "forward protocol differs from the inbound exchange",
            ));
        }
        fields(
            value,
            if ws {
                &[
                    "url",
                    "headers",
                    "protocols",
                    "networkProfile",
                    "credentialRef",
                    "transforms",
                ]
            } else {
                &[
                    "url",
                    "method",
                    "headers",
                    "body",
                    "networkProfile",
                    "credentialRef",
                ]
            },
        )?;
        {
            let mut state = exchange
                .outbound
                .try_lock()
                .map_err(|_| error("forward_response_pending", "forward is already pending"))?;
            if state.preparing || state.pending.as_ref().is_some_and(|b| !b.finished()) {
                return Err(error(
                    "forward_response_pending",
                    "consume or cancel the previous response",
                ));
            }
            if ws && state.forwarded {
                return Err(error(
                    "forward_already_dispatched",
                    "WebSocket already dispatched",
                ));
            }
            if state.attempts >= channel.options.attempts {
                return Err(error("forward_attempt_limit", "forward budget exhausted"));
            }
            state.attempts += 1;
            state.preparing = true;
            state.forwarded |= ws;
            state.transforms = value.get("transforms").cloned().unwrap_or(Value::Null);
        }
        channel.forwards.fetch_add(1, Ordering::AcqRel);
        self.channel_state(&channel);
        let result=async{
            let target=string(value,"url")?.to_owned();url(&target)?;
            let resolve=channel.resolve.clone();let options=value.clone();let route=tokio::task::spawn_blocking(move||resolve(options)).await.map_err(|_|error("traffic_unavailable","authority failed"))??;exchange.check()?;
            let trust=Trust{credential:route["credential"].as_str().map(str::to_owned),route:Some(route),ca:None};
            let method=super::model::method(value.get("method").and_then(Value::as_str).unwrap_or("GET"))?;
            if !ws&&matches!(method.as_str(),"GET"|"HEAD")&&!value.get("body").is_none_or(Value::is_null){return Err(error("invalid_argument","GET/HEAD body is unsupported"));}
            let body=streams::remote_body(self.gateway.clone(),lease_id.to_owned(),value.get("body").cloned().unwrap_or(Value::Null),exchange.stopped.child_token(),channel.options.request)?;
            let body=Body::new(body.stream(channel.options.request)?,exchange.stopped.child_token());
            let protocols=value.get("protocols").map(|v|v.as_array().ok_or_else(||error("invalid_argument","invalid protocols"))).transpose()?.map(|v|v.iter().map(|v|v.as_str().map(str::to_owned).ok_or_else(||error("invalid_argument","invalid protocol"))).collect::<Result<Vec<_>>>()).transpose()?.unwrap_or_default();
            let request=Request{id:exchange.id.clone(),url:target,method,headers:pairs(value.get("headers").unwrap_or(&json!([])))?,body,protocols};
            if ws{let socket=self.connect_ws(&request,&trust,&exchange).await?;let result=json!({"protocol":socket.protocol});exchange.outbound.lock().await.ws=Some(socket);exchange.ws_ready.notify_one();Ok(result)}
            else{let response=self.forward_http(&request,&trust,&exchange,channel.options.response).await?;
                let streams=exchange.leases.lock().unwrap_or_else(|p|p.into_inner()).get(&channel.id).map(|v|v.streams.clone()).ok_or_else(||error("stream_retired","lease retired"))?;
                exchange.outbound.lock().await.pending=Some(response.body.clone());
                Ok(json!({"status":response.status,"headers":response.headers,"body":streams.export(response.body)?}))}
        }.await;
        let mut outbound = exchange.outbound.lock().await;
        outbound.preparing = false;
        if let Err(error) = &result
            && error.code == "websocket_rejected"
        {
            outbound.rejection = Some(error.clone());
        }
        result
    }
    pub async fn channel_frame(
        &self,
        channel: &Channel,
        exchange: &Arc<Exchange>,
        direction: &str,
        bytes: bytes::Bytes,
        binary: bool,
    ) -> Result<Option<(bytes::Bytes, bool)>> {
        if exchange.outbound.lock().await.transforms[direction] != true {
            return Ok(Some((bytes, binary)));
        }
        let lease = exchange
            .leases
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&channel.id)
            .cloned()
            .ok_or_else(|| error("stream_retired", "lease retired"))?;
        let body = lease.streams.export(Body::bytes(bytes))?;
        let result=self.gateway.request("relay",json!({"lease":lease.id,"operation":"invoke","payload":{"kind":"channel.frame","direction":direction,"value":{"binary":binary,"body":body}}}),&exchange.stopped,Duration::from_millis(channel.options.timeout)).await?;
        if result.is_null() {
            return Ok(None);
        }
        let binary = result["binary"]
            .as_bool()
            .ok_or_else(|| error("invalid_frame", "invalid frame type"))?;
        let data = streams::remote_body(
            self.gateway.clone(),
            lease.id.clone(),
            result["body"].clone(),
            exchange.stopped.child_token(),
            channel.options.max_message,
        )?
        .collect(channel.options.max_message)
        .await?;
        Ok(Some((data, binary)))
    }
}
