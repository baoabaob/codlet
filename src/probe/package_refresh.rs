//! Retry only the explicit pre-resume signal from the owned activation helper.
//! An already resumed client or a plugin/IPC failure is never replayed here.
use super::{InstalledPackage, ProbeError, ProcessError};
use std::collections::BTreeSet;

pub(super) fn launch<T>(
    mut selected: InstalledPackage,
    mut attempt: impl FnMut(&InstalledPackage) -> Result<T, ProbeError>,
) -> Result<(InstalledPackage, T), ProbeError> {
    let mut seen = BTreeSet::from([selected.full_name.clone()]);
    for index in 0..3 {
        match attempt(&selected) {
            Ok(value) => return Ok((selected, value)),
            Err(error) => {
                let ProbeError::Process(ProcessError::PackageSelectionChanged {
                    selected: previous,
                    active,
                }) = &error
                else {
                    return Err(error);
                };
                if index == 2
                    || previous != &selected.full_name
                    || active.family_name != selected.family_name
                    || !seen.insert(active.full_name.clone())
                {
                    return Err(error);
                }
                eprintln!(
                    "client-package-selection: refreshed from owned activation; previous={}; current={}",
                    selected.full_name, active.full_name
                );
                selected = active.as_ref().clone();
            }
        }
    }
    unreachable!("every final attempt returns")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windows::packages::{
        CODEX_EXECUTABLE_RELATIVE_PATH, PackageVersion, resolve_package_executable,
    };
    use std::path::{Path, PathBuf};

    fn package(name: &str) -> InstalledPackage {
        InstalledPackage {
            family_name: "fixture_family".into(),
            full_name: name.into(),
            install_location: PathBuf::from(name),
            version: PackageVersion {
                major: 1,
                minor: 0,
                build: 0,
                revision: 0,
            },
        }
    }
    fn changed(selected: &InstalledPackage, active: InstalledPackage) -> ProbeError {
        ProcessError::PackageSelectionChanged {
            selected: selected.full_name.clone(),
            active: Box::new(active),
        }
        .into()
    }

    #[test]
    fn stale_snapshot_refreshes_both_identity_and_executable() {
        let root = tempfile::tempdir().unwrap();
        let mut old = package("old");
        old.install_location = root.path().join("old");
        let mut new = package("new");
        new.install_location = root.path().join("new");
        new.version.build = 2;
        for item in [&old, &new] {
            std::fs::create_dir_all(item.install_location.join("app")).unwrap();
            std::fs::write(
                item.install_location.join(CODEX_EXECUTABLE_RELATIVE_PATH),
                b"fixture",
            )
            .unwrap();
        }
        let mut paths = Vec::new();
        let (actual, executable) = launch(old.clone(), |selected| {
            let executable =
                resolve_package_executable(selected, Path::new(CODEX_EXECUTABLE_RELATIVE_PATH))?;
            paths.push(executable.clone());
            if selected.full_name == old.full_name {
                return Err(changed(selected, new.clone()));
            }
            Ok(executable)
        })
        .unwrap();
        assert_eq!(actual, new);
        assert_eq!(paths.len(), 2);
        assert_ne!(paths[0], paths[1]);
        assert_eq!(executable, paths[1]);
    }

    #[test]
    fn refresh_never_follows_foreign_replayed_or_misattributed_identity() {
        for mode in ["foreign", "same", "misattributed"] {
            let mut calls = 0;
            let result = launch(package("old"), |selected| -> Result<(), ProbeError> {
                calls += 1;
                let mut active = package(if mode == "same" { "old" } else { "new" });
                if mode == "foreign" {
                    active.family_name = "other_family".into();
                }
                let mut claimed = selected.clone();
                if mode == "misattributed" {
                    claimed.full_name = "not_the_attempt".into();
                }
                Err(changed(&claimed, active))
            });
            assert!(result.is_err());
            assert_eq!(calls, 1, "{mode}");
        }
    }

    #[test]
    fn repeated_package_changes_are_bounded_and_generic_failures_are_not_replayed() {
        let mut calls = 0;
        assert!(
            launch(package("first"), |selected| -> Result<(), ProbeError> {
                calls += 1;
                Err(changed(selected, package(&format!("update-{calls}"))))
            })
            .is_err()
        );
        assert_eq!(calls, 3);
        let mut calls = 0;
        assert!(
            launch(package("first"), |_| -> Result<(), ProbeError> {
                calls += 1;
                Err(ProcessError::PackageLaunch("untrusted peer or failed handshake".into()).into())
            })
            .is_err()
        );
        assert_eq!(calls, 1);
    }

    #[test]
    fn refreshed_attempt_still_honors_instance_conflicts() {
        let mut calls = 0;
        let result = launch(package("old"), |selected| -> Result<(), ProbeError> {
            calls += 1;
            if calls == 1 {
                return Err(changed(selected, package("new")));
            }
            Err(ProbeError::InstanceConflict {
                executable: PathBuf::from("new/app/ChatGPT.exe"),
                process_ids: vec![42],
            })
        });
        assert!(
            matches!(result,Err(ProbeError::InstanceConflict {process_ids,..}) if process_ids==[42])
        );
        assert_eq!(calls, 2);
    }
}
