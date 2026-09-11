//! One native folder dialog on a dedicated STA. Returning/polling a selection
//! never blocks the renderer RPC or lifecycle owner, and grants no plugin trust.
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{Value, json};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
    CoTaskMemFree, CoUninitialize,
};
use windows::Win32::UI::Shell::{
    FOS_DONTADDTORECENT, FOS_FORCEFILESYSTEM, FOS_NOCHANGEDIR, FOS_PATHMUSTEXIST, FOS_PICKFOLDERS,
    FileOpenDialog, IFileOpenDialog, IShellItem, SHCreateItemFromParsingName, SIGDN_FILESYSPATH,
};
use windows::core::{PCWSTR, w};

#[derive(Clone, Default)]
pub(crate) struct FolderPicker(Arc<Mutex<State>>);
#[derive(Default)]
struct State {
    next: u64,
    current: Option<Value>,
}

impl FolderPicker {
    pub fn invoke(
        &self,
        method: &str,
        params: Value,
        preferred_directory: &Path,
    ) -> Result<Value, String> {
        if method == "folderSelection" {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Selection {
                selection_id: String,
            }
            let input: Selection =
                serde_json::from_value(params).map_err(|error| error.to_string())?;
            return self
                .0
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .current
                .as_ref()
                .filter(|current| current["selectionId"] == input.selection_id)
                .cloned()
                .ok_or_else(|| {
                    "This folder selection is no longer available. Choose the folder again.".into()
                });
        }
        if !params.is_null() {
            return Err("chooseLocalFolder expects null params.".into());
        }
        let directory = initial_directory(preferred_directory)?;
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if state
            .current
            .as_ref()
            .is_some_and(|value| value["status"] == "selecting")
        {
            return Err(
                "A folder dialog is already open. Complete or cancel that selection first.".into(),
            );
        }
        state.next = state
            .next
            .checked_add(1)
            .ok_or("Folder selection counter exhausted.")?;
        let id = format!("folder-{}", state.next);
        let pending = json!({"selectionId":id,"status":"selecting"});
        state.current = Some(pending.clone());
        let shared = self.0.clone();
        let worker = std::thread::Builder::new()
            .name("codlet-folder-dialog".into())
            .spawn(move || {
                let value = match pick_folder(&directory) {
                    Ok(Some(path)) => json!({"selectionId":id,"status":"selected","path":path}),
                    Ok(None) => json!({"selectionId":id,"status":"cancelled"}),
                    Err(error) => json!({"selectionId":id,"status":"failed","error":error}),
                };
                shared
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .current = Some(value);
            });
        if let Err(error) = worker {
            state.current = None;
            return Err(error.to_string());
        }
        Ok(pending)
    }
}

fn initial_directory(preferred: &Path) -> Result<PathBuf, String> {
    if preferred.is_dir() {
        return std::fs::canonicalize(preferred).map_err(|error| error.to_string());
    }
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    executable
        .parent()
        .filter(|directory| directory.is_dir())
        .map(Path::to_owned)
        .ok_or_else(|| {
            "No existing initial folder is available. Enter the plugin path instead.".into()
        })
}

fn pick_folder(directory: &Path) -> Result<Option<PathBuf>, String> {
    // SAFETY: this function owns a fresh dedicated thread. Every COM object is
    // released before its apartment guard, and allocated path text is freed once.
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|error| error.to_string())?;
        struct Apartment;
        impl Drop for Apartment {
            fn drop(&mut self) {
                unsafe {
                    CoUninitialize();
                }
            }
        }
        let _apartment = Apartment;
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
            .map_err(|error| error.to_string())?;
        dialog
            .SetOptions(
                dialog.GetOptions().map_err(|error| error.to_string())?
                    | FOS_PICKFOLDERS
                    | FOS_FORCEFILESYSTEM
                    | FOS_PATHMUSTEXIST
                    | FOS_NOCHANGEDIR
                    | FOS_DONTADDTORECENT,
            )
            .map_err(|error| error.to_string())?;
        dialog
            .SetTitle(w!(
                "Import a local Codlet plugin — choose the folder containing codlet.json"
            ))
            .map_err(|error| error.to_string())?;
        // Do not depend on ambient Desktop/last-used locations. Isolated profiles
        // may intentionally lack a Desktop folder, making the default Shell view fail.
        let wide = directory
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let folder: IShellItem = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None)
            .map_err(|error| error.to_string())?;
        dialog
            .SetFolder(&folder)
            .map_err(|error| error.to_string())?;
        if let Err(error) = dialog.Show(None) {
            if error.code().0 as u32 == 0x800704c7 {
                return Ok(None);
            }
            return Err(error.to_string());
        }
        let item = dialog.GetResult().map_err(|error| error.to_string())?;
        let text = item
            .GetDisplayName(SIGDN_FILESYSPATH)
            .map_err(|error| error.to_string())?;
        let path = text
            .to_string()
            .map(PathBuf::from)
            .map_err(|error| error.to_string());
        CoTaskMemFree(Some(text.0.cast()));
        let path = path?;
        crate::plugin_permissions::validate_policy_path(&path)
            .map_err(|error| error.to_string())?;
        Ok(Some(path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn picker_starts_at_an_existing_directory_without_creating_a_fake_desktop() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            initial_directory(root.path()).unwrap(),
            std::fs::canonicalize(root.path()).unwrap()
        );
        let missing = root.path().join("missing-desktop");
        assert!(initial_directory(&missing).unwrap().is_dir());
        assert!(!missing.exists());
    }
}
