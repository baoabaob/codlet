use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{Read, Seek};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Default)]
pub(crate) struct FolderPicker(Arc<Mutex<State>>);
#[derive(Default)]
struct State {
    next: u64,
    current: Option<Value>,
    dialog: Option<Dialog>,
}
struct Dialog {
    child: Child,
    stdout: tempfile::NamedTempFile,
    stderr: tempfile::NamedTempFile,
}
impl Drop for Dialog {
    fn drop(&mut self) {
        if self.child.try_wait().is_ok_and(|v| v.is_none()) {
            let _ = self.child.kill();
        }
        let until = Instant::now() + Duration::from_secs(2);
        while self.child.try_wait().is_ok_and(|v| v.is_none()) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl FolderPicker {
    pub fn invoke(&self, method: &str, params: Value, preferred: &Path) -> Result<Value, String> {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if method == "folderSelection" {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Selection {
                selection_id: String,
            }
            let input: Selection = serde_json::from_value(params).map_err(|e| e.to_string())?;
            if state
                .current
                .as_ref()
                .is_none_or(|v| v["selectionId"] != input.selection_id)
            {
                return Err("This folder selection is no longer available".into());
            }
            if let Some(dialog) = &mut state.dialog
                && let Some(status) = dialog.child.try_wait().map_err(|e| e.to_string())?
            {
                let mut body = String::new();
                let source = if status.success() {
                    &mut dialog.stdout
                } else {
                    &mut dialog.stderr
                };
                source.as_file_mut().rewind().map_err(|e| e.to_string())?;
                source
                    .as_file_mut()
                    .take(16385)
                    .read_to_string(&mut body)
                    .map_err(|e| e.to_string())?;
                if body.len() > 16384 {
                    return Err("Folder selection exceeded its output limit".into());
                }
                let selected = body.trim_end_matches(['\r', '\n']);
                state.current = Some(if !status.success() {
                    json!({"selectionId":input.selection_id,"status":"failed","error":selected})
                } else if selected.is_empty() {
                    json!({"selectionId":input.selection_id,"status":"cancelled"})
                } else {
                    let path = Path::new(selected)
                        .canonicalize()
                        .map_err(|e| e.to_string())?;
                    if !path.is_dir() {
                        return Err("Selected directory is no longer available".into());
                    }
                    json!({"selectionId":input.selection_id,"status":"selected","path":path})
                });
                state.dialog = None;
            }
            return Ok(state.current.as_ref().unwrap().clone());
        }
        #[derive(Deserialize, Default)]
        #[serde(deny_unknown_fields)]
        struct Options {
            locale: Option<String>,
        }
        let options: Options = if params.is_null() {
            Options::default()
        } else {
            serde_json::from_value(params).map_err(|e| e.to_string())?
        };
        let prompt = match options.locale.as_deref() {
            Some("zh") => "选择插件文件夹",
            Some("en") | None => "Choose plugin folder",
            _ => return Err("Unknown folder dialog locale".into()),
        };
        if state.dialog.is_some() {
            return Err("A folder selection is already open".into());
        }
        let directory = preferred
            .ancestors()
            .find(|p| p.is_dir())
            .ok_or("Initial folder is unavailable")?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let stdout = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
        let stderr = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
        let script = "on run args\nactivate\ntry\nreturn POSIX path of (choose folder with prompt (item 1 of args) default location (POSIX file (item 2 of args)))\non error number -128\nreturn \"\"\nend try\nend run";
        let child = Command::new("/usr/bin/osascript")
            .args(["-e", script, "--", prompt])
            .arg(directory)
            .stdin(Stdio::null())
            .stdout(stdout.reopen().map_err(|e| e.to_string())?)
            .stderr(stderr.reopen().map_err(|e| e.to_string())?)
            .spawn()
            .map_err(|e| e.to_string())?;
        state.next = state
            .next
            .checked_add(1)
            .ok_or("Folder selection counter exhausted")?;
        state.current =
            Some(json!({"selectionId":format!("folder-{}",state.next),"status":"selecting"}));
        state.dialog = Some(Dialog {
            child,
            stdout,
            stderr,
        });
        Ok(state.current.as_ref().unwrap().clone())
    }
}
