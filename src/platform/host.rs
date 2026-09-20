//! Stdio cancellation and owned process resources used by the shared Host pump.
#[cfg(windows)]
pub(crate) use crate::windows::{
    local_ipc::{Channel, LocalIpcError},
    plugin_process::{OwnedPluginProcess, PluginStdio},
};
#[cfg(windows)]
pub(crate) type StopSignal = std::sync::Arc<std::os::windows::io::OwnedHandle>;
#[cfg(windows)]
pub(crate) fn signal(stop: &StopSignal) {
    unsafe {
        windows_sys::Win32::System::Threading::SetEvent(crate::windows::local_ipc::raw(stop));
    }
}
#[cfg(windows)]
pub(crate) fn stream_closed(error: &LocalIpcError) -> bool {
    use windows_sys::Win32::Foundation::{
        ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_PIPE_NOT_CONNECTED,
    };
    matches!(
        error,
        LocalIpcError::Win32 {
            code: ERROR_BROKEN_PIPE | ERROR_NO_DATA | ERROR_PIPE_NOT_CONNECTED,
            ..
        }
    )
}
#[cfg(target_os = "macos")]
pub(crate) use crate::macos::host::{
    Channel, LocalIpcError, OwnedPluginProcess, PluginStdio, StopSignal, signal, stream_closed,
};
