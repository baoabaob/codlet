//! Host-plugin protocol and process supervision, independent of any application
//! API, CDP connection, renderer runtime, or plugin manifest format.
mod protocol;
#[cfg(windows)]
mod supervisor;

pub use protocol::{HostIdentity, HostRpcError, MAX_HOST_FRAME_BYTES, MAX_HOST_PENDING_REQUESTS};
#[cfg(windows)]
pub use supervisor::{HostError, HostEvent, HostExitReport, HostState, HostSupervisor};
