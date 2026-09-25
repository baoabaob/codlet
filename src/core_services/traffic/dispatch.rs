//! Permissioned interceptor ordering and delegation; no application vocabulary.
use super::*;
use super::{
    engine::{Engine, Exchange, LeaseContext},
    model::*,
    streams::{self, Body, Streams},
};
use bytes::Bytes;
pub(super) struct Participant {
    pub registration: Arc<Registration>,
    pub lease: Arc<LeaseContext>,
    pub url: String,
    pub transforms: Value,
}

impl Engine {
    fn selected(&self, target: &str) -> Result<Vec<Arc<Registration>>> {
        let hub = self
            .hub
            .upgrade()
            .ok_or_else(|| error("traffic_unavailable", "authority retired"))?;
        let mut values = hub
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .registrations
            .values()
            .filter(|v| v.active.load(Ordering::Acquire) && v.matches(target))
            .cloned()
            .collect::<Vec<_>>();
        values.sort_by(|a, b| {
            a.options["priority"]
                .as_i64()
                .cmp(&b.options["priority"].as_i64())
                .then(a.plugin_id.cmp(&b.plugin_id))
                .then(a.order.cmp(&b.order))
        });
        Ok(values)
    }
    pub async fn access(
        &self,
        registration: &Arc<Registration>,
        action: &str,
        target: &str,
        exchange: &Exchange,
    ) -> Result<bool> {
        exchange.check()?;
        if !registration.active.load(Ordering::Acquire) {
            return Err(error("interceptor_retired", "interceptor retired"));
        }
        if action != "redirect" && !registration.matches(target) {
            return Err(error("permission_denied", "outside registered origins"));
        }
        let action = action.to_owned();
        let target = target.to_owned();
        let check = registration.check.clone();
        let permit = self
            .blockers
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| error("traffic_unavailable", "engine retired"))?;
        let allowed = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            check(&action, &target)
        })
        .await
        .map_err(|_| error("traffic_unavailable", "authority failed"))??;
        exchange.check()?;
        Ok(allowed)
    }
    async fn privileged(
        &self,
        registration: &Arc<Registration>,
        target: &str,
        exchange: &Exchange,
    ) -> Result<bool> {
        if !self
            .access(registration, "intercept", target, exchange)
            .await?
        {
            return Err(error("permission_denied", "interception grant denied"));
        }
        self.access(registration, "sensitiveHeaders", target, exchange)
            .await
    }
    pub async fn lease(
        self: &Arc<Self>,
        registration: &Arc<Registration>,
        target: &str,
        exchange: &Arc<Exchange>,
    ) -> Result<Arc<LeaseContext>> {
        if let Some(value) = exchange
            .leases
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&registration.key)
            .cloned()
        {
            return Ok(value);
        }
        let current = exchange.clone();
        let engine = Arc::downgrade(self);
        let key = registration.key.clone();
        let result = self
            .gateway
            .request_prepared(
                "open",
                json!({"registration":key,"url":target}),
                &exchange.stopped,
                Duration::from_secs(2),
                Some(Box::new(move |value| {
                    let id = string(value, "lease")?.to_owned();
                    let engine = engine
                        .upgrade()
                        .ok_or_else(|| error("traffic_unavailable", "engine retired"))?;
                    let context = Arc::new(LeaseContext {
                        id: id.clone(),
                        streams: Arc::new(Streams::new(current.stopped.child_token())),
                    });
                    let mut owned = current.leases.lock().unwrap_or_else(|p| p.into_inner());
                    if current.finished.load(Ordering::Acquire) || current.stopped.is_cancelled() {
                        if let Some(hub) = engine.hub.upgrade() {
                            hub.release(
                                &mut hub.state.lock().unwrap_or_else(|p| p.into_inner()),
                                &id,
                            );
                        }
                        return Err(error("stream_retired", "exchange retired during receipt"));
                    }
                    owned.insert(key, context);
                    engine
                        .leases
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .insert(id, Arc::downgrade(&current));
                    Ok(())
                })),
            )
            .await?;
        exchange.check()?;
        exchange
            .leases
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .find(|v| v.id == result["lease"])
            .cloned()
            .ok_or_else(|| error("stream_retired", "lease retired"))
    }
    pub async fn callback(
        &self,
        registration: &Registration,
        lease: &LeaseContext,
        kind: &str,
        value: Value,
        context: Value,
        exchange: &Exchange,
    ) -> Result<Value> {
        exchange.check()?;
        let timeout =
            Duration::from_millis(registration.options["timeoutMs"].as_u64().unwrap_or(1000) + 100);
        let value=self.gateway.request("relay",json!({"lease":lease.id,"operation":"invoke","payload":{"kind":kind,"value":value,"context":context}}),&exchange.stopped,timeout).await?;
        exchange.check()?;
        Ok(value)
    }
    async fn rewrite(
        self: &Arc<Self>,
        registration: &Arc<Registration>,
        request: &mut Request,
        update: &Value,
        privileged: bool,
        lease: &LeaseContext,
        exchange: &Exchange,
    ) -> Result<()> {
        fields(update, &["url", "method", "headers", "body"])?;
        let old = origin(&request.url)?;
        if let Some(value) = update.get("url") {
            request.url = bounded_string(update, "url", 8192)?.to_owned();
            url(value.as_str().unwrap_or(""))?;
        }
        if let Some(value) = update.get("method") {
            request.method = method(
                value
                    .as_str()
                    .ok_or_else(|| error("invalid_decision", "invalid method"))?,
            )?;
        }
        if let Some(value) = update.get("headers") {
            request.headers = changed_headers(value, &request.headers, privileged)?;
        }
        if let Some(value) = update.get("body") {
            request.body = streams::remote_body(
                self.gateway.clone(),
                lease.id.clone(),
                value.clone(),
                exchange.stopped.child_token(),
                streams::BODY_LIMIT,
            )?;
        }
        if origin(&request.url)? != old {
            if !self
                .access(registration, "redirect", &request.url, exchange)
                .await?
            {
                return Err(error("permission_denied", "redirect grant denied"));
            }
            request.headers = cross_origin(&request.headers);
            // Protocol names can themselves carry tokens. A redirect grant
            // must not copy these hidden credentials to a different origin.
            request.protocols.clear();
        }
        Ok(())
    }
    pub async fn intercept_http(
        self: &Arc<Self>,
        mut request: Request,
        exchange: &Arc<Exchange>,
        trust: &super::transport::Trust,
    ) -> Result<Response> {
        let selected = self.selected(&request.url)?;
        let mut participants = Vec::new();
        let mut response = None;
        for registration in selected {
            if !registration.matches(&request.url) {
                continue;
            }
            let privileged = self
                .privileged(&registration, &request.url, exchange)
                .await?;
            let lease = self.lease(&registration, &request.url, exchange).await?;
            participants.push(Participant {
                registration: registration.clone(),
                lease: lease.clone(),
                url: request.url.clone(),
                transforms: Value::Null,
            });
            if !has_handler(&registration, "request") {
                continue;
            }
            let body = lease.streams.export(request.body.clone())?;
            let value = json!({"id":request.id,"url":request.url,"method":request.method,"headers":visible(&request.headers,privileged),"body":body});
            let decision = self
                .callback(&registration, &lease, "request", value, json!({}), exchange)
                .await?;
            if decision.is_null() {
                continue;
            }
            fields(&decision, &["request", "respond", "block"])?;
            if decision.as_object().is_none_or(|v| v.len() != 1) {
                return Err(error("invalid_decision", "one decision required"));
            }
            if decision["block"] == true {
                response = Some(Response {
                    status: 403,
                    headers: vec![],
                    body: Body::bytes(Bytes::from_static(b"blocked_by_interceptor")),
                    final_url: None,
                });
                break;
            }
            if let Some(value) = decision.get("respond") {
                fields(value, &["status", "headers", "body"])?;
                let headers = if let Some(value) = value.get("headers") {
                    changed_headers(value, &vec![], privileged)?
                } else {
                    vec![]
                };
                let body = streams::remote_body(
                    self.gateway.clone(),
                    lease.id.clone(),
                    value.get("body").cloned().unwrap_or(Value::Null),
                    exchange.stopped.child_token(),
                    streams::BODY_LIMIT,
                )?;
                response = Some(Response {
                    status: status(&value["status"])?,
                    headers,
                    body,
                    final_url: None,
                });
                break;
            }
            let update = decision
                .get("request")
                .ok_or_else(|| error("invalid_decision", "request decision required"))?;
            let before = url(&request.url)?;
            self.rewrite(
                &registration,
                &mut request,
                update,
                privileged,
                &lease,
                exchange,
            )
            .await?;
            if url(&request.url)?.scheme().starts_with("ws") != before.scheme().starts_with("ws") {
                return Err(error("invalid_decision", "protocol rewrite denied"));
            }
        }
        let synthetic = response.is_some();
        let mut response = match response {
            Some(response) => response,
            None => {
                if exchange.delegate.is_some() {
                    self.delegate_http(&request, exchange).await?
                } else {
                    self.forward_http(&request, trust, exchange, streams::BODY_LIMIT)
                        .await?
                }
            }
        };
        let final_url = response.final_url.as_ref().unwrap_or(&request.url).clone();
        for participant in participants.into_iter().rev() {
            let registration = participant.registration;
            if !has_handler(&registration, "response") || !registration.matches(&final_url) {
                continue;
            }
            let privileged = self.privileged(&registration, &final_url, exchange).await?;
            let body = participant.lease.streams.export(response.body.clone())?;
            let value = json!({"status":response.status,"headers":visible(&response.headers,privileged),"body":body});
            let context = json!({"source":if synthetic {"synthetic"}else{"upstream"},"request":{"id":request.id,"url":request.url,"method":request.method}});
            let update = self
                .callback(
                    &registration,
                    &participant.lease,
                    "response",
                    value,
                    context,
                    exchange,
                )
                .await?;
            if update.is_null() {
                continue;
            }
            fields(&update, &["status", "headers", "body"])?;
            if let Some(value) = update.get("status") {
                response.status = status(value)?;
            }
            if let Some(value) = update.get("headers") {
                response.headers = changed_headers(value, &response.headers, privileged)?;
            }
            if let Some(value) = update.get("body") {
                response.body = streams::remote_body(
                    self.gateway.clone(),
                    participant.lease.id.clone(),
                    value.clone(),
                    exchange.stopped.child_token(),
                    streams::BODY_LIMIT,
                )?;
            }
        }
        Ok(response)
    }
    pub async fn intercept_ws(
        self: &Arc<Self>,
        request: &mut Request,
        exchange: &Arc<Exchange>,
    ) -> Result<Vec<Participant>> {
        let mut participants = vec![];
        for registration in self.selected(&request.url)? {
            if !registration.matches(&request.url) || !has_handler(&registration, "webSocket") {
                continue;
            }
            let privileged = self
                .privileged(&registration, &request.url, exchange)
                .await?;
            let lease = self.lease(&registration, &request.url, exchange).await?;
            let value = json!({"id":request.id,"url":request.url,"method":"GET","headers":visible(&request.headers,privileged),"protocols":if privileged {request.protocols.clone()}else{vec![]}});
            let decision = self
                .callback(
                    &registration,
                    &lease,
                    "webSocket",
                    value,
                    json!({}),
                    exchange,
                )
                .await?;
            if decision.is_null() {
                continue;
            }
            fields(&decision, &["request", "block", "transforms"])?;
            if decision["block"] == true {
                return Err(error("permission_denied", "WebSocket blocked"));
            }
            let observed = request.url.clone();
            if let Some(update) = decision.get("request") {
                fields(update, &["url", "headers"])?;
                self.rewrite(&registration, request, update, privileged, &lease, exchange)
                    .await?;
                if !url(&request.url)?.scheme().starts_with("ws") {
                    return Err(error("invalid_decision", "protocol rewrite denied"));
                }
            }
            participants.push(Participant {
                registration,
                lease,
                url: observed,
                transforms: decision.get("transforms").cloned().unwrap_or(Value::Null),
            });
        }
        Ok(participants)
    }
    pub async fn transform(
        self: &Arc<Self>,
        participants: &[Participant],
        direction: &str,
        mut data: Bytes,
        binary: bool,
        exchange: &Arc<Exchange>,
    ) -> Result<Option<(Bytes, bool)>> {
        let mut binary = binary;
        let indices = if direction == "serverToClient" {
            (0..participants.len()).rev().collect::<Vec<_>>()
        } else {
            (0..participants.len()).collect()
        };
        for index in indices {
            let part = &participants[index];
            if part.transforms[direction] != true {
                continue;
            }
            self.privileged(&part.registration, &part.url, exchange)
                .await?;
            let body = part.lease.streams.export(Body::bytes(data))?;
            let result=self.gateway.request("relay",json!({"lease":part.lease.id,"operation":"invoke","payload":{"kind":"frame","direction":direction,"value":{"binary":binary,"body":body}}}),&exchange.stopped,Duration::from_millis(part.registration.options["timeoutMs"].as_u64().unwrap_or(1000)+100)).await?;
            if result.is_null() {
                return Ok(None);
            }
            binary = result["binary"]
                .as_bool()
                .ok_or_else(|| error("invalid_frame", "invalid frame type"))?;
            data = streams::remote_body(
                self.gateway.clone(),
                part.lease.id.clone(),
                result["body"].clone(),
                exchange.stopped.child_token(),
                8 * 1024 * 1024,
            )?
            .collect(8 * 1024 * 1024)
            .await?;
            if !binary && std::str::from_utf8(&data).is_err() {
                return Err(error("invalid_frame", "invalid text frame"));
            }
        }
        Ok(Some((data, binary)))
    }
}
fn has_handler(registration: &Registration, kind: &str) -> bool {
    registration.options["handlers"]
        .as_array()
        .is_some_and(|values| values.iter().any(|v| v == kind))
}
