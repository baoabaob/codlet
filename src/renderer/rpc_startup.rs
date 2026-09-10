//! Entry ordering spans all attached documents, including Host initializers
//! that await a renderer provider in another window.

use super::*;

impl RendererRuntime {
    pub fn attach_all(
        &mut self,
        sessions: &[TargetSession],
    ) -> Vec<(String, Result<RendererBootstrapReport, RendererError>)> {
        if let Err(error) = self.register_rpc_plugins(&self.logical_plugins()) {
            let message = error.to_string();
            return sessions
                .iter()
                .map(|session| {
                    (
                        session.target_id().to_owned(),
                        Err(RendererError::PluginRejected {
                            plugin_id: "core-rpc".into(),
                            message: message.clone(),
                        }),
                    )
                })
                .collect();
        }
        self.owner_lifecycle_depth += 1;
        let mut results = BTreeMap::new();
        let mut authorizations = BTreeMap::new();
        for session in sessions {
            let target = session.target_id().to_owned();
            if self.sessions.contains_key(&target) {
                results.insert(
                    target.clone(),
                    Err(RendererError::TargetAlreadyAttached(target)),
                );
                continue;
            }
            let scope = CapabilityScopeInstance::Target(target.clone());
            let resolved = self
                .capabilities
                .activate_scope(scope.clone())
                .map_err(RendererError::from)
                .and_then(|_| {
                    self.resolve_target_authorizations(&scope)
                        .map_err(RendererError::from)
                });
            match resolved {
                Err(error) => {
                    self.capabilities.deactivate_scope(&scope);
                    results.insert(target, Err(error));
                }
                Ok(authorization) => {
                    self.sessions.insert(
                        target.clone(),
                        RendererSession {
                            session: session.clone(),
                            main_frame_id: None,
                            document_epoch: 1,
                            recovery_pending: false,
                            plugins: Vec::with_capacity(self.plugins.len()),
                            events: session.subscribe_events(),
                        },
                    );
                    self.publish_rpc_target(&target);
                    authorizations.insert(target, authorization);
                }
            }
        }
        let previous = self.drive_deadline;
        self.drive_deadline = previous.or_else(|| {
            sessions
                .iter()
                .filter_map(|session| session.request_deadline().ok())
                .min()
        });
        for plugin in self.plugins.clone() {
            for session in sessions {
                let target = session.target_id();
                if results.contains_key(target) {
                    continue;
                }
                let Some(authorization) = authorizations
                    .get_mut(target)
                    .and_then(|authorizations| authorizations.remove(&plugin.manifest.id))
                else {
                    continue;
                };
                let single = BTreeMap::from([(plugin.manifest.id.clone(), authorization)]);
                if let Err(error) = self.install_plugins(target, vec![plugin.clone()], single) {
                    let _ = self.deactivate_target(target);
                    results.insert(target.into(), Err(error));
                }
            }
        }
        self.drive_deadline = previous;
        self.owner_lifecycle_depth -= 1;
        self.publish_status();
        self.flush_host_actions();
        sessions
            .iter()
            .map(|session| {
                let target = session.target_id().to_owned();
                let result = results.remove(&target).unwrap_or_else(|| {
                    Ok(RendererBootstrapReport {
                        target_id: target.clone(),
                        plugin_count: self.sessions.get(&target).map_or(0, |session| {
                            session
                                .plugins
                                .iter()
                                .filter(|plugin| plugin.state == RendererPluginState::Active)
                                .count()
                        }),
                    })
                });
                (target, result)
            })
            .collect()
    }

    pub(super) fn wait_native_ready(
        &mut self,
        plugin_id: &str,
        generation: u64,
    ) -> Result<(), RendererError> {
        let deadline = self
            .drive_deadline
            .or_else(|| {
                self.sessions
                    .values()
                    .filter_map(|session| session.session.request_deadline().ok())
                    .min()
            })
            .unwrap_or_else(|| Instant::now() + Duration::from_secs(5));
        loop {
            match self.native_rpc_ready(plugin_id, generation) {
                Some(Ok(true)) => return Ok(()),
                Some(Err(message)) => {
                    return Err(RendererError::PluginRejected {
                        plugin_id: plugin_id.into(),
                        message,
                    });
                }
                None => return self.require_native_ready(plugin_id, generation),
                Some(Ok(false)) => {}
            }
            if Instant::now() >= deadline {
                return Err(RendererError::PluginRejected { plugin_id:plugin_id.into(), message:"the pinned native dependency did not become Ready within the original startup budget".into() });
            }
            let mut events = Vec::new();
            for (target, session) in &self.sessions {
                for _ in 0..16 {
                    match session.events.recv_timeout(Duration::ZERO) {
                        Ok(event) => events.push((target.clone(), event)),
                        Err(EventStreamError::Timeout) => break,
                        Err(error) => return Err(error.into()),
                    }
                }
            }
            let idle = events.is_empty();
            for (target, event) in events {
                self.handle_renderer_event(&target, event)?;
            }
            self.poll_host_capabilities();
            if idle {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
}
