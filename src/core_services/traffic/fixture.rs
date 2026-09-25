//! Debug-only real authority/engine harness. Never built into release artifacts.
use super::*;
use std::io::{BufRead, Write};
pub fn run() -> Result<()> {
    let stdin = std::io::stdin();
    let mut lines = stdin.lock().lines();
    let first = lines
        .next()
        .ok_or_else(|| error("invalid_params", "fixture configuration required"))?
        .map_err(|_| error("io_error", "fixture input closed"))?;
    let config: Value = serde_json::from_str(&first)
        .map_err(|_| error("invalid_params", "invalid fixture configuration"))?;
    let directory = tempfile::Builder::new()
        .prefix("codlet-native-traffic-")
        .tempdir()
        .map_err(|_| error("io_error", "cannot create fixture directory"))?;
    // macOS's default /var temporary prefix is a system symlink. Use the
    // physical root so fixture ownership has the same strict path checks.
    let fixture_root = directory
        .path()
        .canonicalize()
        .map_err(|_| error("io_error", "cannot resolve fixture directory"))?;
    let registry_path = fixture_root.join("registry.json");
    let mut registry = PluginRegistry::load(&registry_path)
        .map_err(|_| error("io_error", "fixture registry failed"))?;
    let mut plugins = vec![];
    for name in ["test.native-a", "test.native-b"] {
        let root = fixture_root.join(name);
        std::fs::create_dir(&root).map_err(|_| error("io_error", "fixture directory failed"))?;
        let root = root
            .canonicalize()
            .map_err(|_| error("io_error", "fixture directory failed"))?;
        let mut permissions = vec![
            Permission::HostProcess,
            Permission::HostNetwork,
            Permission::CoreNetwork,
            Permission::CoreCredentials,
            Permission::CoreCredentialsUse,
        ];
        if config["noIntercept"] != true {
            permissions.push(Permission::TrafficIntercept);
        }
        if config["sensitive"] == true || name == "test.native-b" {
            permissions.extend([
                Permission::TrafficSensitiveHeaders,
                Permission::TrafficRedirect,
            ]);
        }
        std::fs::write(root.join("host.js"), "exports.activate=()=>{};")
            .map_err(|_| error("io_error", "fixture entry failed"))?;
        std::fs::write(root.join("codlet.json"),json!({"schema":1,"id":name,"version":"1.0.0","host":{"entry":"host.js"},"permissions":permissions}).to_string()).map_err(|_|error("io_error","fixture manifest failed"))?;
        let registration = crate::plugins::LocalPluginRegistration {
            path: root,
            grants: permissions,
            broker_policy: crate::plugin_permissions::BrokerPolicy {
                network_origins: config["origins"]
                    .as_array()
                    .map(|v| {
                        v.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default(),
                ..Default::default()
            },
        };
        registry
            .register_local(name, registration.clone())
            .map_err(|_| error("io_error", "fixture registration failed"))?;
        registry
            .set_enabled(name, true)
            .map_err(|_| error("io_error", "fixture enable failed"))?;
        plugins.push(
            crate::local_plugins::load_local_plugin_with_registration(name, &registration, 1)
                .map_err(|_| error("io_error", "fixture package failed"))?,
        );
    }
    registry
        .save()
        .map_err(|_| error("io_error", "fixture registry save failed"))?;
    let services = SharedCoreServices::with_persistent(
        &registry_path,
        PluginServices::fixture(&registry_path)?,
    )?;
    services.register(&plugins)?;
    let traffic = services.prepare_traffic()?;
    let legacy = config["engine"] == "legacy";
    if !legacy && config["engine"] != "off" {
        traffic.start_native()?;
    }
    let gateway = if legacy {
        traffic.gateway_endpoint()?
    } else {
        Value::Null
    };
    let mut output = std::io::stdout().lock();
    writeln!(output,"{}",json!({"ready":true,"pid":std::process::id(),"source":traffic.launch_descriptor().unwrap_or(Value::Null)["source"],"gateway":gateway})).map_err(|_|error("io_error","fixture output failed"))?;
    output
        .flush()
        .map_err(|_| error("io_error", "fixture output failed"))?;
    for line in lines {
        let line = line.map_err(|_| error("io_error", "fixture input failed"))?;
        let message: Value = serde_json::from_str(&line)
            .map_err(|_| error("invalid_params", "invalid fixture request"))?;
        let method = message["method"].as_str().unwrap_or("");
        if method == "quit" {
            break;
        }
        let owner = message["owner"].as_str().unwrap_or("test.native-a");
        let params = message.get("params").cloned().unwrap_or(json!({}));
        let result = (|| {
            if method == "resources" {
                return Ok(traffic.resources());
            }
            if method == "descriptor" {
                return Ok(traffic.launch_descriptor().unwrap_or(Value::Null));
            }
            if method == "start" {
                traffic.start_native()?;
                return Ok(traffic.launch_descriptor().unwrap_or(Value::Null));
            }
            if method == "retire" {
                services.retire(owner, 1);
                return Ok(json!({"retired":true}));
            }
            if method == "disable" {
                let mut registry = PluginRegistry::load(&registry_path)
                    .map_err(|_| error("io_error", "fixture registry failed"))?;
                registry
                    .set_enabled(owner, false)
                    .map_err(|_| error("io_error", "fixture disable failed"))?;
                registry
                    .save()
                    .map_err(|_| error("io_error", "fixture registry save failed"))?;
                services.retire_host_traffic(owner, 1);
                return Ok(json!({"disabled":true}));
            }
            let principal = services
                .0
                .owners
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(owner)
                .cloned()
                .ok_or_else(|| error("stale_generation", "fixture owner retired"))?;
            let method = method.strip_prefix("services.").unwrap_or(method);
            services.check(&principal, method, true, &params)?;
            match method.split_once('.') {
                Some(("traffic", method)) => services.traffic_operation(&principal, method, params),
                Some(("network", method)) => services.0.network.invoke(
                    &principal,
                    method,
                    params,
                    &services.0.persistent,
                    &|| services.current_checked(&principal, true),
                ),
                Some(("credentials", method)) => {
                    services
                        .0
                        .persistent
                        .invoke_credentials(&principal.owner, method, params)
                }
                _ => Err(error(
                    "method_not_found",
                    "fixture supports traffic-related services only",
                )),
            }
        })();
        let response = match result {
            Ok(value) => json!({"id":message["id"],"result":value}),
            Err(e) => json!({"id":message["id"],"error":{"code":e.code}}),
        };
        writeln!(output, "{response}").map_err(|_| error("io_error", "fixture output failed"))?;
        output
            .flush()
            .map_err(|_| error("io_error", "fixture output failed"))?;
    }
    traffic.stop_native();
    drop(traffic);
    drop(services);
    drop(output);
    drop(directory);
    Ok(())
}
