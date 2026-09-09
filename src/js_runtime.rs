//! Codlet's pinned JS executor. Runtime selection belongs to the distribution,
//! never to a plugin manifest, PATH search or an ambient Node installation.

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Deserialize;
use tempfile::NamedTempFile;
use windows_sys::Win32::Security::Cryptography::*;

use crate::plugin_host::HostError;
use crate::plugins::LoadedHost;

const BOOTSTRAP: &str = include_str!("../runtime/host.cjs");
const MAX_NODE_BYTES: u64 = 160 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimePin {
    version: String,
    platforms: BTreeMap<String, PlatformPin>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlatformPin {
    executable_sha256: String,
}

struct RuntimeFiles {
    executable: PathBuf,
    // Hold the checked binary against replacement while any plugin uses it.
    _file: File,
}

#[derive(Clone)]
pub struct JsRuntime(Arc<RuntimeFiles>);

pub(crate) struct JsInvocation {
    pub executable: PathBuf,
    pub arguments: Vec<String>,
    pub cwd: PathBuf,
    pub environment: Vec<(std::ffi::OsString, std::ffi::OsString)>,
    // Snapshot source is disposed with this generation, not left in the package.
    _source: NamedTempFile,
    _runtime: JsRuntime,
}

impl JsRuntime {
    pub fn discover() -> Result<Self, HostError> {
        let executable = std::env::current_exe().map_err(io_error)?;
        Self::from_distribution(executable.parent().ok_or_else(|| {
            HostError::new(
                "js_runtime_missing",
                "Codlet executable has no distribution directory",
            )
        })?)
    }

    /// A packaging/test seam selecting a Codlet distribution directory. The
    /// pinned digest is still mandatory; this cannot accept an arbitrary program.
    pub fn from_distribution(directory: &Path) -> Result<Self, HostError> {
        let pin: RuntimePin = serde_json::from_str(include_str!("../runtime/node-runtime.json"))
            .expect("checked-in Node runtime pin is valid");
        let platform = if cfg!(target_arch = "x86_64") {
            "win-x64"
        } else if cfg!(target_arch = "aarch64") {
            "win-arm64"
        } else {
            return Err(HostError::new(
                "js_runtime_platform",
                "this JS runtime distribution supports Windows x64 and arm64",
            ));
        };
        let expected = &pin.platforms[platform].executable_sha256;
        let path = directory
            .join("runtime")
            .join(format!("node-v{}-{platform}", pin.version))
            .join("node.exe");
        let missing = |error| {
            HostError::new(
                "js_runtime_missing",
                format!(
                    "managed Node {} is unavailable at {}: {error}; stage the runtime with scripts/Install-JsRuntime.ps1 -Destination <Codlet directory>",
                    pin.version,
                    path.display()
                ),
            )
        };
        let metadata = std::fs::symlink_metadata(&path).map_err(missing)?;
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        };
        if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(HostError::new(
                "js_runtime_invalid",
                "managed Node must be an ordinary file",
            ));
        }
        let file = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&path)
            .map_err(missing)?;
        if file.metadata().map_err(io_error)?.len() > MAX_NODE_BYTES {
            return Err(HostError::new(
                "js_runtime_invalid",
                "managed Node exceeds the runtime file limit",
            ));
        }
        if sha256(&file)? != *expected {
            return Err(HostError::new(
                "js_runtime_mismatch",
                format!(
                    "{} does not match Codlet's pinned Node {}; repair the runtime package",
                    path.display(),
                    pin.version
                ),
            ));
        }
        Ok(Self(Arc::new(RuntimeFiles {
            executable: std::fs::canonicalize(&path).map_err(io_error)?,
            _file: file,
        })))
    }

    pub(crate) fn prepare(&self, host: &LoadedHost) -> Result<JsInvocation, HostError> {
        if !host.entry.starts_with(&host.root)
            || host.entry.to_str().is_none()
            || !host.root.is_dir()
        {
            return Err(HostError::new(
                "js_entry_invalid",
                "host.entry must remain in the loaded package directory",
            ));
        }
        let mut source = tempfile::Builder::new()
            .prefix("codlet-host-")
            .suffix(".js")
            .tempfile()
            .map_err(io_error)?;
        source.write_all(host.source.as_bytes()).map_err(io_error)?;
        source.flush().map_err(io_error)?;
        // No user flags or loader hooks. TS is compiled before distribution;
        // native Node addons are disabled in this process by the runtime itself.
        let arguments = vec![
            "--no-addons".into(),
            "--no-experimental-strip-types".into(),
            "--no-global-search-paths".into(),
            "--no-experimental-require-module".into(),
            "--input-type=commonjs".into(),
            "--eval".into(),
            BOOTSTRAP.into(),
            "--".into(),
            host.entry.to_string_lossy().into_owned(),
            source.path().to_string_lossy().into_owned(),
        ];
        let environment = std::env::vars_os()
            .filter(|(key, _)| {
                let name = key.to_string_lossy().to_ascii_uppercase();
                !name.starts_with("NODE_")
                    && !name.starts_with("OPENSSL_")
                    && name != "ELECTRON_RUN_AS_NODE"
            })
            .collect();
        Ok(JsInvocation {
            executable: self.0.executable.clone(),
            arguments,
            cwd: host.root.clone(),
            environment,
            _source: source,
            _runtime: self.clone(),
        })
    }
}

fn io_error(error: std::io::Error) -> HostError {
    HostError::new("js_runtime_io", error.to_string())
}

fn sha256(mut file: &File) -> Result<String, HostError> {
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
    fn check(status: i32) -> Result<(), HostError> {
        if status >= 0 {
            Ok(())
        } else {
            Err(HostError::new(
                "js_runtime_hash",
                format!("Node digest calculation failed: {status:#x}"),
            ))
        }
    }
    let mut hash = Hash {
        algorithm: std::ptr::null_mut(),
        hash: std::ptr::null_mut(),
    };
    check(unsafe {
        BCryptOpenAlgorithmProvider(
            &mut hash.algorithm,
            BCRYPT_SHA256_ALGORITHM,
            std::ptr::null(),
            0,
        )
    })?;
    check(unsafe {
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
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(io_error)?;
        if count == 0 {
            break;
        }
        check(unsafe { BCryptHashData(hash.hash, buffer.as_ptr(), count as u32, 0) })?;
    }
    let mut digest = [0_u8; 32];
    check(unsafe { BCryptFinishHash(hash.hash, digest.as_mut_ptr(), digest.len() as u32, 0) })?;
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}
