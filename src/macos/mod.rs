//! Native macOS resources; the plugin and renderer protocols remain shared.
pub mod application;
pub mod cli;
#[path = "../probe/client_versions.rs"]
pub(crate) mod client_versions;
mod command;
pub mod control_pipe;
pub(crate) mod filesystem;
pub(crate) mod folder_dialog;
pub(crate) mod host;
pub mod identity;
pub mod launch_mutex;
#[doc(hidden)]
pub mod lifecycle;
pub(crate) mod open_folder;
pub mod pipes;
pub mod process_owner;
pub mod runtime;
