use super::*;
use std::thread;

fn owner() -> ResourceOwner {
    ResourceOwner {
        plugin_id: "test.resources".into(),
        source_identity: "scope/source".into(),
        generation: 1,
        default_cwd: PathBuf::new(),
        executables: vec![],
        cwd_roots: vec![],
        env_keys: vec![],
    }
}
fn call(core: &CoreResources, owner: &ResourceOwner, method: &str, params: Value) -> Value {
    core.invoke(owner, method, params)
        .unwrap_or_else(|e| panic!("{method}: {e}"))
}
fn code(core: &CoreResources, owner: &ResourceOwner, method: &str, params: Value) -> &'static str {
    core.invoke(owner, method, params).unwrap_err().code
}

#[test]
fn events_replay_gap_ack_and_owner_boundaries() {
    let core = CoreResources::default();
    let owner = owner();
    let topic = call(
        &core,
        &owner,
        "events.createTopic",
        json!({"name":"changes","maxEvents":2}),
    );
    let subscription = call(
        &core,
        &owner,
        "events.subscribe",
        json!({"topic":topic["topic"],"after":topic["cursor"]}),
    );
    for n in 0..3 {
        call(
            &core,
            &owner,
            "events.publish",
            json!({"topic":topic["topic"],"event":n}),
        );
    }
    let request = json!({"subscription":subscription["subscription"]});
    let read = call(&core, &owner, "events.read", request.clone());
    assert_eq!(read["gap"], true);
    assert_eq!(read["events"].as_array().unwrap().len(), 2);
    assert_eq!(read["events"][0]["value"], 1);
    assert_eq!(read, call(&core, &owner, "events.read", request.clone()));
    call(
        &core,
        &owner,
        "events.ack",
        json!({"subscription":subscription["subscription"],"cursor":read["cursor"]}),
    );
    assert!(
        call(&core, &owner, "events.read", request.clone())["events"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let other = ResourceOwner {
        plugin_id: "other".into(),
        ..owner.clone()
    };
    assert_eq!(
        code(&core, &other, "events.read", request),
        "resource_not_found"
    );
    let second = call(&core, &owner, "events.createTopic", json!({"name":"other"}));
    assert_eq!(
        code(
            &core,
            &owner,
            "events.subscribe",
            json!({"topic":second["topic"],"after":read["cursor"]})
        ),
        "cursor_invalid"
    );
    call(
        &core,
        &owner,
        "events.close",
        json!({"resource":topic["topic"]}),
    );
    let ended = call(
        &core,
        &owner,
        "events.read",
        json!({"subscription":subscription["subscription"]}),
    );
    assert_eq!(ended["terminal"], "topic_closed");
    core.retire(&owner).unwrap();
    assert_eq!(
        code(&core, &owner, "events.createTopic", json!({"name":"late"})),
        "stale_generation"
    );
    let next = ResourceOwner {
        generation: 2,
        ..owner
    };
    assert_eq!(
        code(
            &core,
            &next,
            "events.publish",
            json!({"topic":topic["topic"],"event":0})
        ),
        "resource_not_found"
    );
}

#[test]
fn event_wait_releases_service_lock_and_shutdown_wakes_it() {
    let core = CoreResources::default();
    let owner = owner();
    let topic = call(&core, &owner, "events.createTopic", json!({"name":"wait"}));
    let sub = call(
        &core,
        &owner,
        "events.subscribe",
        json!({"topic":topic["topic"]}),
    );
    let reader = core.clone();
    let reader_owner = owner.clone();
    let waiting = thread::spawn(move || {
        reader.invoke(
            &reader_owner,
            "events.read",
            json!({"subscription":sub["subscription"],"waitMs":1000}),
        )
    });
    thread::sleep(Duration::from_millis(20));
    core.shutdown().unwrap();
    assert_eq!(waiting.join().unwrap().unwrap_err().code, "resource_closed");
}

#[test]
fn cross_plugin_subscription_pins_provider_and_retires_without_rebinding() {
    let core = CoreResources::default();
    let provider = owner();
    let consumer = ResourceOwner {
        plugin_id: "test.consumer".into(),
        ..provider.clone()
    };
    let capability = json!({"name":"test.shared-events","api":1,"scope":"runtime"});
    let topic = call(
        &core,
        &provider,
        "events.createTopic",
        json!({"name":"shared","capability":capability}),
    );
    assert_eq!(topic["scope"], "capability");
    assert_eq!(
        code(
            &core,
            &consumer,
            "events.subscribe",
            json!({"topic":topic["topic"]})
        ),
        "resource_not_found"
    );
    let sub = core
        .invoke_events_for(
            &consumer,
            &provider,
            "events.subscribe",
            json!({"topic":topic["topic"],"after":topic["cursor"],"capability":capability}),
        )
        .unwrap();
    assert_eq!(sub["scope"], "capability");
    call(
        &core,
        &provider,
        "events.publish",
        json!({"topic":topic["topic"],"event":"live"}),
    );
    let read = call(
        &core,
        &consumer,
        "events.read",
        json!({"subscription":sub["subscription"]}),
    );
    assert_eq!(read["events"][0]["value"], "live");
    assert_eq!(
        code(
            &core,
            &consumer,
            "events.publish",
            json!({"topic":topic["topic"],"event":"forged"})
        ),
        "resource_not_found"
    );
    core.retire(&provider).unwrap();
    let ended = call(
        &core,
        &consumer,
        "events.read",
        json!({"subscription":sub["subscription"]}),
    );
    assert_eq!(ended["terminal"], "provider_retired");
    assert!(ended["events"].as_array().unwrap().is_empty());
    let next = ResourceOwner {
        generation: 2,
        ..provider.clone()
    };
    assert_eq!(
        core.invoke_events_for(
            &consumer,
            &next,
            "events.subscribe",
            json!({"topic":topic["topic"],"capability":capability})
        )
        .unwrap_err()
        .code,
        "resource_not_found"
    );
    call(
        &core,
        &consumer,
        "events.close",
        json!({"resource":sub["subscription"]}),
    );
    core.retire(&consumer).unwrap();
}

#[test]
fn cross_plugin_event_topics_require_the_exact_export_descriptor() {
    let core = CoreResources::default();
    let provider = owner();
    let consumer = ResourceOwner {
        plugin_id: "test.consumer".into(),
        ..provider.clone()
    };
    let exported = json!({"name":"test.exported","api":1,"scope":"runtime"});
    let other = json!({"name":"test.other","api":1,"scope":"runtime"});
    let private = call(
        &core,
        &provider,
        "events.createTopic",
        json!({"name":"private"}),
    );
    assert_eq!(
        core.invoke_events_for(
            &consumer,
            &provider,
            "events.subscribe",
            json!({"topic":private["topic"],"capability":exported}),
        )
        .unwrap_err()
        .code,
        "resource_not_found"
    );
    let shared = call(
        &core,
        &provider,
        "events.createTopic",
        json!({"name":"exported","capability":exported}),
    );
    assert_eq!(
        core.invoke_events_for(
            &consumer,
            &provider,
            "events.subscribe",
            json!({"topic":shared["topic"],"capability":other}),
        )
        .unwrap_err()
        .code,
        "resource_not_found"
    );
    assert_eq!(
        code(
            &core,
            &provider,
            "events.subscribe",
            json!({"topic":shared["topic"],"capability":other})
        ),
        "resource_not_found"
    );
    assert!(
        core.invoke_events_for(
            &consumer,
            &provider,
            "events.subscribe",
            json!({"topic":shared["topic"],"capability":exported}),
        )
        .is_ok()
    );
    assert_eq!(
        code(
            &core,
            &provider,
            "events.createTopic",
            json!({"name":"target-scope","capability":{"name":"test.target","api":1,"scope":"target"}})
        ),
        "invalid_params"
    );
}

#[test]
fn tasks_have_exclusive_claims_idempotent_start_and_truthful_cancel() {
    let core = CoreResources::default();
    let owner = owner();
    let runner = call(&core, &owner, "tasks.register", json!({"name":"work"}));
    let input = json!({"runner":runner["runner"],"input":{"x":1},"operationKey":"same"});
    let task = call(&core, &owner, "tasks.start", input.clone());
    assert_eq!(
        call(&core, &owner, "tasks.start", input)["task"],
        task["task"]
    );
    assert_eq!(
        code(
            &core,
            &owner,
            "tasks.start",
            json!({"runner":runner["runner"],"input":2,"operationKey":"same"})
        ),
        "operation_conflict"
    );
    let claim = call(
        &core,
        &owner,
        "tasks.claim",
        json!({"runner":runner["runner"]}),
    );
    let work = &claim["tasks"][0];
    assert_eq!(work["task"], task["task"]);
    assert!(
        call(
            &core,
            &owner,
            "tasks.claim",
            json!({"runner":runner["runner"]})
        )["tasks"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        code(
            &core,
            &owner,
            "tasks.finish",
            json!({"task":task["task"],"claim":"wrong","state":"succeeded"})
        ),
        "claim_denied"
    );
    let cancel = call(&core, &owner, "tasks.cancel", json!({"task":task["task"]}));
    assert_eq!(cancel["state"], "running");
    assert_eq!(cancel["cancelRequested"], true);
    let poll = call(
        &core,
        &owner,
        "tasks.claim",
        json!({"runner":runner["runner"]}),
    );
    assert_eq!(poll["cancellations"][0]["task"], task["task"]);
    let result = call(
        &core,
        &owner,
        "tasks.finish",
        json!({"task":task["task"],"claim":work["claim"],"state":"succeeded","result":42}),
    );
    assert_eq!(result["state"], "succeeded");
    assert_eq!(result["result"], 42);
    assert_eq!(
        code(
            &core,
            &owner,
            "tasks.finish",
            json!({"task":task["task"],"claim":work["claim"],"state":"cancelled"})
        ),
        "task_terminal"
    );
}

#[test]
fn tasks_bound_concurrency_and_timeout_without_replay() {
    let core = CoreResources::default();
    let owner = owner();
    let runner = call(&core, &owner, "tasks.register", json!({"name":"long"}));
    for n in 0..5 {
        call(
            &core,
            &owner,
            "tasks.start",
            json!({"runner":runner["runner"],"input":n,"operationKey":format!("job-{n}")}),
        );
    }
    let claim = call(
        &core,
        &owner,
        "tasks.claim",
        json!({"runner":runner["runner"],"limit":4}),
    );
    assert_eq!(claim["tasks"].as_array().unwrap().len(), 4);
    assert!(
        call(
            &core,
            &owner,
            "tasks.claim",
            json!({"runner":runner["runner"]})
        )["tasks"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    call(
        &core,
        &owner,
        "tasks.unregister",
        json!({"runner":runner["runner"]}),
    );
    let states = call(&core, &owner, "tasks.list", json!({}));
    assert_eq!(
        states["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["state"] == "interrupted")
            .count(),
        4
    );
    assert_eq!(
        states["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["state"] == "cancelled")
            .count(),
        1
    );
    let runner = call(&core, &owner, "tasks.register", json!({"name":"deadline"}));
    let task = call(
        &core,
        &owner,
        "tasks.start",
        json!({"runner":runner["runner"],"input":null,"operationKey":"deadline","timeoutMs":1}),
    );
    thread::sleep(Duration::from_millis(4));
    assert_eq!(
        call(&core, &owner, "tasks.get", json!({"task":task["task"]}))["state"],
        "cancelled"
    );
    assert!(
        call(
            &core,
            &owner,
            "tasks.claim",
            json!({"runner":runner["runner"]})
        )["tasks"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[cfg(windows)]
fn process_owner(temp: &tempfile::TempDir) -> ResourceOwner {
    let _verified = crate::js_runtime::JsRuntime::discover()
        .expect("stage the pinned Node runtime beside the test binary");
    let pin: Value = serde_json::from_str(include_str!("../../runtime/node-runtime.json")).unwrap();
    let platform = if cfg!(target_os = "macos") {
        "darwin-arm64"
    } else if cfg!(target_arch = "aarch64") {
        "win-arm64"
    } else {
        "win-x64"
    };
    let version = pin["platforms"][platform]["version"]
        .as_str()
        .unwrap_or(pin["version"].as_str().unwrap());
    let executable = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .join("runtime")
        .join(format!("node-v{version}-{platform}"))
        .join(if cfg!(target_os = "macos") {
            "bin/node"
        } else {
            "node.exe"
        })
        .canonicalize()
        .unwrap();
    ResourceOwner {
        default_cwd: std::fs::canonicalize(temp.path()).unwrap(),
        executables: vec![executable],
        ..owner()
    }
}
#[cfg(windows)]
fn spawn_script(core: &CoreResources, owner: &ResourceOwner, script: &str, key: &str) -> Value {
    call(
        core,
        owner,
        "processes.spawn",
        json!({"executable":owner.executables[0],"args":["--eval",script],"operationKey":key}),
    )
}
#[cfg(windows)]
fn read_until(
    core: &CoreResources,
    owner: &ResourceOwner,
    id: &Value,
    stream: &str,
    bytes: usize,
) -> Vec<u8> {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut output = Vec::new();
    while output.len() < bytes && Instant::now() < deadline {
        let chunk = call(
            core,
            owner,
            "processes.read",
            json!({"process":id,"stream":stream,"waitMs":250}),
        );
        output.extend(
            chunk["bytes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap() as u8),
        );
        if chunk["eof"] == true || chunk["closed"] == true {
            break;
        }
    }
    output
}

#[cfg(windows)]
#[test]
fn process_streams_binary_io_and_write_receipts_then_reaps() {
    let temp = tempfile::tempdir().unwrap();
    let owner = process_owner(&temp);
    let core = CoreResources::default();
    let script = "process.stdout.write(Buffer.from([0,255,66]));process.stderr.write('ready\\n');let input='';process.stdin.on('data',part=>{input+=part;if(input.includes('\\n')){process.stdout.write(input.trimEnd());process.stdin.destroy();}})";
    let created = spawn_script(&core, &owner, script, "binary");
    let id = &created["process"];
    assert_eq!(read_until(&core, &owner, id, "stdout", 3), vec![0, 255, 66]);
    assert!(
        String::from_utf8(read_until(&core, &owner, id, "stderr", 5))
            .unwrap()
            .contains("ready")
    );
    let write = json!({"process":id,"bytes":b"hello\n".to_vec(),"sequence":"0"});
    assert_eq!(
        call(&core, &owner, "processes.write", write.clone())["acceptedBytes"],
        6
    );
    assert_eq!(
        call(&core, &owner, "processes.write", write)["replayedReceipt"],
        true
    );
    assert_eq!(
        code(
            &core,
            &owner,
            "processes.write",
            json!({"process":id,"bytes":[1],"sequence":"0"})
        ),
        "operation_conflict"
    );
    call(&core, &owner, "processes.endInput", json!({"process":id}));
    assert_eq!(read_until(&core, &owner, id, "stdout", 5), b"hello");
    let deadline = Instant::now() + Duration::from_secs(10);
    let done = loop {
        let status = call(
            &core,
            &owner,
            "processes.wait",
            json!({"process":id,"waitMs":250}),
        );
        if status["workerDone"] == true {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "process failed to retire: {status}"
        );
    };
    assert_eq!(done["exitCode"], 0);
    assert_eq!(done["processesReaped"], true);
    call(&core, &owner, "processes.close", json!({"process":id}));
    assert_eq!(
        spawn_script(&core, &owner, script, "binary")["closed"],
        true
    );
}

#[cfg(windows)]
#[test]
fn process_backpressure_and_retirement_keep_buffers_bounded() {
    let temp = tempfile::tempdir().unwrap();
    let owner = process_owner(&temp);
    let core = CoreResources::default();
    let created = spawn_script(
        &core,
        &owner,
        "process.stdout.write(Buffer.alloc(1048576));setTimeout(()=>{},60000)",
        "flood",
    );
    thread::sleep(Duration::from_millis(250));
    let status = call(
        &core,
        &owner,
        "processes.status",
        json!({"process":created["process"]}),
    );
    assert!(status["stdoutBuffered"].as_u64().unwrap() <= 256 * 1024);
    core.retire(&owner).unwrap();
    assert_eq!(
        code(
            &core,
            &owner,
            "processes.status",
            json!({"process":created["process"]})
        ),
        "stale_generation"
    );
}

#[cfg(windows)]
#[test]
fn process_rejects_ungranted_environment_before_start() {
    let temp = tempfile::tempdir().unwrap();
    let owner = process_owner(&temp);
    let core = CoreResources::default();
    assert_eq!(
        code(
            &core,
            &owner,
            "processes.spawn",
            json!({"executable":owner.executables[0],"args":[],"env":{"SECRET":"value"},"operationKey":"denied"})
        ),
        "policy_denied"
    );
    assert!(
        call(&core, &owner, "resources.list", json!({}))["resources"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
