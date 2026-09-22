use std::fs;
use std::path::{Path, PathBuf};

use codlet::local_plugins::{
    LocalPluginError, MAX_MANIFEST_BYTES, MAX_SOURCE_BYTES, inspect_local_plugin,
    load_local_plugin, validate_grants,
};
use codlet::plugins::{Permission, PluginManifest};
use serde_json::{Value, json};
use tempfile::{TempDir, tempdir};

const SOURCE: &str = "module.exports = { activate() {}, deactivate() {} };\n";

fn manifest() -> Value {
    json!({
        "schema": 1,
        "id": "dev.local",
        "version": "1.0.0",
        "renderer": { "entry": "dist/renderer.js", "world": "isolated" },
        "permissions": ["ui.dom"],
        "provides": [{ "name": "dev.local.service", "api": 2, "scope": "runtime" }],
        "requires": [{ "name": "codlet.runtime.ping", "api": 1, "scope": "target" }]
    })
}

struct Fixture {
    _directory: TempDir,
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempdir().unwrap();
        let root = directory
            .path()
            .join("\u{672c}\u{5730}\u{63d2}\u{4ef6} with spaces");
        fs::create_dir_all(root.join("dist")).unwrap();
        let fixture = Self {
            _directory: directory,
            root,
        };
        fixture.write_manifest(&manifest());
        fs::write(fixture.entry(), SOURCE).unwrap();
        fixture
    }

    fn write_manifest(&self, manifest: &Value) {
        fs::write(
            self.root.join("codlet.json"),
            serde_json::to_vec(manifest).unwrap(),
        )
        .unwrap();
    }

    fn entry(&self) -> PathBuf {
        self.root.join("dist/renderer.js")
    }
}

fn rejected(root: &Path, stage: &str, reason: &str) -> LocalPluginError {
    let error = inspect_local_plugin(root).unwrap_err();
    assert_rejection(&error, stage, reason);
    error
}

fn assert_rejection(error: &LocalPluginError, stage: &str, reason: &str) {
    let LocalPluginError::Rejected {
        stage: actual_stage,
        reason: actual_reason,
        ..
    } = error
    else {
        panic!("expected rejection, got {error:?}");
    };
    assert_eq!(*actual_stage, stage);
    assert!(actual_reason.contains(reason), "{error}");
}

#[test]
fn valid_unicode_and_space_root_returns_canonical_root_and_unchanged_source() {
    let fixture = Fixture::new();
    let candidate = inspect_local_plugin(&fixture.root).unwrap();
    assert_eq!(candidate.root, fs::canonicalize(&fixture.root).unwrap());
    assert!(candidate.root.is_absolute());
    assert_eq!(candidate.source, Some(SOURCE.to_owned().into()));
    assert_eq!(candidate.manifest.id, "dev.local");
    assert_eq!(candidate.manifest.provides[0].api.get(), 2);
    candidate.validate_grants(&[Permission::UiDom]).unwrap();
    let loaded = load_local_plugin("dev.local", &candidate.root, &[Permission::UiDom], 7).unwrap();
    assert_eq!(loaded.generation, 7);
    assert_eq!(loaded.manifest, candidate.manifest);
    assert_eq!(loaded.source, Some(SOURCE.to_owned().into()));
}

#[test]
fn relative_root_is_resolved_without_changing_current_directory() {
    let directory = tempfile::tempdir_in(".").unwrap();
    fs::create_dir(directory.path().join("dist")).unwrap();
    fs::write(directory.path().join("codlet.json"), manifest().to_string()).unwrap();
    fs::write(directory.path().join("dist/renderer.js"), SOURCE).unwrap();
    let relative = Path::new(".").join(directory.path().file_name().unwrap());
    assert!(relative.is_relative());
    assert_eq!(
        inspect_local_plugin(&relative).unwrap().root,
        fs::canonicalize(directory.path()).unwrap()
    );
}

#[cfg(windows)]
#[test]
fn non_unicode_windows_root_is_rejected_before_filesystem_lookup() {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    let root = PathBuf::from(OsString::from_wide(&[0xd800]));
    rejected(&root, "root path validation", "Unicode");
}

#[test]
fn unavailable_roots_and_files_have_path_and_stage_without_creation() {
    let fixture = Fixture::new();
    let missing = fixture.root.join("missing");
    let error = inspect_local_plugin(&missing).unwrap_err();
    assert!(matches!(
        error,
        LocalPluginError::Io {
            stage: "resolve root",
            ..
        }
    ));
    assert!(error.to_string().contains("missing"));
    assert!(!missing.exists());
    rejected(&fixture.entry(), "inspect root", "directory");

    fs::remove_file(fixture.root.join("codlet.json")).unwrap();
    let error = inspect_local_plugin(&fixture.root).unwrap_err();
    assert!(matches!(
        error,
        LocalPluginError::Io {
            stage: "read manifest",
            ..
        }
    ));
    assert!(error.to_string().contains("codlet.json"));
    fixture.write_manifest(&manifest());
    fs::remove_file(fixture.entry()).unwrap();
    let error = inspect_local_plugin(&fixture.root).unwrap_err();
    assert!(matches!(
        error,
        LocalPluginError::Io {
            stage: "read renderer entry",
            ..
        }
    ));
    assert!(error.to_string().contains("renderer.js"));
    assert!(!fixture.entry().exists());
}

#[test]
fn directories_cannot_be_read_as_manifest_or_source() {
    let fixture = Fixture::new();
    fs::remove_file(fixture.root.join("codlet.json")).unwrap();
    fs::create_dir(fixture.root.join("codlet.json")).unwrap();
    rejected(&fixture.root, "read manifest", "ordinary file");
    fs::remove_dir(fixture.root.join("codlet.json")).unwrap();
    fixture.write_manifest(&manifest());
    fs::remove_file(fixture.entry()).unwrap();
    fs::create_dir(fixture.entry()).unwrap();
    rejected(&fixture.root, "read renderer entry", "ordinary file");
}

#[test]
fn intermediate_entry_components_must_be_directories() {
    let fixture = Fixture::new();
    let mut value = manifest();
    value["renderer"]["entry"] = json!("codlet.json/renderer.js");
    fixture.write_manifest(&value);
    rejected(&fixture.root, "read renderer entry", "ordinary directory");
}

#[test]
fn manifest_uses_existing_strict_schema_id_and_capability_parser() {
    let fixture = Fixture::new();
    let mutations = [
        ("/schema", json!(2)),
        ("/id", json!("Bad Id")),
        ("/version", json!("")),
        ("/renderer/world", json!("unsupported")),
        ("/permissions", json!(["unknown.permission"])),
        ("/provides/0/name", json!("bad capability")),
        ("/provides/0/api", json!(0)),
        ("/provides/0/scope", json!("unknown")),
        ("/requires", json!(["legacy.string"])),
        (
            "/requires/0",
            json!({"name":"dev.capability", "api":1,"scope":"target","extra":0}),
        ),
        (
            "/renderer",
            json!({"entry":"dist/renderer.js","world":"isolated","extra":0}),
        ),
    ];
    for (pointer, replacement) in mutations {
        let mut value = manifest();
        *value.pointer_mut(pointer).unwrap() = replacement;
        fixture.write_manifest(&value);
        rejected(&fixture.root, "parse manifest", "");
    }
    let mut value = manifest();
    value["extra"] = json!(true);
    fixture.write_manifest(&value);
    rejected(&fixture.root, "parse manifest", "unknown field");
    for json in ["{", "", r#"{"schema":1,"schema":1}"#] {
        fs::write(fixture.root.join("codlet.json"), json).unwrap();
        rejected(&fixture.root, "parse manifest", "");
    }
}

#[test]
fn capability_scopes_are_not_reimplemented_by_the_loader() {
    let fixture = Fixture::new();
    for scope in ["runtime", "target", "backend-session", "thread"] {
        let mut value = manifest();
        value["provides"][0]["scope"] = json!(scope);
        fixture.write_manifest(&value);
        inspect_local_plugin(&fixture.root).unwrap();
    }
}

#[test]
fn manifest_and_source_enforce_byte_limits_including_exact_boundary() {
    let fixture = Fixture::new();
    let mut json = serde_json::to_vec(&manifest()).unwrap();
    json.resize(MAX_MANIFEST_BYTES, b' ');
    fs::write(fixture.root.join("codlet.json"), &json).unwrap();
    inspect_local_plugin(&fixture.root).unwrap();
    json.push(b' ');
    fs::write(fixture.root.join("codlet.json"), json).unwrap();
    rejected(&fixture.root, "read manifest", "131072-byte limit");

    fixture.write_manifest(&manifest());
    let mut source = SOURCE.as_bytes().to_vec();
    source.resize(MAX_SOURCE_BYTES, b' ');
    fs::write(fixture.entry(), &source).unwrap();
    assert_eq!(
        inspect_local_plugin(&fixture.root)
            .unwrap()
            .source
            .unwrap()
            .len(),
        MAX_SOURCE_BYTES
    );
    source.push(b' ');
    fs::write(fixture.entry(), source).unwrap();
    rejected(&fixture.root, "read renderer entry", "1048576-byte limit");
}

#[test]
fn multibyte_utf8_limits_are_measured_in_bytes() {
    let fixture = Fixture::new();
    let mut source = "\u{754c}".repeat(MAX_SOURCE_BYTES / 3);
    source.push('x');
    assert_eq!(source.len(), MAX_SOURCE_BYTES);
    fs::write(fixture.entry(), &source).unwrap();
    assert_eq!(
        inspect_local_plugin(&fixture.root).unwrap().source,
        Some(source.to_owned().into())
    );
    source.push('x');
    fs::write(fixture.entry(), source).unwrap();
    rejected(&fixture.root, "read renderer entry", "byte limit");
}

#[test]
fn bounded_sources_leave_room_for_json_encoded_cdp_frames() {
    // Source escaping can double quotes/backslashes; bounding before JSON parsing
    // also prevents small-looking manifests with unbounded capability metadata.
    let fixture = Fixture::new();
    let source = "\\".repeat(MAX_SOURCE_BYTES);
    fs::write(fixture.entry(), &source).unwrap();
    let candidate = inspect_local_plugin(&fixture.root).unwrap();
    let frame = serde_json::to_vec(&json!({
        "method": "Runtime.evaluate", "params": { "expression": candidate.source.as_deref() }
    }))
    .unwrap();
    assert!(frame.len() + 6 * MAX_MANIFEST_BYTES < codlet::cdp::MAX_CDP_FRAME_BYTES);
}

#[test]
fn binary_and_invalid_utf8_files_are_rejected_without_echoing_source() {
    let fixture = Fixture::new();
    for bytes in [
        b"\xff".as_slice(),
        b"\xef\xbb\xbf\xff",
        b"source-secret\0",
        b"source-secret\x1b",
        b"source-secret\xc2\x85",
    ] {
        fs::write(fixture.root.join("codlet.json"), bytes).unwrap();
        let error = rejected(&fixture.root, "read manifest", "UTF-8");
        assert!(!error.to_string().contains("source-secret"));
        fixture.write_manifest(&manifest());
        fs::write(fixture.entry(), bytes).unwrap();
        let error = rejected(&fixture.root, "read renderer entry", "UTF-8");
        assert!(!error.to_string().contains("source-secret"));
        fs::write(fixture.entry(), SOURCE).unwrap();
    }
}

#[test]
fn empty_entry_is_rejected_but_source_is_not_a_javascript_parser() {
    let fixture = Fixture::new();
    for source in ["", " \t\r\n "] {
        fs::write(fixture.entry(), source).unwrap();
        rejected(&fixture.root, "read renderer entry", "non-whitespace");
    }
    let source = "not valid JavaScript, intentionally; runtime validates it later";
    fs::write(fixture.entry(), source).unwrap();
    assert_eq!(
        inspect_local_plugin(&fixture.root).unwrap().source,
        Some(source.to_owned().into())
    );
}

#[test]
fn entry_paths_reject_traversal_absolute_drive_unc_ads_and_aliases() {
    let fixture = Fixture::new();
    for entry in [
        "../renderer.js",
        "dist/../renderer.js",
        "./dist/renderer.js",
        "/renderer.js",
        "dist//renderer.js",
        "dist/./renderer.js",
        "dist/renderer.js/",
        "",
        ".",
        "..",
        "C:/renderer.js",
        "C:renderer.js",
        "//server/share/renderer.js",
        r"\\server\share\renderer.js",
        r"\\?\C:\renderer.js",
        r"\\.\pipe\renderer",
        "renderer.js:stream",
        r"dist\renderer.js",
        "dist/renderer.js ",
        "dist /renderer.js",
        "DIST~1/renderer.js",
        "renderer%2ejs",
        "dist/\u{6e32}\u{67d3}.js",
        "COM\u{00b9}.js",
        "CONIN$.js",
        "CONOUT$.js",
    ] {
        let mut value = manifest();
        value["renderer"]["entry"] = json!(entry);
        fixture.write_manifest(&value);
        rejected(&fixture.root, "parse manifest", "normalized relative path");
    }
}

#[test]
fn windows_device_names_and_trailing_dots_are_rejected_on_every_platform() {
    let fixture = Fixture::new();
    for entry in [
        "CON.js",
        "con.js",
        "NuL.js",
        "aux.txt.js",
        "PRN.js",
        "COM1.js",
        "com9.js",
        "LPT1.js",
        "lpt9.js",
        "dist/CON.js",
        "NUL/renderer.js",
        "dist./renderer.js",
        "dist/renderer.js./entry.js",
        "dist/.../renderer.js",
    ] {
        let mut value = manifest();
        value["renderer"]["entry"] = json!(entry);
        fixture.write_manifest(&value);
        rejected(
            &fixture.root,
            "entry path validation",
            "Windows device names or trailing spaces/dots",
        );
    }
}

#[test]
fn ordinary_names_resembling_device_names_remain_valid() {
    let fixture = Fixture::new();
    for entry in [
        "COM0.js",
        "COM10.js",
        "LPT0.js",
        "LPT10.js",
        "console.js",
        "auxiliary.js",
        "nulled.js",
        ".renderer.js",
    ] {
        fs::write(fixture.root.join(entry), SOURCE).unwrap();
        let mut value = manifest();
        value["renderer"]["entry"] = json!(entry);
        fixture.write_manifest(&value);
        inspect_local_plugin(&fixture.root).unwrap();
    }
}

#[test]
fn network_and_device_roots_are_rejected_before_filesystem_lookup() {
    // Nonexistent endpoints must fail validation, not attempt a network open.
    for root in [
        "",
        r"\\codlet.invalid\share\plugin",
        "//codlet.invalid/share/plugin",
        r"\\?\UNC\codlet.invalid\share\plugin",
        r"\\.\pipe\codlet",
        r"\\?\GLOBALROOT\Device\HarddiskVolume1\plugin",
    ] {
        rejected(Path::new(root), "root path validation", "local directory");
    }
}

#[cfg(windows)]
#[test]
fn windows_ambiguous_roots_are_rejected_and_verbatim_disk_roots_are_accepted() {
    for root in [
        "C:",
        "C:plugin",
        r"\plugin",
        r"\??\C:\plugin",
        r"\\?\C:plugin",
    ] {
        rejected(Path::new(root), "root path validation", "local directory");
    }
    let fixture = Fixture::new();
    let canonical = fs::canonicalize(&fixture.root).unwrap();
    assert!(canonical.to_string_lossy().starts_with(r"\\?\"));
    assert_eq!(inspect_local_plugin(&canonical).unwrap().root, canonical);
}

#[test]
fn load_rereads_identity_permissions_and_source_each_time() {
    let fixture = Fixture::new();
    let original = inspect_local_plugin(&fixture.root).unwrap();
    original.validate_grants(&[Permission::UiDom]).unwrap();
    let mut changed = manifest();
    changed["id"] = json!("dev.renamed");
    fixture.write_manifest(&changed);
    let error = load_local_plugin("dev.local", &fixture.root, &[Permission::UiDom], 1).unwrap_err();
    assert_rejection(&error, "identity validation", "dev.renamed");

    changed["id"] = json!("dev.local");
    changed["permissions"] = json!(["ui.dom", "runtime.manage"]);
    fixture.write_manifest(&changed);
    let error = load_local_plugin("dev.local", &fixture.root, &[Permission::UiDom], 2).unwrap_err();
    assert_rejection(&error, "grant validation", "runtime.manage");
    let replacement = "module.exports = { activate() { return 2; }, deactivate() {} };";
    fs::write(fixture.entry(), replacement).unwrap();
    let loaded = load_local_plugin(
        "dev.local",
        &fixture.root,
        &[Permission::UiDom, Permission::RuntimeManage],
        3,
    )
    .unwrap();
    assert_eq!(loaded.source, Some(replacement.to_owned().into()));
    assert_eq!(loaded.generation, 3);
    assert_eq!(original.source, Some(SOURCE.to_owned().into()));
    assert_eq!(
        loaded.manifest.permissions,
        [Permission::UiDom, Permission::RuntimeManage]
    );

    changed["schema"] = json!(99);
    fixture.write_manifest(&changed);
    assert!(
        load_local_plugin(
            "dev.local",
            &fixture.root,
            &[Permission::UiDom, Permission::RuntimeManage],
            4
        )
        .is_err()
    );
}

#[test]
fn grants_must_be_explicit_and_unique_and_never_expand_the_manifest() {
    let fixture = Fixture::new();
    let candidate = inspect_local_plugin(&fixture.root).unwrap();
    let error = candidate.validate_grants(&[]).unwrap_err();
    assert_rejection(&error, "grant validation", "explicitly grant");
    assert!(
        error
            .to_string()
            .contains(&candidate.root.to_string_lossy().to_string())
    );
    assert!(validate_grants(&candidate.manifest, &[]).is_err());
    for permission in [Permission::UiDom, Permission::RuntimeManage] {
        let grants = [Permission::UiDom, permission, permission];
        assert_rejection(
            &candidate.validate_grants(&grants).unwrap_err(),
            "grant validation",
            "duplicate grant",
        );
        assert!(load_local_plugin("dev.local", &fixture.root, &grants, 1).is_err());
    }
    let grants = [Permission::RuntimeManage, Permission::UiDom];
    validate_grants(&candidate.manifest, &grants).unwrap();
    let loaded = load_local_plugin("dev.local", &fixture.root, &grants, 1).unwrap();
    assert_eq!(loaded.manifest.permissions, [Permission::UiDom]);

    let mut value = manifest();
    value["permissions"] = json!([]);
    fixture.write_manifest(&value);
    load_local_plugin("dev.local", &fixture.root, &[], 1).unwrap();
}

#[test]
fn unsupported_permissions_are_rejected_in_both_requests_and_grants() {
    let fixture = Fixture::new();
    for permission in [Permission::CdpRaw, Permission::HostProcess] {
        let candidate = inspect_local_plugin(&fixture.root).unwrap();
        let grants = [Permission::UiDom, permission];
        assert_rejection(
            &candidate.validate_grants(&grants).unwrap_err(),
            "grant validation",
            "not implemented",
        );
        assert!(validate_grants(&candidate.manifest, &grants).is_err());
        assert!(load_local_plugin("dev.local", &fixture.root, &grants, 1).is_err());
        let mut value = manifest();
        value["permissions"] = json!([permission.as_str()]);
        fixture.write_manifest(&value);
        rejected(&fixture.root, "permission validation", permission.as_str());
        fixture.write_manifest(&manifest());
    }
}

#[test]
fn main_world_loads_only_with_an_explicit_declared_and_granted_permission() {
    let fixture = Fixture::new();
    let mut value = manifest();
    value["renderer"]["world"] = json!("main");
    value["permissions"] = json!(["ui.mainWorld"]);
    fixture.write_manifest(&value);
    let candidate = inspect_local_plugin(&fixture.root).unwrap();
    assert!(candidate.validate_grants(&[]).is_err());
    assert!(candidate.validate_grants(&[Permission::UiDom]).is_err());
    let parsed = PluginManifest::parse(&value.to_string()).unwrap();
    validate_grants(&parsed, &[Permission::UiMainWorld]).unwrap();
    load_local_plugin("dev.local", &fixture.root, &[Permission::UiMainWorld], 1).unwrap();
    value["permissions"] = json!(["ui.dom"]);
    fixture.write_manifest(&value);
    assert!(inspect_local_plugin(&fixture.root).is_err());
}

#[test]
fn generations_require_positive_javascript_safe_integers() {
    let fixture = Fixture::new();
    for generation in [0, 9_007_199_254_740_992, u64::MAX] {
        let error = load_local_plugin("dev.local", &fixture.root, &[Permission::UiDom], generation)
            .unwrap_err();
        assert_rejection(
            &error,
            "generation validation",
            "between 1 and 9007199254740991",
        );
    }
    for generation in [1, 9_007_199_254_740_991] {
        assert_eq!(
            load_local_plugin("dev.local", &fixture.root, &[Permission::UiDom], generation)
                .unwrap()
                .generation,
            generation
        );
    }
}

#[test]
fn successful_inspection_and_load_do_not_execute_source_or_create_configuration() {
    let fixture = Fixture::new();
    let sentinel = fixture.root.join("executed.txt");
    let source = format!(
        "require('node:fs').writeFileSync({}, 'executed');\nthrow new Error('must not run in loader');\n{SOURCE}",
        serde_json::to_string(&sentinel).unwrap()
    );
    fs::write(fixture.entry(), &source).unwrap();
    let before: Vec<_> = fs::read_dir(&fixture.root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(
        inspect_local_plugin(&fixture.root).unwrap().source,
        Some(source.to_owned().into())
    );
    assert_eq!(
        load_local_plugin("dev.local", &fixture.root, &[Permission::UiDom], 1)
            .unwrap()
            .source,
        Some(source.to_owned().into())
    );
    assert!(!sentinel.exists());
    let after: Vec<_> = fs::read_dir(&fixture.root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(before, after);
}

#[test]
fn reserved_ids_are_left_for_the_composed_catalog() {
    let fixture = Fixture::new();
    let mut value = manifest();
    value["id"] = json!("codlet-gui");
    fixture.write_manifest(&value);
    load_local_plugin("codlet-gui", &fixture.root, &[Permission::UiDom], 1).unwrap();
    assert!(
        LocalPluginError::ReservedId("codlet-gui".to_owned())
            .to_string()
            .contains("reserved")
    );
}

#[test]
fn hard_links_to_manifest_and_source_are_rejected_even_within_root() {
    let fixture = Fixture::new();
    let manifest_alias = fixture.root.join("manifest-alias.json");
    fs::hard_link(fixture.root.join("codlet.json"), &manifest_alias).unwrap();
    rejected(&fixture.root, "read manifest", "links");
    fs::remove_file(&manifest_alias).unwrap();
    let source_alias = fixture._directory.path().join("outside-source.js");
    fs::hard_link(fixture.entry(), &source_alias).unwrap();
    rejected(&fixture.root, "read renderer entry", "links");
    assert_eq!(fs::read_to_string(source_alias).unwrap(), SOURCE);
}

#[cfg(any(windows, unix))]
fn symlink(target: &Path, link: &Path, directory: bool) -> bool {
    #[cfg(windows)]
    let result = if directory {
        std::os::windows::fs::symlink_dir(target, link)
    } else {
        std::os::windows::fs::symlink_file(target, link)
    };
    #[cfg(unix)]
    let result = {
        let _ = directory;
        std::os::unix::fs::symlink(target, link)
    };
    match result {
        Ok(()) => true,
        #[cfg(windows)]
        Err(error)
            if error.raw_os_error() == Some(1314)
                || error.kind() == std::io::ErrorKind::Unsupported =>
        {
            eprintln!("symlink fixture unavailable without changing system settings: {error}");
            false
        }
        Err(error) => panic!("failed to create symlink fixture: {error}"),
    }
}

#[cfg(any(windows, unix))]
#[test]
fn symbolic_manifest_and_source_links_are_rejected_including_contained_targets() {
    for manifest_link in [true, false] {
        let fixture = Fixture::new();
        let path = if manifest_link {
            fixture.root.join("codlet.json")
        } else {
            fixture.entry()
        };
        let target = fixture.root.join("contained-target");
        fs::rename(&path, &target).unwrap();
        if !symlink(&target, &path, false) {
            return;
        }
        rejected(
            &fixture.root,
            if manifest_link {
                "read manifest"
            } else {
                "read renderer entry"
            },
            "links",
        );
        assert!(target.is_file());
    }
}

#[cfg(any(windows, unix))]
#[test]
fn symbolic_parent_escape_is_rejected_and_explicit_link_root_is_allowed() {
    let fixture = Fixture::new();
    let external = fixture._directory.path().join("outside");
    fs::rename(fixture.root.join("dist"), &external).unwrap();
    if !symlink(&external, &fixture.root.join("dist"), true) {
        return;
    }
    rejected(&fixture.root, "read renderer entry", "links");
    fs::remove_dir(fixture.root.join("dist"))
        .or_else(|_| fs::remove_file(fixture.root.join("dist")))
        .unwrap();
    fs::rename(&external, fixture.root.join("dist")).unwrap();
    let root_alias = fixture._directory.path().join("root-alias");
    assert!(symlink(&fixture.root, &root_alias, true));
    assert_eq!(
        inspect_local_plugin(&root_alias).unwrap().root,
        fs::canonicalize(&fixture.root).unwrap()
    );
}

#[cfg(windows)]
#[test]
fn case_aliases_are_rejected_for_manifest_entry_and_parent_directories() {
    let fixture = Fixture::new();
    fs::rename(
        fixture.root.join("codlet.json"),
        fixture.root.join("CODLET.JSON"),
    )
    .unwrap();
    rejected(&fixture.root, "read manifest", "alias");
    fs::rename(
        fixture.root.join("CODLET.JSON"),
        fixture.root.join("codlet.json"),
    )
    .unwrap();
    for entry in ["DIST/renderer.js", "dist/Renderer.js"] {
        let mut value = manifest();
        value["renderer"]["entry"] = json!(entry);
        fixture.write_manifest(&value);
        rejected(&fixture.root, "read renderer entry", "alias");
    }
}

#[cfg(windows)]
fn junction(target: &Path, link: &Path) -> bool {
    // PowerShell creates only this fixture junction; no security/developer-mode
    // settings are changed and no path is interpolated into shell source.
    use std::os::windows::process::CommandExt;
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; New-Item -ItemType Junction -Path $env:CODLET_JUNCTION_LINK -Target $env:CODLET_JUNCTION_TARGET | Out-Null"])
        .env("CODLET_JUNCTION_LINK", link)
        .env("CODLET_JUNCTION_TARGET", target)
        .creation_flags(0x0800_0000)
        .output().unwrap();
    if !output.status.success() {
        eprintln!(
            "junction fixture unavailable: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        return false;
    }
    true
}

#[cfg(windows)]
#[test]
fn real_windows_junction_escape_is_rejected_but_explicit_junction_root_is_allowed() {
    use std::os::windows::fs::MetadataExt;
    let fixture = Fixture::new();
    let outside = fixture._directory.path().join("outside");
    fs::rename(fixture.root.join("dist"), &outside).unwrap();
    let link = fixture.root.join("dist");
    if !junction(&outside, &link) {
        return;
    }
    assert_ne!(
        fs::symlink_metadata(&link).unwrap().file_attributes() & 0x400,
        0
    );
    rejected(&fixture.root, "read renderer entry", "links");
    assert_eq!(
        fs::read_to_string(outside.join("renderer.js")).unwrap(),
        SOURCE
    );
    fs::remove_dir(&link).unwrap();
    fs::rename(&outside, fixture.root.join("dist")).unwrap();
    let alias = fixture._directory.path().join("root-junction");
    assert!(junction(&fixture.root, &alias));
    assert_eq!(
        inspect_local_plugin(&alias).unwrap().root,
        fs::canonicalize(&fixture.root).unwrap()
    );
    fs::remove_dir(alias).unwrap();
}

#[cfg(unix)]
#[test]
fn unix_special_file_is_rejected_before_opening() {
    use std::os::unix::net::UnixListener;
    // Darwin's socket address is at most 104 bytes; its default TMPDIR plus
    // the Unicode-path fixture can exceed that before plugin inspection runs.
    let directory = tempfile::Builder::new()
        .prefix("codlet-")
        .tempdir_in("/tmp")
        .unwrap();
    let root = directory.path();
    fs::write(
        root.join("codlet.json"),
        serde_json::to_vec(&manifest()).unwrap(),
    )
    .unwrap();
    fs::create_dir(root.join("dist")).unwrap();
    let _listener = UnixListener::bind(root.join("dist/renderer.js")).unwrap();
    rejected(root, "read renderer entry", "ordinary file");
}
