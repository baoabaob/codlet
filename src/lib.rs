pub mod capabilities;
pub mod cdp;
pub mod diagnostics;
pub mod local_plugins;
pub mod plugins;
pub mod renderer;

#[cfg(windows)]
pub mod probe;
#[cfg(windows)]
pub mod windows;
