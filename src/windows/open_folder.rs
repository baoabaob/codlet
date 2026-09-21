//! Explorer receives a checked, registered directory and no command arguments.
use std::os::windows::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf, Prefix};
use std::time::Duration;

use serde_json::{Value, json};
use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize};
use windows::Win32::UI::Shell::{
    SEE_MASK_CLASSNAME, SEE_MASK_FLAG_LOG_USAGE, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC,
    SHELLEXECUTEINFOW, ShellExecuteExW,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use windows::core::{PCWSTR, w};

use crate::plugin_control::PluginControlError;
use crate::plugins::PluginRegistry;

pub(crate) fn open_registered_source(
    registry: &PluginRegistry,
    plugin_id: &str,
) -> Result<Value, PluginControlError> {
    let registry = registry.clone();
    let plugin_id = plugin_id.to_owned();
    on_sta(move || open_on_sta(&registry, &plugin_id))
}

/// Only Core-selected installation/log paths reach this helper; no RPC-supplied
/// path, command line, file association, or optional arguments are accepted.
pub(crate) fn open_runtime_directory(directory: PathBuf) -> Result<Value, PluginControlError> {
    if !directory.is_dir() {
        return Err(PluginControlError::new(
            "open_folder_missing",
            "The runtime directory does not exist",
        ));
    }
    on_sta(move || {
        open_directory_on_sta(&directory)?;
        Ok(json!({"opened":true}))
    })
}

fn on_sta(
    work: impl FnOnce() -> Result<Value, PluginControlError> + Send + 'static,
) -> Result<Value, PluginControlError> {
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("codlet-open-folder".into())
        .spawn(move || {
            let result = (|| {
                // Shell extensions can require an STA; never change the RPC owner's
                // apartment or call them from an uninitialized management thread.
                unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
                    .ok()
                    .map_err(|error| {
                        PluginControlError::new(
                            "open_source_folder_com",
                            format!("Explorer COM initialization failed: {error}"),
                        )
                    })?;
                struct Apartment;
                impl Drop for Apartment {
                    fn drop(&mut self) {
                        unsafe {
                            CoUninitialize();
                        }
                    }
                }
                let _apartment = Apartment;
                work()
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| PluginControlError::new("open_source_folder_failed", error.to_string()))?;
    receiver.recv_timeout(Duration::from_secs(10))
        .map_err(|_| PluginControlError::new("open_source_folder_unconfirmed", "Explorer did not confirm the open request in time. The request may still complete."))?
}

fn open_on_sta(registry: &PluginRegistry, plugin_id: &str) -> Result<Value, PluginControlError> {
    crate::source_removal::with_registered_directory(registry, plugin_id, |directory| {
        open_directory_on_sta(directory)?;
        Ok(json!({"pluginId":plugin_id,"opened":true}))
    })
}

fn open_directory_on_sta(directory: &Path) -> Result<(), PluginControlError> {
    let directory = shell_directory_path(directory)?;
    let wide: Vec<_> = directory.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut request = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        // This STA has no message loop and exits after the call. Wait for Shell
        // dispatch and mark the launch as user initiated so Explorer receives
        // activation semantics rather than a background directory open.
        fMask: SEE_MASK_NOASYNC | SEE_MASK_FLAG_LOG_USAGE | SEE_MASK_FLAG_NO_UI | SEE_MASK_CLASSNAME,
        lpVerb: w!("explore"),
        lpClass: w!("folder"),
        lpFile: PCWSTR(wide.as_ptr()),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    // SAFETY: NUL-terminated checked directory, fixed folder class/verb, no
    // parameters or shell command. Ancestor/root pins live through this call.
    unsafe { ShellExecuteExW(&mut request) }.map_err(|error| {
        PluginControlError::new(
            "open_source_folder_failed",
            format!("Explorer could not open the registered source directory: {error}"),
        )
    })
}

/// Filesystem canonicalization uses the Win32 verbatim prefix; Shell parsing
/// names use ordinary DOS paths. UNC/device namespaces are not source locations.
pub(crate) fn shell_directory_path(path: &Path) -> Result<PathBuf, PluginControlError> {
    if !path.is_absolute() || path.as_os_str().encode_wide().any(|unit| unit == 0) {
        return Err(PluginControlError::new(
            "shell_directory_invalid",
            "The selected directory must be an absolute local path.",
        ));
    }
    match path.components().next() {
        Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_)) => {
            Ok(path.to_owned())
        }
        Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::VerbatimDisk(_)) => {
            let text = path.to_str().ok_or_else(|| {
                PluginControlError::new(
                    "shell_directory_invalid",
                    "The selected directory cannot be represented as text.",
                )
            })?;
            Ok(PathBuf::from(text.strip_prefix("\\\\?\\").ok_or_else(
                || {
                    PluginControlError::new(
                        "shell_directory_invalid",
                        "Invalid verbatim directory path.",
                    )
                },
            )?))
        }
        _ => Err(PluginControlError::new(
            "shell_directory_invalid",
            "Shell directory selection supports local drive paths only.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_paths_preserve_local_unicode_and_reject_device_or_network_namespaces() {
        assert_eq!(
            shell_directory_path(Path::new(r"\\?\C:\测试 space\plugins")).unwrap(),
            Path::new(r"C:\测试 space\plugins")
        );
        for path in [
            r"\\server\share",
            r"\\?\UNC\server\share",
            r"\\.\C:\plugins",
            r"C:relative",
            "relative",
        ] {
            assert!(shell_directory_path(Path::new(path)).is_err(), "{path}");
        }
    }

    #[test]
    fn unregistered_or_missing_sources_fail_before_explorer_can_be_launched() {
        let fixture = tempfile::tempdir().unwrap();
        let mut registry = PluginRegistry::load(fixture.path().join("config.json")).unwrap();
        assert_eq!(
            open_registered_source(&registry, "dev.missing")
                .unwrap_err()
                .code,
            "plugin_not_found"
        );
        let missing = fixture.path().canonicalize().unwrap().join("moved-source");
        registry
            .register_local(
                "dev.missing",
                crate::plugins::LocalPluginRegistration {
                    path: missing,
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(
            open_registered_source(&registry, "dev.missing")
                .unwrap_err()
                .code,
            "source_directory_missing"
        );
        assert!(!registry.path().exists());
    }
}
