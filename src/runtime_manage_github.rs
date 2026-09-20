//! Bounded, cancellable network preparation jobs. Jobs never register or execute plugins.
use std::collections::BTreeMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::github_distribution::{GitHubClient, GitHubLink, GitHubRepository};
use crate::managed_plugins::ManagedOperation;
use crate::plugins::PluginRegistry;
use crate::runtime_control::MAX_CONTROL_RESPONSE_BYTES;
use crate::runtime_manage::RuntimeManageError;

const MAX_RUNNING_JOBS: usize = 4;
const MAX_RETAINED_JOBS: usize = 16;

#[derive(Clone)]
pub(crate) struct GitHubJobs {
    registry: Arc<PathBuf>,
    state: Arc<Mutex<JobTable>>,
}

struct JobTable {
    incarnation: String,
    sequence: u64,
    active_workers: usize,
    jobs: BTreeMap<String, JobEntry>,
}

struct JobEntry {
    result: Value,
    cancelled: Arc<AtomicBool>,
    sequence: u64,
}

impl GitHubJobs {
    pub(crate) fn new(registry: Arc<PathBuf>) -> Self {
        Self {
            registry,
            state: Arc::new(Mutex::new(JobTable {
                incarnation: format!(
                    "{:x}-{:x}",
                    std::process::id(),
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos()
                ),
                sequence: 0,
                active_workers: 0,
                jobs: BTreeMap::new(),
            })),
        }
    }

    pub(crate) fn invoke<F>(
        &self,
        method: &str,
        params: Value,
        decorate_preview: F,
    ) -> Result<Value, RuntimeManageError>
    where
        F: FnOnce(&mut Value) -> Result<(), RuntimeManageError> + Send + 'static,
    {
        match method {
            "githubReleases" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Input {
                    url: String,
                }
                let input: Input = decode(params)?;
                let link = GitHubLink::parse(&input.url).map_err(github_error)?;
                self.start("releases", async move {
                    let client = GitHubClient::new().map_err(github_error)?;
                    let releases = client.list_releases(&link).await.map_err(github_error)?;
                    Ok(serde_json::to_value(releases).expect("GitHub catalog is serializable"))
                })
            }
            "githubPrepare" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields, rename_all = "camelCase")]
                struct Input {
                    repository_url: String,
                    release_id: u64,
                    asset_id: u64,
                    #[serde(default = "install")]
                    operation: ManagedOperation,
                    #[serde(default)]
                    plugin_id: Option<String>,
                }
                fn install() -> ManagedOperation {
                    ManagedOperation::Install
                }
                let input: Input = decode(params)?;
                if input.release_id == 0
                    || input.asset_id == 0
                    || input.operation == ManagedOperation::Rollback
                {
                    return Err(invalid(
                        "Choose a specific release and asset; use previewRollback for retained versions.",
                    ));
                }
                if input.operation == ManagedOperation::Update
                    && input.plugin_id.as_ref().is_none_or(|id| id.is_empty())
                {
                    return Err(invalid(
                        "An update must identify the currently installed plugin.",
                    ));
                }
                let repository =
                    GitHubRepository::parse(&input.repository_url).map_err(github_error)?;
                let path = self.registry.clone();
                self.start("package", async move {
                    let client = GitHubClient::new().map_err(github_error)?;
                    let package = client.prepare_asset(&repository, input.release_id, input.asset_id, path.as_ref()).await.map_err(github_error)?;
                    if input.plugin_id.as_ref().is_some_and(|id| *id != package.manifest.id) {
                        return Err(RuntimeManageError::new("plugin_identity_changed", "The selected release contains a different plugin ID. Select a release for the installed plugin."));
                    }
                    let registry = PluginRegistry::load(path.as_ref()).map_err(|error| RuntimeManageError::new("registry_error", error.to_string()))?;
                    let preview = crate::managed_plugins::preview(&registry, &package.package_path, input.operation).map_err(control_error)?;
                    let mut value = serde_json::to_value(preview).expect("managed preview is serializable");
                    decorate_preview(&mut value)?;
                    Ok(value)
                })
            }
            "githubJob" | "cancelGitHubJob" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields, rename_all = "camelCase")]
                struct Input {
                    job_id: String,
                }
                let input: Input = decode(params)?;
                let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
                let entry = state.jobs.get_mut(&input.job_id).ok_or_else(|| RuntimeManageError::new("github_job_not_found", "The preparation job expired or belongs to another Host. Start a new preview."))?;
                if method == "cancelGitHubJob" && entry.result["status"] == "running" {
                    entry.cancelled.store(true, Ordering::Release);
                    entry.result["status"] = json!("cancelled");
                    entry.result["stage"] = json!("cancelled");
                }
                Ok(entry.result.clone())
            }
            _ => Err(RuntimeManageError::new(
                "method_not_found",
                "Unknown GitHub preparation method.",
            )),
        }
    }

    fn start<F>(&self, kind: &'static str, work: F) -> Result<Value, RuntimeManageError>
    where
        F: Future<Output = Result<Value, RuntimeManageError>> + Send + 'static,
    {
        self.start_with_timeout(
            kind,
            work,
            Duration::from_secs(if kind == "releases" { 25 } else { 120 }),
        )
    }

    fn start_with_timeout<F>(
        &self,
        kind: &'static str,
        work: F,
        timeout: Duration,
    ) -> Result<Value, RuntimeManageError>
    where
        F: Future<Output = Result<Value, RuntimeManageError>> + Send + 'static,
    {
        let (job_id, cancelled, initial) = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            if state.active_workers >= MAX_RUNNING_JOBS {
                return Err(RuntimeManageError::new(
                    "github_busy",
                    "Four GitHub preparations are already running. Wait or cancel one.",
                ));
            }
            if state.jobs.len() >= MAX_RETAINED_JOBS {
                let oldest = state
                    .jobs
                    .iter()
                    .filter(|(_, entry)| entry.result["status"] != "running")
                    .min_by_key(|(_, entry)| entry.sequence)
                    .map(|(id, _)| id.clone());
                if let Some(oldest) = oldest {
                    state.jobs.remove(&oldest);
                }
            }
            state.sequence += 1;
            state.active_workers += 1;
            let sequence = state.sequence;
            let job_id = format!("{}-{:x}", state.incarnation, sequence);
            let cancelled = Arc::new(AtomicBool::new(false));
            let initial = json!({"jobId":job_id, "kind":kind, "status":"running", "stage":if kind == "package" {"downloading-and-validating"} else {"fetching-releases"}});
            state.jobs.insert(
                job_id.clone(),
                JobEntry {
                    result: initial.clone(),
                    cancelled: cancelled.clone(),
                    sequence,
                },
            );
            (job_id, cancelled, initial)
        };
        let state = self.state.clone();
        let thread_id = job_id.clone();
        let started = std::time::Instant::now();
        let worker = std::thread::Builder::new().name("codlet-github-preview".into()).spawn(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|error| RuntimeManageError::new("github_runtime_error", error.to_string()))?;
                runtime.block_on(async {
                    tokio::pin!(work);
                    let deadline = tokio::time::sleep(timeout);
                    tokio::pin!(deadline);
                    let mut cancellation = tokio::time::interval(Duration::from_millis(50));
                    loop {
                        tokio::select! {
                            result = &mut work => return result,
                            _ = &mut deadline => return Err(RuntimeManageError::new("github_timeout", "GitHub request timed out. Check the connection or proxy, then try again.")),
                            _ = cancellation.tick() => if cancelled.load(Ordering::Acquire) { return Err(RuntimeManageError::new("github_cancelled", "Preparation was cancelled.")); },
                        }
                    }
                })
            })).unwrap_or_else(|_| Err(RuntimeManageError::new("github_worker_failed", "The preparation worker failed. No plugin was registered.")));
            let mut table = state.lock().unwrap_or_else(|error| error.into_inner());
            table.active_workers -= 1;
            let Some(entry) = table.jobs.get_mut(&thread_id) else { return; };
            if entry.cancelled.load(Ordering::Acquire) { return; }
            match outcome.and_then(|value| {
                if serde_json::to_vec(&value).map_or(true, |encoded| encoded.len() > MAX_CONTROL_RESPONSE_BYTES - 1024) {
                    Err(RuntimeManageError::new("response_too_large", "GitHub preparation data exceeds the management response limit."))
                } else { Ok(value) }
            }) {
                Ok(value) => { entry.result["status"] = json!("completed"); entry.result["stage"] = json!("ready"); entry.result["result"] = value; }
                Err(error) => {
                    crate::runtime_log::error("github_preparation", &format!("kind={kind} code={} elapsedMs={}", error.code, started.elapsed().as_millis()));
                    entry.result["status"] = json!("failed"); entry.result["stage"] = json!("failed"); entry.result["error"] = json!({"code":error.code,"message":error.message});
                }
            }
        });
        if let Err(error) = worker {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            state.jobs.remove(&job_id);
            state.active_workers -= 1;
            return Err(RuntimeManageError::new(
                "github_worker_failed",
                error.to_string(),
            ));
        }
        Ok(initial)
    }
}

fn decode<T: serde::de::DeserializeOwned>(params: Value) -> Result<T, RuntimeManageError> {
    serde_json::from_value(params).map_err(|error| invalid(error.to_string()))
}
fn invalid(message: impl Into<String>) -> RuntimeManageError {
    RuntimeManageError::new("invalid_params", message)
}
fn github_error(error: crate::github_distribution::GitHubDistributionError) -> RuntimeManageError {
    let code = match error.code.as_str() {
        "github_timeout" => "github_timeout",
        "github_network" => "github_network",
        "github_rate_limited" => "github_rate_limited",
        "github_not_found" => "github_not_found",
        _ => {
            return RuntimeManageError::new(
                "github_error",
                format!("{}: {}", error.code, error.message),
            );
        }
    };
    RuntimeManageError::new(code, error.message)
}
fn control_error(error: crate::plugin_control::PluginControlError) -> RuntimeManageError {
    RuntimeManageError::new(
        "managed_plugin_error",
        format!("{}: {}", error.code, error.message),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stalled_release_job_expires_and_releases_its_worker_slot() {
        let directory = tempfile::tempdir().unwrap();
        let registry = directory.path().join("registry.json");
        let jobs = GitHubJobs::new(Arc::new(registry.clone()));
        let job = jobs
            .start_with_timeout(
                "releases",
                std::future::pending(),
                Duration::from_millis(30),
            )
            .unwrap();
        let params = json!({"jobId":job["jobId"]});
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let result = loop {
            let value = jobs
                .invoke("githubJob", params.clone(), |_| Ok(()))
                .unwrap();
            if value["status"] != "running" {
                break value;
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(result["status"], "failed");
        assert_eq!(result["error"]["code"], "github_timeout");
        assert_eq!(jobs.state.lock().unwrap().active_workers, 0);
        assert_eq!(
            jobs.invoke("githubJob", params, |_| Ok(())).unwrap(),
            result
        );
        assert!(!registry.exists());
    }

    #[test]
    fn transport_errors_keep_their_structured_code_and_translatable_message() {
        let error = github_error(crate::github_distribution::GitHubDistributionError {
            code: "github_timeout".into(),
            message: "GitHub request timed out.".into(),
        });
        assert_eq!(error.code, "github_timeout");
        assert_eq!(error.message, "GitHub request timed out.");
    }

    #[test]
    fn cancellation_is_terminal_and_running_preparations_are_bounded() {
        let directory = tempfile::tempdir().unwrap();
        let jobs = GitHubJobs::new(Arc::new(directory.path().join("registry.json")));
        let mut running = Vec::new();
        for _ in 0..MAX_RUNNING_JOBS {
            running.push(jobs.start("releases", std::future::pending()).unwrap());
        }
        assert_eq!(
            jobs.start("releases", std::future::pending())
                .unwrap_err()
                .code,
            "github_busy"
        );
        for job in &running {
            let params = json!({"jobId":job["jobId"]});
            assert_eq!(
                jobs.invoke("cancelGitHubJob", params.clone(), |_| Ok(()))
                    .unwrap()["status"],
                "cancelled"
            );
            assert_eq!(
                jobs.invoke("githubJob", params, |_| Ok(())).unwrap()["status"],
                "cancelled"
            );
        }
        assert!(!directory.path().join("registry.json").exists());
    }

    #[test]
    fn invalid_sources_and_identity_inputs_do_not_start_jobs() {
        let directory = tempfile::tempdir().unwrap();
        let jobs = GitHubJobs::new(Arc::new(directory.path().join("registry.json")));
        for input in [
            json!({"url":"http://127.0.0.1/private"}),
            json!({"url":"https://github.com/a/b","registry":"elsewhere"}),
        ] {
            assert!(jobs.invoke("githubReleases", input, |_| Ok(())).is_err());
        }
        assert!(jobs.invoke("githubPrepare", json!({"repositoryUrl":"https://github.com/a/b","releaseId":1,"assetId":2,"operation":"update"}), |_| Ok(())).is_err());
        assert!(jobs.state.lock().unwrap().jobs.is_empty());
    }

    #[test]
    fn an_oversized_preparation_finishes_with_a_queryable_failure() {
        let directory = tempfile::tempdir().unwrap();
        let jobs = GitHubJobs::new(Arc::new(directory.path().join("registry.json")));
        let job = jobs
            .start("package", async {
                Ok(json!({"dependencyCheck":"x".repeat(MAX_CONTROL_RESPONSE_BYTES)}))
            })
            .unwrap();
        let params = json!({"jobId":job["jobId"]});
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let completed = loop {
            let value = jobs
                .invoke("githubJob", params.clone(), |_| Ok(()))
                .unwrap();
            if value["status"] != "running" {
                break value;
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(completed["status"], "failed");
        assert_eq!(completed["error"]["code"], "response_too_large");
        assert!(serde_json::to_vec(&completed).unwrap().len() < MAX_CONTROL_RESPONSE_BYTES);
        assert_eq!(
            jobs.invoke("githubJob", params, |_| Ok(())).unwrap(),
            completed
        );
    }
}
