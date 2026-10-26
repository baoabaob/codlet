//! Core-owned skill resources and a serialized, runtime-only extra-root lease.
//! Native integration uses its existing local App Server connection, independently
//! of all optional plugins. User/project skill directories are never modified.
use crate::cdp::TargetSession;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
struct SkillDirectory {
    #[cfg(any(windows, target_os = "macos"))]
    pinned: Option<crate::platform::directory::Directory>,
    #[cfg(not(any(windows, target_os = "macos")))]
    skill: PathBuf,
    _lock: std::fs::File,
}
impl Drop for SkillDirectory {
    fn drop(&mut self) {
        #[cfg(any(windows, target_os = "macos"))]
        if let Some(pinned) = self.pinned.take()
            && let Err(error) = pinned.remove()
        {
            crate::runtime_log::error("runtime_skill_cleanup", &error.to_string());
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        let _ = std::fs::remove_dir_all(&self.skill);
    }
}
fn plain_directory(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    let redirect = metadata.file_type().is_symlink();
    #[cfg(windows)]
    let redirect = {
        use std::os::windows::fs::MetadataExt;
        redirect || metadata.file_attributes() & 0x400 != 0
    };
    if redirect || !metadata.is_dir() {
        return Err("Runtime skill resources must be a plain directory".into());
    }
    Ok(())
}
fn owned_skill(path: &Path, registry: &Path) -> bool {
    if plain_directory(path).is_err() {
        return false;
    }
    let metadata = std::fs::symlink_metadata(path.join("runtime.json"));
    if metadata.is_err()
        || metadata
            .as_ref()
            .is_ok_and(|m| !m.is_file() || m.file_type().is_symlink() || m.len() > 262144)
    {
        return false;
    }
    let Ok(data) = std::fs::read(path.join("runtime.json")) else {
        return false;
    };
    let Ok(value) = serde_json::from_slice::<Value>(&data) else {
        return false;
    };
    let Some(saved) = value.get("registry").and_then(Value::as_str) else {
        return false;
    };
    let saved = PathBuf::from(saved)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(saved));
    let expected = registry
        .canonicalize()
        .unwrap_or_else(|_| registry.to_path_buf());
    if cfg!(windows) {
        saved
            .to_string_lossy()
            .eq_ignore_ascii_case(&expected.to_string_lossy())
    } else {
        saved == expected
    }
}
pub(crate) const BINDING: &str = "codlet_core_skills_v1";
pub(crate) const MARKER: &str = "codlet.core.skills.v1";
const BRIDGE: &str = include_str!("../runtime/skill-bridge.js");
struct Pending {
    ticket: u64,
    target: String,
    context: u64,
    roots: Vec<String>,
    unknown: bool,
    dispatched: bool,
    confirmed: bool,
    client_id: String,
    client_epoch: u64,
}
type Owner = (String, u64, String, u64);
#[derive(Default)]
struct RootAuthority {
    roots: Vec<String>,
    registered: bool,
    uncertain: bool,
    baseline_known: bool,
    pending: Option<Pending>,
    revision: Value,
}

pub(crate) struct RuntimeSkills {
    _directory: SkillDirectory,
    root: PathBuf,
    script: String,
    next: u64,
    authorities: BTreeMap<String, RootAuthority>,
    bindings: BTreeMap<Owner, String>,
}
impl RuntimeSkills {
    pub(crate) fn prepare(registry: &Path) -> Result<Self, String> {
        let parent = registry.parent().ok_or("Registry has no parent")?;
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        #[cfg(any(windows, target_os = "macos"))]
        let canonical_parent = parent.canonicalize().map_err(|e| e.to_string())?;
        #[cfg(any(windows, target_os = "macos"))]
        let parent = canonical_parent.as_path();
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(parent.join("runtime-skills.lock"))
            .map_err(|e| e.to_string())?;
        lock.try_lock()
            .map_err(|_| "This registry already has a Core providing runtime skills".to_string())?;
        let resources = parent.join("runtime-skills");
        if resources.exists() {
            plain_directory(&resources)?;
        }
        std::fs::create_dir_all(&resources).map_err(|e| e.to_string())?;
        let root = resources;
        let skill = root.join("codlet");
        if skill.exists() && !owned_skill(&skill, registry) {
            return Err(
                "The runtime codlet skill directory is not owned by this Core registry".into(),
            );
        }
        for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_name().to_string_lossy().starts_with("core-")
                && plain_directory(&entry.path()).is_ok()
                && owned_skill(&entry.path().join("codlet"), registry)
            {
                crate::source_removal::remove_owned_directory(&entry.path())
                    .map_err(|e| e.to_string())?;
            }
        }
        // Build outside the published skill root. A process crash cannot expose
        // a partial codlet/SKILL.md or leave the stable directory unrecognizable.
        for entry in std::fs::read_dir(parent).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with(".codlet-skill-")
                && owned_skill(&entry.path(), registry)
            {
                crate::source_removal::remove_owned_directory(&entry.path())
                    .map_err(|e| e.to_string())?;
            }
        }
        let staging = tempfile::Builder::new()
            .prefix(".codlet-skill-")
            .tempdir_in(parent)
            .map_err(|e| e.to_string())?;
        let files = [
            (
                "agents/openai.yaml",
                include_str!("../runtime/skills/codlet/agents/openai.yaml"),
            ),
            (
                "assets/codlet.svg",
                include_str!("../runtime/skills/codlet/assets/codlet.svg"),
            ),
            (
                "references/overview.md",
                include_str!("../runtime/skills/codlet/references/overview.md"),
            ),
            (
                "references/management.md",
                include_str!("../runtime/skills/codlet/references/management.md"),
            ),
            (
                "references/creation.md",
                include_str!("../runtime/skills/codlet/references/creation.md"),
            ),
            (
                "SKILL.md",
                include_str!("../runtime/skills/codlet/SKILL.md"),
            ),
            (
                "references/plugin-api.md",
                include_str!("../runtime/skills/codlet/references/plugin-api.md"),
            ),
            (
                "references/official-ui.md",
                include_str!("../runtime/skills/codlet/references/official-ui.md"),
            ),
            (
                "scripts/codlet-cli.ps1",
                include_str!("../runtime/skills/codlet/scripts/codlet-cli.ps1"),
            ),
            (
                "scripts/codlet-cli.py",
                include_str!("../runtime/skills/codlet/scripts/codlet-cli.py"),
            ),
            (
                "scripts/plugin-release.mjs",
                include_str!("../scripts/plugin-release.mjs"),
            ),
            (
                "docs/spec/plugin-updates.md",
                include_str!("../docs/spec/plugin-updates.md"),
            ),
            (
                "schemas/plugin-updates.schema.json",
                include_str!("../schemas/plugin-updates.schema.json"),
            ),
            (
                "types/renderer.d.ts",
                include_str!("../types/renderer.d.ts"),
            ),
            (
                "types/renderer-ui.d.ts",
                include_str!("../types/renderer-ui.d.ts"),
            ),
            ("types/host.d.ts", include_str!("../types/host.d.ts")),
            (
                "types/core-services.d.ts",
                include_str!("../types/core-services.d.ts"),
            ),
            (
                "types/plugin-storage.d.ts",
                include_str!("../types/plugin-storage.d.ts"),
            ),
            (
                "types/core-resources.d.ts",
                include_str!("../types/core-resources.d.ts"),
            ),
            (
                "types/codex-desktop.d.ts",
                include_str!("../types/codex-desktop.d.ts"),
            ),
            ("types/codex.d.ts", include_str!("../types/codex.d.ts")),
            (
                "types/codex-ui.d.ts",
                include_str!("../types/codex-ui.d.ts"),
            ),
            (
                "types/codex-workspace.d.ts",
                include_str!("../types/codex-workspace.d.ts"),
            ),
            (
                "types/codex-permissions.d.ts",
                include_str!("../types/codex-permissions.d.ts"),
            ),
            (
                "types/codex-traffic.d.ts",
                include_str!("../types/codex-traffic.d.ts"),
            ),
            ("codex/README.md", include_str!("../codex/README.md")),
            (
                "docs/core-online-update.md",
                include_str!("../docs/core-online-update.md"),
            ),
            (
                "types/runtime-manage.d.ts",
                include_str!("../types/runtime-manage.d.ts"),
            ),
            (
                "docs/spec/plugin-format.md",
                include_str!("../docs/spec/plugin-format.md"),
            ),
            ("docs/spec/ui.md", include_str!("../docs/spec/ui.md")),
            ("docs/spec/codex.md", include_str!("../docs/spec/codex.md")),
            (
                "docs/spec/client-source.md",
                include_str!("../docs/spec/client-source.md"),
            ),
            (
                "docs/spec/management.md",
                include_str!("../docs/spec/management.md"),
            ),
            ("docs/spec/host.md", include_str!("../docs/spec/host.md")),
            ("docs/spec/rpc.md", include_str!("../docs/spec/rpc.md")),
            (
                "docs/spec/permissions.md",
                include_str!("../docs/spec/permissions.md"),
            ),
            (
                "docs/spec/traffic.md",
                include_str!("../docs/spec/traffic.md"),
            ),
            (
                "docs/spec/services.md",
                include_str!("../docs/spec/services.md"),
            ),
        ];
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        let lab = executable
            .file_stem()
            .is_some_and(|s| s.to_string_lossy().eq_ignore_ascii_case("codlet-lab"));
        let prefix = if lab {
            vec![
                "--experimental-isolated-client".to_string(),
                "--root".into(),
                parent
                    .parent()
                    .ok_or("Lab root missing")?
                    .to_string_lossy()
                    .into_owned(),
            ]
        } else {
            Vec::new()
        };
        let (script, interpreter) = if cfg!(target_os = "macos") {
            ("scripts/codlet-cli.py", "python3")
        } else {
            ("scripts/codlet-cli.ps1", "powershell")
        };
        let metadata = json!({"schema":1,"runtimeVersion":env!("CARGO_PKG_VERSION"),"environment":if lab{"test-client"}else{"desktop"},"cliCommands":if lab{vec!["plugin"]}else{vec!["plugin","doctor","status","diagnostics"]},"defaultPluginsDirectory":parent.join("packages"),"defaultPluginProjectsDirectory":parent.join("projects"),"registry":registry,"cliExecutable":executable,"cliPrefix":prefix,"cliLocalAppData":if lab{parent.parent()}else{None},"cliScript":skill.join(script),"cliInterpreter":interpreter,"typesDirectory":skill.join("types"),"docsDirectory":skill.join("docs")});
        std::fs::write(
            staging.path().join("runtime.json"),
            serde_json::to_vec_pretty(&metadata).unwrap(),
        )
        .map_err(|e| e.to_string())?;
        for (relative, body) in files {
            let target = staging.path().join(relative);
            std::fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
            std::fs::write(target, body).map_err(|e| e.to_string())?;
        }
        if skill.exists() {
            if !owned_skill(&skill, registry) {
                return Err("The runtime codlet skill directory changed during preparation".into());
            }
            crate::source_removal::remove_owned_directory(&skill).map_err(|e| e.to_string())?;
        }
        std::fs::rename(staging.path(), &skill).map_err(|e| e.to_string())?;
        let _ = staging.keep();
        let directory = SkillDirectory {
            #[cfg(any(windows, target_os = "macos"))]
            pinned: Some(
                crate::platform::directory::pin_directory(&skill, true)
                    .map_err(|e| e.to_string())?,
            ),
            #[cfg(not(any(windows, target_os = "macos")))]
            skill: skill.clone(),
            _lock: lock,
        };
        let config = json!({"root":root,"skillPath":skill.join("SKILL.md"),"binding":BINDING,"marker":MARKER});
        let script = format!("({BRIDGE})({config});");
        Ok(Self {
            _directory: directory,
            root,
            script,
            next: 0,
            authorities: BTreeMap::new(),
            bindings: BTreeMap::new(),
        })
    }
    pub(crate) fn descriptor(&self) -> Value {
        json!({"available":true,"name":"codlet","path":self.root.join("codlet/SKILL.md")})
    }
    pub(crate) fn install(&self, session: &TargetSession) -> Result<String, String> {
        session
            .request("Runtime.addBinding", Some(json!({"name":BINDING})))
            .map_err(|e| e.to_string())?;
        let result = session
            .request(
                "Page.addScriptToEvaluateOnNewDocument",
                Some(json!({"source":self.script})),
            )
            .map_err(|e| e.to_string())?;
        let id = result["identifier"]
            .as_str()
            .ok_or("Skill bootstrap has no identifier")?
            .to_string();
        session.evaluate(&self.script).map_err(|e| e.to_string())?;
        Ok(id)
    }
    pub(crate) fn observe_baseline(
        &mut self,
        target: &str,
        context: u64,
        client_id: &str,
        client_epoch: u64,
        fact: &Value,
    ) -> Value {
        let key = (
            target.to_owned(),
            context,
            client_id.to_owned(),
            client_epoch,
        );
        let Some(authority) = fact["authorityId"].as_str().filter(|id| !id.is_empty()) else {
            self.bindings.remove(&key);
            return json!({"error":"The Native skill root owner has not been observed","unobserved":true});
        };
        if fact["status"] == "retired" {
            self.authorities.remove(authority);
            self.bindings.retain(|_, id| id != authority);
            return json!({"error":"The Native skill root owner retired","unobserved":true});
        }
        if fact["status"] != "observed" && fact["status"] != "unknown" {
            self.bindings.remove(&key);
            return json!({"error":"The current Native skill root owner is unobserved","unobserved":true,"authorityId":authority});
        }
        self.bindings.insert(key, authority.to_owned());
        let state = self.authorities.entry(authority.to_owned()).or_default();
        if state.uncertain {
            return json!({"error":"Native skill root write outcome is unknown until its owner retires","unknown":true,"authorityId":authority});
        }
        if fact["status"] == "unknown" {
            if fact["reason"] == "root_write_pending" {
                return json!({"busy":true,"authorityId":authority});
            }
            state.uncertain = true;
            state.registered = false;
            return json!({"error":"Native skill root write outcome is unknown","unknown":true,"authorityId":authority});
        }
        let Some(roots) = fact["roots"].as_array().and_then(|roots| {
            roots
                .iter()
                .map(|root| root.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
        }) else {
            return json!({"error":"The Native skill root baseline is malformed","unobserved":true});
        };
        if let Some(pending) = state.pending.as_mut() {
            if pending.dispatched {
                let mut expected = pending.roots.clone();
                expected.push(self.root.to_string_lossy().into_owned());
                if roots != expected {
                    pending.unknown = true;
                    state.uncertain = true;
                    state.registered = false;
                    return json!({"error":"The observed Native roots changed during the pending write","unknown":true,"authorityId":authority});
                }
                pending.confirmed = true;
            } else if state.revision != fact["revision"] {
                state.pending = None;
            }
        }
        if state.pending.is_none() {
            state.registered = roots.iter().any(|root| Path::new(root) == self.root);
            state.roots = roots
                .into_iter()
                .filter(|root| Path::new(root) != self.root)
                .collect();
            state.baseline_known = true;
            state.revision = fact["revision"].clone();
        }
        json!({"observed":true,"authorityId":authority,"revision":state.revision})
    }
    pub(crate) fn invoke(&mut self, target: &str, context: u64, input: &Value) -> Value {
        if input["action"] == "failed" {
            let message: String = input["message"]
                .as_str()
                .unwrap_or("Runtime skill registration failed")
                .chars()
                .take(1000)
                .collect();
            crate::runtime_log::error("runtime_skill_unavailable", &message);
            return json!({"reported":true});
        }
        let Some((client_id, client_epoch)) = input["clientId"]
            .as_str()
            .zip(input["clientEpoch"].as_u64())
        else {
            return json!({"error":"The Native skill request client has not been observed","unobserved":true});
        };
        let key = (
            target.to_owned(),
            context,
            client_id.to_owned(),
            client_epoch,
        );
        let Some(id) = self.bindings.get(&key) else {
            return json!({"error":"The Native skill root owner has not been observed","unobserved":true});
        };
        if input
            .get("authorityId")
            .is_some_and(|value| value.as_str() != Some(id))
        {
            return json!({"error":"The Native skill root owner changed","unobserved":true});
        }
        let Some(state) = self.authorities.get_mut(id) else {
            return json!({"error":"The Native skill root owner retired","unobserved":true});
        };
        state.invoke(&self.root, &mut self.next, &key, input)
    }
    pub(crate) fn retire(&mut self, target: &str) {
        for state in self.authorities.values_mut() {
            if state
                .pending
                .as_ref()
                .is_some_and(|p| p.target == target && !p.dispatched)
            {
                state.pending = None;
            } else if let Some(pending) = state.pending.as_mut().filter(|p| p.target == target) {
                pending.unknown = true;
                state.uncertain = true;
                state.registered = false;
            }
        }
        self.bindings.retain(|owner, _| owner.0 != target);
        self.authorities.retain(|id, state| {
            state.pending.is_some()
                || state.uncertain
                || self.bindings.values().any(|bound| bound == id)
        });
    }
    pub(crate) fn shutdown_script(&self) -> String {
        let plans = self.bindings.iter().map(|(owner, id)| {
            let state = &self.authorities[id];
            json!({"target":owner.0,"clientId":owner.2,"clientEpoch":owner.3,"authorityId":id,"roots":if state.pending.is_none() && !state.uncertain && state.baseline_known { Some(&state.roots) } else { None }})
        }).collect::<Vec<_>>();
        format!(
            "(async()=>{{const bridge=globalThis[Symbol.for({})];if(!bridge)return{{api:1,status:'absent',reason:null,pendingNativeWrites:0}};const plan={}.find(plan=>plan.clientId===bridge.clientId&&plan.clientEpoch===bridge.clientEpoch&&plan.authorityId===bridge.authorityId);return bridge.dispose(Array.isArray(plan?.roots)?plan.roots:undefined);}})()",
            json!(MARKER),
            json!(plans)
        )
    }
}
impl RootAuthority {
    fn invoke(&mut self, root: &Path, next: &mut u64, owner: &Owner, input: &Value) -> Value {
        let (target, context, client_id, client_epoch) = owner;
        let fail = |message: &str| json!({"error":message});
        match input["action"].as_str() {
            Some("failed") => {
                let message: String = input["message"]
                    .as_str()
                    .unwrap_or("Runtime skill registration failed")
                    .chars()
                    .take(1000)
                    .collect();
                crate::runtime_log::error("runtime_skill_unavailable", &message);
                json!({"reported":true})
            }
            Some("ensure" | "set") => {
                if self.uncertain {
                    return json!({"error":"Native skill root write outcome is unknown until this Core runtime retires","unknown":true});
                }
                if self.pending.is_some() {
                    return json!({"busy":true});
                }
                if input["action"] == "ensure" && !self.baseline_known {
                    return json!({"error":"The current Native extra skill roots have not been observed","unobserved":true});
                }
                if input["action"] == "ensure" && self.registered {
                    return json!({"ready":true});
                }
                let roots = if input["action"] == "set" {
                    let Some(values) = input["roots"].as_array() else {
                        return fail("Invalid extra skill roots");
                    };
                    let mut roots = Vec::new();
                    for value in values {
                        let Some(path) = value
                            .as_str()
                            .filter(|s| !s.contains('\0') && Path::new(s).is_absolute())
                        else {
                            return fail("Invalid extra skill root");
                        };
                        if Path::new(path) != root && !roots.iter().any(|r| r == path) {
                            roots.push(path.to_string());
                        }
                    }
                    roots
                } else {
                    self.roots.clone()
                };
                let Some(ticket) = next.checked_add(1).filter(|n| *n <= 9_007_199_254_740_991)
                else {
                    return fail("Skill root ticket identity exhausted");
                };
                *next = ticket;
                let mut merged = roots.clone();
                merged.push(root.to_string_lossy().into_owned());
                self.pending = Some(Pending {
                    ticket,
                    target: target.clone(),
                    context: *context,
                    roots,
                    unknown: false,
                    dispatched: false,
                    confirmed: false,
                    client_id: client_id.clone(),
                    client_epoch: *client_epoch,
                });
                json!({"ticket":ticket,"roots":merged})
            }
            Some("dispatch" | "complete") => {
                let Some(pending) = self.pending.as_mut().filter(|p| {
                    p.ticket == input["ticket"].as_u64().unwrap_or(0)
                        && &p.target == target
                        && p.context == *context
                        && &p.client_id == client_id
                        && p.client_epoch == *client_epoch
                }) else {
                    return fail("Retired skill root lease");
                };
                if input["action"] == "dispatch" {
                    if pending.unknown || self.uncertain {
                        return json!({"error":"Native skill root write outcome is unknown","unknown":true});
                    }
                    pending.dispatched = true;
                    return json!({"admitted":true});
                }
                if input["unknown"] == true {
                    pending.unknown = true;
                    self.uncertain = true;
                    self.registered = false;
                    return json!({"ready":false,"unknown":true});
                }
                if pending.unknown || self.uncertain {
                    return json!({"error":"Native skill root write outcome is unknown","unknown":true});
                }
                if input["ok"] == true && !pending.dispatched {
                    return fail("Skill root write was not admitted");
                }
                if input["ok"] == true && !pending.confirmed {
                    return fail("The Native skill root write has no matching observed receipt");
                }
                if input["ok"] == true {
                    self.roots = pending.roots.clone();
                    self.registered = true;
                    self.baseline_known = true;
                    crate::runtime_log::info(
                        "runtime_skill_ready",
                        "Codlet skill registered with the local App Server",
                    );
                } else {
                    self.registered = false;
                }
                self.pending = None;
                json!({"ready":self.registered})
            }
            Some("invalidate") => {
                self.registered = false;
                json!({"ready":false})
            }
            Some("unknown") => {
                self.uncertain = true;
                self.registered = false;
                if let Some(pending) = &mut self.pending {
                    pending.unknown = true;
                }
                json!({"ready":false,"unknown":true})
            }
            _ => fail("Unknown runtime skill action"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn invoke(skill: &mut RuntimeSkills, target: &str, context: u64, input: &Value) -> Value {
        let mut input = input.clone();
        input["clientId"] = json!(target);
        input["clientEpoch"] = json!(0);
        skill.invoke(target, context, &input)
    }
    fn observed(
        skill: &mut RuntimeSkills,
        target: &str,
        context: u64,
        authority: &str,
        roots: Value,
    ) -> Value {
        skill.observe_baseline(target, context, target, 0, &json!({"status":"observed","authorityId":authority,"revision":"fixture","roots":roots,"provenance":"confirmed"}))
    }
    #[test]
    fn interrupted_skill_preparation_does_not_publish_partial_files_or_block_the_next_start() {
        let temp = tempfile::tempdir().unwrap();
        let registry = temp.path().join("config.json");
        let previous = RuntimeSkills::prepare(&registry).unwrap();
        let metadata = std::fs::read(previous.root.join("codlet/runtime.json")).unwrap();
        let root = previous.root.clone();
        drop(previous);
        let staging = temp.path().join(".codlet-skill-interrupted");
        std::fs::create_dir(&staging).unwrap();
        std::fs::write(staging.join("runtime.json"), metadata).unwrap();
        std::fs::write(staging.join("SKILL.md"), "partial").unwrap();
        assert!(!root.join("codlet/SKILL.md").exists());
        let foreign = temp.path().join(".codlet-skill-user");
        std::fs::create_dir(&foreign).unwrap();
        std::fs::write(foreign.join("notes.txt"), "keep this").unwrap();
        let restored = RuntimeSkills::prepare(&registry).unwrap();
        assert!(!staging.exists());
        assert_eq!(
            std::fs::read_to_string(foreign.join("notes.txt")).unwrap(),
            "keep this"
        );
        assert!(restored.root.join("codlet/types/renderer.d.ts").is_file());
        assert_ne!(
            std::fs::read_to_string(restored.root.join("codlet/SKILL.md")).unwrap(),
            "partial"
        );
        let metadata: Value = serde_json::from_slice(
            &std::fs::read(restored.root.join("codlet/runtime.json")).unwrap(),
        )
        .unwrap();
        assert!(!metadata.to_string().contains(".codlet-skill-"));
    }
    #[test]
    fn unowned_skill_directory_survives_a_failed_prepare() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("runtime-skills/codlet");
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("SKILL.md"), "user-owned").unwrap();
        assert!(RuntimeSkills::prepare(&temp.path().join("config.json")).is_err());
        assert_eq!(
            std::fs::read_to_string(path.join("SKILL.md")).unwrap(),
            "user-owned"
        );
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn shutdown_preserves_a_replacement_skill_directory() {
        let temp = tempfile::tempdir().unwrap();
        let skill = RuntimeSkills::prepare(&temp.path().join("config.json")).unwrap();
        let path = skill.root.join("codlet");
        let moved = skill.root.join("moved");
        std::fs::rename(&path, &moved).unwrap();
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("SKILL.md"), "replacement").unwrap();
        drop(skill);
        assert_eq!(
            std::fs::read_to_string(path.join("SKILL.md")).unwrap(),
            "replacement"
        );
        assert!(moved.join("SKILL.md").is_file());
    }
    #[test]
    fn runtime_roots_are_serialized_across_windows_and_preserve_other_skills() {
        let temp = tempfile::tempdir().unwrap();
        let mut skill = RuntimeSkills::prepare(&temp.path().join("config.json")).unwrap();
        let root = skill.root.to_string_lossy().into_owned();
        assert_eq!(
            invoke(&mut skill, "window-a", 7, &json!({"action":"ensure"}))["unobserved"],
            true
        );
        observed(&mut skill, "window-a", 7, "native", json!([]));
        observed(&mut skill, "window-b", 8, "native", json!([]));
        let a = invoke(
            &mut skill,
            "window-a",
            7,
            &json!({"action":"set","roots":[]}),
        );
        assert_eq!(a["roots"], json!([root]));
        assert_eq!(
            invoke(&mut skill, "window-b", 8, &json!({"action":"ensure"}))["busy"],
            true
        );
        assert!(
            invoke(
                &mut skill,
                "window-b",
                8,
                &json!({"action":"complete","ticket":a["ticket"],"ok":true})
            )["error"]
                .is_string()
        );
        invoke(
            &mut skill,
            "window-a",
            7,
            &json!({"action":"dispatch","ticket":a["ticket"]}),
        );
        observed(&mut skill, "window-a", 7, "native", a["roots"].clone());
        invoke(
            &mut skill,
            "window-a",
            7,
            &json!({"action":"complete","ticket":a["ticket"],"ok":true}),
        );
        assert_eq!(
            invoke(&mut skill, "window-b", 8, &json!({"action":"ensure"}))["ready"],
            true
        );
        let other = temp.path().join("other-skills");
        let change = invoke(
            &mut skill,
            "window-b",
            8,
            &json!({"action":"set","roots":[other,root]}),
        );
        assert_eq!(change["roots"], json!([other, root]));
        invoke(
            &mut skill,
            "window-b",
            8,
            &json!({"action":"dispatch","ticket":change["ticket"]}),
        );
        observed(&mut skill, "window-b", 8, "native", change["roots"].clone());
        invoke(
            &mut skill,
            "window-b",
            8,
            &json!({"action":"complete","ticket":change["ticket"],"ok":true}),
        );
        invoke(&mut skill, "window-a", 7, &json!({"action":"invalidate"}));
        let restored = invoke(&mut skill, "window-a", 7, &json!({"action":"ensure"}));
        assert_eq!(restored["roots"], json!([other, root]));
        invoke(
            &mut skill,
            "window-a",
            7,
            &json!({"action":"dispatch","ticket":restored["ticket"]}),
        );
        skill.retire("window-a");
        assert!(
            skill.authorities["native"]
                .pending
                .as_ref()
                .unwrap()
                .unknown
        );
        assert_eq!(
            invoke(&mut skill, "window-b", 8, &json!({"action":"ensure"}))["unknown"],
            true
        );
        assert_eq!(
            skill.authorities["native"].roots,
            vec![other.to_string_lossy().into_owned()]
        );
        assert!(!skill.shutdown_script().contains("other-skills"));
    }
    #[test]
    fn native_extra_roots_are_not_limited_by_a_core_plugin_quota() {
        let temp = tempfile::tempdir().unwrap();
        let mut skill = RuntimeSkills::prepare(&temp.path().join("config.json")).unwrap();
        let roots: Vec<_> = (0..64)
            .map(|index| temp.path().join(format!("skills-{index}")))
            .collect();
        observed(&mut skill, "window", 7, "native", json!([]));
        let lease = invoke(
            &mut skill,
            "window",
            7,
            &json!({"action":"set","roots":roots}),
        );
        assert_eq!(lease["roots"].as_array().unwrap().len(), 65);
        assert_eq!(
            &lease["roots"].as_array().unwrap()[..64],
            json!(roots).as_array().unwrap()
        );
    }
    #[test]
    fn actual_native_authorities_have_independent_roots_and_prepared_retirement_never_commits() {
        let temp = tempfile::tempdir().unwrap();
        let mut skill = RuntimeSkills::prepare(&temp.path().join("config.json")).unwrap();
        let other = temp.path().join("existing");
        observed(&mut skill, "one", 1, "child-one", json!([other]));
        observed(&mut skill, "two", 2, "child-two", json!([]));
        let one = invoke(&mut skill, "one", 1, &json!({"action":"ensure"}));
        let two = invoke(&mut skill, "two", 2, &json!({"action":"ensure"}));
        assert_eq!(one["roots"].as_array().unwrap().len(), 2);
        assert_eq!(two["roots"].as_array().unwrap().len(), 1);
        skill.retire("one");
        assert!(!skill.authorities.contains_key("child-one"));
        assert!(
            !skill.authorities["child-two"]
                .pending
                .as_ref()
                .unwrap()
                .dispatched
        );
        assert!(
            invoke(
                &mut skill,
                "two",
                2,
                &json!({"action":"complete","ticket":two["ticket"],"ok":true})
            )["error"]
                .is_string()
        );
    }
    #[test]
    fn a_skill_write_requires_the_observed_native_receipt_and_different_roots_stay_unknown() {
        let temp = tempfile::tempdir().unwrap();
        let mut skill = RuntimeSkills::prepare(&temp.path().join("config.json")).unwrap();
        observed(&mut skill, "one", 1, "child", json!([]));
        let lease = invoke(&mut skill, "one", 1, &json!({"action":"ensure"}));
        invoke(
            &mut skill,
            "one",
            1,
            &json!({"action":"dispatch","ticket":lease["ticket"]}),
        );
        assert!(
            invoke(
                &mut skill,
                "one",
                1,
                &json!({"action":"complete","ticket":lease["ticket"],"ok":true})
            )["error"]
                .is_string()
        );
        let reply = observed(
            &mut skill,
            "one",
            1,
            "child",
            json!([temp.path().join("later-user-roots")]),
        );
        assert_eq!(reply["unknown"], true);
        skill.retire("one");
        observed(&mut skill, "two", 2, "child", lease["roots"].clone());
        assert_eq!(
            invoke(&mut skill, "two", 2, &json!({"action":"ensure"}))["unknown"],
            true
        );
        skill.observe_baseline(
            "two",
            2,
            "two",
            0,
            &json!({"status":"retired","authorityId":"child"}),
        );
        assert!(!skill.authorities.contains_key("child"));
    }
    #[test]
    fn skill_resources_live_only_in_the_core_owned_directory_and_include_scoped_authoring_paths() {
        let temp = tempfile::tempdir().unwrap();
        let registry = temp.path().join("config.json");
        let skill = RuntimeSkills::prepare(&registry).unwrap();
        let root = skill.root.clone();
        let data: Value =
            serde_json::from_slice(&std::fs::read(root.join("codlet/runtime.json")).unwrap())
                .unwrap();
        assert_eq!(
            data["defaultPluginsDirectory"],
            json!(root.parent().unwrap().join("packages"))
        );
        assert_eq!(
            data["defaultPluginProjectsDirectory"],
            json!(root.parent().unwrap().join("projects"))
        );
        assert!(!root.parent().unwrap().join("projects").exists());
        assert!(root.join("codlet/types/renderer.d.ts").is_file());
        assert_eq!(
            skill.descriptor()["path"],
            json!(root.join("codlet/SKILL.md"))
        );
        for resource in [
            "agents/openai.yaml",
            "assets/codlet.svg",
            "references/management.md",
            "references/overview.md",
            "references/creation.md",
            "docs/spec/plugin-format.md",
            "docs/spec/host.md",
            "docs/spec/rpc.md",
            "docs/spec/permissions.md",
            "docs/spec/services.md",
            "docs/spec/ui.md",
            "docs/spec/management.md",
            "docs/spec/traffic.md",
        ] {
            let path = root.join("codlet").join(resource);
            assert!(path.is_file(), "{resource}");
            if resource.ends_with(".md") {
                let body = std::fs::read_to_string(&path).unwrap();
                for link in body.split("](").skip(1) {
                    let target = link.split(')').next().unwrap().split('#').next().unwrap();
                    if target.is_empty()
                        || target.starts_with("https://")
                        || target.starts_with("http://")
                    {
                        continue;
                    }
                    assert!(
                        path.parent().unwrap().join(target).is_file(),
                        "runtime skill link does not resolve: {resource} -> {target}"
                    );
                }
            }
        }
        assert!(
            data["cliCommands"]
                .as_array()
                .unwrap()
                .contains(&json!("plugin"))
        );
        let old = root.join("core-legacy/codlet");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::copy(root.join("codlet/runtime.json"), old.join("runtime.json")).unwrap();
        let unrelated = root.join("core-user/codlet");
        std::fs::create_dir_all(&unrelated).unwrap();
        std::fs::write(unrelated.join("SKILL.md"), "not generated by Core").unwrap();
        assert!(!registry.exists());
        assert!(!temp.path().join("skills").exists());
        drop(skill);
        assert!(!root.join("codlet").exists());
        let again = RuntimeSkills::prepare(&registry).unwrap();
        assert_eq!(again.root, root);
        assert!(!old.exists());
        assert!(unrelated.join("SKILL.md").exists());
        assert!(
            RuntimeSkills::prepare(&registry).is_err(),
            "a second Core must not overwrite live skill resources"
        );
    }
}
