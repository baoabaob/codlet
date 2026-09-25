use super::streams::Body;
use super::*;
use bytes::Bytes;
use http::{HeaderMap, HeaderName, HeaderValue};
pub(super) type Headers = Vec<(String, String)>;
pub(super) struct Request {
    pub id: String,
    pub url: String,
    pub method: String,
    pub headers: Headers,
    pub body: Body,
    pub protocols: Vec<String>,
}
pub(super) struct Response {
    pub status: u16,
    pub headers: Headers,
    pub body: Body,
    pub final_url: Option<String>,
}
pub(super) fn pairs(value: &Value) -> Result<Headers> {
    let array = value
        .as_array()
        .filter(|v| v.len() <= 128)
        .ok_or_else(|| error("invalid_headers", "bounded header pairs required"))?;
    let mut bytes = 0;
    array
        .iter()
        .map(|value| {
            let pair = value
                .as_array()
                .filter(|p| p.len() == 2)
                .ok_or_else(|| error("invalid_headers", "header pair required"))?;
            let name = pair[0]
                .as_str()
                .ok_or_else(|| error("invalid_headers", "invalid header name"))?;
            let value = pair[1]
                .as_str()
                .ok_or_else(|| error("invalid_headers", "invalid header value"))?;
            HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| error("invalid_headers", "invalid header name"))?;
            header_value(value)?;
            bytes += name.len() + value.len();
            if bytes > 32 * 1024 {
                return Err(error("invalid_headers", "headers exceed bound"));
            }
            Ok((name.to_owned(), value.to_owned()))
        })
        .collect()
}
pub(super) fn map(headers: &Headers) -> Result<HeaderMap> {
    let mut map = HeaderMap::new();
    for (name, value) in headers {
        map.append(
            HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| error("invalid_headers", "invalid header"))?,
            header_value(value)?,
        );
    }
    Ok(map)
}
pub(super) fn from_map(headers: &HeaderMap) -> Result<Headers> {
    headers
        .iter()
        .map(|(name, value)| {
            Ok((
                name.as_str().to_owned(),
                value
                    .as_bytes()
                    .iter()
                    .map(|byte| char::from(*byte))
                    .collect(),
            ))
        })
        .collect()
}
fn header_value(value: &str) -> Result<HeaderValue> {
    let bytes = value
        .chars()
        .map(|c| {
            u8::try_from(c as u32)
                .map_err(|_| error("invalid_headers", "header value is not Latin-1"))
        })
        .collect::<Result<Vec<_>>>()?;
    HeaderValue::from_bytes(&bytes).map_err(|_| error("invalid_headers", "invalid header value"))
}
pub(super) fn sensitive(name: &str) -> bool {
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "accept"
            | "accept-encoding"
            | "accept-language"
            | "content-type"
            | "content-encoding"
            | "content-length"
            | "cache-control"
            | "user-agent"
    )
}
pub(super) fn visible(headers: &Headers, privileged: bool) -> Headers {
    headers
        .iter()
        .filter(|(name, _)| privileged || !sensitive(name))
        .cloned()
        .collect()
}
pub(super) fn changed_headers(
    value: &Value,
    previous: &Headers,
    privileged: bool,
) -> Result<Headers> {
    let mut next = pairs(value)?;
    if !privileged {
        if next.iter().any(|(name, _)| sensitive(name)) {
            return Err(error("permission_denied", "sensitive header change denied"));
        }
        next.extend(previous.iter().filter(|(name, _)| sensitive(name)).cloned());
    }
    Ok(next)
}
pub(super) fn framing(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "proxy-connection"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "content-length"
    )
}
pub(super) fn strip(headers: &Headers, outbound: bool) -> Headers {
    let nominated = headers
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("connection"))
        .flat_map(|(_, value)| {
            value
                .split(',')
                .map(|part| part.trim().to_ascii_lowercase())
        })
        .collect::<Vec<_>>();
    headers
        .iter()
        .filter(|(name, _)| {
            !framing(name)
                && !nominated.contains(&name.to_ascii_lowercase())
                && !(outbound
                    && (name.eq_ignore_ascii_case("host")
                        || name.to_ascii_lowercase().starts_with("sec-websocket-")))
        })
        .cloned()
        .collect()
}
pub(super) fn cross_origin(headers: &Headers) -> Headers {
    headers
        .iter()
        .filter(|(name, _)| {
            matches!(
                name.to_ascii_lowercase().as_str(),
                "accept" | "content-type" | "content-encoding"
            )
        })
        .cloned()
        .collect()
}
pub(super) fn url(value: &str) -> Result<url::Url> {
    let target = url::Url::parse(value).map_err(|_| error("invalid_target", "invalid URL"))?;
    if value.len() > 8192
        || !matches!(target.scheme(), "http" | "https" | "ws" | "wss")
        || !target.username().is_empty()
        || target.password().is_some()
        || target.fragment().is_some()
    {
        return Err(error("invalid_target", "invalid URL"));
    }
    Ok(target)
}
pub(super) fn origin(value: &str) -> Result<String> {
    let mut url = url(value)?;
    if url.scheme() == "ws" {
        let _ = url.set_scheme("http");
    } else if url.scheme() == "wss" {
        let _ = url.set_scheme("https");
    }
    Ok(url.origin().ascii_serialization())
}
pub(super) fn method(value: &str) -> Result<String> {
    http::Method::from_bytes(value.as_bytes())
        .map_err(|_| error("invalid_target", "invalid method"))?;
    if value.len() > 32 || value.eq_ignore_ascii_case("CONNECT") {
        return Err(error("invalid_target", "invalid method"));
    }
    Ok(value.to_owned())
}
pub(super) fn status(value: &Value) -> Result<u16> {
    value
        .as_u64()
        .filter(|n| (200..=599).contains(n))
        .map(|n| n as u16)
        .ok_or_else(|| error("invalid_response", "invalid response status"))
}
pub(super) fn fields(value: &Value, allowed: &[&str]) -> Result<()> {
    if value
        .as_object()
        .is_none_or(|v| v.keys().any(|key| !allowed.contains(&key.as_str())))
    {
        return Err(error("invalid_decision", "unknown decision field"));
    }
    Ok(())
}
pub(super) fn failure_response(code: &'static str) -> Response {
    let status = match code {
        "permission_denied" | "authorization_revoked" | "policy_denied" => 403,
        "body_too_large" => 413,
        "handler_timeout" | "traffic_timeout" => 504,
        "resource_limit" | "interceptor_busy" => 503,
        "target_not_found" => 404,
        "method_not_allowed" => 405,
        "invalid_target" => 400,
        _ => 502,
    };
    Response {
        status,
        headers: vec![("content-type".into(), "text/plain; charset=utf-8".into())],
        body: Body::bytes(Bytes::from_static(code.as_bytes())),
        final_url: None,
    }
}
