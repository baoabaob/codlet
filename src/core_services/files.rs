use super::*;
use crate::os_broker::filesystem::{pin_exact_grant, pin_within_grants};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};

const MAX_BYTES: usize = 256 * 1024;
#[derive(Clone, Default)]
pub(super) struct Files(Arc<Mutex<State>>);
#[derive(Default)]
struct State {
    watches: BTreeMap<String, Watch>,
    dialogs: BTreeMap<String, Dialog>,
    selections: BTreeMap<String, Selection>,
}
struct Watch {
    owner: String,
    target: PathBuf,
    roots: Vec<PathBuf>,
    snapshot: Value,
    revision: u64,
    events: VecDeque<Value>,
    cancelled: Arc<AtomicBool>,
}
struct Dialog {
    owner: String,
    cancelled: Arc<AtomicBool>,
    result: Value,
}
struct Selection {
    owner: String,
    path: PathBuf,
    write: bool,
}

impl Files {
    pub fn invoke(
        &self,
        p: &Principal,
        method: &str,
        params: Value,
        check: &dyn Fn() -> Result<()>,
    ) -> Result<Value> {
        match method {
            "openDialog" | "saveDialog" => return self.dialog(p, method == "saveDialog", params),
            "dialogStatus" | "cancelDialog" => {
                let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
                let dialog = state
                    .dialogs
                    .get_mut(string(&params, "dialog")?)
                    .filter(|d| d.owner == owner_key(p))
                    .ok_or_else(|| error("resource_closed", "file dialog is unavailable"))?;
                if method == "cancelDialog" {
                    dialog.cancelled.store(true, Ordering::Release);
                }
                return Ok(dialog.result.clone());
            }
            "changes" | "unwatch" => {
                let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
                let id = string(&params, "watch")?;
                let watch = state
                    .watches
                    .get_mut(id)
                    .filter(|w| w.owner == owner_key(p))
                    .ok_or_else(|| error("resource_closed", "file watch is unavailable"))?;
                if method == "unwatch" {
                    watch.cancelled.store(true, Ordering::Release);
                    state.watches.remove(id);
                    return Ok(json!({"closed":true}));
                }
                let after = params.get("after").and_then(Value::as_u64).unwrap_or(0);
                if after > watch.revision {
                    return Err(error(
                        "invalid_cursor",
                        "watch cursor is ahead of its stream",
                    ));
                }
                let events = watch
                    .events
                    .iter()
                    .filter(|v| v["cursor"].as_u64().is_some_and(|n| n > after))
                    .cloned()
                    .collect::<Vec<_>>();
                return Ok(
                    json!({"events":events,"cursor":watch.revision,"gap":watch.events.front().and_then(|v| v["cursor"].as_u64()).is_some_and(|first| after + 1 < first)}),
                );
            }
            _ => {}
        }
        let write = matches!(method, "writeAtomic" | "mkdir" | "remove");
        let (path, roots) = self.target(p, &params, write, method == "watch")?;
        if method == "watch" {
            return self.watch(p, path, roots);
        }
        // Serialize our own compare-and-replace operations. External editors do
        // not participate in this lock; version checks are optimistic evidence.
        let _state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        check()?;
        match method {
            "read" => {
                let mut selected = pin_within_grants(&path, &roots).map_err(broker_error)?;
                let offset = params.get("offset").and_then(Value::as_u64).unwrap_or(0);
                let maximum = params
                    .get("maxBytes")
                    .and_then(Value::as_u64)
                    .unwrap_or(32 * 1024);
                if maximum == 0 || maximum > MAX_BYTES as u64 {
                    return Err(error("invalid_params", "maxBytes must be in 1..262144"));
                }
                selected
                    .file
                    .seek(SeekFrom::Start(offset))
                    .map_err(io_error)?;
                let mut bytes = Vec::new();
                Read::by_ref(&mut selected.file)
                    .take(maximum)
                    .read_to_end(&mut bytes)
                    .map_err(io_error)?;
                let length = selected.file.metadata().map_err(io_error)?.len();
                selected.check_location().map_err(broker_error)?;
                Ok(
                    json!({"data":BASE64.encode(&bytes),"encoding":"base64","offset":offset,"eof":offset.saturating_add(bytes.len() as u64)>=length,"size":length}),
                )
            }
            "stat" => {
                let selected = pin_within_grants(&path, &roots).map_err(broker_error)?;
                metadata(&selected.file)
            }
            "readDir" => directory_snapshot(&path, &roots),
            "writeAtomic" => {
                let parent = path
                    .parent()
                    .ok_or_else(|| error("invalid_params", "target has no parent"))?;
                let pinned_parent = pin_within_grants(parent, &roots).map_err(broker_error)?;
                let expected = params.get("expectedVersion").ok_or_else(|| {
                    error(
                        "invalid_params",
                        "expectedVersion is required; null creates a new file",
                    )
                })?;
                let previous = match fs::symlink_metadata(&path) {
                    Ok(_) => {
                        let selected = pin_within_grants(&path, &roots).map_err(broker_error)?;
                        Some(version(&selected.file)?)
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                    Err(e) => return Err(io_error(e)),
                };
                if (expected.is_null() && previous.is_some())
                    || (!expected.is_null() && expected.as_str() != previous.as_deref())
                {
                    return Err(error(
                        "revision_conflict",
                        "the file changed; read its current version before replacing it",
                    ));
                }
                let data = params
                    .get("data")
                    .and_then(Value::as_str)
                    .ok_or_else(|| error("invalid_params", "data must be base64"))?;
                let bytes = BASE64
                    .decode(data)
                    .map_err(|_| error("invalid_params", "data is not valid base64"))?;
                if bytes.len() > MAX_BYTES {
                    return Err(error(
                        "resource_limit",
                        "atomic writes are limited to 256 KiB",
                    ));
                }
                check()?;
                pinned_parent.check_location().map_err(broker_error)?;
                commit_file(&pinned_parent, &path, &bytes, expected.is_null())?;
                let current = pin_within_grants(&path, &roots).map_err(broker_error)?;
                Ok(json!({"version":version(&current.file)?,"bytesWritten":bytes.len()}))
            }
            "mkdir" => {
                let parent = path
                    .parent()
                    .ok_or_else(|| error("invalid_params", "target has no parent"))?;
                let selected = pin_within_grants(parent, &roots).map_err(broker_error)?;
                check()?;
                make_directory(&selected, &path)?;
                selected.check_location().map_err(broker_error)?;
                Ok(json!({"created":true}))
            }
            "remove" => {
                let parent = path
                    .parent()
                    .ok_or_else(|| error("invalid_params", "target has no parent"))?;
                let parent = pin_within_grants(parent, &roots).map_err(broker_error)?;
                let selected = pin_within_grants(&path, &roots).map_err(broker_error)?;
                let expected = string(&params, "expectedVersion")?;
                if version(&selected.file)? != expected {
                    return Err(error("revision_conflict", "the selected file changed"));
                }
                let is_dir = selected.file.metadata().map_err(io_error)?.is_dir();
                drop(selected);
                check()?;
                remove_child(&parent, &path, is_dir)?;
                Ok(json!({"removed":true}))
            }
            _ => Err(error("method_not_found", "unknown file service method")),
        }
    }

    fn target(
        &self,
        p: &Principal,
        params: &Value,
        write: bool,
        watch: bool,
    ) -> Result<(PathBuf, Vec<PathBuf>)> {
        if let Some(reference) = params.get("reference").and_then(Value::as_str) {
            let state = self.0.lock().unwrap_or_else(|p| p.into_inner());
            let selected = state
                .selections
                .get(reference)
                .filter(|s| s.owner == owner_key(p) && (!write || s.write))
                .ok_or_else(|| {
                    error(
                        "policy_denied",
                        "the selected file reference is unavailable for this operation",
                    )
                })?;
            // A file selection authorizes that file only. The parent pin needed
            // for creation/replacement is internal and cannot be returned as a ref.
            let roots = if selected.path.is_dir() {
                vec![selected.path.clone()]
            } else {
                vec![
                    selected
                        .path
                        .parent()
                        .ok_or_else(|| error("invalid_params", "selected path has no parent"))?
                        .to_owned(),
                ]
            };
            return Ok((selected.path.clone(), roots));
        }
        let path = PathBuf::from(string(params, "path")?);
        let policy = p
            .plugin
            .authorization
            .as_ref()
            .map(|a| &a.broker_policy)
            .ok_or_else(|| error("policy_denied", "no file scopes were granted"))?;
        let roots = if watch {
            &policy.watch_roots
        } else if write {
            &policy.write_roots
        } else {
            &policy.read_roots
        };
        crate::plugin_permissions::validate_policy_path(&path)
            .map_err(|e| error("invalid_params", e.to_string()))?;
        Ok((path, roots.clone()))
    }
    fn watch(&self, p: &Principal, target: PathBuf, roots: Vec<PathBuf>) -> Result<Value> {
        let initial_snapshot = snapshot(&target, &roots)?;
        let id = token("watch")?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if state.watches.len() >= 16
            || state
                .watches
                .values()
                .filter(|w| w.owner == owner_key(p))
                .count()
                >= 4
        {
            return Err(error("resource_limit", "file watch limit reached"));
        }
        state.watches.insert(
            id.clone(),
            Watch {
                owner: owner_key(p),
                target,
                roots,
                snapshot: initial_snapshot.clone(),
                revision: 0,
                events: VecDeque::new(),
                cancelled: cancelled.clone(),
            },
        );
        drop(state);
        let weak = Arc::downgrade(&self.0);
        let watch_id = id.clone();
        std::thread::Builder::new()
            .name("codlet-file-watch".into())
            .spawn(move || {
                let mut interval = Duration::from_secs(1);
                while !cancelled.load(Ordering::Acquire) {
                    std::thread::sleep(interval);
                    let Some(shared) = weak.upgrade() else {
                        break;
                    };
                    let location = shared
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .watches
                        .get(&watch_id)
                        .map(|w| (w.target.clone(), w.roots.clone()));
                    let Some((target, roots)) = location else {
                        break;
                    };
                    let next = match snapshot(&target, &roots) {
                        Ok(value) => value,
                        Err(e) => json!({"error":e.code}),
                    };
                    let mut state = shared.lock().unwrap_or_else(|p| p.into_inner());
                    let Some(watch) = state.watches.get_mut(&watch_id) else {
                        break;
                    };
                    if watch.snapshot != next {
                        interval = Duration::from_secs(1);
                        watch.revision += 1;
                        watch.snapshot = next;
                        watch.events.push_back(
                            json!({"cursor":watch.revision,"kind":"changed","rescan":true}),
                        );
                        if watch.events.len() > 128 {
                            watch.events.pop_front();
                        }
                    } else {
                        interval = (interval + Duration::from_secs(1)).min(Duration::from_secs(5));
                    }
                }
            })
            .map_err(|_| error("worker_unavailable", "cannot start file watcher"))?;
        Ok(
            json!({"watch":id,"cursor":0,"snapshot":initial_snapshot,"recursive":false,"pollIntervalMs":1000,"idlePollIntervalMs":5000}),
        )
    }
    fn dialog(&self, p: &Principal, save: bool, params: Value) -> Result<Value> {
        let kind = params.get("kind").and_then(Value::as_str).unwrap_or("file");
        if !matches!(kind, "file" | "directory") || (save && kind != "file") {
            return Err(error("invalid_params", "invalid file dialog kind"));
        }
        let name = params
            .get("suggestedName")
            .and_then(Value::as_str)
            .unwrap_or("Untitled");
        if name.len() > 255 || name.contains(['/', '\\', '\0', '\r', '\n']) {
            return Err(error("invalid_params", "suggestedName must be a file name"));
        }
        let id = token("dialog")?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if state
            .dialogs
            .values()
            .filter(|d| d.result["status"] == "selecting")
            .count()
            >= 2
            || state
                .dialogs
                .values()
                .any(|d| d.owner == owner_key(p) && d.result["status"] == "selecting")
        {
            return Err(error("resource_limit", "a file dialog is already open"));
        }
        if state.selections.len() >= 128 {
            return Err(error("resource_limit", "file selection limit reached"));
        }
        state
            .dialogs
            .retain(|_, d| d.owner != owner_key(p) || d.result["status"] == "selecting");
        let initial = json!({"dialog":id,"status":"selecting"});
        state.dialogs.insert(
            id.clone(),
            Dialog {
                owner: owner_key(p),
                cancelled: cancelled.clone(),
                result: initial.clone(),
            },
        );
        drop(state);
        let weak = Arc::downgrade(&self.0);
        let owner = owner_key(p);
        let name = name.to_owned();
        let directory = kind == "directory";
        std::thread::Builder::new().name("codlet-file-dialog".into()).spawn(move || {
            let outcome = native_dialog(save, directory, &name, cancelled.clone());
            let Some(shared) = weak.upgrade() else { return; };
            let mut state = shared.lock().unwrap_or_else(|p| p.into_inner());
            if !state.dialogs.contains_key(&id) { return; }
            let result = if cancelled.load(Ordering::Acquire) { json!({"dialog":id,"status":"cancelled"}) }
            else { match outcome {
                Ok(Some(path)) => match token("file") {
                    Ok(reference) => { state.selections.insert(reference.clone(), Selection { owner, path: path.clone(), write:save }); json!({"dialog":id,"status":"selected","reference":reference,"path":path,"access":if save {"write"} else {"read"}}) }
                    Err(e) => json!({"dialog":id,"status":"failed","code":e.code}),
                },
                Ok(None) => json!({"dialog":id,"status":"cancelled"}),
                Err(e) => json!({"dialog":id,"status":"failed","code":e.code,"message":e.message}),
            }};
            if let Some(dialog) = state.dialogs.get_mut(&id) { dialog.result = result; }
        }).map_err(|_| error("worker_unavailable", "cannot start file dialog"))?;
        Ok(initial)
    }
    pub fn retire(&self, p: &Principal) {
        let owner = owner_key(p);
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        state.watches.retain(|_, w| {
            if w.owner == owner {
                w.cancelled.store(true, Ordering::Release);
                false
            } else {
                true
            }
        });
        state.dialogs.retain(|_, d| {
            if d.owner == owner {
                d.cancelled.store(true, Ordering::Release);
                false
            } else {
                true
            }
        });
        state.selections.retain(|_, s| s.owner != owner);
    }
    pub fn list(&self, p: &Principal) -> Value {
        let state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        json!({"watches":state.watches.iter().filter(|(_,w)|w.owner==owner_key(p)).map(|(id,w)|json!({"id":id,"cursor":w.revision})).collect::<Vec<_>>(),"dialogs":state.dialogs.values().filter(|d|d.owner==owner_key(p)).map(|d|json!({"status":d.result["status"]})).collect::<Vec<_>>()})
    }
}
impl Drop for State {
    fn drop(&mut self) {
        for w in self.watches.values() {
            w.cancelled.store(true, Ordering::Release)
        }
        for d in self.dialogs.values() {
            d.cancelled.store(true, Ordering::Release)
        }
    }
}
fn snapshot(path: &Path, roots: &[PathBuf]) -> Result<Value> {
    let selected = pin_within_grants(path, roots).map_err(broker_error)?;
    let meta = selected.file.metadata().map_err(io_error)?;
    if meta.is_dir() {
        directory_snapshot(path, roots)
    } else {
        Ok(
            json!({"size":meta.len(),"modified":meta.modified().ok().and_then(|v|v.duration_since(UNIX_EPOCH).ok()).map(|v|v.as_nanos().to_string())}),
        )
    }
}
fn metadata(file: &File) -> Result<Value> {
    let meta = file.metadata().map_err(io_error)?;
    Ok(
        json!({"kind":if meta.is_dir(){"directory"}else{"file"},"size":meta.len(),"version":version(file)?,"modifiedMs":meta.modified().ok().and_then(|v|v.duration_since(UNIX_EPOCH).ok()).map(|v|v.as_millis())}),
    )
}
fn version(file: &File) -> Result<String> {
    let meta = file.metadata().map_err(io_error)?;
    // Content digest avoids low resolution mtime/size collisions. Very large
    // files use metadata evidence; callers are told whether it is a content hash.
    if meta.is_file() && meta.len() <= 16 * 1024 * 1024 {
        let mut clone = file.try_clone().map_err(io_error)?;
        clone.rewind().map_err(io_error)?;
        let mut hash = Sha256::new();
        let mut bytes = [0; 32768];
        loop {
            let n = clone.read(&mut bytes).map_err(io_error)?;
            if n == 0 {
                break;
            }
            hash.update(&bytes[..n]);
        }
        return Ok(format!("sha256:{:x}", hash.finalize()));
    }
    Ok(format!(
        "metadata:{}:{}",
        meta.len(),
        meta.modified()
            .ok()
            .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
            .map(|v| v.as_nanos())
            .unwrap_or(0)
    ))
}
fn directory_snapshot(path: &Path, roots: &[PathBuf]) -> Result<Value> {
    let selected = pin_within_grants(path, roots).map_err(broker_error)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&selected.path).map_err(io_error)?.take(1025) {
        let entry = entry.map_err(io_error)?;
        let meta = fs::symlink_metadata(entry.path()).map_err(io_error)?;
        entries.push(json!({"name":entry.file_name().to_string_lossy(),"kind":if meta.file_type().is_symlink(){"link"}else if meta.is_dir(){"directory"}else{"file"},"size":meta.len(),"modified":meta.modified().ok().and_then(|v|v.duration_since(UNIX_EPOCH).ok()).map(|v|v.as_nanos().to_string())}));
    }
    if entries.len() > 1024 {
        return Err(error(
            "resource_limit",
            "directory snapshot exceeds 1024 entries",
        ));
    }
    entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    selected.check_location().map_err(broker_error)?;
    Ok(json!({"entries":entries}))
}
fn io_error(e: std::io::Error) -> ServiceError {
    error("io_error", e.to_string())
}
fn broker_error(e: crate::os_broker::OsBrokerError) -> ServiceError {
    error(e.code, e.message)
}

#[cfg(windows)]
fn commit_file(
    parent: &crate::os_broker::filesystem::Selected,
    path: &Path,
    bytes: &[u8],
    create: bool,
) -> Result<()> {
    let mut temp = tempfile::NamedTempFile::new_in(&parent.path).map_err(io_error)?;
    temp.write_all(bytes).map_err(io_error)?;
    temp.as_file().sync_all().map_err(io_error)?;
    if create {
        temp.persist_noclobber(path)
            .map_err(|e| io_error(e.error))?;
    } else {
        use std::os::windows::ffi::OsStrExt;
        let target = path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let replacement = temp
            .path()
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        // ReplaceFile preserves the original target's ACL and attributes.
        if unsafe {
            windows_sys::Win32::Storage::FileSystem::ReplaceFileW(
                target.as_ptr(),
                replacement.as_ptr(),
                std::ptr::null(),
                0,
                std::ptr::null(),
                std::ptr::null(),
            )
        } == 0
        {
            return Err(io_error(std::io::Error::last_os_error()));
        }
    }
    Ok(())
}
#[cfg(windows)]
fn make_directory(_parent: &crate::os_broker::filesystem::Selected, path: &Path) -> Result<()> {
    fs::create_dir(path).map_err(io_error)
}
#[cfg(windows)]
fn remove_child(
    _parent: &crate::os_broker::filesystem::Selected,
    path: &Path,
    directory: bool,
) -> Result<()> {
    if directory {
        fs::remove_dir(path).map_err(io_error)
    } else {
        fs::remove_file(path).map_err(io_error)
    }
}

#[cfg(target_os = "macos")]
fn child_name(path: &Path) -> Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(
        path.file_name()
            .ok_or_else(|| error("invalid_params", "target needs a file name"))?
            .as_bytes(),
    )
    .map_err(|_| error("invalid_params", "file name contains NUL"))
}
#[cfg(target_os = "macos")]
fn commit_file(
    parent: &crate::os_broker::filesystem::Selected,
    path: &Path,
    bytes: &[u8],
    create: bool,
) -> Result<()> {
    use std::os::fd::{AsRawFd, FromRawFd};
    unsafe extern "C" {
        fn renameatx_np(
            from: i32,
            source: *const libc::c_char,
            to: i32,
            target: *const libc::c_char,
            flags: u32,
        ) -> i32;
    }
    let temporary = std::ffi::CString::new(format!(".{}", token("codlet-write")?)).unwrap();
    let name = child_name(path)?;
    let parent_fd = parent.file.as_raw_fd();
    let fd = unsafe {
        libc::openat(
            parent_fd,
            temporary.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let result = (|| {
        file.write_all(bytes).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        parent.check_location().map_err(broker_error)?;
        if unsafe {
            renameatx_np(
                parent_fd,
                temporary.as_ptr(),
                parent_fd,
                name.as_ptr(),
                if create { 4 } else { 0 },
            )
        } != 0
        {
            return Err(io_error(std::io::Error::last_os_error()));
        }
        parent.file.sync_all().map_err(|_| {
            error(
                "outcome_unknown",
                "file was replaced but directory durability could not be confirmed",
            )
        })?;
        Ok(())
    })();
    unsafe {
        libc::unlinkat(parent_fd, temporary.as_ptr(), 0);
    }
    result
}
#[cfg(target_os = "macos")]
fn make_directory(parent: &crate::os_broker::filesystem::Selected, path: &Path) -> Result<()> {
    use std::os::fd::AsRawFd;
    let name = child_name(path)?;
    if unsafe { libc::mkdirat(parent.file.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    Ok(())
}
#[cfg(target_os = "macos")]
fn remove_child(
    parent: &crate::os_broker::filesystem::Selected,
    path: &Path,
    directory: bool,
) -> Result<()> {
    use std::os::fd::AsRawFd;
    let name = child_name(path)?;
    if unsafe {
        libc::unlinkat(
            parent.file.as_raw_fd(),
            name.as_ptr(),
            if directory { libc::AT_REMOVEDIR } else { 0 },
        )
    } != 0
    {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    Ok(())
}
pub(super) fn token(prefix: &str) -> Result<String> {
    let mut bytes = [0u8; 16];
    #[cfg(windows)]
    {
        if unsafe {
            windows_sys::Win32::Security::Cryptography::BCryptGenRandom(
                std::ptr::null_mut(),
                bytes.as_mut_ptr(),
                16,
                2,
            )
        } < 0
        {
            return Err(error(
                "random_unavailable",
                "cannot issue file resource handle",
            ));
        }
    }
    #[cfg(target_os = "macos")]
    unsafe {
        libc::arc4random_buf(bytes.as_mut_ptr().cast(), bytes.len())
    };
    Ok(format!(
        "{prefix}_{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ))
}

#[cfg(windows)]
fn native_dialog(
    save: bool,
    directory: bool,
    name: &str,
    cancelled: Arc<AtomicBool>,
) -> Result<Option<PathBuf>> {
    use windows::{
        Win32::{System::Com::*, UI::Shell::*},
        core::{Interface, PCWSTR},
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{KillTimer, SetTimer};
    thread_local! { static ACTIVE:std::cell::RefCell<Option<(IFileDialog,Arc<AtomicBool>)>>=const{std::cell::RefCell::new(None)}; }
    unsafe extern "system" fn timer(
        _: windows_sys::Win32::Foundation::HWND,
        _: u32,
        _: usize,
        _: u32,
    ) {
        ACTIVE.with(|active| {
            if let Some((dialog, flag)) = &*active.borrow()
                && flag.load(Ordering::Acquire)
            {
                let _ = unsafe { dialog.Close(windows::core::HRESULT(0x800704c7u32 as i32)) };
            }
        });
    }
    let os_error = |e: windows::core::Error| error("os_dialog_error", e.to_string());
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(os_error)?;
        struct Apartment;
        impl Drop for Apartment {
            fn drop(&mut self) {
                unsafe { CoUninitialize() }
            }
        }
        let _com = Apartment;
        let dialog: IFileDialog = if save {
            let d: IFileSaveDialog =
                CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER).map_err(os_error)?;
            d.cast().map_err(os_error)?
        } else {
            let d: IFileOpenDialog =
                CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).map_err(os_error)?;
            d.cast().map_err(os_error)?
        };
        let mut flags =
            FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR | FOS_DONTADDTORECENT;
        if directory {
            flags |= FOS_PICKFOLDERS;
        }
        if save {
            flags |= FOS_OVERWRITEPROMPT;
        } else {
            flags |= FOS_FILEMUSTEXIST;
        }
        dialog.SetOptions(flags).map_err(os_error)?;
        if save {
            let wide = name.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
            dialog
                .SetFileName(PCWSTR(wide.as_ptr()))
                .map_err(os_error)?;
        }
        ACTIVE.with(|value| *value.borrow_mut() = Some((dialog.clone(), cancelled.clone())));
        let timer_id = SetTimer(std::ptr::null_mut(), 0, 100, Some(timer));
        let shown = dialog.Show(None);
        KillTimer(std::ptr::null_mut(), timer_id);
        ACTIVE.with(|value| *value.borrow_mut() = None);
        if let Err(e) = shown {
            if e.code().0 as u32 == 0x800704c7 {
                return Ok(None);
            }
            return Err(os_error(e));
        }
        let item = dialog.GetResult().map_err(os_error)?;
        let text = item.GetDisplayName(SIGDN_FILESYSPATH).map_err(os_error)?;
        let path = text
            .to_string()
            .map(PathBuf::from)
            .map_err(|e| error("os_dialog_error", e.to_string()));
        CoTaskMemFree(Some(text.0.cast()));
        let path = path?;
        crate::plugin_permissions::validate_policy_path(&path)
            .map_err(|e| error("invalid_selection", e.to_string()))?;
        if save {
            let parent = path
                .parent()
                .ok_or_else(|| error("invalid_selection", "selected path has no parent"))?;
            let _pinned = pin_exact_grant(parent, &[parent.to_owned()]).map_err(broker_error)?;
        } else {
            let _pinned =
                pin_exact_grant(&path, std::slice::from_ref(&path)).map_err(broker_error)?;
        }
        Ok(Some(path))
    }
}
#[cfg(target_os = "macos")]
fn native_dialog(
    save: bool,
    directory: bool,
    name: &str,
    cancelled: Arc<AtomicBool>,
) -> Result<Option<PathBuf>> {
    use std::process::{Command, Stdio};
    let command = if save {
        "choose file name with prompt \"Save plugin file\" default name (item 1 of args)"
    } else if directory {
        "choose folder with prompt \"Choose plugin directory\""
    } else {
        "choose file with prompt \"Choose plugin file\""
    };
    let script = format!(
        "on run args\nactivate\ntry\nreturn POSIX path of ({command})\non error number -128\nreturn \"\"\nend try\nend run"
    );
    let mut output = tempfile::NamedTempFile::new().map_err(io_error)?;
    let mut child = Command::new("/usr/bin/osascript")
        .args(["-e", &script, "--", name])
        .stdin(Stdio::null())
        .stdout(output.reopen().map_err(io_error)?)
        .stderr(Stdio::null())
        .spawn()
        .map_err(io_error)?;
    loop {
        if cancelled.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        if let Some(status) = child.try_wait().map_err(io_error)? {
            if !status.success() {
                return Err(error("os_dialog_error", "macOS file picker failed"));
            }
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    output.rewind().map_err(io_error)?;
    let mut text = String::new();
    output
        .take(16384)
        .read_to_string(&mut text)
        .map_err(io_error)?;
    let text = text.trim_end_matches(['\r', '\n']);
    if text.is_empty() {
        Ok(None)
    } else {
        Ok(Some(PathBuf::from(text)))
    }
}
