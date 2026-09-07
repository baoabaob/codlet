//! Populate only the audited package's immutable Node runtime in the fresh lab.
//! The Desktop's synchronous cache materializer otherwise delays shell hydration.
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use serde::Serialize;
use windows_sys::Win32::Security::Cryptography::{
    BCRYPT_ALG_HANDLE, BCRYPT_HASH_HANDLE, BCRYPT_SHA256_ALGORITHM, BCryptCloseAlgorithmProvider,
    BCryptCreateHash, BCryptDestroyHash, BCryptFinishHash, BCryptHashData,
    BCryptOpenAlgorithmProvider,
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
};

use super::{LabError, pin_plain_directory};

const MARKERS: [&str; 3] = ["manifest.json", "bin/node.exe", "bin/node_repl.exe"];
const MAX_FILES: usize = 20_000;
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Serialize)]
struct Marker {
    relative_path: String,
    sha256: String,
    size: u64,
}

#[derive(Serialize)]
pub(super) struct RuntimeSeed {
    pub source: PathBuf,
    pub destination: PathBuf,
    pub cache_key: String,
    pub copied_files: usize,
    pub copied_bytes: u64,
    markers: Vec<Marker>,
    #[serde(skip)]
    _pins: Vec<File>,
}

impl RuntimeSeed {
    pub fn prepare(resources: &Path, local_app_data: &Path) -> Result<Self, LabError> {
        let source = resources.join("cua_node");
        // Release the package-directory guard when preparation finishes. Only
        // fresh lab directories remain pinned during the Desktop's lifetime.
        let _source_guard = pin_plain_directory(&source)?;
        let mut pins = Vec::new();
        let markers = markers(&source)?;
        let cache_key = cache_key(&markers)?;
        let mut destination = local_app_data.to_owned();
        for part in ["OpenAI", "Codex", "runtimes", "cua_node", &cache_key] {
            destination.push(part);
            fs::create_dir(&destination)?;
            pins.push(pin_plain_directory(&destination)?);
        }
        let mut seed = Self {
            source,
            destination,
            cache_key,
            copied_files: 0,
            copied_bytes: 0,
            markers,
            _pins: pins,
        };
        let source = seed.source.clone();
        let destination = seed.destination.clone();
        seed.copy_contents(&source, &destination, 0)?;
        seed.verify()?;
        Ok(seed)
    }

    pub fn verify(&self) -> Result<(), LabError> {
        for marker in &self.markers {
            for root in [&self.source, &self.destination] {
                let (digest, size) = hash_file(&root.join(&marker.relative_path))?;
                if digest != marker.sha256 || size != marker.size {
                    return Err(LabError::Preflight(
                        "audited runtime marker changed before start".into(),
                    ));
                }
            }
        }
        let _modules = pin_plain_directory(&self.destination.join("bin/node_modules"))?;
        Ok(())
    }

    fn copy_contents(
        &mut self,
        source: &Path,
        destination: &Path,
        depth: usize,
    ) -> Result<(), LabError> {
        if depth > 32 {
            return Err(LabError::Preflight(
                "bundled runtime nesting limit exceeded".into(),
            ));
        }
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            let metadata = fs::symlink_metadata(entry.path())?;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(LabError::Preflight(
                    "bundled runtime contains a reparse point".into(),
                ));
            }
            let target = destination.join(entry.file_name());
            if metadata.is_dir() {
                fs::create_dir(&target)?;
                self._pins.push(pin_plain_directory(&target)?);
                self.copy_contents(&entry.path(), &target, depth + 1)?;
            } else if metadata.is_file() {
                self.copied_files += 1;
                self.copied_bytes = self
                    .copied_bytes
                    .checked_add(metadata.len())
                    .ok_or_else(|| LabError::Preflight("bundled runtime size overflow".into()))?;
                if self.copied_files > MAX_FILES || self.copied_bytes > MAX_BYTES {
                    return Err(LabError::Preflight(
                        "bundled runtime copy budget exceeded".into(),
                    ));
                }
                let mut input = plain_file(&entry.path())?;
                let mut output = super::new_file(&target)?;
                let copied = std::io::copy(&mut input, &mut output)?;
                if copied != metadata.len() {
                    return Err(LabError::Preflight(
                        "bundled runtime file changed while copying".into(),
                    ));
                }
                output.flush()?;
            } else {
                return Err(LabError::Preflight(
                    "bundled runtime contains a non-file entry".into(),
                ));
            }
        }
        Ok(())
    }
}

fn markers(root: &Path) -> Result<Vec<Marker>, LabError> {
    MARKERS
        .into_iter()
        .map(|relative| {
            let (sha256, size) = hash_file(&root.join(relative))?;
            Ok(Marker {
                relative_path: relative.into(),
                sha256,
                size,
            })
        })
        .collect()
}

fn cache_key(markers: &[Marker]) -> Result<String, LabError> {
    // Exact installed cL/mL algorithm: names, NUL, lowercase hex digest, NUL.
    let mut hash = Sha256::new()?;
    for marker in markers {
        hash.update(marker.relative_path.as_bytes())?;
        hash.update(&[0])?;
        hash.update(marker.sha256.as_bytes())?;
        hash.update(&[0])?;
    }
    Ok(hash.finish()?[..16].to_owned())
}

fn plain_file(path: &Path) -> Result<File, LabError> {
    let file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(LabError::Preflight(
            "bundled runtime source is not a plain file".into(),
        ));
    }
    Ok(file)
}

fn hash_file(path: &Path) -> Result<(String, u64), LabError> {
    let mut file = plain_file(path)?;
    let mut hash = Sha256::new()?;
    let mut bytes = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let count = file.read(&mut bytes)?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > MAX_BYTES {
            return Err(LabError::Preflight("runtime marker is oversized".into()));
        }
        hash.update(&bytes[..count])?;
    }
    Ok((hash.finish()?, total))
}

struct Sha256 {
    algorithm: BCRYPT_ALG_HANDLE,
    hash: BCRYPT_HASH_HANDLE,
}
impl Sha256 {
    fn new() -> Result<Self, LabError> {
        let mut result = Self {
            algorithm: std::ptr::null_mut(),
            hash: std::ptr::null_mut(),
        };
        // CNG owns the hash-object storage until BCryptDestroyHash (Windows 7+).
        check_crypto(unsafe {
            BCryptOpenAlgorithmProvider(
                &mut result.algorithm,
                BCRYPT_SHA256_ALGORITHM,
                std::ptr::null(),
                0,
            )
        })?;
        check_crypto(unsafe {
            BCryptCreateHash(
                result.algorithm,
                &mut result.hash,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
                0,
                0,
            )
        })?;
        Ok(result)
    }
    fn update(&mut self, bytes: &[u8]) -> Result<(), LabError> {
        let count = u32::try_from(bytes.len())
            .map_err(|_| LabError::Preflight("hash input is oversized".into()))?;
        check_crypto(unsafe { BCryptHashData(self.hash, bytes.as_ptr(), count, 0) })
    }
    fn finish(self) -> Result<String, LabError> {
        let mut output = [0_u8; 32];
        check_crypto(unsafe {
            BCryptFinishHash(self.hash, output.as_mut_ptr(), output.len() as u32, 0)
        })?;
        Ok(output
            .into_iter()
            .map(|byte| format!("{byte:02x}"))
            .collect())
    }
}
impl Drop for Sha256 {
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
fn check_crypto(status: i32) -> Result<(), LabError> {
    if status < 0 {
        Err(LabError::Preflight(format!(
            "Windows SHA-256 failed: {status:#x}"
        )))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_known_vectors() {
        assert_eq!(
            Sha256::new().unwrap().finish().unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        let mut hash = Sha256::new().unwrap();
        hash.update(b"a").unwrap();
        hash.update(b"bc").unwrap();
        assert_eq!(
            hash.finish().unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    fn fixture() -> tempfile::TempDir {
        let resources = tempfile::tempdir().unwrap();
        let root = resources.path().join("cua_node");
        fs::create_dir_all(root.join("bin/node_modules/example")).unwrap();
        fs::write(root.join("manifest.json"), b"{}\n").unwrap();
        fs::write(root.join("bin/node.exe"), b"node fixture").unwrap();
        fs::write(root.join("bin/node_repl.exe"), b"repl fixture").unwrap();
        fs::write(
            root.join("bin/node_modules/example/index.js"),
            b"fixture code",
        )
        .unwrap();
        resources
    }

    #[test]
    fn runtime_seed_is_independent_refuses_reuse_and_checks_markers_again() {
        let resources = fixture();
        let destination = tempfile::tempdir().unwrap();
        let seed = RuntimeSeed::prepare(resources.path(), destination.path()).unwrap();
        assert_eq!(seed.copied_files, 4);
        assert_eq!(seed.cache_key.len(), 16);
        assert_eq!(
            fs::read(seed.destination.join("bin/node_modules/example/index.js")).unwrap(),
            b"fixture code"
        );
        assert!(RuntimeSeed::prepare(resources.path(), destination.path()).is_err());
        fs::write(seed.destination.join("bin/node.exe"), b"changed").unwrap();
        assert!(seed.verify().is_err());
        assert_eq!(
            fs::read(resources.path().join("cua_node/bin/node.exe")).unwrap(),
            b"node fixture"
        );
    }

    #[test]
    fn runtime_seed_rejects_links_inside_the_package_fixture() {
        let resources = fixture();
        let other = tempfile::tempdir().unwrap();
        std::os::windows::fs::symlink_dir(other.path(), resources.path().join("cua_node/linked"))
            .unwrap();
        let destination = tempfile::tempdir().unwrap();
        assert!(RuntimeSeed::prepare(resources.path(), destination.path()).is_err());
    }
}
