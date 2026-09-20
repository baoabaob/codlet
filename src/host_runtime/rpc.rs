//! Pollable outbound managed calls. All phases retain one absolute deadline,
//! one pinned lease and one bounded cancellation chain.

use crate::capabilities::{CapabilityDescriptor, host_provider_plugin_id};
use crate::cdp::CdpRequest;
use crate::renderer::BUILTIN_HOST_PROVIDER_ID;

use super::*;

pub(super) struct RawMetadata {
    pub method: String,
    pub params: Option<Value>,
    pub session: Option<String>,
    pub attachment: Option<rpc_state::RawAttachPermit>,
    pub deadline: Instant,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CallInput {
    capability: CapabilityDescriptor,
    method: String,
    #[serde(default)]
    params: Value,
    scope: Option<String>,
    #[serde(default = "default_timeout_ms")]
    timeout_ms: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TargetInput {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CloseInput {
    handle_id: String,
}

pub(super) struct Pending {
    pub id: u64,
    parent: Option<u64>,
    deadline: Instant,
    cancelled: Arc<AtomicBool>,
    kind: Option<Kind>,
}

enum Kind {
    Call {
        route: Box<RpcRoute>,
        method: String,
        params: Value,
        notification: bool,
        phase: Phase,
    },
    Target {
        session: String,
        phase: TargetPhase,
    },
}

enum Phase {
    Waiting,
    Core(crate::core_services::ServiceOperation),
    Host(HostCapabilityOperation),
    Renderer {
        request: CdpRequest,
        endpoint: Box<RendererEndpoint>,
        token: String,
    },
}

enum TargetPhase {
    Enable(QueuedCdpRequest),
    Frame(QueuedCdpRequest),
}

impl Drop for Pending {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
    }
}

impl HostOwner {
    pub(super) fn dispatch_rpc(
        &mut self,
        client: &CdpClient,
        id: u64,
        method: &str,
        params: Value,
        parent: Option<(u64, Instant)>,
    ) -> Option<Result<Value, HostRpcError>> {
        let result = (|| {
            if self.rpc_pending.len() >= MAX_PENDING {
                return Err(HostError::new(
                    "request_limit",
                    "this Host has four pending managed RPC requests",
                ));
            }
            let mut deadline = self
                .supervisor
                .as_ref()
                .and_then(|supervisor| supervisor.incoming_deadline(id))
                .ok_or_else(|| {
                    HostError::new("request_timeout", "the original Host receipt has retired")
                })?;
            if let Some((_, end)) = parent {
                deadline = deadline.min(end);
            }
            if self.observation.state == ExecutionState::Starting {
                deadline = deadline.min(self.initialize_deadline);
            }
            let cancelled = Arc::new(AtomicBool::new(false));
            let kind = match method {
                "rpc.request" | "rpc.notify" => {
                    let input: CallInput = decode_params(params).map_err(host_error)?;
                    if !valid_identifier(&input.method)
                        || input.method.len() > 256
                        || !(1..=15_000).contains(&input.timeout_ms)
                        || !payload_fits(&input.params)
                    {
                        return Err(HostError::new(
                            "invalid_params",
                            "RPC needs a valid method, bounded JSON params and timeoutMs between 1 and 15000",
                        ));
                    }
                    deadline =
                        deadline.min(Instant::now() + Duration::from_millis(input.timeout_ms));
                    let lineage = parent
                        .and_then(|(id, _)| {
                            self.capabilities
                                .iter()
                                .find(|invocation| invocation.id == id)
                        })
                        .and_then(|invocation| invocation.lineage.as_ref());
                    if parent.is_some() && lineage.is_none() {
                        return Err(HostError::new(
                            "scope_unavailable",
                            "the parent invocation has no Core RPC scope",
                        ));
                    }
                    let mut route = self.services.rpc.resolve_host(
                        &self.observation.plugin,
                        &input.capability,
                        input.scope.as_deref(),
                        lineage,
                        deadline,
                    )?;
                    route.lineage.cancellations.push(Arc::clone(&cancelled));
                    Kind::Call {
                        route: Box::new(route),
                        method: input.method,
                        params: input.params,
                        notification: method == "rpc.notify",
                        phase: Phase::Waiting,
                    }
                }
                "rpc.target" => {
                    let input: TargetInput = decode_params(params).map_err(host_error)?;
                    self.services.rpc.owned_target(
                        &self.observation.plugin.manifest.id,
                        self.observation.plugin.generation,
                        &input.session_id,
                    )?;
                    let request = client
                        .begin_raw_request("Page.enable", None, Some(&input.session_id), deadline)
                        .map_err(|error| host_error(cdp_error(error)))?;
                    Kind::Target {
                        session: input.session_id,
                        phase: TargetPhase::Enable(request),
                    }
                }
                "rpc.close" => {
                    let input: CloseInput = decode_params(params).map_err(host_error)?;
                    return self
                        .services
                        .rpc
                        .close_handle(
                            &self.observation.plugin.manifest.id,
                            self.observation.plugin.generation,
                            &input.handle_id,
                        )
                        .map(Some);
                }
                _ => {
                    return Err(HostError::new(
                        "method_not_found",
                        "Core does not expose this managed RPC method",
                    ));
                }
            };
            self.rpc_pending.push(Pending {
                id,
                parent: parent.map(|(id, _)| id),
                deadline,
                cancelled,
                kind: Some(kind),
            });
            Ok(None)
        })();
        match result {
            Ok(None) => None,
            Ok(Some(value)) => Some(Ok(value)),
            Err(error) => Some(Err(rpc_error(error))),
        }
    }

    pub(super) fn pump_rpc(&mut self, client: &CdpClient) {
        self.rpc_cancel_deliveries
            .retain_mut(|request| matches!(request.try_response(), Ok(None)));
        self.raw_metadata
            .retain(|id, _| self.pending.iter().any(|(pending, _, _)| pending == id));
        let pending = std::mem::take(&mut self.rpc_pending);
        for mut request in pending {
            let result = if !self.authority_is_live() {
                Some(Err(HostError::new(
                    "authorization_revoked",
                    "the caller Host generation's authority retired",
                )))
            } else if request.cancelled.load(Ordering::Acquire) {
                Some(Err(HostError::new(
                    "invocation_cancelled",
                    "the caller cancelled this managed request",
                )))
            } else if Instant::now() >= request.deadline {
                Some(Err(HostError::new(
                    "request_timeout",
                    "the original managed RPC deadline expired",
                )))
            } else {
                self.advance_rpc(client, &mut request)
            };
            if let Some(mut result) = result {
                if result.is_ok() && !self.authority_is_current() {
                    result = Err(HostError::new(
                        "authorization_revoked",
                        "the complete caller trust record changed before RPC delivery",
                    ));
                }
                self.retire_rpc_phase(&mut request);
                self.queue(Outbound::Reply(
                    request.id,
                    bounded_result(result.map_err(rpc_error)),
                ));
            } else {
                self.rpc_pending.push(request);
            }
        }
    }

    fn advance_rpc(
        &mut self,
        client: &CdpClient,
        pending: &mut Pending,
    ) -> Option<Result<Value, HostError>> {
        let kind = pending.kind.take().expect("pending RPC has a phase");
        match kind {
            Kind::Call {
                route,
                method,
                params,
                notification,
                mut phase,
            } => {
                if let Err(error) = self.services.rpc.validate(&route) {
                    pending.kind = Some(Kind::Call {
                        route,
                        method,
                        params,
                        notification,
                        phase,
                    });
                    return Some(Err(error));
                }
                let result = match &mut phase {
                    Phase::Waiting
                        if route.provider_id == BUILTIN_HOST_PROVIDER_ID
                            && route.capability.name.as_str()
                                == crate::core_services::CAPABILITY =>
                    {
                        let result = self
                            .services
                            .config
                            .plugin_services
                            .as_ref()
                            .ok_or_else(|| {
                                HostError::new(
                                    "runtime_unavailable",
                                    "Core services were not installed",
                                )
                            })
                            .and_then(|services| {
                                services
                                    .begin(
                                        crate::core_services::ServiceCaller {
                                            id: &route.caller.plugin_id,
                                            generation: route.caller.generation,
                                            host: true,
                                            document: None,
                                        },
                                        &method,
                                        params.clone(),
                                        pending.deadline,
                                        client.clone(),
                                    )
                                    .map_err(|e| HostError::new(e.code, e.message))
                            });
                        match result {
                            Ok(operation) => {
                                phase = Phase::Core(operation);
                                None
                            }
                            Err(error) => Some(Err(error)),
                        }
                    }
                    Phase::Core(operation) => operation
                        .try_result()
                        .map(|result| result.map_err(|e| HostError::new(e.code, e.message))),
                    Phase::Waiting if route.provider_id == BUILTIN_HOST_PROVIDER_ID => {
                        Some(self.invoke_core_rpc(&route, &method, params.clone(), notification))
                    }
                    Phase::Waiting => {
                        if let Some(owner) = host_provider_plugin_id(&route.provider_id) {
                            match self.services.rpc.host_ready(owner, route.generation) {
                                Err(error) => Some(Err(error)),
                                Ok(false) => None,
                                Ok(true) => {
                                    let client = self
                                        .services
                                        .capability_client
                                        .lock()
                                        .unwrap_or_else(|p| p.into_inner())
                                        .clone();
                                    match client
                                        .ok_or_else(|| {
                                            HostError::new(
                                                "runtime_unavailable",
                                                "the Core Host RPC transport is unavailable",
                                            )
                                        })
                                        .and_then(|client| {
                                            client.begin_routed(
                                                (*route).clone(),
                                                method.clone(),
                                                params.clone(),
                                            )
                                        }) {
                                        Ok(operation) => {
                                            phase = Phase::Host(operation);
                                            None
                                        }
                                        Err(error) => Some(Err(error)),
                                    }
                                }
                            }
                        } else {
                            match self.services.rpc.renderer_endpoint(&route) {
                                Ok(None) => None,
                                Err(error) => Some(Err(error)),
                                Ok(Some(endpoint)) => {
                                    if !endpoint.authority_is_current() {
                                        pending.kind = Some(Kind::Call {
                                            route,
                                            method,
                                            params,
                                            notification,
                                            phase,
                                        });
                                        return Some(Err(HostError::new(
                                            "authorization_revoked",
                                            "the renderer provider's complete trust record changed",
                                        )));
                                    }
                                    let invocation = self
                                        .services
                                        .rpc
                                        .begin_renderer_invocation(&endpoint, route.lineage.clone())
                                        .and_then(|token| {
                                            let expression = renderer_expression(
                                                &endpoint,
                                                &route,
                                                &token,
                                                &method,
                                                &params,
                                                notification,
                                            );
                                            match endpoint
                                                .session
                                                .until(pending.deadline)
                                                .start_evaluate_in_context(
                                                    &expression,
                                                    Some(endpoint.context_id),
                                                ) {
                                                Ok(request) => Ok((request, token)),
                                                Err(error) => {
                                                    self.services
                                                        .rpc
                                                        .end_renderer_invocation(&token);
                                                    Err(HostError::new(
                                                        "renderer_unavailable",
                                                        error.to_string(),
                                                    ))
                                                }
                                            }
                                        });
                                    match invocation {
                                        Ok((request, token)) => {
                                            phase = Phase::Renderer {
                                                request,
                                                endpoint: Box::new(endpoint),
                                                token,
                                            };
                                            None
                                        }
                                        Err(error) => Some(Err(error)),
                                    }
                                }
                            }
                        }
                    }
                    Phase::Host(operation) => operation.try_result(),
                    Phase::Renderer {
                        request, endpoint, ..
                    } => {
                        if !self.services.rpc.endpoint_is_current(endpoint) {
                            Some(Err(HostError::new(
                                "provider_unavailable",
                                "the original renderer endpoint has retired",
                            )))
                        } else {
                            match request.try_response() {
                                Ok(None) => None,
                                Ok(Some(response)) => Some(if endpoint.authority_is_current() {
                                    parse_renderer_result(response.result.unwrap_or(Value::Null))
                                } else {
                                    Err(HostError::new(
                                        "authorization_revoked",
                                        "the renderer provider's complete trust record changed before delivery",
                                    ))
                                }),
                                Err(error) => Some(Err(HostError::new(
                                    "renderer_unavailable",
                                    error.to_string(),
                                ))),
                            }
                        }
                    }
                };
                pending.kind = Some(Kind::Call {
                    route,
                    method,
                    params,
                    notification,
                    phase,
                });
                result.map(|result| {
                    result.map(|value| {
                        if notification {
                            json!({"delivered":true})
                        } else {
                            value
                        }
                    })
                })
            }
            Kind::Target { session, mut phase } => {
                let result = match &mut phase {
                    TargetPhase::Enable(request) => match request.try_response() {
                        Ok(None) => None,
                        Ok(Some(_)) => match client.begin_raw_request("Page.getFrameTree", None, Some(&session), pending.deadline) {
                            Ok(request) => { phase = TargetPhase::Frame(request); None }, Err(error) => Some(Err(host_error(cdp_error(error)))),
                        },
                        Err(error) => Some(Err(host_error(cdp_error(error)))),
                    },
                    TargetPhase::Frame(request) => match request.try_response() {
                        Ok(None) => None,
                        Ok(Some(response)) => Some(response.result.and_then(|value| value.pointer("/frameTree/frame/id").and_then(Value::as_str).map(str::to_owned)).ok_or_else(|| HostError::new("scope_unavailable", "Page.getFrameTree did not return the current top-level frame")).and_then(|frame| self.services.rpc.issue_handle(&self.observation.plugin.manifest.id, self.observation.plugin.generation, &session, frame))),
                        Err(error) => Some(Err(host_error(cdp_error(error)))),
                    },
                };
                pending.kind = Some(Kind::Target { session, phase });
                result
            }
        }
    }

    fn invoke_core_rpc(
        &self,
        route: &RpcRoute,
        method: &str,
        params: Value,
        notification: bool,
    ) -> Result<Value, HostError> {
        self.services.rpc.validate(route)?;
        match route.capability.name.as_str() {
            "codlet.runtime.ping" if method == "ping" && params.is_null() => {
                Ok(json!({"pong":true,"abi":1}))
            }
            "codlet.runtime.manage" => {
                if !self
                    .observation
                    .plugin
                    .manifest
                    .permissions
                    .contains(&Permission::RuntimeManage)
                {
                    return Err(HostError::new(
                        "permission_denied",
                        "runtime.manage must be declared and granted to this Host generation",
                    ));
                }
                if notification {
                    return Err(HostError::new(
                        "request_required",
                        "runtime management requires a response receipt",
                    ));
                }
                self.services
                    .config
                    .runtime_manage
                    .as_ref()
                    .ok_or_else(|| {
                        HostError::new(
                            "runtime_unavailable",
                            "the Core runtime management service is unavailable",
                        )
                    })?
                    .invoke(method, params)
                    .map_err(|error| HostError::new(error.code, error.message))
            }
            _ => Err(HostError::new(
                "method_not_found",
                "the Core capability does not expose this method or parameter shape",
            )),
        }
    }

    fn retire_rpc_phase(&mut self, pending: &mut Pending) {
        pending.cancelled.store(true, Ordering::Release);
        if let Some(Kind::Call {
            phase: Phase::Renderer {
                endpoint, token, ..
            },
            ..
        }) = pending.kind.take()
        {
            self.services.rpc.end_renderer_invocation(&token);
            if self.rpc_cancel_deliveries.len() < 32 {
                let expression = format!(
                    "globalThis.__codletRendererV1.__rpcCancel({}, {})",
                    serde_json::to_string(&endpoint.binding).unwrap(),
                    serde_json::to_string(&token).unwrap()
                );
                if let Ok(request) = endpoint
                    .session
                    .until(Instant::now() + Duration::from_millis(250))
                    .start_evaluate_in_context(&expression, Some(endpoint.context_id))
                {
                    self.rpc_cancel_deliveries.push(request);
                }
            }
        }
    }

    pub(super) fn cancel_rpc(&mut self, parent: Option<u64>) {
        let requests = std::mem::take(&mut self.rpc_pending);
        for mut request in requests {
            if parent.is_some() && request.parent != parent {
                self.rpc_pending.push(request);
                continue;
            }
            self.retire_rpc_phase(&mut request);
            if let Some(supervisor) = &mut self.supervisor {
                supervisor.abandon_incoming(request.id);
            }
        }
    }

    pub(super) fn cancel_managed_request(&mut self, id: u64) {
        if let Some(index) = self.rpc_pending.iter().position(|request| request.id == id) {
            let mut request = self.rpc_pending.swap_remove(index);
            self.retire_rpc_phase(&mut request);
        }
        self.cancel_os_request(id);
        self.cancel_raw_request(id);
        self.outbox
            .retain(|outbound| !matches!(outbound, Outbound::Reply(pending, _) if *pending == id));
        if let Some(supervisor) = &mut self.supervisor {
            supervisor.abandon_incoming(id);
        }
        self.child_reply_finished(id);
    }

    pub(super) fn finish_raw_metadata(
        &mut self,
        id: u64,
        result: Result<Value, HostRpcError>,
    ) -> Result<Value, HostRpcError> {
        let Some(mut metadata) = self.raw_metadata.remove(&id) else {
            return result;
        };
        let Ok(value) = &result else {
            return result;
        };
        if metadata.method == "Target.attachToTarget"
            && metadata.session.is_none()
            && metadata
                .params
                .as_ref()
                .and_then(|params| params.get("flatten"))
                == Some(&Value::Bool(true))
        {
            if let (Some(target), Some(session)) = (
                metadata
                    .params
                    .as_ref()
                    .and_then(|params| params.get("targetId"))
                    .and_then(Value::as_str),
                value
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .filter(|session| valid_identifier(session)),
            ) {
                let permit = metadata.attachment.take().ok_or_else(|| {
                    HostRpcError::new(
                        "scope_limit",
                        "this raw attachment has no Core ownership reservation",
                    )
                })?;
                self.services
                    .rpc
                    .track_raw_attach(
                        &self.observation.plugin.manifest.id,
                        self.observation.plugin.generation,
                        target,
                        session,
                        permit,
                    )
                    .map_err(rpc_error)?;
                self.undelivered_attachments.insert(id, session.into());
            } else {
                self.unconfirmed_attachment(
                    "a successful attach response omitted its valid session identity",
                );
                return Err(HostRpcError::new(
                    "cleanup_incomplete",
                    "Core cannot identify the successful raw attachment to retire it",
                ));
            }
        }
        if metadata.method == "Target.detachFromTarget"
            && let Some(session) = metadata
                .params
                .as_ref()
                .and_then(|params| params.get("sessionId"))
                .and_then(Value::as_str)
        {
            self.services.rpc.retire_raw_session(session);
        }
        result
    }
}

fn renderer_expression(
    endpoint: &RendererEndpoint,
    route: &RpcRoute,
    token: &str,
    method: &str,
    params: &Value,
    notification: bool,
) -> String {
    let request = json!({"v":1,"type":if notification {"notification"} else {"request"},"id":if notification {Value::Null} else {json!(1)},"pluginId":route.caller.plugin_id,"generation":route.caller.generation,"capability":route.capability,"method":method,"params":params,"coreInvocation":{"token":token,"caller":route.caller,"scope":route.lineage.scope,"depth":route.lineage.depth,"remainingMs":route.lineage.deadline.saturating_duration_since(Instant::now()).as_millis()}});
    let mut request = request;
    if notification {
        request.as_object_mut().unwrap().remove("id");
    }
    format!(
        "globalThis.__codletRendererV1.__rpcInvoke({}, {})",
        serde_json::to_string(&endpoint.binding).unwrap(),
        serde_json::to_string(&request).unwrap()
    )
}

fn parse_renderer_result(value: Value) -> Result<Value, HostError> {
    if value.get("exceptionDetails").is_some() {
        return Err(HostError::new(
            "provider_error",
            "renderer Runtime.evaluate reported exceptionDetails",
        ));
    }
    let value = value.pointer("/result/value").ok_or_else(|| {
        HostError::new("provider_error", "renderer endpoint did not return a value")
    })?;
    if value.get("ok") == Some(&Value::Bool(true)) {
        let value = value.get("value").cloned().ok_or_else(|| {
            HostError::new("provider_error", "renderer endpoint omitted its result")
        })?;
        if payload_fits(&value) {
            Ok(value)
        } else {
            Err(HostError::new(
                "response_too_large",
                "renderer result exceeds the JSON payload bound",
            ))
        }
    } else {
        let code = match value.get("code").and_then(Value::as_str) {
            Some("method_not_found") => "method_not_found",
            Some("invocation_cancelled") => "invocation_cancelled",
            Some("request_timeout") => "request_timeout",
            Some("request_limit") => "request_limit",
            _ => "provider_error",
        };
        Err(HostError::new(
            code,
            value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("renderer provider failed")
                .chars()
                .take(4096)
                .collect::<String>(),
        ))
    }
}

fn rpc_error(error: HostError) -> HostRpcError {
    HostRpcError::new(error.code, error.message)
}
fn host_error(error: HostRpcError) -> HostError {
    let code = match error.code.as_str() {
        "permission_denied" => "permission_denied",
        "request_timeout" => "request_timeout",
        "request_limit" => "request_limit",
        "cdp_error" => "cdp_error",
        "invalid_params" => "invalid_params",
        _ => "rpc_error",
    };
    HostError::new(code, error.message)
}
