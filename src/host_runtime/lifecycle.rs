//! Online lifecycle commands share the existing host RPC owner. Waiting for a
//! plugin's initialize/shutdown never suspends another plugin's Core requests.

use std::collections::BTreeMap;
use std::thread;

use super::*;

mod launcher;
use launcher::Launcher;

const COMMAND_QUEUE: usize = 8;
const MAX_OPERATIONS: usize = 16;
const MAX_RETIRED: usize = 64;
// Small identity tombstones prevent an old generation being replayed after its
// source/process record is released. Never evict a tombstone and permit reuse.
pub const MAX_HOST_IDENTITIES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostOperationResult {
    Started {
        plugin_id: String,
        generation: u64,
        process_id: u32,
    },
    Stopped {
        plugin_id: String,
        generation: u64,
        report: HostExitReport,
    },
}

/// Dropping a receipt does not cancel or undo an admitted operation. It owns no
/// thread and yields exactly one terminal result, including owner termination.
pub struct HostOperation {
    receiver: mpsc::Receiver<Result<HostOperationResult, HostError>>,
    delivered: bool,
}

impl HostOperation {
    pub fn try_result(&mut self) -> Option<Result<HostOperationResult, HostError>> {
        if self.delivered {
            return None;
        }
        let result = match self.receiver.try_recv() {
            Ok(result) => result,
            Err(mpsc::TryRecvError::Empty) => return None,
            Err(mpsc::TryRecvError::Disconnected) => Err(HostError::new(
                "owner_stopped",
                "the host lifecycle owner stopped before publishing its result",
            )),
        };
        self.delivered = true;
        Some(result)
    }
}

struct OperationPermit(Arc<AtomicUsize>);

impl Drop for OperationPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

pub(super) struct Completion {
    sender: mpsc::SyncSender<Result<HostOperationResult, HostError>>,
    _permit: OperationPermit,
}

impl Completion {
    fn finish(self, result: Result<HostOperationResult, HostError>) {
        let _ = self.sender.try_send(result);
    }
}

pub(super) enum Command {
    Start(Box<LoadedPlugin>, Completion),
    Stop(HostIdentity, Completion),
}

impl HostRuntime {
    /// Enqueues a validated source snapshot. Registry/grant reads, generation
    /// allocation and persistence belong to the caller, never this executor.
    pub fn begin_start(&self, plugin: LoadedPlugin) -> Result<HostOperation, HostError> {
        Self::validate_plugins(std::slice::from_ref(&plugin))?;
        self.submit(|completion| Command::Start(Box::new(plugin), completion))
    }

    pub fn begin_stop(
        &self,
        plugin_id: &str,
        expected_generation: u64,
    ) -> Result<HostOperation, HostError> {
        let identity = HostIdentity {
            plugin_id: plugin_id.into(),
            generation: expected_generation,
        };
        identity
            .validate()
            .map_err(|error| HostError::new("invalid_identity", error))?;
        self.submit(|completion| Command::Stop(identity, completion))
    }

    fn submit(
        &self,
        command: impl FnOnce(Completion) -> Command,
    ) -> Result<HostOperation, HostError> {
        if self.stopping.load(Ordering::Acquire) {
            return Err(HostError::new(
                "runtime_stopping",
                "the host runtime is stopping",
            ));
        }
        self.operations
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |pending| {
                (pending < MAX_OPERATIONS).then_some(pending + 1)
            })
            .map_err(|_| {
                HostError::new(
                    "operation_limit",
                    "too many pending host lifecycle operations",
                )
            })?;
        let permit = OperationPermit(Arc::clone(&self.operations));
        let (sender, receiver) = mpsc::sync_channel(1);
        self.commands
            .try_send(command(Completion {
                sender,
                _permit: permit,
            }))
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => HostError::new(
                    "operation_queue_full",
                    "the host lifecycle command queue is full",
                ),
                mpsc::TrySendError::Disconnected(_) => {
                    HostError::new("owner_stopped", "the host lifecycle owner stopped")
                }
            })?;
        Ok(HostOperation {
            receiver,
            delivered: false,
        })
    }
}

pub(super) fn launch(
    plugins: Vec<LoadedPlugin>,
    client: CdpClient,
    runtime: Option<JsRuntime>,
) -> Result<HostRuntime, HostError> {
    if !plugins.is_empty() && runtime.is_none() {
        return Err(HostError::new(
            "js_runtime_missing",
            "enabled host JS plugins require the managed runtime",
        ));
    }
    let published = Arc::new(Mutex::new(Published::default()));
    let stopping = Arc::new(AtomicBool::new(false));
    let operations = Arc::new(AtomicUsize::new(0));
    let (commands, receiver) = mpsc::sync_channel(COMMAND_QUEUE);
    let generations: BTreeMap<_, _> = plugins
        .iter()
        .map(|plugin| (plugin.manifest.id.clone(), plugin.generation))
        .collect();
    let owners: Vec<_> = plugins
        .into_iter()
        .map(|plugin| {
            HostOwner::start(plugin, runtime.as_ref().expect("validated initial runtime"))
        })
        .collect();
    let launcher = Launcher::new(runtime)?;
    publish(&published, &owners);
    let worker_published = Arc::clone(&published);
    let worker_stopping = Arc::clone(&stopping);
    let worker = thread::Builder::new()
        .name("codlet-core-host-rpc".into())
        .spawn(move || {
            let mut owners = owners;
            let mut generations = generations;
            let mut launcher = launcher;
            while !worker_stopping.load(Ordering::Acquire) {
                client.poll_raw_io();
                launcher.collect(&mut owners);
                // Commands only transfer ownership here. Snapshot/runtime IO and
                // process creation run on one separate, bounded launch worker.
                if let Ok(command) = receiver.try_recv() {
                    apply(command, &mut owners, &mut generations, &launcher);
                }
                for owner in &mut owners {
                    owner.pump(&client);
                }
                publish(&worker_published, &owners);
                for owner in &mut owners {
                    owner.finish_operations();
                }
                prune_retired(&mut owners);
                thread::sleep(TICK);
            }
            while let Ok(command) = receiver.try_recv() {
                let completion = match command {
                    Command::Start(_, completion) | Command::Stop(_, completion) => completion,
                };
                completion.finish(Err(HostError::new(
                    "runtime_stopping",
                    "the runtime stopped before this command was applied",
                )));
            }
            // All children receive shutdown before any cooperative wait. Global
            // runtime teardown preserves the existing finite stop/drop ownership.
            launcher.begin_shutdown();
            for owner in &mut owners {
                if owner.observation.state == ExecutionState::Starting {
                    owner.fail(HostError::new(
                        "runtime_stopping",
                        "runtime stopped during host initialization",
                    ));
                } else {
                    owner.begin_retirement();
                }
            }
            // A pending creation remains owned until its result is collected.
            // It must never deliver a process after a successful stop receipt.
            while owners.iter().any(|owner| owner.launching) {
                launcher.collect(&mut owners);
                for owner in &mut owners {
                    owner.pump(&client);
                }
                thread::sleep(TICK);
            }
            drop(launcher);
            let reports = owners.iter_mut().filter_map(HostOwner::stop).collect();
            publish(&worker_published, &owners);
            for owner in &mut owners {
                owner.finish_operations();
            }
            reports
        })
        .map_err(|error| HostError::new("owner_spawn_failed", error.to_string()))?;
    Ok(HostRuntime {
        published,
        stopping,
        commands,
        operations,
        worker: Some(worker),
    })
}

fn apply(
    command: Command,
    owners: &mut Vec<HostOwner>,
    generations: &mut BTreeMap<String, u64>,
    launcher: &Launcher,
) {
    match command {
        Command::Start(plugin, completion) => {
            let plugin = *plugin;
            let id = &plugin.manifest.id;
            if owners
                .iter()
                .any(|owner| owner.observation.plugin.manifest.id == *id && !owner.retired())
            {
                completion.finish(Err(HostError::new(
                    "host_busy",
                    "this plugin still owns a starting, active or stopping process",
                )));
                return;
            }
            if generations
                .get(id)
                .is_some_and(|generation| plugin.generation <= *generation)
            {
                completion.finish(Err(HostError::new(
                    "stale_generation",
                    "start must use a generation newer than every previous attempt",
                )));
                return;
            }
            if owners.iter().filter(|owner| !owner.retired()).count() >= MAX_HOSTS {
                completion.finish(Err(HostError::new(
                    "host_limit",
                    "at most 16 host processes may be owned at once",
                )));
                return;
            }
            if !generations.contains_key(id) && generations.len() >= MAX_HOST_IDENTITIES {
                completion.finish(Err(HostError::new(
                    "identity_limit",
                    "this runtime has exhausted its bounded host identity history",
                )));
                return;
            }
            generations.insert(id.clone(), plugin.generation);
            owners.retain(|owner| owner.observation.plugin.manifest.id != *id);
            let mut owner = HostOwner::new(plugin.clone());
            owner.launching = true;
            if let Err(error) = launcher.begin(plugin) {
                owner.launching = false;
                owner.fail(error);
            }
            owner.start_operation = Some(completion);
            owners.push(owner);
        }
        Command::Stop(identity, completion) => {
            if generations
                .get(&identity.plugin_id)
                .is_some_and(|generation| identity.generation != *generation)
            {
                completion.finish(Err(HostError::new(
                    "stale_generation",
                    "stop generation does not match the latest owned generation",
                )));
                return;
            }
            let Some(owner) = owners.iter_mut().find(|owner| {
                owner.observation.plugin.manifest.id == identity.plugin_id
                    && owner.observation.plugin.generation == identity.generation
            }) else {
                completion.finish(Err(HostError::new(
                    "host_not_running",
                    "this generation has no retained host process",
                )));
                return;
            };
            if owner.stop_operation.is_some() {
                completion.finish(Err(HostError::new(
                    "host_busy",
                    "this generation already has a pending stop operation",
                )));
                return;
            }
            owner.stop_operation = Some(completion);
            if owner.observation.state == ExecutionState::Starting {
                owner.fail(HostError::new(
                    "initialize_cancelled",
                    "host stopped before initialization completed",
                ));
            } else if !owner.retired() {
                owner.begin_retirement();
            }
        }
    }
}

impl HostOwner {
    fn retired(&self) -> bool {
        !self.launching && self.supervisor.is_none() && self.invocation.is_none()
    }

    fn finish_operations(&mut self) {
        if self.launching
            && self.observation.state == ExecutionState::Starting
            && Instant::now() >= self.initialize_deadline
        {
            self.fail(HostError::new(
                "launch_timeout",
                "host process creation did not finish within its startup deadline",
            ));
        }
        if self.observation.state == ExecutionState::Active {
            if let Some(completion) = self.start_operation.take() {
                completion.finish(Ok(HostOperationResult::Started {
                    plugin_id: self.observation.plugin.manifest.id.clone(),
                    generation: self.observation.plugin.generation,
                    process_id: self
                        .observation
                        .process_id
                        .expect("active host has a process"),
                }));
            }
        } else if self.retired() {
            if let Some(completion) = self.start_operation.take() {
                completion.finish(Err(self.failure.clone().unwrap_or_else(|| {
                    HostError::new("initialize_failed", "host retired before activation")
                })));
            }
        } else if self
            .stop_deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            let failure = || {
                HostError::new(
                    "cleanup_incomplete",
                    "the plugin Job/process/IO retirement deadline expired; its generation is still owned and cannot be replaced",
                )
            };
            if let Some(completion) = self.start_operation.take() {
                completion.finish(Err(failure()));
            }
            if let Some(completion) = self.stop_operation.take() {
                completion.finish(Err(failure()));
            }
        }
        if self.retired()
            && let Some(completion) = self.stop_operation.take()
        {
            completion.finish(match &self.stop_report {
                Some(report) => report
                    .result
                    .clone()
                    .map(|report| HostOperationResult::Stopped {
                        plugin_id: self.observation.plugin.manifest.id.clone(),
                        generation: self.observation.plugin.generation,
                        report,
                    }),
                None => Err(HostError::new(
                    "host_not_running",
                    "this generation did not create a process",
                )),
            });
        }
    }
}

fn prune_retired(owners: &mut Vec<HostOwner>) {
    let mut excess = owners
        .iter()
        .filter(|owner| owner.retired())
        .count()
        .saturating_sub(MAX_RETIRED);
    owners.retain(|owner| {
        if excess > 0
            && owner.retired()
            && owner.start_operation.is_none()
            && owner.stop_operation.is_none()
        {
            excess -= 1;
            false
        } else {
            true
        }
    });
}
