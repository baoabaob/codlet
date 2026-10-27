//! Opt-in real desktop acceptance. This never runs in the normal test suite or
//! ships in Core. The coordinator provides an isolated profile and owned backend.
use super::*;
#[cfg(not(test))]
use base64::Engine;
use serde_json::json;
use std::io::Write;
use std::os::windows::io::AsRawHandle;

#[link(name = "kernel32")]
unsafe extern "system" {
    #[link_name = "GetTickCount64"]
    fn acceptance_tick_count_ms() -> u64;
}

#[derive(Clone)]
struct AcceptanceTrace {
    started: Instant,
    sender: Option<std::sync::mpsc::Sender<Value>>,
    call: std::sync::Arc<std::sync::atomic::AtomicU64>,
    writer: std::sync::Arc<std::sync::Mutex<Option<std::thread::JoinHandle<()>>>>,
}

impl AcceptanceTrace {
    fn start(root: &Path) -> Self {
        let started = Instant::now();
        let writer = std::sync::Arc::new(std::sync::Mutex::new(None));
        let sender = (|| -> std::io::Result<_> {
            let path = root.join("observer-timeline.jsonl");
            let (sender, receiver) = std::sync::mpsc::channel::<Value>();
            let worker = std::thread::Builder::new()
                .name("acceptance-phase-log".into())
                .spawn(move || {
                    let mut file = match std::fs::OpenOptions::new()
                        .create_new(true)
                        .write(true)
                        .open(path)
                    {
                        Ok(file) => file,
                        Err(error) => {
                            eprintln!("acceptance phase log unavailable: {error}");
                            return;
                        }
                    };
                    for (index, mut event) in receiver.into_iter().enumerate() {
                        event["line"] = json!(index + 1);
                        let mut bytes = serde_json::to_vec(&event).expect("phase JSON");
                        bytes.push(b'\n');
                        if let Err(error) = file.write_all(&bytes) {
                            eprintln!("acceptance phase log: {error}");
                            break;
                        }
                    }
                })?;
            *writer.lock().unwrap() = Some(worker);
            Ok(sender)
        })()
        .map_err(|error| eprintln!("acceptance phase log unavailable: {error}"))
        .ok();
        Self {
            started,
            sender,
            call: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(1)),
            writer,
        }
    }

    fn record(&self, event: &str, details: Value) {
        let Some(sender) = &self.sender else { return };
        let elapsed = self.started.elapsed().as_millis();
        let wall = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .map(|duration| duration.as_millis());
        // SAFETY: GetTickCount64 takes no pointers and is available on supported Windows.
        let tick = unsafe { acceptance_tick_count_ms() };
        // The caller never waits for disk I/O. One writer emits complete JSONL
        // records for all threads; telemetry errors do not change any outcome.
        let _ = sender.send(json!({"event":event,"elapsedMs":elapsed,"wallUnixMs":wall,"tickCountMs":tick,"details":details}));
    }

    #[cfg(not(test))]
    fn request(
        &self,
        stage: &str,
        client: &CdpClient,
        method: &str,
        params: Option<Value>,
        session_id: Option<&str>,
        deadline: Duration,
    ) -> Result<crate::cdp::CdpResponse, crate::cdp::ClientError> {
        let call = self.call.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.record("cdp.begin", json!({"stage":stage,"call":call,"method":method,"sessionId":session_id,"budgetMs":deadline.as_millis()}));
        let result = client.request(method, params, session_id, deadline);
        let error = result.as_ref().err().map(|error| match error {
            crate::cdp::ClientError::Connection(reason) => json!({"kind":"connection","shutdown":matches!(reason.as_ref(),crate::cdp::ConnectionError::Shutdown)}),
            crate::cdp::ClientError::RequestTimedOut { .. } => json!({"kind":"timeout"}),
            crate::cdp::ClientError::Remote { error_code, .. } => json!({"kind":"remote","code":error_code}),
            crate::cdp::ClientError::SessionEnded(_) => json!({"kind":"session_ended"}),
            _ => json!({"kind":"request_rejected"}),
        });
        self.record("cdp.end",json!({"stage":stage,"call":call,"method":method,"sessionId":session_id,"received":result.is_ok(),"error":error}));
        result
    }

    fn finish(mut self) {
        // Called after both observed workers have joined and Native exit has
        // already been observed. No request/Native/quit budget waits on this log.
        drop(self.sender.take());
        let worker = self.writer.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(worker) = worker {
            let _ = worker.join();
        }
    }
}

fn write_latest_probe(root: &Path, sample: &Value) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_NORMAL, ReplaceFileW, SetFileAttributesW,
    };
    let mut temporary = tempfile::NamedTempFile::new_in(root)?;
    temporary.write_all(&serde_json::to_vec_pretty(sample).expect("probe sample JSON"))?;
    temporary.flush()?;
    let (file, temporary) = temporary.into_parts();
    drop(file);
    let destination = root.join("probe-latest.json");
    if !destination.try_exists()? {
        return temporary.persist(destination).map_err(|error| error.error);
    }
    // ReplaceFile supports an observer retaining a delete-sharing snapshot.
    // Closing the temporary handle also permits its exclusive replacement open.
    let source: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: both paths are live, NUL-terminated names in this owned report
    // directory. Optional pointers are null; flags preserve normal ACL checks.
    if unsafe { SetFileAttributesW(source.as_ptr(), FILE_ATTRIBUTE_NORMAL) } == 0
        || unsafe {
            ReplaceFileW(
                destination.as_ptr(),
                source.as_ptr(),
                std::ptr::null(),
                0,
                std::ptr::null(),
                std::ptr::null(),
            )
        } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(test))]
const SKILL_FACTS_COLLECTOR: &str = "codlet.vm.skill-facts.20261027";

struct SkillFactsRequest {
    run_id: String,
    sample_id: String,
    client_id: String,
    client_epoch: u64,
    authority_id: Option<String>,
    anchors: Value,
}

impl SkillFactsRequest {
    fn parse(value: &Value) -> Result<Self, &'static str> {
        let invalid = "skill_facts_capture_invalid";
        let run_id = value["runId"].as_str().ok_or(invalid)?;
        let suffix = run_id.strip_prefix("vm-20261027-").ok_or(invalid)?;
        if value["api"] != 1
            || suffix.len() != 36
            || !suffix
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        {
            return Err(invalid);
        }
        let sample_id = value["sampleId"].as_str().ok_or(invalid)?;
        let label = sample_id
            .strip_prefix(run_id)
            .and_then(|value| value.strip_prefix(":skills-"))
            .filter(|value| !value.is_empty())
            .ok_or(invalid)?;
        if !label
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err(invalid);
        }
        let client_id = value["clientId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or(invalid)?;
        let client_epoch = value["clientEpoch"]
            .as_u64()
            .filter(|epoch| *epoch <= 9_007_199_254_740_991)
            .ok_or(invalid)?;
        let authority_id = match &value["authorityId"] {
            Value::Null => None,
            Value::String(id) if !id.is_empty() => Some(id.clone()),
            _ => return Err(invalid),
        };
        let anchors = value["anchors"].as_array().ok_or(invalid)?;
        if !anchors.iter().all(|anchor| {
            (anchor["id"].as_str().is_some_and(|id| !id.is_empty())
                || anchor["id"]
                    .as_i64()
                    .is_some_and(|id| id.unsigned_abs() <= 9_007_199_254_740_991))
                && anchor["method"]
                    .as_str()
                    .is_some_and(|method| !method.is_empty())
        }) {
            return Err(invalid);
        }
        Ok(Self {
            run_id: run_id.into(),
            sample_id: sample_id.into(),
            client_id: client_id.into(),
            client_epoch,
            authority_id,
            anchors: value["anchors"].clone(),
        })
    }
}

fn verified_skill_fact(
    request: &SkillFactsRequest,
    fact: Value,
    completion: &Value,
) -> Result<Value, &'static str> {
    if completion["accepted"] != true || completion["sampleId"] != request.sample_id {
        return Err("skill_facts_owner_changed");
    }
    if !matches!(
        fact["status"].as_str(),
        Some("observed" | "unobserved" | "retired" | "unknown")
    ) {
        return Err("skill_facts_observation_invalid");
    }
    // Identity acceptance confirms only the capture. Unknown Native outcomes
    // retain their original status and are never interpreted as an empty list.
    Ok(fact)
}

fn synthetic_skill_facts_profile(root: &Path, codex_home: &Path) -> bool {
    codex_home.starts_with(root)
        && std::fs::read(codex_home.join("auth.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .is_some_and(|auth| auth == json!({"OPENAI_API_KEY":"codlet-offline-acceptance"}))
}

#[derive(Clone, PartialEq, Eq)]
struct SkillFactsContext {
    target_id: String,
    session_id: String,
    frame_id: String,
    context_id: u64,
}

fn skill_context_retired(event: &crate::cdp::CdpEvent, context: &SkillFactsContext) -> bool {
    let params = event.params.as_ref().unwrap_or(&Value::Null);
    if event.method == "Target.detachedFromTarget" {
        return params["sessionId"] == context.session_id;
    }
    if event.method == "Target.targetDestroyed" {
        return params["targetId"] == context.target_id;
    }
    if event.session_id.as_deref() != Some(context.session_id.as_str()) {
        return false;
    }
    match event.method.as_str() {
        "Runtime.executionContextsCleared" | "Inspector.detached" => true,
        "Runtime.executionContextDestroyed" => {
            params["executionContextId"].as_u64() == Some(context.context_id)
        }
        "Runtime.executionContextCreated" => {
            params.pointer("/context/auxData/isDefault") == Some(&Value::Bool(true))
                && params
                    .pointer("/context/auxData/frameId")
                    .and_then(Value::as_str)
                    == Some(context.frame_id.as_str())
        }
        "Page.frameDetached" => params["frameId"] == context.frame_id,
        "Page.frameNavigated" => {
            params.pointer("/frame/id").and_then(Value::as_str) == Some(context.frame_id.as_str())
                || params.pointer("/frame/parentId").is_none()
        }
        _ => false,
    }
}

#[cfg(not(test))]
fn check_skill_context(
    client: &CdpClient,
    status: &StatusPublisher,
    context: &SkillFactsContext,
    events: &CdpEventStream,
    trace: &AcceptanceTrace,
) -> Result<(), String> {
    let observed = skill_facts_context(client, status, &context.session_id, trace)?;
    trace.record("skill.context.drain.begin", json!({}));
    let mut drained = 0_u64;
    loop {
        match events.recv_timeout(Duration::ZERO) {
            Ok(event) if skill_context_retired(&event, context) => {
                trace.record(
                    "skill.context.drain.end",
                    json!({"drained":drained,"retired":true}),
                );
                return Err("skill_facts_context_changed".into());
            }
            Ok(_) => drained += 1,
            Err(crate::cdp::EventStreamError::Timeout) => break,
            Err(_) => {
                trace.record(
                    "skill.context.drain.end",
                    json!({"drained":drained,"disconnected":true}),
                );
                return Err("skill_facts_target_retired".into());
            }
        }
    }
    trace.record(
        "skill.context.drain.end",
        json!({"drained":drained,"retired":false}),
    );
    if observed != *context {
        return Err("skill_facts_context_changed".into());
    }
    Ok(())
}

#[cfg(not(test))]
fn skill_facts_context(
    client: &CdpClient,
    status: &StatusPublisher,
    session_id: &str,
    trace: &AcceptanceTrace,
) -> Result<SkillFactsContext, String> {
    let snapshot = status.snapshot();
    let target = snapshot
        .renderer
        .targets
        .iter()
        .find(|target| target.session_id == session_id && target.session_live)
        .ok_or("skill_facts_target_retired")?;
    let response = trace
        .request(
            "skill.main-context",
            client,
            "Page.getFrameTree",
            None,
            Some(session_id),
            Duration::from_secs(3),
        )
        .map_err(|_| "skill_facts_context_unavailable")?;
    if response.error.is_some() {
        return Err("skill_facts_context_unavailable".into());
    }
    let frame_id = response
        .result
        .as_ref()
        .and_then(|result| result.pointer("/frameTree/frame/id"))
        .and_then(Value::as_str)
        .ok_or("skill_facts_context_unavailable")?;
    let context_id = client
        .default_context(session_id, frame_id)
        .ok_or("skill_facts_context_unavailable")?;
    Ok(SkillFactsContext {
        target_id: target.target_id.clone(),
        session_id: session_id.into(),
        frame_id: frame_id.into(),
        context_id,
    })
}

#[cfg(not(test))]
fn evaluate_skill_collector(
    client: &CdpClient,
    context: &SkillFactsContext,
    expression: String,
    stage: &str,
    trace: &AcceptanceTrace,
) -> Result<Value, String> {
    let response = trace
        .request(
            stage,
            client,
            "Runtime.evaluate",
            Some(json!({"expression":expression,"contextId":context.context_id,"awaitPromise":true,"returnByValue":true})),
            Some(&context.session_id),
            Duration::from_secs(10),
        )
        .map_err(|_| "skill_facts_collector_unavailable")?;
    if response.error.is_some() {
        return Err("skill_facts_collector_unavailable".into());
    }
    let result = response.result.ok_or("skill_facts_collector_unavailable")?;
    if result.get("exceptionDetails").is_some() {
        return Err("skill_facts_collector_failed".into());
    }
    result
        .pointer("/result/value")
        .cloned()
        .ok_or_else(|| "skill_facts_collector_unavailable".into())
}

#[cfg(not(test))]
fn collect_skill_fact(
    client: &CdpClient,
    status: &StatusPublisher,
    session_id: &str,
    source: Option<&crate::client_bridge::ClientSourceRuntime>,
    trace: &AcceptanceTrace,
) -> Option<Value> {
    // No request is dequeued until the exact current main default context exists.
    let events = client.subscribe_events(Some(session_id));
    let context = skill_facts_context(client, status, session_id, trace).ok()?;
    // Events before capture establish the initial context. Events after this
    // point permanently invalidate the capture, even if CDP reuses its numbers.
    trace.record("skill.initial-drain.begin", json!({}));
    let mut drained = 0_u64;
    while events.recv_timeout(Duration::ZERO).is_ok() {
        drained += 1;
    }
    trace.record("skill.initial-drain.end", json!({"drained":drained}));
    let context_valid = std::cell::Cell::new(true);
    let check = || {
        if !context_valid.get() {
            return Err("skill_facts_context_changed".into());
        }
        let result = check_skill_context(client, status, &context, &events, trace);
        if result.is_err() {
            context_valid.set(false);
        }
        result
    };
    let collector = format!("globalThis[Symbol.for({})]", json!(SKILL_FACTS_COLLECTOR));
    let capture = evaluate_skill_collector(
        client,
        &context,
        format!("{collector}?.captureNext() ?? null"),
        "skill.capture",
        trace,
    )
    .ok()?;
    if capture.is_null() {
        return None;
    }
    let sample_id = capture["sampleId"].as_str().map(str::to_owned);
    let result = (|| -> Result<Value, String> {
        let request = SkillFactsRequest::parse(&capture).map_err(str::to_owned)?;
        check()?;
        let fact = match source {
            Some(source) => {
                trace.record("skill.roots.begin", json!({"sampleId":request.sample_id}));
                let observed = source.skill_roots_snapshot(
                    &request.client_id,
                    request.client_epoch,
                    &request.anchors,
                    request.authority_id.as_deref(),
                );
                trace.record("skill.roots.end",json!({"sampleId":request.sample_id,"status":observed.as_ref().ok().and_then(|fact|fact["status"].as_str()),"error":observed.as_ref().err().map(|error|error.code)}));
                observed.map_err(|error| error.code.to_owned())?
            }
            None => json!({"status":"unobserved","reason":"retained_source_unavailable"}),
        };
        check()?;
        let completion = evaluate_skill_collector(
            client,
            &context,
            format!("{collector}?.complete({},{fact})", json!(request.sample_id)),
            "skill.complete",
            trace,
        )?;
        check()?;
        let fact = verified_skill_fact(&request, fact, &completion).map_err(str::to_owned)?;
        Ok(
            json!({"api":1,"runId":request.run_id,"sampleId":request.sample_id,"clientId":request.client_id,"clientEpoch":request.client_epoch,"targetId":context.target_id,"sessionId":context.session_id,"contextId":context.context_id,"identityValidated":true,"fact":fact}),
        )
    })();
    Some(match result {
        Ok(receipt) => receipt,
        Err(reason) => {
            // Never evaluate another target/context to release an old capture.
            // A destroyed context retires its diagnostic captures with the realm.
            if let Some(sample_id) = &sample_id
                && check().is_ok()
            {
                let _ = evaluate_skill_collector(
                    client,
                    &context,
                    format!(
                        "{collector}?.cancel({},{})",
                        json!(sample_id),
                        json!(reason)
                    ),
                    "skill.cancel",
                    trace,
                );
            }
            json!({"api":1,"runId":capture["runId"],"sampleId":sample_id,"targetId":context.target_id,"sessionId":context.session_id,"contextId":context.context_id,"identityValidated":false,"status":"unknown","reason":reason})
        }
    })
}

fn stop_acceptance_at_deadline(
    process: &std::os::windows::io::OwnedHandle,
    completion: &std::sync::mpsc::Receiver<()>,
    timeout: Duration,
    root: &std::path::Path,
    trace: &AcceptanceTrace,
) -> bool {
    trace.record(
        "watchdog.wait.begin",
        json!({"timeoutMs":timeout.as_millis()}),
    );
    let reason = match completion.recv_timeout(timeout) {
        Ok(()) => {
            trace.record("watchdog.wait.end", json!({"completed":true}));
            return false;
        }
        Err(reason) => reason,
    };
    trace.record("watchdog.wait.end",json!({"completed":false,"timedOut":matches!(reason,std::sync::mpsc::RecvTimeoutError::Timeout)}));
    trace.record("watchdog.terminate.begin", json!({"exitCode":124}));
    // SAFETY: the caller retained the newly launched test process handle.
    let terminated = unsafe {
        windows_sys::Win32::System::Threading::TerminateProcess(process.as_raw_handle(), 124)
    } != 0;
    let error = (!terminated).then(std::io::Error::last_os_error);
    trace.record("watchdog.terminate.end", json!({"requested":terminated,"errorCode":error.as_ref().and_then(std::io::Error::raw_os_error)}));
    let receipt = json!({
        "timedOut":matches!(reason, std::sync::mpsc::RecvTimeoutError::Timeout),
        "normalShutdown":false,"exitCode":124,"terminationRequested":terminated,
        "terminationError":error.map(|error|error.to_string())
    });
    // A report-writing failure must not prevent cleanup of the owned child.
    if let Err(error) = std::fs::write(root.join("watchdog.json"), receipt.to_string()) {
        eprintln!("acceptance deadline report: {error}");
    }
    true
}

#[cfg(not(test))]
pub(super) fn isolated_full_runtime() {
    let creator_package = crate::windows::package_launch::package_full_name(unsafe {
        windows_sys::Win32::System::Threading::GetCurrentProcess()
    })
    .expect("creator package identity");
    assert!(
        creator_package.is_none(),
        "run acceptance from an ordinary unpackaged process; a pre-supplied package context hides startup defects"
    );
    let root = PathBuf::from(std::env::var_os("CODLET_ACCEPTANCE_ROOT").expect("acceptance root"));
    assert!(root.is_absolute());
    assert_eq!(
        std::fs::read_to_string(root.join("owner.txt")).unwrap(),
        "codlet-desktop-acceptance\n"
    );
    for key in [
        "CODLET_HOME",
        "CODEX_HOME",
        "CODEX_SQLITE_HOME",
        "CODEX_ELECTRON_USER_DATA_PATH",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
    ] {
        assert!(
            PathBuf::from(std::env::var_os(key).expect(key)).starts_with(&root),
            "{key} must be isolated"
        );
    }
    if let Ok(endpoint) = std::env::var("CODEX_APP_SERVER_WS_URL") {
        let endpoint = url::Url::parse(&endpoint).unwrap();
        assert_eq!(endpoint.scheme(), "ws");
        assert_eq!(endpoint.host_str(), Some("127.0.0.1"));
        assert!(endpoint.port().is_some());
    } else {
        assert_eq!(
            std::env::var("CODLET_ACCEPTANCE_OWNED_BACKEND").as_deref(),
            Ok("1")
        );
        let backend = PathBuf::from(std::env::var_os("CODEX_CLI_PATH").unwrap());
        assert!(backend.starts_with(root.join("backend")) && backend.is_file());
        let endpoint = url::Url::parse(&std::env::var("OPENAI_BASE_URL").unwrap()).unwrap();
        assert_eq!(endpoint.scheme(), "http");
        assert_eq!(endpoint.host_str(), Some("127.0.0.1"));
    }
    let executable = PathBuf::from(std::env::var_os("CODLET_ACCEPTANCE_EXE").unwrap());
    assert!(executable.is_absolute() && executable.is_file());
    let version = std::env::var("CODLET_ACCEPTANCE_PACKAGE_VERSION").expect("package version");
    let parts: Vec<u16> = version
        .split('.')
        .map(|part| part.parse().expect("numeric package version"))
        .collect();
    assert_eq!(parts.len(), 4);
    let package = InstalledPackage {
        family_name: CODEX_PACKAGE_FAMILY.into(),
        full_name: format!("unpacked-{version}-in-existing-package-context"),
        install_location: executable.parent().unwrap().parent().unwrap().to_owned(),
        version: crate::windows::packages::PackageVersion {
            major: parts[0],
            minor: parts[1],
            build: parts[2],
            revision: parts[3],
        },
    };
    // Use the installed launcher's actual resolver, including its canonical
    // verbatim Windows path. A plain config path hid Owl's resource URL failure.
    let executable =
        resolve_package_executable(&package, Path::new(CODEX_EXECUTABLE_RELATIVE_PATH))
            .expect("resolve reviewed package executable");
    let trace = AcceptanceTrace::start(&root);
    trace.record("startup.begin", json!({"corePid":std::process::id()}));
    let mut runtime = start_codlet_runtime_with_connector(LaunchOptions::default(), |services, traffic| {
        let services = services.expect("production runtime services");
        let control = ControlServer::bind_isolated(services.lease, services.status.clone())?;
        let stderr = traffic.is_none().then(crate::client_stderr::ClientStderr::capture_startup).transpose()?;
        // Same native CDP pipes and startup stderr as production. Exact-child
        // cleanup additionally prevents failed tests leaving a client behind.
        let mut context = find_unique_current_user_package(CODEX_PACKAGE_FAMILY)?;
        let current_context = context.clone();
        if std::env::var_os("CODLET_ACCEPTANCE_STALE_PACKAGE").is_some() {
            // Simulate only the stale enumeration result. Windows registration,
            // the selected signed image and the user's running client stay intact.
            context.full_name = "OpenAI.Codex_0.0.0.0_x64__2p2nqsd0c76g0".into();
        }
        let selected_context = context.full_name.clone();
        let (process, pipes) = if let Some(traffic) = traffic {
            traffic.stderr().capture_acceptance_startup();
            let environment = crate::windows::environment::ChildEnvironment::from_entries(traffic.environment().iter().cloned()).map_err(ProcessError::from)?;
            let (active, launched) = super::package_refresh::launch(context, |context| {
                Ok(crate::windows::process::launch_packaged_cdp_with_bootstrap(&executable, traffic.arguments(), Some(&environment), true, Some(traffic.stderr()), context, &mut |child| traffic.before_client_resume(child, &executable))?)
            })?;
            assert_eq!(active, current_context);
            if let Err(error) = traffic.attach_client(launched.0.process_id(), &executable, || false) {
                traffic.stderr().report_startup_failure();
                eprintln!("acceptance-traffic-client: pid={}; exit={:?}", launched.0.process_id(), launched.0.wait(Duration::from_millis(10)));
                return Err(error.into());
            }
            traffic.stderr().finish_startup();
            launched
        } else if std::env::var_os("CODLET_ACCEPTANCE_RAW").is_some() {
            let environment = crate::windows::environment::ChildEnvironment::inherited().map_err(ProcessError::from)?;
            crate::windows::process::launch_with_owned_traffic_capture(&executable, &[], &environment, stderr.as_ref().unwrap())?
        } else {
            // Production ordinary/safe startup inherits the complete native block.
            // Supplying a sanitized explicit block here would hide launcher defects.
            let (active, launched) = super::package_refresh::launch(context, |context| {
                Ok(crate::windows::process::launch_packaged_cdp(&executable, &[], None, true, stderr.as_ref(), context)?)
            })?;
            assert_eq!(active, current_context);
            launched
        };
        if std::env::var_os("CODLET_ACCEPTANCE_SHELL_ENV").is_some() {
            let environment = crate::windows::environment::ChildEnvironment::inherited().map_err(ProcessError::from)?;
            assert!(environment.entries_os().contains(&(OsString::from("=ExitCode"), OsString::from("00000007"))), "real shell metadata must reach Core before the helper handoff");
        }
        services.status.set_codex(CodexStatus {
            pid: process.process_id(), package_full_name: package.full_name.clone(),
            package_version: package.version.to_string(), executable: executable.display().to_string(),
        });
        std::fs::write(root.join("client.json"), json!({"pid":process.process_id(),"created":process.creation_time_filetime()?,"packageFamily":process.package_family()?,"executable":executable,"creatorPackage":creator_package,"selectedContext":selected_context,"activatedContext":current_context.full_name}).to_string()).unwrap();
        let (client, events) = CdpClient::spawn(pipes)?;
        let transport_trace = trace.clone();
        client.set_acceptance_trace(Some(std::sync::Arc::new(move |event, details| transport_trace.record(event, details))));
        trace.record("startup.cdp-connected", json!({"nativePid":process.process_id()}));
        Ok((ConnectedCodex {package, executable, process, client, events, stderr}, Some(HostServers{_status:None,control})))
    }).expect("full Core startup");
    runtime.print_identity_and_initial_state();
    if std::env::var("CODLET_ACCEPTANCE_MANUAL").as_deref() == Ok("1") {
        assert!(
            std::env::var_os("CODLET_ACCEPTANCE_PROBE").is_none(),
            "manual acceptance never runs an automated UI probe"
        );
        std::fs::write(
            root.join("manual-ready.txt"),
            "Close this isolated client to finish.\n",
        )
        .unwrap();
        let outcome = runtime.wait_inner();
        let exit = runtime.process.wait(Duration::from_secs(15));
        println!("manual-client-exit: {exit:?}; runtime: {outcome:?}");
        runtime.client.set_acceptance_trace(None);
        trace.finish();
        return;
    }
    let client = runtime.client.clone();
    let status = runtime.status.clone();
    let report_root = root.clone();
    let duration_input = std::env::var("CODLET_ACCEPTANCE_DURATION").ok();
    let duration = duration_input
        .as_ref()
        .map(|value| value.parse::<u64>().expect("acceptance duration"))
        .unwrap_or(35);
    assert!((35..=900).contains(&duration));
    trace.record(
        "startup.runtime-returned",
        json!({"nativePid":runtime.process.process_id()}),
    );
    trace.record("observer.configuration",json!({"durationSeconds":duration,"durationEnvironment":duration_input,"watchdogSeconds":duration+30,"corePid":std::process::id(),"nativePid":runtime.process.process_id()}));
    let probe_script = std::env::var_os("CODLET_ACCEPTANCE_PROBE").map(PathBuf::from);
    let skill_source = runtime
        .traffic
        .as_ref()
        .and_then(|traffic| traffic.client_source());
    let skill_facts_enabled = synthetic_skill_facts_profile(
        &root,
        &PathBuf::from(std::env::var_os("CODEX_HOME").expect("isolated Codex home")),
    );
    let window_bounds = std::env::var("CODLET_ACCEPTANCE_WINDOW_BOUNDS")
        .ok()
        .map(|value| serde_json::from_str::<Value>(&value).expect("acceptance window bounds"));
    if let Some(bounds) = &window_bounds {
        assert!((640..=2560).contains(&bounds["width"].as_u64().expect("window width")));
        assert!((480..=1600).contains(&bounds["height"].as_u64().expect("window height")));
    }
    let worker_trace = trace.clone();
    let worker = std::thread::spawn(move || {
        let trace = worker_trace;
        let result = (|| -> Result<Value, String> {
            let started = Instant::now();
            trace.record("observer.worker.start", json!({"durationSeconds":duration}));
            let mut samples = Vec::new();
            let mut sid = None;
            let mut probes = Vec::new();
            let mut skill_facts = Vec::new();
            let mut focused = false;
            while started.elapsed() < Duration::from_secs(duration) {
                trace.record(
                    "observer.iteration.sleep",
                    json!({"workerElapsedMs":started.elapsed().as_millis()}),
                );
                std::thread::sleep(Duration::from_secs(2));
                trace.record(
                    "observer.iteration.awake",
                    json!({"workerElapsedMs":started.elapsed().as_millis()}),
                );
                if root.join("finish.json").is_file() {
                    trace.record(
                        "observer.finish-file",
                        json!({"workerElapsedMs":started.elapsed().as_millis()}),
                    );
                    break;
                }
                trace.record("observer.status-save.begin", json!({}));
                let snapshot = status.snapshot();
                std::fs::write(
                    root.join("status.json"),
                    serde_json::to_vec_pretty(&*snapshot).unwrap(),
                )
                .unwrap();
                trace.record("observer.status-save.end", json!({}));
                if sid.is_none() {
                    // Splash/pet targets can attach before the main window and
                    // the splash is also large. Require a rendered navigation
                    // landmark instead of latching onto the first large target.
                    for target in &snapshot.renderer.targets {
                        let dimensions = trace.request("observer.find-main", &client,"Runtime.evaluate", Some(json!({"expression":"innerWidth>=480&&innerHeight>=400&&!!document.querySelector('nav[data-app-navigation-rail=\"true\"],nav button.sidebar-item')","returnByValue":true})), Some(&target.session_id), Duration::from_secs(2));
                        if dimensions
                            .ok()
                            .and_then(|r| r.result)
                            .is_some_and(|r| r["result"]["value"] == true)
                        {
                            if let Some(bounds) = &window_bounds {
                                let resized = trace
                                    .request(
                                        "observer.resize",
                                        &client,
                                        "Emulation.setDeviceMetricsOverride",
                                        Some(json!({"width":bounds["width"],"height":bounds["height"],"deviceScaleFactor":1,"mobile":false})),
                                        Some(&target.session_id),
                                        Duration::from_secs(5),
                                    )
                                    .map_err(|error| error.to_string())?;
                                if resized.error.is_some() {
                                    return Err("Native acceptance viewport resize failed".into());
                                }
                                std::fs::write(
                                    root.join("viewport.json"),
                                    json!({"method":"Emulation.setDeviceMetricsOverride","bounds":bounds}).to_string(),
                                )
                                .map_err(|error| error.to_string())?;
                            }
                            sid = Some(target.session_id.clone());
                            trace.record(
                                "observer.main-session",
                                json!({"targetId":target.target_id,"sessionId":target.session_id}),
                            );
                            break;
                        }
                    }
                }
                if let Some(sid) = &sid {
                    // Some Desktop builds defer local stream ownership in a
                    // background window. Opt in only for an owned functional
                    // fixture; ordinary and manual acceptance keep their focus.
                    if !focused && std::env::var_os("CODLET_ACCEPTANCE_FOREGROUND").is_some() {
                        trace
                            .request(
                                "observer.focus",
                                &client,
                                "Page.bringToFront",
                                None,
                                Some(sid),
                                Duration::from_secs(3),
                            )
                            .map_err(|error| error.to_string())?;
                        focused = true;
                    }
                    if started.elapsed() > Duration::from_secs(6)
                        && let Some(path) = &probe_script
                    {
                        trace.record("observer.probe-read.begin", json!({}));
                        let script =
                            std::fs::read_to_string(path).map_err(|error| error.to_string())?;
                        trace.record("observer.probe-read.end", json!({"bytes":script.len()}));
                        if script.len() > 131072 {
                            return Err("probe script exceeds 128 KiB".into());
                        }
                        let result = trace.request("observer.probe", &client,"Runtime.evaluate", Some(json!({"expression":script,"awaitPromise":true,"returnByValue":true})), Some(sid), Duration::from_secs(10));
                        let result = match result {
                            Ok(response) => json!({"response":response.result}),
                            Err(error) => json!({"error":error.to_string()}),
                        };
                        probes.push(
                            json!({"elapsedMs":started.elapsed().as_millis(),"result":result}),
                        );
                        trace.record("observer.probe-save.begin", json!({"samples":probes.len()}));
                        write_latest_probe(&root, probes.last().expect("current probe sample"))
                            .unwrap();
                        std::fs::write(
                            root.join("probe.json"),
                            serde_json::to_vec_pretty(&probes).unwrap(),
                        )
                        .unwrap();
                        trace.record("observer.probe-save.end", json!({"samples":probes.len()}));
                        if skill_facts_enabled
                            && let Some(receipt) = collect_skill_fact(
                                &client,
                                &status,
                                sid,
                                skill_source.as_ref(),
                                &trace,
                            )
                        {
                            skill_facts.push(json!({"elapsedMs":started.elapsed().as_millis(),"receipt":receipt}));
                            std::fs::write(
                                root.join("skill-facts.json"),
                                serde_json::to_vec_pretty(&skill_facts).unwrap(),
                            )
                            .map_err(|error| error.to_string())?;
                        }
                    }
                    let response = trace.request("observer.dom", &client,"Runtime.evaluate", Some(json!({"expression":"JSON.stringify({url:location.href,title:document.title,state:document.readyState,bridge:{type:window.electronBridge?.windowType,send:typeof window.electronBridge?.sendMessageFromView},text:document.body?.innerText?.slice(0,8000),buttons:[...document.querySelectorAll('button')].map(b=>b.innerText||b.getAttribute('aria-label')).filter(Boolean)})","returnByValue":true})), Some(sid), Duration::from_secs(4)).map_err(|e|e.to_string())?;
                    samples.push(
                        json!({"elapsedMs":started.elapsed().as_millis(),"dom":response.result}),
                    );
                    trace.record("observer.dom-save.begin", json!({"samples":samples.len()}));
                    std::fs::write(
                        root.join("dom.json"),
                        serde_json::to_vec_pretty(&samples).unwrap(),
                    )
                    .unwrap();
                    trace.record("observer.dom-save.end", json!({"samples":samples.len()}));
                    if probe_script.is_none() && started.elapsed() > Duration::from_secs(15) {
                        let _ = trace.request("observer.default-probe", &client,"Runtime.evaluate", Some(json!({"expression":"(()=>{const e=[...document.querySelectorAll('a,button')].find(e=>e.textContent.trim()==='Codlet');if(e){e.click();return true}return false})()","returnByValue":true})), Some(sid), Duration::from_secs(4));
                    }
                }
            }
            trace.record(
                "observer.loop.end",
                json!({"workerElapsedMs":started.elapsed().as_millis(),"durationSeconds":duration}),
            );
            let sid = sid.ok_or("no renderer session")?;
            let screenshot = trace
                .request(
                    "observer.screenshot",
                    &client,
                    "Page.captureScreenshot",
                    Some(json!({"format":"png"})),
                    Some(&sid),
                    Duration::from_secs(5),
                )
                .map_err(|e| e.to_string())?;
            if let Some(data) = screenshot
                .result
                .and_then(|v| v.get("data").and_then(Value::as_str).map(str::to_owned))
            {
                std::fs::write(
                    root.join("desktop.png"),
                    base64::engine::general_purpose::STANDARD
                        .decode(data)
                        .map_err(|e| e.to_string())?,
                )
                .unwrap();
            }
            Ok(json!({"samples":samples,"snapshot":&*status.snapshot()}))
        })();
        trace.record(
            "observer.result",
            json!({"returned":true,"isOk":result.is_ok()}),
        );
        // Only the exact CDP-owned test window receives the normal app quit IPC.
        if let Some(target) = status.snapshot().renderer.targets.first() {
            trace.record("observer.quit.attempt",json!({"targetId":target.target_id,"sessionId":target.session_id,"sessionLive":target.session_live}));
            let quit = trace.request("observer.quit", &client,"Runtime.evaluate", Some(json!({"expression":include_str!("../lab/quit.js"),"awaitPromise":true,"returnByValue":true})), Some(&target.session_id), Duration::from_secs(3));
            std::fs::write(root.join("quit.txt"), format!("{quit:?}")).unwrap();
        }
        std::fs::write(
            root.join("acceptance.json"),
            serde_json::to_vec_pretty(&json!({"result":result})).unwrap(),
        )
        .unwrap();
        trace.record("observer.worker.end", json!({"isOk":result.is_ok()}));
        result
    });
    // Production intentionally retains a living Native client after renderer
    // discovery fails. Closing CDP alone cannot end that degraded event loop.
    // This disposable acceptance scope retains the exact child handle so its
    // deadline can stop only the test client and record an explicit failure.
    let deadline_client = runtime.client.clone();
    let deadline_process = runtime
        .process
        .owned_handle()
        .try_clone()
        .expect("retain owned acceptance client");
    let watchdog_root = report_root.clone();
    let (done, deadline) = std::sync::mpsc::channel();
    let watchdog_trace = trace.clone();
    let watchdog = std::thread::spawn(move || {
        watchdog_trace.record(
            "watchdog.thread.start",
            json!({"durationSeconds":duration,"timeoutSeconds":duration+30}),
        );
        if stop_acceptance_at_deadline(
            &deadline_process,
            &deadline,
            Duration::from_secs(duration + 30),
            &watchdog_root,
            &watchdog_trace,
        ) {
            watchdog_trace.record("watchdog.cdp-shutdown.begin", json!({}));
            let _ = deadline_client.shutdown();
            watchdog_trace.record("watchdog.cdp-shutdown.end", json!({}));
        }
    });
    trace.record("runtime.wait.begin", json!({}));
    let outcome = runtime.wait_inner();
    trace.record("runtime.wait.end", json!({"isOk":outcome.is_ok()}));
    let exit_started = Instant::now();
    let final_exit = runtime.process.wait(Duration::from_secs(15));
    trace.record("runtime.native-exit",json!({"waitMs":exit_started.elapsed().as_millis(),"exitCode":final_exit.as_ref().ok().copied().flatten(),"waitError":final_exit.is_err()}));
    println!(
        "owned-client-exit-after-loop: {final_exit:?}; wait-ms={}",
        exit_started.elapsed().as_millis()
    );
    let observed = worker.join().expect("observer thread");
    trace.record("runtime.worker.joined", json!({"isOk":observed.is_ok()}));
    let _ = done.send(());
    watchdog.join().unwrap();
    println!("full-runtime-exit: {outcome:?}");
    let normal_shutdown = outcome.is_ok()
        && matches!(&final_exit, Ok(Some(0)))
        && !report_root.join("watchdog.json").exists();
    trace.record("runtime.observation.complete",json!({"normalShutdown":normal_shutdown,"watchdogRecorded":report_root.join("watchdog.json").exists()}));
    // The sink owns a sender clone. Release it after actual Native exit and
    // joined observers before draining the logger's existing channel.
    runtime.client.set_acceptance_trace(None);
    trace.finish();
    let observed = observed.unwrap_or_else(|error| {
        std::fs::write(
            report_root.join("verdict.json"),
            serde_json::to_vec_pretty(&json!({
                "rendered":false,"normalShutdown":normal_shutdown,
                "observerError":error,"exit":format!("{final_exit:?}"),
                "watchdogExpired":report_root.join("watchdog.json").exists(),
                "msixUpdateAccepted":false,"signedInSessionAccepted":false
            }))
            .unwrap(),
        )
        .unwrap();
        panic!("rendered client observation: {error}");
    });
    let rendered = observed["samples"].as_array().is_some_and(|samples| {
        samples.iter().any(|sample| {
            sample["dom"]["result"]["value"]
                .as_str()
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .is_some_and(|dom| {
                    dom["text"]
                        .as_str()
                        .is_some_and(|text| !text.trim().is_empty())
                })
        })
    });
    let plugin_errors = observed["snapshot"]["renderer"]["recent_events"]
        .as_array()
        .map_or(0, |events| {
            events
                .iter()
                .filter(|event| {
                    matches!(
                        event["code"].as_str(),
                        Some("plugin_activation_failed" | "plugin_reported_error")
                    )
                })
                .count()
        });
    std::fs::write(report_root.join("verdict.json"), serde_json::to_vec_pretty(&json!({
        "rendered":rendered,"pluginErrorCount":plugin_errors,"normalShutdown":normal_shutdown,
        "exit":format!("{final_exit:?}"),"msixUpdateAccepted":false,"signedInSessionAccepted":false
    })).unwrap()).unwrap();
    assert!(rendered, "no rendered client UI");
    assert!(outcome.is_ok(), "normal shutdown failed: {outcome:?}");
    assert!(
        normal_shutdown,
        "owned client exit was not successful: {final_exit:?}"
    );
    assert!(
        observed["snapshot"]["renderer"]["targets"]
            .as_array()
            .is_some_and(|targets| !targets.is_empty()),
        "no renderer target"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::io::BorrowedHandle;
    use std::os::windows::process::CommandExt;

    #[test]
    fn latest_probe_atomically_preserves_the_complete_original_sample() {
        use std::io::Read;
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        let root = tempfile::tempdir().unwrap();
        let history = b"existing probe history remains unchanged\n";
        std::fs::write(root.path().join("probe.json"), history).unwrap();
        let body = format!(
            "start:{}:end",
            "Native complete body\n🙂".repeat(128 * 1024)
        );
        let first = json!({"elapsedMs":123456,"result":{"response":{"result":{"value":{"body":body,"tail":"last native value"}}}}});
        write_latest_probe(root.path(), &first).unwrap();
        let path = root.path().join("probe-latest.json");
        let first_bytes = serde_json::to_vec_pretty(&first).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), first_bytes);
        // An observer holding a delete-sharing read handle keeps its complete
        // previous snapshot while a new open sees the replacement sample.
        let mut previous = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .open(&path)
            .unwrap();
        let second =
            json!({"elapsedMs":123999,"result":{"error":"original CDP error\nunknown outcome"}});
        write_latest_probe(root.path(), &second).unwrap();
        let mut retained = Vec::new();
        previous.read_to_end(&mut retained).unwrap();
        assert_eq!(retained, first_bytes);
        assert_eq!(
            std::fs::read(&path).unwrap(),
            serde_json::to_vec_pretty(&second).unwrap()
        );
        let observed: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(observed, second);
        assert_eq!(
            std::fs::read(root.path().join("probe.json")).unwrap(),
            history
        );
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 2);
    }

    #[test]
    fn phase_trace_keeps_concurrent_records_complete_without_serializing_callers_on_io() {
        let root = tempfile::tempdir().unwrap();
        let trace = AcceptanceTrace::start(root.path());
        let workers: Vec<_> = (0..4)
            .map(|thread| {
                let trace = trace.clone();
                std::thread::spawn(move || {
                    for _ in 0..16 {
                        let call = trace
                            .call
                            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        trace.record("test.record", json!({"thread":thread,"call":call}));
                    }
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        trace.finish();
        let content = std::fs::read_to_string(root.path().join("observer-timeline.jsonl")).unwrap();
        let records: Vec<Value> = content
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(records.len(), 64);
        let mut calls = std::collections::BTreeSet::new();
        for (index, record) in records.iter().enumerate() {
            assert_eq!(record["line"], index + 1);
            assert_eq!(record["event"], "test.record");
            assert!(record["elapsedMs"].as_u64().is_some());
            assert!(record["wallUnixMs"].as_u64().is_some());
            assert!(record["tickCountMs"].as_u64().is_some());
            assert!(calls.insert(record["details"]["call"].as_u64().unwrap()));
        }
    }

    fn skill_capture() -> Value {
        let run = "vm-20261027-01234567-89ab-cdef-0123-456789abcdef";
        json!({"api":1,"runId":run,"sampleId":format!("{run}:skills-before"),"clientId":"current-client","clientEpoch":3,"authorityId":"actual-child","anchors":[{"id":19,"method":"skills/list"}]})
    }

    #[test]
    fn skill_facts_context_retirement_cannot_be_hidden_by_reused_numeric_identity() {
        let context = SkillFactsContext {
            target_id: "main".into(),
            session_id: "owned-session".into(),
            frame_id: "main-frame".into(),
            context_id: 17,
        };
        let event = |session: Option<&str>, method: &str, params| crate::cdp::CdpEvent {
            session_id: session.map(str::to_owned),
            method: method.into(),
            params: Some(params),
        };
        assert!(skill_context_retired(
            &event(
                Some("owned-session"),
                "Runtime.executionContextDestroyed",
                json!({"executionContextId":17})
            ),
            &context
        ));
        assert!(skill_context_retired(
            &event(
                Some("owned-session"),
                "Runtime.executionContextCreated",
                json!({"context":{"id":17,"auxData":{"isDefault":true,"frameId":"main-frame"}}})
            ),
            &context
        ));
        assert!(!skill_context_retired(
            &event(
                Some("unrelated-session"),
                "Runtime.executionContextsCleared",
                json!({})
            ),
            &context
        ));
        assert!(!skill_context_retired(
            &event(
                Some("owned-session"),
                "Page.frameNavigated",
                json!({"frame":{"id":"child","parentId":"main-frame"}})
            ),
            &context
        ));
        assert!(skill_context_retired(
            &event(
                None,
                "Target.detachedFromTarget",
                json!({"sessionId":"owned-session"})
            ),
            &context
        ));
    }

    #[test]
    fn skill_facts_requires_matching_capture_and_preserves_original_unknown_or_complete_roots() {
        let request = SkillFactsRequest::parse(&skill_capture()).unwrap();
        assert!(request.run_id.starts_with("vm-20261027-"));
        assert_eq!(request.client_id, "current-client");
        assert_eq!(request.client_epoch, 3);
        assert_eq!(request.authority_id.as_deref(), Some("actual-child"));
        assert_eq!(request.anchors, json!([{"id":19,"method":"skills/list"}]));
        let accepted = json!({"accepted":true,"sampleId":request.sample_id});
        let unknown = json!({"status":"unknown","authorityId":"actual-child","revision":8,"reason":"root_write_pending"});
        assert_eq!(
            verified_skill_fact(&request, unknown.clone(), &accepted).unwrap(),
            unknown
        );
        let roots = vec![
            format!("C:/{}", "完整😀/".repeat(20_000)),
            "C:/second".into(),
        ];
        let observed = json!({"status":"observed","authorityId":"actual-child","revision":9,"provenance":"confirmed","roots":roots});
        assert_eq!(
            verified_skill_fact(&request, observed.clone(), &accepted).unwrap(),
            observed
        );
        for completion in [
            json!({"accepted":false,"sampleId":request.sample_id,"reason":"owner_changed"}),
            json!({"accepted":true,"sampleId":"another-capture"}),
        ] {
            assert_eq!(
                verified_skill_fact(&request, observed.clone(), &completion).unwrap_err(),
                "skill_facts_owner_changed"
            );
        }
    }

    #[test]
    fn skill_facts_rejects_unrelated_run_or_non_native_control_identity() {
        for (key, invalid) in [
            ("api", json!(2)),
            ("runId", json!("daily-profile")),
            ("sampleId", json!("different-run:skills-before")),
            ("clientEpoch", json!(9_007_199_254_740_992_u64)),
            ("anchors", json!([{"id":true,"method":"skills/list"}])),
        ] {
            let mut capture = skill_capture();
            capture[key] = invalid;
            assert!(SkillFactsRequest::parse(&capture).is_err(), "{capture}");
        }
    }

    #[test]
    fn skill_facts_are_only_enabled_for_the_owned_synthetic_profile() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("codex");
        std::fs::create_dir(&home).unwrap();
        assert!(!synthetic_skill_facts_profile(root.path(), &home));
        std::fs::write(
            home.join("auth.json"),
            json!({"OPENAI_API_KEY":"codlet-offline-acceptance"}).to_string(),
        )
        .unwrap();
        assert!(synthetic_skill_facts_profile(root.path(), &home));
        assert!(!synthetic_skill_facts_profile(
            &root.path().join("another-owner"),
            &home
        ));
        std::fs::write(
            home.join("auth.json"),
            json!({"OPENAI_API_KEY":"some-other-profile"}).to_string(),
        )
        .unwrap();
        assert!(!synthetic_skill_facts_profile(root.path(), &home));
    }

    struct Fixture(std::process::Child);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn fixture() -> Fixture {
        let shell = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        Fixture(
            std::process::Command::new(shell)
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Start-Sleep -Seconds 60",
                ])
                .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
                .spawn()
                .unwrap(),
        )
    }

    #[test]
    fn deadline_stops_only_retained_test_process() {
        let root = tempfile::tempdir().unwrap();
        let trace = AcceptanceTrace::start(root.path());
        let mut owned = fixture();
        let mut unrelated = fixture();
        // SAFETY: owned retains this handle until the fixture is dropped.
        let handle = unsafe { BorrowedHandle::borrow_raw(owned.0.as_raw_handle()) }
            .try_clone_to_owned()
            .unwrap();
        let (_complete, deadline) = std::sync::mpsc::channel();
        assert!(stop_acceptance_at_deadline(
            &handle,
            &deadline,
            Duration::from_millis(25),
            root.path(),
            &trace
        ));
        trace.finish();
        assert_eq!(owned.0.wait().unwrap().code(), Some(124));
        assert!(unrelated.0.try_wait().unwrap().is_none());
        let receipt: Value =
            serde_json::from_slice(&std::fs::read(root.path().join("watchdog.json")).unwrap())
                .unwrap();
        assert_eq!(receipt["timedOut"], true);
        assert_eq!(receipt["terminationRequested"], true);
    }

    #[test]
    fn completed_acceptance_does_not_stop_the_client() {
        let root = tempfile::tempdir().unwrap();
        let trace = AcceptanceTrace::start(root.path());
        let mut owned = fixture();
        // SAFETY: owned retains this handle until the fixture is dropped.
        let handle = unsafe { BorrowedHandle::borrow_raw(owned.0.as_raw_handle()) }
            .try_clone_to_owned()
            .unwrap();
        let (complete, deadline) = std::sync::mpsc::channel();
        complete.send(()).unwrap();
        assert!(!stop_acceptance_at_deadline(
            &handle,
            &deadline,
            Duration::from_millis(25),
            root.path(),
            &trace
        ));
        trace.finish();
        assert!(owned.0.try_wait().unwrap().is_none());
        assert!(!root.path().join("watchdog.json").exists());
    }
}
