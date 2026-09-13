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

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum FolderLocale {
    Zh,
    #[default]
    En,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct PickerOptions {
    #[serde(default)]
    locale: FolderLocale,
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
        let options: PickerOptions = if params.is_null() {
            PickerOptions::default()
        } else {
            serde_json::from_value(params).map_err(|error| {
                format!("chooseLocalFolder expects null or {{locale:'zh'|'en'}}: {error}")
            })?
        };
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
                let value = match pick_folder(&directory, options.locale) {
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
    if let Some(existing) = preferred.ancestors().find(|directory| directory.is_dir()) {
        let canonical = std::fs::canonicalize(existing)
            .map_err(|error| format!("initial_directory.canonicalize: {error}"))?;
        return super::open_folder::shell_directory_path(&canonical)
            .map_err(|error| error.to_string());
    }
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    executable
        .parent()
        .filter(|directory| directory.is_dir())
        .and_then(|directory| super::open_folder::shell_directory_path(directory).ok())
        .ok_or_else(|| {
            "No existing initial folder is available. Enter the plugin path instead.".into()
        })
}

fn pick_folder(directory: &Path, locale: FolderLocale) -> Result<Option<PathBuf>, String> {
    // SAFETY: this function owns a fresh dedicated thread. Every COM object is
    // released before its apartment guard, and allocated path text is freed once.
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|error| format!("folder_dialog.CoInitializeEx: {error}"))?;
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
            .map_err(|error| format!("folder_dialog.CoCreateInstance: {error}"))?;
        dialog
            .SetOptions(
                dialog
                    .GetOptions()
                    .map_err(|error| format!("folder_dialog.GetOptions: {error}"))?
                    | FOS_PICKFOLDERS
                    | FOS_FORCEFILESYSTEM
                    | FOS_PATHMUSTEXIST
                    | FOS_NOCHANGEDIR
                    | FOS_DONTADDTORECENT,
            )
            .map_err(|error| format!("folder_dialog.SetOptions: {error}"))?;
        dialog
            .SetTitle(match locale {
                FolderLocale::Zh => w!("选择插件文件夹"),
                FolderLocale::En => w!("Choose plugin folder"),
            })
            .map_err(|error| format!("folder_dialog.SetTitle: {error}"))?;
        dialog
            .SetOkButtonLabel(match locale {
                FolderLocale::Zh => w!("选择文件夹"),
                FolderLocale::En => w!("Choose folder"),
            })
            .map_err(|error| format!("folder_dialog.SetOkButtonLabel: {error}"))?;
        // A preferred location is only a hint. Rejecting its Shell parsing name
        // must not abort the entire dialog; try existing ancestors and finally
        // let the Shell choose its default. The lab initializer separately supplies
        // the Desktop namespace directory required by an isolated Windows profile.
        let mut folder_errors = Vec::new();
        for candidate in directory.ancestors().filter(|candidate| candidate.is_dir()) {
            match set_folder(&dialog, candidate) {
                Ok(()) => break,
                Err(error) => folder_errors.push(error),
            }
        }
        if let Err(error) = dialog.Show(None) {
            if error.code().0 as u32 == 0x800704c7 {
                return Ok(None);
            }
            return Err(format!(
                "folder_dialog.Show: {error}; initial folder diagnostics: {}",
                folder_errors.join("; ")
            ));
        }
        let item = dialog
            .GetResult()
            .map_err(|error| format!("folder_dialog.GetResult: {error}"))?;
        let text = item
            .GetDisplayName(SIGDN_FILESYSPATH)
            .map_err(|error| format!("folder_dialog.GetDisplayName: {error}"))?;
        let path = text
            .to_string()
            .map(PathBuf::from)
            .map_err(|error| format!("folder_dialog.decode_result: {error}"));
        CoTaskMemFree(Some(text.0.cast()));
        let path = path?;
        crate::plugin_permissions::validate_policy_path(&path)
            .map_err(|error| format!("folder_dialog.validate_result: {error}"))?;
        if !path.is_dir() {
            return Err(
                "folder_dialog.validate_result: The selected directory no longer exists.".into(),
            );
        }
        Ok(Some(std::fs::canonicalize(&path).map_err(|error| {
            format!("folder_dialog.canonicalize_result: {error}")
        })?))
    }
}

unsafe fn set_folder(dialog: &IFileOpenDialog, directory: &Path) -> Result<(), String> {
    let directory =
        super::open_folder::shell_directory_path(directory).map_err(|error| error.to_string())?;
    let wide: Vec<_> = directory.as_os_str().encode_wide().chain(Some(0)).collect();
    let folder: IShellItem = unsafe { SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None) }
        .map_err(|error| format!("folder_dialog.SHCreateItemFromParsingName: {error}"))?;
    unsafe { dialog.SetFolder(&folder) }
        .map_err(|error| format!("folder_dialog.SetFolder: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn picker_starts_at_an_existing_directory_without_creating_a_fake_desktop() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            initial_directory(root.path()).unwrap(),
            super::super::open_folder::shell_directory_path(
                &std::fs::canonicalize(root.path()).unwrap()
            )
            .unwrap()
        );
        let missing = root.path().join("missing-desktop");
        assert!(initial_directory(&missing).unwrap().is_dir());
        assert!(!missing.exists());
    }

    #[test]
    fn canonical_verbatim_directory_is_accepted_after_shell_normalization_without_showing_ui() {
        let thread = std::thread::spawn(|| unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap();
            let root = tempfile::tempdir().unwrap();
            let canonical = std::fs::canonicalize(root.path()).unwrap();
            let raw: Vec<_> = canonical.as_os_str().encode_wide().chain(Some(0)).collect();
            let raw_item: windows::core::Result<IShellItem> =
                SHCreateItemFromParsingName(PCWSTR(raw.as_ptr()), None);
            let dialog: IFileOpenDialog =
                CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).unwrap();
            dialog
                .SetOptions(
                    dialog.GetOptions().expect("GetOptions")
                        | FOS_PICKFOLDERS
                        | FOS_FORCEFILESYSTEM
                        | FOS_PATHMUSTEXIST
                        | FOS_NOCHANGEDIR
                        | FOS_DONTADDTORECENT,
                )
                .expect("SetOptions preserves default flags");
            match raw_item {
                Ok(item) => println!(
                    "verbatim SetFolder result: {:?}",
                    dialog
                        .SetFolder(&item)
                        .as_ref()
                        .map_err(|error| error.code())
                ),
                Err(error) => println!(
                    "verbatim SHCreateItemFromParsingName failed: {:?}",
                    error.code()
                ),
            }
            set_folder(&dialog, &canonical).unwrap();
            println!("normalized SHCreateItemFromParsingName and SetFolder succeeded");
            drop(dialog);
            CoUninitialize();
        });
        thread.join().unwrap();
    }
}
