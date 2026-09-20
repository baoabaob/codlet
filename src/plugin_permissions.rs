//! Explicit OS broker scope grants. Registry validation is structural and never
//! follows a directory; the CLI canonicalizes only the paths selected by a user.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::plugins::{LocalPluginRegistration, Permission};

pub const MAX_BROKER_SCOPES: usize = 32;
pub const MAX_POLICY_PATH_BYTES: usize = 4096;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BrokerPolicy {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub read_roots: Vec<PathBuf>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub network_origins: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub executables: Vec<PathBuf>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub write_roots: Vec<PathBuf>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub watch_roots: Vec<PathBuf>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cwd_roots: Vec<PathBuf>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env_keys: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shortcuts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct PermissionPolicyError {
    pub message: String,
}

impl BrokerPolicy {
    pub fn is_empty(&self) -> bool {
        self.read_roots.is_empty()
            && self.network_origins.is_empty()
            && self.executables.is_empty()
            && self.write_roots.is_empty()
            && self.watch_roots.is_empty()
            && self.cwd_roots.is_empty()
            && self.env_keys.is_empty()
            && self.shortcuts.is_empty()
    }

    pub fn validate(&self) -> Result<(), PermissionPolicyError> {
        for (name, paths) in [
            ("readRoots", &self.read_roots),
            ("executables", &self.executables),
            ("writeRoots", &self.write_roots),
            ("watchRoots", &self.watch_roots),
            ("cwdRoots", &self.cwd_roots),
        ] {
            if paths.len() > MAX_BROKER_SCOPES {
                return Err(policy_error(format!(
                    "{name} exceeds {MAX_BROKER_SCOPES} entries"
                )));
            }
            let mut seen = BTreeSet::new();
            for path in paths {
                validate_policy_path(path)?;
                #[cfg(windows)]
                if name == "executables"
                    && !path
                        .extension()
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
                {
                    return Err(policy_error("executables must name .exe files"));
                }
                if !seen.insert(path) {
                    return Err(policy_error(format!("{name} contains duplicate paths")));
                }
            }
        }
        if self.network_origins.len() > MAX_BROKER_SCOPES {
            return Err(policy_error("networkOrigins exceeds its entry bound"));
        }
        let mut seen = BTreeSet::new();
        for origin in &self.network_origins {
            if normalize_origin(origin)? != *origin {
                return Err(policy_error(
                    "networkOrigins must use normalized exact HTTP(S) origins without a trailing slash",
                ));
            }
            if !seen.insert(origin) {
                return Err(policy_error("networkOrigins contains duplicates"));
            }
        }
        for (name, values) in [("envKeys", &self.env_keys), ("shortcuts", &self.shortcuts)] {
            if values.len() > MAX_BROKER_SCOPES
                || values.iter().any(|value| {
                    value.is_empty() || value.len() > 128 || value.chars().any(char::is_control)
                })
                || values.iter().collect::<BTreeSet<_>>().len() != values.len()
            {
                return Err(policy_error(format!(
                    "{name} must contain at most 32 distinct bounded values"
                )));
            }
        }
        if self.env_keys.iter().any(|key| {
            !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                || key.as_bytes()[0].is_ascii_digit()
        }) {
            return Err(policy_error("envKeys must be environment variable names"));
        }
        Ok(())
    }

    pub fn validate_grants(&self, grants: &[Permission]) -> Result<(), PermissionPolicyError> {
        self.validate()?;
        for (present, permission) in [
            (!self.read_roots.is_empty(), Permission::HostFs),
            (!self.network_origins.is_empty(), Permission::HostNetwork),
            (!self.write_roots.is_empty(), Permission::HostFsWrite),
            (!self.watch_roots.is_empty(), Permission::HostFsWatch),
            (
                !self.cwd_roots.is_empty() || !self.env_keys.is_empty(),
                Permission::HostProcessSpawn,
            ),
            (!self.shortcuts.is_empty(), Permission::CoreShortcuts),
        ] {
            if present && !grants.contains(&permission) {
                return Err(policy_error(format!(
                    "broker scope requires explicit {} grant",
                    permission.as_str()
                )));
            }
        }
        if !self.executables.is_empty()
            && !grants.contains(&Permission::HostProcess)
            && !grants.contains(&Permission::HostProcessSpawn)
        {
            return Err(policy_error(
                "executable scopes require host.process or host.process.spawn",
            ));
        }
        Ok(())
    }

    /// Canonicalize only explicitly supplied CLI values. This never supplies
    /// ambient defaults from the plugin directory, current URL, PATH or shell.
    pub fn from_explicit_inputs(
        read_roots: &[PathBuf],
        network_origins: &[String],
        executables: &[PathBuf],
    ) -> Result<Self, PermissionPolicyError> {
        let read_roots = read_roots
            .iter()
            .map(|path| canonical_selected(path, true))
            .collect::<Result<Vec<_>, _>>()?;
        let network_origins = network_origins
            .iter()
            .map(|origin| normalize_origin(origin))
            .collect::<Result<Vec<_>, _>>()?;
        let executables = executables
            .iter()
            .map(|path| canonical_selected(path, false))
            .collect::<Result<Vec<_>, _>>()?;
        let policy = Self {
            read_roots,
            network_origins,
            executables,
            ..Self::default()
        };
        policy.validate()?;
        Ok(policy)
    }

    pub fn canonicalized(&self) -> Result<Self, PermissionPolicyError> {
        let mut policy =
            Self::from_explicit_inputs(&self.read_roots, &self.network_origins, &self.executables)?;
        policy.write_roots = self
            .write_roots
            .iter()
            .map(|path| canonical_selected(path, true))
            .collect::<Result<_, _>>()?;
        policy.watch_roots = self
            .watch_roots
            .iter()
            .map(|path| canonical_selected(path, true))
            .collect::<Result<_, _>>()?;
        policy.cwd_roots = self
            .cwd_roots
            .iter()
            .map(|path| canonical_selected(path, true))
            .collect::<Result<_, _>>()?;
        policy.env_keys = self.env_keys.clone();
        policy.shortcuts = self.shortcuts.clone();
        policy.validate()?;
        Ok(policy)
    }
}

impl LocalPluginRegistration {
    /// The caller persists this changed complete record under the existing
    /// registry lock. Removing one grant never broadens another endpoint.
    pub fn remove_permission(&mut self, permission: Permission) -> bool {
        let old = self.clone();
        self.grants.retain(|grant| *grant != permission);
        match permission {
            Permission::HostFs => self.broker_policy.read_roots.clear(),
            Permission::HostNetwork => self.broker_policy.network_origins.clear(),
            Permission::HostProcess if !self.grants.contains(&Permission::HostProcessSpawn) => {
                self.broker_policy.executables.clear()
            }
            Permission::HostProcessSpawn => {
                if !self.grants.contains(&Permission::HostProcess) {
                    self.broker_policy.executables.clear();
                }
                self.broker_policy.cwd_roots.clear();
                self.broker_policy.env_keys.clear();
            }
            Permission::HostFsWrite => self.broker_policy.write_roots.clear(),
            Permission::HostFsWatch => self.broker_policy.watch_roots.clear(),
            Permission::CoreShortcuts => self.broker_policy.shortcuts.clear(),
            _ => {}
        }
        *self != old
    }
}

pub fn normalize_origin(value: &str) -> Result<String, PermissionPolicyError> {
    if value.len() > 4096 {
        return Err(policy_error("network origin is too long"));
    }
    let url = url::Url::parse(value)
        .map_err(|_| policy_error("network origin must be an absolute HTTP(S) origin"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.path(), "" | "/")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(policy_error(
            "network origin must contain only HTTP(S) scheme, host and optional port; no credentials, path, query or fragment",
        ));
    }
    Ok(url.origin().ascii_serialization())
}

pub(crate) fn validate_policy_path(path: &Path) -> Result<(), PermissionPolicyError> {
    let text = path
        .to_str()
        .ok_or_else(|| policy_error("broker paths must be Unicode"))?;
    if text.is_empty()
        || text.len() > MAX_POLICY_PATH_BYTES
        || text.contains('\0')
        || !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
        || text
            .split(['\\', '/'])
            .any(|component| matches!(component, "." | ".."))
    {
        return Err(policy_error(
            "broker paths must be bounded absolute local paths without dot segments or NUL",
        ));
    }
    #[cfg(windows)]
    {
        use std::path::Prefix;
        if !matches!(path.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
        {
            return Err(policy_error(
                "broker paths must use a local drive, not UNC or a device namespace",
            ));
        }
        if path.components().skip(1).any(|part| {
            part.as_os_str().to_str().is_some_and(|part| {
                part.contains(':') || part.ends_with('.') || part.ends_with(' ')
            })
        }) {
            return Err(policy_error(
                "broker paths reject alternate data streams and ambiguous trailing characters",
            ));
        }
        for component in path.components().skip(1) {
            if let Some(name) = component.as_os_str().to_str() {
                let stem = name
                    .split('.')
                    .next()
                    .unwrap_or_default()
                    .to_ascii_uppercase();
                if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$")
                    || ["COM", "LPT"].into_iter().any(|prefix| {
                        stem.strip_prefix(prefix).is_some_and(|suffix| {
                            matches!(
                                suffix,
                                "1" | "2"
                                    | "3"
                                    | "4"
                                    | "5"
                                    | "6"
                                    | "7"
                                    | "8"
                                    | "9"
                                    | "¹"
                                    | "²"
                                    | "³"
                            )
                        })
                    })
                {
                    return Err(policy_error("broker paths reject Windows device names"));
                }
            }
        }
    }
    Ok(())
}

fn canonical_selected(path: &Path, directory: bool) -> Result<PathBuf, PermissionPolicyError> {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|error| policy_error(error.to_string()))?
            .join(path)
    };
    validate_policy_path(&absolute)?;
    let canonical = std::fs::canonicalize(&absolute).map_err(|error| {
        policy_error(format!(
            "cannot resolve selected broker path {}: {error}",
            absolute.display()
        ))
    })?;
    validate_policy_path(&canonical)?;
    let metadata =
        std::fs::metadata(&canonical).map_err(|error| policy_error(error.to_string()))?;
    if (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
        return Err(policy_error(
            "selected broker scope has the wrong file type",
        ));
    }
    #[cfg(windows)]
    if !directory
        && !canonical
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        return Err(policy_error(
            "process executable scopes must name .exe files; shell scripts are not executable scopes",
        ));
    }
    Ok(canonical)
}

fn policy_error(message: impl Into<String>) -> PermissionPolicyError {
    PermissionPolicyError {
        message: message.into(),
    }
}
