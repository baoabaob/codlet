//! Read-only update channels are distinct from downloaded GitHub provenance.
//! Local author folders have no channel unless a verified installer receipt binds it.
use crate::github_distribution::{GitHubClient, GitHubRepository, GitHubSource};
use crate::local_import::{digest, registration_digest};
use crate::managed_plugins::ManagedOperation;
use crate::plugins::{PluginManifest, PluginRegistry};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateChannel {
    pub kind: String,
    pub repository_url: String,
    pub repository_id: Option<u64>,
    pub owner_id: Option<u64>,
    pub asset_name_template: String,
}

#[cfg(test)]
pub(crate) fn fixture_seed(root: &std::path::Path, id: &str) -> PluginRegistry {
    use serde_json::json;
    use sha2::{Digest, Sha256};
    let home = root.canonicalize().unwrap();
    let folder = home.join("packages").join(id);
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("codlet.json"),json!({"schema":1,"id":id,"version":"1.0.0","renderer":{"entry":"entry.js","world":"isolated"},"permissions":["ui.dom"]}).to_string()).unwrap();
    std::fs::write(
        folder.join("entry.js"),
        "module.exports={activate(){},deactivate(){}};",
    )
    .unwrap();
    let files: Vec<_> = ["codlet.json", "entry.js"]
        .into_iter()
        .map(|name| {
            let b = std::fs::read(folder.join(name)).unwrap();
            json!({"path":name,"bytes":b.len(),"sha256":format!("{:x}",Sha256::digest(b))})
        })
        .collect();
    let receipts = home.join(".official-seed-transactions");
    std::fs::create_dir_all(&receipts).unwrap();
    std::fs::write(receipts.join(format!("{id}.receipt.json")),json!({"schema":1,"source":"official-installer","package":{"id":id,"version":"1.0.0","permissions":["ui.dom"],"files":files,"updateSource":{"kind":"github","repositoryUrl":"https://github.com/dev-owner/dev-repo","repositoryId":42,"ownerId":7,"assetNameTemplate":"plugin.zip"}}}).to_string()).unwrap();
    let mut registry = PluginRegistry::load(home.join("config.json")).unwrap();
    registry
        .register_local(
            id,
            crate::plugins::LocalPluginRegistration {
                path: folder,
                grants: vec![crate::plugins::Permission::UiDom],
                broker_policy: Default::default(),
            },
        )
        .unwrap();
    registry.set_enabled(id, false).unwrap();
    registry.save().unwrap();
    registry
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verified_seed_source_preserves_identity_without_inventing_a_github_receipt() {
        let temp = tempfile::tempdir().unwrap();
        let registry = fixture_seed(temp.path(), "dev.seed");
        let source = PluginUpdateSource::load(&registry, "dev.seed").unwrap();
        assert_eq!(source.operation, ManagedOperation::Adopt);
        assert_eq!(source.ownership, "installer-seed");
        assert!(registry.managed_plugins().is_empty());
        let receipt = temp
            .path()
            .join(".official-seed-transactions/dev.seed.receipt.json");
        let original = std::fs::read(&receipt).unwrap();
        let mut changed: serde_json::Value = serde_json::from_slice(&original).unwrap();
        changed["package"]["updateSource"]["ownerId"] = serde_json::json!(8);
        std::fs::write(&receipt, changed.to_string()).unwrap();
        assert_ne!(
            PluginUpdateSource::load(&registry, "dev.seed")
                .unwrap()
                .version_key,
            source.version_key
        );
        std::fs::write(&receipt, &original).unwrap();
        std::fs::write(
            registry.local_plugins()["dev.seed"].path.join("author.txt"),
            "keep",
        )
        .unwrap();
        assert!(PluginUpdateSource::load(&registry, "dev.seed").is_none());
        std::fs::remove_file(registry.local_plugins()["dev.seed"].path.join("author.txt")).unwrap();
        std::fs::remove_file(&receipt).unwrap();
        assert!(PluginUpdateSource::load(&registry, "dev.seed").is_none());
    }
}
impl UpdateChannel {
    pub(crate) fn validate(&self, installer: bool) -> Result<(), String> {
        let repository =
            GitHubRepository::parse(&self.repository_url).map_err(|e| e.to_string())?;
        if self.kind != "github"
            || repository.url != self.repository_url
            || self.repository_id == Some(0)
            || self.owner_id == Some(0)
            || self.repository_id.is_some() != self.owner_id.is_some()
            || installer && self.repository_id.is_none()
            || self.asset_name_template.is_empty()
            || self.asset_name_template.len() > 255
            || self.asset_name_template.contains(['/', '\\'])
            || self.asset_name_template.chars().any(char::is_control)
        {
            return Err("Invalid update channel identity or asset template".into());
        }
        Ok(())
    }
    pub(crate) fn accepts(&self, source: &GitHubSource) -> bool {
        source
            .repository_url
            .eq_ignore_ascii_case(&self.repository_url)
            && self
                .repository_id
                .is_none_or(|id| source.repository_id == Some(id))
            && self.owner_id.is_none_or(|id| source.owner_id == Some(id))
    }
    pub(crate) async fn verify_identity(&self, client: &GitHubClient) -> Result<(), String> {
        client
            .verify_update_identity(
                &GitHubRepository::parse(&self.repository_url).map_err(|e| e.to_string())?,
                self.repository_id,
                self.owner_id,
            )
            .await
            .map_err(|e| e.to_string())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginUpdateSource {
    #[serde(flatten)]
    pub channel: UpdateChannel,
    pub ownership: &'static str,
    pub version_key: String,
    pub operation: ManagedOperation,
    #[serde(skip)]
    pub manifest: PluginManifest,
    #[serde(skip)]
    pub release_id: Option<u64>,
    #[serde(skip)]
    pub comparison_version: String,
}
impl PluginUpdateSource {
    pub(crate) fn load(registry: &PluginRegistry, id: &str) -> Option<Self> {
        if let Some(version) = registry.managed_plugins().get(id).and_then(|r| r.current()) {
            let source = &version.source;
            let channel = UpdateChannel {
                kind: "github".into(),
                repository_url: source.repository_url.clone(),
                repository_id: source.repository_id,
                owner_id: source.owner_id,
                asset_name_template: source.asset_name.replace(
                    source.tag.strip_prefix('v').unwrap_or(&source.tag),
                    "{version}",
                ),
            };
            channel.validate(false).ok()?;
            return Some(Self {
                channel,
                ownership: "core-managed-github",
                version_key: digest(&(registration_digest(registry, id), version)),
                operation: ManagedOperation::Update,
                manifest: version.manifest.clone(),
                release_id: Some(source.release_id),
                comparison_version: source.tag.strip_prefix('v').unwrap_or(&source.tag).into(),
            });
        }
        let (manifest, channel, proof) =
            crate::plugin_cli::official_seed::verified_update_channel(registry, id)?;
        Some(Self {
            version_key: digest(&(registration_digest(registry, id), &channel, proof)),
            channel,
            ownership: "installer-seed",
            operation: ManagedOperation::Adopt,
            comparison_version: manifest.version.clone(),
            manifest,
            release_id: None,
        })
    }
    pub(crate) fn all(registry: &PluginRegistry) -> Vec<(String, Self)> {
        registry
            .local_plugins()
            .keys()
            .filter_map(|id| Self::load(registry, id).map(|s| (id.clone(), s)))
            .collect()
    }
}
