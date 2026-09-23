//! Read-only local import previews and the shared CLI/GUI registration transaction.
//! Previewing reads bounded manifest/entry text through the normal checked loader.
//! It never evaluates JavaScript, runs build scripts, or copies/deletes author files.
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::catalog::{PluginCatalogEntry, PluginSource, validate_renderer_requirements};
use crate::local_plugins::{LocalPluginCandidate, inspect_local_plugin};
use crate::plugin_control::PluginControlError;
use crate::plugin_permissions::BrokerPolicy;
use crate::plugins::{
    LoadedPlugin, LocalPluginRegistration, Permission, PluginManifest, PluginRegistry,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LocalImportRequest {
    pub path: PathBuf,
    pub content_digest: String,
    pub registration_digest: String,
    pub trusted: bool,
    pub grants: Vec<Permission>,
    #[serde(default)]
    pub broker_policy: BrokerPolicy,
    #[serde(default)]
    pub enable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed: Option<crate::managed_plugins::ManagedOperation>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalImportPreview {
    pub schema: u32,
    pub kind: &'static str,
    pub path: PathBuf,
    pub content_digest: String,
    pub registration_digest: String,
    pub manifest: PluginManifest,
    pub metadata: Option<crate::github_distribution::PackageMetadata>,
    pub device_compatibility: crate::github_distribution::DeviceCompatibility,
    pub existing_registration: Option<LocalPluginRegistration>,
    pub existing_enabled: bool,
    pub ownership: &'static str,
}

impl LocalImportRequest {
    pub fn validate(&self) -> Result<(), PluginControlError> {
        if !self.trusted {
            return Err(error(
                "trust_required",
                "Explicitly trust the selected package before registering it.",
            ));
        }
        crate::plugin_permissions::validate_policy_path(&self.path)
            .map_err(|e| error("invalid_import_path", e.to_string()))?;
        if [&self.content_digest, &self.registration_digest]
            .iter()
            .any(|digest| {
                digest.len() != 64
                    || !digest
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
        {
            return Err(error(
                "invalid_import_preview",
                "Use the digests returned by a fresh local import preview.",
            ));
        }
        // Deserialization accepts only the finite Permission enum. Requiring
        // uniqueness bounds this list without freezing the old permission count.
        if self
            .grants
            .iter()
            .enumerate()
            .any(|(i, grant)| self.grants[..i].contains(grant))
        {
            return Err(error(
                "invalid_import_grants",
                "Specify each supported permission once.",
            ));
        }
        self.broker_policy
            .validate_grants(&self.grants)
            .map_err(|e| error("invalid_broker_policy", e.to_string()))
    }
}

impl LocalImportPreview {
    pub fn request(
        &self,
        grants: Vec<Permission>,
        broker_policy: BrokerPolicy,
        enable: bool,
    ) -> Box<LocalImportRequest> {
        Box::new(LocalImportRequest {
            path: self.path.clone(),
            content_digest: self.content_digest.clone(),
            registration_digest: self.registration_digest.clone(),
            trusted: true,
            grants,
            broker_policy,
            enable,
            managed: None,
        })
    }
}

pub fn preview(
    registry: &PluginRegistry,
    path: &Path,
) -> Result<LocalImportPreview, PluginControlError> {
    let candidate =
        inspect_local_plugin(path).map_err(|e| error("local_plugin_invalid", e.to_string()))?;
    if registry
        .managed_plugins()
        .get(&candidate.manifest.id)
        .and_then(crate::managed_plugins::ManagedPluginRecord::current)
        .is_some()
    {
        return Err(error(
            "managed_preview_required",
            "Use a managed update preview to change a managed registration or its grants.",
        ));
    }
    // A dry staged registration checks reserved IDs, source collisions and aliases.
    let mut dry = registry.clone();
    dry.register_local(
        &candidate.manifest.id,
        LocalPluginRegistration {
            path: candidate.root.clone(),
            grants: candidate.manifest.permissions.clone(),
            broker_policy: BrokerPolicy::default(),
        },
    )
    .map_err(|e| error("registration_conflict", e.to_string()))?;
    let id = &candidate.manifest.id;
    let metadata = crate::github_distribution::read_metadata(&candidate.root)
        .map_err(|e| error("package_metadata_invalid", e.to_string()))?;
    let device_compatibility = crate::github_distribution::device_compatibility(metadata.as_ref());
    Ok(LocalImportPreview {
        schema: 1,
        kind: "codlet.local-import-preview",
        path: candidate.root.clone(),
        content_digest: digest(&(content_digest(&candidate), &metadata)),
        registration_digest: registration_digest(registry, id),
        existing_registration: registry.local_plugins().get(id).cloned(),
        existing_enabled: registry.is_enabled(id),
        manifest: candidate.manifest,
        metadata,
        device_compatibility,
        ownership: "development-directory",
    })
}

/// Recheck both the selected content and registration before staging any write.
/// The returned entry retains exactly these verified bytes for later activation.
pub(crate) fn stage(
    registry: &PluginRegistry,
    id: &str,
    request: &LocalImportRequest,
) -> Result<(PluginRegistry, PluginCatalogEntry), PluginControlError> {
    if request.managed.is_some() {
        return crate::managed_plugins::stage(registry, id, request);
    }
    request.validate()?;
    if registry
        .managed_plugins()
        .get(id)
        .and_then(crate::managed_plugins::ManagedPluginRecord::current)
        .is_some()
    {
        return Err(error(
            "managed_preview_required",
            "A managed registration requires a managed preview.",
        ));
    }
    if registration_digest(registry, id) != request.registration_digest {
        return Err(error(
            "import_registration_changed",
            "The registration or enabled preference changed after preview. Inspect the directory again.",
        ));
    }
    let candidate = inspect_local_plugin(&request.path)
        .map_err(|e| error("local_plugin_invalid", e.to_string()))?;
    let metadata = crate::github_distribution::read_metadata(&candidate.root)
        .map_err(|e| error("package_metadata_invalid", e.to_string()))?;
    crate::github_distribution::require_device_compatibility(metadata.as_ref())
        .map_err(|e| error("package_incompatible", e.to_string()))?;
    if candidate.manifest.id != id
        || candidate.root != request.path
        || digest(&(content_digest(&candidate), &metadata)) != request.content_digest
    {
        return Err(error(
            "import_content_changed",
            "The directory, manifest or entry changed after preview. Inspect the directory again.",
        ));
    }
    let entry = checked_entry(candidate, request)?;
    let registration = entry
        .plugin
        .as_ref()
        .expect("validated entry")
        .authorization
        .clone()
        .expect("explicit authorization");
    let mut next = registry.clone();
    next.register_local(id, registration)
        .map_err(|e| error("registration_conflict", e.to_string()))?;
    next.set_enabled(id, false)
        .map_err(|e| error("registry_error", e.to_string()))?;
    Ok((next, entry))
}

pub(crate) fn checked_entry(
    mut candidate: LocalPluginCandidate,
    request: &LocalImportRequest,
) -> Result<PluginCatalogEntry, PluginControlError> {
    let id = candidate.manifest.id.clone();
    candidate
        .validate_grants(&request.grants)
        .map_err(|e| error("permission_required", e.to_string()))?;
    // Revalidate explicit scopes through the same canonicalizer used by the CLI.
    let broker_policy = request
        .broker_policy
        .canonicalized()
        .map_err(|e| error("invalid_broker_policy", e.to_string()))?;
    if broker_policy != request.broker_policy {
        return Err(error(
            "broker_scope_changed",
            "A broker scope resolves differently from the confirmed value. Use its canonical path or normalized origin.",
        ));
    }
    let registration = LocalPluginRegistration {
        path: candidate.root.clone(),
        grants: request.grants.clone(),
        broker_policy,
    };
    if let Some(host) = &mut candidate.host {
        host.authorization = Some(registration.clone());
    }
    let plugin = validate_renderer_requirements(
        LoadedPlugin {
            manifest: candidate.manifest,
            source: candidate.source,
            host: candidate.host,
            generation: 1,
            authorization: Some(registration.clone()),
        },
        &candidate.root,
    )
    .map_err(|e| error("local_plugin_invalid", e.to_string()))?;
    let entry = PluginCatalogEntry {
        id,
        source: PluginSource::Local {
            path: candidate.root,
            grants: request.grants.clone(),
        },
        plugin: Ok(plugin),
    };
    Ok(entry)
}

pub(crate) fn content_digest(candidate: &LocalPluginCandidate) -> String {
    digest(&(
        candidate.root.as_path(),
        &candidate.manifest,
        candidate.source.as_deref(),
        candidate.host.as_ref().map(|host| host.source.as_ref()),
    ))
}
pub(crate) fn registration_digest(registry: &PluginRegistry, id: &str) -> String {
    digest(&(
        id,
        registry.local_plugins().get(id),
        registry.managed_plugins().get(id),
        registry.is_enabled(id),
    ))
}
pub(crate) fn digest(value: &impl Serialize) -> String {
    let bytes = serde_json::to_vec(value).expect("import snapshot is serializable");
    format!("{:x}", Sha256::digest(bytes))
}
fn error(code: &str, message: impl Into<String>) -> PluginControlError {
    PluginControlError::new(code, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> (tempfile::TempDir, PluginRegistry, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("author folder 测试");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("codlet.json"), json!({"schema":1,"id":"dev.import","name":"Import fixture","version":"1","renderer":{"entry":"entry.js","world":"isolated"},"permissions":["ui.dom"]}).to_string()).unwrap();
        std::fs::write(
            root.join("entry.js"),
            "throw new Error('preview and registration must never execute this');",
        )
        .unwrap();
        let registry = PluginRegistry::load(directory.path().join("config.json")).unwrap();
        (directory, registry, root)
    }

    #[test]
    fn preview_and_staging_do_not_execute_write_copy_or_delete_author_files() {
        let (_directory, registry, root) = fixture();
        let before = std::fs::read(root.join("entry.js")).unwrap();
        let preview = preview(&registry, &root).unwrap();
        assert_eq!(preview.ownership, "development-directory");
        assert!(preview.existing_registration.is_none());
        assert!(!registry.path().exists());
        let request = preview.request(vec![Permission::UiDom], BrokerPolicy::default(), true);
        let (mut staged, entry) = stage(&registry, "dev.import", &request).unwrap();
        assert!(!registry.path().exists());
        assert!(!staged.is_enabled("dev.import"));
        assert_eq!(entry.plugin.unwrap().source.unwrap().as_bytes(), before);
        staged.save().unwrap();
        assert_eq!(
            staged.local_plugins()["dev.import"].path,
            std::fs::canonicalize(&root).unwrap()
        );
        assert_eq!(std::fs::read(root.join("entry.js")).unwrap(), before);
        assert_eq!(std::fs::read_dir(root).unwrap().count(), 2);
    }

    #[test]
    fn imports_many_declared_permissions_without_relaxing_duplicate_or_enum_checks() {
        let (_directory, registry, root) = fixture();
        let grants = vec![
            Permission::UiDom,
            Permission::HostProcess,
            Permission::CoreStorage,
            Permission::CoreEvents,
            Permission::CoreTasks,
            Permission::CoreDiagnostics,
            Permission::HostSystem,
            Permission::HostFs,
            Permission::HostFsWrite,
            Permission::HostFsWatch,
            Permission::HostNetwork,
            Permission::CoreNetwork,
            Permission::HostProcessSpawn,
            Permission::CoreNotifications,
        ];
        let manifest_path = root.join("codlet.json");
        let mut manifest: PluginManifest =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        manifest.permissions = grants.clone();
        manifest.host = Some(serde_json::from_value(json!({"entry": "host.cjs"})).unwrap());
        std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        std::fs::write(
            root.join("host.cjs"),
            "throw new Error('registration must not execute the Host entry');",
        )
        .unwrap();
        let candidate = preview(&registry, &root).unwrap();
        let mut request = candidate.request(grants.clone(), BrokerPolicy::default(), false);
        let (mut staged, entry) = stage(&registry, "dev.import", &request).unwrap();
        assert_eq!(entry.plugin.unwrap().manifest.permissions, grants);
        staged.save().unwrap();
        let saved = PluginRegistry::load(registry.path()).unwrap();
        assert_eq!(saved.local_plugins()["dev.import"].grants, grants);
        assert!(!saved.is_enabled("dev.import"));

        request.grants.push(Permission::UiDom);
        assert_eq!(
            request.validate().unwrap_err().code,
            "invalid_import_grants"
        );
        let mut invalid = serde_json::to_value(&request).unwrap();
        invalid["grants"] = json!(["permission.not.supported"]);
        assert!(serde_json::from_value::<LocalImportRequest>(invalid).is_err());
    }

    #[test]
    fn changed_entry_or_manifest_rejects_the_preview_before_registration() {
        for manifest_changed in [false, true] {
            let (_directory, registry, root) = fixture();
            let preview = preview(&registry, &root).unwrap();
            let request = preview.request(vec![Permission::UiDom], BrokerPolicy::default(), false);
            if manifest_changed {
                let mut manifest = preview.manifest;
                manifest.version = "2".into();
                std::fs::write(
                    root.join("codlet.json"),
                    serde_json::to_vec(&manifest).unwrap(),
                )
                .unwrap();
            } else {
                std::fs::write(root.join("entry.js"), "module.exports={};").unwrap();
            }
            assert_eq!(
                stage(&registry, "dev.import", &request).unwrap_err().code,
                "import_content_changed"
            );
            assert!(!registry.path().exists());
        }
    }

    #[test]
    fn local_metadata_is_declared_checked_and_bound_to_the_review_digest() {
        let (_directory, registry, root) = fixture();
        let metadata = root.join("codlet-package.json");
        std::fs::write(
            &metadata,
            json!({"schema":1,"runtimeApi":1,"platforms":["any"],"author":"Original"}).to_string(),
        )
        .unwrap();
        let candidate = preview(&registry, &root).unwrap();
        assert_eq!(candidate.device_compatibility.status, "compatible");
        let request = candidate.request(vec![Permission::UiDom], BrokerPolicy::default(), false);
        std::fs::write(
            &metadata,
            json!({"schema":1,"runtimeApi":1,"platforms":["any"],"author":"Changed"}).to_string(),
        )
        .unwrap();
        assert_eq!(
            stage(&registry, "dev.import", &request).unwrap_err().code,
            "import_content_changed"
        );
        std::fs::write(
            &metadata,
            json!({"schema":1,"runtimeApi":1,"platforms":["otheros"]}).to_string(),
        )
        .unwrap();
        let incompatible = preview(&registry, &root).unwrap();
        assert_eq!(incompatible.device_compatibility.status, "incompatible");
        assert_eq!(
            stage(
                &registry,
                "dev.import",
                &incompatible.request(vec![Permission::UiDom], BrokerPolicy::default(), false)
            )
            .unwrap_err()
            .code,
            "package_incompatible"
        );
        assert!(
            crate::local_plugins::load_local_plugin("dev.import", &root, &[Permission::UiDom], 1)
                .is_err()
        );
    }

    #[test]
    fn changed_registration_or_enablement_requires_a_fresh_preview() {
        for change_grants in [false, true] {
            let (_directory, mut registry, root) = fixture();
            let candidate = preview(&registry, &root).unwrap();
            let request =
                candidate.request(vec![Permission::UiDom], BrokerPolicy::default(), false);
            if change_grants {
                registry
                    .register_local(
                        "dev.import",
                        LocalPluginRegistration {
                            path: candidate.path,
                            grants: vec![],
                            broker_policy: BrokerPolicy::default(),
                        },
                    )
                    .unwrap();
            } else {
                registry.set_enabled("dev.import", false).unwrap();
            }
            registry.save().unwrap();
            let before = std::fs::read(registry.path()).unwrap();
            assert_eq!(
                stage(&registry, "dev.import", &request).unwrap_err().code,
                "import_registration_changed"
            );
            assert_eq!(std::fs::read(registry.path()).unwrap(), before);
        }
    }

    #[test]
    fn explicit_trust_and_all_requested_grants_are_required() {
        let (_directory, registry, root) = fixture();
        let preview = preview(&registry, &root).unwrap();
        let mut request = preview.request(vec![], BrokerPolicy::default(), false);
        assert_eq!(
            stage(&registry, "dev.import", &request).unwrap_err().code,
            "permission_required"
        );
        request.grants = vec![Permission::UiDom];
        request.trusted = false;
        assert_eq!(
            stage(&registry, "dev.import", &request).unwrap_err().code,
            "trust_required"
        );
        request.trusted = true;
        request.grants.push(Permission::UiDom);
        assert_eq!(
            stage(&registry, "dev.import", &request).unwrap_err().code,
            "invalid_import_grants"
        );
        assert!(!registry.path().exists());
    }

    #[test]
    fn another_source_cannot_inherit_an_existing_identity_or_its_grants() {
        let (directory, mut registry, root) = fixture();
        let other = directory.path().join("other author");
        std::fs::create_dir(&other).unwrap();
        registry
            .register_local(
                "dev.import",
                LocalPluginRegistration {
                    path: std::fs::canonicalize(other).unwrap(),
                    grants: vec![Permission::UiDom],
                    broker_policy: BrokerPolicy::default(),
                },
            )
            .unwrap();
        registry.save().unwrap();
        assert_eq!(
            preview(&registry, &root).unwrap_err().code,
            "registration_conflict"
        );
    }

    #[test]
    fn registration_commit_keeps_the_existing_concurrent_writer_guard() {
        let (_directory, registry, root) = fixture();
        let preview = preview(&registry, &root).unwrap();
        let request = preview.request(vec![Permission::UiDom], BrokerPolicy::default(), false);
        let (mut staged, _) = stage(&registry, "dev.import", &request).unwrap();
        let mut other = PluginRegistry::load(registry.path()).unwrap();
        other
            .register_local(
                "dev.import",
                LocalPluginRegistration {
                    path: preview.path,
                    grants: vec![],
                    broker_policy: BrokerPolicy::default(),
                },
            )
            .unwrap();
        other.save().unwrap();
        assert!(staged.save().is_err());
        assert!(
            PluginRegistry::load(registry.path())
                .unwrap()
                .local_plugins()["dev.import"]
                .grants
                .is_empty()
        );
    }
}
