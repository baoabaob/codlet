//! Stable registry identity and the lease shared by Host startup and offline edits.
use std::ffi::OsString;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use windows_sys::Win32::Security::Cryptography::*;

use super::launch_mutex::{LaunchMutexError, LaunchMutexGuard, current_user_sid_bytes};
use super::local_ipc::LocalIpcError;

#[derive(Clone, Debug)]
pub struct RegistryScope {
    path: PathBuf,
    id: String,
    pipe_name: OsString,
    mutex_name: OsString,
}

impl RegistryScope {
    pub fn for_path(path: &Path) -> Result<Self, LocalIpcError> {
        let path = canonical_registry_path(path)?;
        let mut bytes = Vec::new();
        for character in path.as_os_str().encode_wide() {
            // Existing ancestors are resolved to their OS spelling; the fixed registry
            // suffix is ASCII. Fold drive/ASCII spelling without lossy path conversion.
            let character = if (b'A' as u16..=b'Z' as u16).contains(&character) {
                character + 32
            } else {
                character
            };
            bytes.extend_from_slice(&character.to_le_bytes());
        }
        let id = sha256(&bytes)?;
        let sid = user_suffix()?;
        Ok(Self {
            path,
            pipe_name: OsString::from(format!(r"\\.\pipe\Codlet.RuntimeControl.{sid}.{id}")),
            mutex_name: OsString::from(format!(r"Global\Codlet.RegistryControl.{sid}.{id}")),
            id,
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub(crate) fn pipe_name(&self) -> &std::ffi::OsStr {
        &self.pipe_name
    }

    pub fn acquire(&self, timeout: Duration) -> Result<RegistryScopeGuard, LocalIpcError> {
        let guard = LaunchMutexGuard::acquire_named(&self.mutex_name, timeout).map_err(
            |error| match error {
                LaunchMutexError::Timeout => LocalIpcError::Timeout,
                other => LocalIpcError::Invalid(other.to_string()),
            },
        )?;
        Ok(RegistryScopeGuard {
            scope: self.clone(),
            _guard: guard,
        })
    }
}

/// Thread affine: the foreground thread owns the lease until its Host is dropped.
pub struct RegistryScopeGuard {
    scope: RegistryScope,
    _guard: LaunchMutexGuard,
}
impl RegistryScopeGuard {
    pub fn scope(&self) -> &RegistryScope {
        &self.scope
    }
}

pub(crate) fn discovery_pipe_name() -> Result<OsString, LocalIpcError> {
    Ok(OsString::from(format!(
        r"\\.\pipe\Codlet.RuntimeControlDiscovery.{}",
        user_suffix()?
    )))
}

fn user_suffix() -> Result<String, LocalIpcError> {
    Ok(current_user_sid_bytes()
        .map_err(|error| LocalIpcError::Invalid(error.to_string()))?
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn canonical_registry_path(path: &Path) -> Result<PathBuf, LocalIpcError> {
    let absolute = std::path::absolute(path)?;
    let mut ancestor = absolute.as_path();
    let mut missing = Vec::new();
    loop {
        match std::fs::canonicalize(ancestor) {
            Ok(mut resolved) => {
                for name in missing.iter().rev() {
                    resolved.push(name);
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let name = ancestor.file_name().ok_or_else(|| {
                    LocalIpcError::Invalid("registry has no existing ancestor".into())
                })?;
                missing.push(name.to_os_string());
                ancestor = ancestor
                    .parent()
                    .ok_or_else(|| LocalIpcError::Invalid("registry has no parent".into()))?;
            }
            Err(error) => return Err(error.into()),
        }
    }
}

pub(crate) fn random_incarnation() -> Result<[u8; 16], LocalIpcError> {
    let mut bytes = [0_u8; 16];
    check_crypto(unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    })?;
    Ok(bytes)
}

fn sha256(bytes: &[u8]) -> Result<String, LocalIpcError> {
    struct Hash {
        algorithm: BCRYPT_ALG_HANDLE,
        hash: BCRYPT_HASH_HANDLE,
    }
    impl Drop for Hash {
        fn drop(&mut self) {
            unsafe {
                if !self.hash.is_null() {
                    BCryptDestroyHash(self.hash);
                }
                if !self.algorithm.is_null() {
                    BCryptCloseAlgorithmProvider(self.algorithm, 0);
                }
            }
        }
    }
    let mut hash = Hash {
        algorithm: std::ptr::null_mut(),
        hash: std::ptr::null_mut(),
    };
    check_crypto(unsafe {
        BCryptOpenAlgorithmProvider(
            &mut hash.algorithm,
            BCRYPT_SHA256_ALGORITHM,
            std::ptr::null(),
            0,
        )
    })?;
    check_crypto(unsafe {
        BCryptCreateHash(
            hash.algorithm,
            &mut hash.hash,
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
            0,
            0,
        )
    })?;
    let count = u32::try_from(bytes.len())
        .map_err(|_| LocalIpcError::Invalid("registry identity exceeds CNG input limit".into()))?;
    check_crypto(unsafe { BCryptHashData(hash.hash, bytes.as_ptr(), count, 0) })?;
    let mut output = [0_u8; 32];
    check_crypto(unsafe {
        BCryptFinishHash(hash.hash, output.as_mut_ptr(), output.len() as u32, 0)
    })?;
    Ok(output.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn check_crypto(status: i32) -> Result<(), LocalIpcError> {
    if status < 0 {
        Err(LocalIpcError::Invalid(format!(
            "CNG identity operation failed: {status:#x}"
        )))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_scope_is_stable_across_creation_and_spelling_and_separates_configs() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("Codlet/config.json");
        let before = RegistryScope::for_path(&path).unwrap();
        std::fs::create_dir(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"{}").unwrap();
        let after = RegistryScope::for_path(&path).unwrap();
        assert_eq!(before.id(), after.id());
        let alternate = directory.path().join("codlet/./CONFIG.JSON");
        assert_eq!(
            after.id(),
            RegistryScope::for_path(&alternate).unwrap().id()
        );
        assert_ne!(
            after.id(),
            RegistryScope::for_path(&directory.path().join("other/config.json"))
                .unwrap()
                .id()
        );
        assert_eq!(before.id().len(), 64);
    }

    #[test]
    fn scope_lease_serializes_host_and_offline_owner_and_releases_on_drop() {
        let directory = tempfile::tempdir().unwrap();
        let scope = RegistryScope::for_path(&directory.path().join("config.json")).unwrap();
        let held = scope.acquire(Duration::ZERO).unwrap();
        let other_scope = scope.clone();
        std::thread::spawn(move || {
            assert!(matches!(
                other_scope.acquire(Duration::from_millis(20)),
                Err(LocalIpcError::Timeout)
            ))
        })
        .join()
        .unwrap();
        drop(held);
        drop(scope.acquire(Duration::ZERO).unwrap());
    }
}
