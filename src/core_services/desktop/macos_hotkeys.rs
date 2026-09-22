//! Carbon event registration and polling must stay on the macOS main thread.
//! Workers submit bounded commands and wake the existing Core/CDP pump.
use super::*;
use std::collections::BTreeSet;
use std::ffi::c_void;
use std::sync::OnceLock;
type Ref = *mut c_void;
#[repr(C)]
#[derive(Clone, Copy)]
struct HotKeyId {
    signature: u32,
    id: u32,
}
#[repr(C)]
struct EventType {
    class: u32,
    kind: u32,
}
#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn RegisterEventHotKey(
        key: u32,
        mods: u32,
        id: HotKeyId,
        target: Ref,
        options: u32,
        out: *mut Ref,
    ) -> i32;
    fn UnregisterEventHotKey(key: Ref) -> i32;
    fn GetApplicationEventTarget() -> Ref;
    fn ReceiveNextEvent(
        count: u32,
        types: *const EventType,
        timeout: f64,
        pull: u8,
        out: *mut Ref,
    ) -> i32;
    fn GetEventParameter(
        event: Ref,
        name: u32,
        kind: u32,
        actual: *mut u32,
        size: u32,
        actual_size: *mut u32,
        data: *mut c_void,
    ) -> i32;
    fn ReleaseEvent(event: Ref);
}
enum Request {
    Register {
        id: String,
        key: u32,
        modifiers: u32,
        reply: SyncSender<Result<()>>,
        cancelled: Arc<AtomicBool>,
    },
    Unregister(String),
}
struct MainState {
    next: u32,
    handles: BTreeMap<String, (usize, u32)>,
    events: VecDeque<String>,
    receiver: Receiver<Request>,
}
struct Queue {
    sender: SyncSender<Request>,
    state: Mutex<MainState>,
    waker: Mutex<Option<crate::cdp::CdpClient>>,
}
fn queue() -> &'static Queue {
    static QUEUE: OnceLock<Queue> = OnceLock::new();
    QUEUE.get_or_init(|| {
        let (sender, receiver) = mpsc::sync_channel(128);
        Queue {
            sender,
            state: Mutex::new(MainState {
                next: 1,
                handles: BTreeMap::new(),
                events: VecDeque::new(),
                receiver,
            }),
            waker: Mutex::new(None),
        }
    })
}
pub(crate) fn set_waker(waker: crate::cdp::CdpClient) {
    *queue().waker.lock().unwrap_or_else(|p| p.into_inner()) = Some(waker);
}
fn wake() {
    if let Some(waker) = queue()
        .waker
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
    {
        waker.notify_runtime_activity();
    }
}
pub(super) fn register(id: &str, key: u32, modifiers: u32) -> Result<()> {
    let (send, receive) = mpsc::sync_channel(1);
    let cancelled = Arc::new(AtomicBool::new(false));
    queue()
        .sender
        .try_send(Request::Register {
            id: id.into(),
            key,
            modifiers,
            reply: send,
            cancelled: cancelled.clone(),
        })
        .map_err(|_| error("resource_limit", "macOS shortcut command queue is full"))?;
    wake();
    match receive.recv_timeout(Duration::from_secs(2)) {
        Ok(result) => result,
        Err(_) => {
            cancelled.store(true, Ordering::Release);
            unregister(id);
            Err(error(
                "outcome_unknown",
                "macOS main thread did not confirm shortcut registration",
            ))
        }
    }
}
pub(super) fn unregister(id: &str) {
    let _ = queue().sender.try_send(Request::Unregister(id.into()));
    wake();
}
pub(super) fn take_events(ids: &BTreeSet<String>) -> Vec<(String, &'static str)> {
    let mut state = queue().state.lock().unwrap_or_else(|p| p.into_inner());
    let mut result = Vec::new();
    state.events.retain(|id| {
        if ids.contains(id) {
            result.push((id.clone(), "shortcut"));
            false
        } else {
            true
        }
    });
    result
}
pub(crate) fn pump() {
    if unsafe { libc::pthread_main_np() } == 0 {
        return;
    }
    let mut state = queue().state.lock().unwrap_or_else(|p| p.into_inner());
    while let Ok(request) = state.receiver.try_recv() {
        match request {
            Request::Unregister(id) => {
                if let Some((handle, _)) = state.handles.remove(&id) {
                    unsafe {
                        UnregisterEventHotKey(handle as Ref);
                    }
                }
                state.events.retain(|entry| entry != &id);
            }
            Request::Register {
                id,
                key,
                modifiers,
                reply,
                cancelled,
            } => {
                if cancelled.load(Ordering::Acquire) {
                    continue;
                }
                let result = (|| {
                    if state.handles.len() >= 128 {
                        return Err(error(
                            "resource_limit",
                            "macOS native shortcut limit reached",
                        ));
                    }
                    let token = state.next;
                    state.next = state
                        .next
                        .checked_add(1)
                        .ok_or_else(|| error("resource_limit", "shortcut ID exhausted"))?;
                    let mut handle = std::ptr::null_mut();
                    if unsafe {
                        RegisterEventHotKey(
                            key,
                            modifiers,
                            HotKeyId {
                                signature: u32::from_be_bytes(*b"Cdlt"),
                                id: token,
                            },
                            GetApplicationEventTarget(),
                            0,
                            &mut handle,
                        )
                    } != 0
                    {
                        return Err(error("shortcut_conflict", "macOS rejected this shortcut"));
                    }
                    if cancelled.load(Ordering::Acquire) {
                        unsafe {
                            UnregisterEventHotKey(handle);
                        }
                        return Err(error("scope_ended", "shortcut registration was cancelled"));
                    }
                    state.handles.insert(id.clone(), (handle as usize, token));
                    Ok(())
                })();
                if reply.try_send(result).is_err()
                    && let Some((handle, _)) = state.handles.remove(&id)
                {
                    unsafe {
                        UnregisterEventHotKey(handle as Ref);
                    }
                }
            }
        }
    }
    let event_type = EventType {
        class: u32::from_be_bytes(*b"keyb"),
        kind: 6,
    };
    for _ in 0..32 {
        unsafe {
            let mut event = std::ptr::null_mut();
            if ReceiveNextEvent(1, &event_type, 0.0, 1, &mut event) != 0 || event.is_null() {
                break;
            }
            let mut value = HotKeyId {
                signature: 0,
                id: 0,
            };
            if GetEventParameter(
                event,
                u32::from_be_bytes(*b"----"),
                u32::from_be_bytes(*b"hkid"),
                std::ptr::null_mut(),
                std::mem::size_of::<HotKeyId>() as u32,
                std::ptr::null_mut(),
                (&mut value as *mut HotKeyId).cast(),
            ) == 0
                && value.signature == u32::from_be_bytes(*b"Cdlt")
                && let Some(id) = state
                    .handles
                    .iter()
                    .find(|(_, (_, token))| *token == value.id)
                    .map(|(id, _)| id.clone())
                && state.events.len() < 256
            {
                state.events.push_back(id);
            }
            ReleaseEvent(event);
        }
    }
}
