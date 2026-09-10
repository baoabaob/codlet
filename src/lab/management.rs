//! M2 executors and lifecycle owner for one explicitly selected lab registry.
use super::{LabError, Reporter};
use crate::cdp::{CdpClient, TargetSession};
use crate::host_control::HostControl;
use crate::host_runtime::{HostCoreServices, HostRuntime};
use crate::js_runtime::JsRuntime;
use crate::os_broker::OsBroker;
use crate::plugin_control::{PluginControlError, PluginControlRequest};
use crate::plugins::{PluginRegistry, default_registry_path};
use crate::renderer::RendererRuntime;
use crate::runtime_control::{ControlBroker, ControlRequest, ControlStatus};
use crate::runtime_status::StatusPublisher;
use crate::windows::control_pipe::{ControlServer, RegistryScope};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{OsStr, OsString};
use std::fs::OpenOptions;
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
};

pub(super) struct LabRuntime {
    pub renderer: RendererRuntime,
    hosts: Option<HostRuntime>,
    os_broker: Option<OsBroker>,
    host_control: HostControl,
    control: ControlBroker,
    status: StatusPublisher,
    js_runtime: Option<JsRuntime>,
    stdin_receipts: BTreeSet<String>,
    last_authorization_error: Option<String>,
    stopped: Option<bool>,
    // The registry lease outlives executors and listener workers.
    server: ControlServer,
}

impl LabRuntime {
    pub fn prepare(registry_path: PathBuf) -> Result<Self, LabError> {
        let scope = RegistryScope::for_path(&registry_path).map_err(preflight)?;
        let lease = scope
            .acquire(Duration::from_millis(1500))
            .map_err(preflight)?;
        let registry = PluginRegistry::load(&registry_path).map_err(preflight)?;
        let (mut renderer, host_plugins) =
            crate::probe::prepare_plugin_runtimes(registry).map_err(preflight)?;
        let mut host_control = HostControl::new(registry_path);
        host_control.seed_watch_sources(&renderer, &host_plugins);
        let js_runtime = if host_plugins.is_empty() {
            None
        } else {
            Some(JsRuntime::discover().map_err(preflight)?)
        };
        let status = StatusPublisher::new();
        renderer.set_status_publisher(status.clone());
        let server = ControlServer::bind_isolated(lease, status.clone()).map_err(preflight)?;
        let control = server.broker();
        renderer.set_manage_service(crate::runtime_manage::RuntimeManageService::new(
            control.clone(),
        ));
        Ok(Self {
            renderer,
            hosts: None,
            os_broker: None,
            host_control,
            control,
            status,
            js_runtime,
            stdin_receipts: BTreeSet::new(),
            last_authorization_error: None,
            stopped: None,
            server,
        })
    }
    pub fn registry_path(&self) -> &Path {
        self.renderer.registry_path()
    }
    pub fn registry_scope(&self) -> &str {
        self.server.scope().id()
    }

    pub fn activate(
        &mut self,
        client: CdpClient,
        sessions: &BTreeMap<String, TargetSession>,
        reporter: &mut Reporter,
    ) -> Result<(), LabError> {
        let os_broker =
            OsBroker::for_registry(self.registry_path().to_owned()).map_err(runtime_error)?;
        let hosts = HostRuntime::start_with_services(
            self.renderer.logical_plugins(),
            client,
            self.js_runtime.take(),
            HostCoreServices {
                os_broker: Some(os_broker.client()),
                runtime_manage: Some(crate::runtime_manage::RuntimeManageService::new(
                    self.control.clone(),
                )),
            },
        )
        .map_err(runtime_error)?;
        self.renderer
            .set_host_capability_client(hosts.capability_client());
        self.renderer
            .set_external_observations(hosts.observations());
        self.hosts = Some(hosts);
        self.os_broker = Some(os_broker);
        self.attach_all(sessions, reporter)?;
        self.status.set_ready();
        self.control.set_ready();
        self.renderer.refresh_management_list();
        reporter.emit("plugin_runtime_ready", json!({"registry":self.registry_path(), "registry_scope":self.registry_scope(), "local_plugins_supported":true, "production_discovery_bound":false}));
        Ok(())
    }

    fn attach_all(
        &mut self,
        sessions: &BTreeMap<String, TargetSession>,
        reporter: &mut Reporter,
    ) -> Result<(), LabError> {
        let sessions: Vec<_> = sessions
            .values()
            .filter(|session| session.is_live())
            .cloned()
            .collect();
        let mut failed = None;
        for (target_id, result) in self.renderer.attach_all(&sessions) {
            match result {
                Ok(report) => reporter.emit("renderer_attached", json!({"target_id":report.target_id,"plugin_count":report.plugin_count,"gui_mount_verified":false})),
                Err(error) => {
                    reporter.emit("renderer_attach_failed", json!({"target_id":target_id,"error":error.to_string(),"child_retained":true}));
                    failed.get_or_insert_with(|| runtime_error(error));
                }
            }
        }
        failed.map_or(Ok(()), Err)
    }

    pub fn submit(&mut self, request: PluginControlRequest) -> Result<String, PluginControlError> {
        let prepared = self.control.handle(ControlRequest::prepare(request));
        if prepared.status != ControlStatus::Prepared {
            return Err(PluginControlError::new(
                "lab_control_unavailable",
                prepared
                    .error
                    .unwrap_or_else(|| format!("{:?}", prepared.status)),
            ));
        }
        let operation_id = prepared
            .operation_id()
            .expect("prepared receipt")
            .to_owned();
        let submitted = self.control.handle(ControlRequest::submit(&operation_id));
        if submitted.status != ControlStatus::Queued {
            return Err(PluginControlError::new(
                "lab_control_unavailable",
                submitted
                    .error
                    .unwrap_or_else(|| format!("{:?}", submitted.status)),
            ));
        }
        self.stdin_receipts.insert(operation_id.clone());
        Ok(operation_id)
    }

    pub fn pump(
        &mut self,
        sessions: &BTreeMap<String, TargetSession>,
        reporter: &mut Reporter,
    ) -> Result<(), LabError> {
        if self.stopped.is_some() {
            return Ok(());
        }
        let Some(hosts) = &self.hosts else {
            return Ok(());
        };
        self.renderer
            .set_external_observations(hosts.observations());
        self.status
            .publish_host_observation(hosts.execution_snapshot());
        for diagnostic in hosts.take_diagnostics() {
            reporter.emit("host_plugin_diagnostic", json!({"id":diagnostic.plugin_id,"pid":diagnostic.process_id,"state":diagnostic.state,"error":diagnostic.error}));
        }
        match self
            .host_control
            .reconcile_authorization(&mut self.renderer, hosts, Instant::now())
        {
            Ok(()) => self.last_authorization_error = None,
            Err(error) => {
                let message = error.to_string();
                if self.last_authorization_error.as_ref() != Some(&message) {
                    reporter.emit("plugin_authorization_failed", json!({"error":message}));
                    self.last_authorization_error = Some(message);
                }
            }
        }
        self.renderer.pump_bindings().map_err(runtime_error)?;
        self.host_control
            .submit_self_disable_requests(&mut self.renderer, &self.control);
        self.host_control
            .poll(&mut self.renderer, hosts, &self.control);
        if self.host_control.needs_renderer_executor() {
            // Discovery is retained even when all managed renderers are disabled.
            let result = self
                .attach_all(sessions, reporter)
                .map_err(|error| error.to_string());
            self.host_control.renderer_executor_result(result);
        }
        if !self.host_control.is_pending()
            && let Some(job) = self.control.take_next()
            && let Some(job) = self.host_control.dispatch(
                job,
                &mut self.renderer,
                self.hosts.as_ref().unwrap(),
                &self.control,
            )
        {
            let result = self.renderer.manage_plugin(job.request);
            self.control.complete(&job.operation_id, result);
        }
        self.renderer.publish_status();
        self.renderer.refresh_management_list();
        for report in self.host_control.take_authorization_reports() {
            reporter.emit("plugin_authorization_result", json!({"result":report}));
        }
        self.stdin_receipts.retain(|operation_id| {
            let report = self.control.handle(ControlRequest::result(operation_id));
            if matches!(
                report.status,
                ControlStatus::Queued | ControlStatus::Running
            ) {
                return true;
            }
            reporter.emit(
                "plugin_control_result",
                json!({"operation_id":operation_id,"control":report,"gui_mount_verified":false}),
            );
            false
        });
        Ok(())
    }

    pub fn stop(&mut self, reporter: &mut Reporter) -> bool {
        if let Some(clean) = self.stopped {
            return clean;
        }
        self.control.stop();
        let mut clean = true;
        for failure in self.renderer.retire_all_package_renderers() {
            reporter.emit(
                "renderer_cleanup_failed",
                json!({"id":failure.plugin_id,"target_id":failure.target_id,"error":failure.error}),
            );
        }
        if let Some(hosts) = &mut self.hosts {
            match hosts.stop() {
                Ok(reports) => {
                    for report in reports {
                        match report.result {
                        Ok(exit) => reporter.emit("host_plugin_stopped", json!({"id":report.plugin_id,"pid":exit.process_id,"exit_code":exit.exit_code,"forced":exit.forced,"workers_reaped":exit.workers_reaped})),
                        Err(error) => { clean = false; reporter.emit("host_cleanup_failed", json!({"id":report.plugin_id,"error":error.to_string()})); }
                    }
                    }
                }
                Err(error) => {
                    clean = false;
                    reporter.emit("host_cleanup_failed", json!({"error":error.to_string()}));
                }
            }
            self.status
                .publish_host_observation(hosts.execution_snapshot());
        }
        if let Some(mut broker) = self.os_broker.take()
            && let Err(error) = broker.stop()
        {
            clean = false;
            reporter.emit(
                "os_broker_cleanup_failed",
                json!({"error":error.to_string()}),
            );
        }
        self.status.terminate("isolated_lab_stopped");
        self.stopped = Some(clean);
        reporter.emit("plugin_runtime_stopped", json!({"clean":clean}));
        clean
    }
}

fn preflight(error: impl std::fmt::Display) -> LabError {
    LabError::Preflight(error.to_string())
}
fn runtime_error(error: impl std::fmt::Display) -> LabError {
    LabError::Runtime(error.to_string())
}

/// LOCALAPPDATA is set only on the launcher child. Verify its resolved identity
/// before reusing the CLI; launch/status/doctor cannot enter this branch.
pub(super) fn run_plugin_cli(root: &Path, arguments: &[OsString]) -> Result<(), LabError> {
    let _pins = super::pin_lab_ancestry(root, false)?;
    let _registry_pin = super::pin_plain_directory(&root.join("codlet"))?;
    let file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(root.join(".codlet-lab-owner.json"))?;
    super::resume::check_file(&file)?;
    let marker: serde_json::Value =
        serde_json::from_slice(&super::resume::bounded_bytes(file, 4096)?).map_err(preflight)?;
    if marker["schema_version"] != 1
        || marker["experimental"] != true
        || marker["host_pid"].as_u64().is_none()
    {
        return Err(preflight("directory is not a marked experimental lab"));
    }
    let expected = RegistryScope::for_path(&root.join("codlet/config.json")).map_err(preflight)?;
    let actual =
        RegistryScope::for_path(&default_registry_path().map_err(preflight)?).map_err(preflight)?;
    if actual.id() != expected.id() {
        return Err(preflight(
            "plugin CLI environment does not select this lab registry; use the lab's Test-Plugins launcher",
        ));
    }
    let mut command = vec![OsStr::new("plugin").to_owned()];
    command.extend_from_slice(arguments);
    crate::probe::run_cli(command.into_iter()).map_err(runtime_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::{LocalPluginRegistration, Permission};

    #[test]
    fn local_catalog_is_prepared_without_execution_and_private_control_waits_for_startup() {
        let temporary = tempfile::tempdir().unwrap();
        let root = super::super::LabRoot::claim(&temporary.path().join("lab")).unwrap();
        let plugin = root.path.join("project/local-renderer");
        std::fs::create_dir(&plugin).unwrap();
        std::fs::write(plugin.join("codlet.json"), r#"{"schema":1,"id":"lab.local","version":"0.1.0","renderer":{"entry":"renderer.js","world":"isolated"},"permissions":["ui.dom"],"provides":[],"requires":[]}"#).unwrap();
        std::fs::write(
            plugin.join("renderer.js"),
            "throw new Error('must not execute during preparation');",
        )
        .unwrap();
        let mut registry = PluginRegistry::load(root.path.join("codlet/config.json")).unwrap();
        registry
            .register_local(
                "lab.local",
                LocalPluginRegistration {
                    path: std::fs::canonicalize(plugin).unwrap(),
                    grants: vec![Permission::UiDom],
                    broker_policy: Default::default(),
                },
            )
            .unwrap();
        registry.save().unwrap();
        let mut runtime = LabRuntime::prepare(registry.path().to_owned()).unwrap();
        assert!(
            runtime
                .renderer
                .logical_plugins()
                .iter()
                .any(|plugin| plugin.manifest.id == "lab.local")
        );
        assert!(runtime.hosts.is_none());
        assert!(runtime.os_broker.is_none());
        let request = PluginControlRequest {
            plugin_id: "lab.local".into(),
            action: crate::plugin_control::PluginControlAction::Reload,
            permission: None,
            cascade: false,
        };
        assert_eq!(
            crate::windows::control_pipe::query(
                runtime.server.scope(),
                &ControlRequest::prepare(request.clone())
            )
            .status,
            ControlStatus::NotReady
        );
        assert!(runtime.submit(request.clone()).is_err());
        runtime.control.set_ready();
        let receipt = runtime.submit(request).unwrap();
        assert_eq!(runtime.control.take_next().unwrap().operation_id, receipt);
        assert!(runtime.control.take_next().is_none());
    }
}
