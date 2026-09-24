use super::*;
use crate::plugin_permissions::BrokerPolicy;
use crate::plugins::Permission;
use std::io::{Cursor, Write};

fn package(
    registry: &PluginRegistry,
    version: &str,
    permissions: &[&str],
) -> crate::github_distribution::PreparedGitHubPackage {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file("codlet.json", options).unwrap();
    zip.write_all(serde_json::json!({"schema":1,"id":"dev.update-test","version":version,"renderer":{"entry":"entry.js","world":"isolated"},"permissions":permissions}).to_string().as_bytes()).unwrap();
    zip.start_file("entry.js", options).unwrap();
    zip.write_all(b"module.exports={activate(){},deactivate(){}};")
        .unwrap();
    crate::github_distribution::test_prepare_archive_identity(
        registry.path(),
        &zip.finish().unwrap().into_inner(),
        Some((42, 7)),
    )
    .unwrap()
}
fn prepared() -> (tempfile::TempDir, ManagedPreview) {
    let temp = tempfile::tempdir().unwrap();
    let registry = PluginRegistry::load(temp.path().join("config.json")).unwrap();
    let old = package(&registry, "1.0.0", &["ui.dom"]);
    let old =
        crate::managed_plugins::preview(&registry, &old.package_path, ManagedOperation::Install)
            .unwrap();
    let (mut registry, _) = crate::managed_plugins::stage(
        &registry,
        "dev.update-test",
        &old.request(vec![Permission::UiDom], BrokerPolicy::default(), false),
    )
    .unwrap();
    registry.save().unwrap();
    let next = package(&registry, "1.1.0", &["ui.dom"]);
    let preview =
        crate::managed_plugins::preview(&registry, &next.package_path, ManagedOperation::Update)
            .unwrap();
    (temp, preview)
}
#[test]
fn existing_grants_update_directly_but_new_authority_and_dependency_changes_require_review() {
    let (_temp, mut p) = prepared();
    assert!(!needs_review(&p));
    p.operation = ManagedOperation::Adopt;
    assert!(needs_review(&p));
    p.operation = ManagedOperation::Update;
    p.changes.restart_required = true;
    assert!(needs_review(&p));
    p.changes.restart_required = false;
    p.manifest.permissions.push(Permission::RuntimeManage);
    assert!(needs_review(&p));
    p.manifest.permissions.pop();
    p.changes.requirements_added.push(
        crate::capabilities::CapabilityDescriptor::new(
            "other.service",
            1,
            crate::capabilities::CapabilityScope::Target,
        )
        .unwrap(),
    );
    assert!(needs_review(&p));
    p.changes.requirements_added.clear();
    p.changes.provides_removed.push(
        crate::capabilities::CapabilityDescriptor::new(
            "old.service",
            1,
            crate::capabilities::CapabilityScope::Target,
        )
        .unwrap(),
    );
    assert!(needs_review(&p));
}
#[test]
fn installer_update_uses_adoption_and_binds_review_to_channel_identity() {
    let temp = tempfile::tempdir().unwrap();
    let registry = crate::plugin_update_source::fixture_seed(temp.path(), "dev.update-test");
    let source = PluginUpdateSource::load(&registry, "dev.update-test").unwrap();
    assert_eq!(source.operation, ManagedOperation::Adopt);
    let prepared = package(&registry, "2.0.0", &["ui.dom"]);
    let p = crate::managed_plugins::preview(&registry, &prepared.package_path, source.operation)
        .unwrap();
    assert!(needs_review(&p));
    assert!(!p.existing_enabled);
    let request = p.request(
        p.existing_registration.as_ref().unwrap().grants.clone(),
        p.existing_registration
            .as_ref()
            .unwrap()
            .broker_policy
            .clone(),
        false,
    );
    assert!(crate::managed_plugins::stage(&registry, "dev.update-test", &request).is_ok());
    let service = PluginUpdateInstall::new(
        Arc::new(registry.path().to_owned()),
        ControlBroker::new([22; 16], "seed-review".into()),
    );
    service.0.state.lock().unwrap().items.push(Item {
        plugin_id: "dev.update-test".into(),
        version_key: source.version_key,
        phase: "reviewRequired",
        version: Some("2.0.0".into()),
        message: None,
        operation_id: None,
        preview: Some(serde_json::to_value(&p).unwrap()),
    });
    assert_eq!(
        service.preview(0, "dev.update-test").unwrap()["operation"],
        "adopt"
    );
    let receipt = temp
        .path()
        .join(".official-seed-transactions/dev.update-test.receipt.json");
    let mut changed: Value = serde_json::from_slice(&std::fs::read(&receipt).unwrap()).unwrap();
    changed["package"]["updateSource"]["ownerId"] = serde_json::json!(8);
    std::fs::write(&receipt, changed.to_string()).unwrap();
    assert!(service.preview(0, "dev.update-test").is_err());
    assert_eq!(
        crate::managed_plugins::stage(&registry, "dev.update-test", &request)
            .unwrap_err()
            .code,
        "import_registration_changed"
    );
    assert_eq!(
        crate::managed_plugins::preview(&registry, &prepared.package_path, ManagedOperation::Adopt)
            .unwrap_err()
            .code,
        "managed_source_changed"
    );
}
#[test]
fn release_asset_selection_keeps_the_platform_and_refuses_ambiguous_archives() {
    let (_temp, p) = prepared();
    let mut source = p.source;
    source.tag = "v1.0.0".into();
    source.asset_name = "plugin-1.0.0-win-x64.zip".into();
    let make = |id, name: &str| GitHubAsset {
        id,
        name: name.into(),
        size: 2,
        content_type: "application/zip".into(),
        download_url: String::new(),
        digest: None,
        download_count: None,
    };
    let mut release = GitHubRelease {
        id: 2,
        tag: "v1.1.0".into(),
        name: String::new(),
        url: String::new(),
        prerelease: false,
        published_at: None,
        assets: vec![
            make(2, "plugin-1.1.0-win-arm64.zip"),
            make(3, "plugin-1.1.0-win-x64.zip"),
        ],
    };
    assert_eq!(select_asset(&source, &release).unwrap().id, 3);
    release.assets = vec![make(4, "one.zip"), make(5, "two.zip")];
    assert!(select_asset(&source, &release).is_err());
}
#[tokio::test]
async fn automatic_install_submits_one_receipt_and_preserves_enabled_state_and_grants() {
    let (temp, mut p) = prepared();
    p.existing_enabled = true;
    let scope = temp.path().canonicalize().unwrap();
    let prior = p.existing_registration.as_mut().unwrap();
    prior.grants.extend([
        Permission::HostFs,
        Permission::HostNetwork,
        Permission::HostFsWrite,
        Permission::HostFsWatch,
        Permission::HostProcessSpawn,
        Permission::CoreShortcuts,
    ]);
    prior.broker_policy = BrokerPolicy {
        read_roots: vec![scope.clone()],
        network_origins: vec!["https://example.com".into()],
        executables: vec![],
        write_roots: vec![scope.clone()],
        watch_roots: vec![scope.clone()],
        cwd_roots: vec![scope],
        env_keys: vec!["SELECTED".into()],
        shortcuts: vec!["Ctrl+Shift+K".into()],
    };
    let expected = prior.clone();
    let broker = ControlBroker::new([33; 16], "update-test".into());
    broker.set_ready();
    let service =
        PluginUpdateInstall::new(Arc::new(temp.path().join("config.json")), broker.clone());
    let weak = Arc::downgrade(&service.0);
    let apply = apply(&broker, &p, &weak, 0, "dev.update-test");
    let drive = async {
        let job = loop {
            if let Some(job) = broker.take_next() {
                break job;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        };
        let selection = job.request.local_import.unwrap();
        assert!(selection.enable);
        assert_eq!(selection.grants, expected.grants);
        assert_eq!(selection.broker_policy, expected.broker_policy);
        assert!(selection.trusted);
        assert!(broker.take_next().is_none());
        broker.complete(
            &job.operation_id,
            Ok(crate::plugin_control::PluginControlReport {
                action: PluginControlAction::Update,
                plugin_id: "dev.update-test".into(),
                outcome: crate::plugin_control::PluginControlOutcome::Applied,
                desired_enabled: true,
                affected_plugin_ids: vec!["dev.update-test".into()],
                generations: vec![],
                target_failures: vec![],
                message: None,
            }),
        );
    };
    let (result, ()) = tokio::join!(apply, drive);
    assert!(result.is_ok());
    assert!(broker.take_next().is_none());
}
