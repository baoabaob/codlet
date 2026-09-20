//! Core-owned skill resources and a serialized, runtime-only extra-root lease.
//! Native integration uses its existing local App Server connection, independently
//! of all optional plugins. User/project skill directories are never modified.
use crate::cdp::TargetSession;
use serde_json::{Value, json};
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
}

pub(crate) struct RuntimeSkills {
    _directory: SkillDirectory,
    root: PathBuf,
    script: String,
    roots: Vec<String>,
    registered: bool,
    next: u64,
    pending: Option<Pending>,
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
            (
                "types/runtime-manage.d.ts",
                include_str!("../types/runtime-manage.d.ts"),
            ),
            (
                "docs/LOCAL_PLUGINS.md",
                include_str!("../docs/LOCAL_PLUGINS.md"),
            ),
            (
                "docs/UI_COMPONENTS_2026-09-13.md",
                include_str!("../docs/UI_COMPONENTS_2026-09-13.md"),
            ),
            (
                "docs/OFFICIAL_UI_STYLE_2026-09-13.md",
                include_str!("../docs/OFFICIAL_UI_STYLE_2026-09-13.md"),
            ),
            (
                "docs/DESKTOP_ADAPTER_DEVELOPMENT_2026-09-10.md",
                include_str!("../docs/DESKTOP_ADAPTER_DEVELOPMENT_2026-09-10.md"),
            ),
            (
                "docs/CORE_RPC_2026-09-10.md",
                include_str!("../docs/CORE_RPC_2026-09-10.md"),
            ),
            (
                "docs/OS_BROKER_2026-09-10.md",
                include_str!("../docs/OS_BROKER_2026-09-10.md"),
            ),
            (
                "docs/TRAFFIC_CHANNELS.md",
                include_str!("../docs/TRAFFIC_CHANNELS.md"),
            ),
            (
                "docs/CORE_SERVICES.md",
                include_str!("../docs/CORE_SERVICES.md"),
            ),
            (
                "docs/JS_PLUGIN_RUNTIME_2026-09-09.md",
                include_str!("../docs/JS_PLUGIN_RUNTIME_2026-09-09.md"),
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
        let metadata = json!({"schema":1,"runtimeVersion":env!("CARGO_PKG_VERSION"),"environment":if lab{"test-client"}else{"desktop"},"cliCommands":if lab{vec!["plugin"]}else{vec!["plugin","doctor","status","diagnostics"]},"defaultPluginsDirectory":parent.join("packages"),"registry":registry,"cliExecutable":executable,"cliPrefix":prefix,"cliLocalAppData":if lab{parent.parent()}else{None},"cliScript":skill.join(script),"cliInterpreter":interpreter,"typesDirectory":skill.join("types"),"docsDirectory":skill.join("docs")});
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
        let catalog: Value =
            serde_json::from_str(include_str!("../compatibility/client-profiles.json"))
                .expect("checked-in client profiles are valid");
        let profiles = catalog["builds"].as_array().unwrap().iter()
            .filter(|profile| profile["runtimeSkill"] == true)
            .map(|profile| json!({"appVersion":profile["appVersion"],"buildNumber":profile["buildNumber"],"appServerVersion":profile["appServerVersion"],"module":profile["module"],"entry":profile["entry"],"exports":{"scope":profile["exports"]["scope"],"client":profile["exports"]["client"]}}))
            .collect::<Vec<_>>();
        let config = json!({"root":root,"skillPath":skill.join("SKILL.md"),"binding":BINDING,"marker":MARKER,"profiles":profiles});
        let script = format!("({BRIDGE})({config});");
        Ok(Self {
            _directory: directory,
            root,
            script,
            roots: Vec::new(),
            registered: false,
            next: 0,
            pending: None,
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
    pub(crate) fn invoke(&mut self, target: &str, context: u64, input: &Value) -> Value {
        let fail = |message: &str| json!({"error":message});
        match input["action"].as_str() {
            Some("ensure" | "set") => {
                if self.pending.is_some() {
                    return json!({"busy":true});
                }
                if input["action"] == "ensure" && self.registered {
                    return json!({"ready":true});
                }
                let roots = if input["action"] == "set" {
                    let Some(values) = input["roots"].as_array().filter(|v| v.len() <= 32) else {
                        return fail("Invalid extra skill roots");
                    };
                    let mut roots = Vec::new();
                    for value in values {
                        let Some(path) = value.as_str().filter(|s| {
                            s.len() < 8192 && !s.contains('\0') && Path::new(s).is_absolute()
                        }) else {
                            return fail("Invalid extra skill root");
                        };
                        if Path::new(path) != self.root && !roots.iter().any(|r| r == path) {
                            roots.push(path.to_string());
                        }
                    }
                    roots
                } else {
                    self.roots.clone()
                };
                self.next += 1;
                let ticket = self.next;
                let mut merged = roots.clone();
                merged.push(self.root.to_string_lossy().into_owned());
                self.pending = Some(Pending {
                    ticket,
                    target: target.into(),
                    context,
                    roots,
                });
                json!({"ticket":ticket,"roots":merged})
            }
            Some("complete") => {
                let Some(pending) = self.pending.as_ref().filter(|p| {
                    p.ticket == input["ticket"].as_u64().unwrap_or(0)
                        && p.target == target
                        && p.context == context
                }) else {
                    return fail("Retired skill root lease");
                };
                if input["ok"] == true {
                    self.roots = pending.roots.clone();
                    self.registered = true;
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
            _ => fail("Unknown runtime skill action"),
        }
    }
    pub(crate) fn retire(&mut self, target: &str) {
        if self.pending.as_ref().is_some_and(|p| p.target == target) {
            let pending = self.pending.take().unwrap();
            self.roots = pending.roots;
            self.registered = false;
        }
    }
    pub(crate) fn shutdown_script(&self) -> String {
        format!(
            "globalThis[Symbol.for({})]?.dispose({})",
            json!(MARKER),
            json!(self.roots)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        let a = skill.invoke("window-a", 7, &json!({"action":"ensure"}));
        assert_eq!(a["roots"], json!([root]));
        assert_eq!(
            skill.invoke("window-b", 8, &json!({"action":"ensure"}))["busy"],
            true
        );
        assert!(
            skill.invoke(
                "window-b",
                8,
                &json!({"action":"complete","ticket":a["ticket"],"ok":true})
            )["error"]
                .is_string()
        );
        skill.invoke(
            "window-a",
            7,
            &json!({"action":"complete","ticket":a["ticket"],"ok":true}),
        );
        assert_eq!(
            skill.invoke("window-b", 8, &json!({"action":"ensure"}))["ready"],
            true
        );
        let other = temp.path().join("other-skills");
        let change = skill.invoke("window-b", 8, &json!({"action":"set","roots":[other,root]}));
        assert_eq!(change["roots"], json!([other, root]));
        skill.invoke(
            "window-b",
            8,
            &json!({"action":"complete","ticket":change["ticket"],"ok":true}),
        );
        skill.invoke("window-a", 7, &json!({"action":"invalidate"}));
        let restored = skill.invoke("window-a", 7, &json!({"action":"ensure"}));
        assert_eq!(restored["roots"], json!([other, root]));
        skill.retire("window-a");
        assert!(skill.pending.is_none());
        assert_eq!(skill.roots, vec![other.to_string_lossy().into_owned()]);
        assert!(skill.shutdown_script().contains("other-skills"));
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
        ] {
            assert!(root.join("codlet").join(resource).is_file(), "{resource}");
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
