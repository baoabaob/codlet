//! Read-only official Windows release observations owned by the Codex launcher.
//! This presentation status never authorizes an unreviewed private adapter ABI.
use std::sync::mpsc::{self, Sender};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::runtime_manage::RuntimeManageService;

const MANIFEST_URL: &str =
    "https://persistent.oaistatic.com/codex-app-prod/windows-store-update.json";
const MAX_MANIFEST: usize = 64 * 1024;
const MATCHED_VERSIONS: &str = include_str!("../../bundled/codex-ui-adapter/client-versions.json");

pub(crate) struct ClientUpdateMonitor(Sender<()>);

impl ClientUpdateMonitor {
    pub(crate) fn start(service: RuntimeManageService, running_version: String) -> Self {
        let (stop, stopped) = mpsc::channel();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build();
            loop {
                let installed = crate::windows::packages::find_unique_current_user_package(
                    crate::windows::packages::CODEX_PACKAGE_FAMILY,
                )
                .map(|package| package.version.to_string())
                .unwrap_or_else(|_| running_version.clone());
                let latest = runtime
                    .as_ref()
                    .ok()
                    .and_then(|runtime| runtime.block_on(fetch_version()).ok());
                service.publish_client_status(status(&installed, latest.as_deref()));
                if !matches!(
                    stopped.recv_timeout(Duration::from_secs(15 * 60)),
                    Err(mpsc::RecvTimeoutError::Timeout)
                ) {
                    break;
                }
            }
        });
        Self(stop)
    }
}

impl Drop for ClientUpdateMonitor {
    fn drop(&mut self) {
        let _ = self.0.send(());
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoreManifest {
    schema_version: u32,
    build_version: String,
    store_product_id: String,
    package_identity: String,
}

fn parse_manifest(bytes: &[u8]) -> Result<String, String> {
    let manifest: StoreManifest =
        serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    if manifest.schema_version != 1
        || manifest.package_identity != "OpenAI.Codex"
        || manifest.store_product_id != "9PLM9XGG6VKS"
        || version(&manifest.build_version).is_none()
    {
        return Err("Unexpected official Windows update manifest identity".into());
    }
    Ok(manifest.build_version)
}

async fn fetch_version() -> Result<String, String> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(12))
        .user_agent(concat!("Codlet/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| error.to_string())?;
    let mut response = client
        .get(MANIFEST_URL)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|size| size > MAX_MANIFEST as u64)
    {
        return Err("Official update manifest is unavailable".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if bytes.len() + chunk.len() > MAX_MANIFEST {
            return Err("Official update manifest exceeds limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    parse_manifest(&bytes)
}

fn version(text: &str) -> Option<[u16; 4]> {
    let parts = text
        .split('.')
        .map(|part| {
            if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
                None
            } else {
                part.parse().ok()
            }
        })
        .collect::<Option<Vec<u16>>>()?;
    parts.try_into().ok()
}

fn status(installed: &str, latest: Option<&str>) -> Value {
    let matched: Value =
        serde_json::from_str(MATCHED_VERSIONS).expect("bundled client version metadata");
    let supported = |candidate: &str| {
        matched["matchedPackageVersions"]
            .as_array()
            .is_some_and(|versions| versions.iter().any(|item| item == candidate))
    };
    let available = latest
        .zip(version(installed))
        .is_some_and(|(latest, installed)| {
            version(latest).is_some_and(|latest| latest > installed)
        });
    let newest = if available {
        latest.unwrap()
    } else {
        installed
    };
    let matches_latest = latest.is_some() && supported(newest);
    let state = if latest.is_none() {
        if supported(installed) {
            "unknown"
        } else {
            "unmatched"
        }
    } else if !matches_latest {
        "unmatched"
    } else if available {
        "officialUpdateAvailable"
    } else {
        "matched"
    };
    json!({"status":state,"installedVersion":installed,"latestVersion":latest.map(|_|newest),
        "officialUpdateAvailable":available,"matchesLatestClient":matches_latest,
        "checkedAt":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u128::from(u64::MAX)) as u64})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn distinguishes_rollout_lag_available_unsupported_and_unknown() {
        assert_eq!(
            status("26.908.4834.0", Some("26.908.4561.0"))["status"],
            "matched"
        );
        assert_eq!(
            status("26.903.9818.0", Some("26.908.4834.0"))["status"],
            "officialUpdateAvailable"
        );
        let unknown_release = status("26.908.4834.0", Some("26.999.1.0"));
        assert_eq!(unknown_release["status"], "unmatched");
        assert_eq!(unknown_release["officialUpdateAvailable"], true);
        assert_eq!(status("26.908.4834.0", None)["status"], "unknown");
        assert_eq!(status("26.999.1.0", None)["status"], "unmatched");
    }
    #[test]
    fn requires_official_manifest_identity_and_numeric_package_version() {
        let valid = json!({"schemaVersion":1,"buildVersion":"26.908.4834.0","storeProductId":"9PLM9XGG6VKS","packageIdentity":"OpenAI.Codex"});
        assert_eq!(
            parse_manifest(&serde_json::to_vec(&valid).unwrap()).unwrap(),
            "26.908.4834.0"
        );
        for (key, value) in [
            ("schemaVersion", json!(2)),
            ("storeProductId", json!("other")),
            ("packageIdentity", json!("other")),
            ("buildVersion", json!("26.+1.2.0")),
        ] {
            let mut changed = valid.clone();
            changed[key] = value;
            assert!(parse_manifest(&serde_json::to_vec(&changed).unwrap()).is_err());
        }
    }
}
