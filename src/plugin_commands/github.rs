//! GitHub distribution CLI. Network preparation is read-only with respect to
//! registration; final mutations use the same receipt/offline lease as the GUI.
use std::ffi::{OsStr, OsString};
use std::path::Path;

use serde::Serialize;

use super::{CommandError as ProbeError, PluginTrustOptions, parse_plugin_trust_options};
use crate::github_distribution::{GitHubClient, GitHubLink};
use crate::managed_plugins::{ManagedOperation, ManagedPreview};
use crate::plugin_control::{PluginControlAction, PluginControlRequest};
use crate::plugins::PluginRegistry;

pub(super) fn run(arguments: &[OsString]) -> Result<(), ProbeError> {
    match arguments {
        [action, url, options @ ..] if action == OsStr::new("releases") => {
            let json = json_only(options)?;
            let link = GitHubLink::parse(text(url)?)?;
            let catalog = runtime()?.block_on(GitHubClient::new()?.list_releases(&link))?;
            output(&catalog, json);
            Ok(())
        }
        [action, url, options @ ..] if action == OsStr::new("preview") => {
            let options = PreviewOptions::parse(options)?;
            let link = GitHubLink::parse(text(url)?)?;
            let registry = PluginRegistry::load_default()?;
            let package = runtime()?.block_on(GitHubClient::new()?.prepare_asset(
                &link.repository,
                options.release_id,
                options.asset_id,
                registry.path(),
            ))?;
            if options
                .update
                .as_ref()
                .is_some_and(|id| *id != package.manifest.id)
            {
                return Err(control(
                    "plugin_identity_changed",
                    "The release asset contains a different plugin ID from the requested update.",
                ));
            }
            if link
                .tag
                .as_ref()
                .is_some_and(|tag| tag != &package.source.tag)
                || link
                    .asset_name
                    .as_ref()
                    .is_some_and(|asset| asset != &package.source.asset_name)
            {
                return Err(control(
                    "github_selection_mismatch",
                    "The selected release or asset does not match the supplied release URL.",
                ));
            }
            let preview = crate::managed_plugins::preview(
                &registry,
                &package.package_path,
                if options.update.is_some() {
                    ManagedOperation::Update
                } else {
                    ManagedOperation::Install
                },
            )
            .map_err(crate::plugin_cli::PluginCliError::from)?;
            output(&preview, options.json);
            Ok(())
        }
        [action, id, options @ ..] if action == OsStr::new("history") => {
            let json = json_only(options)?;
            let id = text(id)?;
            let registry = PluginRegistry::load_default()?;
            let record = registry.managed_plugins().get(id).ok_or_else(|| {
                control(
                    "managed_plugin_required",
                    "This plugin has no retained managed versions.",
                )
            })?;
            output(
                &serde_json::json!({"pluginId":id,"currentVersion":record.current_version,"history":record.history}),
                json,
            );
            Ok(())
        }
        [action, path, options @ ..] if action == OsStr::new("install") => {
            let options = parse_plugin_trust_options(options)?;
            let registry = PluginRegistry::load_default()?;
            let preview = crate::managed_plugins::preview(
                &registry,
                Path::new(path),
                ManagedOperation::Install,
            )
            .map_err(crate::plugin_cli::PluginCliError::from)?;
            apply(preview, options)
        }
        [action, id, path, options @ ..] if action == OsStr::new("update") => {
            let options = parse_plugin_trust_options(options)?;
            let registry = PluginRegistry::load_default()?;
            let preview = crate::managed_plugins::preview(
                &registry,
                Path::new(path),
                ManagedOperation::Update,
            )
            .map_err(crate::plugin_cli::PluginCliError::from)?;
            if preview.manifest.id != text(id)? {
                return Err(control(
                    "plugin_identity_changed",
                    "The prepared package does not match the requested plugin ID.",
                ));
            }
            apply(preview, options)
        }
        [action, id, key, options @ ..] if action == OsStr::new("rollback") => {
            let options = parse_plugin_trust_options(options)?;
            let registry = PluginRegistry::load_default()?;
            let preview =
                crate::managed_plugins::preview_rollback(&registry, text(id)?, text(key)?)
                    .map_err(crate::plugin_cli::PluginCliError::from)?;
            apply(preview, options)
        }
        [action] if action == OsStr::new("community") => {
            println!("https://github.com/topics/codlet-plugin");
            Ok(())
        }
        _ => Err(control(
            "github_cli_usage",
            "Use `plugin github releases <url> [--json]`, `preview <url> --release <id> --asset <id> [--update <plugin-id>] [--json]`, `install <prepared-directory>`, `update <plugin-id> <prepared-directory>`, `history <plugin-id> [--json]`, or `rollback <plugin-id> <version-key>`. Mutations require --trust and explicit --grant for each permission; --enable is optional. Omit --trust to inspect a prepared candidate without registering it.",
        )),
    }
}

fn apply(preview: ManagedPreview, options: PluginTrustOptions) -> Result<(), ProbeError> {
    if !options.trusted {
        output(&preview, options.json);
        return Err(ProbeError::PluginTrustRequired(preview.manifest.id));
    }
    crate::local_plugins::validate_grants(&preview.manifest, &options.grants)?;
    let broker_policy = crate::plugin_permissions::BrokerPolicy::from_explicit_inputs(
        &options.read_roots,
        &options.network_origins,
        &options.executables,
    )?;
    broker_policy.validate_grants(&options.grants)?;
    if !options.json {
        output(&preview, false);
    }
    let action = match preview.operation {
        ManagedOperation::Install => PluginControlAction::Import,
        ManagedOperation::Update => PluginControlAction::Update,
        ManagedOperation::Rollback => PluginControlAction::Rollback,
    };
    crate::plugin_cli::manage(
        PluginControlRequest {
            action,
            plugin_id: preview.manifest.id.clone(),
            permission: None,
            cascade: false,
            remove_source: None,
            local_import: Some(preview.request(options.grants, broker_policy, options.enable)),
        },
        options.json,
    )?;
    Ok(())
}

struct PreviewOptions {
    release_id: u64,
    asset_id: u64,
    update: Option<String>,
    json: bool,
}
impl PreviewOptions {
    fn parse(arguments: &[OsString]) -> Result<Self, ProbeError> {
        let mut release_id = None;
        let mut asset_id = None;
        let mut update = None;
        let mut json = false;
        let mut args = arguments.iter();
        while let Some(argument) = args.next() {
            match text(argument)? {
                "--release" if release_id.is_none() => release_id = Some(positive_id(args.next())?),
                "--asset" if asset_id.is_none() => asset_id = Some(positive_id(args.next())?),
                "--update" if update.is_none() => {
                    update = Some(text(args.next().ok_or(ProbeError::Usage)?)?.to_owned())
                }
                "--json" if !json => json = true,
                _ => return Err(ProbeError::Usage),
            }
        }
        Ok(Self {
            release_id: release_id.ok_or(ProbeError::Usage)?,
            asset_id: asset_id.ok_or(ProbeError::Usage)?,
            update,
            json,
        })
    }
}
fn positive_id(value: Option<&OsString>) -> Result<u64, ProbeError> {
    text(value.ok_or(ProbeError::Usage)?)?
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or(ProbeError::Usage)
}
fn text(value: &OsStr) -> Result<&str, ProbeError> {
    value.to_str().ok_or(ProbeError::Usage)
}
fn json_only(options: &[OsString]) -> Result<bool, ProbeError> {
    match options {
        [] => Ok(false),
        [option] if option == OsStr::new("--json") => Ok(true),
        _ => Err(ProbeError::Usage),
    }
}
fn output(value: &impl Serialize, json: bool) {
    println!(
        "{}",
        if json {
            serde_json::to_string(value)
        } else {
            serde_json::to_string_pretty(value)
        }
        .expect("distribution DTO is serializable")
    );
}
fn control(code: &str, message: &str) -> ProbeError {
    crate::plugin_cli::PluginCliError::from(crate::plugin_control::PluginControlError::new(
        code, message,
    ))
    .into()
}
fn runtime() -> Result<tokio::runtime::Runtime, ProbeError> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| control("github_runtime_error", &error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_requires_one_exact_release_and_asset_without_implicit_latest() {
        let parse = |args: &[&str]| {
            PreviewOptions::parse(&args.iter().map(OsString::from).collect::<Vec<_>>())
        };
        for args in [
            &[][..],
            &["--release", "1"][..],
            &["--release", "0", "--asset", "2"][..],
            &["--release", "1", "--release", "2", "--asset", "3"][..],
            &["--release", "1", "--asset", "2", "--trust"][..],
        ] {
            assert!(parse(args).is_err());
        }
        let options = parse(&[
            "--release",
            "1",
            "--asset",
            "2",
            "--update",
            "dev.example",
            "--json",
        ])
        .unwrap();
        assert_eq!((options.release_id, options.asset_id), (1, 2));
        assert_eq!(options.update.as_deref(), Some("dev.example"));
        assert!(options.json);
    }
}
