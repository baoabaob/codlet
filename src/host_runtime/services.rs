//! Services are installed before the first initialize request. Ordinary owner
//! authority and the finite cleanup phase deliberately have separate checks.

use std::collections::BTreeMap;

use crate::os_broker::{OsAuthorization, OsBrokerClient, OsBrokerOperation};
use crate::runtime_manage::RuntimeManageService;

use super::*;

#[derive(Clone, Default)]
pub struct HostCoreServices {
    pub os_broker: Option<OsBrokerClient>,
    pub runtime_manage: Option<RuntimeManageService>,
    pub plugin_services: Option<crate::core_services::SharedCoreServices>,
}

#[derive(Clone, Default)]
pub(super) struct CoreServices {
    pub config: HostCoreServices,
    pub rpc: rpc_state::CoreRpcShared,
    pub capability_client: Arc<Mutex<Option<HostCapabilityClient>>>,
    invalidated: Arc<Mutex<BTreeMap<String, u64>>>,
}

impl CoreServices {
    pub fn new(config: HostCoreServices) -> Self {
        Self {
            config,
            ..Self::default()
        }
    }

    pub fn invalidate(&self, id: &str, generation: u64) {
        self.invalidated
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id.into(), generation);
        self.rpc.retire_plugin(id, generation);
        self.rpc.retire_host_scopes(id, generation);
        if let Some(broker) = &self.config.os_broker {
            broker.revoke_owner(id, generation);
        }
        if let Some(services) = &self.config.plugin_services {
            services.retire(id, generation);
        }
    }

    fn invalidated(&self, id: &str, generation: u64) -> bool {
        self.invalidated
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
            .is_some_and(|current| generation <= *current)
    }
}

pub(super) struct OsPending {
    id: u64,
    operation: OsBrokerOperation,
    parent: Option<u64>,
}

pub(super) struct ScopeCleanup {
    session_id: String,
    request: QueuedCdpRequest,
}

impl HostRuntime {
    /// The caller passes the complete enabled catalog for cross-entry graph
    /// validation; only entries containing host source create a process here.
    pub fn start_with_services(
        all_enabled_plugins: Vec<LoadedPlugin>,
        client: CdpClient,
        runtime: Option<JsRuntime>,
        services: HostCoreServices,
    ) -> Result<Self, HostError> {
        crate::catalog::capability_graph(&all_enabled_plugins)
            .and_then(|graph| graph.resolve_activation_order())
            .map_err(|error| HostError::new("dependency_conflict", error.to_string()))?;
        let services = CoreServices::new(services);
        if let Some(plugin_services) = &services.config.plugin_services {
            plugin_services
                .register(&all_enabled_plugins)
                .map_err(|error| HostError::new(error.code, error.message))?;
        }
        services.rpc.register_plugins(&all_enabled_plugins)?;
        let plugins = all_enabled_plugins
            .into_iter()
            .filter(|plugin| plugin.manifest.host.is_some())
            .collect::<Vec<_>>();
        Self::validate_plugins(&plugins)?;
        lifecycle::launch(plugins, client, runtime, services)
    }

    pub fn revoke_authorization(
        &self,
        plugin_id: &str,
        expected_generation: u64,
    ) -> Result<(), HostError> {
        let current = self
            .published
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .observations
            .iter()
            .find(|observation| observation.plugin.manifest.id == plugin_id)
            .map(|observation| observation.plugin.generation);
        if current != Some(expected_generation) {
            return Err(HostError::new(
                "stale_generation",
                "authorization revocation must name the currently owned Host generation",
            ));
        }
        self.services.invalidate(plugin_id, expected_generation);
        Ok(())
    }
}

impl HostOwner {
    pub(super) fn authorize_services(&mut self, services: CoreServices) -> Result<(), HostError> {
        self.services = services;
        self.services_active = true;
        if let Some(services) = &self.services.config.plugin_services {
            services
                .register(std::slice::from_ref(&self.observation.plugin))
                .map_err(|error| HostError::new(error.code, error.message))?;
        }
        self.services
            .rpc
            .register_plugins(std::slice::from_ref(&self.observation.plugin))?;
        self.authorization = self
            .services
            .config
            .os_broker
            .as_ref()
            .map(|broker| broker.authorize(&self.observation.plugin))
            .transpose()
            .map_err(|error| HostError::new(error.code, error.message))?;
        Ok(())
    }

    pub(super) fn authority_is_current(&self) -> bool {
        !self.services.invalidated(
            &self.observation.plugin.manifest.id,
            self.observation.plugin.generation,
        ) && self
            .authorization
            .as_ref()
            .is_none_or(OsAuthorization::is_current)
    }

    pub(super) fn authority_is_live(&self) -> bool {
        !self.services.invalidated(
            &self.observation.plugin.manifest.id,
            self.observation.plugin.generation,
        ) && self
            .authorization
            .as_ref()
            .is_none_or(OsAuthorization::is_live)
    }

    pub(super) fn cleanup_raw_is_current(&self) -> bool {
        self.observation
            .plugin
            .manifest
            .permissions
            .contains(&Permission::CdpRaw)
            && self.authorization.as_ref().map_or_else(
                || {
                    !self.services.invalidated(
                        &self.observation.plugin.manifest.id,
                        self.observation.plugin.generation,
                    )
                },
                |authorization| authorization.cleanup_permission_current(Permission::CdpRaw),
            )
    }

    pub(super) fn dispatch_os(
        &mut self,
        id: u64,
        method: &str,
        params: Value,
        parent: Option<(u64, Instant)>,
    ) -> Option<Result<Value, HostRpcError>> {
        let result = (|| {
            if self.os_pending.len() >= MAX_PENDING {
                return Err(HostRpcError::new(
                    "request_limit",
                    "this Host has four pending OS broker requests",
                ));
            }
            let broker = self.services.config.os_broker.as_ref().ok_or_else(|| {
                HostRpcError::new("broker_unavailable", "Core OS services were not installed")
            })?;
            let authorization = self.authorization.as_ref().ok_or_else(|| {
                HostRpcError::new(
                    "permission_denied",
                    "this generation has no OS broker authorization",
                )
            })?;
            let mut deadline = self
                .supervisor
                .as_ref()
                .and_then(|supervisor| supervisor.incoming_deadline(id))
                .ok_or_else(|| {
                    HostRpcError::new("request_timeout", "the original Host request has retired")
                })?;
            if let Some((_, parent_deadline)) = parent {
                deadline = deadline.min(parent_deadline);
            }
            if self.observation.state == ExecutionState::Starting {
                deadline = deadline.min(self.initialize_deadline);
            }
            let operation = broker
                .begin_request(authorization, method, params, deadline)
                .map_err(|error| HostRpcError::new(error.code, error.message))?;
            self.os_pending.push(OsPending {
                id,
                operation,
                parent: parent.map(|(id, _)| id),
            });
            Ok(())
        })();
        result.err().map(Err)
    }

    pub(super) fn pump_os(&mut self) {
        let mut index = 0;
        while index < self.os_pending.len() {
            let Some(result) = self.os_pending[index].operation.try_result() else {
                index += 1;
                continue;
            };
            let pending = self.os_pending.swap_remove(index);
            let result = result.map_err(|error| HostRpcError::new(error.code, error.message));
            self.queue(Outbound::Reply(pending.id, bounded_result(result)));
        }
        let mut index = 0;
        while index < self.retiring_os.len() {
            match self.retiring_os[index].try_result() {
                None => index += 1,
                Some(result) => {
                    self.retiring_os.swap_remove(index);
                    if let Err(error) = result
                        && error.code == "cleanup_incomplete"
                    {
                        self.cleanup_quarantined = true;
                        self.cleanup_error = Some(error.to_string());
                    }
                }
            }
        }
    }

    pub(super) fn cancel_os(&mut self, parent: Option<u64>) {
        let mut index = 0;
        while index < self.os_pending.len() {
            if parent.is_some() && self.os_pending[index].parent != parent {
                index += 1;
                continue;
            }
            let pending = self.os_pending.swap_remove(index);
            pending.operation.cancel();
            if let Some(supervisor) = &mut self.supervisor {
                supervisor.abandon_incoming(pending.id);
            }
            self.retiring_os.push(pending.operation);
        }
    }

    pub(super) fn cancel_os_request(&mut self, id: u64) {
        if let Some(index) = self.os_pending.iter().position(|request| request.id == id) {
            let pending = self.os_pending.swap_remove(index);
            pending.operation.cancel();
            self.retiring_os.push(pending.operation);
        }
    }

    pub(super) fn retire_services(&mut self) {
        if !self.services_active {
            return;
        }
        self.services_active = false;
        if let Some(services) = &self.services.config.plugin_services {
            services.retire_host_traffic(
                &self.observation.plugin.manifest.id,
                self.observation.plugin.generation,
            );
        }
        self.services.rpc.retire_plugin(
            &self.observation.plugin.manifest.id,
            self.observation.plugin.generation,
        );
        self.services.rpc.retire_host_scopes(
            &self.observation.plugin.manifest.id,
            self.observation.plugin.generation,
        );
        if let Some(broker) = &self.services.config.os_broker {
            broker.revoke_owner(
                &self.observation.plugin.manifest.id,
                self.observation.plugin.generation,
            );
        }
    }

    pub(super) fn pump_scope_cleanup(&mut self, client: &CdpClient) {
        // A still-authorized plugin gets its original finite deactivate phase
        // before Core closes any raw sessions it leaves behind.
        if self.defer_scope_cleanup && self.cleanup_phase == HostCleanupPhase::Running {
            return;
        }
        let sessions = self.services.rpc.take_cleanup_sessions(
            &self.observation.plugin.manifest.id,
            self.observation.plugin.generation,
        );
        let deadline = self
            .stop_deadline
            .unwrap_or_else(|| Instant::now() + Duration::from_millis(1500));
        self.scope_cleanup_queue
            .extend(sessions.into_iter().map(|session| (session, deadline)));
        let mut index = 0;
        while index < self.scope_cleanup.len() {
            let result = match self.scope_cleanup[index].request.try_response() {
                Ok(None) => {
                    index += 1;
                    continue;
                }
                result => result,
            };
            let cleanup = self.scope_cleanup.swap_remove(index);
            if let Err(error) = result {
                let already_detached = matches!(&error, ClientError::Remote { message, .. } if message.contains("No session with given id") || message.contains("Session with given id not found") || message.contains("Session closed") || message == "unknown detached session");
                if !already_detached {
                    self.unconfirmed_attachment(&format!(
                        "Core raw-session detach was not confirmed: {error}"
                    ));
                    client
                        .close_unconfirmed_attachment(self.attachment_failure.as_deref().unwrap());
                }
            }
            self.services.rpc.retire_raw_session(&cleanup.session_id);
        }
        while self.scope_cleanup.len() < MAX_PENDING {
            let Some((session_id, deadline)) = self.scope_cleanup_queue.pop_front() else {
                break;
            };
            if Instant::now() >= deadline {
                self.unconfirmed_attachment(
                    "known raw-session detach queue exhausted its original cleanup budget",
                );
                client.close_unconfirmed_attachment(self.attachment_failure.as_deref().unwrap());
                self.services.rpc.retire_raw_session(&session_id);
                for (session, _) in self.scope_cleanup_queue.drain(..) {
                    self.services.rpc.retire_raw_session(&session);
                }
                break;
            }
            match client.begin_raw_request(
                "Target.detachFromTarget",
                Some(json!({"sessionId":session_id})),
                None,
                deadline,
            ) {
                Ok(request) => self.scope_cleanup.push(ScopeCleanup {
                    session_id,
                    request,
                }),
                Err(ClientError::RequestQueueFull) => {
                    self.scope_cleanup_queue.push_front((session_id, deadline));
                    break;
                }
                Err(error) => {
                    self.unconfirmed_attachment(&format!(
                        "Core could not dispatch an owned raw-session detach: {error}"
                    ));
                    client
                        .close_unconfirmed_attachment(self.attachment_failure.as_deref().unwrap());
                    self.services.rpc.retire_raw_session(&session_id);
                    for (session, _) in self.scope_cleanup_queue.drain(..) {
                        self.services.rpc.retire_raw_session(&session);
                    }
                    break;
                }
            }
        }
    }
}
