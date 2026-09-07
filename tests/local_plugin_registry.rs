use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use codlet::plugins::{LocalPluginRegistration, Permission, PluginRegistry, PluginRegistryError};
use serde_json::{Value, json};
use tempfile::tempdir;

fn registration(root: &Path, grants: &[Permission]) -> LocalPluginRegistration {
    LocalPluginRegistration {
        path: root.join("plugin"),
        grants: grants.to_vec(),
    }
}

fn io_kind(error: PluginRegistryError) -> io::ErrorKind {
    match error {
        PluginRegistryError::Io { source, .. } => source.kind(),
        other => panic!("expected local edit error, got {other}"),
    }
}

fn seed(path: &Path, registration: LocalPluginRegistration) -> PluginRegistry {
    let mut registry = PluginRegistry::load(path).unwrap();
    registry
        .register_local("dev.example", registration)
        .unwrap();
    registry.save().unwrap();
    registry
}

#[test]
fn schema_one_load_is_read_only_and_explicit_save_migrates_unknown_preferences() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("config.json");
    let original =
        b"{\n  \"schema\": 1, \"plugins\": {\"future.plugin\": {\"enabled\": false}}\n}\n";
    fs::write(&path, original).unwrap();
    let mut registry = PluginRegistry::load(&path).unwrap();
    assert!(!registry.is_enabled("future.plugin"));
    assert!(registry.local_plugins().is_empty());
    assert_eq!(fs::read(&path).unwrap(), original);
    assert_eq!(directory.path().read_dir().unwrap().count(), 1);

    registry.save().unwrap();
    let document: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        document,
        json!({"schema": 2, "plugins": {"future.plugin": {"enabled": false}}, "localPlugins": {}})
    );
}

#[cfg(windows)]
#[test]
fn failed_schema_migration_preserves_original_bytes_and_retries_without_an_edit() {
    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;

    let directory = tempdir().unwrap();
    let path = directory.path().join("config.json");
    let original = br#"{"schema":1,"plugins":{"future.plugin":{"enabled":false}}}"#;
    fs::write(&path, original).unwrap();
    let mut registry = PluginRegistry::load(&path).unwrap();
    let blocker = OpenOptions::new()
        .read(true)
        .share_mode(0x1 | 0x2)
        .open(&path)
        .unwrap();
    assert!(matches!(
        registry.save(),
        Err(PluginRegistryError::Io {
            operation: "replace",
            ..
        })
    ));
    assert_eq!(fs::read(&path).unwrap(), original);
    assert!(registry.local_plugins().is_empty());
    assert!(!registry.is_enabled("future.plugin"));
    assert_eq!(directory.path().read_dir().unwrap().count(), 2);
    drop(blocker);

    registry.save().unwrap();
    let committed: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(committed["schema"], 2);
    assert_eq!(committed["localPlugins"], json!({}));
    assert!(!registry.is_enabled("future.plugin"));
}

#[test]
fn registration_stages_explicit_grants_without_reading_or_creating_source_files() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("state").join("config.json");
    let mut registry = PluginRegistry::load(&path).unwrap();
    let initial = registration(directory.path(), &[]);
    registry
        .register_local("dev.example", initial.clone())
        .unwrap();
    assert_eq!(registry.local_plugins()["dev.example"], initial);
    assert!(registry.is_enabled("dev.example"));
    assert!(!path.exists());
    assert!(!initial.path.exists());
    registry.save().unwrap();
    assert!(!initial.path.exists());
    assert_eq!(
        PluginRegistry::load(&path).unwrap().local_plugins(),
        registry.local_plugins()
    );

    registry.set_enabled("dev.example", false).unwrap();
    let grants = [
        Permission::UiDom,
        Permission::UiMainWorld,
        Permission::CdpRaw,
        Permission::HostProcess,
        Permission::RuntimeManage,
    ];
    let trusted = registration(directory.path(), &grants);
    registry
        .register_local("dev.example", trusted.clone())
        .unwrap();
    assert!(!registry.is_enabled("dev.example"));
    registry.save().unwrap();
    let disk: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        disk["localPlugins"]["dev.example"]["grants"],
        json!([
            "ui.dom",
            "ui.mainWorld",
            "cdp.raw",
            "host.process",
            "runtime.manage"
        ])
    );
    assert_eq!(registry.local_plugins()["dev.example"], trusted);
    assert!(!registry.is_enabled("dev.example"));
    assert_eq!(
        serde_json::from_value::<LocalPluginRegistration>(
            disk["localPlugins"]["dev.example"].clone()
        )
        .unwrap(),
        trusted
    );
}

#[test]
fn schema_two_rejects_malformed_fields_ids_paths_and_grants_without_rewriting() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("config.json");
    let local =
        serde_json::to_string(&registration(directory.path(), &[Permission::UiDom])).unwrap();
    let local_path = serde_json::to_string(&directory.path().join("plugin")).unwrap();
    let malformed = vec![
        r#"{"schema":0,"localPlugins":{}}"#.to_owned(),
        r#"{"schema":3,"localPlugins":{}}"#.to_owned(),
        r#"{"schema":"2","localPlugins":{}}"#.to_owned(),
        r#"{"schema":2.0,"localPlugins":{}}"#.to_owned(),
        r#"{"schema":2,"schema":2,"localPlugins":{}}"#.to_owned(),
        r#"{"schema":2,"localPlugins":{},"localPlugins":{}}"#.to_owned(),
        r#"{"schema":2,"plugins":{},"plugins":{},"localPlugins":{}}"#.to_owned(),
        r#"{"schema":2,"localPlugins":{},"extra":true}"#.to_owned(),
        r#"{"schema":2,"plugins":{}}"#.to_owned(),
        r#"{"schema":1,"localPlugins":{}}"#.to_owned(),
        r#"{"schema":1,"localPlugins":null}"#.to_owned(),
        r#"{"schema":2,"localPlugins":null}"#.to_owned(),
        r#"{"schema":2,"localPlugins":[]}"#.to_owned(),
        r#"{"schema":2,"localPlugins":{"dev.example":null}}"#.to_owned(),
        format!(r#"{{"schema":2,"localPlugins":{{"dev.example":{local},"dev.example":{local}}}}}"#),
        format!(r#"{{"schema":2,"localPlugins":{{"dev.one":{local},"dev.two":{local}}}}}"#),
        format!(
            r#"{{"schema":2,"plugins":{{"future.plugin":{{"enabled":false}},"future.plugin":{{"enabled":true}}}},"localPlugins":{{"dev.example":{local}}}}}"#
        ),
        format!(
            r#"{{"schema":2,"localPlugins":{{"dev.example":{{"path":{local_path},"path":{local_path},"grants":[]}}}}}}"#
        ),
        format!(
            r#"{{"schema":2,"localPlugins":{{"dev.example":{{"path":{local_path},"grants":[],"grants":[]}}}}}}"#
        ),
    ];
    for original in malformed {
        fs::write(&path, &original).unwrap();
        assert!(PluginRegistry::load(&path).is_err(), "accepted {original}");
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        assert_eq!(directory.path().read_dir().unwrap().count(), 1);
    }

    for id in [
        "",
        "Bad.id",
        "dev..example",
        "codlet",
        "codex.ui.adapter",
        "codlet.core.host",
    ] {
        let original = format!(r#"{{"schema":2,"localPlugins":{{"{id}":{local}}}}}"#);
        fs::write(&path, &original).unwrap();
        assert!(PluginRegistry::load(&path).is_err(), "accepted id {id}");
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
    }

    for invalid in [
        json!({"path": "", "grants": []}),
        json!({"path": "relative/plugin", "grants": []}),
        json!({"path": format!("{}\0tail", directory.path().display()), "grants": []}),
        json!({"path": directory.path()}),
        json!({"grants": []}),
        json!({"path": directory.path(), "grants": ["ui.dom", "ui.dom"]}),
        json!({"path": directory.path(), "grants": ["host.files"]}),
        json!({"path": directory.path(), "grants": [1]}),
        json!({"path": directory.path(), "grants": null}),
        json!({"path": directory.path(), "grants": "ui.dom"}),
        json!({"path": directory.path(), "grants": [], "extra": true}),
    ] {
        assert!(
            serde_json::from_value::<LocalPluginRegistration>(invalid.clone()).is_err(),
            "accepted registration {invalid}"
        );
        let original =
            serde_json::to_vec(&json!({"schema": 2, "localPlugins": {"dev.example": invalid}}))
                .unwrap();
        fs::write(&path, &original).unwrap();
        assert!(PluginRegistry::load(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
    }
}

#[test]
fn invalid_api_edits_preserve_staged_registrations_and_preferences() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("config.json");
    let initial = registration(directory.path(), &[]);
    let mut registry = PluginRegistry::load(&path).unwrap();
    registry
        .register_local("dev.example", initial.clone())
        .unwrap();
    registry.set_enabled("dev.example", false).unwrap();
    for id in ["codlet", "codex.ui.adapter", "codlet.core.host"] {
        assert_eq!(
            io_kind(registry.register_local(id, initial.clone()).unwrap_err()),
            io::ErrorKind::InvalidInput
        );
    }
    for path in [PathBuf::new(), PathBuf::from("relative/plugin")] {
        assert_eq!(
            io_kind(
                registry
                    .register_local(
                        "dev.invalid",
                        LocalPluginRegistration {
                            path,
                            grants: vec![]
                        }
                    )
                    .unwrap_err()
            ),
            io::ErrorKind::InvalidInput
        );
    }
    let duplicate_grants = registration(directory.path(), &[Permission::UiDom, Permission::UiDom]);
    assert_eq!(
        io_kind(
            registry
                .register_local("dev.example", duplicate_grants)
                .unwrap_err()
        ),
        io::ErrorKind::InvalidInput
    );
    let mut different_path = initial.clone();
    different_path.path = directory.path().join("elsewhere");
    assert_eq!(
        io_kind(
            registry
                .register_local("dev.example", different_path)
                .unwrap_err()
        ),
        io::ErrorKind::AlreadyExists
    );
    assert_eq!(
        io_kind(
            registry
                .register_local("dev.alias", initial.clone())
                .unwrap_err()
        ),
        io::ErrorKind::AlreadyExists
    );
    assert_eq!(
        io_kind(registry.remove_local("dev.missing").unwrap_err()),
        io::ErrorKind::NotFound
    );
    assert_eq!(registry.local_plugins().len(), 1);
    assert_eq!(registry.local_plugins()["dev.example"], initial);
    assert!(!registry.is_enabled("dev.example"));
    assert!(!path.exists());
    registry.save().unwrap();
}

#[cfg(windows)]
#[test]
fn windows_paths_must_be_unicode_absolute_local_drive_paths() {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    let directory = tempdir().unwrap();
    let mut registry = PluginRegistry::load(directory.path().join("config.json")).unwrap();
    for invalid in [
        r"C:plugin",
        r"\plugin",
        r"\\server\share\plugin",
        r"\\?\UNC\server\share\plugin",
        r"\\.\pipe\plugin",
    ] {
        let local = LocalPluginRegistration {
            path: PathBuf::from(invalid),
            grants: vec![],
        };
        assert!(
            serde_json::from_value::<LocalPluginRegistration>(
                json!({"path": invalid, "grants": []})
            )
            .is_err(),
            "accepted {invalid}"
        );
        assert_eq!(
            io_kind(registry.register_local("dev.example", local).unwrap_err()),
            io::ErrorKind::InvalidInput
        );
    }
    let mut invalid: Vec<u16> = directory.path().as_os_str().encode_wide().collect();
    invalid.extend([b'\\' as u16, 0xD800]);
    let local = LocalPluginRegistration {
        path: PathBuf::from(OsString::from_wide(&invalid)),
        grants: vec![],
    };
    assert_eq!(
        io_kind(registry.register_local("dev.example", local).unwrap_err()),
        io::ErrorKind::InvalidInput
    );
    let canonical = directory.path().canonicalize().unwrap();
    registry
        .register_local("dev.example", registration(&canonical, &[]))
        .unwrap();
    registry.save().unwrap();
}

#[test]
fn remove_preserves_files_and_disabled_preference_when_registered_again() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("config.json");
    let local = registration(directory.path(), &[Permission::UiDom]);
    fs::create_dir(&local.path).unwrap();
    let source = local.path.join("plugin.json");
    fs::write(&source, b"source bytes are outside the registry contract").unwrap();
    let mut registry = seed(&path, local.clone());
    registry.set_enabled("dev.example", false).unwrap();
    registry.remove_local("dev.example").unwrap();
    assert!(registry.local_plugins().is_empty());
    assert!(
        !PluginRegistry::load(&path)
            .unwrap()
            .local_plugins()
            .is_empty()
    );
    registry.save().unwrap();
    assert_eq!(
        fs::read(&source).unwrap(),
        b"source bytes are outside the registry contract"
    );
    assert!(
        PluginRegistry::load(&path)
            .unwrap()
            .local_plugins()
            .is_empty()
    );
    assert!(!registry.is_enabled("dev.example"));
    registry.register_local("dev.example", local).unwrap();
    assert!(!registry.is_enabled("dev.example"));
    registry.save().unwrap();
    assert!(
        !PluginRegistry::load(&path)
            .unwrap()
            .is_enabled("dev.example")
    );
}

#[test]
fn stale_enablement_does_not_restore_revoked_grants_or_removed_registrations() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("config.json");
    let mut current = seed(
        &path,
        registration(
            directory.path(),
            &[Permission::UiDom, Permission::HostProcess],
        ),
    );
    let mut stale = current.clone();
    current
        .register_local(
            "dev.example",
            registration(directory.path(), &[Permission::UiDom]),
        )
        .unwrap();
    current.save().unwrap();
    stale.set_enabled("dev.example", false).unwrap();
    stale.save().unwrap();
    assert_eq!(
        stale.local_plugins()["dev.example"].grants,
        [Permission::UiDom]
    );
    assert!(!stale.is_enabled("dev.example"));
    current.remove_local("dev.example").unwrap();
    current.save().unwrap();
    stale.set_enabled("another.future-plugin", false).unwrap();
    stale.save().unwrap();
    assert!(stale.local_plugins().is_empty());
    assert!(!stale.is_enabled("dev.example"));
    assert!(!stale.is_enabled("another.future-plugin"));
    current.save().unwrap();
    assert!(!current.is_enabled("another.future-plugin"));
}

#[test]
fn stale_local_edits_preserve_independent_enablement_and_other_registrations() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("config.json");
    let mut current = seed(&path, registration(directory.path(), &[]));
    let mut stale = current.clone();
    current.set_enabled("dev.example", false).unwrap();
    current
        .register_local(
            "future.plugin",
            registration(&directory.path().join("future"), &[]),
        )
        .unwrap();
    current.save().unwrap();
    stale
        .register_local(
            "dev.example",
            registration(directory.path(), &[Permission::UiDom]),
        )
        .unwrap();
    stale.save().unwrap();
    assert!(!stale.is_enabled("dev.example"));
    assert!(stale.local_plugins().contains_key("future.plugin"));
    current.set_enabled("another.future-plugin", false).unwrap();
    current.save().unwrap();
    stale.remove_local("dev.example").unwrap();
    stale.save().unwrap();
    assert!(!stale.is_enabled("another.future-plugin"));
    assert_eq!(stale.local_plugins().len(), 1);
}

#[test]
fn concurrent_adds_and_grants_updates_conflict_without_partial_preference_commits() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("config.json");
    let mut first = PluginRegistry::load(&path).unwrap();
    let mut second = first.clone();
    let local = registration(directory.path(), &[Permission::UiDom]);
    first.register_local("dev.example", local.clone()).unwrap();
    second.register_local("dev.example", local.clone()).unwrap();
    second.set_enabled("codlet", false).unwrap();
    first.save().unwrap();
    let committed = fs::read(&path).unwrap();
    assert_eq!(
        io_kind(second.save().unwrap_err()),
        io::ErrorKind::AlreadyExists
    );
    assert_eq!(fs::read(&path).unwrap(), committed);
    assert!(!second.is_enabled("codlet"));
    assert!(PluginRegistry::load(&path).unwrap().is_enabled("codlet"));

    second = PluginRegistry::load(&path).unwrap();
    // Even explicitly restaging unchanged old grants cannot undo a concurrent revoke.
    second.register_local("dev.example", local).unwrap();
    second.set_enabled("codlet", false).unwrap();
    first
        .register_local("dev.example", registration(directory.path(), &[]))
        .unwrap();
    first.save().unwrap();
    let committed = fs::read(&path).unwrap();
    assert_eq!(
        io_kind(second.save().unwrap_err()),
        io::ErrorKind::InvalidData
    );
    assert_eq!(fs::read(&path).unwrap(), committed);
    assert_eq!(
        second.local_plugins()["dev.example"].grants,
        [Permission::UiDom]
    );
    assert!(PluginRegistry::load(&path).unwrap().is_enabled("codlet"));
}

#[test]
fn remove_wins_over_stale_update_and_retries_cannot_silently_recreate_it() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("config.json");
    let mut current = seed(&path, registration(directory.path(), &[]));
    let mut stale_update = current.clone();
    let mut stale_remove = current.clone();
    stale_update
        .register_local(
            "dev.example",
            registration(directory.path(), &[Permission::HostProcess]),
        )
        .unwrap();
    stale_update.set_enabled("codlet", false).unwrap();
    stale_remove.remove_local("dev.example").unwrap();
    current.remove_local("dev.example").unwrap();
    current.save().unwrap();
    let removed = fs::read(&path).unwrap();
    for _ in 0..2 {
        assert_eq!(
            io_kind(stale_update.save().unwrap_err()),
            io::ErrorKind::NotFound
        );
        assert_eq!(
            io_kind(stale_remove.save().unwrap_err()),
            io::ErrorKind::NotFound
        );
        assert_eq!(fs::read(&path).unwrap(), removed);
    }
    assert_eq!(
        stale_update.local_plugins()["dev.example"].grants,
        [Permission::HostProcess]
    );
    assert!(PluginRegistry::load(&path).unwrap().is_enabled("codlet"));
    let mut reloaded = PluginRegistry::load(&path).unwrap();
    reloaded
        .register_local("dev.example", registration(directory.path(), &[]))
        .unwrap();
    reloaded.save().unwrap();
    assert!(reloaded.local_plugins()["dev.example"].grants.is_empty());
}

#[test]
fn stale_remove_conflicts_with_grants_change_and_new_path_assignment() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("config.json");
    let mut current = seed(&path, registration(directory.path(), &[Permission::UiDom]));
    let mut stale = current.clone();
    stale.remove_local("dev.example").unwrap();
    current
        .register_local("dev.example", registration(directory.path(), &[]))
        .unwrap();
    current.save().unwrap();
    assert_eq!(
        io_kind(stale.save().unwrap_err()),
        io::ErrorKind::InvalidData
    );
    let mut stale_update = current.clone();
    stale_update
        .register_local(
            "dev.example",
            registration(directory.path(), &[Permission::UiDom]),
        )
        .unwrap();
    current.remove_local("dev.example").unwrap();
    current.save().unwrap();
    current
        .register_local(
            "dev.example",
            registration(&directory.path().join("replacement"), &[]),
        )
        .unwrap();
    current.save().unwrap();
    assert_eq!(
        io_kind(stale_update.save().unwrap_err()),
        io::ErrorKind::InvalidData
    );
    assert_eq!(
        PluginRegistry::load(&path).unwrap().local_plugins(),
        current.local_plugins()
    );
}

#[test]
fn independent_ids_cannot_commit_the_same_path_from_stale_snapshots() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("config.json");
    let mut first = PluginRegistry::load(&path).unwrap();
    let mut second = first.clone();
    let local = registration(directory.path(), &[]);
    first.register_local("dev.one", local.clone()).unwrap();
    second.register_local("dev.two", local).unwrap();
    second.set_enabled("codlet", false).unwrap();
    first.save().unwrap();
    let committed = fs::read(&path).unwrap();
    assert!(
        second
            .save()
            .unwrap_err()
            .to_string()
            .contains("duplicate paths")
    );
    assert_eq!(fs::read(&path).unwrap(), committed);
    assert!(PluginRegistry::load(&path).unwrap().is_enabled("codlet"));
}

#[test]
fn cancelling_a_staged_add_does_not_remove_a_concurrent_registration() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("config.json");
    let mut registry = PluginRegistry::load(&path).unwrap();
    let local = registration(directory.path(), &[]);
    registry
        .register_local("dev.example", local.clone())
        .unwrap();
    registry.remove_local("dev.example").unwrap();
    registry.set_enabled("dev.example", false).unwrap();
    seed(&path, local.clone());
    registry.save().unwrap();
    assert_eq!(registry.local_plugins()["dev.example"], local);
    assert!(!registry.is_enabled("dev.example"));
}

#[cfg(windows)]
#[test]
fn failed_replacement_preserves_pending_edits_and_retry_merges_latest_preferences() {
    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;

    let directory = tempdir().unwrap();
    let path = directory.path().join("config.json");
    let mut registry = seed(&path, registration(directory.path(), &[]));
    let original = fs::read(&path).unwrap();
    registry
        .register_local(
            "dev.example",
            registration(directory.path(), &[Permission::UiDom]),
        )
        .unwrap();
    registry.set_enabled("dev.example", false).unwrap();
    let staged = registry.local_plugins().clone();
    let blocker = OpenOptions::new()
        .read(true)
        .share_mode(0x1 | 0x2)
        .open(&path)
        .unwrap();
    assert!(matches!(
        registry.save(),
        Err(PluginRegistryError::Io {
            operation: "replace",
            ..
        })
    ));
    assert_eq!(fs::read(&path).unwrap(), original);
    assert_eq!(registry.local_plugins(), &staged);
    assert!(!registry.is_enabled("dev.example"));
    assert_eq!(directory.path().read_dir().unwrap().count(), 2);
    drop(blocker);
    let mut another = PluginRegistry::load(&path).unwrap();
    another.set_enabled("future.plugin", false).unwrap();
    another.save().unwrap();
    registry.save().unwrap();
    assert_eq!(registry.local_plugins(), &staged);
    assert!(!registry.is_enabled("dev.example"));
    assert!(!registry.is_enabled("future.plugin"));
    assert_eq!(
        PluginRegistry::load(&path).unwrap().local_plugins(),
        &staged
    );
}

#[test]
fn invalid_latest_document_blocks_the_entire_local_transaction_and_can_be_repaired() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("config.json");
    let mut registry = seed(&path, registration(directory.path(), &[]));
    let original = fs::read(&path).unwrap();
    registry
        .register_local(
            "dev.example",
            registration(directory.path(), &[Permission::UiDom]),
        )
        .unwrap();
    registry.set_enabled("codlet", false).unwrap();
    let invalid = br#"{"schema":2,"localPlugins":{"dev.example":{"path":"relative","grants":[]}}}"#;
    fs::write(&path, invalid).unwrap();
    assert!(registry.save().is_err());
    assert_eq!(fs::read(&path).unwrap(), invalid);
    assert_eq!(
        registry.local_plugins()["dev.example"].grants,
        [Permission::UiDom]
    );
    assert!(!registry.is_enabled("codlet"));
    fs::write(&path, original).unwrap();
    registry.save().unwrap();
    assert!(!registry.is_enabled("codlet"));
    assert_eq!(
        registry.local_plugins()["dev.example"].grants,
        [Permission::UiDom]
    );
}
