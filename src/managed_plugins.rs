//! Explicit GitHub package registration and version selection. Provenance comes
//! only from the downloader's checked receipt. Installation storage is committed
//! after the previous runtime has stopped, retaining one installed version.
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::capabilities::CapabilityDescriptor;
use crate::catalog::PluginCatalogEntry;
use crate::github_distribution::{
    GitHubSource, PackageMetadata, PreparedGitHubPackage, inspect_prepared_package,
};
use crate::local_import::{self, LocalImportRequest};
use crate::local_plugins::{LocalPluginCandidate, inspect_local_plugin};
use crate::plugin_control::PluginControlError;
use crate::plugin_permissions::BrokerPolicy;
use crate::plugins::{LocalPluginRegistration, Permission, PluginManifest, PluginRegistry};

const MAX_HISTORY: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagedOperation {
    Install,
    Update,
    Adopt,
    Rollback,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ManagedVersion {
    pub version_key: String,
    pub package_path: PathBuf,
    pub content_digest: String,
    pub source: GitHubSource,
    pub manifest: PluginManifest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<PackageMetadata>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ManagedPluginRecord {
    pub current_version: Option<String>,
    pub history: Vec<ManagedVersion>,
}

impl ManagedPluginRecord {
    pub fn current(&self) -> Option<&ManagedVersion> {
        self.current_version.as_ref().and_then(|key| {
            self.history
                .iter()
                .find(|version| &version.version_key == key)
        })
    }

    pub(crate) fn validate(
        &self,
        id: &str,
        registration: Option<&LocalPluginRegistration>,
    ) -> Result<(), String> {
        if self.history.is_empty() || self.history.len() > MAX_HISTORY {
            return Err("version history must contain between 1 and 64 entries".into());
        }
        for (index, version) in self.history.iter().enumerate() {
            if version.manifest.id != id
                || !version.package_path.is_absolute()
                || !valid_digest(&version.version_key)
                || !valid_digest(&version.content_digest)
                || !valid_digest(&version.source.sha256)
                || self.history[..index]
                    .iter()
                    .any(|previous| previous.version_key == version.version_key)
            {
                return Err("invalid or duplicate managed version".into());
            }
            PluginManifest::parse(
                &serde_json::to_string(&version.manifest).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
        }
        if self.current_version.is_some() {
            let current = self
                .current()
                .ok_or("currentVersion must name a retained version")?;
            if registration.is_none_or(|registration| registration.path != current.package_path) {
                return Err("currentVersion must match the registered directory".into());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedChanges {
    pub permissions_added: Vec<Permission>,
    pub permissions_removed: Vec<Permission>,
    pub requirements_added: Vec<CapabilityDescriptor>,
    pub requirements_removed: Vec<CapabilityDescriptor>,
    pub provides_added: Vec<CapabilityDescriptor>,
    pub provides_removed: Vec<CapabilityDescriptor>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedPreview {
    pub schema: u32,
    pub kind: &'static str,
    pub operation: ManagedOperation,
    pub path: PathBuf,
    pub content_digest: String,
    pub registration_digest: String,
    pub manifest: PluginManifest,
    pub source: GitHubSource,
    pub metadata: Option<PackageMetadata>,
    pub device_compatibility: crate::github_distribution::DeviceCompatibility,
    pub existing_registration: Option<LocalPluginRegistration>,
    pub existing_enabled: bool,
    pub current_version: Option<ManagedVersion>,
    pub history: Vec<ManagedVersion>,
    pub changes: ManagedChanges,
    pub ownership: &'static str,
}

impl ManagedPreview {
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
            managed: Some(self.operation),
        })
    }
}

pub fn preview(
    registry: &PluginRegistry,
    path: &Path,
    operation: ManagedOperation,
) -> Result<ManagedPreview, PluginControlError> {
    let prepared = inspect_prepared_package(registry.path(), path)
        .map_err(|error| control_error("managed_package_invalid", error.to_string()))?;
    let candidate = inspect_local_plugin(&prepared.package_path)
        .map_err(|error| control_error("local_plugin_invalid", error.to_string()))?;
    preview_checked(registry, prepared, candidate, operation)
}

pub fn preview_rollback(
    registry: &PluginRegistry,
    plugin_id: &str,
    version_key: &str,
) -> Result<ManagedPreview, PluginControlError> {
    let record = registry.managed_plugins().get(plugin_id).ok_or_else(|| {
        control_error(
            "managed_plugin_required",
            "The selected plugin has no managed version history.",
        )
    })?;
    let version = record
        .history
        .iter()
        .find(|version| version.version_key == version_key)
        .ok_or_else(|| {
            control_error(
                "managed_version_not_found",
                "Choose a retained version from this plugin's history.",
            )
        })?;
    if version.package_path.try_exists().ok() == Some(false) {
        return Err(control_error(
            "managed_version_missing",
            "This retained version's source directory is missing or was explicitly deleted; download that release again.",
        ));
    }
    preview(registry, &version.package_path, ManagedOperation::Rollback)
}

/// Loader guard for startup, manual enable/reload and dependent replacements.
pub fn validate_current(
    registry: &PluginRegistry,
    plugin_id: &str,
) -> Result<(), PluginControlError> {
    let Some(record) = registry.managed_plugins().get(plugin_id) else {
        return Ok(());
    };
    let Some(version) = record.current() else {
        return Ok(());
    };
    let prepared = inspect_prepared_package(registry.path(), &version.package_path)
        .map_err(|error| control_error("managed_package_invalid", error.to_string()))?;
    let candidate = inspect_local_plugin(&version.package_path)
        .map_err(|error| control_error("managed_package_invalid", error.to_string()))?;
    if version.source != prepared.source
        || version.manifest != candidate.manifest
        || version.metadata != prepared.metadata
        || package_digest(&prepared, &candidate) != version.content_digest
    {
        return Err(control_error(
            "managed_version_changed",
            "Installed managed source or content no longer matches its explicitly confirmed version.",
        ));
    }
    Ok(())
}

fn preview_checked(
    registry: &PluginRegistry,
    prepared: PreparedGitHubPackage,
    candidate: LocalPluginCandidate,
    operation: ManagedOperation,
) -> Result<ManagedPreview, PluginControlError> {
    let id = &candidate.manifest.id;
    let record = registry.managed_plugins().get(id);
    let current = record.and_then(ManagedPluginRecord::current);
    match operation {
        ManagedOperation::Install if registry.local_plugins().contains_key(id) => {
            return Err(control_error(
                "registration_conflict",
                "This ID is already registered. Select an explicit managed update, or unregister it before trusting a different source.",
            ));
        }
        ManagedOperation::Update | ManagedOperation::Rollback => {
            let current = current
                .filter(|current| {
                    registry
                        .local_plugins()
                        .get(id)
                        .is_some_and(|registration| registration.path == current.package_path)
                })
                .ok_or_else(|| {
                    control_error(
                        "managed_plugin_required",
                        "Updates and rollbacks require an existing managed registration.",
                    )
                })?;
            if !same_repository(&current.source, &prepared.source) {
                return Err(control_error(
                    "managed_source_changed",
                    "A different repository cannot inherit this plugin ID or its trust. Unregister the current source and explicitly review a new installation.",
                ));
            }
        }
        ManagedOperation::Adopt
            if !crate::plugin_cli::official_seed::verified_installer_source(registry, id) =>
        {
            return Err(control_error(
                "installer_source_required",
                "This registration is not a verified installer package. Review it as a separate local source; Core will not take over its ID.",
            ));
        }
        _ => {}
    }
    let digest = package_digest(&prepared, &candidate);
    if operation == ManagedOperation::Rollback
        && record.is_none_or(|record| {
            !record.history.iter().any(|version| {
                version.package_path == candidate.root
                    && version.source == prepared.source
                    && version.content_digest == digest
                    && version.manifest == candidate.manifest
            })
        })
    {
        return Err(control_error(
            "managed_version_changed",
            "The rollback package no longer matches its retained source and content record.",
        ));
    }
    // Use the existing registration path validator on an isolated staged copy.
    let mut dry = registry.clone();
    if dry.local_plugins().contains_key(id) {
        dry.remove_local(id)
            .map_err(|e| control_error("registration_conflict", e.to_string()))?;
    }
    dry.register_local(
        id,
        LocalPluginRegistration {
            path: candidate.root.clone(),
            grants: candidate.manifest.permissions.clone(),
            broker_policy: BrokerPolicy::default(),
        },
    )
    .map_err(|e| control_error("registration_conflict", e.to_string()))?;
    let previous_manifest = if operation == ManagedOperation::Adopt {
        registry
            .local_plugins()
            .get(id)
            .and_then(|registration| inspect_local_plugin(&registration.path).ok())
            .map(|candidate| candidate.manifest)
    } else {
        None
    };
    let changes = changes(
        current
            .map(|version| &version.manifest)
            .or(previous_manifest.as_ref()),
        &candidate.manifest,
    );
    let device_compatibility =
        crate::github_distribution::device_compatibility(prepared.metadata.as_ref());
    Ok(ManagedPreview {
        schema: 1,
        kind: "codlet.managed-preview",
        operation,
        path: candidate.root,
        content_digest: digest,
        registration_digest: local_import::registration_digest(registry, id),
        existing_registration: registry.local_plugins().get(id).cloned(),
        existing_enabled: registry.is_enabled(id),
        current_version: current.cloned(),
        history: record
            .map(|record| record.history.clone())
            .unwrap_or_default(),
        manifest: candidate.manifest,
        source: prepared.source,
        metadata: prepared.metadata,
        device_compatibility,
        changes,
        ownership: "core-managed-github",
    })
}

/// Shared atomic staging for offline CLI and the running foreground coordinator.
/// Only save() makes the selected registration and its history durable together.
pub fn stage(
    registry: &PluginRegistry,
    id: &str,
    request: &LocalImportRequest,
) -> Result<(PluginRegistry, PluginCatalogEntry), PluginControlError> {
    request.validate()?;
    let operation = request.managed.ok_or_else(|| {
        control_error(
            "managed_preview_required",
            "Use an explicit managed preview.",
        )
    })?;
    if local_import::registration_digest(registry, id) != request.registration_digest {
        return Err(control_error(
            "import_registration_changed",
            "The registration, permissions, enabled preference or managed history changed after preview.",
        ));
    }
    let prepared = inspect_prepared_package(registry.path(), &request.path)
        .map_err(|error| control_error("managed_package_invalid", error.to_string()))?;
    let candidate = inspect_local_plugin(&request.path)
        .map_err(|error| control_error("local_plugin_invalid", error.to_string()))?;
    stage_checked(registry, id, request, prepared, candidate, operation)
}

fn stage_checked(
    registry: &PluginRegistry,
    id: &str,
    request: &LocalImportRequest,
    prepared: PreparedGitHubPackage,
    candidate: LocalPluginCandidate,
    operation: ManagedOperation,
) -> Result<(PluginRegistry, PluginCatalogEntry), PluginControlError> {
    let preview = preview_checked(registry, prepared, candidate, operation)?;
    crate::github_distribution::require_device_compatibility(preview.metadata.as_ref())
        .map_err(|error| control_error("managed_package_incompatible", error.to_string()))?;
    if preview.manifest.id != id
        || preview.path != request.path
        || preview.content_digest != request.content_digest
    {
        return Err(control_error(
            "import_content_changed",
            "The selected package changed after preview; inspect it again.",
        ));
    }
    let candidate = inspect_local_plugin(&request.path)
        .map_err(|error| control_error("local_plugin_invalid", error.to_string()))?;
    // Rechecking after preview prevents a directory edit from escaping the digest.
    let prepared = inspect_prepared_package(registry.path(), &request.path)
        .map_err(|error| control_error("managed_package_invalid", error.to_string()))?;
    if package_digest(&prepared, &candidate) != request.content_digest {
        return Err(control_error(
            "import_content_changed",
            "Package content changed during staging.",
        ));
    }
    let entry = local_import::checked_entry(candidate, request)?;
    let registration = entry
        .plugin
        .as_ref()
        .expect("validated entry")
        .authorization
        .clone()
        .expect("explicit trust");
    let version = ManagedVersion {
        version_key: local_import::digest(&(
            &preview.path,
            &preview.source,
            &preview.content_digest,
        )),
        package_path: preview.path,
        source: preview.source,
        content_digest: preview.content_digest,
        manifest: preview.manifest,
        metadata: preview.metadata,
    };
    let mut record = registry
        .managed_plugins()
        .get(id)
        .cloned()
        .unwrap_or_default();
    record.current_version = Some(version.version_key.clone());
    if !record
        .history
        .iter()
        .any(|previous| previous.version_key == version.version_key)
    {
        if record.history.len() >= MAX_HISTORY {
            record.history = record.current().cloned().into_iter().collect();
        }
        record.history.push(version);
    }
    let mut next = registry.clone();
    next.register_managed(id, registration, record)
        .map_err(|error| control_error("registration_conflict", error.to_string()))?;
    next.set_enabled(id, false)
        .map_err(|error| control_error("registry_error", error.to_string()))?;
    Ok((next, entry))
}

pub(crate) fn registration_at_path(
    registry: &PluginRegistry,
    id: &str,
    target: &Path,
) -> Result<PluginRegistry, PluginControlError> {
    let old = registry
        .managed_plugins()
        .get(id)
        .and_then(ManagedPluginRecord::current)
        .ok_or_else(|| {
            control_error(
                "managed_version_missing",
                "The selected managed package is no longer registered.",
            )
        })?;
    let prepared = inspect_prepared_package(registry.path(), target)
        .map_err(|e| control_error("managed_package_invalid", e.to_string()))?;
    if prepared.source != old.source
        || prepared.manifest != old.manifest
        || prepared.metadata != old.metadata
    {
        return Err(control_error(
            "import_content_changed",
            "The installation differs from the selected package.",
        ));
    }
    let candidate = inspect_local_plugin(target)
        .map_err(|e| control_error("local_plugin_invalid", e.to_string()))?;
    let content_digest = package_digest(&prepared, &candidate);
    let mut registration = registry
        .local_plugins()
        .get(id)
        .expect("managed current registration")
        .clone();
    registration.path = target.into();
    let version = ManagedVersion {
        version_key: local_import::digest(&(target, &prepared.source, &content_digest)),
        package_path: target.into(),
        content_digest,
        source: prepared.source,
        manifest: prepared.manifest,
        metadata: prepared.metadata,
    };
    let record = ManagedPluginRecord {
        current_version: Some(version.version_key.clone()),
        history: vec![version],
    };
    let mut next = registry.clone();
    next.register_managed(id, registration, record)
        .map_err(|e| control_error("registration_conflict", e.to_string()))?;
    Ok(next)
}

pub(crate) fn at_installation_path(
    registry: &PluginRegistry,
    id: &str,
    target: &Path,
) -> Result<(PluginRegistry, PluginCatalogEntry), PluginControlError> {
    let next = registration_at_path(registry, id, target)?;
    let candidate = inspect_local_plugin(target)
        .map_err(|e| control_error("local_plugin_invalid", e.to_string()))?;
    let registration = &next.local_plugins()[id];
    let request = LocalImportRequest {
        path: target.into(),
        content_digest: next.managed_plugins()[id]
            .current()
            .unwrap()
            .content_digest
            .clone(),
        registration_digest: local_import::registration_digest(&next, id),
        trusted: true,
        grants: registration.grants.clone(),
        broker_policy: registration.broker_policy.clone(),
        enable: next.is_enabled(id),
        managed: Some(ManagedOperation::Update),
    };
    let entry = local_import::checked_entry(candidate, &request)?;
    Ok((next, entry))
}

/// Restore only if the full candidate registration and provenance still belong
/// to this transaction. Concurrent revocations or source edits are never undone.
pub(crate) fn restore_previous(
    expected: &PluginRegistry,
    previous: &PluginRegistry,
    id: &str,
) -> Result<PluginRegistry, PluginControlError> {
    let current = PluginRegistry::load(expected.path())
        .map_err(|e| control_error("registry_error", e.to_string()))?;
    if current.local_plugins().get(id) == previous.local_plugins().get(id)
        && current.managed_plugins().get(id) == previous.managed_plugins().get(id)
        && current.is_enabled(id) == previous.is_enabled(id)
    {
        crate::managed_storage::clear_registration_checkpoint(&current, id)?;
        return Ok(current);
    }
    if current.local_plugins().get(id) != expected.local_plugins().get(id)
        || current.managed_plugins().get(id) != expected.managed_plugins().get(id)
        || current.is_enabled(id) != expected.is_enabled(id)
    {
        return Err(control_error(
            "managed_restore_conflict",
            "Concurrent trust, version or enabled changes prevent automatic registration restoration; affected packages remain stopped.",
        ));
    }
    let mut restored = current;
    restored.restore_managed(
        id,
        previous.local_plugins().get(id).cloned(),
        previous.managed_plugins().get(id).cloned(),
    );
    restored
        .set_enabled(id, previous.is_enabled(id))
        .map_err(|e| control_error("registry_error", e.to_string()))?;
    restored
        .save()
        .map_err(|e| control_error("registry_error", e.to_string()))?;
    crate::managed_storage::clear_registration_checkpoint(&restored, id)?;
    Ok(restored)
}

fn same_repository(left: &GitHubSource, right: &GitHubSource) -> bool {
    left.owner.eq_ignore_ascii_case(&right.owner)
        && left.repository.eq_ignore_ascii_case(&right.repository)
        && left
            .repository_url
            .eq_ignore_ascii_case(&right.repository_url)
        && left
            .repository_id
            .is_none_or(|id| right.repository_id == Some(id))
        && left.owner_id.is_none_or(|id| right.owner_id == Some(id))
}
fn package_digest(prepared: &PreparedGitHubPackage, candidate: &LocalPluginCandidate) -> String {
    local_import::digest(&(
        local_import::content_digest(candidate),
        &prepared.source,
        &prepared.metadata,
    ))
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn changes(previous: Option<&PluginManifest>, next: &PluginManifest) -> ManagedChanges {
    let old_permissions = previous
        .map(|manifest| manifest.permissions.clone())
        .unwrap_or_default();
    let old_requires = previous
        .map(|manifest| manifest.all_requires().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let old_provides = previous
        .map(|manifest| manifest.all_provides().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let next_requires = next.all_requires().cloned().collect::<Vec<_>>();
    let next_provides = next.all_provides().cloned().collect::<Vec<_>>();
    ManagedChanges {
        permissions_added: difference(&next.permissions, &old_permissions),
        permissions_removed: difference(&old_permissions, &next.permissions),
        requirements_added: difference(&next_requires, &old_requires),
        requirements_removed: difference(&old_requires, &next_requires),
        provides_added: difference(&next_provides, &old_provides),
        provides_removed: difference(&old_provides, &next_provides),
    }
}
fn difference<T: PartialEq + Clone>(left: &[T], right: &[T]) -> Vec<T> {
    left.iter()
        .filter(|item| !right.contains(item))
        .cloned()
        .collect()
}
fn control_error(code: &str, message: impl Into<String>) -> PluginControlError {
    PluginControlError::new(code, message)
}

#[cfg(test)]
mod tests;
