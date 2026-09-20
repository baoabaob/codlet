//! Explicit desktop actions. No clipboard polling and no keyboard hook.
use super::*;
use std::sync::mpsc::{Receiver, SyncSender};
#[cfg(target_os = "macos")]
pub(crate) mod macos_hotkeys;

#[derive(Clone)]
pub(super) struct Desktop(Arc<SharedDesktop>);
struct SharedDesktop {
    sender: SyncSender<Command>,
    state: Arc<Mutex<State>>,
    retired: Arc<Mutex<std::collections::BTreeSet<String>>>,
}
#[derive(Default)]
struct State {
    shortcuts: BTreeMap<String, Registration>,
    notifications: BTreeMap<String, String>,
    events: VecDeque<Value>,
    cursor: u64,
}
struct Registration {
    owner: String,
    chord: String,
    action: String,
}
enum Command {
    Register {
        owner: String,
        id: String,
        chord: String,
        action: String,
        reply: SyncSender<Result<Value>>,
    },
    Unregister {
        owner: String,
        id: String,
        reply: SyncSender<Result<Value>>,
    },
    Notify {
        owner: String,
        id: String,
        title: String,
        body: String,
        reply: SyncSender<Result<Value>>,
    },
    Dismiss {
        owner: String,
        id: String,
        reply: SyncSender<Result<Value>>,
    },
    ClipboardRead(String, SyncSender<Result<Value>>),
    ClipboardWrite(String, String, SyncSender<Result<Value>>),
    Retire(String),
}
impl Default for Desktop {
    fn default() -> Self {
        let (sender, receiver) = mpsc::sync_channel(16);
        let state = Arc::new(Mutex::new(State::default()));
        let retired = Arc::new(Mutex::new(std::collections::BTreeSet::new()));
        let worker_retired = retired.clone();
        let worker = Arc::downgrade(&state);
        let _ = std::thread::Builder::new()
            .name("codlet-desktop-services".into())
            .spawn(move || run(receiver, worker, worker_retired));
        Self(Arc::new(SharedDesktop {
            sender,
            state,
            retired,
        }))
    }
}
impl Desktop {
    pub fn invoke(
        &self,
        p: &Principal,
        method: &str,
        params: Value,
        check: &dyn Fn() -> Result<()>,
    ) -> Result<Value> {
        check()?;
        let owner = owner_key(p);
        match method {
            "clipboardRead" => self.call(|reply| Command::ClipboardRead(owner, reply)),
            "clipboardWrite" => {
                let text = params
                    .get("text")
                    .and_then(Value::as_str)
                    .filter(|v| v.len() <= 256 * 1024 && !v.contains('\0'))
                    .ok_or_else(|| {
                        error(
                            "invalid_params",
                            "clipboard text must be at most 256 KiB without NUL",
                        )
                    })?;
                self.call(|reply| Command::ClipboardWrite(owner, text.to_owned(), reply))
            }
            "registerShortcut" => {
                let chord = normalize_shortcut(string(&params, "shortcut")?)?;
                let allowed = p
                    .plugin
                    .authorization
                    .as_ref()
                    .map(|a| &a.broker_policy.shortcuts)
                    .ok_or_else(|| error("policy_denied", "no shortcuts were granted"))?;
                if !allowed.iter().any(|candidate| {
                    normalize_shortcut(candidate).is_ok_and(|value| value == chord)
                }) {
                    return Err(error(
                        "policy_denied",
                        "this specific shortcut was not granted",
                    ));
                }
                let action = string(&params, "actionId")?.to_owned();
                if action.len() > 128 {
                    return Err(error("invalid_params", "actionId exceeds 128 characters"));
                }
                let id = super::files::token("shortcut")?;
                self.call(|reply| Command::Register {
                    owner,
                    id,
                    chord,
                    action,
                    reply,
                })
            }
            "unregisterShortcut" => {
                let id = string(&params, "registration")?.to_owned();
                self.call(|reply| Command::Unregister { owner, id, reply })
            }
            "notify" => {
                let title = string(&params, "title")?.to_owned();
                let body = params
                    .get("body")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                if title.encode_utf16().count() > 63
                    || body.encode_utf16().count() > 255
                    || title.contains('\0')
                    || body.contains('\0')
                {
                    return Err(error(
                        "invalid_params",
                        "notification title/body exceed the native 63/255 character limits",
                    ));
                }
                if params
                    .get("actions")
                    .is_some_and(|v| v.as_array().is_none_or(|a| !a.is_empty()))
                {
                    return Err(error(
                        "invalid_params",
                        "this native notification style supports clicking the notification, without custom action buttons",
                    ));
                }
                let id = super::files::token("notification")?;
                self.call(|reply| Command::Notify {
                    owner,
                    id,
                    title,
                    body,
                    reply,
                })
            }
            "dismissNotification" => {
                let id = string(&params, "notification")?.to_owned();
                self.call(|reply| Command::Dismiss { owner, id, reply })
            }
            "notificationEvents" | "shortcutEvents" => {
                let after = params.get("after").and_then(Value::as_u64).unwrap_or(0);
                let kind = if method == "shortcutEvents" {
                    "shortcut"
                } else {
                    "notification"
                };
                let state = self.0.state.lock().unwrap_or_else(|p| p.into_inner());
                let events = state
                    .events
                    .iter()
                    .filter(|v| {
                        v["owner"] == owner
                            && v["kind"] == kind
                            && v["cursor"].as_u64().is_some_and(|n| n > after)
                    })
                    .map(|v| {
                        let mut v = v.clone();
                        v.as_object_mut().unwrap().remove("owner");
                        v
                    })
                    .collect::<Vec<_>>();
                Ok(
                    json!({"events":events,"cursor":state.cursor,"gap":state.events.front().and_then(|v|v["cursor"].as_u64()).is_some_and(|n|after>0&&after+1<n)}),
                )
            }
            _ => Err(error("method_not_found", "unknown desktop service method")),
        }
    }
    fn call(&self, create: impl FnOnce(SyncSender<Result<Value>>) -> Command) -> Result<Value> {
        let (send, receive) = mpsc::sync_channel(1);
        self.0
            .sender
            .try_send(create(send))
            .map_err(|_| error("resource_limit", "desktop command queue is full or stopped"))?;
        receive.recv_timeout(Duration::from_secs(3)).map_err(|_| {
            error(
                "outcome_unknown",
                "desktop action receipt timed out; query resources before retrying",
            )
        })?
    }
    pub fn retire(&self, p: &Principal) {
        self.0
            .retired
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(owner_key(p));
        let _ = self.0.sender.try_send(Command::Retire(owner_key(p)));
    }
    pub fn list(&self, p: &Principal) -> Value {
        let state = self.0.state.lock().unwrap_or_else(|p| p.into_inner());
        json!({"shortcuts":state.shortcuts.iter().filter(|(_,v)|v.owner==owner_key(p)).map(|(id,v)|json!({"registration":id,"shortcut":v.chord,"actionId":v.action})).collect::<Vec<_>>(),"notifications":state.notifications.iter().filter(|(_,owner)|**owner==owner_key(p)).map(|(id,_)|id).collect::<Vec<_>>()})
    }
}
fn emit(state: &mut State, owner: &str, kind: &str, id: &str, event: &str, action: Option<&str>) {
    state.cursor += 1;
    state.events.push_back(json!({"cursor":state.cursor,"owner":owner,"kind":kind,"resource":id,"event":event,"actionId":action,"time":now_ms()}));
    if state.events.len() > 256 {
        state.events.pop_front();
    }
}
fn run(
    receiver: Receiver<Command>,
    weak: Weak<Mutex<State>>,
    retired: Arc<Mutex<std::collections::BTreeSet<String>>>,
) {
    let mut native = match native::Native::new() {
        Ok(native) => native,
        Err(_) => return,
    };
    while let Some(shared) = weak.upgrade() {
        {
            let mut state = shared.lock().unwrap_or_else(|p| p.into_inner());
            let retired = retired.lock().unwrap_or_else(|p| p.into_inner()).clone();
            let keys = state
                .shortcuts
                .iter()
                .filter(|(_, v)| retired.contains(&v.owner))
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            for id in keys {
                native.unregister(&id);
                state.shortcuts.remove(&id);
            }
            let notices = state
                .notifications
                .iter()
                .filter(|(_, owner)| retired.contains(*owner))
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            for id in notices {
                native.dismiss(&id);
                state.notifications.remove(&id);
            }
        }
        for (id, kind) in native.poll() {
            let mut state = shared.lock().unwrap_or_else(|p| p.into_inner());
            if kind == "shortcut" {
                if let Some(v) = state.shortcuts.get(&id) {
                    let (owner, action) = (v.owner.clone(), v.action.clone());
                    emit(
                        &mut state,
                        &owner,
                        "shortcut",
                        &id,
                        "pressed",
                        Some(&action),
                    );
                }
            } else if let Some(owner) = state.notifications.get(&id).cloned() {
                emit(&mut state, &owner, "notification", &id, kind, None);
            }
        }
        let command = match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(value) => value,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        let mut state = shared.lock().unwrap_or_else(|p| p.into_inner());
        let admission = match &command {
            Command::Register { owner, reply, .. }
            | Command::Unregister { owner, reply, .. }
            | Command::Notify { owner, reply, .. }
            | Command::Dismiss { owner, reply, .. }
            | Command::ClipboardRead(owner, reply)
            | Command::ClipboardWrite(owner, _, reply) => Some((owner, reply)),
            Command::Retire(_) => None,
        };
        if let Some((owner, reply)) = admission
            && retired
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .contains(owner)
        {
            let _ = reply.try_send(Err(error(
                "stale_generation",
                "desktop resource owner has retired",
            )));
            continue;
        }
        match command {
            Command::ClipboardRead(_, reply) => {
                let _ = reply.try_send(native.clipboard_read().map(|text| json!({"text":text})));
            }
            Command::ClipboardWrite(_, text, reply) => {
                let _ = reply.try_send(
                    native
                        .clipboard_write(&text)
                        .map(|()| json!({"written":true})),
                );
            }
            Command::Register {
                owner,
                id,
                chord,
                action,
                reply,
            } => {
                let result = (|| {
                    if state.shortcuts.len() >= 64
                        || state
                            .shortcuts
                            .values()
                            .filter(|v| v.owner == owner)
                            .count()
                            >= 8
                    {
                        return Err(error("resource_limit", "global shortcut limit reached"));
                    }
                    if state.shortcuts.values().any(|v| v.chord == chord) {
                        return Err(error("shortcut_conflict", "shortcut is already registered"));
                    }
                    native.register(&id, &chord)?;
                    state.shortcuts.insert(
                        id.clone(),
                        Registration {
                            owner,
                            chord: chord.clone(),
                            action,
                        },
                    );
                    Ok(json!({"registration":id,"normalized":chord}))
                })();
                let _ = reply.try_send(result);
            }
            Command::Unregister { owner, id, reply } => {
                let result = if state.shortcuts.get(&id).is_some_and(|v| v.owner == owner) {
                    native.unregister(&id);
                    state.shortcuts.remove(&id);
                    Ok(json!({"removed":true}))
                } else {
                    Err(error(
                        "resource_closed",
                        "shortcut registration is unavailable",
                    ))
                };
                let _ = reply.try_send(result);
            }
            Command::Notify {
                owner,
                id,
                title,
                body,
                reply,
            } => {
                let result = (|| {
                    if state.notifications.len() >= 64 {
                        return Err(error("resource_limit", "notification limit reached"));
                    }
                    native.notify(&id, &title, &body)?;
                    state.notifications.insert(id.clone(), owner.clone());
                    emit(&mut state, &owner, "notification", &id, "submitted", None);
                    Ok(json!({"notification":id,"state":"submitted","visible":Value::Null}))
                })();
                let _ = reply.try_send(result);
            }
            Command::Dismiss { owner, id, reply } => {
                let result = if state.notifications.get(&id) == Some(&owner) {
                    let dismissed = native.dismiss(&id);
                    state.notifications.remove(&id);
                    emit(
                        &mut state,
                        &owner,
                        "notification",
                        &id,
                        if dismissed { "dismissed" } else { "released" },
                        None,
                    );
                    Ok(json!({"dismissed":dismissed,"released":true}))
                } else {
                    Err(error("resource_closed", "notification is unavailable"))
                };
                let _ = reply.try_send(result);
            }
            Command::Retire(owner) => {
                let shortcuts = state
                    .shortcuts
                    .iter()
                    .filter(|(_, v)| v.owner == owner)
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                for id in shortcuts {
                    native.unregister(&id);
                    state.shortcuts.remove(&id);
                }
                let notifications = state
                    .notifications
                    .iter()
                    .filter(|(_, v)| **v == owner)
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                for id in notifications {
                    native.dismiss(&id);
                    state.notifications.remove(&id);
                }
            }
        }
    }
}
fn normalize_shortcut(value: &str) -> Result<String> {
    let mut control = false;
    let mut alt = false;
    let mut shift = false;
    let mut meta = false;
    let mut key = None;
    for part in value.split('+').map(str::trim) {
        match part.to_ascii_uppercase().as_str() {
            "CTRL" | "CONTROL" => control = true,
            "ALT" | "OPTION" => alt = true,
            "SHIFT" => shift = true,
            "META" | "SUPER" | "WIN" | "CMD" | "COMMAND" => meta = true,
            other => {
                if key.is_some() || !valid_key(other) {
                    return Err(error(
                        "invalid_shortcut",
                        "use modifiers plus A–Z, 0–9, F1–F24, Space, Enter or Escape",
                    ));
                }
                key = Some(other.to_owned());
            }
        }
    }
    if !control && !alt && !meta {
        return Err(error(
            "invalid_shortcut",
            "global shortcuts require Ctrl, Alt or Meta",
        ));
    }
    let key = key.ok_or_else(|| error("invalid_shortcut", "shortcut has no key"))?;
    let mut pieces = Vec::new();
    if control {
        pieces.push("Ctrl")
    }
    if alt {
        pieces.push("Alt")
    }
    if shift {
        pieces.push("Shift")
    }
    if meta {
        pieces.push("Meta")
    }
    pieces.push(&key);
    Ok(pieces.join("+"))
}
fn valid_key(value: &str) -> bool {
    value.len() == 1 && value.bytes().all(|b| b.is_ascii_alphanumeric())
        || matches!(value, "SPACE" | "ENTER" | "ESCAPE")
        || value
            .strip_prefix('F')
            .and_then(|v| v.parse::<u8>().ok())
            .is_some_and(|v| (1..=24).contains(&v))
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::ptr::null_mut;
    use windows::Win32::UI::Shell::{
        NIF_ICON, NIF_INFO, NIF_MESSAGE, NIIF_INFO, NIM_ADD, NIM_DELETE, NOTIFYICONDATAW,
        Shell_NotifyIconW,
    };
    use windows_sys::Win32::{
        Foundation::*,
        System::{DataExchange::*, Memory::*},
        UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
    };
    pub(super) struct Native {
        window: HWND,
        next: i32,
        keys: BTreeMap<String, i32>,
        notifications: BTreeMap<String, u32>,
    }
    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
    }
    impl Native {
        pub fn clipboard_read(&mut self) -> Result<String> {
            clipboard_read(self.window)
        }
        pub fn clipboard_write(&mut self, text: &str) -> Result<()> {
            clipboard_write(self.window, text)
        }
        pub fn new() -> Result<Self> {
            unsafe {
                let class = "CodletServiceWindow\0".encode_utf16().collect::<Vec<_>>();
                let registration = WNDCLASSW {
                    lpfnWndProc: Some(window_proc),
                    lpszClassName: class.as_ptr(),
                    ..std::mem::zeroed()
                };
                RegisterClassW(&registration);
                let window = CreateWindowExW(
                    0,
                    class.as_ptr(),
                    class.as_ptr(),
                    0,
                    0,
                    0,
                    0,
                    0,
                    null_mut(),
                    null_mut(),
                    null_mut(),
                    null_mut(),
                );
                if window.is_null() {
                    return Err(error(
                        "os_unavailable",
                        "cannot create desktop service window",
                    ));
                }
                Ok(Self {
                    window,
                    next: 1,
                    keys: BTreeMap::new(),
                    notifications: BTreeMap::new(),
                })
            }
        }
        pub fn register(&mut self, id: &str, chord: &str) -> Result<()> {
            let mut modifiers = MOD_NOREPEAT;
            let mut key = 0;
            for part in chord.split('+') {
                match part {
                    "Ctrl" => modifiers |= MOD_CONTROL,
                    "Alt" => modifiers |= MOD_ALT,
                    "Shift" => modifiers |= MOD_SHIFT,
                    "Meta" => modifiers |= MOD_WIN,
                    "SPACE" => key = 0x20,
                    "ENTER" => key = 0x0d,
                    "ESCAPE" => key = 0x1b,
                    other => {
                        key = if let Some(f) =
                            other.strip_prefix('F').and_then(|v| v.parse::<u32>().ok())
                        {
                            0x70 + f - 1
                        } else {
                            other.as_bytes()[0] as u32
                        }
                    }
                }
            }
            let token = self.next;
            self.next = self
                .next
                .checked_add(1)
                .ok_or_else(|| error("resource_limit", "shortcut ID exhausted"))?;
            if unsafe { RegisterHotKey(self.window, token, modifiers, key) } == 0 {
                return Err(error(
                    "shortcut_conflict",
                    "the OS rejected this global shortcut",
                ));
            }
            self.keys.insert(id.into(), token);
            Ok(())
        }
        pub fn unregister(&mut self, id: &str) {
            if let Some(token) = self.keys.remove(id) {
                unsafe {
                    UnregisterHotKey(self.window, token);
                }
            }
        }
        pub fn notify(&mut self, id: &str, title: &str, body: &str) -> Result<()> {
            let token = self.next as u32;
            self.next += 1;
            let mut data = self.data(token);
            data.uFlags = NIF_ICON | NIF_MESSAGE | NIF_INFO;
            data.uCallbackMessage = WM_APP + 17;
            data.hIcon = windows::Win32::UI::WindowsAndMessaging::HICON(unsafe {
                LoadIconW(null_mut(), IDI_INFORMATION)
            });
            for (target, value) in data.szInfoTitle.iter_mut().zip(title.encode_utf16()) {
                *target = value;
            }
            for (target, value) in data.szInfo.iter_mut().zip(body.encode_utf16()) {
                *target = value;
            }
            data.dwInfoFlags = NIIF_INFO;
            if !unsafe { Shell_NotifyIconW(NIM_ADD, &data) }.as_bool() {
                return Err(error(
                    "os_notification_failed",
                    "Windows did not accept the notification",
                ));
            }
            self.notifications.insert(id.into(), token);
            Ok(())
        }
        fn data(&self, id: u32) -> NOTIFYICONDATAW {
            NOTIFYICONDATAW {
                cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
                hWnd: windows::Win32::Foundation::HWND(self.window),
                uID: id,
                ..Default::default()
            }
        }
        pub fn dismiss(&mut self, id: &str) -> bool {
            if let Some(token) = self.notifications.remove(id) {
                return unsafe { Shell_NotifyIconW(NIM_DELETE, &self.data(token)) }.as_bool();
            }
            false
        }
        pub fn poll(&mut self) -> Vec<(String, &'static str)> {
            let mut events = Vec::new();
            unsafe {
                let mut msg = MSG::default();
                while PeekMessageW(&mut msg, self.window, 0, 0, PM_REMOVE) != 0 {
                    if msg.message == WM_HOTKEY {
                        if let Some((id, _)) = self
                            .keys
                            .iter()
                            .find(|(_, value)| **value == msg.wParam as i32)
                        {
                            events.push((id.clone(), "shortcut"));
                        }
                    } else if msg.message == WM_APP + 17 {
                        let kind = match msg.lParam as u32 {
                            0x405 => Some("clicked"),
                            0x403 | 0x404 => Some("hidden"),
                            _ => None,
                        };
                        if let Some(kind) = kind
                            && let Some((id, _)) = self
                                .notifications
                                .iter()
                                .find(|(_, value)| **value == msg.wParam as u32)
                        {
                            events.push((id.clone(), kind));
                        }
                    }
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
            events
        }
    }
    impl Drop for Native {
        fn drop(&mut self) {
            for token in self.keys.values() {
                unsafe {
                    UnregisterHotKey(self.window, *token);
                }
            }
            for token in self.notifications.values() {
                unsafe {
                    let _ = Shell_NotifyIconW(NIM_DELETE, &self.data(*token));
                }
            }
            unsafe {
                DestroyWindow(self.window);
            }
        }
    }
    struct Clipboard;
    impl Drop for Clipboard {
        fn drop(&mut self) {
            unsafe {
                CloseClipboard();
            }
        }
    }
    fn open_clipboard(window: HWND) -> Result<Clipboard> {
        for _ in 0..10 {
            if unsafe { OpenClipboard(window) } != 0 {
                return Ok(Clipboard);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Err(error(
            "clipboard_busy",
            "the clipboard is held by another application",
        ))
    }
    pub fn clipboard_read(window: HWND) -> Result<String> {
        let _clipboard = open_clipboard(window)?;
        unsafe {
            let handle = GetClipboardData(13);
            if handle.is_null() {
                return Ok(String::new());
            }
            let size = GlobalSize(handle);
            if size > 512 * 1024 {
                return Err(error("resource_limit", "clipboard text exceeds 256 KiB"));
            }
            let ptr = GlobalLock(handle).cast::<u16>();
            if ptr.is_null() {
                return Err(error("os_clipboard_failed", "cannot read clipboard text"));
            }
            let slice = std::slice::from_raw_parts(ptr, size / 2);
            let end = slice.iter().position(|v| *v == 0).unwrap_or(slice.len());
            let text = String::from_utf16_lossy(&slice[..end]);
            GlobalUnlock(handle);
            if text.len() > 256 * 1024 {
                return Err(error("resource_limit", "clipboard text exceeds 256 KiB"));
            }
            Ok(text)
        }
    }
    pub fn clipboard_write(window: HWND, text: &str) -> Result<()> {
        let _clipboard = open_clipboard(window)?;
        let wide = text.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        unsafe {
            let handle = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2);
            if handle.is_null() {
                return Err(error(
                    "os_clipboard_failed",
                    "cannot allocate clipboard text",
                ));
            }
            let ptr = GlobalLock(handle).cast::<u16>();
            if ptr.is_null() {
                GlobalFree(handle);
                return Err(error("os_clipboard_failed", "cannot lock clipboard memory"));
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
            GlobalUnlock(handle);
            if EmptyClipboard() == 0 || SetClipboardData(13, handle).is_null() {
                GlobalFree(handle);
                return Err(error(
                    "outcome_unknown",
                    "clipboard update did not return a success receipt",
                ));
            }
            Ok(())
        }
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use std::ffi::c_void;
    use std::process::{Command, Stdio};
    type Ref = *mut c_void;
    pub(super) struct Native {
        keys: std::collections::BTreeSet<String>,
        notifications: BTreeMap<String, String>,
    }
    impl Native {
        pub fn clipboard_read(&mut self) -> Result<String> {
            clipboard_read()
        }
        pub fn clipboard_write(&mut self, text: &str) -> Result<()> {
            clipboard_write(text)
        }
        pub fn new() -> Result<Self> {
            Ok(Self {
                keys: std::collections::BTreeSet::new(),
                notifications: BTreeMap::new(),
            })
        }
        pub fn register(&mut self, id: &str, chord: &str) -> Result<()> {
            let mut modifiers = 0;
            let mut key = None;
            for part in chord.split('+') {
                match part {
                    "Ctrl" => modifiers |= 1 << 12,
                    "Alt" => modifiers |= 1 << 11,
                    "Shift" => modifiers |= 1 << 9,
                    "Meta" => modifiers |= 1 << 8,
                    other => key = keycode(other),
                }
            }
            let key = key.ok_or_else(|| {
                error(
                    "invalid_shortcut",
                    "this key is unavailable in macOS virtual key mapping",
                )
            })?;
            super::macos_hotkeys::register(id, key, modifiers)?;
            self.keys.insert(id.into());
            Ok(())
        }
        pub fn unregister(&mut self, id: &str) {
            if self.keys.remove(id) {
                super::macos_hotkeys::unregister(id);
            }
        }
        pub fn poll(&mut self) -> Vec<(String, &'static str)> {
            super::macos_hotkeys::take_events(&self.keys)
        }
        pub fn notify(&mut self, id: &str, title: &str, body: &str) -> Result<()> {
            run_script(
                "on run args\ndisplay notification (item 2 of args) with title (item 1 of args)\nend run",
                &[title, body],
            )?;
            self.notifications.insert(id.into(), title.into());
            Ok(())
        }
        pub fn dismiss(&mut self, id: &str) -> bool {
            self.notifications.remove(id); /* macOS owns expiry of AppleScript notifications; no fabricated native dismissal. */
            false
        }
    }
    impl Drop for Native {
        fn drop(&mut self) {
            for id in &self.keys {
                super::macos_hotkeys::unregister(id);
            }
        }
    }
    fn keycode(key: &str) -> Option<u32> {
        Some(match key {
            "A" => 0,
            "S" => 1,
            "D" => 2,
            "F" => 3,
            "H" => 4,
            "G" => 5,
            "Z" => 6,
            "X" => 7,
            "C" => 8,
            "V" => 9,
            "B" => 11,
            "Q" => 12,
            "W" => 13,
            "E" => 14,
            "R" => 15,
            "Y" => 16,
            "T" => 17,
            "1" => 18,
            "2" => 19,
            "3" => 20,
            "4" => 21,
            "6" => 22,
            "5" => 23,
            "9" => 25,
            "7" => 26,
            "8" => 28,
            "0" => 29,
            "O" => 31,
            "U" => 32,
            "I" => 34,
            "P" => 35,
            "ENTER" => 36,
            "L" => 37,
            "J" => 38,
            "K" => 40,
            "N" => 45,
            "M" => 46,
            "SPACE" => 49,
            "ESCAPE" => 53,
            "F1" => 122,
            "F2" => 120,
            "F3" => 99,
            "F4" => 118,
            "F5" => 96,
            "F6" => 97,
            "F7" => 98,
            "F8" => 100,
            "F9" => 101,
            "F10" => 109,
            "F11" => 103,
            "F12" => 111,
            "F13" => 105,
            "F14" => 107,
            "F15" => 113,
            "F16" => 106,
            "F17" => 64,
            "F18" => 79,
            "F19" => 80,
            "F20" => 90,
            _ => return None,
        })
    }
    fn run_script(script: &str, args: &[&str]) -> Result<()> {
        let mut command = Command::new("/usr/bin/osascript");
        command
            .args(["-e", script, "--"])
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = command
            .spawn()
            .map_err(|_| error("os_unavailable", "cannot start macOS desktop action"))?;
        let started = Instant::now();
        loop {
            if let Some(status) = child
                .try_wait()
                .map_err(|_| error("os_unavailable", "cannot query macOS desktop action"))?
            {
                return if status.success() {
                    Ok(())
                } else {
                    Err(error(
                        "os_permission_denied",
                        "macOS declined the desktop action",
                    ))
                };
            }
            if started.elapsed() > Duration::from_secs(2) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error("outcome_unknown", "macOS desktop action timed out"));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    #[link(name = "AppKit", kind = "framework")]
    unsafe extern "C" {}
    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const libc::c_char) -> Ref;
        fn sel_registerName(name: *const libc::c_char) -> Ref;
        fn objc_msgSend();
    }
    unsafe fn send0(receiver: Ref, selector: &std::ffi::CStr) -> Ref {
        let call: unsafe extern "C" fn(Ref, Ref) -> Ref =
            unsafe { std::mem::transmute(objc_msgSend as unsafe extern "C" fn()) };
        unsafe { call(receiver, sel_registerName(selector.as_ptr())) }
    }
    unsafe fn send1(receiver: Ref, selector: &std::ffi::CStr, arg: Ref) -> Ref {
        let call: unsafe extern "C" fn(Ref, Ref, Ref) -> Ref =
            unsafe { std::mem::transmute(objc_msgSend as unsafe extern "C" fn()) };
        unsafe { call(receiver, sel_registerName(selector.as_ptr()), arg) }
    }
    struct Pool(Ref);
    impl Drop for Pool {
        fn drop(&mut self) {
            unsafe {
                send0(self.0, c"drain");
            }
        }
    }
    unsafe fn pasteboard() -> (Pool, Ref, Ref) {
        unsafe {
            let pool = Pool(send0(
                send0(objc_getClass(c"NSAutoreleasePool".as_ptr()), c"alloc"),
                c"init",
            ));
            let board = send0(
                objc_getClass(c"NSPasteboard".as_ptr()),
                c"generalPasteboard",
            );
            let kind = send1(
                objc_getClass(c"NSString".as_ptr()),
                c"stringWithUTF8String:",
                c"public.utf8-plain-text".as_ptr() as Ref,
            );
            (pool, board, kind)
        }
    }
    pub fn clipboard_read() -> Result<String> {
        unsafe {
            let (_pool, board, kind) = pasteboard();
            let value = send1(board, c"stringForType:", kind);
            if value.is_null() {
                return Ok(String::new());
            }
            let length: unsafe extern "C" fn(Ref, Ref, usize) -> usize =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let bytes = length(
                value,
                sel_registerName(c"lengthOfBytesUsingEncoding:".as_ptr()),
                4,
            );
            if bytes > 256 * 1024 {
                return Err(error("resource_limit", "clipboard text exceeds 256 KiB"));
            }
            let text = send0(value, c"UTF8String");
            if text.is_null() {
                return Err(error(
                    "os_clipboard_failed",
                    "clipboard text cannot be converted to UTF-8",
                ));
            }
            String::from_utf8(std::slice::from_raw_parts(text.cast::<u8>(), bytes).to_vec())
                .map_err(|_| error("os_clipboard_failed", "clipboard text is not UTF-8"))
        }
    }
    pub fn clipboard_write(text: &str) -> Result<()> {
        let text = std::ffi::CString::new(text)
            .map_err(|_| error("invalid_params", "clipboard text contains NUL"))?;
        unsafe {
            let (_pool, board, kind) = pasteboard();
            let string = send1(
                objc_getClass(c"NSString".as_ptr()),
                c"stringWithUTF8String:",
                text.as_ptr() as Ref,
            );
            send0(board, c"clearContents");
            let call: unsafe extern "C" fn(Ref, Ref, Ref, Ref) -> i8 =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            if call(
                board,
                sel_registerName(c"setString:forType:".as_ptr()),
                string,
                kind,
            ) == 0
            {
                return Err(error(
                    "outcome_unknown",
                    "macOS clipboard write was not confirmed",
                ));
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_chords_are_canonical_and_never_bare_keys() {
        assert_eq!(
            normalize_shortcut("shift + Control + k").unwrap(),
            "Ctrl+Shift+K"
        );
        assert_eq!(normalize_shortcut("Command+Alt+F2").unwrap(), "Alt+Meta+F2");
        assert!(normalize_shortcut("K").is_err());
        assert!(normalize_shortcut("Ctrl+A+B").is_err());
    }
    #[test]
    fn desktop_event_log_drops_oldest_without_retaining_text() {
        let mut state = State::default();
        for _ in 0..300 {
            emit(&mut state, "owner", "notification", "n", "submitted", None);
        }
        assert_eq!(state.events.len(), 256);
        assert_eq!(state.events.front().unwrap()["cursor"], 45);
        assert!(state.events.iter().all(|v| v.get("body").is_none()));
    }
}
