use super::*;
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use sha2::{Digest, Sha256};
pub(super) mod proxy;

#[derive(Clone, Default)]
pub(super) struct Network(Arc<Mutex<State>>);
#[derive(Default)]
struct State {
    profiles: BTreeMap<String, Profile>,
    status: BTreeMap<String, VecDeque<Value>>,
}
#[derive(Clone)]
struct Profile {
    owner: String,
    proxy: Value,
    ca_pem: Option<String>,
    revision: String,
}
impl Network {
    pub fn invoke(
        &self,
        p: &Principal,
        method: &str,
        params: Value,
        persistent: &PluginServices,
        check: &dyn Fn() -> Result<()>,
    ) -> Result<Value> {
        match method {
            "profiles" => Ok(
                json!({"proxyModes":["direct","system","explicit"],"proxyProtocols":["http","https"],"trustSources":["system","bundled","additionalPem"],"profiles":self.list(p)}),
            ),
            "createProfile" => {
                let value = params.get("proxy").cloned().unwrap_or(json!("direct"));
                if !matches!(value.as_str(), Some("direct" | "system")) {
                    let proxy_url = string(&value, "url")?;
                    validate_proxy(proxy_url)?;
                    // Explicit proxies are network destinations in their own right.
                    authorize_url(p, proxy_url)?;
                }
                let ca = params
                    .get("caPem")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                if let Some(ca) = &ca
                    && (ca.len() > 128 * 1024
                        || reqwest::Certificate::from_pem_bundle(ca.as_bytes())
                            .map_or(true, |v| v.is_empty()))
                {
                    return Err(error(
                        "invalid_ca",
                        "caPem must contain a bounded PEM certificate bundle",
                    ));
                }
                let id = super::files::token("network")?;
                let revision = format!(
                    "{:x}",
                    Sha256::digest(serde_json::to_vec(&json!({"proxy":value,"ca":ca})).unwrap())
                );
                let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
                if state.profiles.len() >= 128
                    || state
                        .profiles
                        .values()
                        .filter(|v| v.owner == owner_key(p))
                        .count()
                        >= 8
                {
                    return Err(error("resource_limit", "network profile limit reached"));
                }
                state.profiles.insert(
                    id.clone(),
                    Profile {
                        owner: owner_key(p),
                        proxy: value,
                        ca_pem: ca,
                        revision: revision.clone(),
                    },
                );
                Ok(json!({"profile":id,"revision":revision}))
            }
            "closeProfile" => {
                let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
                let id = string(&params, "profile")?;
                if !state
                    .profiles
                    .get(id)
                    .is_some_and(|v| v.owner == owner_key(p))
                {
                    return Err(error("resource_closed", "network profile is unavailable"));
                }
                state.profiles.remove(id);
                Ok(json!({"closed":true}))
            }
            "resolve" => {
                let url = authorized_url(p, string(&params, "url")?)?;
                self.resolve(p, &params, &url)
            }
            "status" => Ok(
                json!({"events":self.0.lock().unwrap_or_else(|p|p.into_inner()).status.get(&owner_key(p)).cloned().unwrap_or_default()}),
            ),
            "fetch" => {
                let target = authorized_url(p, string(&params, "url")?)?;
                let route = self.resolve(p, &params, &target)?;
                check()?;
                let start = Instant::now();
                let outcome = self.fetch(p, &params, &target, &route, persistent, check);
                let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
                let history = state.status.entry(owner_key(p)).or_default();
                history.push_back(json!({"time":now_ms(),"origin":target.origin().ascii_serialization(),"elapsedMs":start.elapsed().as_millis(),"profileRevision":route["revision"],"proxy":route["source"],"phase":if outcome.is_ok(){"complete"}else{"failed"},"code":outcome.as_ref().err().map(|e|e.code)}));
                if history.len() > 64 {
                    history.pop_front();
                }
                outcome
            }
            _ => Err(error("method_not_found", "unknown network service method")),
        }
    }
    fn resolve(&self, p: &Principal, params: &Value, target: &url::Url) -> Result<Value> {
        let profile = if let Some(id) = params.get("profile").and_then(Value::as_str) {
            self.0
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .profiles
                .get(id)
                .filter(|v| v.owner == owner_key(p))
                .cloned()
                .ok_or_else(|| error("resource_closed", "network profile is unavailable"))?
        } else {
            Profile {
                owner: owner_key(p),
                proxy: params.get("proxy").cloned().unwrap_or(json!("direct")),
                ca_pem: None,
                revision: "direct-default".into(),
            }
        };
        let (proxy, source) = match profile.proxy.as_str() {
            Some("direct") => (None, "direct"),
            Some("system") => (proxy::system_proxy(target)?, "system"),
            None => {
                let value = string(&profile.proxy, "url")?;
                validate_proxy(value)?;
                authorize_url(p, value)?;
                (Some(value.to_owned()), "explicit")
            }
            _ => {
                return Err(error(
                    "invalid_params",
                    "proxy must be direct, system, or an explicit proxy object",
                ));
            }
        };
        if let Some(proxy) = &proxy {
            authorize_url(p, proxy)?;
        }
        Ok(
            json!({"proxyUrl":proxy,"source":source,"revision":profile.revision,"caPem":profile.ca_pem,"trust":"system+bundled","proxyCredentialRef":profile.proxy.get("credentialRef")}),
        )
    }
    fn fetch(
        &self,
        p: &Principal,
        params: &Value,
        target: &url::Url,
        route: &Value,
        persistent: &PluginServices,
        check: &dyn Fn() -> Result<()>,
    ) -> Result<Value> {
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(10));
        if let Some(proxy) = route["proxyUrl"].as_str() {
            let mut setting = reqwest::Proxy::all(proxy)
                .map_err(|_| error("invalid_proxy", "proxy URL is invalid"))?;
            if let Some(reference) = route["proxyCredentialRef"].as_str() {
                require_secret_grant(p)?;
                let secret = persistent.resolve_credential(
                    &p.owner,
                    reference,
                    &url::Url::parse(proxy)
                        .unwrap()
                        .origin()
                        .ascii_serialization(),
                )?;
                let (user, password) = secret.as_str().split_once(':').ok_or_else(|| {
                    error(
                        "invalid_credential",
                        "proxy credential must use username:password",
                    )
                })?;
                setting = setting.basic_auth(user, password);
            }
            builder = builder.proxy(setting);
        }
        if let Some(pem) = route["caPem"].as_str() {
            for certificate in reqwest::Certificate::from_pem_bundle(pem.as_bytes())
                .map_err(|_| error("invalid_ca", "additional CA is invalid"))?
            {
                builder = builder.add_root_certificate(certificate);
            }
        }
        let client = builder
            .build()
            .map_err(|_| error("network_unavailable", "cannot initialize HTTP client"))?;
        let method = params
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or("GET");
        let method = reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|_| error("invalid_params", "invalid HTTP method"))?;
        if method == reqwest::Method::CONNECT || method == reqwest::Method::TRACE {
            return Err(error(
                "invalid_params",
                "CONNECT and TRACE are not public fetch methods",
            ));
        }
        let mut request = client.request(method, target.clone());
        if let Some(headers) = params.get("headers") {
            let headers = headers
                .as_array()
                .filter(|v| v.len() <= 64)
                .ok_or_else(|| error("invalid_params", "headers must be at most 64 pairs"))?;
            for header in headers {
                let pair = header
                    .as_array()
                    .filter(|v| v.len() == 2)
                    .ok_or_else(|| error("invalid_params", "invalid header pair"))?;
                let name = pair[0]
                    .as_str()
                    .ok_or_else(|| error("invalid_params", "invalid header name"))?;
                let value = pair[1]
                    .as_str()
                    .filter(|v| v.len() <= 8192)
                    .ok_or_else(|| error("invalid_params", "invalid header value"))?;
                if matches!(
                    name.to_ascii_lowercase().as_str(),
                    "host"
                        | "connection"
                        | "proxy-authorization"
                        | "proxy-authenticate"
                        | "transfer-encoding"
                        | "content-length"
                        | "upgrade"
                        | "te"
                        | "trailer"
                ) {
                    return Err(error(
                        "invalid_params",
                        "hop-by-hop or framing headers are Core-owned",
                    ));
                }
                request = request.header(name, value);
            }
        }
        if let Some(reference) = params.get("credentialRef").and_then(Value::as_str) {
            require_secret_grant(p)?;
            let secret = persistent.resolve_credential(
                &p.owner,
                reference,
                &target.origin().ascii_serialization(),
            )?;
            request = request.bearer_auth(secret.as_str());
        }
        if let Some(data) = params.get("data").and_then(Value::as_str) {
            let data = BASE64
                .decode(data)
                .map_err(|_| error("invalid_params", "request data must be base64"))?;
            if data.len() > 256 * 1024 {
                return Err(error("resource_limit", "fetch body exceeds 256 KiB"));
            }
            request = request.body(data);
        }
        let maximum = params
            .get("maxBytes")
            .and_then(Value::as_u64)
            .unwrap_or(64 * 1024)
            .min(256 * 1024) as usize;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| error("network_unavailable", "cannot initialize network worker"))?;
        runtime.block_on(async {
            let mut response=checked_network(request.send(),check).await?;
            check()?;
            let status=response.status().as_u16();
            let headers=response.headers().iter().map(|(name,value)|json!([name.as_str(),value.to_str().unwrap_or("")])).collect::<Vec<_>>();
            let mut bytes=Vec::new();
            while let Some(chunk)=checked_network(response.chunk(),check).await? {check()?;if bytes.len()+chunk.len()>maximum{return Err(error("response_too_large","fetch response exceeds maxBytes; use a streaming traffic channel"))}bytes.extend_from_slice(&chunk);}
            Ok(json!({"status":status,"headers":headers,"data":BASE64.encode(bytes),"encoding":"base64","profileRevision":route["revision"]}))
        })
    }
    pub fn retire(&self, p: &Principal) {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        state.profiles.retain(|_, v| v.owner != owner_key(p));
        state.status.remove(&owner_key(p));
    }
    pub fn list(&self, p: &Principal) -> Value {
        json!(self.0.lock().unwrap_or_else(|p|p.into_inner()).profiles.iter().filter(|(_,v)|v.owner==owner_key(p)).map(|(id,v)|json!({"profile":id,"revision":v.revision,"proxy":v.proxy.as_str().unwrap_or("explicit"),"additionalCa":v.ca_pem.is_some()})).collect::<Vec<_>>())
    }
}
fn validate_proxy(value: &str) -> Result<()> {
    let url =
        url::Url::parse(value).map_err(|_| error("invalid_proxy", "proxy URL must be HTTP(S)"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(error(
            "invalid_proxy",
            "proxy must be an HTTP(S) origin without inline credentials",
        ));
    }
    Ok(())
}
fn authorized_url(p: &Principal, value: &str) -> Result<url::Url> {
    let mut url = url::Url::parse(value)
        .map_err(|_| error("invalid_url", "absolute HTTP(S)/WS(S) URL required"))?;
    if url.scheme() == "ws" {
        let _ = url.set_scheme("http");
    } else if url.scheme() == "wss" {
        let _ = url.set_scheme("https");
    }
    authorize_url(p, url.as_str())?;
    Ok(url)
}
pub(super) fn authorize_url(p: &Principal, value: &str) -> Result<()> {
    let url = url::Url::parse(value)
        .map_err(|_| error("invalid_url", "absolute HTTP(S) URL required"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(error(
            "invalid_url",
            "URL must be HTTP(S), without inline credentials or fragment",
        ));
    }
    if !p
        .plugin
        .manifest
        .permissions
        .contains(&Permission::HostNetwork)
        || !p.plugin.authorization.as_ref().is_some_and(|a| {
            a.grants.contains(&Permission::HostNetwork)
                && a.broker_policy
                    .network_origins
                    .contains(&url.origin().ascii_serialization())
        })
    {
        return Err(error(
            "policy_denied",
            "destination origin is not explicitly granted",
        ));
    }
    Ok(())
}
fn require_secret_grant(p: &Principal) -> Result<()> {
    if !p
        .plugin
        .manifest
        .permissions
        .contains(&Permission::CoreCredentialsUse)
        || !p
            .plugin
            .authorization
            .as_ref()
            .is_some_and(|a| a.grants.contains(&Permission::CoreCredentialsUse))
    {
        return Err(error(
            "permission_denied",
            "core.credentials.use must be declared and granted",
        ));
    }
    Ok(())
}
async fn checked_network<T>(
    future: impl std::future::Future<Output = std::result::Result<T, reqwest::Error>>,
    check: &dyn Fn() -> Result<()>,
) -> Result<T> {
    tokio::pin!(future);
    let mut interval = tokio::time::interval(Duration::from_millis(25));
    loop {
        tokio::select! { result=&mut future=>return result.map_err(network_error), _=interval.tick()=>check()?, }
    }
}
fn network_error(e: reqwest::Error) -> ServiceError {
    error(
        if e.is_timeout() {
            "network_timeout"
        } else if e.is_connect() {
            "network_connect_failed"
        } else {
            "network_failed"
        },
        "the network operation failed; check destination, proxy and certificate trust",
    )
}
