//! A single preparation worker isolates disk/runtime verification and OS process
//! creation from the thread serving every live plugin's Core RPC.

use super::*;

pub(super) struct Launcher {
    requests: Option<mpsc::SyncSender<LoadedPlugin>>,
    results: Option<mpsc::Receiver<HostOwner>>,
    stopping: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Launcher {
    pub(super) fn new(
        runtime: Option<JsRuntime>,
        services: services::CoreServices,
    ) -> Result<Self, HostError> {
        let mut runtime = runtime;
        Self::with_prepare(move |plugin| {
            let ready = if runtime.is_none() {
                JsRuntime::discover().map(|value| runtime = Some(value))
            } else {
                Ok(())
            };
            match ready {
                Ok(()) => HostOwner::start_with_services(
                    plugin,
                    runtime.as_ref().unwrap(),
                    services.clone(),
                ),
                Err(error) => {
                    let mut owner = HostOwner::new(plugin);
                    owner.fail(error);
                    owner
                }
            }
        })
    }

    fn with_prepare(
        mut prepare: impl FnMut(LoadedPlugin) -> HostOwner + Send + 'static,
    ) -> Result<Self, HostError> {
        let (requests, receiver) = mpsc::sync_channel(MAX_HOSTS);
        let (sender, results) = mpsc::sync_channel(1);
        let stopping = Arc::new(AtomicBool::new(false));
        let worker_stopping = Arc::clone(&stopping);
        let worker = thread::Builder::new()
            .name("codlet-host-launch".into())
            .spawn(move || {
                while let Ok(plugin) = receiver.recv() {
                    let mut owner = if worker_stopping.load(Ordering::Acquire) {
                        let mut owner = HostOwner::new(plugin);
                        owner.fail(HostError::new(
                            "runtime_stopping",
                            "runtime stopped before process creation",
                        ));
                        owner
                    } else {
                        prepare(plugin)
                    };
                    if worker_stopping.load(Ordering::Acquire) {
                        owner.fail(HostError::new(
                            "runtime_stopping",
                            "runtime stopped during process creation",
                        ));
                    }
                    // If the RPC owner is unwinding, dropping the failed send's owner
                    // still stops/joins its process and IO before this worker exits.
                    if sender.send(owner).is_err() {
                        break;
                    }
                }
            })
            .map_err(|error| HostError::new("launch_worker_failed", error.to_string()))?;
        Ok(Self {
            requests: Some(requests),
            results: Some(results),
            stopping,
            worker: Some(worker),
        })
    }

    pub(super) fn begin(&self, plugin: LoadedPlugin) -> Result<(), HostError> {
        self.requests
            .as_ref()
            .ok_or_else(|| HostError::new("runtime_stopping", "the launch worker is stopping"))?
            .try_send(plugin)
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => HostError::new(
                    "launch_queue_full",
                    "the host process creation queue is full",
                ),
                mpsc::TrySendError::Disconnected(_) => HostError::new(
                    "launch_worker_stopped",
                    "the host process creation worker stopped",
                ),
            })
    }

    pub(super) fn collect(&self, owners: &mut [HostOwner]) {
        let Some(results) = &self.results else {
            return;
        };
        loop {
            match results.try_recv() {
                Ok(mut created) => {
                    let identity = &created.observation.plugin;
                    if let Some(owner) = owners.iter_mut().find(|owner| {
                        owner.launching
                            && owner.observation.plugin.manifest.id == identity.manifest.id
                            && owner.observation.plugin.generation == identity.generation
                    }) {
                        created.start_operation = owner.start_operation.take();
                        created.stop_operation = owner.stop_operation.take();
                        if let Some(error) = owner.failure.take() {
                            // This is the already-requested retirement arriving
                            // with a late creation, not a new protocol fault.
                            if created.failure.is_none() {
                                created.observation.error = Some(error.to_string());
                                created.failure = Some(error);
                            }
                            created.begin_retirement();
                        } else if owner.observation.state == ExecutionState::Stopping {
                            created.begin_retirement();
                        }
                        if let Some(deadline) = owner.stop_deadline {
                            created.stop_deadline = Some(
                                created
                                    .stop_deadline
                                    .map_or(deadline, |created| created.min(deadline)),
                            );
                        }
                        *owner = created;
                    }
                    // An unmatched result can never attach itself to another
                    // generation. Its owner drops here and reclaims the process.
                }
                Err(mpsc::TryRecvError::Empty) => return,
                Err(mpsc::TryRecvError::Disconnected) => {
                    for owner in owners.iter_mut().filter(|owner| owner.launching) {
                        owner.launching = false;
                        owner.fail(HostError::new(
                            "launch_worker_stopped",
                            "the process creation worker stopped before returning this generation",
                        ));
                    }
                    return;
                }
            }
        }
    }

    pub(super) fn begin_shutdown(&mut self) {
        self.stopping.store(true, Ordering::Release);
        self.requests.take();
    }
}

impl Drop for Launcher {
    fn drop(&mut self) {
        self.begin_shutdown();
        // Disconnect before joining, so a queued creation result cannot leave
        // the worker waiting for an RPC owner that is itself unwinding.
        self.results.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::path::PathBuf;

    use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
    };

    use super::*;

    fn receipt() -> (Completion, HostOperation) {
        let (sender, receiver) = mpsc::sync_channel(1);
        (
            Completion {
                sender,
                _permit: OperationPermit(Arc::new(AtomicUsize::new(1))),
            },
            HostOperation {
                receiver,
                delivered: false,
            },
        )
    }

    #[test]
    fn retirement_waits_for_a_delayed_creation_result_on_stop_shutdown_or_launch_timeout() {
        for mode in ["stop", "runtime", "timeout"] {
            let directory = tempfile::tempdir().unwrap();
            std::fs::write(
                directory.path().join("host.js"),
                "module.exports={activate(){},deactivate(){}};",
            )
            .unwrap();
            std::fs::write(directory.path().join("codlet.json"), json!({"schema":1,"id":"dev.delayed-launch","version":"1","host":{"entry":"host.js"},"permissions":["host.process"]}).to_string()).unwrap();
            let plugin = crate::local_plugins::load_local_plugin(
                "dev.delayed-launch",
                directory.path(),
                &[Permission::HostProcess],
                1,
            )
            .unwrap();
            let runtime = JsRuntime::discover().unwrap();
            let (entered_sender, entered) = mpsc::sync_channel(1);
            let (resume, paused) = mpsc::sync_channel(1);
            let (created_sender, created) = mpsc::sync_channel(1);
            let mut launcher = Launcher::with_prepare(move |plugin| {
                entered_sender.send(()).unwrap();
                paused.recv().unwrap();
                let owner = HostOwner::start(plugin, &runtime);
                let handle = unsafe {
                    OpenProcess(
                        PROCESS_SYNCHRONIZE,
                        0,
                        owner.observation.process_id.unwrap(),
                    )
                };
                assert!(!handle.is_null());
                let handle = unsafe { OwnedHandle::from_raw_handle(handle.cast()) };
                let snapshot =
                    PathBuf::from(owner.invocation.as_ref().unwrap().arguments.last().unwrap());
                created_sender.send((handle, snapshot)).unwrap();
                owner
            })
            .unwrap();
            let mut owners = Vec::new();
            let mut generations = BTreeMap::new();
            let (completion, mut starting) = receipt();
            apply(
                Command::Start(Box::new(plugin), completion),
                &mut owners,
                &mut generations,
                &launcher,
            );
            entered.recv_timeout(Duration::from_secs(2)).unwrap();
            assert!(owners[0].launching && owners[0].observation.process_id.is_none());
            let mut stopping = if mode == "stop" {
                let (completion, stopping) = receipt();
                apply(
                    Command::Stop(
                        HostIdentity {
                            plugin_id: "dev.delayed-launch".into(),
                            generation: 1,
                        },
                        completion,
                    ),
                    &mut owners,
                    &mut generations,
                    &launcher,
                );
                Some(stopping)
            } else if mode == "runtime" {
                launcher.begin_shutdown();
                owners[0].fail(HostError::new(
                    "runtime_stopping",
                    "runtime stopped during creation",
                ));
                None
            } else {
                owners[0].initialize_deadline = Instant::now();
                None
            };
            owners[0].finish_operations();
            assert_eq!(owners[0].observation.state, ExecutionState::Stopping);
            assert!(
                starting.try_result().is_none()
                    && stopping
                        .as_mut()
                        .is_none_or(|operation| operation.try_result().is_none())
            );
            // The launch worker is deliberately held before CreateProcess, so
            // this covers a pending creation rather than just pending activate.
            std::thread::sleep(Duration::from_millis(25));
            assert!(
                starting.try_result().is_none()
                    && stopping
                        .as_mut()
                        .is_none_or(|operation| operation.try_result().is_none())
            );
            resume.send(()).unwrap();
            let (process, snapshot) = created.recv_timeout(Duration::from_secs(2)).unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                launcher.collect(&mut owners);
                owners[0].pump_retirement();
                owners[0].finish_operations();
                if owners[0].retired() {
                    break;
                }
                assert!(Instant::now() < deadline);
                std::thread::sleep(TICK);
            }
            let report = owners[0]
                .stop_report
                .as_ref()
                .unwrap()
                .result
                .as_ref()
                .unwrap();
            if let Some(stopping) = &mut stopping {
                assert!(matches!(
                    stopping.try_result().unwrap().unwrap(),
                    HostOperationResult::Stopped { .. }
                ));
            }
            assert!(report.workers_reaped && !report.forced && report.exit_code == 0);
            assert_eq!(
                unsafe { WaitForSingleObject(process.as_raw_handle().cast(), 0) },
                WAIT_OBJECT_0
            );
            assert!(!snapshot.exists());
            assert!(owners[0].retired());
            let expected = match mode {
                "stop" => "initialize_cancelled",
                "runtime" => "runtime_stopping",
                _ => "launch_timeout",
            };
            assert_eq!(starting.try_result().unwrap().unwrap_err().code, expected);
            assert!(
                starting.try_result().is_none()
                    && stopping
                        .as_mut()
                        .is_none_or(|operation| operation.try_result().is_none())
            );
        }
    }
}
