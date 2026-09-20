pub mod capabilities;
pub mod catalog;
pub mod cdp;
#[cfg(any(windows, target_os = "macos"))]
mod control_validation;
#[cfg(any(windows, target_os = "macos"))]
pub mod core_resources;
#[cfg(any(windows, target_os = "macos"))]
pub mod core_services;
pub mod diagnostic_bundle;
pub mod diagnostics;
pub mod github_distribution;
pub mod local_import;
pub mod local_plugins;
#[cfg(target_os = "macos")]
pub mod macos;
pub mod managed_plugins;
mod managed_storage;
mod official_update;
pub mod platform;
pub mod plugin_control;
pub mod plugin_execution;
pub mod plugin_host;
mod plugin_lifecycle;
pub mod plugin_permissions;
#[cfg(any(windows, target_os = "macos"))]
pub mod plugin_services;
pub mod plugin_watch;
pub mod plugins;
pub mod renderer;
pub mod runtime_control;
pub mod runtime_inspection;
pub mod runtime_log;
pub mod runtime_manage;
mod runtime_manage_github;
pub mod runtime_settings;
pub mod runtime_status;
pub mod runtime_update;
#[cfg(any(windows, target_os = "macos"))]
mod safe_mode;
pub mod source_removal;

#[cfg(any(windows, target_os = "macos"))]
pub mod host_control;
#[cfg(any(windows, target_os = "macos"))]
pub mod host_runtime;
#[cfg(any(windows, target_os = "macos"))]
pub mod js_runtime;
#[cfg(windows)]
pub mod lab;
#[cfg(any(windows, target_os = "macos"))]
pub mod os_broker;
#[cfg(any(windows, target_os = "macos"))]
pub mod plugin_cli;
#[cfg(any(windows, target_os = "macos"))]
pub mod plugin_commands;
mod plugin_update_install;
mod plugin_updates;
#[cfg(windows)]
pub mod probe;
mod runtime_skills;
#[cfg(windows)]
pub(crate) mod runtime_update_owner;
#[cfg(windows)]
pub mod windows;
