//! Codlet's pinned JS executor. Runtime selection belongs to the distribution,
//! never to a plugin manifest, PATH search or an ambient Node installation.

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Deserialize;
use tempfile::NamedTempFile;
#[cfg(windows)]
use windows_sys::Win32::Security::Cryptography::*;

use crate::plugin_host::HostError;
use crate::plugins::LoadedHost;

const BOOTSTRAP: &str = concat!(
    "const createEmbeddedServicesRuntime = (() => { const module = { exports: {} };\n",
    include_str!("../runtime/core-services.cjs"),
    "\nreturn module.exports.createCoreServicesRuntime; })();\n",
    include_str!("../runtime/host-traffic-bundle.cjs"),
    "\n",
    include_str!("../runtime/host.cjs")
);
const MAX_NODE_BYTES: u64 = 160 * 1024 * 1024;
const MAX_LICENSE_BYTES: u64 = 2 * 1024 * 1024;

mod provision;
#[cfg(test)]
mod tests;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct RuntimePin {
    schema: u32,
    version: String,
    base_url: String,
    #[serde(default)]
    mode: Option<String>,
    platforms: BTreeMap<String, PlatformPin>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct PlatformPin {
    archive: String,
    archive_sha256: String,
    #[serde(default)]
    mirror_url: Option<String>,
    executable_sha256: String,
    license_sha256: String,
    version: Option<String>,
    base_url: Option<String>,
}

struct RuntimeFiles {
    executable: PathBuf,
    license: PathBuf,
    #[allow(dead_code)] // Mac native update proof records the checked Node version.
    version: String,
    executable_sha256: String,
    license_sha256: String,
    #[allow(dead_code)]
    // Mac installer records persistent cache paths; Windows tests inspect them.
    cached_executable: Option<PathBuf>,
    #[cfg(target_os = "macos")]
    cached_license: Option<PathBuf>,
    // Hold the checked binary against replacement while any plugin uses it.
    _file: File,
    _license_file: File,
    #[cfg(target_os = "macos")]
    _snapshot: tempfile::TempDir,
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
    // The embedded bootstrap is too large for Windows' process command line.
    // Keep its private snapshot for exactly the same generation lifetime.
    _bootstrap: NamedTempFile,
    _runtime: JsRuntime,
}

impl JsRuntime {
    /// Fixed Core-owned entry point. Neither script text nor invocation flags
    /// originate in a plugin manifest or renderer request.
    pub(crate) fn prepare_traffic_worker(
        &self,
        config: &serde_json::Value,
        directory: &Path,
    ) -> Result<JsInvocation, HostError> {
        let mut source = tempfile::Builder::new()
            .prefix("launch-")
            .suffix(".json")
            .tempfile_in(directory)
            .map_err(io_error)?;
        source
            .write_all(&serde_json::to_vec(config).expect("traffic configuration serializes"))
            .map_err(io_error)?;
        source.flush().map_err(io_error)?;
        let mut bootstrap = tempfile::Builder::new()
            .prefix("traffic-")
            .suffix(".cjs")
            .tempfile_in(directory)
            .map_err(io_error)?;
        bootstrap
            .write_all(include_bytes!("../runtime/traffic-worker-bundle.cjs"))
            .map_err(io_error)?;
        bootstrap.flush().map_err(io_error)?;
        let arguments = vec![
            "--no-addons".into(),
            "--no-experimental-strip-types".into(),
            "--no-global-search-paths".into(),
            "--no-experimental-require-module".into(),
            // The fixed streaming worker has a small live JS heap. V8's
            // machine-sized nursery otherwise retains tens of MiB after bursts.
            // This tunes collection frequency, not body/frame or old-heap limits;
            // ordinary plugin Hosts retain their own runtime defaults.
            "--max-semi-space-size=4".into(),
            bootstrap.path().to_string_lossy().into_owned(),
            source.path().to_string_lossy().into_owned(),
        ];
        let environment = std::env::vars_os()
            .filter(|(key, _)| {
                let name = key.to_string_lossy().to_ascii_uppercase();
                !name.starts_with("NODE_")
                    && !name.starts_with("OPENSSL_")
                    && !name.starts_with("DYLD_")
                    && name != "ELECTRON_RUN_AS_NODE"
            })
            .collect();
        Ok(JsInvocation {
            executable: self.0.executable.clone(),
            arguments,
            cwd: directory.into(),
            environment,
            _source: source,
            _bootstrap: bootstrap,
            _runtime: self.clone(),
        })
    }

    pub fn discover() -> Result<Self, HostError> {
        let executable = std::env::current_exe().map_err(io_error)?;
        let directory = executable.parent().ok_or_else(|| {
            HostError::new(
                "js_runtime_missing",
                "Codlet executable has no distribution directory",
            )
        })?;
        if directory.join("runtime/node-runtime.json").exists() {
            provision::ensure_current(directory)
        } else {
            // Existing unit/isolated-client fixtures stage only the embedded
            // bundled Node; production slim packages always carry the pin.
            Self::from_distribution(directory)
        }
    }

    /// A packaging/test seam selecting a Codlet distribution directory. The
    /// pinned digest is still mandatory; this cannot accept an arbitrary program.
    pub fn from_distribution(directory: &Path) -> Result<Self, HostError> {
        let pin: RuntimePin = serde_json::from_str(include_str!("../runtime/node-runtime.json"))
            .expect("checked-in Node runtime pin is valid");
        Self::checked_bundled(directory, &pin)
    }

    /// Production resolver for a Core-owned current or already-verified staged
    /// distribution. The caller, never a plugin, selects this directory.
    pub(crate) fn ensure_from_distribution(directory: &Path) -> Result<Self, HostError> {
        provision::ensure(directory)
    }

    pub(crate) fn executable_path(&self) -> &Path {
        &self.0.executable
    }

    pub(crate) fn license_path(&self) -> &Path {
        &self.0.license
    }

    pub(crate) fn verified_executable_sha256(&self) -> &str {
        &self.0.executable_sha256
    }

    pub(crate) fn verified_license_sha256(&self) -> &str {
        &self.0.license_sha256
    }

    #[allow(dead_code)] // Used by the Mac native fixture and staged update checks.
    pub(crate) fn verified_node_version(&self) -> &str {
        &self.0.version
    }

    #[allow(dead_code)] // Mac staged updates use this path; Windows tests inspect cache reuse.
    pub(crate) fn cached_executable_path(&self) -> Option<&Path> {
        self.0.cached_executable.as_deref()
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn cached_license_path(&self) -> Option<&Path> {
        self.0.cached_license.as_deref()
    }

    fn checked_bundled(directory: &Path, pin: &RuntimePin) -> Result<Self, HostError> {
        let target = crate::platform::DesktopTarget::current().ok_or_else(|| {
            HostError::new(
                "js_runtime_platform",
                "this JS runtime supports Windows x64/ARM64 and macOS ARM64",
            )
        })?;
        let platform = target.node_platform();
        let platform_pin = pin.platforms.get(platform).ok_or_else(|| {
            HostError::new(
                "js_runtime_platform",
                "Node runtime pin has no current platform",
            )
        })?;
        let version = platform_pin.version.as_deref().unwrap_or(&pin.version);
        let root = directory
            .join("runtime")
            .join(format!("node-v{version}-{platform}"));
        Self::checked_pair(
            &root.join(target.node_executable()),
            &root.join("LICENSE"),
            &platform_pin.executable_sha256,
            &platform_pin.license_sha256,
            version,
            None,
        )
    }

    fn checked_pair(
        path: &Path,
        license_path: &Path,
        executable_sha256: &str,
        license_sha256: &str,
        version: &str,
        cached: Option<(PathBuf, PathBuf)>,
    ) -> Result<Self, HostError> {
        let missing = |error| {
            HostError::new(
                "js_runtime_missing",
                format!(
                    "Node {version} at {} is unavailable: {error}",
                    path.display()
                ),
            )
        };
        #[cfg(windows)]
        let (file, license_file) = (
            open_plain_windows(path).map_err(&missing)?,
            open_plain_windows(license_path).map_err(&missing)?,
        );
        #[cfg(target_os = "macos")]
        let (file, license_file, executable, license, snapshot) =
            snapshot_runtime(path, license_path).map_err(&missing)?;
        let node_size = file.metadata().map_err(io_error)?.len();
        let license_size = license_file.metadata().map_err(io_error)?.len();
        if node_size == 0
            || node_size > MAX_NODE_BYTES
            || license_size == 0
            || license_size > MAX_LICENSE_BYTES
        {
            return Err(HostError::new(
                "js_runtime_invalid",
                "Node or LICENSE exceeds its runtime file limit",
            ));
        }
        if sha256(&file)? != executable_sha256 || sha256(&license_file)? != license_sha256 {
            return Err(HostError::new(
                "js_runtime_mismatch",
                format!(
                    "{} or LICENSE does not match the pinned Node {}; repair the runtime package",
                    path.display(),
                    version
                ),
            ));
        }
        let (cached_executable, cached_license) = cached.unzip();
        #[cfg(windows)]
        let _ = cached_license;
        Ok(Self(Arc::new(RuntimeFiles {
            #[cfg(windows)]
            executable: std::fs::canonicalize(path).map_err(io_error)?,
            #[cfg(target_os = "macos")]
            executable,
            #[cfg(windows)]
            license: std::fs::canonicalize(license_path).map_err(io_error)?,
            #[cfg(target_os = "macos")]
            license,
            cached_executable,
            #[cfg(target_os = "macos")]
            cached_license,
            version: version.into(),
            executable_sha256: executable_sha256.into(),
            license_sha256: license_sha256.into(),
            _file: file,
            _license_file: license_file,
            #[cfg(target_os = "macos")]
            _snapshot: snapshot,
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
        let mut bootstrap = tempfile::Builder::new()
            .prefix("codlet-bootstrap-")
            .suffix(".cjs")
            .tempfile()
            .map_err(io_error)?;
        bootstrap
            .write_all(BOOTSTRAP.as_bytes())
            .map_err(io_error)?;
        bootstrap.flush().map_err(io_error)?;
        // No user flags or loader hooks. TS is compiled before distribution;
        // native Node addons are disabled in this process by the runtime itself.
        // The short loader removes its own path so host.cjs still observes the
        // plugin entry at argv[1] and immutable source snapshot at argv[2].
        let arguments = vec![
            "--no-addons".into(),
            "--no-experimental-strip-types".into(),
            "--no-global-search-paths".into(),
            "--no-experimental-require-module".into(),
            "--input-type=commonjs".into(),
            "--eval".into(),
            "require(process.argv.splice(1,1)[0])".into(),
            "--".into(),
            bootstrap.path().to_string_lossy().into_owned(),
            host.entry.to_string_lossy().into_owned(),
            source.path().to_string_lossy().into_owned(),
        ];
        let environment = std::env::vars_os()
            .filter(|(key, _)| {
                let name = key.to_string_lossy().to_ascii_uppercase();
                !name.starts_with("NODE_")
                    && !name.starts_with("OPENSSL_")
                    && !name.starts_with("DYLD_")
                    && name != "ELECTRON_RUN_AS_NODE"
            })
            .collect();
        Ok(JsInvocation {
            executable: self.0.executable.clone(),
            arguments,
            cwd: host.root.clone(),
            environment,
            _source: source,
            _bootstrap: bootstrap,
            _runtime: self.clone(),
        })
    }

    pub(crate) fn prepare_client_launch(
        &self,
        host: &LoadedHost,
        directory: &Path,
    ) -> Result<JsInvocation, HostError> {
        let mut invocation = self.prepare(host)?;
        let mut bootstrap = tempfile::Builder::new()
            .prefix("launch-adapter-")
            .suffix(".cjs")
            .tempfile_in(directory)
            .map_err(io_error)?;
        bootstrap
            .write_all(include_bytes!("../runtime/client-launch.cjs"))
            .map_err(io_error)?;
        bootstrap.flush().map_err(io_error)?;
        invocation.arguments = vec![
            "--no-addons".into(),
            "--no-experimental-strip-types".into(),
            "--no-global-search-paths".into(),
            "--no-experimental-require-module".into(),
            bootstrap.path().to_string_lossy().into_owned(),
            host.entry.to_string_lossy().into_owned(),
            invocation._source.path().to_string_lossy().into_owned(),
        ];
        invocation._bootstrap = bootstrap;
        Ok(invocation)
    }
}

fn io_error(error: std::io::Error) -> HostError {
    HostError::new("js_runtime_io", error.to_string())
}

#[cfg(windows)]
fn open_plain_windows(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
    };
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(std::io::Error::other("Node runtime file must be ordinary"));
    }
    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(target_os = "macos")]
fn snapshot_runtime(
    path: &Path,
    license_path: &Path,
) -> std::io::Result<(File, File, PathBuf, PathBuf, tempfile::TempDir)> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    // A Unix open descriptor does not prevent a pathname replacement or an
    // in-place write. Use a private generation-owned copy of both pinned files.
    let directory = tempfile::Builder::new().prefix("codlet-node-").tempdir()?;
    std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))?;
    let executable = directory.path().join("node");
    let license = directory.path().join("LICENSE");
    for (source_path, target_path, maximum, mode) in [
        (path, &executable, MAX_NODE_BYTES, 0o500),
        (license_path, &license, MAX_LICENSE_BYTES, 0o400),
    ] {
        let source = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(source_path)?;
        let metadata = source.metadata()?;
        if !metadata.is_file()
            || metadata.len() == 0
            || metadata.len() > maximum
            || metadata.nlink() != 1
        {
            return Err(std::io::Error::other(
                "Node runtime source is not an ordinary bounded file",
            ));
        }
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(target_path)?;
        if std::io::copy(&mut source.take(maximum + 1), &mut output)? > maximum {
            return Err(std::io::Error::other(
                "Node runtime exceeded its snapshot size limit",
            ));
        }
        output.sync_all()?;
    }
    let file = File::open(&executable)?;
    let license_file = File::open(&license)?;
    Ok((file, license_file, executable, license, directory))
}

#[cfg(target_os = "macos")]
fn sha256(mut file: &File) -> Result<String, HostError> {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(io_error)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[cfg(windows)]
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
