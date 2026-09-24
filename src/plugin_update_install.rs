//! User-requested updates use the existing foreground lifecycle receipts.
//! Downloads are automatic; existing grants and enablement are preserved. New
//! authority or changed dependency contracts are returned for explicit review.
#[cfg(test)]
use crate::github_distribution::GitHubSource;
use crate::github_distribution::{GitHubAsset, GitHubClient, GitHubLink, GitHubRelease};
use crate::managed_plugins::{ManagedOperation, ManagedPreview};
use crate::plugin_control::{PluginControlAction, PluginControlRequest};
use crate::plugin_update_source::PluginUpdateSource;
use crate::plugins::PluginRegistry;
use crate::runtime_control::{ControlBroker, ControlRequest, ControlStatus};
use crate::runtime_manage::RuntimeManageError;
use serde::Serialize;
use serde_json::Value;
#[cfg(test)]
mod tests;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Item {
    plugin_id: String,
    version_key: String,
    phase: &'static str,
    version: Option<String>,
    message: Option<String>,
    operation_id: Option<String>,
    #[serde(skip)]
    preview: Option<Value>,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateBatch {
    id: u64,
    running: bool,
    items: Vec<Item>,
}
struct Owner {
    registry: Arc<PathBuf>,
    broker: ControlBroker,
    state: Mutex<UpdateBatch>,
}
#[derive(Clone)]
pub(crate) struct PluginUpdateInstall(Arc<Owner>);

impl PluginUpdateInstall {
    pub(crate) fn new(registry: Arc<PathBuf>, broker: ControlBroker) -> Self {
        Self(Arc::new(Owner {
            registry,
            broker,
            state: Mutex::new(UpdateBatch::default()),
        }))
    }
    pub(crate) fn status(&self) -> UpdateBatch {
        self.0
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub(crate) fn preview(
        &self,
        batch_id: u64,
        plugin_id: &str,
    ) -> Result<Value, RuntimeManageError> {
        let state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.id == batch_id
            && let Some(preview) = state
                .items
                .iter()
                .find(|item| {
                    item.plugin_id == plugin_id
                        && item.phase == "reviewRequired"
                        && PluginRegistry::load(self.0.registry.as_ref())
                            .ok()
                            .and_then(|r| PluginUpdateSource::load(&r, plugin_id))
                            .is_some_and(|s| s.version_key == item.version_key)
                })
                .and_then(|item| item.preview.clone())
        {
            return Ok(preview);
        }
        Err(RuntimeManageError::new(
            "update_review_expired",
            "The update review expired. Check this plugin again.",
        ))
    }
    pub(crate) fn start(
        &self,
        plugin_ids: Option<Vec<String>>,
    ) -> Result<UpdateBatch, RuntimeManageError> {
        let registry = PluginRegistry::load(self.0.registry.as_ref())
            .map_err(|e| RuntimeManageError::new("registry_error", e.to_string()))?;
        let plugin_ids = plugin_ids.unwrap_or_else(|| {
            PluginUpdateSource::all(&registry)
                .into_iter()
                .map(|(id, _)| id)
                .collect()
        });
        if plugin_ids.is_empty() || plugin_ids.len() > 128 {
            return Err(RuntimeManageError::new(
                "invalid_params",
                "Choose between 1 and 128 plugins with a verified update channel.",
            ));
        }
        let mut items = Vec::new();
        for id in plugin_ids {
            if items.iter().any(|item: &Item| item.plugin_id == id) {
                return Err(RuntimeManageError::new(
                    "invalid_params",
                    "Duplicate plugin ID.",
                ));
            }
            let version = PluginUpdateSource::load(&registry, &id).ok_or_else(|| {
                RuntimeManageError::new(
                    "managed_plugin_required",
                    "This plugin has no verified update channel, or its installer files changed.",
                )
            })?;
            items.push(Item {
                plugin_id: id,
                version_key: version.version_key.clone(),
                phase: "queued",
                version: None,
                message: None,
                operation_id: None,
                preview: None,
            });
        }
        let initial = {
            let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.running {
                return Err(RuntimeManageError::new(
                    "update_busy",
                    "Plugin updates are already running.",
                ));
            }
            *state = UpdateBatch {
                id: state.id + 1,
                running: true,
                items,
            };
            state.clone()
        };
        let weak = Arc::downgrade(&self.0);
        let path = self.0.registry.clone();
        let broker = self.0.broker.clone();
        let work = initial.clone();
        if let Err(error)=std::thread::Builder::new().name("codlet-install-updates".into()).spawn(move||{
            let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e|e.to_string())?;
                runtime.block_on(async {
                    let client=GitHubClient::new().map_err(|e|e.to_string())?;
                    for item in &work.items {
                        if weak.strong_count()==0 { break; }
                        publish(&weak,work.id,&item.plugin_id,"downloading",None,None,None);
                        let prepare=prepare_latest(&client,path.as_ref(),&item.plugin_id,&item.version_key);
                        tokio::pin!(prepare);
                        let deadline=tokio::time::sleep(Duration::from_secs(120));tokio::pin!(deadline);
                        let mut cancellation=tokio::time::interval(Duration::from_millis(100));
                        let result=loop {tokio::select!{
                            result=&mut prepare=>break result,
                            _=&mut deadline=>break Err("Preparing the GitHub package timed out. No installation was submitted. Try again.".into()),
                            _=cancellation.tick()=>if weak.strong_count()==0 {return Ok::<(),String>(());}
                        }};
                        match result {
                            Ok(None)=>publish(&weak,work.id,&item.plugin_id,"upToDate",None,None,None),
                            Ok(Some(preview))=>{
                                if needs_review(&preview) {
                                    let mut value=serde_json::to_value(&preview).map_err(|e|e.to_string())?;
                                    value.as_object_mut().unwrap().remove("history");
                                    let message=if preview.changes.restart_required {"This update changes plugin entry shape. Apply it with the CLI while Codlet is stopped, then restart Codlet."}else if preview.operation==ManagedOperation::Adopt {"Review the first update from the installer package to its GitHub channel. Existing settings will be preserved."}else{"This update changes permissions or plugin dependencies. Review it before installing."};
                                    publish(&weak,work.id,&item.plugin_id,"reviewRequired",Some(preview.manifest.version.clone()),Some(message.into()),Some(value));
                                } else {
                                    publish(&weak,work.id,&item.plugin_id,"installing",Some(preview.manifest.version.clone()),None,None);
                                    match apply(&broker,&preview,&weak,work.id,&item.plugin_id).await {
                                        Ok(())=>publish(&weak,work.id,&item.plugin_id,"updated",Some(preview.manifest.version.clone()),None,None),
                                        Err(error)=>publish(&weak,work.id,&item.plugin_id,"failed",None,Some(error),None),
                                    }
                                }
                            }
                            Err(error)=>publish(&weak,work.id,&item.plugin_id,"failed",None,Some(error),None),
                        }
                    }
                    Ok(())
                })
            })).unwrap_or_else(|_|Err("Plugin update worker failed.".into()));
            if let Some(owner)=weak.upgrade(){let mut state=owner.state.lock().unwrap_or_else(|e|e.into_inner());
                if state.id==work.id {state.running=false;if let Err(error)=result {for item in &mut state.items {if matches!(item.phase,"queued"|"downloading"|"installing"){item.phase="failed";item.message=Some(error.clone());}}}}
            }
        }) { let mut state=self.0.state.lock().unwrap_or_else(|e|e.into_inner());state.running=false;return Err(RuntimeManageError::new("update_worker_failed",error.to_string())); }
        Ok(initial)
    }
}
fn publish(
    owner: &Weak<Owner>,
    batch: u64,
    id: &str,
    phase: &'static str,
    version: Option<String>,
    message: Option<String>,
    preview: Option<Value>,
) {
    if let Some(owner) = owner.upgrade() {
        let mut state = owner.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.id == batch
            && let Some(item) = state.items.iter_mut().find(|item| item.plugin_id == id)
        {
            item.phase = phase;
            item.version = version.or(item.version.take());
            item.message = message.map(|m| m.chars().take(1000).collect());
            item.preview = preview;
        }
    }
}
fn asset_pattern(name: &str, tag: &str) -> String {
    name.replace(tag, "{version}")
        .replace(tag.strip_prefix('v').unwrap_or(tag), "{version}")
}
#[cfg(test)]
pub(crate) fn select_asset<'a>(
    source: &GitHubSource,
    release: &'a GitHubRelease,
) -> Result<&'a GitHubAsset, String> {
    select_channel_asset(
        &asset_pattern(&source.asset_name, &source.tag),
        release,
        true,
    )
}
fn select_channel_asset<'a>(
    template: &str,
    release: &'a GitHubRelease,
    allow_single: bool,
) -> Result<&'a GitHubAsset, String> {
    let assets: Vec<_> = release
        .assets
        .iter()
        .filter(|a| a.name.to_ascii_lowercase().ends_with(".zip"))
        .collect();
    if allow_single && assets.len() == 1 {
        return Ok(assets[0]);
    }
    let matching: Vec<_> = assets
        .into_iter()
        .filter(|a| a.name == template || asset_pattern(&a.name, &release.tag) == template)
        .collect();
    if matching.len() == 1 {
        Ok(matching[0])
    } else {
        Err(
            "The latest release has more than one possible package. Choose a ZIP asset manually."
                .into(),
        )
    }
}
async fn prepare_latest(
    client: &GitHubClient,
    path: &Path,
    id: &str,
    expected: &str,
) -> Result<Option<ManagedPreview>, String> {
    let registry = PluginRegistry::load(path).map_err(|e| e.to_string())?;
    let current = PluginUpdateSource::load(&registry, id)
        .filter(|v| v.version_key == expected)
        .ok_or("The installed plugin changed. Check it again before updating.")?;
    let link = GitHubLink::parse(&current.channel.repository_url).map_err(|e| e.to_string())?;
    current.channel.verify_identity(client).await?;
    let current_tag = &current.comparison_version;
    if crate::runtime_update::newer_version(current_tag, current_tag).is_err() {
        return Err("The package version cannot be compared. Choose a release manually.".into());
    }
    let catalog = client
        .list_releases(&link)
        .await
        .map_err(|e| e.to_string())?;
    if catalog.truncated {
        return Err("Release history is incomplete. Choose a release manually.".into());
    }
    let Some(release) =
        crate::plugin_updates::latest_release_version(current_tag, current.release_id, &catalog)
    else {
        return if catalog.truncated {
            Err("Release history is incomplete. Choose a release manually.".into())
        } else {
            Ok(None)
        };
    };
    let asset = select_channel_asset(
        &current.channel.asset_name_template,
        release,
        current.operation == ManagedOperation::Update,
    )?;
    let package = client
        .prepare_asset(&link.repository, release.id, asset.id, path)
        .await
        .map_err(|e| e.to_string())?;
    if package.manifest.id != id
        || !current.channel.accepts(&package.source)
        || package.source.release_id != release.id
        || package.source.asset_id != asset.id
        || package.source.tag != release.tag
        || package.manifest.version != release.tag.strip_prefix('v').unwrap_or(&release.tag)
    {
        return Err("The downloaded package belongs to a different plugin.".into());
    }
    if !crate::runtime_update::newer_version(&package.manifest.version, &current.manifest.version)
        .map_err(|_| "The package version cannot be compared. Choose a release manually.")?
    {
        return Err("The published package is not newer than the installed plugin.".into());
    }
    // Compare again after network I/O; only the requested registration can change.
    let registry = PluginRegistry::load(path).map_err(|e| e.to_string())?;
    if PluginUpdateSource::load(&registry, id).is_none_or(|v| v.version_key != expected) {
        return Err("The installed plugin changed. Check it again before updating.".into());
    }
    crate::managed_plugins::preview(&registry, &package.package_path, current.operation)
        .map(Some)
        .map_err(|e| e.to_string())
}
fn needs_review(p: &ManagedPreview) -> bool {
    p.operation == ManagedOperation::Adopt
        || p.changes.restart_required
        || p.existing_registration.as_ref().is_none_or(|r| {
            p.manifest
                .permissions
                .iter()
                .any(|permission| !r.grants.contains(permission))
        })
        || !p.changes.permissions_added.is_empty()
        || !p.changes.requirements_added.is_empty()
        || !p.changes.requirements_removed.is_empty()
        || !p.changes.provides_added.is_empty()
        || !p.changes.provides_removed.is_empty()
}
async fn apply(
    broker: &ControlBroker,
    p: &ManagedPreview,
    owner: &Weak<Owner>,
    batch: u64,
    id: &str,
) -> Result<(), String> {
    let old = p
        .existing_registration
        .as_ref()
        .ok_or("Installed plugin has no grants.")?;
    let policy = old.broker_policy.clone();
    let request = PluginControlRequest {
        action: PluginControlAction::Update,
        plugin_id: id.into(),
        permission: None,
        cascade: false,
        remove_source: None,
        local_import: Some(p.request(old.grants.clone(), policy, p.existing_enabled)),
    };
    let prepared = broker.handle(ControlRequest::prepare(request));
    if prepared.status != ControlStatus::Prepared {
        return Err(prepared
            .error
            .unwrap_or("The update could not be prepared.".into()));
    }
    let ticket = prepared
        .operation_id()
        .ok_or("The update returned no receipt.")?
        .to_string();
    if let Some(owner) = owner.upgrade() {
        let mut state = owner.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.id == batch
            && let Some(item) = state.items.iter_mut().find(|item| item.plugin_id == id)
        {
            item.operation_id = Some(ticket.clone());
        }
    } else {
        return Err("Runtime stopped before installation.".into());
    }
    let submitted = broker.handle(ControlRequest::submit(&ticket));
    if !matches!(
        submitted.status,
        ControlStatus::Queued | ControlStatus::Running | ControlStatus::Completed
    ) {
        return Err(submitted
            .error
            .unwrap_or("The update was not submitted.".into()));
    }
    let deadline = Instant::now() + Duration::from_secs(90);
    let mut delayed = false;
    loop {
        let reply = broker.handle(ControlRequest::result(&ticket));
        if reply.is_success() {
            return Ok(());
        }
        if !matches!(reply.status, ControlStatus::Queued | ControlStatus::Running) {
            return Err(reply
                .operation
                .and_then(|o| o.completion)
                .map(|c| match c {
                    crate::runtime_control::ControlCompletion::Error { error } => error.to_string(),
                    crate::runtime_control::ControlCompletion::Report { report } => {
                        report.message.unwrap_or("Plugin update failed.".into())
                    }
                })
                .or(reply.error)
                .unwrap_or("Plugin update status is unavailable.".into()));
        }
        if owner.strong_count() == 0 {
            return Err("Runtime stopped while checking the update receipt.".into());
        }
        if !delayed && Instant::now() >= deadline {
            delayed = true;
            publish(
                owner,
                batch,
                id,
                "checkingStatus",
                None,
                Some(
                    "Installation is taking longer than usual. Checking the original operation."
                        .into(),
                ),
                None,
            );
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
