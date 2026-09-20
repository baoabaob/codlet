//! Host-plugin protocol and process supervision, independent of any application
//! API, CDP connection, renderer runtime, or plugin manifest format.
mod error;
mod protocol;
pub use error::HostError;
#[cfg(any(windows, target_os = "macos"))]
mod supervisor;

pub use protocol::{HostIdentity, HostRpcError, MAX_HOST_FRAME_BYTES, MAX_HOST_PENDING_REQUESTS};
#[cfg(any(windows, target_os = "macos"))]
pub use supervisor::{HostEvent, HostExitReport, HostState, HostSupervisor};
