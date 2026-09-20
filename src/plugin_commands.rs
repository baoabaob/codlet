//! Shared plugin command parsing and presentation for native desktop targets.
use crate::catalog::{PluginCatalog, PluginSource};
use crate::plugin_control::{PluginControlAction, PluginControlRequest};
use crate::plugins::{Permission, PluginRegistry};
use serde_json::{Value, json};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
mod github;
use CommandError as ProbeError;

#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    #[error(transparent)]
    Registry(#[from] crate::plugins::PluginRegistryError),
    #[error(transparent)]
    Manifest(#[from] crate::plugins::ManifestError),
    #[error(transparent)]
    Local(#[from] crate::local_plugins::LocalPluginError),
    #[error(transparent)]
    Policy(#[from] crate::plugin_permissions::PermissionPolicyError),
    #[error(transparent)]
    Control(#[from] crate::plugin_cli::PluginCliError),
    #[error(transparent)]
    GitHub(#[from] crate::github_distribution::GitHubDistributionError),
    #[error(
        "unrecognized plugin arguments; use codlet plugin list, preview, add, github, permissions, revoke, remove, enable, disable, reload, or operation"
    )]
    Usage,
    #[error(
        "local plugin {0} was inspected but not registered; explicitly supply --trust and --grant for each requested permission"
    )]
    PluginTrustRequired(String),
    #[error("unrecognized plugin permission {0}")]
    UnknownPermission(String),
}

pub fn run(arguments: &[OsString]) -> Result<(), CommandError> {
    match arguments {
        [command, action] if command == OsStr::new("plugin") && action == OsStr::new("list") => {
            let registry = PluginRegistry::load_default()?;
            print_plugin_registry(&registry)
        }
        [command, action, format]
            if command == OsStr::new("plugin")
                && action == OsStr::new("list")
                && format == OsStr::new("--json") =>
        {
            let registry = PluginRegistry::load_default()?;
            let catalog = PluginCatalog::load(&registry)?;
            let plugins:Vec<_>=catalog.entries().iter().map(|entry|json!({"id":entry.id,"enabled":registry.is_enabled(&entry.id),"manifest":entry.plugin.as_ref().ok().map(|p|&p.manifest),"validationError":entry.plugin.as_ref().err().map(ToString::to_string),"source":if registry.managed_plugins().contains_key(&entry.id){"github"}else if matches!(entry.source,PluginSource::Bundled){"bundled"}else{"local"},"path":registry.local_plugins().get(&entry.id).map(|r|&r.path)})).collect();
            println!(
                "{}",
                json!({"schema":1,"registry":registry.path(),"plugins":plugins})
            );
            Ok(())
        }
        [command, action, plugin_id, options @ ..]
            if command == OsStr::new("plugin")
                && matches!(
                    action.to_str(),
                    Some("enable" | "disable" | "reload" | "remove" | "operation")
                ) =>
        {
            let json = options.iter().any(|option| option == OsStr::new("--json"));
            let cascade = options
                .iter()
                .any(|option| option == OsStr::new("--cascade"));
            let delete_source = options
                .iter()
                .any(|option| option == OsStr::new("--delete-source"));
            if options.len()
                != usize::from(json) + usize::from(cascade) + usize::from(delete_source)
                || options.iter().any(|option| {
                    option != OsStr::new("--json")
                        && option != OsStr::new("--cascade")
                        && option != OsStr::new("--delete-source")
                })
                || (cascade && !matches!(action.to_str(), Some("disable" | "remove")))
                || (delete_source && action != OsStr::new("remove"))
            {
                return Err(ProbeError::Usage);
            }
            let plugin_id = plugin_id.to_str().ok_or(ProbeError::Usage)?;
            if action == OsStr::new("operation") {
                crate::plugin_cli::operation(plugin_id, json)?;
            } else {
                let action = match action.to_str().unwrap() {
                    "enable" => PluginControlAction::Enable,
                    "disable" => PluginControlAction::Disable,
                    "reload" => PluginControlAction::Reload,
                    "remove" => PluginControlAction::Remove,
                    _ => unreachable!(),
                };
                let remove_source = if delete_source {
                    Some(
                        crate::source_removal::preview(&PluginRegistry::load_default()?, plugin_id)
                            .map_err(crate::plugin_cli::PluginCliError::from)?
                            .request(),
                    )
                } else {
                    None
                };
                crate::plugin_cli::manage(
                    PluginControlRequest {
                        action,
                        plugin_id: plugin_id.into(),
                        permission: None,
                        cascade,
                        remove_source,
                        local_import: None,
                    },
                    json,
                )?;
            }
            Ok(())
        }
        [command, action, plugin_id, options @ ..]
            if command == OsStr::new("plugin") && action == OsStr::new("permissions") =>
        {
            let json = match options {
                [] => false,
                [option] if option == OsStr::new("--json") => true,
                _ => return Err(ProbeError::Usage),
            };
            print_plugin_permissions(plugin_id.to_str().ok_or(ProbeError::Usage)?, json)
        }
        [command, action, plugin_id, permission, options @ ..]
            if command == OsStr::new("plugin") && action == OsStr::new("revoke") =>
        {
            let json = match options {
                [] => false,
                [option] if option == OsStr::new("--json") => true,
                _ => return Err(ProbeError::Usage),
            };
            let permission = permission.to_str().ok_or(ProbeError::Usage)?;
            let permission = serde_json::from_value(Value::String(permission.to_owned()))
                .map_err(|_| ProbeError::UnknownPermission(permission.to_owned()))?;
            crate::plugin_cli::manage(
                PluginControlRequest {
                    action: PluginControlAction::Revoke,
                    plugin_id: plugin_id.to_str().ok_or(ProbeError::Usage)?.into(),
                    permission: Some(permission),
                    cascade: false,
                    remove_source: None,
                    local_import: None,
                },
                json,
            )?;
            Ok(())
        }
        [command, action, directory, options @ ..]
            if command == OsStr::new("plugin") && action == OsStr::new("add") =>
        {
            let options = parse_plugin_trust_options(options)?;
            add_local_plugin(Path::new(directory), options)
        }
        [command, source, arguments @ ..]
            if command == OsStr::new("plugin") && source == OsStr::new("github") =>
        {
            github::run(arguments)
        }
        [command, action, directory, options @ ..]
            if command == OsStr::new("plugin") && action == OsStr::new("preview") =>
        {
            let json = match options {
                [] => false,
                [option] if option == OsStr::new("--json") => true,
                _ => return Err(ProbeError::Usage),
            };
            let registry = PluginRegistry::load_default()?;
            let preview = crate::local_import::preview(&registry, Path::new(directory))
                .map_err(crate::plugin_cli::PluginCliError::from)?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string(&preview).expect("preview is serializable")
                );
            } else {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&preview).expect("preview is serializable")
                );
            }
            Ok(())
        }
        _ => Err(CommandError::Usage),
    }
}

fn print_plugin_registry(registry: &PluginRegistry) -> Result<(), ProbeError> {
    println!("plugin-registry: {}", registry.path().display());
    let catalog = PluginCatalog::load(registry)?;
    for entry in catalog.entries() {
        let source = match entry.source {
            PluginSource::Bundled => "bundled",
            PluginSource::Local { .. }
                if registry
                    .managed_plugins()
                    .get(&entry.id)
                    .and_then(|record| record.current())
                    .is_some() =>
            {
                "github"
            }
            PluginSource::Local { .. } => "local",
        };
        let version = entry
            .plugin
            .as_ref()
            .map(|plugin| plugin.manifest.version.as_str())
            .unwrap_or("unavailable");
        println!(
            "plugin: id={}; version={version}; source={source}; enabled={}",
            entry.id,
            registry.is_enabled(&entry.id)
        );
        if let PluginSource::Local { path, grants } = &entry.source {
            println!("plugin-directory: {}", path.display());
            println!("granted-permissions: {}", permission_list(grants));
        }
        if let Err(error) = &entry.plugin {
            println!(
                "plugin-validation: id={}; state=failed; error={error}",
                entry.id
            );
        }
    }
    Ok(())
}

#[derive(Default)]
struct PluginTrustOptions {
    trusted: bool,
    enable: bool,
    json: bool,
    grants: Vec<Permission>,
    read_roots: Vec<PathBuf>,
    network_origins: Vec<String>,
    executables: Vec<PathBuf>,
    write_roots: Vec<PathBuf>,
    watch_roots: Vec<PathBuf>,
    cwd_roots: Vec<PathBuf>,
    env_keys: Vec<String>,
    shortcuts: Vec<String>,
}

fn parse_plugin_trust_options(arguments: &[OsString]) -> Result<PluginTrustOptions, ProbeError> {
    let mut options = PluginTrustOptions::default();
    let mut arguments = arguments.iter();
    while let Some(argument) = arguments.next() {
        if argument == OsStr::new("--trust") && !options.trusted {
            options.trusted = true;
        } else if argument == OsStr::new("--enable") && !options.enable {
            options.enable = true;
        } else if argument == OsStr::new("--json") && !options.json {
            options.json = true;
        } else if argument == OsStr::new("--grant") {
            let permission = arguments
                .next()
                .and_then(|permission| permission.to_str())
                .ok_or(ProbeError::Usage)?;
            let grant: Permission = serde_json::from_value(Value::String(permission.to_owned()))
                .map_err(|_| ProbeError::UnknownPermission(permission.to_owned()))?;
            if options.grants.contains(&grant) {
                return Err(ProbeError::Usage);
            }
            options.grants.push(grant);
        } else if argument == OsStr::new("--read-root") {
            options
                .read_roots
                .push(PathBuf::from(arguments.next().ok_or(ProbeError::Usage)?));
        } else if argument == OsStr::new("--network-origin") {
            options.network_origins.push(
                arguments
                    .next()
                    .and_then(|value| value.to_str())
                    .ok_or(ProbeError::Usage)?
                    .into(),
            );
        } else if matches!(
            argument.to_str(),
            Some("--write-root" | "--watch-root" | "--cwd-root")
        ) {
            let path = PathBuf::from(arguments.next().ok_or(ProbeError::Usage)?);
            match argument.to_str().unwrap() {
                "--write-root" => options.write_roots.push(path),
                "--watch-root" => options.watch_roots.push(path),
                _ => options.cwd_roots.push(path),
            }
        } else if matches!(argument.to_str(), Some("--env-key" | "--shortcut")) {
            let value = arguments
                .next()
                .and_then(|value| value.to_str())
                .ok_or(ProbeError::Usage)?
                .to_owned();
            if argument == OsStr::new("--env-key") {
                options.env_keys.push(value);
            } else {
                options.shortcuts.push(value);
            }
        } else if argument == OsStr::new("--executable") {
            options
                .executables
                .push(PathBuf::from(arguments.next().ok_or(ProbeError::Usage)?));
        } else {
            return Err(ProbeError::Usage);
        }
    }
    Ok(options)
}

fn permission_list(permissions: &[Permission]) -> String {
    if permissions.is_empty() {
        "none".to_owned()
    } else {
        permissions
            .iter()
            .map(|permission| permission.as_str())
            .collect::<Vec<_>>()
            .join(",")
    }
}

fn add_local_plugin(directory: &Path, options: PluginTrustOptions) -> Result<(), ProbeError> {
    let registry = PluginRegistry::load_default()?;
    let candidate = crate::local_import::preview(&registry, directory)
        .map_err(crate::plugin_cli::PluginCliError::from)?;
    let plugin_id = &candidate.manifest.id;
    if !options.json {
        println!(
            "plugin-candidate: id={plugin_id}; version={}; source=local",
            candidate.manifest.version
        );
        println!("plugin-directory: {}", candidate.path.display());
        println!(
            "requested-permissions: {}",
            permission_list(&candidate.manifest.permissions)
        );
    }
    if !options.trusted {
        return Err(ProbeError::PluginTrustRequired(plugin_id.clone()));
    }
    crate::local_plugins::validate_grants(&candidate.manifest, &options.grants)?;
    let mut broker_policy = crate::plugin_permissions::BrokerPolicy::from_explicit_inputs(
        &options.read_roots,
        &options.network_origins,
        &options.executables,
    )?;
    broker_policy.write_roots = options.write_roots;
    broker_policy.watch_roots = options.watch_roots;
    broker_policy.cwd_roots = options.cwd_roots;
    broker_policy.env_keys = options.env_keys;
    broker_policy.shortcuts = options.shortcuts;
    let broker_policy = broker_policy.canonicalized()?;
    broker_policy.validate_grants(&options.grants)?;
    if !options.json {
        println!("granted-permissions: {}", permission_list(&options.grants));
        println!(
            "broker-policy: {}",
            serde_json::to_string(&broker_policy).expect("policy is serializable")
        );
        if options.grants.contains(&Permission::HostProcess) {
            println!(
                "host-authority: managed Node and approved child processes run with the current user's OS permissions; this grant is not a sandbox"
            );
        }
    }
    crate::plugin_cli::manage(
        PluginControlRequest {
            action: PluginControlAction::Import,
            plugin_id: plugin_id.clone(),
            permission: None,
            cascade: false,
            remove_source: None,
            local_import: Some(candidate.request(options.grants, broker_policy, options.enable)),
        },
        options.json,
    )?;
    Ok(())
}

fn print_plugin_permissions(plugin_id: &str, json: bool) -> Result<(), ProbeError> {
    let registry = PluginRegistry::load_default()?;
    let registration = registry
        .local_plugins()
        .get(plugin_id)
        .ok_or_else(|| crate::plugin_cli::PluginCliError::UnknownPlugin(plugin_id.to_owned()))?;
    if json {
        let mut value = serde_json::json!({
            "schema":1,"kind":"codlet.plugin-permissions","pluginId":plugin_id,
            "registration":registration,"enabled":registry.is_enabled(plugin_id)
        });
        if let Some(current) = registry
            .managed_plugins()
            .get(plugin_id)
            .and_then(|record| record.current())
        {
            value["ownership"] = Value::from("core-managed-github");
            value["managedSource"] =
                serde_json::to_value(&current.source).expect("source is serializable");
            value["managedVersionKey"] = Value::from(current.version_key.clone());
            value["metadata"] =
                serde_json::to_value(&current.metadata).expect("metadata is serializable");
        }
        println!("{}", value);
    } else {
        println!(
            "plugin-permissions: id={plugin_id}; directory={}",
            registration.path.display()
        );
        println!(
            "granted-permissions: {}",
            permission_list(&registration.grants)
        );
        println!(
            "broker-policy: {}",
            serde_json::to_string_pretty(&registration.broker_policy)
                .expect("policy is serializable")
        );
    }
    Ok(())
}
