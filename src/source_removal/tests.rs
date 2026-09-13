use super::*;
use crate::plugins::LocalPluginRegistration;
use std::fs;

const ID: &str = "dev.source-remove";

struct Fixture {
    directory: tempfile::TempDir,
    source: PathBuf,
    registry: PluginRegistry,
    data: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::create_dir(source.join("nested")).unwrap();
        fs::write(source.join("nested/entry.js"), "source").unwrap();
        let source = source.canonicalize().unwrap();
        let mut registry =
            PluginRegistry::load(directory.path().join("state/config.json")).unwrap();
        registry
            .register_local(
                ID,
                LocalPluginRegistration {
                    path: source.clone(),
                    ..Default::default()
                },
            )
            .unwrap();
        registry.set_enabled(ID, false).unwrap();
        registry.save().unwrap();
        let data = directory.path().join("state/data/plugin-state.txt");
        fs::create_dir_all(data.parent().unwrap()).unwrap();
        fs::write(&data, "separate plugin data").unwrap();
        Self {
            directory,
            source,
            registry,
            data,
        }
    }
    fn unregister(&mut self) {
        self.registry.remove_local(ID).unwrap();
        self.registry.set_enabled(ID, false).unwrap();
        self.registry.save().unwrap();
    }
    fn apply(&self, plan: SourceRemovalPlan) -> SourceRemovalResult {
        // Every destructive test target is an explicitly checked absolute child
        // of this fixture. No user directories are passed to apply().
        assert!(plan.path.is_absolute());
        assert!(
            plan.path
                .starts_with(self.directory.path().canonicalize().unwrap())
        );
        apply(plan)
    }
    fn move_source(&self) -> PathBuf {
        let target = self.directory.path().join("moved-source");
        assert!(
            self.source
                .starts_with(self.directory.path().canonicalize().unwrap())
        );
        assert_eq!(
            target.parent().unwrap().canonicalize().unwrap(),
            self.directory.path().canonicalize().unwrap()
        );
        fs::rename(&self.source, &target).unwrap();
        target
    }
}

#[test]
fn explicit_source_removal_deletes_only_the_confirmed_directory_after_unregistering() {
    let mut fixture = Fixture::new();
    let selection = preview(&fixture.registry, ID).unwrap();
    assert_eq!(selection.status, "available");
    let plan = prepare(&fixture.registry, ID, &selection.request()).unwrap();
    fixture.unregister();
    let result = fixture.apply(plan);
    assert_eq!(result.status, "deleted", "{result:?}");
    assert!(!fixture.source.exists());
    assert_eq!(
        fs::read_to_string(&fixture.data).unwrap(),
        "separate plugin data"
    );
    assert!(
        !PluginRegistry::load(fixture.registry.path())
            .unwrap()
            .local_plugins()
            .contains_key(ID)
    );
}

#[test]
fn missing_or_moved_source_is_skipped_while_unregistering_succeeds() {
    for move_before_preview in [false, true] {
        let mut fixture = Fixture::new();
        let before = preview(&fixture.registry, ID).unwrap();
        let moved = fixture.move_source();
        let selection = if move_before_preview {
            preview(&fixture.registry, ID).unwrap()
        } else {
            before
        };
        if move_before_preview {
            assert_eq!(selection.status, "missing");
        }
        let plan = prepare(&fixture.registry, ID, &selection.request()).unwrap();
        fixture.unregister();
        let result = fixture.apply(plan);
        assert_eq!(result.status, "skipped");
        assert_eq!(result.code, "source_directory_missing");
        assert!(moved.join("nested/entry.js").exists());
        assert!(fixture.data.exists());
    }
}

#[test]
fn directory_replacement_before_or_after_prepare_is_never_deleted() {
    for move_before_prepare in [false, true] {
        let mut fixture = Fixture::new();
        let request = preview(&fixture.registry, ID).unwrap().request();
        let plan = if move_before_prepare {
            None
        } else {
            Some(prepare(&fixture.registry, ID, &request).unwrap())
        };
        let moved = fixture.move_source();
        fs::create_dir(&fixture.source).unwrap();
        fs::write(
            fixture.source.join("replacement.txt"),
            "do not delete replacement",
        )
        .unwrap();
        let plan = plan.unwrap_or_else(|| prepare(&fixture.registry, ID, &request).unwrap());
        fixture.unregister();
        let result = fixture.apply(plan);
        assert_eq!(result.status, "skipped");
        assert_eq!(result.code, "source_directory_changed");
        assert!(fixture.source.join("replacement.txt").exists());
        assert!(moved.join("nested/entry.js").exists());
    }
}

#[test]
fn registration_changes_and_forged_path_fields_cannot_authorize_source_removal() {
    let mut fixture = Fixture::new();
    let request = preview(&fixture.registry, ID).unwrap().request();
    fixture.registry.set_enabled(ID, true).unwrap();
    fixture.registry.save().unwrap();
    assert_eq!(
        prepare(&fixture.registry, ID, &request).unwrap_err().code,
        "source_removal_registration_changed"
    );
    let forged = serde_json::json!({"registrationDigest":request.registration_digest,"sourceIdentity":request.source_identity,"path":"C:\\Windows"});
    assert!(serde_json::from_value::<SourceRemovalRequest>(forged).is_err());
    assert!(fixture.source.exists());
    let fresh = preview(&fixture.registry, ID).unwrap().request();
    let plan = prepare(&fixture.registry, ID, &fresh).unwrap();
    assert_eq!(fixture.apply(plan).code, "source_removal_reregistered");
    assert!(fixture.source.exists());
}

#[test]
fn sources_overlapping_registry_runtime_or_another_registration_are_blocked() {
    let mut fixture = Fixture::new();
    let other = fixture.source.join("nested");
    fixture
        .registry
        .register_local(
            "dev.other",
            LocalPluginRegistration {
                path: other,
                ..Default::default()
            },
        )
        .unwrap();
    fixture.registry.save().unwrap();
    let preview = preview(&fixture.registry, ID).unwrap();
    assert_eq!(preview.status, "blocked");
    assert!(preview.source_identity.is_none());
    assert!(protected_path(&fixture.registry, ID, fixture.directory.path(), false).is_err());
    assert!(protected_path(&fixture.registry, ID, Path::new("C:\\"), false).is_err());
    assert!(
        protected_path(
            &fixture.registry,
            ID,
            std::env::current_exe().unwrap().parent().unwrap(),
            false
        )
        .is_err()
    );
    let runtime = std::env::current_exe().unwrap();
    let runtime = runtime.parent().unwrap();
    assert!(
        protected_path(
            &fixture.registry,
            ID,
            &runtime.join("plugins/dev.fixture"),
            false
        )
        .is_ok()
    );
    assert!(protected_path(&fixture.registry, ID, &runtime.join("plugins"), false).is_err());
    assert!(protected_path(&fixture.registry, ID, &runtime.join("runtime/node"), false).is_err());
}

#[test]
fn deletion_failure_is_reported_without_claiming_all_files_were_removed() {
    use std::os::windows::fs::OpenOptionsExt;
    let mut fixture = Fixture::new();
    let locked_path = fixture.source.join("locked.txt");
    fs::write(&locked_path, "held open").unwrap();
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&locked_path)
        .unwrap();
    let plan = prepare(
        &fixture.registry,
        ID,
        &preview(&fixture.registry, ID).unwrap().request(),
    )
    .unwrap();
    fixture.unregister();
    let result = fixture.apply(plan);
    assert!(result.failed());
    assert_eq!(result.code, "source_removal_failed");
    assert!(locked_path.exists());
    assert!(fixture.data.exists());
    drop(held);
}

#[test]
fn child_junction_is_removed_without_following_its_external_contents() {
    use std::os::windows::process::CommandExt;
    let mut fixture = Fixture::new();
    let external = fixture.directory.path().join("outside-source");
    fs::create_dir(&external).unwrap();
    fs::write(external.join("preserve.txt"), "external content").unwrap();
    let link = fixture.source.join("external-junction");
    assert!(
        link.parent()
            .unwrap()
            .starts_with(fixture.directory.path().canonicalize().unwrap())
    );
    let powershell = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let result = std::process::Command::new(powershell).args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "New-Item -ItemType Junction -Path $env:CODLET_TEST_SOURCE_LINK -Target $env:CODLET_TEST_SOURCE_TARGET -ErrorAction Stop | Out-Null"])
        .env("CODLET_TEST_SOURCE_LINK", crate::windows::open_folder::shell_directory_path(&link).unwrap()).env("CODLET_TEST_SOURCE_TARGET", crate::windows::open_folder::shell_directory_path(&external).unwrap()).creation_flags(0x08000000).output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let plan = prepare(
        &fixture.registry,
        ID,
        &preview(&fixture.registry, ID).unwrap().request(),
    )
    .unwrap();
    fixture.unregister();
    let result = fixture.apply(plan);
    assert_eq!(result.status, "deleted", "{result:?}");
    assert_eq!(
        fs::read_to_string(external.join("preserve.txt")).unwrap(),
        "external content"
    );
}

#[test]
fn root_pin_prevents_directory_replacement_during_source_deletion() {
    let fixture = Fixture::new();
    let pin = windows::pin_directory(&fixture.source, true).unwrap();
    let target = fixture.directory.path().join("moved-while-pinned");
    assert!(
        fixture
            .source
            .starts_with(fixture.directory.path().canonicalize().unwrap())
    );
    assert_eq!(
        target.parent().unwrap().canonicalize().unwrap(),
        fixture.directory.path().canonicalize().unwrap()
    );
    assert!(fs::rename(&fixture.source, target).is_err());
    drop(pin);
}

#[test]
fn explicitly_deleted_managed_source_keeps_history_and_reports_missing_rollback_files() {
    use std::io::{Cursor, Write};
    let mut fixture = Fixture::new();
    fixture.unregister();
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    archive.start_file("codlet.json", options).unwrap();
    archive.write_all(serde_json::json!({"schema":1,"id":ID,"version":"1","renderer":{"entry":"entry.js","world":"isolated"},"permissions":["ui.dom"]}).to_string().as_bytes()).unwrap();
    archive.start_file("entry.js", options).unwrap();
    archive.write_all(b"module.exports = {};").unwrap();
    let archive = archive.finish().unwrap().into_inner();
    let package =
        crate::github_distribution::test_prepare_archive(fixture.registry.path(), &archive)
            .unwrap();
    let preview = crate::managed_plugins::preview(
        &fixture.registry,
        &package.package_path,
        crate::managed_plugins::ManagedOperation::Install,
    )
    .unwrap();
    let (mut registry, _) = crate::managed_plugins::stage(
        &fixture.registry,
        ID,
        &preview.request(
            vec![crate::plugins::Permission::UiDom],
            Default::default(),
            false,
        ),
    )
    .unwrap();
    registry.save().unwrap();
    fixture.registry = registry;
    fixture.source = package.package_path;
    let version_key = fixture.registry.managed_plugins()[ID]
        .current_version
        .clone()
        .unwrap();
    let selection = super::preview(&fixture.registry, ID).unwrap();
    assert_eq!(selection.status, "available");
    let plan = prepare(&fixture.registry, ID, &selection.request()).unwrap();
    fixture.unregister();
    let result = fixture.apply(plan);
    assert_eq!(result.status, "deleted", "{result:?}");
    let record = &fixture.registry.managed_plugins()[ID];
    assert!(record.current().is_none());
    assert_eq!(record.history.len(), 1);
    assert_eq!(
        crate::managed_plugins::preview_rollback(&fixture.registry, ID, &version_key)
            .unwrap_err()
            .code,
        "managed_version_missing"
    );
    assert!(fixture.data.exists());
}
