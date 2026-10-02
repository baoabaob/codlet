//! Capture the package identity; the shared service owns advisory remote records.
use crate::runtime_manage::RuntimeManageService;
pub(crate) fn publish(service: &RuntimeManageService, running_version: &str) {
    service.observe_client_version(running_version);
}
