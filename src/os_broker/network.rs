use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::{Value, json};

use super::{CHECK_INTERVAL, OsBrokerError, RequestGuard, Result, byte_limit, decode, invalid};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Fetch {
    url: String,
    method: Option<String>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    max_bytes: Option<usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthorizeForward {
    url: String,
}

pub(super) fn authorize_channel(params: Value, guard: &RequestGuard) -> Result<Value> {
    let _: Empty = decode(params)?;
    guard.check_full()?;
    Ok(json!({
        "transport":"http-loopback",
        "coverage":"explicit-endpoint"
    }))
}

pub(super) fn authorize_forward(params: Value, guard: &RequestGuard) -> Result<Value> {
    let request: AuthorizeForward = decode(params)?;
    guard.check_full()?;
    let (url, origin) = authorized_url(&request.url, guard, true)?;
    Ok(json!({"url":url.as_str(),"origin":origin}))
}

pub(super) async fn fetch(
    client: &reqwest::Client,
    params: Value,
    guard: &RequestGuard,
) -> Result<Value> {
    let request: Fetch = decode(params)?;
    let limit = byte_limit(request.max_bytes)?;
    let (url, _) = authorized_url(&request.url, guard, false)?;
    let method = match request.method.as_deref().unwrap_or("GET") {
        "GET" => reqwest::Method::GET,
        "HEAD" => reqwest::Method::HEAD,
        _ => return Err(invalid("fetch supports GET or HEAD")),
    };
    let head = method == reqwest::Method::HEAD;
    if request.headers.len() > 32
        || request
            .headers
            .iter()
            .map(|(name, value)| name.len() + value.len())
            .sum::<usize>()
            > 16 * 1024
    {
        return Err(invalid("fetch request headers exceed their bound"));
    }
    let mut builder = client.request(method, url.clone()).timeout(
        guard
            .deadline
            .saturating_duration_since(std::time::Instant::now()),
    );
    for (name, value) in request.headers {
        if matches!(
            name.to_ascii_lowercase().as_str(),
            "host"
                | "connection"
                | "proxy-authorization"
                | "proxy-connection"
                | "upgrade"
                | "transfer-encoding"
                | "content-length"
        ) {
            return Err(invalid(
                "fetch does not accept routing, proxy or hop-by-hop header overrides",
            ));
        }
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| invalid("invalid fetch header name"))?;
        let value = reqwest::header::HeaderValue::from_str(&value)
            .map_err(|_| invalid("invalid fetch header value"))?;
        builder = builder.header(name, value);
    }
    guard.check_full()?;
    let work = async {
        let mut response = builder.send().await.map_err(network_error)?;
        if !head
            && response
                .content_length()
                .is_some_and(|bytes| bytes > limit as u64)
        {
            return Err(too_large());
        }
        let status = response.status().as_u16();
        let mut headers = BTreeMap::new();
        let mut header_bytes = 0;
        for (name, value) in response.headers() {
            let value = value.to_str().map_err(|_| {
                OsBrokerError::new("invalid_response", "response headers must be text")
            })?;
            header_bytes += name.as_str().len() + value.len();
            if headers.len() >= 64 || header_bytes > 16 * 1024 {
                return Err(OsBrokerError::new(
                    "response_too_large",
                    "response headers exceed their bound",
                ));
            }
            headers.insert(name.as_str().to_owned(), value.to_owned());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(network_error)? {
            guard.check()?;
            if bytes.len() + chunk.len() > limit {
                return Err(too_large());
            }
            bytes.extend_from_slice(&chunk);
        }
        let body = String::from_utf8(bytes)
            .map_err(|_| OsBrokerError::new("invalid_utf8", "fetch body is not UTF-8 text"))?;
        Ok(
            json!({"status":status,"url":url.as_str(),"headers":headers,"bytes":body.len(),"body":body}),
        )
    };
    tokio::pin!(work);
    let mut interval = tokio::time::interval(CHECK_INTERVAL);
    loop {
        tokio::select! {
            result = &mut work => return result,
            _ = interval.tick() => guard.check()?,
        }
    }
}

fn authorized_url(
    url: &str,
    guard: &RequestGuard,
    allow_websocket: bool,
) -> Result<(reqwest::Url, String)> {
    if url.len() > 8192 {
        return Err(invalid("network URL exceeds 8192 bytes"));
    }
    let url = reqwest::Url::parse(url)
        .map_err(|_| invalid("network access requires an absolute HTTP(S) URL"))?;
    if !(matches!(url.scheme(), "http" | "https")
        || allow_websocket && matches!(url.scheme(), "ws" | "wss"))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid(
            "network URL must use HTTP(S) or an allowed WebSocket scheme, without credentials or fragment",
        ));
    }
    let mut policy_url = url.clone();
    if url.scheme() == "ws" {
        policy_url
            .set_scheme("http")
            .expect("HTTP and WS schemes are replaceable");
    } else if url.scheme() == "wss" {
        policy_url
            .set_scheme("https")
            .expect("HTTPS and WSS schemes are replaceable");
    }
    let origin = policy_url.origin().ascii_serialization();
    if !guard
        .authorization
        .0
        .registration
        .broker_policy
        .network_origins
        .contains(&origin)
    {
        return Err(OsBrokerError::new(
            "policy_denied",
            "URL origin was not explicitly granted",
        ));
    }
    Ok((url, origin))
}

fn network_error(error: reqwest::Error) -> OsBrokerError {
    if error.is_timeout() {
        super::expired()
    } else {
        OsBrokerError::new("network_error", error.without_url().to_string())
    }
}
fn too_large() -> OsBrokerError {
    OsBrokerError::new(
        "response_too_large",
        "HTTP response exceeds the requested byte limit",
    )
}
