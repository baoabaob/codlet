pub mod capabilities;
pub mod catalog;
pub mod cdp;
pub mod diagnostics;
pub mod local_plugins;
pub mod plugin_control;
mod plugin_lifecycle;
pub mod plugin_watch;
pub mod plugins;
pub mod renderer;
pub mod runtime_control;
pub mod runtime_status;

#[cfg(windows)]
pub mod lab;
#[cfg(windows)]
pub mod plugin_cli;
#[cfg(windows)]
pub mod probe;
#[cfg(windows)]
pub mod windows;
