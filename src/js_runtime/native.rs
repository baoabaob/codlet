//! Check Node's own contract, independently of the surrounding client version.
#[cfg(not(windows))]
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Deserialize;

use super::{JsRuntime, MAX_LICENSE_BYTES, MAX_NODE_BYTES, io_error, sha256};
use crate::platform::DesktopTarget;
use crate::plugin_host::HostError;

const PROBE: &str = r#"
const vm = require('node:vm');
const workers = require('node:worker_threads');
const crypto = require('node:crypto');
process.stdout.write(JSON.stringify({
  version: process.versions.node, platform: process.platform, architecture: process.arch,
  capabilities: [fetch, WebSocket, structuredClone, AbortController, AbortSignal.timeout,
    TextEncoder, TextDecoder, ReadableStream, vm.createContext, vm.Script, workers.Worker,
    crypto.createHash].every(value => typeof value === 'function')
}));
"#;

#[derive(Deserialize)]
struct NodeContract {
    version: String,
    platform: String,
    architecture: String,
    capabilities: bool,
}

pub(super) fn compatible_version(value: &str) -> bool {
    let parts: Vec<_> = value.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()))
    {
        return false;
    }
    let Ok(numbers) = parts
        .into_iter()
        .map(str::parse::<u32>)
        .collect::<Result<Vec<_>, _>>()
    else {
        return false;
    };
    match numbers.as_slice() {
        [22, minor, patch] => (*minor, *patch) >= (23, 2),
        [24, minor, patch] => (*minor, *patch) >= (21, 0),
        _ => false,
    }
}

fn unsupported(message: impl Into<String>) -> HostError {
    HostError::new("js_runtime_incompatible", message)
}

fn validate(contract: &NodeContract, target: DesktopTarget) -> Result<(), HostError> {
    let (platform, architecture) = match target.node_platform() {
        "win-x64" => ("win32", "x64"),
        "win-arm64" => ("win32", "arm64"),
        "darwin-arm64" => ("darwin", "arm64"),
        _ => return Err(unsupported("Unsupported Node platform")),
    };
    if !compatible_version(&contract.version)
        || contract.platform != platform
        || contract.architecture != architecture
        || !contract.capabilities
    {
        return Err(unsupported(format!(
            "Native Node {} does not provide this Core's required runtime contract",
            contract.version
        )));
    }
    Ok(())
}

// Only callers that resolve the installed official package/bundle may reach here.
// Capture the files before probing, then use that same checked snapshot for hosts.
pub(super) fn checked_pair(
    node: &Path,
    license: &Path,
    target: DesktopTarget,
) -> Result<JsRuntime, HostError> {
    #[cfg(windows)]
    let (node_file, license_file) = (
        super::open_plain_windows(node).map_err(io_error)?,
        super::open_plain_windows(license).map_err(io_error)?,
    );
    #[cfg(not(windows))]
    let (node_file, license_file) = (
        File::open(node).map_err(io_error)?,
        File::open(license).map_err(io_error)?,
    );
    for (file, limit) in [
        (&node_file, MAX_NODE_BYTES),
        (&license_file, MAX_LICENSE_BYTES),
    ] {
        let metadata = file.metadata().map_err(io_error)?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > limit {
            return Err(unsupported(
                "Native Node files exceed the runtime file limits",
            ));
        }
    }
    let mut runtime = JsRuntime::checked_pair(
        node,
        license,
        &sha256(&node_file)?,
        &sha256(&license_file)?,
        "candidate",
        None,
    )?;
    let contract = probe(runtime.executable_path())?;
    validate(&contract, target)?;
    std::sync::Arc::get_mut(&mut runtime.0)
        .expect("new runtime has one owner")
        .version = contract.version;
    Ok(runtime)
}

fn probe(node: &Path) -> Result<NodeContract, HostError> {
    let mut output = tempfile::NamedTempFile::new().map_err(io_error)?;
    let mut command = Command::new(node);
    command
        .args([
            "--no-addons",
            "--no-experimental-strip-types",
            "--no-global-search-paths",
            "--no-experimental-require-module",
            "--input-type=commonjs",
            "--eval",
            PROBE,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::from(output.as_file().try_clone().map_err(io_error)?))
        .stderr(Stdio::null());
    for (key, _) in std::env::vars_os() {
        let name = key.to_string_lossy().to_ascii_uppercase();
        if name.starts_with("NODE_")
            || name.starts_with("OPENSSL_")
            || name.starts_with("DYLD_")
            || name == "ELECTRON_RUN_AS_NODE"
        {
            command.env_remove(key);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(io_error)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(unsupported(match result {
                    Err(error) => format!("Native Node probe failed: {error}"),
                    _ => "Native Node probe timed out".into(),
                }));
            }
        }
    };
    if !status.success() || output.as_file().metadata().map_err(io_error)?.len() > 8192 {
        return Err(unsupported(
            "Native Node does not accept the required Host flags",
        ));
    }
    output
        .as_file_mut()
        .seek(SeekFrom::Start(0))
        .map_err(io_error)?;
    let mut bytes = Vec::new();
    output
        .as_file_mut()
        .take(8193)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    serde_json::from_slice(&bytes)
        .map_err(|_| unsupported("Native Node returned an invalid runtime contract"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compatibility_tracks_node_versions_instead_of_client_builds() {
        for version in ["22.23.2", "22.24.0", "24.21.0", "24.22.1"] {
            assert!(compatible_version(version), "{version}");
        }
        for version in [
            "22.23.1",
            "24.20.0",
            "20.99.0",
            "25.0.0",
            "26.0.0",
            "24.21",
            "24.21.0-rc.1",
            "v24.21.0",
        ] {
            assert!(!compatible_version(version), "{version}");
        }
    }
    #[test]
    fn matching_node_version_still_requires_the_host_platform_and_apis() {
        let mut contract = NodeContract {
            version: "24.21.0".into(),
            platform: "win32".into(),
            architecture: "x64".into(),
            capabilities: true,
        };
        assert!(validate(&contract, DesktopTarget::WindowsX64).is_ok());
        contract.architecture = "arm64".into();
        assert!(validate(&contract, DesktopTarget::WindowsX64).is_err());
        contract.architecture = "x64".into();
        contract.capabilities = false;
        assert!(validate(&contract, DesktopTarget::WindowsX64).is_err());
    }
}
