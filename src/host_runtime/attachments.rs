//! Remote attachments need a retirement receipt even after their caller stops.
//! Only a writer cancellation proves no session can have been created. Once a
//! frame starts, retain its exact response and detach the returned session.

use super::*;

const RETIREMENT_BUDGET: Duration = Duration::from_millis(1500);

pub(super) struct RetiringAttachment {
    request: QueuedCdpRequest,
    metadata: rpc::RawMetadata,
    deadline: Instant,
}

impl HostOwner {
    pub(super) fn cancel_raw_request(&mut self, id: u64) {
        self.finish_raw_reply(id, false);
        let Some(index) = self
            .pending
            .iter()
            .position(|(current, _, _)| *current == id)
        else {
            return;
        };
        let (_, request, _) = self.pending.swap_remove(index);
        if let Some(metadata) = self.raw_metadata.remove(&id)
            && metadata.attachment.is_some()
            && !request.cancel_attachment_before_write()
        {
            self.retiring_attachments.push(RetiringAttachment {
                request,
                metadata,
                deadline: Instant::now() + RETIREMENT_BUDGET,
            });
        }
    }

    pub(super) fn finish_raw_reply(&mut self, id: u64, delivered: bool) {
        if let Some(session) = self.undelivered_attachments.remove(&id)
            && !delivered
        {
            self.services.rpc.retire_late_attachment(
                &self.observation.plugin.manifest.id,
                self.observation.plugin.generation,
                &session,
            );
        }
    }

    pub(super) fn cancel_raw_requests(&mut self, parent: Option<u64>) {
        let ids = self
            .pending
            .iter()
            .filter(|(_, _, current)| parent.is_none() || *current == parent)
            .map(|(id, _, _)| *id)
            .collect::<Vec<_>>();
        for id in ids {
            self.cancel_raw_request(id);
        }
        if parent.is_none() {
            let ids = self
                .undelivered_attachments
                .keys()
                .copied()
                .collect::<Vec<_>>();
            for id in ids {
                self.finish_raw_reply(id, false);
            }
        }
    }

    pub(super) fn pump_raw_pending(&mut self) {
        let mut index = 0;
        while index < self.pending.len() {
            let id = self.pending[index].0;
            let attachment = self
                .raw_metadata
                .get(&id)
                .is_some_and(|metadata| metadata.attachment.is_some());
            if attachment
                && self
                    .raw_metadata
                    .get(&id)
                    .is_some_and(|metadata| Instant::now() >= metadata.deadline)
            {
                self.cancel_raw_request(id);
                self.queue(Outbound::Reply(
                    id,
                    Err(HostRpcError::new(
                        "request_timeout",
                        "the original raw attachment caller deadline expired",
                    )),
                ));
                continue;
            }
            let response = if attachment {
                self.pending[index].1.try_attachment_response()
            } else {
                self.pending[index].1.try_response()
            };
            if attachment
                && response.as_ref().is_err_and(|error| {
                    !matches!(
                        error,
                        ClientError::Remote { .. } | ClientError::Connection(_)
                    )
                })
                && !self.pending[index].1.cancel_attachment_before_write()
            {
                let error = response.expect_err("checked attachment error");
                self.cancel_raw_request(id);
                self.queue(Outbound::Reply(id, Err(cdp_error(error))));
                continue;
            }
            let outcome = match response {
                Ok(None) => {
                    index += 1;
                    continue;
                }
                Ok(Some(response)) => bounded_result(Ok(response.result.unwrap_or(Value::Null))),
                Err(error) => Err(cdp_error(error)),
            };
            let (id, _, _) = self.pending.swap_remove(index);
            let outcome = self.finish_raw_metadata(id, outcome);
            if outcome.is_ok()
                && self.observation.state != ExecutionState::Stopping
                && !self.authority_is_current()
            {
                self.fail(HostError::new(
                    "authorization_revoked",
                    "the complete Host trust record changed before raw response delivery",
                ));
                return;
            }
            self.queue(Outbound::Reply(id, outcome));
            if self.failure.is_some() {
                return;
            }
        }
    }

    pub(super) fn pump_attachment_retirement(&mut self, client: &CdpClient) {
        let mut index = 0;
        while index < self.retiring_attachments.len() {
            let response = self.retiring_attachments[index]
                .request
                .try_attachment_response();
            match response {
                Ok(None) if Instant::now() < self.retiring_attachments[index].deadline => {
                    index += 1;
                    continue;
                }
                Ok(None) => {
                    self.unconfirmed_attachment("an already-started attach did not return its session within the finite Core retirement budget");
                    self.retiring_attachments.swap_remove(index);
                }
                Ok(Some(response)) => {
                    let mut retired = self.retiring_attachments.swap_remove(index);
                    let result = response.result.unwrap_or(Value::Null);
                    let session = result
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .filter(|id| valid_identifier(id));
                    let target = retired
                        .metadata
                        .params
                        .as_ref()
                        .and_then(|params| params.get("targetId"))
                        .and_then(Value::as_str);
                    if let (Some(session), Some(target), Some(permit)) =
                        (session, target, retired.metadata.attachment.take())
                    {
                        match self.services.rpc.track_raw_attach(
                            &self.observation.plugin.manifest.id,
                            self.observation.plugin.generation,
                            target,
                            session,
                            permit,
                        ) {
                            Ok(()) => self.services.rpc.retire_late_attachment(
                                &self.observation.plugin.manifest.id,
                                self.observation.plugin.generation,
                                session,
                            ),
                            Err(error) => self.unconfirmed_attachment(&error.to_string()),
                        }
                    } else {
                        self.unconfirmed_attachment(
                            "a retired successful attach omitted its valid session identity",
                        );
                    }
                }
                Err(error) => {
                    // A CDP remote error confirms that this attach failed. A
                    // closed connection invalidates its remote session namespace.
                    if !matches!(
                        error,
                        ClientError::Remote { .. } | ClientError::Connection(_)
                    ) && !self.retiring_attachments[index]
                        .request
                        .cancel_attachment_before_write()
                    {
                        self.unconfirmed_attachment(&error.to_string());
                    }
                    self.retiring_attachments.swap_remove(index);
                }
            }
        }
        if let Some(reason) = self.attachment_failure.take() {
            client.close_unconfirmed_attachment(&reason);
            self.fail(HostError::new("cleanup_incomplete", reason));
        }
    }

    pub(super) fn unconfirmed_attachment(&mut self, reason: &str) {
        self.cleanup_quarantined = true;
        self.cleanup_error = Some(format!("cleanup_incomplete: {reason}"));
        self.attachment_failure
            .get_or_insert_with(|| reason.to_owned());
    }

    pub(super) fn finish_attachment_shutdown(&mut self, client: &CdpClient) {
        if !self.retiring_attachments.is_empty()
            || !self.scope_cleanup_queue.is_empty()
            || !self.scope_cleanup.is_empty()
            || self.services.rpc.has_cleanup_sessions(
                &self.observation.plugin.manifest.id,
                self.observation.plugin.generation,
            )
        {
            self.unconfirmed_attachment(
                "Core shutdown ended before owned raw attachment retirement could be confirmed",
            );
            client.close_unconfirmed_attachment(self.attachment_failure.as_deref().unwrap());
            self.attachment_failure.take();
            self.retiring_attachments.clear();
        }
    }
}
