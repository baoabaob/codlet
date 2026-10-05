pub(crate) mod client_bootstrap;
pub mod control_pipe;
mod control_scope;
pub mod environment;
pub mod fake_child;
pub(crate) mod folder_dialog;
pub mod launch_mutex;
pub(crate) mod local_ipc;
pub(crate) mod open_folder;
pub(crate) mod owned_directory;
pub(crate) mod package_launch;
pub mod packages;
pub mod pipes;
pub(crate) mod plugin_process;
pub mod process;
pub(crate) mod restart_bridge;
pub mod status_pipe;

// Synthetic catalogs must never discover or control the user's running Core.
// Release builds reject test-fixtures, so product endpoint names stay unchanged.
pub(crate) const IPC_NAMESPACE: &str = if cfg!(feature = "test-fixtures") {
    "Codlet.TestFixtures"
} else {
    "Codlet"
};
