//! Local version facts captured at launch. Client updates belong to Desktop.
use crate::runtime_manage::RuntimeManageService;
use serde_json::{Value, json};

const MATCHED_VERSIONS: &str = include_str!("../../bundled/codex-ui-adapter/client-versions.json");
pub(crate) fn publish(service: &RuntimeManageService, running_version: &str) {
    service.publish_client_status(status(running_version));
}

fn status(running: &str) -> Value {
    status_for_target(running, std::env::consts::OS, std::env::consts::ARCH)
}

fn status_for_target(running: &str, os: &str, architecture: &str) -> Value {
    let matched: Value =
        serde_json::from_str(MATCHED_VERSIONS).expect("bundled client version metadata");
    let versions = matched["platforms"][format!("{os}-{architecture}")]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let supported = versions.iter().any(|item| item == running);
    json!({"source":"local-package","status":if supported{"matched"}else{"unmatched"},
        "runningVersion":running,"adaptedVersions":versions,"matchesRunningClient":supported})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_versions_do_not_infer_client_update_availability() {
        let value = status_for_target("26.908.4834.0", "windows", "x86_64");
        assert_eq!(value["status"], "matched");
        assert_eq!(value["adaptedVersions"], json!(["26.908.4834.0"]));
        assert!(value.get("latestVersion").is_none());
        assert!(value.get("officialUpdateAvailable").is_none());
        assert!(value.get("installedVersion").is_none());
        assert_eq!(
            status_for_target("26.999.1.0", "windows", "x86_64")["status"],
            "unmatched"
        );
        assert_eq!(
            status_for_target("26.908.4834.0", "windows", "aarch64")["adaptedVersions"],
            json!([])
        );
        assert_eq!(
            status_for_target("26.908.4834.0", "macos", "aarch64")["matchesRunningClient"],
            false
        );
    }
}
