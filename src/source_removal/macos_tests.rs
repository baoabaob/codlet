use super::*;
use crate::plugins::LocalPluginRegistration;

#[test]
fn native_preview_round_trips_and_removes_only_the_confirmed_source() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let source = root.join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("entry.js"), "plugin code").unwrap();
    let mut registry = PluginRegistry::load(root.join("state/config.json")).unwrap();
    registry
        .register_local(
            "dev.native-delete",
            LocalPluginRegistration {
                path: source.clone(),
                ..Default::default()
            },
        )
        .unwrap();
    registry.save().unwrap();
    let data = root.join("state/data.txt");
    std::fs::write(&data, "user data").unwrap();
    let preview = preview(&registry, "dev.native-delete").unwrap();
    assert_eq!(preview.status, "available");
    let wire = serde_json::to_vec(&preview.request()).unwrap();
    let request: SourceRemovalRequest = serde_json::from_slice(&wire).unwrap();
    let plan = prepare(&registry, "dev.native-delete", &request).unwrap();
    registry.remove_local("dev.native-delete").unwrap();
    registry.save().unwrap();
    let result = apply(plan);
    assert_eq!(result.status, "deleted", "{result:?}");
    assert!(!source.exists());
    assert_eq!(std::fs::read_to_string(data).unwrap(), "user data");
}

#[test]
fn a_directory_renamed_before_cleanup_keeps_its_contents_and_its_replacement() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let path = root.join("original");
    let moved = root.join("moved");
    std::fs::create_dir(&path).unwrap();
    std::fs::write(path.join("entry.js"), "original").unwrap();
    let pin = native::pin_directory(&path, true).unwrap();
    std::fs::rename(&path, &moved).unwrap();
    std::fs::create_dir(&path).unwrap();
    std::fs::write(path.join("entry.js"), "replacement").unwrap();
    assert!(pin.remove().is_err());
    assert_eq!(
        std::fs::read_to_string(path.join("entry.js")).unwrap(),
        "replacement"
    );
    assert_eq!(
        std::fs::read_to_string(moved.join("entry.js")).unwrap(),
        "original"
    );
}
