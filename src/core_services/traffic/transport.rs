//! HTTP/SSE/WS transport shared by transparent routes and explicit channels.
use super::*;
use super::{
    dispatch::Participant,
    engine::{Completion, Engine, Exchange},
    model::*,
    streams::{self, Body},
};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, StreamBody, combinators::UnsyncBoxBody};
use hyper::body::{Frame, Incoming};
use hyper_util::rt::TokioIo;
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{
        Message,
        handshake::{client::generate_key, derive_accept_key},
        protocol::{Role as WsRole, WebSocketConfig},
    },
};
use tokio_util::sync::CancellationToken;
pub(super) type WireBody = UnsyncBoxBody<Bytes, ServiceError>;
pub(super) type UpstreamSocket = WebSocketStream<reqwest::Upgraded>;
// TLS/proxy contexts are expensive. Reuse a bounded set, partitioned by owner
// and exact trust/route configuration, without caching authorization decisions.
#[derive(Clone, PartialEq, Eq)]
pub(super) struct ClientKey {
    pub owner: String,
    proxy: Option<String>,
    proxy_authorization: Option<String>,
    ca: Option<String>,
}
#[derive(Clone, Default)]
pub(super) struct Trust {
    pub ca: Option<(String, String)>,
    pub route: Option<Value>,
    pub credential: Option<String>,
}
pub(super) struct WsConnection {
    pub socket: UpstreamSocket,
    pub protocol: Option<String>,
}

impl Engine {
    pub fn start_http(self: &Arc<Self>, listener: tokio::net::TcpListener) {
        let engine = self.clone();
        self.spawn(async move{
            let slots=Arc::new(tokio::sync::Semaphore::new(4096));
            loop{
                let accepted=tokio::select!{_=engine.stopped.cancelled()=>break,value=listener.accept()=>value};
                let Ok((stream,_))=accepted else{engine.stop();break};
                let Ok(permit)=slots.clone().try_acquire_owned() else{continue};
                let _=stream.set_nodelay(true);let engine=engine.clone();
                engine.clone().spawn(async move{
                    let _permit=permit;let service_engine=engine.clone();
                    let service=hyper::service::service_fn(move|request|{let engine=service_engine.clone();async move{Ok::<_,std::convert::Infallible>(engine.serve_http(request).await)}});
                    let mut builder=hyper::server::conn::http1::Builder::new();
                    builder.max_headers(128).max_buf_size(32*1024).timer(hyper_util::rt::TokioTimer::new()).header_read_timeout(Duration::from_secs(10));
                    let connection=builder.serve_connection(TokioIo::new(stream),service).with_upgrades();
                    tokio::select!{_=engine.stopped.cancelled()=>{},_=connection=>{}}
                });
            }
        });
    }
    async fn serve_http(
        self: Arc<Self>,
        input: http::Request<Incoming>,
    ) -> http::Response<WireBody> {
        let mut input = input.map(Some);
        let result = self.dispatch_incoming(&mut input).await;
        match result {
            Ok(value) => value,
            Err(e) => wire_response(error_response(&e), None, false)
                .unwrap_or_else(|_| http::Response::new(empty_wire())),
        }
    }
    async fn dispatch_incoming(
        self: &Arc<Self>,
        input: &mut http::Request<Option<Incoming>>,
    ) -> Result<http::Response<WireBody>> {
        validate_incoming(input)?;
        let raw = input
            .uri()
            .path_and_query()
            .map(|v| v.as_str())
            .unwrap_or("/")
            .to_owned();
        if raw.len() > 8192
            || !raw.starts_with('/')
            || raw.starts_with("//")
            || super::source::bad_path(&raw)
            || input.uri().scheme().is_some()
            || input.uri().authority().is_some()
        {
            return Err(error("invalid_target", "invalid ingress path"));
        }
        let (key, suffix) = raw[1..]
            .split_once('/')
            .map(|(a, b)| (a, format!("/{b}")))
            .unwrap_or((
                raw[1..].split('?').next().unwrap_or(""),
                format!(
                    "/{}",
                    raw.split_once('?')
                        .map(|(_, q)| format!("?{q}"))
                        .unwrap_or_default()
                ),
            ));
        if key != self.prefix {
            return self.channel_incoming(key, &suffix, input).await;
        }
        let (id, suffix) = suffix[1..]
            .split_once('/')
            .map(|(a, b)| (a, format!("/{b}")))
            .unwrap_or((
                suffix[1..].split('?').next().unwrap_or(""),
                format!(
                    "/{}",
                    suffix
                        .split_once('?')
                        .map(|(_, q)| format!("?{q}"))
                        .unwrap_or_default()
                ),
            ));
        if !super::source::token(id) {
            return Err(error("target_not_found", "unknown route"));
        }
        let websocket = is_upgrade(input.headers());
        let permit = if websocket {
            self.ws_slots.clone()
        } else {
            self.http_slots.clone()
        }
        .try_acquire_owned()
        .map_err(|_| error("resource_limit", "ingress capacity reached"))?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        let (config, parent) = loop {
            let notified = self.route_changed.notified();
            let registered = self
                .routes
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(id)
                .cloned();
            if let Some(route) = registered {
                let config = route
                    .config
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone();
                break (config, route.stopped.clone());
            }
            let owned = self.hub.upgrade().and_then(|h| {
                h.state
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .sources
                    .get(id)
                    .cloned()
            });
            if let Some(source) = owned {
                let check = source.check.clone();
                let base = source.base_url.clone();
                let allowed = tokio::task::spawn_blocking(move || check("intercept", &base))
                    .await
                    .map_err(|_| error("traffic_unavailable", "authority failed"))??;
                if !allowed || source.stopped.is_cancelled() {
                    return Err(error("permission_denied", "source retired"));
                }
                break (
                    Arc::new(super::source::RouteConfig {
                        base: super::source::base(&source.base_url)?,
                        ca: String::new(),
                    }),
                    source.stopped.clone(),
                );
            }
            tokio::select! {_=self.stopped.cancelled()=>return Err(error("traffic_unavailable","engine retired")),_=tokio::time::sleep_until(deadline)=>return Err(error("target_not_found","route unavailable")),_=notified=>{}}
        };
        let mut target = config
            .base
            .join(suffix.trim_start_matches('/'))
            .map_err(|_| error("invalid_target", "invalid route URL"))?;
        if target.origin() != config.base.origin() || !target.path().starts_with(config.base.path())
        {
            return Err(error("invalid_target", "route boundary changed"));
        }
        let exchange = self.exchange(&parent, permit, None, None, websocket)?;
        let completion = Completion(exchange.clone());
        let headers = from_map(input.headers())?;
        let method = input.method().to_string();
        let trust = Trust {
            ca: (!config.ca.is_empty()).then(|| {
                (
                    config.base.origin().ascii_serialization(),
                    config.ca.clone(),
                )
            }),
            ..Default::default()
        };
        if websocket {
            let scheme = if target.scheme() == "https" {
                "wss"
            } else {
                "ws"
            };
            let _ = target.set_scheme(scheme);
            let mut request = Request {
                id: files::token("request")?,
                url: target.to_string(),
                method,
                headers,
                body: Body::empty(),
                protocols: protocols(input.headers())?,
            };
            let participants = self.intercept_ws(&mut request, &exchange).await?;
            let upstream = self.connect_ws(&request, &trust, &exchange).await?;
            self.finish_ws(input, upstream, participants, exchange, completion, None)
                .await
        } else {
            // Taking the body does not buffer it. Hyper's original request is
            // left with an empty incoming body only after an explicit split.
            let body = take_incoming(input, exchange.stopped.child_token())?;
            let request = Request {
                id: files::token("request")?,
                url: target.to_string(),
                method: method.clone(),
                headers,
                body,
                protocols: vec![],
            };
            let response = self.intercept_http(request, &exchange, &trust).await?;
            wire_response(response, Some(completion), method == "HEAD")
        }
    }
    pub async fn network_client(
        &self,
        target: &url::Url,
        trust: &Trust,
        exchange: &Exchange,
    ) -> Result<reqwest::Client> {
        exchange.check()?;
        self.check_loop(target)?;
        let route = if let Some(route) = &trust.route {
            route.clone()
        } else if let Some(route) = environment_route(&self.environment, target) {
            route
        } else {
            let target = target.clone();
            let permit = self
                .blockers
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| error("traffic_unavailable", "resolver retired"))?;
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                super::super::network::proxy::system_proxy(&target)
                    .map(|proxy| json!({"proxyUrl":proxy}))
            })
            .await
            .map_err(|_| error("proxy_resolution_failed", "resolver failed"))??
        };
        exchange.check()?;
        let ca = trust
            .ca
            .as_ref()
            .filter(|(expected, _)| origin(target.as_str()).is_ok_and(|actual| actual == *expected))
            .map(|(_, pem)| pem.as_str())
            .or_else(|| route["caPem"].as_str());
        let key = ClientKey {
            owner: exchange
                .channel
                .as_ref()
                .map(|c| c.owner.clone())
                .unwrap_or_default(),
            proxy: route["proxyUrl"].as_str().map(str::to_owned),
            proxy_authorization: route["proxyAuthorization"].as_str().map(str::to_owned),
            ca: ca.map(str::to_owned),
        };
        {
            let mut clients = self.clients.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(index) = clients.iter().position(|(k, _)| k == &key) {
                let entry = clients.remove(index).expect("located cache entry");
                let client = entry.1.clone();
                clients.push_back(entry);
                return Ok(client);
            }
        }
        let mut builder = reqwest::Client::builder()
            .use_rustls_tls()
            .no_proxy()
            .http1_only()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .pool_max_idle_per_host(0)
            .connect_timeout(Duration::from_secs(30))
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd();
        if let Some(proxy) = route["proxyUrl"].as_str() {
            let parsed =
                url::Url::parse(proxy).map_err(|_| error("invalid_proxy", "invalid proxy URL"))?;
            self.check_loop(&parsed)?;
            if !matches!(parsed.scheme(), "http" | "https")
                || parsed.path() != "/"
                || parsed.query().is_some()
                || parsed.fragment().is_some()
            {
                return Err(error("invalid_proxy", "invalid proxy"));
            }
            let mut proxy = reqwest::Proxy::all(proxy)
                .map_err(|_| error("invalid_proxy", "invalid proxy URL"))?;
            if let Some(auth) = route["proxyAuthorization"].as_str() {
                let (user, password) = auth
                    .split_once(':')
                    .ok_or_else(|| error("invalid_credential", "invalid proxy credential"))?;
                proxy = proxy.basic_auth(user, password);
            }
            builder = builder.proxy(proxy);
        }
        if let Some(pem) = ca {
            for certificate in reqwest::Certificate::from_pem_bundle(pem.as_bytes())
                .map_err(|_| error("invalid_ca_bundle", "invalid CA bundle"))?
            {
                builder = builder.add_root_certificate(certificate);
            }
        }
        if let Some(pem) = &self.inherited_ca {
            for certificate in reqwest::Certificate::from_pem_bundle(pem.as_bytes())
                .map_err(|_| error("invalid_ca_bundle", "invalid inherited CA bundle"))?
            {
                builder = builder.add_root_certificate(certificate);
            }
        }
        let permit = self
            .blockers
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| error("traffic_unavailable", "transport initialization retired"))?;
        let client = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            builder
                .build()
                .map_err(|_| error("network_unavailable", "cannot initialize transport"))
        })
        .await
        .map_err(|_| error("network_unavailable", "transport initialization failed"))??;
        exchange.check()?;
        let mut clients = self.clients.lock().unwrap_or_else(|p| p.into_inner());
        if clients.len() >= 32 {
            clients.pop_front();
        }
        clients.push_back((key, client.clone()));
        Ok(client)
    }
    fn check_loop(&self, target: &url::Url) -> Result<()> {
        if matches!(
            target.host_str(),
            Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
        ) && target
            .port()
            .is_some_and(|port| port == self.port || port == self.source_port)
        {
            return Err(error("proxy_loop_detected", "target is this entrance"));
        }
        Ok(())
    }
    pub async fn forward_http(
        &self,
        request: &Request,
        trust: &Trust,
        exchange: &Exchange,
        limit: usize,
    ) -> Result<Response> {
        let target = url(&request.url)?;
        if !matches!(target.scheme(), "http" | "https") {
            return Err(error("invalid_target", "HTTP URL required"));
        }
        let client = self.network_client(&target, trust, exchange).await?;
        let headers = strip(&request.headers, true);
        let mut outgoing = client
            .request(
                http::Method::from_bytes(request.method.as_bytes())
                    .map_err(|_| error("invalid_target", "invalid method"))?,
                target,
            )
            .headers(map(&headers)?);
        if let Some(credential) = &trust.credential {
            outgoing = outgoing.bearer_auth(credential);
        }
        if !matches!(request.method.as_str(), "GET" | "HEAD") {
            outgoing = outgoing.body(reqwest::Body::wrap_stream(
                request.body.stream(streams::BODY_LIMIT)?,
            ));
        }
        let response = send(outgoing, exchange).await?;
        let status = response.status().as_u16();
        let headers = from_map(response.headers())?;
        let body =
            Body::new(
                Box::pin(response.bytes_stream().map(|value| {
                    value.map_err(|_| error("stream_failed", "response stream failed"))
                })),
                exchange.stopped.child_token(),
            );
        let limited = Body::new(body.stream(limit)?, exchange.stopped.child_token());
        Ok(Response {
            status,
            headers: strip(&headers, false),
            body: limited,
            final_url: Some(request.url.clone()),
        })
    }
    pub async fn connect_ws(
        &self,
        request: &Request,
        trust: &Trust,
        exchange: &Exchange,
    ) -> Result<WsConnection> {
        validate_protocols(&request.protocols)?;
        let mut target = url(&request.url)?;
        let scheme = match target.scheme() {
            "ws" => "http",
            "wss" => "https",
            _ => return Err(error("invalid_target", "WebSocket URL required")),
        };
        let _ = target.set_scheme(scheme);
        let client = self.network_client(&target, trust, exchange).await?;
        let key = generate_key();
        let mut outgoing = client
            .get(target)
            .headers(map(&strip(&request.headers, true))?)
            .header("connection", "Upgrade")
            .header("upgrade", "websocket")
            .header("sec-websocket-version", "13")
            .header("sec-websocket-key", &key);
        if !request.protocols.is_empty() {
            outgoing = outgoing.header("sec-websocket-protocol", request.protocols.join(", "));
        }
        if let Some(credential) = &trust.credential {
            outgoing = outgoing.bearer_auth(credential);
        }
        let response = send(outgoing, exchange).await?;
        if response.status() != http::StatusCode::SWITCHING_PROTOCOLS {
            let mut error = error("websocket_rejected", "upstream rejected WebSocket upgrade");
            error.data = Some(json!({"status":response.status().as_u16()}));
            return Err(error);
        }
        if response
            .headers()
            .get("sec-websocket-accept")
            .and_then(|v| v.to_str().ok())
            != Some(derive_accept_key(key.as_bytes()).as_str())
            || !is_upgrade(response.headers())
        {
            return Err(error("invalid_response", "invalid WebSocket handshake"));
        }
        let protocol = response
            .headers()
            .get("sec-websocket-protocol")
            .map(|v| v.to_str().map(str::to_owned))
            .transpose()
            .map_err(|_| error("invalid_response", "invalid protocol"))?;
        if protocol
            .as_ref()
            .is_some_and(|p| !request.protocols.contains(p))
            || (!request.protocols.is_empty() && protocol.is_none())
        {
            return Err(error("invalid_response", "unexpected WebSocket protocol"));
        }
        let stream = response
            .upgrade()
            .await
            .map_err(|_| error("upstream_failed", "WebSocket upgrade failed"))?;
        let socket = WebSocketStream::from_raw_socket(
            stream,
            WsRole::Client,
            Some(ws_config(8 * 1024 * 1024, 16 * 1024 * 1024)),
        )
        .await;
        Ok(WsConnection { socket, protocol })
    }
    pub async fn finish_ws(
        self: &Arc<Self>,
        input: &mut http::Request<Option<Incoming>>,
        upstream: WsConnection,
        participants: Vec<Participant>,
        exchange: Arc<Exchange>,
        completion: Completion,
        channel: Option<Arc<super::channels::Channel>>,
    ) -> Result<http::Response<WireBody>> {
        let key = input
            .headers()
            .get("sec-websocket-key")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| error("invalid_target", "missing WebSocket key"))?;
        use base64::Engine as _;
        if input.method() != http::Method::GET
            || input
                .headers()
                .get("sec-websocket-version")
                .and_then(|v| v.to_str().ok())
                != Some("13")
            || base64::engine::general_purpose::STANDARD
                .decode(key)
                .map_or(true, |v| v.len() != 16)
        {
            return Err(error("invalid_target", "invalid WebSocket handshake"));
        }
        let mut response = http::Response::builder()
            .status(101)
            .header("connection", "Upgrade")
            .header("upgrade", "websocket")
            .header("sec-websocket-accept", derive_accept_key(key.as_bytes()));
        if let Some(protocol) = &upstream.protocol {
            if !protocols(input.headers())?.contains(protocol) {
                return Err(error(
                    "invalid_response",
                    "upstream protocol was not offered by the client",
                ));
            }
            response = response.header("sec-websocket-protocol", protocol);
        }
        let upgraded = hyper::upgrade::on(input);
        let engine = self.clone();
        self.spawn(async move{
            let _completion=completion;
            let socket=tokio::select!{biased;_=exchange.stopped.cancelled()=>return,result=upgraded=>match result{Ok(value)=>value,Err(_)=>return}};
            let (limit,queue)=channel.as_ref().map(|c|(c.options.max_message,c.options.queue_bytes)).unwrap_or((8*1024*1024,16*1024*1024));
            let downstream=WebSocketStream::from_raw_socket(TokioIo::new(socket),WsRole::Server,Some(ws_config(limit,queue))).await;
            let (mut down_write,mut down_read)=downstream.split();let(mut up_write,mut up_read)=upstream.socket.split();
            let participants=Arc::new(participants);
            let down_closing=AtomicBool::new(false);let up_closing=AtomicBool::new(false);
            let failure = {
            let client=async{
                while let Some(frame)=down_read.next().await{
                    let frame=frame.map_err(|_|error("websocket_closed","downstream closed"))?;
                    if let Some(frame)=engine.ws_frame(&participants,"clientToServer",frame,&exchange,channel.as_ref(),(limit,queue)).await?{let closing=frame.is_close();if closing{down_closing.store(true,Ordering::Release);}if closing&&up_closing.load(Ordering::Acquire){up_write.flush().await}else{up_write.send(frame).await}.map_err(|_|error("websocket_closed","upstream closed"))?;if closing{break;}}
                }Ok::<(),ServiceError>(())
            };
            let server=async{
                while let Some(frame)=up_read.next().await{
                    let frame=frame.map_err(|_|error("websocket_closed","upstream closed"))?;
                    if let Some(frame)=engine.ws_frame(&participants,"serverToClient",frame,&exchange,channel.as_ref(),(limit,queue)).await?{let closing=frame.is_close();if closing{up_closing.store(true,Ordering::Release);}if closing&&down_closing.load(Ordering::Acquire){down_write.flush().await}else{down_write.send(frame).await}.map_err(|_|error("websocket_closed","downstream closed"))?;if closing{break;}}
                }Ok::<(),ServiceError>(())
            };
            tokio::pin!(client,server);
            tokio::select!{
                _=exchange.stopped.cancelled()=>None,
                result=&mut client=>{if result.is_ok(){let _=tokio::time::timeout(Duration::from_millis(500),&mut server).await;}result.err()},
                result=&mut server=>{if result.is_ok(){let _=tokio::time::timeout(Duration::from_millis(500),&mut client).await;}result.err()},
            }
            };
            if failure.is_some() {
                let close = Message::Close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame {
                    code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Error,
                    reason: "traffic exchange failed".into(),
                }));
                let _ = tokio::time::timeout(Duration::from_millis(500), async {
                    let _ = tokio::join!(down_write.send(close.clone()), up_write.send(close));
                }).await;
            }
        });
        response
            .body(empty_wire())
            .map_err(|_| error("invalid_response", "invalid WebSocket response"))
    }
    async fn ws_frame(
        self: &Arc<Self>,
        participants: &[Participant],
        direction: &str,
        frame: Message,
        exchange: &Arc<Exchange>,
        channel: Option<&Arc<super::channels::Channel>>,
        limits: (usize, usize),
    ) -> Result<Option<Message>> {
        let (limit, queue) = limits;
        let binary = frame.is_binary();
        if !binary && !frame.is_text() {
            return Ok(Some(frame));
        }
        let bytes = frame.into_data();
        if bytes.len() > limit || bytes.len() > queue {
            return Err(error("body_too_large", "WebSocket message exceeds limit"));
        }
        let changed = if let Some(channel) = channel {
            self.channel_frame(channel, exchange, direction, bytes, binary)
                .await?
        } else {
            self.transform(participants, direction, bytes, binary, exchange)
                .await?
        };
        let Some((bytes, binary)) = changed else {
            return Ok(None);
        };
        if bytes.len() > limit || bytes.len() > queue {
            return Err(error("body_too_large", "transformed message exceeds limit"));
        }
        Ok(Some(if binary {
            Message::Binary(bytes)
        } else {
            Message::Text(
                String::from_utf8(bytes.to_vec())
                    .map_err(|_| error("invalid_frame", "invalid text frame"))?
                    .into(),
            )
        }))
    }
}
pub(super) fn ws_config(limit: usize, queue: usize) -> WebSocketConfig {
    WebSocketConfig::default()
        .read_buffer_size(32 * 1024)
        .write_buffer_size(0)
        .max_write_buffer_size(queue + 1024)
        .max_message_size(Some(limit))
        .max_frame_size(Some(limit))
}
async fn send(request: reqwest::RequestBuilder, exchange: &Exchange) -> Result<reqwest::Response> {
    tokio::select! {
        biased;
        _ = exchange.stopped.cancelled() => Err(error("request_cancelled", "exchange retired")),
        response = tokio::time::timeout(Duration::from_secs(300), request.send()) => {
            response.map_err(|_| error("traffic_timeout", "upstream headers timed out"))?
                .map_err(|reason| {
                    use std::error::Error as _;
                    let mut cause = reason.source();
                    while let Some(value) = cause {
                        if let Some(error) = value.downcast_ref::<ServiceError>()
                            && matches!(error.code, "body_too_large" | "stream_retired" | "request_cancelled") {
                            return error.clone();
                        }
                        cause = value.source();
                    }
                    error("upstream_failed", "upstream request failed")
                })
        }
    }
}
pub(super) fn protocols(headers: &http::HeaderMap) -> Result<Vec<String>> {
    let values = headers
        .get_all("sec-websocket-protocol")
        .iter()
        .map(|v| {
            v.to_str()
                .map_err(|_| error("invalid_target", "invalid protocols"))
        })
        .collect::<Result<Vec<_>>>()?
        .join(",");
    let result = values
        .split(',')
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    validate_protocols(&result)?;
    Ok(result)
}
fn validate_protocols(values: &[String]) -> Result<()> {
    if values.len() > 32
        || values.iter().enumerate().any(|(index, v)| {
            v.is_empty()
                || values[..index].contains(v)
                || v.len() > 128
                || !v
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&c))
        })
    {
        return Err(error("invalid_target", "invalid protocols"));
    }
    Ok(())
}
pub(super) fn is_upgrade(headers: &http::HeaderMap) -> bool {
    headers
        .get("upgrade")
        .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket"))
        && headers
            .get("connection")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                v.split(',')
                    .any(|v| v.trim().eq_ignore_ascii_case("upgrade"))
            })
}
fn validate_incoming(input: &http::Request<Option<Incoming>>) -> Result<()> {
    if input.method() == http::Method::CONNECT {
        return Err(error(
            "method_not_allowed",
            "CONNECT is not an ingress operation",
        ));
    }
    if input.headers().contains_key("upgrade") && !is_upgrade(input.headers()) {
        return Err(error("invalid_target", "unsupported upgrade protocol"));
    }
    if is_upgrade(input.headers()) {
        use base64::Engine as _;
        let valid = input.method() == http::Method::GET
            && input
                .headers()
                .get("sec-websocket-version")
                .and_then(|v| v.to_str().ok())
                == Some("13")
            && input.headers().get("sec-websocket-key").is_some_and(|key| {
                base64::engine::general_purpose::STANDARD
                    .decode(key.as_bytes())
                    .is_ok_and(|v| v.len() == 16)
            });
        if !valid {
            return Err(error("invalid_target", "invalid WebSocket handshake"));
        }
    }
    Ok(())
}
pub(super) fn incoming_body(input: Incoming, stopped: CancellationToken) -> Body {
    Body::new(
        Box::pin(
            input.into_data_stream().map(|value| {
                value.map_err(|_| error("request_cancelled", "incoming stream closed"))
            }),
        ),
        stopped,
    )
}
// Hyper Incoming has no public empty constructor. Moving its request through a
// single Option avoids substituting a synthetic, differently typed request.
pub(super) fn take_incoming(
    input: &mut http::Request<Option<Incoming>>,
    stopped: CancellationToken,
) -> Result<Body> {
    Ok(incoming_body(
        input
            .body_mut()
            .take()
            .ok_or_else(|| error("body_already_consumed", "incoming body already taken"))?,
        stopped,
    ))
}
pub(super) fn empty_wire() -> WireBody {
    http_body_util::Empty::<Bytes>::new()
        .map_err(|never| match never {})
        .boxed_unsync()
}
pub(super) fn error_response(error: &ServiceError) -> Response {
    let mut response = failure_response(error.code);
    if error.code == "websocket_rejected"
        && let Some(status) = error
            .data
            .as_ref()
            .and_then(|v| v["status"].as_u64())
            .filter(|s| (200..=599).contains(s))
    {
        response.status = status as u16;
    }
    response
}
pub(super) fn wire_response(
    response: Response,
    completion: Option<Completion>,
    head: bool,
) -> Result<http::Response<WireBody>> {
    let bodyless = head || matches!(response.status, 204 | 205 | 304);
    let body = if bodyless {
        response.body.cancel();
        drop(completion);
        empty_wire()
    } else {
        let stream = response.body.stream(streams::BODY_LIMIT)?;
        let frames =
            futures_util::stream::unfold((stream, completion), |(mut stream, guard)| async move {
                stream
                    .next()
                    .await
                    .map(|value| (value.map(Frame::data), (stream, guard)))
            });
        StreamBody::new(frames).boxed_unsync()
    };
    let mut result = http::Response::builder()
        .status(response.status)
        .body(body)
        .map_err(|_| error("invalid_response", "invalid response"))?;
    *result.headers_mut() = map(&strip(&response.headers, false))?;
    Ok(result)
}
pub(super) fn inherited_ca(path: Option<String>) -> Result<Option<String>> {
    use std::io::Read;
    let Some(path) = path.filter(|p| !p.is_empty()) else {
        return Ok(None);
    };
    let mut bytes = vec![];
    std::fs::File::open(path)
        .and_then(|file| file.take(1024 * 1024 + 1).read_to_end(&mut bytes))
        .map_err(|_| error("invalid_ca_bundle", "cannot read inherited CA bundle"))?;
    if bytes.len() > 1024 * 1024 {
        return Err(error(
            "invalid_ca_bundle",
            "inherited CA bundle exceeds bound",
        ));
    }
    let pem = String::from_utf8(bytes)
        .map_err(|_| error("invalid_ca_bundle", "invalid inherited CA encoding"))?;
    if reqwest::Certificate::from_pem_bundle(pem.as_bytes()).map_or(true, |v| v.is_empty()) {
        return Err(error("invalid_ca_bundle", "invalid inherited CA bundle"));
    }
    Ok(Some(pem))
}
fn environment_route(environment: &BTreeMap<String, String>, target: &url::Url) -> Option<Value> {
    let get = |name: &str| {
        environment
            .get(&name.to_ascii_lowercase())
            .or_else(|| environment.get(&name.to_ascii_uppercase()))
    };
    let host = target
        .host_str()
        .unwrap_or("")
        .trim_matches(['[', ']'])
        .to_ascii_lowercase();
    let port = target.port_or_known_default().unwrap_or(80);
    for value in get("NO_PROXY")
        .map(String::as_str)
        .unwrap_or("")
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|v| !v.is_empty())
    {
        if value == "*" {
            return Some(json!({"proxyUrl":null}));
        }
        let value = value.to_ascii_lowercase();
        let (pattern, wanted) = value
            .rsplit_once(':')
            .filter(|(_, p)| p.bytes().all(|c| c.is_ascii_digit()))
            .map(|(a, p)| (a, p.parse::<u16>().ok()))
            .unwrap_or((&value, None));
        if wanted.is_some_and(|p| p != port) {
            continue;
        }
        let suffix = pattern
            .trim_start_matches("*.")
            .trim_start_matches('.')
            .trim_matches(['[', ']']);
        if host == suffix
            || ((pattern.starts_with('.') || pattern.starts_with("*."))
                && host.ends_with(&format!(".{suffix}")))
        {
            return Some(json!({"proxyUrl":null}));
        }
    }
    let proxy = get(if matches!(target.scheme(), "https" | "wss") {
        "HTTPS_PROXY"
    } else {
        "HTTP_PROXY"
    })
    .or_else(|| get("ALL_PROXY"));
    if let Some(proxy) = proxy.filter(|v| !v.is_empty()) {
        return Some(json!({"proxyUrl":proxy}));
    }
    None
}
