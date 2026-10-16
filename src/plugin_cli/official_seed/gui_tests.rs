use super::*;
use crate::managed_plugins::{self, ManagedOperation};
use crate::plugin_permissions::BrokerPolicy;
use std::io::Cursor;

const ID: &str = "codlet-gui";
const REPOSITORY: &str = "https://github.com/baoabaob/codlet-gui";
const IDENTITY: (u64, u64) = (1379359689, 76909162);

struct Fixture {
    _temp: tempfile::TempDir,
    registry: PathBuf,
    catalog: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let registry = temp.path().join("data/config.json");
        let catalog = temp.path().join("bundle/catalog.json");
        fs::create_dir_all(registry.parent().unwrap()).unwrap();
        fs::create_dir_all(catalog.parent().unwrap().join("packages").join(ID)).unwrap();
        Self {
            _temp: temp,
            registry,
            catalog,
        }
    }
    fn registry(&self) -> PluginRegistry {
        PluginRegistry::load(&self.registry).unwrap()
    }
    fn files(version: &str) -> [(String, Vec<u8>); 2] {
        [("codlet.json".into(), serde_json::to_vec(&json!({"schema":1,"id":ID,"version":version,"permissions":["ui.dom","runtime.manage"],"renderer":{"entry":"renderer.js","world":"isolated"}})).unwrap()),
         ("renderer.js".into(), format!("module.exports={{activate(){{throw Error('do not execute {version}')}}}};").into_bytes())]
    }
    fn bundle(&self, version: &str) {
        let source = self.catalog.parent().unwrap().join("packages").join(ID);
        let files = Self::files(version)
            .into_iter()
            .map(|(path, data)| {
                fs::write(source.join(&path), &data).unwrap();
                FileRecord {
                    path,
                    bytes: data.len() as u64,
                    sha256: format!("{:x}", Sha256::digest(&data)),
                }
            })
            .collect::<Vec<_>>();
        write(&self.catalog, &json!({"schema":1,"kind":"codlet-official-plugin-bundle","packages":[Package {
            id: ID.into(), version: version.into(), permissions: vec![Permission::UiDom, Permission::RuntimeManage], files,
            update_source: crate::plugin_update_source::official_channel(ID),
        }]})).unwrap();
    }
    fn github(&self, version: &str, identity: (u64, u64), operation: ManagedOperation) {
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (path, data) in Self::files(version) {
            archive
                .start_file(path, zip::write::SimpleFileOptions::default())
                .unwrap();
            archive.write_all(&data).unwrap();
        }
        let archive = archive.finish().unwrap().into_inner();
        let prepared = crate::github_distribution::test_prepare_archive_repository(
            &self.registry,
            &archive,
            Some(identity),
            REPOSITORY,
        )
        .unwrap();
        let previous = self.registry();
        let preview =
            managed_plugins::preview(&previous, &prepared.package_path, operation).unwrap();
        let request = preview.request(
            vec![Permission::UiDom, Permission::RuntimeManage],
            BrokerPolicy::default(),
            true,
        );
        let (candidate, _) = managed_plugins::stage(&previous, ID, &request).unwrap();
        let (mut installation, mut installed, _) =
            crate::managed_storage::Installation::publish(&candidate, &previous, ID, true).unwrap();
        installed.set_enabled(ID, true).unwrap();
        installed.save().unwrap();
        installation.commit().unwrap();
    }
    fn seed(&self) {
        let registry = self.registry();
        let selected = select(&registry, &self.catalog, ID).unwrap();
        let grants = selected.added_permissions.clone();
        install(&registry, selected, grants).unwrap();
    }
    fn target(&self) -> PathBuf {
        roots(&self.registry).unwrap().0.join(ID)
    }
    fn managed(&self) -> PathBuf {
        roots(&self.registry).unwrap().0.join("github").join(ID)
    }
}

#[test]
fn bundled_gui_upgrades_verified_github_preserving_revocation_and_can_return_to_github() {
    let f = Fixture::new();
    f.github("0.1.9", IDENTITY, ManagedOperation::Install);
    let mut previous = f.registry();
    let mut registration = previous.local_plugins()[ID].clone();
    registration.grants = vec![Permission::RuntimeManage];
    registration.broker_policy.client_permissions = true;
    let managed = previous.managed_plugins()[ID].clone();
    previous.restore_managed(ID, Some(registration.clone()), Some(managed));
    previous.set_enabled(ID, false).unwrap();
    previous.save().unwrap();
    f.bundle("1.0.0-rc.2");
    assert!(
        select(&f.registry(), &f.catalog, ID)
            .unwrap()
            .added_permissions
            .is_empty()
    );
    f.seed();
    let installed = f.registry();
    registration.path = f.target();
    assert_eq!(installed.local_plugins()[ID], registration);
    assert!(!installed.is_enabled(ID));
    assert!(!f.managed().exists());
    assert!(verified_installer_source(&installed, ID));
    assert!(verified_update_channel(&installed, ID).is_some());
    let before = fs::read(&f.registry).unwrap();
    assert!(select(&installed, &f.catalog, ID).unwrap().keep_current);
    f.seed();
    assert_eq!(fs::read(&f.registry).unwrap(), before);
    f.github("1.0.0", IDENTITY, ManagedOperation::Adopt);
    managed_plugins::validate_current(&f.registry(), ID).unwrap();
    assert!(!f.target().exists());
}

#[test]
fn bundled_gui_keeps_equal_or_newer_versions_for_both_sources() {
    for version in ["1.0.0-rc.2", "1.0.0"] {
        for github in [true, false] {
            let f = Fixture::new();
            if github {
                f.github(version, IDENTITY, ManagedOperation::Install);
            } else {
                f.bundle(version);
                f.seed();
            }
            f.bundle("1.0.0-rc.2");
            let before = fs::read(&f.registry).unwrap();
            let selected = select(&f.registry(), &f.catalog, ID).unwrap();
            assert!(selected.keep_current);
            assert!(selected.added_permissions.is_empty());
            f.seed();
            assert_eq!(fs::read(&f.registry).unwrap(), before);
        }
    }
}

#[test]
fn bundled_gui_refuses_foreign_identity_modified_source_and_stale_registration() {
    for changed in ["owner", "content", "custom"] {
        let f = Fixture::new();
        f.github(
            "0.1.9",
            if changed == "owner" {
                (IDENTITY.0, 42)
            } else {
                IDENTITY
            },
            ManagedOperation::Install,
        );
        f.bundle("1.0.0-rc.2");
        if changed == "content" {
            fs::write(f.managed().join("author.txt"), "preserve").unwrap();
        }
        if changed == "custom" {
            let mut registry = f.registry();
            let registration = registry.local_plugins()[ID].clone();
            registry.restore_managed(ID, Some(registration), None);
            registry.save().unwrap();
        }
        let before = fs::read(&f.registry).unwrap();
        assert!(select(&f.registry(), &f.catalog, ID).is_err(), "{changed}");
        assert_eq!(fs::read(&f.registry).unwrap(), before);
        assert!(f.managed().join("renderer.js").exists());
    }
    let f = Fixture::new();
    f.github("0.1.9", IDENTITY, ManagedOperation::Install);
    f.bundle("1.0.0-rc.2");
    let previous = f.registry();
    let selection = select(&previous, &f.catalog, ID).unwrap();
    let mut changed = previous.clone();
    changed.set_enabled(ID, false).unwrap();
    changed.save().unwrap();
    assert!(install(&previous, selection, vec![]).is_err());
    assert!(!f.registry().is_enabled(ID));
    assert!(f.managed().exists());
}

#[test]
fn bundled_gui_recovers_github_transition_at_every_durable_boundary() {
    for boundary in 0..7 {
        let f = Fixture::new();
        f.github("0.1.9", IDENTITY, ManagedOperation::Install);
        f.bundle("1.0.0-rc.2");
        let previous = f.registry();
        let selected = select(&previous, &f.catalog, ID).unwrap();
        let mut next = selected.registration.clone().unwrap();
        next.path = selected.target.clone();
        let journal = Journal {
            schema: 1,
            id: ID.into(),
            previous: selected.registration,
            previous_managed: selected.previous_managed,
            previous_managed_package: selected.previous_managed_package,
            next: next.clone(),
            previous_enabled: true,
            enabled: true,
            previous_package: None,
            package: selected.package.clone(),
            previous_receipt: None,
            committed: boundary >= 5,
        };
        let (_, tx) = roots(&f.registry).unwrap();
        let ready = tx.join(format!("{ID}.ready"));
        write(&tx.join(format!("{ID}.json")), &journal).unwrap();
        fs::create_dir(&ready).unwrap();
        if boundary == 0 {
            fs::write(ready.join("codlet.json"), "partial").unwrap();
        } else {
            for file in &journal.package.files {
                fs::copy(selected.source.join(&file.path), ready.join(&file.path)).unwrap();
            }
        }
        if boundary >= 2 {
            fs::rename(&ready, f.target()).unwrap();
        }
        if boundary >= 3 {
            let mut registry = f.registry();
            registry.restore_managed(ID, None, None);
            registry.register_local(ID, next.clone()).unwrap();
            registry.save().unwrap();
        }
        if boundary >= 4 {
            write(
                &receipt_path(&f.registry, ID).unwrap(),
                &Receipt {
                    schema: 1,
                    source: "official-installer".into(),
                    package: journal.package.clone(),
                },
            )
            .unwrap();
        }
        if boundary == 6 {
            fs::remove_file(f.managed().join("renderer.js")).unwrap();
        }
        recover(&f.registry).unwrap();
        recover(&f.registry).unwrap();
        if boundary >= 5 {
            assert_eq!(f.registry().local_plugins()[ID], next);
            assert!(verified_installer_source(&f.registry(), ID));
            assert!(!f.managed().exists());
        } else {
            assert_eq!(
                registration_digest(&f.registry(), ID),
                registration_digest(&previous, ID)
            );
            managed_plugins::validate_current(&f.registry(), ID).unwrap();
            assert!(!f.target().exists());
        }
        assert!(!tx.join(format!("{ID}.json")).exists());
        assert!(!ready.exists());
    }
}
