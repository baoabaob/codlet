//! Read model for the management list. Registrations are current configuration;
//! loaded metadata belongs to the runtime. Listing never inspects plugin files.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Value, json};

use crate::catalog::{PluginCatalog, PluginSource};
use crate::plugin_execution::{ExecutionState, PluginExecutionObservation};
use crate::plugins::{LoadedPlugin, PluginRegistry};

pub(super) fn plugin_list(
    catalog: &PluginCatalog,
    plugins: &[LoadedPlugin],
    registry: &PluginRegistry,
    active_plugin_ids: &BTreeSet<String>,
    external_observations: &[PluginExecutionObservation],
) -> Value {
    let entries: BTreeMap<_, _> = catalog
        .entries()
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect();
    let loaded: BTreeMap<_, _> = plugins
        .iter()
        .map(|plugin| (plugin.manifest.id.as_str(), plugin))
        .collect();
    let external: BTreeMap<_, _> = external_observations
        .iter()
        .filter(|observation| observation.plugin.manifest.host.is_some())
        .map(|observation| (observation.plugin.manifest.id.as_str(), observation))
        .collect();
    let mut ids: BTreeSet<_> = registry
        .local_plugins()
        .keys()
        .map(String::as_str)
        .collect();
    ids.extend(loaded.keys().copied());
    ids.extend(external.iter().filter_map(|(id, observation)| {
        matches!(
            observation.state,
            ExecutionState::Starting | ExecutionState::Active | ExecutionState::Stopping
        )
        .then_some(*id)
    }));
    ids.extend(
        entries
            .iter()
            .filter_map(|(id, entry)| matches!(entry.source, PluginSource::Bundled).then_some(*id)),
    );

    let rows: Vec<_> = ids.into_iter().map(|id| {
        let entry = entries.get(id).copied();
        let runtime = loaded.get(id).copied();
        let observation = external.get(id).copied();
        let observed_plugin = observation.map(|observation| &observation.plugin).or(runtime);
        let is_loaded = observation.map_or(runtime.is_some(), |observation| {
            matches!(observation.state, ExecutionState::Starting | ExecutionState::Active | ExecutionState::Stopping)
        });
        let registration = registry.local_plugins().get(id);
        let bundled = entry.is_some_and(|entry| matches!(entry.source, PluginSource::Bundled));
        let current_cached_entry = entry.filter(|entry| match &entry.source {
            PluginSource::Bundled => true,
            PluginSource::Local { path, grants } => registration.is_some_and(|registration| registration.path == *path && registration.grants == *grants),
        });
        let metadata = observed_plugin.or_else(|| current_cached_entry.and_then(|entry| entry.plugin.as_ref().ok()));
        let metadata_source = if observed_plugin.is_some() { "runtime" } else if current_cached_entry.is_some() { "catalog_snapshot" } else { "unavailable" };
        let validation = if observed_plugin.is_some() {
            json!({"status":"ok","basis":"runtime"})
        } else if let Some(entry) = current_cached_entry {
            match &entry.plugin {
                Ok(_) => json!({"status":"ok","basis":"catalog_snapshot"}),
                Err(error) => json!({"status":"failed","basis":"catalog_snapshot","error":{"code":"local_plugin_invalid","message":error.to_string()}}),
            }
        } else {
            json!({"status":"not_loaded","basis":"registration"})
        };
        let loaded_path = is_loaded.then(|| {
            observation.and_then(|observation| observation.plugin.host.as_ref().map(|host| host.root.as_path()))
                .or_else(|| runtime.and_then(|_| entry.and_then(|entry| entry.source.path())))
        }).flatten();
        let grants = if bundled {
            entry.map(|entry| entry.grants()).unwrap_or_default()
        } else {
            registration.map(|registration| registration.grants.as_slice()).unwrap_or_default()
        };
        let mut row = json!({
            "id":id,
            "version":metadata.map(|plugin| &plugin.manifest.version),
            "source":if bundled { "bundled" } else { "local" },
            "path":registration.map(|registration| registration.path.to_string_lossy()),
            "grants":grants,
            "requestedPermissions":metadata.map(|plugin| &plugin.manifest.permissions),
            "validation":validation,
            "enabled":registry.is_enabled(id),
            "active":observation.map_or(runtime.is_some() && active_plugin_ids.contains(id), |observation| observation.state == ExecutionState::Active),
            "registered":bundled || registration.is_some(),
            "loaded":is_loaded,
            "generation":observed_plugin.map(|plugin| plugin.generation),
            "loadedPath":loaded_path.map(|path| path.to_string_lossy()),
            "metadataSource":metadata_source,
        });
        if let Some(observation) = observation {
            row["execution"] = json!({
                "kind":"host", "state":observation.state,
                "processId":observation.process_id, "error":observation.error,
            });
        }
        row
    }).collect();
    json!({"plugins":rows})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::{LocalPluginRegistration, Permission, bundled_plugins};
    use tempfile::tempdir;

    fn row<'a>(list: &'a Value, id: &str) -> &'a Value {
        list["plugins"]
            .as_array()
            .unwrap()
            .iter()
            .find(|plugin| plugin["id"] == id)
            .expect("plugin should be listed")
    }

    #[test]
    fn removed_local_rows_disappear_only_after_retirement_and_new_registrations_need_no_source_read()
     {
        let directory = tempdir().unwrap();
        let root = directory.path().join("loaded");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("plugin.json"), json!({"schema":1,"id":"dev.list.local","version":"1","renderer":{"entry":"renderer.js","world":"isolated"},"permissions":["ui.dom"]}).to_string()).unwrap();
        std::fs::write(root.join("renderer.js"), "module.exports = {};").unwrap();
        let mut registry = PluginRegistry::load(directory.path().join("config.json")).unwrap();
        for plugin in bundled_plugins().unwrap() {
            registry.set_enabled(&plugin.manifest.id, false).unwrap();
        }
        registry
            .register_local(
                "dev.list.local",
                LocalPluginRegistration {
                    path: root.clone(),
                    grants: vec![Permission::UiDom],
                },
            )
            .unwrap();
        registry.save().unwrap();
        let catalog = PluginCatalog::load(&registry).unwrap();
        let loaded = catalog.enabled_plugins(&registry).unwrap();
        let active = BTreeSet::from(["dev.list.local".to_owned()]);

        std::fs::write(root.join("plugin.json"), "invalid manifest on disk").unwrap();
        std::fs::write(
            root.join("renderer.js"),
            "throw new Error('listing must not read or execute this revision');",
        )
        .unwrap();
        registry.remove_local("dev.list.local").unwrap();
        registry.save().unwrap();
        let list = plugin_list(&catalog, &loaded, &registry, &active, &[]);
        let retained = row(&list, "dev.list.local");
        assert_eq!(retained["registered"], false);
        assert_eq!(retained["loaded"], true);
        assert_eq!(retained["active"], true);
        assert_eq!(retained["generation"], 1);
        assert_eq!(retained["version"], "1");
        assert_eq!(retained["metadataSource"], "runtime");
        assert_eq!(retained["validation"]["basis"], "runtime");
        assert!(retained["path"].is_null());
        assert_eq!(retained["loadedPath"], json!(root.to_string_lossy()));
        assert_eq!(retained["grants"], json!([]));
        assert_eq!(retained["requestedPermissions"], json!(["ui.dom"]));

        let missing = directory.path().join("not-present");
        registry
            .register_local(
                "dev.list.new",
                LocalPluginRegistration {
                    path: missing.clone(),
                    grants: vec![],
                },
            )
            .unwrap();
        registry.set_enabled("dev.list.local", false).unwrap();
        registry.save().unwrap();
        let list = plugin_list(&catalog, &[], &registry, &BTreeSet::new(), &[]);
        assert!(
            list["plugins"]
                .as_array()
                .unwrap()
                .iter()
                .all(|plugin| plugin["id"] != "dev.list.local")
        );
        let new = row(&list, "dev.list.new");
        assert_eq!(new["registered"], true);
        assert_eq!(new["loaded"], false);
        assert_eq!(new["active"], false);
        assert!(
            new["generation"].is_null()
                && new["version"].is_null()
                && new["requestedPermissions"].is_null()
        );
        assert_eq!(new["metadataSource"], "unavailable");
        assert_eq!(new["validation"]["status"], "not_loaded");
        assert!(!missing.exists());
    }

    #[test]
    fn unstarted_metadata_requires_the_same_registration_while_runtime_metadata_uses_its_actual_generation()
     {
        let directory = tempdir().unwrap();
        let original = directory.path().join("original");
        std::fs::create_dir(&original).unwrap();
        std::fs::write(original.join("plugin.json"), json!({"schema":1,"id":"dev.list.local","version":"1","renderer":{"entry":"renderer.js","world":"isolated"}}).to_string()).unwrap();
        std::fs::write(original.join("renderer.js"), "module.exports = {};").unwrap();
        let mut registry = PluginRegistry::load(directory.path().join("config.json")).unwrap();
        registry
            .register_local(
                "dev.list.local",
                LocalPluginRegistration {
                    path: original.clone(),
                    grants: vec![],
                },
            )
            .unwrap();
        registry.set_enabled("dev.list.local", false).unwrap();
        registry.save().unwrap();
        let catalog = PluginCatalog::load(&registry).unwrap();
        let list = plugin_list(&catalog, &[], &registry, &BTreeSet::new(), &[]);
        assert_eq!(
            row(&list, "dev.list.local")["metadataSource"],
            "catalog_snapshot"
        );

        registry
            .register_local(
                "dev.list.local",
                LocalPluginRegistration {
                    path: original.clone(),
                    grants: vec![Permission::UiDom],
                },
            )
            .unwrap();
        registry.save().unwrap();
        let changed_grants = plugin_list(&catalog, &[], &registry, &BTreeSet::new(), &[]);
        assert_eq!(
            row(&changed_grants, "dev.list.local")["metadataSource"],
            "unavailable"
        );
        assert!(row(&changed_grants, "dev.list.local")["version"].is_null());
        let mut running = catalog
            .entries()
            .iter()
            .find(|entry| entry.id == "dev.list.local")
            .unwrap()
            .plugin
            .as_ref()
            .unwrap()
            .clone();
        running.generation = 9;
        running.manifest.version = "9".into();
        registry.remove_local("dev.list.local").unwrap();
        registry.save().unwrap();
        let replacement = directory.path().join("replacement-not-inspected");
        registry
            .register_local(
                "dev.list.local",
                LocalPluginRegistration {
                    path: replacement.clone(),
                    grants: vec![],
                },
            )
            .unwrap();
        registry.save().unwrap();
        let list = plugin_list(&catalog, &[running], &registry, &BTreeSet::new(), &[]);
        let running = row(&list, "dev.list.local");
        assert_eq!(running["metadataSource"], "runtime");
        assert_eq!(running["version"], "9");
        assert_eq!(running["generation"], 9);
        assert_eq!(running["loadedPath"], json!(original.to_string_lossy()));
        assert_eq!(running["path"], json!(replacement.to_string_lossy()));
        let unloaded = plugin_list(&catalog, &[], &registry, &BTreeSet::new(), &[]);
        assert_eq!(
            row(&unloaded, "dev.list.local")["metadataSource"],
            "unavailable"
        );
        assert!(!replacement.exists());
    }

    #[test]
    fn host_observations_preserve_live_removed_processes_and_report_retired_failures_without_renderer_state()
     {
        let directory = tempdir().unwrap();
        let root = directory.path().join("host");
        std::fs::create_dir(&root).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        std::fs::write(root.join("helper.exe"), b"MZ\0\xff").unwrap();
        std::fs::write(
            root.join("plugin.json"),
            json!({
                "schema":1,"id":"dev.host","version":"1",
                "host":{"command":["helper.exe"],"protocol":"jsonl"},
                "permissions":["host.process"]
            })
            .to_string(),
        )
        .unwrap();
        let mut registry = PluginRegistry::load(directory.path().join("config.json")).unwrap();
        registry
            .register_local(
                "dev.host",
                LocalPluginRegistration {
                    path: root.clone(),
                    grants: vec![Permission::HostProcess],
                },
            )
            .unwrap();
        let catalog = PluginCatalog::load(&registry).unwrap();
        let mut plugin = catalog
            .entries()
            .iter()
            .find(|entry| entry.id == "dev.host")
            .unwrap()
            .plugin
            .as_ref()
            .unwrap()
            .clone();
        plugin.generation = 8;
        plugin.manifest.version = "8".into();
        let mut observation = PluginExecutionObservation {
            plugin,
            state: ExecutionState::Starting,
            process_id: Some(404),
            error: None,
        };
        // A list reads only the observation and current registry. It does not
        // reread this changed source or infer execution from its declaration.
        std::fs::write(root.join("plugin.json"), "invalid manifest after launch").unwrap();
        for state in [
            ExecutionState::Starting,
            ExecutionState::Active,
            ExecutionState::Stopping,
        ] {
            observation.state = state;
            let list = plugin_list(
                &catalog,
                &[],
                &registry,
                &BTreeSet::new(),
                std::slice::from_ref(&observation),
            );
            let row = row(&list, "dev.host");
            assert_eq!(row["loaded"], true);
            assert_eq!(row["active"], state == ExecutionState::Active);
            assert_eq!(row["version"], "8");
            assert_eq!(row["generation"], 8);
            assert_eq!(row["metadataSource"], "runtime");
            assert_eq!(row["loadedPath"], json!(root.to_string_lossy()));
            assert_eq!(row["execution"]["kind"], "host");
            assert_eq!(row["execution"]["processId"], 404);
            assert!(row.get("targetId").is_none() && row.get("sessionId").is_none());
        }
        registry.remove_local("dev.host").unwrap();
        let live_removed = plugin_list(
            &catalog,
            &[],
            &registry,
            &BTreeSet::new(),
            std::slice::from_ref(&observation),
        );
        assert_eq!(row(&live_removed, "dev.host")["registered"], false);
        assert_eq!(row(&live_removed, "dev.host")["loaded"], true);

        observation.state = ExecutionState::Failed;
        observation.error = Some("Worker exited with code 12".into());
        let removed = plugin_list(
            &catalog,
            &[],
            &registry,
            &BTreeSet::new(),
            std::slice::from_ref(&observation),
        );
        assert!(
            removed["plugins"]
                .as_array()
                .unwrap()
                .iter()
                .all(|plugin| plugin["id"] != "dev.host")
        );
        let replacement = directory.path().join("registered-but-not-inspected");
        registry
            .register_local(
                "dev.host",
                LocalPluginRegistration {
                    path: replacement.clone(),
                    grants: vec![Permission::HostProcess],
                },
            )
            .unwrap();
        let failed = plugin_list(
            &catalog,
            &[],
            &registry,
            &BTreeSet::new(),
            std::slice::from_ref(&observation),
        );
        let failed = row(&failed, "dev.host");
        assert_eq!(failed["registered"], true);
        assert_eq!(failed["loaded"], false);
        assert_eq!(failed["active"], false);
        assert_eq!(failed["version"], "8");
        assert!(failed["loadedPath"].is_null());
        assert_eq!(failed["execution"]["state"], "failed");
        assert_eq!(failed["execution"]["error"], "Worker exited with code 12");
        assert!(!replacement.exists());

        observation.state = ExecutionState::Exited;
        observation.error = None;
        registry.remove_local("dev.host").unwrap();
        let exited = plugin_list(&catalog, &[], &registry, &BTreeSet::new(), &[observation]);
        assert!(
            exited["plugins"]
                .as_array()
                .unwrap()
                .iter()
                .all(|plugin| plugin["id"] != "dev.host")
        );
    }
}
