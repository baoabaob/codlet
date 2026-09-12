use super::*;
use serde_json::json;
use std::io::{Cursor, Write};

fn archive(version: &str, permissions: &[&str], host_source: Option<&str>) -> Vec<u8> {
    let mut manifest =
        json!({"schema":1,"id":"dev.managed","version":version,"permissions":permissions});
    manifest[if host_source.is_some() {
        "host"
    } else {
        "renderer"
    }] = if host_source.is_some() {
        json!({"entry":"entry.js"})
    } else {
        json!({"entry":"entry.js","world":"isolated"})
    };
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("codlet.json", options).unwrap();
    zip.write_all(manifest.to_string().as_bytes()).unwrap();
    zip.start_file("entry.js", options).unwrap();
    zip.write_all(
        host_source
            .unwrap_or("module.exports = { activate() {}, deactivate() {} };")
            .as_bytes(),
    )
    .unwrap();
    zip.finish().unwrap().into_inner()
}

fn prepare(
    registry: &PluginRegistry,
    version: &str,
    permissions: &[&str],
) -> PreparedGitHubPackage {
    crate::github_distribution::test_prepare_archive(
        registry.path(),
        &archive(version, permissions, None),
    )
    .unwrap()
}

fn commit(
    registry: &PluginRegistry,
    package: &PreparedGitHubPackage,
    operation: ManagedOperation,
    grants: Vec<Permission>,
) -> PluginRegistry {
    let preview = preview(registry, &package.package_path, operation).unwrap();
    let (mut next, _) = stage(
        registry,
        "dev.managed",
        &preview.request(grants, BrokerPolicy::default(), false),
    )
    .unwrap();
    next.save().unwrap();
    next
}

#[test]
fn managed_install_update_rollback_and_unregister_keep_immutable_versions() {
    let directory = tempfile::tempdir().unwrap();
    let registry = PluginRegistry::load(directory.path().join("config.json")).unwrap();
    let first = prepare(&registry, "1", &["ui.dom"]);
    let first_bytes = std::fs::read(first.package_path.join("entry.js")).unwrap();
    let initial = preview(&registry, &first.package_path, ManagedOperation::Install).unwrap();
    assert_eq!(initial.ownership, "core-managed-github");
    assert!(!registry.path().exists());
    let mut registry = commit(
        &registry,
        &first,
        ManagedOperation::Install,
        vec![Permission::UiDom],
    );
    assert!(!registry.is_enabled("dev.managed"));
    let first_key = registry.managed_plugins()["dev.managed"]
        .current_version
        .clone()
        .unwrap();
    assert_eq!(
        registry.managed_plugins()["dev.managed"]
            .current()
            .unwrap()
            .source,
        first.source
    );
    validate_current(&registry, "dev.managed").unwrap();
    let second = prepare(&registry, "2", &["ui.dom", "ui.mainWorld"]);
    let change = preview(&registry, &second.package_path, ManagedOperation::Update).unwrap();
    assert_eq!(
        change.changes.permissions_added,
        vec![Permission::UiMainWorld]
    );
    assert_eq!(
        stage(
            &registry,
            "dev.managed",
            &change.request(vec![Permission::UiDom], BrokerPolicy::default(), false)
        )
        .unwrap_err()
        .code,
        "permission_required"
    );
    registry = commit(
        &registry,
        &second,
        ManagedOperation::Update,
        vec![Permission::UiDom, Permission::UiMainWorld],
    );
    assert_eq!(
        registry.local_plugins()["dev.managed"].path,
        second.package_path
    );
    assert_eq!(registry.managed_plugins()["dev.managed"].history.len(), 2);
    let rollback = preview_rollback(&registry, "dev.managed", &first_key).unwrap();
    assert_eq!(
        rollback.changes.permissions_removed,
        vec![Permission::UiMainWorld]
    );
    let (mut registry, _) = stage(
        &registry,
        "dev.managed",
        &rollback.request(vec![Permission::UiDom], BrokerPolicy::default(), false),
    )
    .unwrap();
    registry.save().unwrap();
    assert_eq!(
        registry.local_plugins()["dev.managed"].path,
        first.package_path
    );
    assert_eq!(
        registry.managed_plugins()["dev.managed"]
            .current_version
            .as_deref(),
        Some(first_key.as_str())
    );
    registry.remove_local("dev.managed").unwrap();
    registry.save().unwrap();
    assert!(
        registry.managed_plugins()["dev.managed"]
            .current()
            .is_none()
    );
    assert_eq!(registry.managed_plugins()["dev.managed"].history.len(), 2);
    assert_eq!(
        std::fs::read(first.package_path.join("entry.js")).unwrap(),
        first_bytes
    );
    assert!(second.package_path.join("entry.js").exists());
}

#[test]
fn stale_managed_preview_and_concurrent_source_edit_cannot_commit() {
    let directory = tempfile::tempdir().unwrap();
    let registry = PluginRegistry::load(directory.path().join("config.json")).unwrap();
    let first = prepare(&registry, "1", &["ui.dom"]);
    let registry = commit(
        &registry,
        &first,
        ManagedOperation::Install,
        vec![Permission::UiDom],
    );
    let second = prepare(&registry, "2", &["ui.dom"]);
    let preview = preview(&registry, &second.package_path, ManagedOperation::Update).unwrap();
    let request = preview.request(vec![Permission::UiDom], BrokerPolicy::default(), false);
    let (mut candidate, _) = stage(&registry, "dev.managed", &request).unwrap();
    let mut concurrent = PluginRegistry::load(registry.path()).unwrap();
    let mut record = concurrent.managed_plugins()["dev.managed"].clone();
    record.history[0].source.tag = "retagged".into();
    concurrent.restore_managed(
        "dev.managed",
        concurrent.local_plugins().get("dev.managed").cloned(),
        Some(record),
    );
    concurrent.save().unwrap();
    assert_eq!(
        stage(&concurrent, "dev.managed", &request)
            .unwrap_err()
            .code,
        "import_registration_changed"
    );
    assert!(candidate.save().is_err());
    assert_eq!(
        PluginRegistry::load(registry.path())
            .unwrap()
            .local_plugins()["dev.managed"]
            .path,
        first.package_path
    );
}

#[test]
fn cross_repository_update_and_local_identity_replacement_require_new_trust() {
    let directory = tempfile::tempdir().unwrap();
    let registry = PluginRegistry::load(directory.path().join("config.json")).unwrap();
    let first = prepare(&registry, "1", &["ui.dom"]);
    let registry = commit(
        &registry,
        &first,
        ManagedOperation::Install,
        vec![Permission::UiDom],
    );
    let second = prepare(&registry, "2", &["ui.dom"]);
    let mut impostor = second.clone();
    impostor.source.owner = "another-owner".into();
    impostor.source.repository_url = "https://github.com/another-owner/dev-repo".into();
    let candidate = inspect_local_plugin(&second.package_path).unwrap();
    assert_eq!(
        preview_checked(&registry, impostor, candidate, ManagedOperation::Update)
            .unwrap_err()
            .code,
        "managed_source_changed"
    );
    assert_eq!(
        local_import::preview(&registry, &second.package_path)
            .unwrap_err()
            .code,
        "managed_preview_required"
    );
    assert_eq!(
        preview(&registry, &second.package_path, ManagedOperation::Install)
            .unwrap_err()
            .code,
        "registration_conflict"
    );
    let fresh = PluginRegistry::load(directory.path().join("other-config.json")).unwrap();
    let mut selection = preview(&fresh, &second.package_path, ManagedOperation::Install)
        .unwrap()
        .request(vec![Permission::UiDom], BrokerPolicy::default(), false);
    selection.trusted = false;
    assert_eq!(
        stage(&fresh, "dev.managed", &selection).unwrap_err().code,
        "trust_required"
    );
}

#[test]
fn managed_preview_detects_entry_edits_and_rejects_author_directory_ownership() {
    let directory = tempfile::tempdir().unwrap();
    let registry = PluginRegistry::load(directory.path().join("config.json")).unwrap();
    let first = prepare(&registry, "1", &["ui.dom"]);
    let selection = preview(&registry, &first.package_path, ManagedOperation::Install)
        .unwrap()
        .request(vec![Permission::UiDom], BrokerPolicy::default(), false);
    std::fs::write(first.package_path.join("entry.js"), "changed").unwrap();
    assert_eq!(
        stage(&registry, "dev.managed", &selection)
            .unwrap_err()
            .code,
        "managed_package_invalid"
    );
    let author = directory.path().join("author");
    std::fs::create_dir(&author).unwrap();
    std::fs::write(author.join("do-not-delete.txt"), "author-owned").unwrap();
    assert_eq!(
        preview(&registry, &author, ManagedOperation::Install)
            .unwrap_err()
            .code,
        "managed_package_invalid"
    );
    assert!(author.join("do-not-delete.txt").exists());
}

#[test]
fn compensation_restores_prior_registration_but_never_overwrites_revoked_grants() {
    let directory = tempfile::tempdir().unwrap();
    let registry = PluginRegistry::load(directory.path().join("config.json")).unwrap();
    let first = prepare(&registry, "1", &["ui.dom"]);
    let mut previous = commit(
        &registry,
        &first,
        ManagedOperation::Install,
        vec![Permission::UiDom],
    );
    previous.set_enabled("dev.managed", true).unwrap();
    previous.save().unwrap();
    let second = prepare(&previous, "2", &["ui.dom"]);
    let candidate = commit(
        &previous,
        &second,
        ManagedOperation::Update,
        vec![Permission::UiDom],
    );
    let restored = restore_previous(&candidate, &previous, "dev.managed").unwrap();
    assert_eq!(restored.local_plugins(), previous.local_plugins());
    assert_eq!(restored.managed_plugins(), previous.managed_plugins());
    assert!(restored.is_enabled("dev.managed"));
    let candidate = commit(
        &restored,
        &second,
        ManagedOperation::Update,
        vec![Permission::UiDom],
    );
    let mut concurrent = PluginRegistry::load(candidate.path()).unwrap();
    concurrent
        .revoke_permission("dev.managed", Permission::UiDom)
        .unwrap();
    concurrent.save().unwrap();
    assert_eq!(
        restore_previous(&candidate, &restored, "dev.managed")
            .unwrap_err()
            .code,
        "managed_restore_conflict"
    );
    assert!(
        PluginRegistry::load(candidate.path())
            .unwrap()
            .local_plugins()["dev.managed"]
            .grants
            .is_empty()
    );
}

#[test]
fn permission_and_dependency_diff_describes_both_halves_without_executing_code() {
    let previous = PluginManifest::parse(&json!({"schema":1,"id":"dev.managed","version":"1","renderer":{"entry":"entry.js","world":"isolated"},"permissions":["ui.dom"],"requires":[{"name":"dev.old","api":1,"scope":"runtime"}]}).to_string()).unwrap();
    let next = PluginManifest::parse(&json!({"schema":1,"id":"dev.managed","version":"2","renderer":{"entry":"entry.js","world":"isolated"},"host":{"entry":"host.js","requires":[{"name":"dev.new","api":1,"scope":"runtime"}]},"permissions":["ui.dom","host.process"]}).to_string()).unwrap();
    let diff = changes(Some(&previous), &next);
    assert_eq!(diff.permissions_added, vec![Permission::HostProcess]);
    assert_eq!(diff.requirements_added[0].name.as_str(), "dev.new");
    assert_eq!(diff.requirements_removed[0].name.as_str(), "dev.old");
}

#[cfg(windows)]
mod runtime {
    use super::*;
    use crate::catalog::PluginCatalog;
    use crate::cdp::CdpClient;
    use crate::host_control::HostControl;
    use crate::host_runtime::HostRuntime;
    use crate::js_runtime::JsRuntime;
    use crate::plugin_control::{
        PluginControlAction, PluginControlOutcome, PluginControlReport, PluginControlRequest,
    };
    use crate::plugin_execution::ExecutionState;
    use crate::renderer::RendererRuntime;
    use crate::runtime_control::{
        ControlBroker, ControlCompletion, ControlReport, ControlRequest, ControlStatus,
    };
    use crate::windows::process::{ChildProcess, launch_with_cdp_pipes};
    use std::ffi::OsString;
    use std::time::{Duration, Instant};

    const WAIT: Duration = Duration::from_secs(12);
    struct Fixture {
        hosts: HostRuntime,
        control: HostControl,
        broker: ControlBroker,
        renderer: RendererRuntime,
        client: CdpClient,
        child: ChildProcess,
        _directory: tempfile::TempDir,
        registry_path: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let registry_path = directory.path().join("config.json");
            let mut registry = PluginRegistry::load(&registry_path).unwrap();
            registry.set_enabled("codlet-gui", false).unwrap();
            registry.set_enabled("codex.ui.adapter", false).unwrap();
            registry.save().unwrap();
            let renderer =
                RendererRuntime::from_catalog(PluginCatalog::load(&registry).unwrap(), registry)
                    .unwrap();
            let executable = std::env::current_exe().unwrap();
            let distribution = executable.parent().unwrap().parent().unwrap();
            let (child, pipes) = launch_with_cdp_pipes(
                &distribution.join("codlet-fake-child.exe"),
                &[OsString::from("--scenario=raw-host-cdp")],
                true,
            )
            .unwrap();
            let (client, events) = CdpClient::spawn(pipes).unwrap();
            drop(events);
            let runtime = JsRuntime::from_distribution(distribution).expect("Build fake-child and stage the pinned Node runtime before running managed lifecycle integration tests.");
            let hosts =
                HostRuntime::start_with_runtime(Vec::new(), client.clone(), Some(runtime)).unwrap();
            let broker = ControlBroker::new([19; 16], "b".repeat(64));
            broker.set_ready();
            Self {
                hosts,
                control: HostControl::new(registry_path.clone()),
                broker,
                renderer,
                client,
                child,
                _directory: directory,
                registry_path,
            }
        }
        fn registry(&self) -> PluginRegistry {
            PluginRegistry::load(&self.registry_path).unwrap()
        }
        fn package(&self, version: &str, source: &str) -> PreparedGitHubPackage {
            crate::github_distribution::test_prepare_archive(
                &self.registry_path,
                &archive(version, &["host.process"], Some(source)),
            )
            .unwrap()
        }
        fn request(
            &self,
            package: &PreparedGitHubPackage,
            operation: ManagedOperation,
            enable: bool,
        ) -> PluginControlRequest {
            let preview = preview(&self.registry(), &package.package_path, operation).unwrap();
            PluginControlRequest {
                action: match operation {
                    ManagedOperation::Install => PluginControlAction::Import,
                    ManagedOperation::Update => PluginControlAction::Update,
                    ManagedOperation::Rollback => PluginControlAction::Rollback,
                },
                plugin_id: "dev.managed".into(),
                permission: None,
                cascade: false,
                local_import: Some(preview.request(
                    vec![Permission::HostProcess],
                    BrokerPolicy::default(),
                    enable,
                )),
            }
        }
        fn submit(&self, request: PluginControlRequest) -> String {
            let prepared = self.broker.handle(ControlRequest::prepare(request));
            assert_eq!(prepared.status, ControlStatus::Prepared, "{prepared:?}");
            let receipt = prepared.operation_id().unwrap().to_owned();
            assert_eq!(
                self.broker.handle(ControlRequest::submit(&receipt)).status,
                ControlStatus::Queued
            );
            receipt
        }
        fn tick(&mut self) {
            self.renderer
                .set_external_observations(self.hosts.observations());
            self.renderer.pump_bindings().unwrap();
            self.control
                .poll(&mut self.renderer, &self.hosts, &self.broker);
            if !self.control.is_pending()
                && let Some(job) = self.broker.take_next()
                && let Some(job) =
                    self.control
                        .dispatch(job, &mut self.renderer, &self.hosts, &self.broker)
            {
                self.broker
                    .complete(&job.operation_id, self.renderer.manage_plugin(job.request));
            }
        }
        fn wait(&mut self, receipt: &str) -> ControlReport {
            let deadline = Instant::now() + WAIT;
            loop {
                self.tick();
                let report = self.broker.handle(ControlRequest::result(receipt));
                if report.status == ControlStatus::Completed {
                    return report;
                }
                assert!(
                    Instant::now() < deadline,
                    "managed receipt timed out: {report:?}; {:?}",
                    self.hosts.observations()
                );
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        fn apply(
            &mut self,
            package: &PreparedGitHubPackage,
            operation: ManagedOperation,
            enable: bool,
        ) -> PluginControlReport {
            let receipt = self.submit(self.request(package, operation, enable));
            let response = self.wait(&receipt);
            assert_eq!(
                self.broker.handle(ControlRequest::submit(&receipt)),
                response,
                "a repeated receipt must not run the package twice"
            );
            match response.operation.unwrap().completion.unwrap() {
                ControlCompletion::Report { report } => report,
                error => panic!("expected managed lifecycle report, got {error:?}"),
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.hosts.stop();
            let _ = self.client.shutdown();
            let _ = self.child.wait(WAIT);
        }
    }

    #[test]
    fn running_managed_updates_and_explicit_rollback_replace_generations_under_one_receipt() {
        let mut fixture = Fixture::new();
        let first = fixture.package("1", "module.exports = {activate() {}, deactivate() {}};");
        let installed = fixture.apply(&first, ManagedOperation::Install, true);
        assert_eq!(installed.outcome, PluginControlOutcome::Applied);
        assert_eq!(installed.generations[0].generation, 1);
        let second = fixture.package("2", "module.exports = {activate() {}, deactivate() {}};");
        let updated = fixture.apply(&second, ManagedOperation::Update, true);
        assert_eq!(updated.action, PluginControlAction::Update);
        assert_eq!(updated.outcome, PluginControlOutcome::Applied);
        assert_eq!(updated.generations[0].generation, 2);
        assert_eq!(
            fixture.registry().local_plugins()["dev.managed"].path,
            second.package_path
        );
        let rolled_back = fixture.apply(&first, ManagedOperation::Rollback, true);
        assert_eq!(rolled_back.action, PluginControlAction::Rollback);
        assert_eq!(rolled_back.outcome, PluginControlOutcome::Applied);
        assert_eq!(rolled_back.generations[0].generation, 3);
        assert_eq!(
            fixture.registry().managed_plugins()["dev.managed"]
                .history
                .len(),
            2
        );
        assert_eq!(
            fixture.registry().local_plugins()["dev.managed"].path,
            first.package_path
        );
        let stopped = fixture.apply(&second, ManagedOperation::Update, false);
        assert_eq!(stopped.outcome, PluginControlOutcome::Applied);
        assert!(!stopped.desired_enabled);
        assert!(stopped.generations.is_empty());
        assert_eq!(
            fixture.registry().local_plugins()["dev.managed"].path,
            second.package_path
        );
        assert!(first.package_path.exists());
        validate_current(&fixture.registry(), "dev.managed").unwrap();
    }

    #[test]
    fn failed_running_update_restores_registration_history_and_previous_snapshot_generation() {
        let mut fixture = Fixture::new();
        let first = fixture.package("1", "module.exports = {activate() {}, deactivate() {}};");
        fixture.apply(&first, ManagedOperation::Install, true);
        let previous = fixture.registry();
        let broken = fixture.package("2", "module.exports = {activate() { throw new Error('managed candidate rejected'); }, deactivate() {}};");
        let failed = fixture.apply(&broken, ManagedOperation::Update, true);
        assert_eq!(
            failed.outcome,
            PluginControlOutcome::RolledBack,
            "{failed:?}"
        );
        assert!(!failed.is_success());
        assert_eq!(failed.generations[0].generation, 3);
        let restored = fixture.registry();
        assert_eq!(restored.local_plugins(), previous.local_plugins());
        assert_eq!(restored.managed_plugins(), previous.managed_plugins());
        assert!(restored.is_enabled("dev.managed"));
        assert!(
            fixture
                .hosts
                .observations()
                .iter()
                .any(|observation| observation.state == ExecutionState::Active
                    && observation.plugin.manifest.version == "1"
                    && observation.plugin.generation == 3)
        );
        assert!(
            broken.package_path.exists(),
            "failed package cache is retained, never silently deleted"
        );
    }

    #[test]
    fn concurrent_revocation_during_failed_update_prevents_unsafe_restoration() {
        let mut fixture = Fixture::new();
        let first = fixture.package("1", "module.exports = {activate() {}, deactivate() {}};");
        fixture.apply(&first, ManagedOperation::Install, true);
        let broken = fixture.package("2", "module.exports = {async activate() { await new Promise(resolve => setTimeout(resolve, 150)); throw new Error('delayed failure'); }, deactivate() {}};");
        let receipt = fixture.submit(fixture.request(&broken, ManagedOperation::Update, true));
        let deadline = Instant::now() + WAIT;
        loop {
            fixture.tick();
            if fixture.hosts.observations().iter().any(|observation| {
                observation.plugin.manifest.version == "2"
                    && observation.state == ExecutionState::Starting
            }) {
                break;
            }
            assert!(Instant::now() < deadline, "candidate never entered startup");
            std::thread::sleep(Duration::from_millis(2));
        }
        let mut concurrent = fixture.registry();
        concurrent
            .revoke_permission("dev.managed", Permission::HostProcess)
            .unwrap();
        concurrent.save().unwrap();
        let completion = fixture
            .wait(&receipt)
            .operation
            .unwrap()
            .completion
            .unwrap();
        let ControlCompletion::Report { report } = completion else {
            panic!("{completion:?}")
        };
        assert_eq!(report.outcome, PluginControlOutcome::Degraded);
        assert!(!report.is_success());
        assert!(
            report
                .target_failures
                .iter()
                .any(|failure| failure.stage == "rollback_registration")
        );
        let registry = fixture.registry();
        assert_eq!(
            registry.local_plugins()["dev.managed"].path,
            broken.package_path
        );
        assert!(registry.local_plugins()["dev.managed"].grants.is_empty());
        assert!(!registry.is_enabled("dev.managed"));
        assert!(
            !fixture
                .hosts
                .observations()
                .iter()
                .any(|observation| matches!(
                    observation.state,
                    ExecutionState::Active | ExecutionState::Starting
                ))
        );
    }

    #[test]
    fn changing_only_managed_provenance_retires_the_loaded_authorization() {
        let mut fixture = Fixture::new();
        let first = fixture.package("1", "module.exports = {activate() {}, deactivate() {}};");
        fixture.apply(&first, ManagedOperation::Install, true);
        let mut changed = fixture.registry();
        let registration = changed.local_plugins()["dev.managed"].clone();
        let mut record = changed.managed_plugins()["dev.managed"].clone();
        record.history[0].source.tag = "externally-edited".into();
        changed.restore_managed("dev.managed", Some(registration.clone()), Some(record));
        changed.save().unwrap();
        assert_eq!(changed.local_plugins()["dev.managed"], registration);
        fixture
            .control
            .reconcile_authorization(
                &mut fixture.renderer,
                &fixture.hosts,
                Instant::now() + Duration::from_secs(1),
            )
            .unwrap();
        assert!(fixture.control.is_pending());
        let deadline = Instant::now() + WAIT;
        while fixture.control.is_pending() {
            fixture.tick();
            assert!(
                Instant::now() < deadline,
                "source authorization retirement timed out"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            !fixture
                .hosts
                .observations()
                .iter()
                .any(|observation| matches!(
                    observation.state,
                    ExecutionState::Active | ExecutionState::Starting
                ))
        );
        assert_eq!(fixture.control.take_authorization_reports().len(), 1);
        assert_eq!(
            validate_current(&fixture.registry(), "dev.managed")
                .unwrap_err()
                .code,
            "managed_version_changed"
        );
    }
}
