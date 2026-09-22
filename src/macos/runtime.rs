use super::application::Application;
use super::control_pipe::{ControlServer, RegistryScope};
use super::launch_mutex::LaunchMutexGuard;
use super::lifecycle::{OwnedChild, ShutdownSignal};
use crate::catalog::PluginCatalog;
use crate::cdp::{CdpClient, TargetChange, TargetController, TargetSession};
use crate::host_control::HostControl;
use crate::host_runtime::{HostCoreServices, HostRuntime};
use crate::js_runtime::JsRuntime;
use crate::os_broker::OsBroker;
use crate::plugins::{PluginRegistry, default_registry_path};
use crate::renderer::RendererRuntime;
use crate::runtime_control::ControlBroker;
use crate::runtime_manage::RuntimeManageService;
use crate::runtime_status::{CodexStatus, StatusPublisher};
use std::collections::BTreeMap;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

pub fn launch(application: Application, watch: bool, safe_mode: bool) -> Result<()> {
    let shutdown_signal = ShutdownSignal::install()?;
    let scope = RegistryScope::for_path(&default_registry_path()?)?;
    let lease = scope.acquire(Duration::from_millis(1500))?;
    crate::runtime_log::initialize(scope.path());
    crate::plugin_cli::official_seed::recover(scope.path())?;
    // Validate plugins and prepare the fixed JS runtime before launching a client.
    let prepared = if safe_mode {
        None
    } else {
        let mut registry = PluginRegistry::load(scope.path())?;
        crate::managed_storage::prepare_installations(&mut registry)?;
        let catalog = PluginCatalog::load(&registry)?;
        let host_plugins = catalog
            .enabled_plugins(&registry)?
            .into_iter()
            .filter(|p| p.manifest.host.is_some())
            .collect::<Vec<_>>();
        HostRuntime::validate_plugins(&host_plugins)?;
        let traffic_required = crate::traffic_owner::required_for_plugins(&host_plugins);
        let launch_provider = traffic_required
            .then(|| crate::client_launch::select(&host_plugins).cloned())
            .transpose()?;
        let runtime = (traffic_required
            || host_plugins
                .iter()
                .any(|plugin| plugin.manifest.has_runtime_host()))
        .then(JsRuntime::discover)
        .transpose()?;
        let services = crate::core_services::SharedCoreServices::new(scope.path())?;
        let mut renderer = RendererRuntime::from_catalog(catalog, registry)?;
        renderer.enable_runtime_skill();
        let mut control = HostControl::new(scope.path().to_owned());
        control.seed_watch_sources(&renderer, &host_plugins);
        Some((renderer, control, runtime, services, launch_provider))
    };
    let launch_lease = LaunchMutexGuard::acquire_current_user(Duration::from_secs(5))?;
    application.revalidate()?;
    let running = application.running()?;
    if !running.is_empty() {
        return Err(format!(
            "Close the existing official client before starting Codlet; running process IDs: {:?}",
            running.iter().map(|p| p.pid).collect::<Vec<_>>()
        )
        .into());
    }
    // Declare before the child: every return retires that exact client before
    // destroying its private proxy and trust directory. Safe mode has no owner.
    let traffic = prepared
        .as_ref()
        .filter(|(_, _, _, _, provider)| provider.is_some())
        .map(|(_, _, runtime, services, provider)| {
            let runtime = runtime.as_ref().expect("traffic requires a Host runtime");
            let mut owner =
                crate::traffic_owner::TrafficOwner::start_cancellable(services, runtime, || {
                    shutdown_signal.requested()
                })?;
            owner.prepare_adapter(provider.as_ref().unwrap(), scope.path(), runtime)?;
            Ok::<_, crate::plugin_host::HostError>(owner)
        })
        .transpose()?;
    let status = StatusPublisher::new();
    let server = ControlServer::bind_current_user(lease, status.clone())?;
    let control = server.broker();
    let pipes = super::pipes::CdpPipes::new()?;
    if shutdown_signal.requested() {
        return Err("Codlet startup was interrupted".into());
    }
    let mut command = Command::new(&application.executable);
    if let Some(traffic) = &traffic {
        command
            .env_clear()
            .envs(traffic.environment().iter().cloned());
    }
    command
        .arg("--remote-debugging-pipe")
        .process_group(0)
        .current_dir(application.bundle.join("Contents/MacOS"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(traffic) = &traffic {
        command.args(traffic.arguments());
        traffic.stderr().configure(&mut command)?;
    }
    for (key, _) in std::env::vars_os() {
        let key_text = key.to_string_lossy().to_ascii_uppercase();
        if key_text.starts_with("DYLD_")
            || key_text.starts_with("NODE_")
            || key_text == "ELECTRON_RUN_AS_NODE"
        {
            command.env_remove(key);
        }
    }
    pipes.configure(&mut command)?;
    let mut child = OwnedChild::new(command.spawn()?);
    drop(command);
    let identity = super::identity::ProcessIdentity::inspect(child.id())?;
    if identity.executable != application.executable || identity.uid != unsafe { libc::geteuid() } {
        return Err("Launched application identity does not match the selected bundle".into());
    }
    if let Some(traffic) = &traffic {
        traffic.attach_client(child.id(), &application.executable, || {
            shutdown_signal.requested()
        })?;
    }
    status.set_codex(CodexStatus {
        pid: child.id(),
        package_full_name: application.identifier.clone(),
        package_version: application.version.clone(),
        executable: application.executable.to_string_lossy().into_owned(),
    });
    drop(launch_lease);
    let (client, events) = CdpClient::spawn(pipes.into_parent())?;
    println!(
        "Codlet {} · macOS ARM64 · client {} ({}) · PID {}",
        env!("CARGO_PKG_VERSION"),
        application.version,
        application.build,
        child.id()
    );
    let result = if let Some((mut renderer, host_control, js_runtime, plugin_services, _)) =
        prepared
    {
        renderer.set_status_publisher(status.clone());
        let manage = RuntimeManageService::new(control.clone())
            .with_local_management(scope.path().to_owned(), watch);
        if let Some(install) = std::env::current_exe()?.parent() {
            match crate::runtime_update::RuntimeUpdateService::start_with_preferences(
                install.to_owned(),
                scope.path().parent().unwrap().join("updates"),
                None,
                manage.preferences_for_start(),
            ) {
                Ok(service) => manage.set_runtime_update(service),
                Err(e) => crate::runtime_log::error("runtime_update_unavailable", &e.to_string()),
            }
        }
        super::client_versions::publish(&manage, &application.version);
        renderer.set_manage_service(manage.clone());
        let os = OsBroker::for_registry(scope.path().to_owned())?;
        renderer.set_core_services(plugin_services.clone())?;
        let hosts = HostRuntime::start_with_services(
            renderer.logical_plugins(),
            client.clone(),
            js_runtime,
            HostCoreServices {
                os_broker: Some(os.client()),
                runtime_manage: Some(manage.clone()),
                plugin_services: Some(plugin_services),
            },
        )?;
        renderer.set_host_capability_client(hosts.capability_client());
        let mut session = Session {
            renderer,
            hosts,
            _os: os,
            host_control,
            control,
            status: status.clone(),
            manage,
            watcher: None,
            authorization_error: None,
            stopped: false,
        };
        let activation = (|| {
            let (mut targets, initial) =
                TargetController::discover(client.clone(), events, Duration::from_secs(15))?;
            let mut sessions: BTreeMap<String, TargetSession> = initial
                .into_iter()
                .map(|s| (s.target_id().to_owned(), s))
                .collect();
            session.attach(&sessions)?;
            session.manage.start_plugin_update_checks();
            session.status.set_ready();
            session.control.set_ready();
            println!("runtime-state: ready");
            loop {
                if let Some(traffic) = &traffic {
                    traffic.check_alive()?;
                }
                if shutdown_signal.requested() {
                    session.stop()?;
                    request_quit(&sessions);
                    if !child.wait_for_exit(Duration::from_secs(5))? {
                        child.terminate()?;
                    }
                    return Ok(());
                }
                if let Some(exit) = child.try_wait()? {
                    return if exit.success() {
                        Ok(())
                    } else {
                        Err(format!("Official client exited with {exit}").into())
                    };
                }
                match targets.pump(Duration::ZERO) {
                    Ok(changes) => {
                        for change in changes {
                            let id = change.target_id().to_owned();
                            match &change {
                                TargetChange::Attached(target) => {
                                    sessions.insert(id.clone(), target.clone());
                                }
                                _ => {
                                    sessions.remove(&id);
                                }
                            }
                            if let Err(e) = session.renderer.apply_target_change(change) {
                                crate::runtime_log::error("renderer_target", &e.to_string());
                            }
                        }
                    }
                    Err(e) => {
                        if wait_briefly(&mut child)? {
                            return Ok(());
                        }
                        return Err(e.into());
                    }
                }
                session.pump(&sessions)?;
                std::thread::sleep(Duration::from_millis(10));
            }
        })();
        let cleanup = session.stop();
        activation.and(cleanup)
    } else {
        let recovery = crate::safe_mode::RecoverySession::new(
            scope.path().to_owned(),
            control,
            status.clone(),
        );
        recovery.ready();
        println!("runtime-state: safe-mode");
        while child.try_wait()?.is_none() {
            if shutdown_signal.requested() {
                recovery.stop("shutdown_requested");
                // Recovery does not attach plugin renderers. Discover only the
                // owned client's targets to use its ordinary application quit.
                if let Ok((_, sessions)) =
                    TargetController::discover(client.clone(), events, Duration::from_secs(3))
                {
                    request_quit(
                        &sessions
                            .into_iter()
                            .map(|s| (s.target_id().to_owned(), s))
                            .collect(),
                    );
                }
                if !child.wait_for_exit(Duration::from_secs(5))? {
                    child.terminate()?;
                }
                break;
            }
            recovery.pump();
            std::thread::sleep(Duration::from_millis(20));
        }
        recovery.stop("client_exited");
        Ok(())
    };
    status.terminate(if result.is_ok() {
        "client_exited"
    } else {
        "runtime_error"
    });
    let shutdown = client.shutdown().map_err(Into::into);
    result.and(shutdown)
}
fn wait_briefly(child: &mut OwnedChild) -> Result<bool> {
    let until = Instant::now() + Duration::from_millis(250);
    while Instant::now() < until {
        if child.try_wait()?.is_some() {
            return Ok(true);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(false)
}
fn request_quit(sessions: &BTreeMap<String, TargetSession>) {
    // The official Mac main process handles quit-app with app.quit(), just as
    // the audited Windows bridge does. The script checks the main document and
    // bridge before sending this one fixed message, with no relaunch request.
    let deadline = Instant::now() + Duration::from_secs(3);
    for target in sessions.values().filter(|target| target.is_live()) {
        if Instant::now() >= deadline {
            break;
        }
        if let Ok(result) = target
            .until(deadline)
            .evaluate(include_str!("../lab/quit.js"))
            && result
                .pointer("/result/value/status")
                .and_then(serde_json::Value::as_str)
                == Some("quit_requested")
        {
            break;
        }
    }
}
struct Session {
    renderer: RendererRuntime,
    hosts: HostRuntime,
    _os: OsBroker,
    host_control: HostControl,
    control: ControlBroker,
    status: StatusPublisher,
    manage: RuntimeManageService,
    watcher: Option<crate::plugin_watch::PluginWatcher>,
    authorization_error: Option<String>,
    stopped: bool,
}
impl Session {
    fn attach(&mut self, sessions: &BTreeMap<String, TargetSession>) -> Result<()> {
        self.renderer
            .set_external_observations(self.hosts.observations());
        for (_, result) in self.renderer.attach_all(
            &sessions
                .values()
                .filter(|s| s.is_live())
                .cloned()
                .collect::<Vec<_>>(),
        ) {
            result?;
        }
        Ok(())
    }
    fn pump(&mut self, sessions: &BTreeMap<String, TargetSession>) -> Result<()> {
        let observations = self.hosts.observations();
        self.renderer
            .set_external_observations(observations.clone());
        self.status
            .publish_host_observation(self.hosts.execution_snapshot());
        for diagnostic in self.hosts.take_diagnostics() {
            if let Some(error) = diagnostic.error {
                crate::runtime_log::error("host_plugin", &error);
            }
        }
        match self.host_control.reconcile_authorization(
            &mut self.renderer,
            &self.hosts,
            Instant::now(),
        ) {
            Ok(()) => self.authorization_error = None,
            Err(e) => {
                let message = e.to_string();
                if self.authorization_error.as_ref() != Some(&message) {
                    crate::runtime_log::error("plugin_authorization", &message);
                    self.authorization_error = Some(message);
                }
            }
        }
        self.renderer.pump_bindings()?;
        self.host_control
            .submit_self_disable_requests(&mut self.renderer, &self.control);
        self.host_control
            .poll(&mut self.renderer, &self.hosts, &self.control);
        if self.host_control.needs_renderer_executor() {
            let result = self.attach(sessions).map_err(|e| e.to_string());
            self.host_control.renderer_executor_result(result);
        }
        if !self.host_control.is_pending() {
            if let Some(job) = self.control.take_next() {
                if let Some(job) =
                    self.host_control
                        .dispatch(job, &mut self.renderer, &self.hosts, &self.control)
                {
                    let result = self.renderer.manage_plugin(job.request);
                    self.control.complete(&job.operation_id, result);
                }
            } else {
                crate::plugin_watch::configure_watcher(
                    &mut self.watcher,
                    self.manage.local_watch_enabled(),
                    self.renderer.registry_path(),
                );
                if !self.host_control.has_watch_receipt()
                    && let Some(watcher) = &mut self.watcher
                {
                    let mut sources = self.renderer.local_watch_sources();
                    sources.extend(self.host_control.local_watch_sources(&observations));
                    if let Some(selection) = watcher.poll_guarded(Instant::now(), &sources)
                        && let Err(e) = self
                            .host_control
                            .submit_watched(selection.clone(), &self.control)
                    {
                        watcher.not_attempted(&selection);
                        crate::runtime_log::error("plugin_watch", &e.to_string());
                    }
                    for diagnostic in watcher.take_diagnostics() {
                        crate::runtime_log::error("plugin_watch", &diagnostic.message);
                    }
                }
            }
        }
        for completed in self.host_control.take_watch_results() {
            if let Some(selection) = &completed.not_attempted
                && let Some(watcher) = &mut self.watcher
            {
                watcher.not_attempted(selection);
            }
        }
        for report in self.host_control.take_authorization_reports() {
            if let Some(message) = report.message {
                crate::runtime_log::error("plugin_authorization", &message);
            }
        }
        self.renderer.publish_status();
        self.renderer.refresh_management_list();
        for diagnostic in self.renderer.take_diagnostics() {
            crate::runtime_log::error("renderer_plugin", &diagnostic.message);
        }
        Ok(())
    }
    fn stop(&mut self) -> Result<()> {
        if self.stopped {
            return Ok(());
        }
        self.stopped = true;
        self.control.stop();
        self.renderer.stop_runtime_skill();
        for failure in self.renderer.retire_all_package_renderers() {
            crate::runtime_log::error("renderer_cleanup", &failure.error);
        }
        for report in self.hosts.stop()? {
            if let Err(error) = report.result {
                return Err(error.into());
            }
        }
        Ok(())
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        if let Err(e) = self.stop() {
            crate::runtime_log::error("runtime_cleanup", &e.to_string());
        }
    }
}
