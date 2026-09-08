use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::FromRawHandle;

use serde_json::{Value, json};
use thiserror::Error;
use windows_sys::Win32::Foundation::{GetLastError, HANDLE};
use windows_sys::Win32::System::Pipes::PeekNamedPipe;

use crate::cdp::{FramingError, NulJsonDecoder, write_json_frame};

#[derive(Debug, Error)]
pub enum FakeChildError {
    #[error("missing required argument {0}")]
    MissingArgument(&'static str),
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    #[error("unknown fake-child scenario {0}")]
    UnknownScenario(String),
    #[error("failed to read inherited CDP pipe: {0}")]
    Read(#[from] std::io::Error),
    #[error(transparent)]
    Framing(#[from] FramingError),
    #[error("request is invalid: {0}")]
    InvalidRequest(String),
    #[error("requested fake-child exit code {0}")]
    RequestedExit(i32),
}

pub fn run(arguments: impl Iterator<Item = OsString>) -> Result<(), FakeChildError> {
    let parsed = ParsedArguments::parse(arguments)?;
    // SAFETY: these numeric values were passed by the parent in the explicit inheritance list,
    // and this process takes ownership of its inherited copies.
    let mut input = unsafe { File::from_raw_handle(parsed.child_reader as *mut _) };
    // SAFETY: same ownership contract as child_reader, for the independent output handle.
    let mut output = unsafe { File::from_raw_handle(parsed.child_writer as *mut _) };

    match parsed.scenario.as_str() {
        "routing" => scenario_routing(&mut input, &mut output),
        "eof" => scenario_eof(&mut input),
        "malformed" => scenario_malformed(&mut input, &mut output),
        "late-retired" => scenario_late_retired(&mut input, &mut output),
        "future-response" => scenario_future_response(&mut input, &mut output),
        "first-issued-id" => scenario_first_issued_id(&mut input, &mut output),
        "target-delayed" => scenario_target_delayed(&mut input, &mut output),
        "target-never" => scenario_target_never_matches(&mut input, &mut output),
        "target-lifecycle" => scenario_target_lifecycle(&mut input, &mut output),
        mode @ ("renderer-runtime" | "renderer-status-context" | "renderer-subframe-context") => {
            scenario_renderer_runtime(&mut input, &mut output, mode)
        }
        mode @ ("renderer-document-recovery" | "renderer-document-recovery-timeout") => {
            scenario_renderer_document_recovery(&mut input, &mut output, mode.ends_with("timeout"))
        }
        "lab-environment" => scenario_lab_environment(&mut input, &mut output),
        "renderer-ready-handshake" => scenario_renderer_ready_handshake(&mut input, &mut output),
        "renderer-ready-rejection" => scenario_renderer_ready_rejection(&mut input, &mut output),
        "renderer-ready-timeout" => scenario_renderer_ready_timeout(&mut input, &mut output),
        "renderer-rpc" => scenario_renderer_rpc(&mut input, &mut output),
        "renderer-manage" => scenario_renderer_manage(&mut input, &mut output),
        "renderer-local-manage" => scenario_renderer_local_manage(&mut input, &mut output, true),
        "renderer-local-manage-denied" => {
            scenario_renderer_local_manage(&mut input, &mut output, false)
        }
        "renderer-manage-response-failure" => {
            scenario_renderer_manage_response_failure(&mut input, &mut output)
        }
        "renderer-target-replacement" => {
            scenario_renderer_target_replacement(&mut input, &mut output)
        }
        "renderer-navigation" => scenario_renderer_navigation(&mut input, &mut output),
        mode @ ("renderer-reentrant"
        | "renderer-reentrant-depth"
        | "renderer-reentrant-deadline"
        | "renderer-reentrant-destroy-activation"
        | "renderer-reentrant-destroy-provider"
        | "renderer-reentrant-destroy-deactivate"
        | "renderer-reentrant-response-failure") => {
            scenario_renderer_reentrant(&mut input, &mut output, mode)
        }
        "pipe-lifetime" => scenario_pipe_lifetime(&mut input, &mut output),
        "probe" => scenario_probe(&mut input, &mut output, ProbeScenario::Success),
        "probe-runtime" => scenario_probe(&mut input, &mut output, ProbeScenario::RuntimeExit(0)),
        "probe-runtime-nonzero" => {
            scenario_probe(&mut input, &mut output, ProbeScenario::RuntimeExit(23))
        }
        "probe-insert-response-lost" => {
            scenario_probe(&mut input, &mut output, ProbeScenario::InsertResponseLost)
        }
        "probe-remove-error" => scenario_probe(&mut input, &mut output, ProbeScenario::RemoveError),
        "probe-reject-arbitrary" => scenario_probe_reject_arbitrary(&mut input, &mut output),
        "wrong-session" => scenario_wrong_session(&mut input, &mut output),
        "whitelist" => scenario_whitelist(&mut output, parsed.sentinel, parsed.sentinel_token),
        other => Err(FakeChildError::UnknownScenario(other.to_owned())),
    }
}

struct ParsedArguments {
    scenario: String,
    child_reader: usize,
    child_writer: usize,
    sentinel: Option<usize>,
    sentinel_token: Option<String>,
}

impl ParsedArguments {
    fn parse(arguments: impl Iterator<Item = OsString>) -> Result<Self, FakeChildError> {
        let mut scenario = None;
        let mut pipes = None;
        let mut sentinel = None;
        let mut sentinel_token = None;
        let mut saw_pipe_mode = false;

        for argument in arguments {
            let argument = os_string_to_ascii(argument)?;
            if argument == "--remote-debugging-pipe=JSON" {
                saw_pipe_mode = true;
            } else if let Some(value) = argument.strip_prefix("--scenario=") {
                scenario = Some(value.to_owned());
            } else if let Some(value) = argument.strip_prefix("--remote-debugging-io-pipes=") {
                let (reader, writer) = value
                    .split_once(',')
                    .ok_or_else(|| FakeChildError::InvalidArgument(argument.clone()))?;
                pipes = Some((parse_handle(reader)?, parse_handle(writer)?));
            } else if let Some(value) = argument.strip_prefix("--sentinel-handle=") {
                sentinel = Some(parse_handle(value)?);
            } else if let Some(value) = argument.strip_prefix("--sentinel-token=") {
                sentinel_token = Some(value.to_owned());
            } else {
                return Err(FakeChildError::InvalidArgument(argument));
            }
        }

        if !saw_pipe_mode {
            return Err(FakeChildError::MissingArgument(
                "--remote-debugging-pipe=JSON",
            ));
        }
        let (child_reader, child_writer) = pipes.ok_or(FakeChildError::MissingArgument(
            "--remote-debugging-io-pipes",
        ))?;
        Ok(Self {
            scenario: scenario.ok_or(FakeChildError::MissingArgument("--scenario"))?,
            child_reader,
            child_writer,
            sentinel,
            sentinel_token,
        })
    }
}

struct RequestReader<'a> {
    input: &'a mut File,
    decoder: NulJsonDecoder,
    queued: VecDeque<Value>,
}

impl<'a> RequestReader<'a> {
    fn new(input: &'a mut File) -> Self {
        Self {
            input,
            decoder: NulJsonDecoder::new(),
            queued: VecDeque::new(),
        }
    }

    fn next(&mut self) -> Result<Value, FakeChildError> {
        self.next_or_eof()?.ok_or_else(|| {
            FakeChildError::InvalidRequest("parent closed before the next request".to_owned())
        })
    }

    fn next_or_eof(&mut self) -> Result<Option<Value>, FakeChildError> {
        loop {
            if let Some(value) = self.queued.pop_front() {
                return Ok(Some(value));
            }
            let mut chunk = [0_u8; 1024];
            let read = self.input.read(&mut chunk)?;
            if read == 0 {
                self.decoder.finish()?;
                return Ok(None);
            }
            self.queued.extend(self.decoder.push(&chunk[..read])?);
        }
    }
}

fn scenario_routing(input: &mut File, output: &mut File) -> Result<(), FakeChildError> {
    let mut reader = RequestReader::new(input);
    let first = request_identity(reader.next()?)?;
    let second = request_identity(reader.next()?)?;
    let event = json!({"method": "Fake.ready", "params": {"coalesced": true}});
    let second_response = json!({"id": second.0, "result": {"method": second.1}});
    let first_response = json!({"id": first.0, "result": {"method": first.1}});
    let mut bytes = framed_bytes(&event)?;
    bytes.extend(framed_bytes(&second_response)?);
    bytes.extend(framed_bytes(&first_response)?);

    let split = bytes.len().min(7);
    output.write_all(&bytes[..split])?;
    output.flush()?;
    std::thread::sleep(std::time::Duration::from_millis(10));
    output.write_all(&bytes[split..])?;
    output.flush()?;
    Ok(())
}

fn scenario_eof(input: &mut File) -> Result<(), FakeChildError> {
    let mut reader = RequestReader::new(input);
    request_identity(reader.next()?)?;
    request_identity(reader.next()?)?;
    Ok(())
}

fn scenario_malformed(input: &mut File, output: &mut File) -> Result<(), FakeChildError> {
    let mut reader = RequestReader::new(input);
    request_identity(reader.next()?)?;
    output.write_all(b"{]\0")?;
    output.flush()?;
    Ok(())
}

fn scenario_late_retired(input: &mut File, output: &mut File) -> Result<(), FakeChildError> {
    const REQUEST_COUNT: u64 = 300;

    let mut reader = RequestReader::new(input);
    let mut first = None;
    for expected_id in 1..=REQUEST_COUNT {
        let request = request_identity(reader.next()?)?;
        if request.0 != expected_id {
            return Err(FakeChildError::InvalidRequest(format!(
                "expected contiguous request id {expected_id}, received {}",
                request.0
            )));
        }
        first.get_or_insert(request);
    }

    let first = first.expect("REQUEST_COUNT is nonzero");
    std::thread::sleep(std::time::Duration::from_millis(2_250));
    write_json_frame(output, &json!({"id": first.0, "result": {"late": first.1}}))?;

    let next = request_identity(reader.next()?)?;
    if next.0 != REQUEST_COUNT + 1 {
        return Err(FakeChildError::InvalidRequest(format!(
            "expected continuation request id {}, received {}",
            REQUEST_COUNT + 1,
            next.0
        )));
    }
    write_json_frame(
        output,
        &json!({"id": next.0, "result": {"continued": next.1}}),
    )?;
    Ok(())
}

fn scenario_future_response(input: &mut File, output: &mut File) -> Result<(), FakeChildError> {
    let mut reader = RequestReader::new(input);
    let request = request_identity(reader.next()?)?;
    let future_id = request
        .0
        .checked_add(1)
        .ok_or_else(|| FakeChildError::InvalidRequest("request id overflowed".to_owned()))?;
    write_json_frame(output, &json!({"id": future_id, "result": {}}))?;
    Ok(())
}

fn scenario_first_issued_id(input: &mut File, output: &mut File) -> Result<(), FakeChildError> {
    let mut reader = RequestReader::new(input);
    let request = request_identity(reader.next()?)?;
    if request.0 != 1 {
        return Err(FakeChildError::InvalidRequest(format!(
            "expected first issued request id 1, received {}",
            request.0
        )));
    }
    write_json_frame(
        output,
        &json!({"id": request.0, "result": {"method": request.1}}),
    )?;
    Ok(())
}

fn scenario_target_delayed(input: &mut File, output: &mut File) -> Result<(), FakeChildError> {
    let mut reader = RequestReader::new(input);
    establish_target_session_with_rounds(
        &mut reader,
        output,
        [
            json!([
                {"targetId": "starting", "type": "page", "url": "about:blank", "title": "Codex", "attached": false},
                {"targetId": "worker", "type": "worker", "url": "app://-/index.html", "title": "Codex", "attached": false}
            ]),
            json!([
                {"targetId": "main", "type": "page", "url": "app://-/index.html", "title": "Codex", "attached": false}
            ]),
        ],
    )
}

fn scenario_target_never_matches(
    input: &mut File,
    output: &mut File,
) -> Result<(), FakeChildError> {
    let mut reader = RequestReader::new(input);
    enable_target_discovery(&mut reader, output)?;
    let mut query_count = 0_u64;
    while let Some(request) = reader.next_or_eof()? {
        query_count += 1;
        let get_targets = expect_method(request, "Target.getTargets", None)?;
        let target_infos = json!([
            {"targetId": format!("starting-{query_count}"), "type": "page", "url": "about:blank", "title": "Codex", "attached": false},
            {"targetId": format!("worker-{query_count}"), "type": "worker", "url": "app://-/index.html", "title": "Codex", "attached": true}
        ]);
        write_json_frame(
            output,
            &json!({
                "id": get_targets,
                "result": {"targetInfos": target_infos}
            }),
        )?;
    }
    Ok(())
}

fn scenario_target_lifecycle(input: &mut File, output: &mut File) -> Result<(), FakeChildError> {
    let mut reader = RequestReader::new(input);
    enable_target_discovery(&mut reader, output)?;

    let get_targets = expect_method(reader.next()?, "Target.getTargets", None)?;
    write_json_frame(
        output,
        &json!({
            "id": get_targets,
            "result": {
                "targetInfos": [
                    {"targetId": "initial-a", "type": "page", "url": "app://-/index.html"},
                    {"targetId": "initial-b", "type": "page", "url": "app://-/index.html"},
                    {"targetId": "blank", "type": "page", "url": "about:blank"},
                    {"targetId": "worker", "type": "worker", "url": "app://-/index.html"}
                ]
            }
        }),
    )?;

    let mut initial_sessions = Vec::new();
    for target_id in ["initial-a", "initial-b"] {
        initial_sessions.push(establish_named_target_session(
            &mut reader,
            output,
            target_id,
        )?);
    }
    for session_id in initial_sessions {
        complete_marker_cycle(&mut reader, output, &session_id)?;
    }

    expect_root_command(&mut reader, output, "Fake.emitCreated")?;
    for target_info in [
        json!({"targetId": "initial-a", "type": "page", "url": "app://-/index.html"}),
        json!({"targetId": "devtools", "type": "page", "url": "devtools://devtools"}),
        json!({"targetId": "created", "type": "page", "url": "app://-/index.html?initialRoute=%2Flocal%2Fthread-created"}),
        json!({"targetId": "created", "type": "page", "url": "app://-/index.html?initialRoute=%2Flocal%2Fthread-created"}),
    ] {
        write_json_frame(
            output,
            &json!({"method": "Target.targetCreated", "params": {"targetInfo": target_info}}),
        )?;
    }
    let created_session = establish_named_target_session(&mut reader, output, "created")?;
    complete_marker_cycle(&mut reader, output, &created_session)?;

    expect_root_command(&mut reader, output, "Fake.emitInfoChanged")?;
    write_json_frame(
        output,
        &json!({
            "method": "Target.targetCreated",
            "params": {"targetInfo": {"targetId": "later", "type": "page", "url": "about:blank"}}
        }),
    )?;
    for _ in 0..2 {
        write_json_frame(
            output,
            &json!({
                "method": "Target.targetInfoChanged",
                "params": {"targetInfo": {"targetId": "later", "type": "page", "url": "app://-/index.html?initialRoute=%2Flocal%2Fthread-later"}}
            }),
        )?;
    }
    let later_session = establish_named_target_session(&mut reader, output, "later")?;
    complete_marker_cycle(&mut reader, output, &later_session)?;

    expect_root_command(&mut reader, output, "Fake.emitDestroyed")?;
    write_json_frame(
        output,
        &json!({"method": "Target.targetDestroyed", "params": {"targetId": "created"}}),
    )?;

    expect_root_command(&mut reader, output, "Fake.emitRecreated")?;
    write_json_frame(
        output,
        &json!({
            "method": "Target.targetCreated",
            "params": {"targetInfo": {"targetId": "created", "type": "page", "url": "app://-/index.html"}}
        }),
    )?;
    let recreated_session = establish_named_target_session(&mut reader, output, "created")?;
    complete_marker_cycle(&mut reader, output, &recreated_session)?;

    expect_root_command(&mut reader, output, "Fake.finish")
}

fn scenario_renderer_runtime(
    input: &mut File,
    output: &mut File,
    context_scenario: &str,
) -> Result<(), FakeChildError> {
    let mut reader = RequestReader::new(input);
    enable_target_discovery(&mut reader, output)?;
    let get_targets = expect_method(reader.next()?, "Target.getTargets", None)?;
    write_json_frame(
        output,
        &json!({
            "id": get_targets,
            "result": {
                "targetInfos": [
                    {"targetId": "main", "type": "page", "url": "app://-/index.html"}
                ]
            }
        }),
    )?;
    let session_id = establish_named_target_session(&mut reader, output, "main")?;
    complete_bundled_renderer_install(&mut reader, output, &session_id, "", 41, 42)?;
    if context_scenario == "renderer-status-context" {
        expect_root_command(&mut reader, output, "Fake.clearContexts")?;
        write_json_frame(
            output,
            &json!({
                "method": "Runtime.executionContextsCleared", "sessionId": session_id, "params": {}
            }),
        )?;
        expect_root_command(&mut reader, output, "Fake.restoreContexts")?;
        for (id, plugin) in [(141, "codex.ui.adapter"), (142, "codlet")] {
            write_json_frame(
                output,
                &json!({
                    "method": "Runtime.executionContextCreated", "sessionId": session_id,
                    "params": {"context": {"id": id, "name": format!("codlet.plugin.{plugin}.g1"), "auxData": {"frameId": "frame-main", "isDefault": false}}}
                }),
            )?;
        }
    }
    if context_scenario == "renderer-subframe-context" {
        expect_root_command(&mut reader, output, "Fake.subframeContexts")?;
        for (id, plugin, frame, is_default) in [
            (241, "codex.ui.adapter", "frame-widget", false),
            (242, "codlet", "frame-widget", false),
            (243, "codlet", "frame-main", true),
        ] {
            write_json_frame(
                output,
                &json!({
                    "method": "Runtime.executionContextCreated", "sessionId": session_id,
                    "params": {"context": {"id": id, "name": format!("codlet.plugin.{plugin}.g1"),
                        "auxData": {"frameId": frame, "isDefault": is_default}}}
                }),
            )?;
            write_json_frame(
                output,
                &json!({
                    "method": "Runtime.executionContextDestroyed", "sessionId": session_id,
                    "params": {"executionContextId": id}
                }),
            )?;
        }
        expect_root_command(&mut reader, output, "Fake.subframeEventsSent")?;
    }
    complete_bundled_renderer_deactivation(&mut reader, output, &session_id, "", 43, 44)?;
    expect_root_command(&mut reader, output, "Fake.finish")
}

fn scenario_renderer_document_recovery(
    input: &mut File,
    output: &mut File,
    timeout_first_recovery: bool,
) -> Result<(), FakeChildError> {
    let mut reader = RequestReader::new(input);
    enable_target_discovery(&mut reader, output)?;
    let request = expect_method(reader.next()?, "Target.getTargets", None)?;
    write_json_frame(
        output,
        &json!({"id":request,"result":{"targetInfos":[
            {"targetId":"main","type":"page","url":"app://-/index.html"}
        ]}}),
    )?;
    let session = establish_named_target_session(&mut reader, output, "main")?;
    let old = complete_bundled_renderer_install(&mut reader, output, &session, "", 41, 42)?;
    expect_root_command(&mut reader, output, "Fake.navigateDocument")?;
    write_json_frame(
        output,
        &json!({"method":"Page.frameNavigated","sessionId":session,
        "params":{"frame":{"id":"frame-main","url":"app://-/index.html#/reloaded","loaderId":"new-document"}}}),
    )?;
    write_json_frame(
        output,
        &json!({"method":"Runtime.executionContextsCleared","sessionId":session,"params":{}}),
    )?;
    expect_root_command(&mut reader, output, "Fake.navigationEventsSent")?;
    complete_bundled_renderer_deactivation(&mut reader, output, &session, "", 143, 144)?;

    if timeout_first_recovery {
        let world = "codlet.plugin.codex.ui.adapter.g1.d2";
        complete_isolated_world(&mut reader, output, &session, world, 41)?;
        expect_renderer_binding(&mut reader, output, &session, world)?;
        expect_renderer_script(
            &mut reader,
            output,
            &session,
            world,
            "__codletRendererV1",
            "recovery-timeout",
        )?;
        complete_renderer_evaluation(
            &mut reader,
            output,
            &session,
            41,
            "__codletRendererV1",
            json!({"ok":true}),
        )?;
        let request = reader.next()?;
        expect_method(request, "Runtime.evaluate", Some(&session))?; // Deliberately never acknowledges activation.
        complete_renderer_evaluation(
            &mut reader,
            output,
            &session,
            41,
            "__rpcClose",
            json!({"ok":true}),
        )?;
        expect_remove_renderer_script(&mut reader, output, &session, "recovery-timeout")?;
        expect_remove_renderer_binding(&mut reader, output, &session)?;
        expect_root_command(&mut reader, output, "Fake.hostStillAlive")?;
        expect_root_command(&mut reader, output, "Fake.retryNavigation")?;
        write_json_frame(
            output,
            &json!({"method":"Page.frameNavigated","sessionId":session,
            "params":{"frame":{"id":"frame-main","url":"app://-/index.html#/retry","loaderId":"retry-document"}}}),
        )?;
        expect_root_command(&mut reader, output, "Fake.navigationEventsSent")?;
    }
    let epoch = if timeout_first_recovery { 3 } else { 2 };

    let mut bindings = Vec::new();
    // Reuse numeric context IDs to model a renderer-process swap. The new
    // document must still receive different worlds and binding identities.
    for (plugin, context, identifier) in [
        ("codex.ui.adapter", 41, "recovery-adapter"),
        ("codlet", 42, "recovery-codlet"),
    ] {
        let world = format!("codlet.plugin.{plugin}.g1.d{epoch}");
        complete_isolated_world(&mut reader, output, &session, &world, context)?;
        bindings.push(expect_renderer_binding(
            &mut reader,
            output,
            &session,
            &world,
        )?);
        expect_renderer_script(
            &mut reader,
            output,
            &session,
            &world,
            "__codletRendererV1",
            identifier,
        )?;
        complete_renderer_evaluation(
            &mut reader,
            output,
            &session,
            context,
            "__codletRendererV1",
            json!({"ok":true}),
        )?;
        complete_renderer_evaluation(
            &mut reader,
            output,
            &session,
            context,
            "runtime.activate",
            json!({"ok":true}),
        )?;
    }
    if bindings[0] == old.adapter_binding || bindings[1] == old.codlet_binding {
        return Err(FakeChildError::InvalidRequest(
            "navigation reused an old renderer binding".into(),
        ));
    }
    expect_root_command(&mut reader, output, "Fake.checkRestoredRpc")?;
    emit_renderer_request(output, &session, &old, 1, "codlet.runtime.ping", "ping")?;
    expect_consumer_error_response(&mut reader, output, &session, 42, "unknown_binding")?;
    let current = RendererBindingInfo {
        adapter_binding: bindings[0].clone(),
        codlet_binding: bindings[1].clone(),
        adapter_context: 41,
        codlet_context: 42,
    };
    emit_renderer_request(
        output,
        &session,
        &current,
        1,
        "codlet.runtime.manage",
        "list",
    )?;
    let (request, response) = read_management_list_response(&mut reader, &session, 42)?;
    let plugins = response
        .pointer("/result/plugins")
        .and_then(Value::as_array)
        .ok_or_else(|| FakeChildError::InvalidRequest("recovered list is absent".into()))?;
    if plugins.len() != 2 || plugins.iter().any(|plugin| plugin["active"] != true) {
        return Err(FakeChildError::InvalidRequest(
            "recovered plugins were not confirmed active".into(),
        ));
    }
    write_evaluation_value(output, request, json!({"ok":true}), &session)?;
    for (plugin, context, identifier) in [
        ("codlet", 42, "recovery-codlet"),
        ("codex.ui.adapter", 41, "recovery-adapter"),
    ] {
        let world = format!("codlet.plugin.{plugin}.g1.d{epoch}");
        complete_isolated_world(&mut reader, output, &session, &world, context)?;
        complete_renderer_evaluation(
            &mut reader,
            output,
            &session,
            context,
            &format!(".deactivate(\"{plugin}\", 1)"),
            json!({"ok":true}),
        )?;
        expect_remove_renderer_script(&mut reader, output, &session, identifier)?;
        expect_remove_renderer_binding(&mut reader, output, &session)?;
    }
    expect_root_command(&mut reader, output, "Fake.finish")
}

fn scenario_lab_environment(input: &mut File, output: &mut File) -> Result<(), FakeChildError> {
    let mut reader = RequestReader::new(input);
    let id = expect_method(reader.next()?, "Fake.environment", None)?;
    let values: serde_json::Map<String, Value> = [
        "SystemRoot",
        "CODLET_LAB_FIXTURE",
        "CODLET_LAB_REMOVE",
        "环境_变量",
        "EMPTY",
    ]
    .into_iter()
    .map(|name| {
        (
            name.to_owned(),
            std::env::var_os(name)
                .map(|value| json!(value.to_string_lossy()))
                .unwrap_or(Value::Null),
        )
    })
    .collect();
    write_json_frame(
        output,
        &json!({"id":id,"result":{
            "environment":values,
            "cwd":std::env::current_dir()?.to_string_lossy(),
            "pid":std::process::id()
        }}),
    )?;
    let close = expect_method(reader.next()?, "Browser.close", None)?;
    write_json_frame(output, &json!({"id":close,"result":{}}))?;
    Ok(())
}

fn expect_held_evaluation(
    reader: &mut RequestReader<'_>,
    session: &str,
    context: u64,
    fragment: &str,
) -> Result<u64, FakeChildError> {
    let request = reader.next()?;
    let id = expect_method(request.clone(), "Runtime.evaluate", Some(session))?;
    if request.pointer("/params/contextId") != Some(&json!(context))
        || request
            .pointer("/params/expression")
            .and_then(Value::as_str)
            .is_none_or(|s| !s.contains(fragment))
    {
        return Err(FakeChildError::InvalidRequest(format!(
            "expected held {fragment} in context {context}, got {request}"
        )));
    }
    Ok(id)
}

fn emit_adapter_ping(
    output: &mut File,
    session: &str,
    bindings: &RendererBindingInfo,
    id: u64,
) -> Result<(), FakeChildError> {
    write_json_frame(
        output,
        &json!({
            "method": "Runtime.bindingCalled", "sessionId": session,
            "params": {"name": bindings.adapter_binding, "executionContextId": bindings.adapter_context,
                "payload": json!({"v":1,"type":"request","pluginId":"codex.ui.adapter","generation":1,"id":id,
                    "capability":{"name":"codlet.runtime.ping","api":1,"scope":"target"},"method":"ping","params":null}).to_string()}
        }),
    )?;
    Ok(())
}

fn destroy_during_wait(
    reader: &mut RequestReader<'_>,
    output: &mut File,
    session: &str,
    bindings: &RendererBindingInfo,
) -> Result<(), FakeChildError> {
    write_json_frame(
        output,
        &json!({"method":"Target.targetDestroyed","params":{"targetId":"main"}}),
    )?;
    emit_renderer_request(
        output,
        session,
        bindings,
        900,
        "codlet.runtime.manage",
        "disableSelf",
    )?;
    // The next command must be root-level: no response, cleanup, or provider
    // dispatch is permitted on the destroyed session, even before controller.pump.
    expect_root_command(reader, output, "Fake.hostStillAlive")?;
    expect_root_command(reader, output, "Fake.finish")
}

fn scenario_renderer_reentrant(
    input: &mut File,
    output: &mut File,
    mode: &str,
) -> Result<(), FakeChildError> {
    let mut reader = RequestReader::new(input);
    enable_target_discovery(&mut reader, output)?;
    let id = expect_method(reader.next()?, "Target.getTargets", None)?;
    write_json_frame(
        output,
        &json!({"id":id,"result":{"targetInfos":[{"targetId":"main","type":"page","url":"app://-/index.html"}]}}),
    )?;
    let session = establish_named_target_session(&mut reader, output, "main")?;
    let (bindings, activation) =
        begin_bundled_renderer_activation(&mut reader, output, &session, "nested", 201, 202)?;
    if mode == "renderer-reentrant-destroy-activation" {
        return destroy_during_wait(&mut reader, output, &session, &bindings);
    }
    if mode == "renderer-reentrant-deadline" {
        let started = std::time::Instant::now();
        std::thread::sleep(std::time::Duration::from_millis(300));
        emit_renderer_request(
            output,
            &session,
            &bindings,
            1,
            "codex.ui.titlebar.afterMenu",
            "getMount",
        )?;
        let provider = expect_held_evaluation(&mut reader, &session, 201, "__rpcInvoke")?;
        // Both outer activation and nested provider remain withheld until the
        // host expires the original 500ms budget and starts retirement.
        complete_renderer_evaluation(
            &mut reader,
            output,
            &session,
            202,
            "__rpcClose",
            json!({"ok":true}),
        )?;
        if started.elapsed() >= std::time::Duration::from_millis(700) {
            return Err(FakeChildError::InvalidRequest(
                "nested wait renewed the activation deadline".to_owned(),
            ));
        }
        write_evaluation_value(output, provider, json!({"ok":true,"value":null}), &session)?;
        write_evaluation_value(output, activation, json!({"ok":true}), &session)?;
        expect_remove_renderer_script(
            &mut reader,
            output,
            &session,
            "script-bootstrap-codlet-nested",
        )?;
        expect_remove_renderer_binding(&mut reader, output, &session)?;
        complete_adapter_renderer_deactivation(&mut reader, output, &session, "nested", 201)?;
        expect_root_command(&mut reader, output, "Fake.hostStillAlive")?;
        return expect_root_command(&mut reader, output, "Fake.finish");
    }
    // Complete a three-level dependency before releasing the activation response.
    emit_renderer_request(
        output,
        &session,
        &bindings,
        1,
        "codex.ui.titlebar.afterMenu",
        "getMount",
    )?;
    let provider = expect_held_evaluation(&mut reader, &session, 201, "__rpcInvoke")?;
    emit_adapter_ping(output, &session, &bindings, 1)?;
    expect_consumer_host_success_response(&mut reader, output, &session, 201)?;
    write_evaluation_value(output, provider, json!({"ok":true,"value":null}), &session)?;
    expect_consumer_success_response(&mut reader, output, &session, 202)?;
    write_evaluation_value(output, activation, json!({"ok":true}), &session)?;

    expect_root_command(&mut reader, output, "Fake.beginNested")?;
    emit_renderer_request(
        output,
        &session,
        &bindings,
        2,
        "codex.ui.titlebar.afterMenu",
        "getMount",
    )?;
    let provider = expect_held_evaluation(&mut reader, &session, 201, "__rpcInvoke")?;
    if mode == "renderer-reentrant-destroy-provider" {
        return destroy_during_wait(&mut reader, output, &session, &bindings);
    }
    if mode == "renderer-reentrant-depth" {
        let mut held = vec![provider];
        for id in 3..=9 {
            emit_renderer_request(
                output,
                &session,
                &bindings,
                id,
                "codex.ui.titlebar.afterMenu",
                "getMount",
            )?;
            held.push(expect_held_evaluation(
                &mut reader,
                &session,
                201,
                "__rpcInvoke",
            )?);
        }
        emit_renderer_request(
            output,
            &session,
            &bindings,
            10,
            "codex.ui.titlebar.afterMenu",
            "getMount",
        )?;
        expect_consumer_error_response(
            &mut reader,
            output,
            &session,
            202,
            "nested wait depth exceeds 8",
        )?;
        for id in held.into_iter().rev() {
            write_evaluation_value(output, id, json!({"ok":true,"value":null}), &session)?;
            expect_consumer_success_response(&mut reader, output, &session, 202)?;
        }
    } else {
        emit_adapter_ping(output, &session, &bindings, 2)?;
        if mode == "renderer-reentrant-response-failure" {
            let reply = expect_held_evaluation(&mut reader, &session, 201, "__rpcReceive")?;
            write_evaluation_value(
                output,
                reply,
                json!({"ok":false,"error":"simulated RPC receive rejection"}),
                &session,
            )?;
            emit_adapter_ping(output, &session, &bindings, 3)?;
        }
        expect_consumer_host_success_response(&mut reader, output, &session, 201)?;
        write_evaluation_value(output, provider, json!({"ok":true,"value":null}), &session)?;
        expect_consumer_success_response(&mut reader, output, &session, 202)?;
    }
    expect_root_command(&mut reader, output, "Fake.hostStillAlive")?;
    complete_isolated_world(
        &mut reader,
        output,
        &session,
        "codlet.plugin.codlet.g1",
        202,
    )?;
    let deactivate =
        expect_held_evaluation(&mut reader, &session, 202, ".deactivate(\"codlet\", 1)")?;
    if mode == "renderer-reentrant-destroy-deactivate" {
        return destroy_during_wait(&mut reader, output, &session, &bindings);
    }
    emit_renderer_request(
        output,
        &session,
        &bindings,
        20,
        "codlet.runtime.manage",
        "disableSelf",
    )?;
    expect_consumer_error_response(&mut reader, output, &session, 202, "plugin_not_active")?;
    emit_renderer_request(
        output,
        &session,
        &bindings,
        21,
        "codex.ui.titlebar.afterMenu",
        "getMount",
    )?;
    let provider = expect_held_evaluation(&mut reader, &session, 201, "__rpcInvoke")?;
    emit_adapter_ping(output, &session, &bindings, 20)?;
    expect_consumer_host_success_response(&mut reader, output, &session, 201)?;
    write_evaluation_value(output, provider, json!({"ok":true,"value":null}), &session)?;
    expect_consumer_success_response(&mut reader, output, &session, 202)?;
    emit_renderer_request(
        output,
        &session,
        &bindings,
        22,
        "codlet.runtime.ping",
        "ping",
    )?;
    expect_consumer_host_success_response(&mut reader, output, &session, 202)?;
    write_evaluation_value(output, deactivate, json!({"ok":true}), &session)?;
    expect_remove_renderer_script(
        &mut reader,
        output,
        &session,
        "script-bootstrap-codlet-nested",
    )?;
    expect_remove_renderer_binding(&mut reader, output, &session)?;
    complete_adapter_renderer_deactivation(&mut reader, output, &session, "nested", 201)?;
    expect_root_command(&mut reader, output, "Fake.finish")
}

fn scenario_renderer_ready_handshake(
    input: &mut File,
    output: &mut File,
) -> Result<(), FakeChildError> {
    let mut reader = RequestReader::new(input);
    enable_target_discovery(&mut reader, output)?;
    let get_targets = expect_method(reader.next()?, "Target.getTargets", None)?;
    write_json_frame(
        output,
        &json!({
            "id": get_targets,
            "result": {
                "targetInfos": [
                    {"targetId": "main", "type": "page", "url": "app://-/index.html"}
                ]
            }
        }),
    )?;
    let session_id = establish_named_target_session(&mut reader, output, "main")?;
    complete_bundled_renderer_install_with_ready_handshake(
        &mut reader,
        output,
        &session_id,
        "ready",
        121,
        122,
    )?;
    complete_bundled_renderer_deactivation(&mut reader, output, &session_id, "ready", 123, 124)?;
    expect_root_command(&mut reader, output, "Fake.finish")
}

fn scenario_renderer_ready_rejection(
    input: &mut File,
    output: &mut File,
) -> Result<(), FakeChildError> {
    let mut reader = RequestReader::new(input);
    enable_target_discovery(&mut reader, output)?;
    let get_targets = expect_method(reader.next()?, "Target.getTargets", None)?;
    write_json_frame(
        output,
        &json!({
            "id": get_targets,
            "result": {
                "targetInfos": [
                    {"targetId": "main", "type": "page", "url": "app://-/index.html"}
                ]
            }
        }),
    )?;
    let session_id = establish_named_target_session(&mut reader, output, "main")?;
    let (bindings, activation_id) = begin_bundled_renderer_activation(
        &mut reader,
        output,
        &session_id,
        "ready-rejection",
        125,
        126,
    )?;

    emit_renderer_request(
        output,
        &session_id,
        &bindings,
        1,
        "codlet.runtime.manage",
        "disableSelf",
    )?;
    expect_consumer_error_response(
        &mut reader,
        output,
        &session_id,
        bindings.codlet_context,
        "plugin_not_active",
    )?;
    write_evaluation_value(
        output,
        activation_id,
        json!({"ok": false, "error": "activation self-disable rejected"}),
        &session_id,
    )?;

    complete_renderer_evaluation(
        &mut reader,
        output,
        &session_id,
        126,
        "__rpcClose",
        json!({"ok": true}),
    )?;

    expect_remove_renderer_script(
        &mut reader,
        output,
        &session_id,
        "script-bootstrap-codlet-ready-rejection",
    )?;
    expect_remove_renderer_binding(&mut reader, output, &session_id)?;
    complete_adapter_renderer_deactivation(
        &mut reader,
        output,
        &session_id,
        "ready-rejection",
        127,
    )?;
    expect_root_command(&mut reader, output, "Fake.hostStillAlive")?;
    expect_root_command(&mut reader, output, "Fake.finish")
}

fn scenario_renderer_ready_timeout(
    input: &mut File,
    output: &mut File,
) -> Result<(), FakeChildError> {
    let mut reader = RequestReader::new(input);
    enable_target_discovery(&mut reader, output)?;
    let get_targets = expect_method(reader.next()?, "Target.getTargets", None)?;
    write_json_frame(
        output,
        &json!({
            "id": get_targets,
            "result": {
                "targetInfos": [
                    {"targetId": "main", "type": "page", "url": "app://-/index.html"}
                ]
            }
        }),
    )?;
    let session_id = establish_named_target_session(&mut reader, output, "main")?;
    let (_bindings, _activation_id) = begin_bundled_renderer_activation(
        &mut reader,
        output,
        &session_id,
        "ready-timeout",
        127,
        128,
    )?;

    complete_renderer_evaluation(
        &mut reader,
        output,
        &session_id,
        128,
        "__rpcClose",
        json!({"ok": true}),
    )?;

    expect_remove_renderer_script(
        &mut reader,
        output,
        &session_id,
        "script-bootstrap-codlet-ready-timeout",
    )?;
    expect_remove_renderer_binding(&mut reader, output, &session_id)?;
    complete_adapter_renderer_deactivation(&mut reader, output, &session_id, "ready-timeout", 129)?;
    expect_root_command(&mut reader, output, "Fake.hostStillAlive")?;
    expect_root_command(&mut reader, output, "Fake.finish")
}

fn scenario_renderer_rpc(input: &mut File, output: &mut File) -> Result<(), FakeChildError> {
    let mut reader = RequestReader::new(input);
    enable_target_discovery(&mut reader, output)?;
    let get_targets = expect_method(reader.next()?, "Target.getTargets", None)?;
    write_json_frame(
        output,
        &json!({
            "id": get_targets,
            "result": {
                "targetInfos": [
                    {"targetId": "main", "type": "page", "url": "app://-/index.html"}
                ]
            }
        }),
    )?;
    let session_id = establish_named_target_session(&mut reader, output, "main")?;
    let bindings =
        complete_bundled_renderer_install(&mut reader, output, &session_id, "rpc", 91, 92)?;

    let capability = json!({
        "name": "codex.ui.titlebar.afterMenu",
        "api": 1,
        "scope": "target"
    });
    let host_request = json!({
        "v": 1,
        "type": "request",
        "pluginId": "codlet",
        "generation": 1,
        "id": 1,
        "capability": {
            "name": "codlet.runtime.ping",
            "api": 1,
            "scope": "target"
        },
        "method": "ping",
        "params": null
    });
    write_json_frame(
        output,
        &json!({
            "method": "Runtime.bindingCalled",
            "params": {
                "name": bindings.codlet_binding,
                "payload": serde_json::to_string(&host_request).expect("request serializes"),
                "executionContextId": bindings.codlet_context
            },
            "sessionId": session_id
        }),
    )?;
    expect_consumer_host_success_response(
        &mut reader,
        output,
        &session_id,
        bindings.codlet_context,
    )?;
    let renderer_request_command = expect_method(reader.next()?, "Fake.emitRendererRequest", None)?;
    write_json_frame(
        output,
        &json!({"id": renderer_request_command, "result": {}}),
    )?;
    let first_request = json!({
        "v": 1,
        "type": "request",
        "pluginId": "codlet",
        "generation": 1,
        "id": 2,
        "capability": capability.clone(),
        "method": "getMount",
        "params": null
    });
    write_json_frame(
        output,
        &json!({
            "method": "Runtime.bindingCalled",
            "params": {
                "name": bindings.codlet_binding,
                "payload": serde_json::to_string(&first_request).expect("request serializes"),
                "executionContextId": bindings.codlet_context
            },
            "sessionId": session_id
        }),
    )?;
    complete_provider_invocation(&mut reader, output, &session_id, &bindings, false)?;
    let duplicate_command = expect_method(reader.next()?, "Fake.emitDuplicateRequest", None)?;
    write_json_frame(output, &json!({"id": duplicate_command, "result": {}}))?;
    write_json_frame(
        output,
        &json!({
            "method": "Runtime.bindingCalled",
            "params": {
                "name": bindings.codlet_binding,
                "payload": serde_json::to_string(&first_request).expect("request serializes"),
                "executionContextId": bindings.codlet_context
            },
            "sessionId": session_id
        }),
    )?;
    expect_consumer_error_response(
        &mut reader,
        output,
        &session_id,
        bindings.codlet_context,
        "duplicate_request_id",
    )?;

    let stale_command = expect_method(reader.next()?, "Fake.emitStale", None)?;
    write_json_frame(output, &json!({"id": stale_command, "result": {}}))?;
    let stale_request = json!({
        "v": 1,
        "type": "request",
        "pluginId": "codlet",
        "generation": 0,
        "id": 3,
        "capability": capability.clone(),
        "method": "getMount",
        "params": null
    });
    write_json_frame(
        output,
        &json!({
            "method": "Runtime.bindingCalled",
            "params": {
                "name": bindings.codlet_binding,
                "payload": serde_json::to_string(&stale_request).expect("request serializes"),
                "executionContextId": bindings.codlet_context
            },
            "sessionId": session_id
        }),
    )?;
    expect_consumer_error_response(
        &mut reader,
        output,
        &session_id,
        bindings.codlet_context,
        "stale_generation",
    )?;

    let unknown_command = expect_method(reader.next()?, "Fake.emitUnknownBinding", None)?;
    write_json_frame(output, &json!({"id": unknown_command, "result": {}}))?;
    write_json_frame(
        output,
        &json!({
            "method": "Runtime.bindingCalled",
            "params": {
                "name": "codlet_rpc_v1_unknown",
                "payload": serde_json::to_string(&first_request).expect("request serializes"),
                "executionContextId": bindings.codlet_context
            },
            "sessionId": session_id
        }),
    )?;
    expect_consumer_error_response(
        &mut reader,
        output,
        &session_id,
        bindings.codlet_context,
        "unknown_binding",
    )?;

    let wrong_session_command =
        expect_method(reader.next()?, "Fake.emitWrongBindingSession", None)?;
    write_json_frame(output, &json!({"id": wrong_session_command, "result": {}}))?;
    write_json_frame(
        output,
        &json!({
            "method": "Runtime.bindingCalled",
            "params": {
                "name": bindings.codlet_binding,
                "payload": serde_json::to_string(&first_request).expect("request serializes"),
                "executionContextId": bindings.codlet_context
            },
            "sessionId": "dead-session"
        }),
    )?;

    complete_isolated_world(
        &mut reader,
        output,
        &session_id,
        "codlet.plugin.codlet.g1",
        bindings.codlet_context,
    )?;
    complete_renderer_evaluation(
        &mut reader,
        output,
        &session_id,
        bindings.codlet_context,
        ".deactivate(\"codlet\", 1)",
        json!({"ok": true, "id": "codlet", "generation": 1, "inactive": true}),
    )?;
    expect_remove_renderer_script(
        &mut reader,
        output,
        &session_id,
        "script-bootstrap-codlet-rpc",
    )?;
    expect_remove_renderer_binding(&mut reader, output, &session_id)?;

    complete_isolated_world(
        &mut reader,
        output,
        &session_id,
        "codlet.plugin.codex.ui.adapter.g1",
        bindings.adapter_context,
    )?;
    complete_renderer_evaluation(
        &mut reader,
        output,
        &session_id,
        bindings.adapter_context,
        ".deactivate(\"codex.ui.adapter\", 1)",
        json!({"ok": true, "id": "codex.ui.adapter", "generation": 1, "inactive": true}),
    )?;
    expect_remove_renderer_script(
        &mut reader,
        output,
        &session_id,
        "script-bootstrap-adapter-rpc",
    )?;
    expect_remove_renderer_binding(&mut reader, output, &session_id)?;
    write_json_frame(
        output,
        &json!({
            "method": "Runtime.bindingCalled",
            "params": {
                "name": bindings.codlet_binding,
                "payload": serde_json::to_string(&first_request).expect("request serializes"),
                "executionContextId": bindings.codlet_context
            },
            "sessionId": session_id
        }),
    )?;
    expect_root_command(&mut reader, output, "Fake.finish")
}

fn scenario_renderer_manage(input: &mut File, output: &mut File) -> Result<(), FakeChildError> {
    let mut reader = RequestReader::new(input);
    enable_target_discovery(&mut reader, output)?;
    let get_targets = expect_method(reader.next()?, "Target.getTargets", None)?;
    write_json_frame(
        output,
        &json!({
            "id": get_targets,
            "result": {
                "targetInfos": [
                    {"targetId": "main", "type": "page", "url": "app://-/index.html"},
                    {"targetId": "cleanup-failure", "type": "page", "url": "app://-/index.html"}
                ]
            }
        }),
    )?;
    let session_id = establish_named_target_session(&mut reader, output, "main")?;
    let failure_session = establish_named_target_session(&mut reader, output, "cleanup-failure")?;
    let bindings =
        complete_bundled_renderer_install(&mut reader, output, &session_id, "manage", 101, 102)?;
    complete_bundled_renderer_install(
        &mut reader,
        output,
        &failure_session,
        "manage-failure",
        103,
        104,
    )?;

    expect_root_command(&mut reader, output, "Fake.emitDisableSelf")?;
    emit_disable_self_binding(output, &session_id, &bindings)?;
    expect_consumer_management_success_response(
        &mut reader,
        output,
        &session_id,
        bindings.codlet_context,
    )?;

    complete_isolated_world(
        &mut reader,
        output,
        &failure_session,
        "codlet.plugin.codlet.g1",
        105,
    )?;
    complete_renderer_evaluation(
        &mut reader,
        output,
        &failure_session,
        105,
        ".deactivate(\"codlet\", 1)",
        json!({"ok": false, "error": "simulated codlet cleanup failure"}),
    )?;
    complete_renderer_evaluation(
        &mut reader,
        output,
        &failure_session,
        105,
        "__rpcClose",
        json!({"ok": true}),
    )?;
    expect_remove_renderer_script(
        &mut reader,
        output,
        &failure_session,
        "script-bootstrap-codlet-manage-failure",
    )?;
    expect_remove_renderer_binding(&mut reader, output, &failure_session)?;

    complete_isolated_world(
        &mut reader,
        output,
        &session_id,
        "codlet.plugin.codlet.g1",
        106,
    )?;
    complete_renderer_evaluation(
        &mut reader,
        output,
        &session_id,
        106,
        ".deactivate(\"codlet\", 1)",
        json!({"ok": true, "id": "codlet", "generation": 1, "inactive": true}),
    )?;
    expect_remove_renderer_script(
        &mut reader,
        output,
        &session_id,
        "script-bootstrap-codlet-manage",
    )?;
    expect_remove_renderer_binding(&mut reader, output, &session_id)?;

    expect_root_command(&mut reader, output, "Fake.createTargetAfterDisable")?;
    write_json_frame(
        output,
        &json!({
            "method": "Target.targetCreated",
            "params": {
                "targetInfo": {
                    "targetId": "after-disable",
                    "type": "page",
                    "url": "app://-/index.html"
                }
            }
        }),
    )?;
    let after_disable_session =
        establish_named_target_session(&mut reader, output, "after-disable")?;
    complete_adapter_renderer_install(
        &mut reader,
        output,
        &after_disable_session,
        "after-disable",
        107,
    )?;

    complete_adapter_renderer_deactivation(
        &mut reader,
        output,
        &after_disable_session,
        "after-disable",
        108,
    )?;
    complete_adapter_renderer_deactivation(&mut reader, output, &session_id, "manage", 109)?;
    complete_adapter_renderer_deactivation(
        &mut reader,
        output,
        &failure_session,
        "manage-failure",
        110,
    )?;
    expect_root_command(&mut reader, output, "Fake.finish")
}

fn scenario_renderer_local_manage(
    input: &mut File,
    output: &mut File,
    has_grant: bool,
) -> Result<(), FakeChildError> {
    let mut reader = RequestReader::new(input);
    establish_target_session(&mut reader, output)?;
    let session = "session-main";
    complete_bundled_renderer_install(&mut reader, output, session, "local", 301, 302)?;
    let world = "codlet.plugin.dev.local.g1";
    complete_isolated_world(&mut reader, output, session, world, 303)?;
    let binding = expect_renderer_binding(&mut reader, output, session, world)?;
    expect_renderer_script(
        &mut reader,
        output,
        session,
        world,
        "__codletRendererV1",
        "local-bootstrap",
    )?;
    complete_renderer_evaluation(
        &mut reader,
        output,
        session,
        303,
        "__codletRendererV1",
        json!({"ok":true}),
    )?;
    let activation = expect_held_evaluation(&mut reader, session, 303, "fixture-local-source")?;
    emit_local_manage_request(output, session, &binding, 1, "list")?;
    if has_grant {
        expect_local_management_list(&mut reader, output, session, false, true)?;
    } else {
        expect_consumer_error_response(&mut reader, output, session, 303, "permission_denied")?;
    }
    write_evaluation_value(output, activation, json!({"ok":true}), session)?;

    expect_root_command(&mut reader, output, "Fake.emitLocalList")?;
    emit_local_manage_request(output, session, &binding, 2, "list")?;
    if has_grant {
        expect_local_management_list(&mut reader, output, session, true, true)?;
    } else {
        expect_consumer_error_response(&mut reader, output, session, 303, "permission_denied")?;
    }
    expect_root_command(&mut reader, output, "Fake.emitLocalDisable")?;
    emit_local_manage_request(output, session, &binding, 3, "disableSelf")?;
    if has_grant {
        expect_consumer_management_success_response(&mut reader, output, session, 303)?;
    } else {
        expect_consumer_error_response(&mut reader, output, session, 303, "permission_denied")?;
        expect_root_command(&mut reader, output, "Fake.hostStillAlive")?;
    }

    complete_isolated_world(&mut reader, output, session, world, 303)?;
    let deactivate =
        expect_held_evaluation(&mut reader, session, 303, ".deactivate(\"dev.local\", 1)")?;
    emit_local_manage_request(output, session, &binding, 4, "list")?;
    if has_grant {
        expect_local_management_list(&mut reader, output, session, false, false)?;
    } else {
        expect_consumer_error_response(&mut reader, output, session, 303, "permission_denied")?;
    }
    write_evaluation_value(output, deactivate, json!({"ok":true}), session)?;
    expect_remove_renderer_script(&mut reader, output, session, "local-bootstrap")?;
    expect_remove_renderer_binding(&mut reader, output, session)?;
    complete_bundled_renderer_deactivation(&mut reader, output, session, "local", 302, 301)?;
    expect_root_command(&mut reader, output, "Fake.finish")
}

fn emit_local_manage_request(
    output: &mut File,
    session: &str,
    binding: &str,
    id: u64,
    method: &str,
) -> Result<(), FakeChildError> {
    let payload = json!({"v":1,"type":"request","pluginId":"dev.local","generation":1,"id":id,
        "capability":{"name":"codlet.runtime.manage","api":1,"scope":"target"},"method":method,"params":null});
    write_json_frame(
        output,
        &json!({"method":"Runtime.bindingCalled","sessionId":session,
        "params":{"name":binding,"executionContextId":303,"payload":payload.to_string()}}),
    )?;
    Ok(())
}

fn expect_local_management_list(
    reader: &mut RequestReader<'_>,
    output: &mut File,
    session: &str,
    active: bool,
    enabled: bool,
) -> Result<(), FakeChildError> {
    let (id, response) = read_management_list_response(reader, session, 303)?;
    let plugins = response
        .pointer("/result/plugins")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            FakeChildError::InvalidRequest(
                "local management response has no plugin list".to_owned(),
            )
        })?;
    let local = plugins.iter().find(|plugin| plugin["id"] == "dev.local");
    let broken = plugins.iter().find(|plugin| plugin["id"] == "dev.broken");
    if local.is_none_or(|plugin| {
        plugin["active"] != active
            || plugin["enabled"] != enabled
            || plugin["source"] != "local"
            || plugin["version"] != "1"
            || plugin["grants"] != json!(["runtime.manage"])
            || plugin["requestedPermissions"] != json!(["runtime.manage"])
            || plugin["validation"]["status"] != "ok"
            || !plugin["path"].is_string()
    }) || broken.is_none_or(|plugin| {
        plugin["active"] != false
            || plugin["enabled"] != false
            || plugin["validation"]["status"] != "failed"
            || !plugin["version"].is_null()
    }) || plugins.iter().any(|plugin| plugin["id"] == "dev.later")
    {
        return Err(FakeChildError::InvalidRequest(format!(
            "incorrect local management snapshot: {response}"
        )));
    }
    write_evaluation_value(output, id, json!({"ok":true}), session)
}

fn scenario_renderer_manage_response_failure(
    input: &mut File,
    output: &mut File,
) -> Result<(), FakeChildError> {
    let mut reader = RequestReader::new(input);
    enable_target_discovery(&mut reader, output)?;
    let get_targets = expect_method(reader.next()?, "Target.getTargets", None)?;
    write_json_frame(
        output,
        &json!({
            "id": get_targets,
            "result": {
                "targetInfos": [
                    {"targetId": "main", "type": "page", "url": "app://-/index.html"}
                ]
            }
        }),
    )?;
    let session_id = establish_named_target_session(&mut reader, output, "main")?;
    let bindings = complete_bundled_renderer_install(
        &mut reader,
        output,
        &session_id,
        "manage-response-failure",
        111,
        112,
    )?;

    expect_root_command(&mut reader, output, "Fake.emitDisableSelf")?;
    emit_disable_self_binding(output, &session_id, &bindings)?;
    expect_consumer_management_rejected_response(
        &mut reader,
        output,
        &session_id,
        bindings.codlet_context,
    )?;

    complete_isolated_world(
        &mut reader,
        output,
        &session_id,
        "codlet.plugin.codlet.g1",
        113,
    )?;
    complete_renderer_evaluation(
        &mut reader,
        output,
        &session_id,
        113,
        ".deactivate(\"codlet\", 1)",
        json!({"ok": true, "id": "codlet", "generation": 1, "inactive": true}),
    )?;
    expect_remove_renderer_script(
        &mut reader,
        output,
        &session_id,
        "script-bootstrap-codlet-manage-response-failure",
    )?;
    expect_remove_renderer_binding(&mut reader, output, &session_id)?;

    expect_root_command(&mut reader, output, "Fake.hostStillAlive")?;
    complete_adapter_renderer_deactivation(
        &mut reader,
        output,
        &session_id,
        "manage-response-failure",
        114,
    )?;
    expect_root_command(&mut reader, output, "Fake.finish")
}

fn emit_disable_self_binding(
    output: &mut File,
    session_id: &str,
    bindings: &RendererBindingInfo,
) -> Result<(), FakeChildError> {
    let request = json!({
        "v": 1,
        "type": "request",
        "pluginId": "codlet",
        "generation": 1,
        "id": 1,
        "capability": {
            "name": "codlet.runtime.manage",
            "api": 1,
            "scope": "target"
        },
        "method": "disableSelf",
        "params": null
    });
    write_json_frame(
        output,
        &json!({
            "method": "Runtime.bindingCalled",
            "params": {
                "name": bindings.codlet_binding,
                "payload": serde_json::to_string(&request).expect("request serializes"),
                "executionContextId": bindings.codlet_context
            },
            "sessionId": session_id
        }),
    )?;
    Ok(())
}

fn complete_provider_invocation(
    reader: &mut RequestReader<'_>,
    output: &mut File,
    session_id: &str,
    bindings: &RendererBindingInfo,
    _expect_error: bool,
) -> Result<(), FakeChildError> {
    let provider_request = reader.next()?;
    let provider_id = expect_method(
        provider_request.clone(),
        "Runtime.evaluate",
        Some(session_id),
    )?;
    let expression = provider_request
        .pointer("/params/expression")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            FakeChildError::InvalidRequest("provider expression is not a string".to_owned())
        })?;
    if provider_request.pointer("/params/contextId") != Some(&json!(bindings.adapter_context))
        || !expression.contains("__rpcInvoke")
        || !expression.contains(&bindings.adapter_binding)
    {
        return Err(FakeChildError::InvalidRequest(
            "provider endpoint action did not use the adapter binding".to_owned(),
        ));
    }
    write_evaluation_value(
        output,
        provider_id,
        json!({"ok": true, "value": {"available": true, "token": "fake-mount"}}),
        session_id,
    )?;
    expect_consumer_success_response(reader, output, session_id, bindings.codlet_context)
}

fn expect_consumer_success_response(
    reader: &mut RequestReader<'_>,
    output: &mut File,
    session_id: &str,
    context_id: u64,
) -> Result<(), FakeChildError> {
    let request = reader.next()?;
    let id = expect_method(request.clone(), "Runtime.evaluate", Some(session_id))?;
    if request.pointer("/params/contextId") != Some(&json!(context_id))
        || request
            .pointer("/params/expression")
            .and_then(Value::as_str)
            .is_none_or(|expression| {
                !expression.contains("__rpcReceive")
                    || (!expression.contains("\"ok\":true")
                        && !expression.contains("\\\"ok\\\":true"))
            })
    {
        return Err(FakeChildError::InvalidRequest(
            "consumer response did not carry a successful RPC result".to_owned(),
        ));
    }
    write_evaluation_value(output, id, json!({"ok": true}), session_id)
}

fn expect_consumer_host_success_response(
    reader: &mut RequestReader<'_>,
    output: &mut File,
    session_id: &str,
    context_id: u64,
) -> Result<(), FakeChildError> {
    let request = reader.next()?;
    let id = expect_method(request.clone(), "Runtime.evaluate", Some(session_id))?;
    if request.pointer("/params/contextId") != Some(&json!(context_id))
        || request
            .pointer("/params/expression")
            .and_then(Value::as_str)
            .is_none_or(|expression| {
                !expression.contains("__rpcReceive")
                    || (!expression.contains("\"pong\":true")
                        && !expression.contains("\\\"pong\\\":true"))
            })
    {
        return Err(FakeChildError::InvalidRequest(
            "consumer response did not carry the host ping result".to_owned(),
        ));
    }
    write_evaluation_value(output, id, json!({"ok": true}), session_id)
}

fn expect_consumer_management_success_response(
    reader: &mut RequestReader<'_>,
    output: &mut File,
    session_id: &str,
    context_id: u64,
) -> Result<(), FakeChildError> {
    let request = reader.next()?;
    let id = expect_method(request.clone(), "Runtime.evaluate", Some(session_id))?;
    if request.pointer("/params/contextId") != Some(&json!(context_id))
        || request
            .pointer("/params/expression")
            .and_then(Value::as_str)
            .is_none_or(|expression| {
                !expression.contains("__rpcReceive")
                    || (!expression.contains("\"enabled\":false")
                        && !expression.contains("\\\"enabled\\\":false"))
            })
    {
        return Err(FakeChildError::InvalidRequest(
            "consumer response did not confirm persisted self-disable".to_owned(),
        ));
    }
    write_evaluation_value(output, id, json!({"ok": true}), session_id)
}

fn expect_consumer_management_list_response(
    reader: &mut RequestReader<'_>,
    output: &mut File,
    session_id: &str,
    context_id: u64,
) -> Result<(), FakeChildError> {
    let (id, response) = read_management_list_response(reader, session_id, context_id)?;
    let plugins = response
        .pointer("/result/plugins")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            FakeChildError::InvalidRequest("management response has no plugin list".to_owned())
        })?;
    for (plugin_id, expected_active) in [("codex.ui.adapter", true), ("codlet", false)] {
        if plugins
            .iter()
            .find(|plugin| plugin["id"] == plugin_id)
            .is_none_or(|plugin| plugin["active"] != expected_active)
        {
            return Err(FakeChildError::InvalidRequest(format!(
                "incorrect ready-handshake active state: {response}"
            )));
        }
    }
    write_evaluation_value(output, id, json!({"ok": true}), session_id)
}

fn read_management_list_response(
    reader: &mut RequestReader<'_>,
    session_id: &str,
    context_id: u64,
) -> Result<(u64, Value), FakeChildError> {
    let request = reader.next()?;
    let id = expect_method(request.clone(), "Runtime.evaluate", Some(session_id))?;
    if request.pointer("/params/contextId") != Some(&json!(context_id))
        || request
            .pointer("/params/expression")
            .and_then(Value::as_str)
            .is_none_or(|expression| {
                !expression.contains("__rpcReceive") || !expression.contains("plugins")
            })
    {
        return Err(FakeChildError::InvalidRequest(
            "consumer response did not carry the runtime plugin list".to_owned(),
        ));
    }
    let encoded = request
        .pointer("/params/expression")
        .and_then(Value::as_str)
        .and_then(|expression| expression.rsplit_once(", JSON.parse("))
        .and_then(|(_, suffix)| suffix.strip_suffix("))"))
        .ok_or_else(|| {
            FakeChildError::InvalidRequest("management response wrapper is invalid".to_owned())
        })?;
    let json: String = serde_json::from_str(encoded)
        .map_err(|error| FakeChildError::InvalidRequest(error.to_string()))?;
    let response: Value = serde_json::from_str(&json)
        .map_err(|error| FakeChildError::InvalidRequest(error.to_string()))?;
    Ok((id, response))
}

fn expect_consumer_management_rejected_response(
    reader: &mut RequestReader<'_>,
    output: &mut File,
    session_id: &str,
    context_id: u64,
) -> Result<(), FakeChildError> {
    let request = reader.next()?;
    let id = expect_method(request.clone(), "Runtime.evaluate", Some(session_id))?;
    if request.pointer("/params/contextId") != Some(&json!(context_id))
        || request
            .pointer("/params/expression")
            .and_then(Value::as_str)
            .is_none_or(|expression| {
                !expression.contains("__rpcReceive")
                    || (!expression.contains("\"enabled\":false")
                        && !expression.contains("\\\"enabled\\\":false"))
            })
    {
        return Err(FakeChildError::InvalidRequest(
            "rejected consumer response did not confirm persisted self-disable".to_owned(),
        ));
    }
    write_evaluation_exception(
        output,
        id,
        "simulated management response delivery failure",
        session_id,
    )
}

fn expect_consumer_error_response(
    reader: &mut RequestReader<'_>,
    output: &mut File,
    session_id: &str,
    context_id: u64,
    code: &str,
) -> Result<(), FakeChildError> {
    let request = reader.next()?;
    let id = expect_method(request.clone(), "Runtime.evaluate", Some(session_id))?;
    if request.pointer("/params/contextId") != Some(&json!(context_id))
        || request
            .pointer("/params/expression")
            .and_then(Value::as_str)
            .is_none_or(|expression| {
                !expression.contains("__rpcReceive") || !expression.contains(code)
            })
    {
        return Err(FakeChildError::InvalidRequest(format!(
            "consumer response did not carry {code} rejection"
        )));
    }
    write_evaluation_value(output, id, json!({"ok": true}), session_id)
}

fn scenario_renderer_target_replacement(
    input: &mut File,
    output: &mut File,
) -> Result<(), FakeChildError> {
    let mut reader = RequestReader::new(input);
    enable_target_discovery(&mut reader, output)?;
    let get_targets = expect_method(reader.next()?, "Target.getTargets", None)?;
    write_json_frame(
        output,
        &json!({
            "id": get_targets,
            "result": {
                "targetInfos": [
                    {"targetId": "main", "type": "page", "url": "app://-/index.html"}
                ]
            }
        }),
    )?;
    let first_session =
        establish_target_session_with_id(&mut reader, output, "main", "session-main-1")?;
    let first_bindings =
        complete_bundled_renderer_install(&mut reader, output, &first_session, "first", 51, 52)?;

    expect_root_command(&mut reader, output, "Fake.replaceTarget")?;
    write_json_frame(
        output,
        &json!({"method": "Target.targetDestroyed", "params": {"targetId": "main"}}),
    )?;
    write_json_frame(
        output,
        &json!({
            "method": "Runtime.bindingCalled",
            "params": {
                "name": first_bindings.codlet_binding,
                "payload": "{}",
                "executionContextId": first_bindings.codlet_context
            },
            "sessionId": first_session
        }),
    )?;
    write_json_frame(
        output,
        &json!({
            "method": "Target.targetCreated",
            "params": {"targetInfo": {"targetId": "main", "type": "page", "url": "app://-/index.html"}}
        }),
    )?;
    let second_session =
        establish_target_session_with_id(&mut reader, output, "main", "session-main-2")?;
    complete_bundled_renderer_install(&mut reader, output, &second_session, "second", 61, 62)?;
    expect_root_command(&mut reader, output, "Fake.emitLateDetach")?;
    write_json_frame(
        output,
        &json!({
            "method": "Target.detachedFromTarget",
            "params": {"sessionId": "session-main-1", "targetId": "main"}
        }),
    )?;
    complete_bundled_renderer_deactivation(&mut reader, output, &second_session, "second", 63, 64)?;
    expect_root_command(&mut reader, output, "Fake.finish")
}

fn scenario_renderer_navigation(input: &mut File, output: &mut File) -> Result<(), FakeChildError> {
    let mut reader = RequestReader::new(input);
    enable_target_discovery(&mut reader, output)?;
    let get_targets = expect_method(reader.next()?, "Target.getTargets", None)?;
    write_json_frame(
        output,
        &json!({
            "id": get_targets,
            "result": {"targetInfos": [{"targetId": "main", "type": "page", "url": "app://-/index.html"}]}
        }),
    )?;
    let first_session =
        establish_target_session_with_id(&mut reader, output, "main", "session-main-nav-1")?;
    complete_bundled_renderer_install(&mut reader, output, &first_session, "nav-1", 71, 72)?;

    expect_root_command(&mut reader, output, "Fake.navigateAway")?;
    write_json_frame(
        output,
        &json!({
            "method": "Target.targetInfoChanged",
            "params": {"targetInfo": {"targetId": "main", "type": "page", "url": "about:blank"}}
        }),
    )?;
    for identifier in [
        "script-bootstrap-codlet-nav-1",
        "script-bootstrap-adapter-nav-1",
    ] {
        expect_remove_renderer_script(&mut reader, output, "session-main-nav-1", identifier)?;
        expect_remove_renderer_binding(&mut reader, output, "session-main-nav-1")?;
    }
    let detach_request = reader.next()?;
    let detach = expect_method(detach_request.clone(), "Target.detachFromTarget", None)?;
    if detach_request.pointer("/params/sessionId") != Some(&json!("session-main-nav-1")) {
        return Err(FakeChildError::InvalidRequest(
            "navigation detach used the wrong session id".to_owned(),
        ));
    }
    write_json_frame(output, &json!({"id": detach, "result": {}}))?;
    write_json_frame(
        output,
        &json!({
            "method": "Target.detachedFromTarget",
            "params": {"sessionId": "session-main-nav-1", "targetId": "main"}
        }),
    )?;

    expect_root_command(&mut reader, output, "Fake.recreateAfterNavigation")?;
    write_json_frame(
        output,
        &json!({
            "method": "Target.targetCreated",
            "params": {"targetInfo": {"targetId": "main", "type": "page", "url": "app://-/index.html"}}
        }),
    )?;
    let second_session =
        establish_target_session_with_id(&mut reader, output, "main", "session-main-nav-2")?;
    complete_bundled_renderer_install(&mut reader, output, &second_session, "nav-2", 81, 82)?;
    complete_bundled_renderer_deactivation(&mut reader, output, &second_session, "nav-2", 83, 84)?;
    expect_root_command(&mut reader, output, "Fake.finish")
}

#[derive(Debug, Clone)]
struct RendererBindingInfo {
    adapter_binding: String,
    codlet_binding: String,
    adapter_context: u64,
    codlet_context: u64,
}

fn complete_bundled_renderer_install(
    reader: &mut RequestReader<'_>,
    output: &mut File,
    session_id: &str,
    identifier_suffix: &str,
    adapter_context: u64,
    codlet_context: u64,
) -> Result<RendererBindingInfo, FakeChildError> {
    let codlet_world = "codlet.plugin.codlet.g1";
    let bootstrap_codlet = renderer_identifier("script-bootstrap-codlet", identifier_suffix);
    let adapter_binding = complete_adapter_renderer_install(
        reader,
        output,
        session_id,
        identifier_suffix,
        adapter_context,
    )?;

    complete_isolated_world(reader, output, session_id, codlet_world, codlet_context)?;
    let codlet_binding = expect_renderer_binding(reader, output, session_id, codlet_world)?;
    expect_renderer_script(
        reader,
        output,
        session_id,
        codlet_world,
        "__codletRendererV1",
        &bootstrap_codlet,
    )?;
    complete_renderer_evaluation(
        reader,
        output,
        session_id,
        codlet_context,
        "__codletRendererV1",
        json!({"ok": true, "reused": false}),
    )?;
    complete_renderer_evaluation(
        reader,
        output,
        session_id,
        codlet_context,
        "runtime.activate",
        json!({"ok": true, "id": "codlet", "generation": 1, "reused": false}),
    )?;
    Ok(RendererBindingInfo {
        adapter_binding,
        codlet_binding,
        adapter_context,
        codlet_context,
    })
}

fn complete_bundled_renderer_install_with_ready_handshake(
    reader: &mut RequestReader<'_>,
    output: &mut File,
    session_id: &str,
    identifier_suffix: &str,
    adapter_context: u64,
    codlet_context: u64,
) -> Result<RendererBindingInfo, FakeChildError> {
    let (bindings, activation_id) = begin_bundled_renderer_activation(
        reader,
        output,
        session_id,
        identifier_suffix,
        adapter_context,
        codlet_context,
    )?;

    emit_renderer_request(
        output,
        session_id,
        &bindings,
        1,
        "codlet.runtime.ping",
        "ping",
    )?;
    expect_consumer_host_success_response(reader, output, session_id, codlet_context)?;

    emit_renderer_request(
        output,
        session_id,
        &bindings,
        2,
        "codlet.runtime.manage",
        "list",
    )?;
    expect_consumer_management_list_response(reader, output, session_id, codlet_context)?;

    emit_renderer_request(
        output,
        session_id,
        &bindings,
        3,
        "codex.ui.titlebar.afterMenu",
        "getMount",
    )?;
    complete_provider_invocation(reader, output, session_id, &bindings, false)?;

    write_evaluation_value(
        output,
        activation_id,
        json!({"ok": true, "id": "codlet", "generation": 1, "reused": false}),
        session_id,
    )?;
    Ok(bindings)
}

fn begin_bundled_renderer_activation(
    reader: &mut RequestReader<'_>,
    output: &mut File,
    session_id: &str,
    identifier_suffix: &str,
    adapter_context: u64,
    codlet_context: u64,
) -> Result<(RendererBindingInfo, u64), FakeChildError> {
    let adapter_binding = complete_adapter_renderer_install(
        reader,
        output,
        session_id,
        identifier_suffix,
        adapter_context,
    )?;
    let codlet_world = "codlet.plugin.codlet.g1";
    let bootstrap_codlet = renderer_identifier("script-bootstrap-codlet", identifier_suffix);
    complete_isolated_world(reader, output, session_id, codlet_world, codlet_context)?;
    let codlet_binding = expect_renderer_binding(reader, output, session_id, codlet_world)?;
    expect_renderer_script(
        reader,
        output,
        session_id,
        codlet_world,
        "__codletRendererV1",
        &bootstrap_codlet,
    )?;
    complete_renderer_evaluation(
        reader,
        output,
        session_id,
        codlet_context,
        "__codletRendererV1",
        json!({"ok": true, "reused": false}),
    )?;

    let activation_request = reader.next()?;
    let activation_id = expect_method(
        activation_request.clone(),
        "Runtime.evaluate",
        Some(session_id),
    )?;
    if activation_request.pointer("/params/contextId") != Some(&json!(codlet_context))
        || activation_request
            .pointer("/params/expression")
            .and_then(Value::as_str)
            .is_none_or(|expression| !expression.contains("runtime.activate"))
    {
        return Err(FakeChildError::InvalidRequest(
            "ready handshake did not begin from the Codlet activation evaluation".to_owned(),
        ));
    }
    Ok((
        RendererBindingInfo {
            adapter_binding,
            codlet_binding,
            adapter_context,
            codlet_context,
        },
        activation_id,
    ))
}

fn emit_renderer_request(
    output: &mut File,
    session_id: &str,
    bindings: &RendererBindingInfo,
    id: u64,
    capability_name: &str,
    method: &str,
) -> Result<(), FakeChildError> {
    let request = json!({
        "v": 1,
        "type": "request",
        "pluginId": "codlet",
        "generation": 1,
        "id": id,
        "capability": {
            "name": capability_name,
            "api": 1,
            "scope": "target"
        },
        "method": method,
        "params": null
    });
    write_json_frame(
        output,
        &json!({
            "method": "Runtime.bindingCalled",
            "params": {
                "name": bindings.codlet_binding,
                "payload": serde_json::to_string(&request).expect("request serializes"),
                "executionContextId": bindings.codlet_context
            },
            "sessionId": session_id
        }),
    )?;
    Ok(())
}

fn complete_adapter_renderer_install(
    reader: &mut RequestReader<'_>,
    output: &mut File,
    session_id: &str,
    identifier_suffix: &str,
    adapter_context: u64,
) -> Result<String, FakeChildError> {
    let adapter_world = "codlet.plugin.codex.ui.adapter.g1";
    let bootstrap_adapter = renderer_identifier("script-bootstrap-adapter", identifier_suffix);
    complete_isolated_world(reader, output, session_id, adapter_world, adapter_context)?;
    let adapter_binding = expect_renderer_binding(reader, output, session_id, adapter_world)?;
    let bootstrap_script = expect_renderer_script(
        reader,
        output,
        session_id,
        adapter_world,
        "__codletRendererV1",
        &bootstrap_adapter,
    )?;
    if bootstrap_script
        .pointer("/params/source")
        .and_then(Value::as_str)
        .is_none_or(|source| {
            !source.contains("globalThis.top !== globalThis")
                || !source.contains("url.protocol !== 'app:'")
                || !source.contains("url.pathname !== '/index.html'")
        })
    {
        return Err(FakeChildError::InvalidRequest(
            "bootstrap new-document script did not guard the main frame".to_owned(),
        ));
    }
    complete_renderer_evaluation(
        reader,
        output,
        session_id,
        adapter_context,
        "__codletRendererV1",
        json!({"ok": true, "reused": false}),
    )?;
    complete_renderer_evaluation(
        reader,
        output,
        session_id,
        adapter_context,
        "codex.ui.adapter",
        json!({"ok": true, "id": "codex.ui.adapter", "generation": 1, "reused": false}),
    )?;
    Ok(adapter_binding)
}

fn complete_bundled_renderer_deactivation(
    reader: &mut RequestReader<'_>,
    output: &mut File,
    session_id: &str,
    identifier_suffix: &str,
    codlet_context: u64,
    adapter_context: u64,
) -> Result<(), FakeChildError> {
    let codlet_world = "codlet.plugin.codlet.g1";
    let bootstrap_codlet = renderer_identifier("script-bootstrap-codlet", identifier_suffix);
    complete_isolated_world(reader, output, session_id, codlet_world, codlet_context)?;
    complete_renderer_evaluation(
        reader,
        output,
        session_id,
        codlet_context,
        ".deactivate(\"codlet\", 1)",
        json!({"ok": true, "id": "codlet", "generation": 1, "inactive": true}),
    )?;
    expect_remove_renderer_script(reader, output, session_id, &bootstrap_codlet)?;
    expect_remove_renderer_binding(reader, output, session_id)?;

    complete_adapter_renderer_deactivation(
        reader,
        output,
        session_id,
        identifier_suffix,
        adapter_context,
    )
}

fn complete_adapter_renderer_deactivation(
    reader: &mut RequestReader<'_>,
    output: &mut File,
    session_id: &str,
    identifier_suffix: &str,
    adapter_context: u64,
) -> Result<(), FakeChildError> {
    let adapter_world = "codlet.plugin.codex.ui.adapter.g1";
    let bootstrap_adapter = renderer_identifier("script-bootstrap-adapter", identifier_suffix);
    complete_isolated_world(reader, output, session_id, adapter_world, adapter_context)?;
    complete_renderer_evaluation(
        reader,
        output,
        session_id,
        adapter_context,
        ".deactivate(\"codex.ui.adapter\", 1)",
        json!({"ok": true, "id": "codex.ui.adapter", "generation": 1, "inactive": true}),
    )?;
    expect_remove_renderer_script(reader, output, session_id, &bootstrap_adapter)?;
    expect_remove_renderer_binding(reader, output, session_id)?;
    Ok(())
}

fn renderer_identifier(base: &str, suffix: &str) -> String {
    if suffix.is_empty() {
        base.to_owned()
    } else {
        format!("{base}-{suffix}")
    }
}

fn complete_isolated_world(
    reader: &mut RequestReader<'_>,
    output: &mut File,
    session_id: &str,
    world_name: &str,
    context_id: u64,
) -> Result<(), FakeChildError> {
    let get_frame_tree = expect_method(reader.next()?, "Page.getFrameTree", Some(session_id))?;
    write_json_frame(
        output,
        &json!({
            "id": get_frame_tree,
            "result": {"frameTree": {"frame": {"id": "frame-main", "url": "app://-/index.html"}}},
            "sessionId": session_id
        }),
    )?;

    let create_request = reader.next()?;
    let create_world = expect_method(
        create_request.clone(),
        "Page.createIsolatedWorld",
        Some(session_id),
    )?;
    if create_request.pointer("/params/frameId") != Some(&json!("frame-main"))
        || create_request.pointer("/params/worldName") != Some(&json!(world_name))
    {
        return Err(FakeChildError::InvalidRequest(
            "isolated world request used the wrong frame or world name".to_owned(),
        ));
    }
    write_json_frame(
        output,
        &json!({
            "id": create_world,
            "result": {"executionContextId": context_id},
            "sessionId": session_id
        }),
    )?;
    Ok(())
}

fn expect_renderer_script(
    reader: &mut RequestReader<'_>,
    output: &mut File,
    session_id: &str,
    world_name: &str,
    source_fragment: &str,
    identifier: &str,
) -> Result<Value, FakeChildError> {
    let request = reader.next()?;
    let id = expect_method(
        request.clone(),
        "Page.addScriptToEvaluateOnNewDocument",
        Some(session_id),
    )?;
    if request.pointer("/params/worldName") != Some(&json!(world_name))
        || request
            .pointer("/params/source")
            .and_then(Value::as_str)
            .is_none_or(|source| !source.contains(source_fragment))
    {
        return Err(FakeChildError::InvalidRequest(format!(
            "new-document script did not target the Codlet world or contain {source_fragment}"
        )));
    }
    write_json_frame(
        output,
        &json!({"id": id, "result": {"identifier": identifier}, "sessionId": session_id}),
    )?;
    Ok(request)
}

fn expect_renderer_binding(
    reader: &mut RequestReader<'_>,
    output: &mut File,
    session_id: &str,
    world_name: &str,
) -> Result<String, FakeChildError> {
    let request = reader.next()?;
    let id = expect_method(request.clone(), "Runtime.addBinding", Some(session_id))?;
    let name = request
        .pointer("/params/name")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            FakeChildError::InvalidRequest("Runtime.addBinding name is not a string".to_owned())
        })?;
    if !name.starts_with("codlet_rpc_v1_")
        || request.pointer("/params/executionContextName") != Some(&json!(world_name))
    {
        return Err(FakeChildError::InvalidRequest(
            "Runtime.addBinding did not use the expected Codlet namespace".to_owned(),
        ));
    }
    write_json_frame(
        output,
        &json!({"id": id, "result": {}, "sessionId": session_id}),
    )?;
    Ok(name.to_owned())
}

fn expect_remove_renderer_binding(
    reader: &mut RequestReader<'_>,
    output: &mut File,
    session_id: &str,
) -> Result<(), FakeChildError> {
    let request = reader.next()?;
    let id = expect_method(request.clone(), "Runtime.removeBinding", Some(session_id))?;
    if request
        .pointer("/params/name")
        .and_then(Value::as_str)
        .is_none_or(|name| !name.starts_with("codlet_rpc_v1_"))
    {
        return Err(FakeChildError::InvalidRequest(
            "Runtime.removeBinding did not use the Codlet namespace".to_owned(),
        ));
    }
    write_json_frame(
        output,
        &json!({"id": id, "result": {}, "sessionId": session_id}),
    )?;
    Ok(())
}

fn complete_renderer_evaluation(
    reader: &mut RequestReader<'_>,
    output: &mut File,
    session_id: &str,
    context_id: u64,
    expression_fragment: &str,
    value: Value,
) -> Result<(), FakeChildError> {
    let request = reader.next()?;
    let id = expect_method(request.clone(), "Runtime.evaluate", Some(session_id))?;
    if request.pointer("/params/contextId") != Some(&json!(context_id))
        || request
            .pointer("/params/expression")
            .and_then(Value::as_str)
            .is_none_or(|expression| !expression.contains(expression_fragment))
    {
        return Err(FakeChildError::InvalidRequest(format!(
            "renderer evaluation did not target context {context_id} or contain {expression_fragment}"
        )));
    }
    write_evaluation_value(output, id, value, session_id)
}

fn expect_remove_renderer_script(
    reader: &mut RequestReader<'_>,
    output: &mut File,
    session_id: &str,
    identifier: &str,
) -> Result<(), FakeChildError> {
    let request = reader.next()?;
    let id = expect_method(
        request.clone(),
        "Page.removeScriptToEvaluateOnNewDocument",
        Some(session_id),
    )?;
    if request.pointer("/params/identifier") != Some(&json!(identifier)) {
        return Err(FakeChildError::InvalidRequest(format!(
            "removed script identifier did not equal {identifier}"
        )));
    }
    write_json_frame(
        output,
        &json!({"id": id, "result": {}, "sessionId": session_id}),
    )?;
    Ok(())
}

fn scenario_pipe_lifetime(input: &mut File, output: &mut File) -> Result<(), FakeChildError> {
    write_json_frame(output, &json!({"method": "Fake.pipeHeld"}))?;
    let mut reader = RequestReader::new(input);
    if reader.next_or_eof()?.is_some() {
        return Err(FakeChildError::InvalidRequest(
            "pipe-lifetime scenario expected EOF without a CDP request".to_owned(),
        ));
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum ProbeScenario {
    Success,
    InsertResponseLost,
    RemoveError,
    RuntimeExit(i32),
}

#[derive(Debug, PartialEq, Eq)]
enum MarkerAction {
    Insert(String),
    Remove(String),
}

fn scenario_probe(
    input: &mut File,
    output: &mut File,
    scenario: ProbeScenario,
) -> Result<(), FakeChildError> {
    let mut reader = RequestReader::new(input);
    establish_target_session(&mut reader, output)?;
    let mut marker = None;

    let insert_request = reader.next()?;
    let insert_id = expect_method(
        insert_request.clone(),
        "Runtime.evaluate",
        Some("session-main"),
    )?;
    let insert_action = marker_action(&insert_request)?;
    if !matches!(insert_action, MarkerAction::Insert(_)) {
        return Err(FakeChildError::InvalidRequest(
            "first marker transition was not an insert".to_owned(),
        ));
    }
    let inserted = apply_marker_action(&mut marker, insert_action)?;
    if !matches!(scenario, ProbeScenario::InsertResponseLost) {
        write_evaluation_boolean(output, insert_id, inserted, "session-main")?;
    }

    let remove_request = reader.next()?;
    let remove_id = expect_method(
        remove_request.clone(),
        "Runtime.evaluate",
        Some("session-main"),
    )?;
    let remove_action = marker_action(&remove_request)?;
    if !matches!(remove_action, MarkerAction::Remove(_)) {
        return Err(FakeChildError::InvalidRequest(
            "second marker transition was not a remove".to_owned(),
        ));
    }
    if matches!(scenario, ProbeScenario::RemoveError) {
        write_evaluation_exception(
            output,
            remove_id,
            "simulated marker remove failure",
            "session-main",
        )?;
        return Ok(());
    }
    let removed = apply_marker_action(&mut marker, remove_action)?;
    write_evaluation_boolean(output, remove_id, removed, "session-main")?;
    if marker.is_some() {
        return Err(FakeChildError::InvalidRequest(
            "marker remained after the remove transition".to_owned(),
        ));
    }

    if let ProbeScenario::RuntimeExit(exit_code) = scenario {
        let exit = expect_method(reader.next()?, "Fake.exit", Some("session-main"))?;
        write_json_frame(
            output,
            &json!({
                "id": exit,
                "result": {"exitCode": exit_code},
                "sessionId": "session-main"
            }),
        )?;
        if exit_code != 0 {
            return Err(FakeChildError::RequestedExit(exit_code));
        }
    }
    Ok(())
}

fn establish_target_session(
    reader: &mut RequestReader<'_>,
    output: &mut File,
) -> Result<(), FakeChildError> {
    establish_target_session_with_rounds(
        reader,
        output,
        [json!([
            {"targetId": "worker", "type": "worker", "url": "app://-/index.html"},
            {"targetId": "main", "type": "page", "url": "app://-/index.html"}
        ])],
    )
}

fn establish_target_session_with_rounds(
    reader: &mut RequestReader<'_>,
    output: &mut File,
    target_rounds: impl IntoIterator<Item = Value>,
) -> Result<(), FakeChildError> {
    enable_target_discovery(reader, output)?;
    for target_infos in target_rounds {
        let get_targets = expect_method(reader.next()?, "Target.getTargets", None)?;
        write_json_frame(
            output,
            &json!({
                "id": get_targets,
                "result": {"targetInfos": target_infos}
            }),
        )?;
    }

    establish_named_target_session(reader, output, "main")?;
    Ok(())
}

fn enable_target_discovery(
    reader: &mut RequestReader<'_>,
    output: &mut File,
) -> Result<(), FakeChildError> {
    let request = reader.next()?;
    let id = expect_method(request.clone(), "Target.setDiscoverTargets", None)?;
    if request.pointer("/params/discover") != Some(&json!(true)) {
        return Err(FakeChildError::InvalidRequest(
            "Target.setDiscoverTargets did not enable discovery".to_owned(),
        ));
    }
    write_json_frame(output, &json!({"id": id, "result": {}}))?;
    Ok(())
}

fn establish_named_target_session(
    reader: &mut RequestReader<'_>,
    output: &mut File,
    target_id: &str,
) -> Result<String, FakeChildError> {
    establish_target_session_with_id(reader, output, target_id, &format!("session-{target_id}"))
}

fn establish_target_session_with_id(
    reader: &mut RequestReader<'_>,
    output: &mut File,
    target_id: &str,
    session_id: &str,
) -> Result<String, FakeChildError> {
    let attach_request = reader.next()?;
    let attach = expect_method(attach_request.clone(), "Target.attachToTarget", None)?;
    if attach_request.pointer("/params/targetId") != Some(&json!(target_id))
        || attach_request.pointer("/params/flatten") != Some(&json!(true))
    {
        return Err(FakeChildError::InvalidRequest(format!(
            "attach request did not select {target_id} with flatten=true"
        )));
    }
    write_json_frame(
        output,
        &json!({"id": attach, "result": {"sessionId": session_id}}),
    )?;

    for method in ["Runtime.enable", "Page.enable"] {
        let id = expect_method(reader.next()?, method, Some(session_id))?;
        write_json_frame(
            output,
            &json!({"id": id, "result": {}, "sessionId": session_id}),
        )?;
    }
    Ok(session_id.to_owned())
}

fn expect_root_command(
    reader: &mut RequestReader<'_>,
    output: &mut File,
    method: &str,
) -> Result<(), FakeChildError> {
    let id = expect_method(reader.next()?, method, None)?;
    write_json_frame(output, &json!({"id": id, "result": {}}))?;
    Ok(())
}

fn scenario_probe_reject_arbitrary(
    input: &mut File,
    output: &mut File,
) -> Result<(), FakeChildError> {
    let mut reader = RequestReader::new(input);
    establish_target_session(&mut reader, output)?;
    let request = reader.next()?;
    let id = expect_method(request.clone(), "Runtime.evaluate", Some("session-main"))?;
    if marker_action(&request).is_ok() {
        return Err(FakeChildError::InvalidRequest(
            "arbitrary-expression scenario received a valid marker expression".to_owned(),
        ));
    }
    write_evaluation_exception(
        output,
        id,
        "expression is not a Codlet marker transition",
        "session-main",
    )
}

fn scenario_wrong_session(input: &mut File, output: &mut File) -> Result<(), FakeChildError> {
    let mut reader = RequestReader::new(input);
    enable_target_discovery(&mut reader, output)?;
    let get_targets = expect_method(reader.next()?, "Target.getTargets", None)?;
    write_json_frame(
        output,
        &json!({
            "id": get_targets,
            "result": {
                "targetInfos": [
                    {"targetId": "main", "type": "page", "url": "app://-/index.html"}
                ]
            }
        }),
    )?;
    let attach_request = reader.next()?;
    let attach = expect_method(attach_request, "Target.attachToTarget", None)?;
    write_json_frame(
        output,
        &json!({"id": attach, "result": {"sessionId": "session-main"}}),
    )?;
    let enable = expect_method(reader.next()?, "Runtime.enable", Some("session-main"))?;
    write_json_frame(
        output,
        &json!({"id": enable, "result": {}, "sessionId": "session-other"}),
    )?;
    Ok(())
}

fn complete_marker_cycle(
    reader: &mut RequestReader<'_>,
    output: &mut File,
    session_id: &str,
) -> Result<(), FakeChildError> {
    let mut marker = None;
    let insert_request = reader.next()?;
    let insert_id = expect_method(insert_request.clone(), "Runtime.evaluate", Some(session_id))?;
    let inserted = apply_marker_action(&mut marker, marker_action(&insert_request)?)?;
    write_evaluation_boolean(output, insert_id, inserted, session_id)?;

    let remove_request = reader.next()?;
    let remove_id = expect_method(remove_request.clone(), "Runtime.evaluate", Some(session_id))?;
    let removed = apply_marker_action(&mut marker, marker_action(&remove_request)?)?;
    write_evaluation_boolean(output, remove_id, removed, session_id)?;
    if marker.is_some() {
        return Err(FakeChildError::InvalidRequest(
            "marker remained after the remove transition".to_owned(),
        ));
    }
    Ok(())
}

fn marker_action(request: &Value) -> Result<MarkerAction, FakeChildError> {
    let expression = request
        .pointer("/params/expression")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            FakeChildError::InvalidRequest("Runtime.evaluate expression is not a string".to_owned())
        })?;
    let marker_id = marker_id_from_expression(expression)?;
    let insert_semantics = [
        "document.createElement('div')",
        "marker.id = id",
        "data-codlet-m0-probe",
        "document.documentElement.appendChild(marker)",
        "document.getElementById(id) === marker",
    ]
    .into_iter()
    .all(|fragment| expression.contains(fragment));
    let remove_semantics = [
        "const marker = document.getElementById(id)",
        "if (marker) marker.remove()",
        "document.getElementById(id) === null",
    ]
    .into_iter()
    .all(|fragment| expression.contains(fragment));

    match (insert_semantics, remove_semantics) {
        (true, false) => Ok(MarkerAction::Insert(marker_id)),
        (false, true) => Ok(MarkerAction::Remove(marker_id)),
        _ => Err(FakeChildError::InvalidRequest(
            "Runtime.evaluate is not a recognized marker insert/remove expression".to_owned(),
        )),
    }
}

fn marker_id_from_expression(expression: &str) -> Result<String, FakeChildError> {
    let encoded = expression
        .split_once("const id = ")
        .and_then(|(_, suffix)| suffix.split_once(';').map(|(value, _)| value.trim()))
        .ok_or_else(|| {
            FakeChildError::InvalidRequest("marker expression does not declare const id".to_owned())
        })?;
    serde_json::from_str(encoded).map_err(|error| {
        FakeChildError::InvalidRequest(format!("marker id is not a JSON string: {error}"))
    })
}

fn apply_marker_action(
    marker: &mut Option<String>,
    action: MarkerAction,
) -> Result<bool, FakeChildError> {
    match action {
        MarkerAction::Insert(id) => {
            if marker.is_some() {
                Ok(false)
            } else {
                *marker = Some(id);
                Ok(true)
            }
        }
        MarkerAction::Remove(id) => {
            if marker.as_deref() != Some(id.as_str()) {
                return Err(FakeChildError::InvalidRequest(
                    "remove marker id did not match the inserted marker".to_owned(),
                ));
            }
            marker.take();
            Ok(true)
        }
    }
}

fn write_evaluation_boolean(
    output: &mut File,
    id: u64,
    value: bool,
    session_id: &str,
) -> Result<(), FakeChildError> {
    write_json_frame(
        output,
        &json!({
            "id": id,
            "result": {"result": {"type": "boolean", "value": value}},
            "sessionId": session_id
        }),
    )?;
    Ok(())
}

fn write_evaluation_value(
    output: &mut File,
    id: u64,
    value: Value,
    session_id: &str,
) -> Result<(), FakeChildError> {
    write_json_frame(
        output,
        &json!({
            "id": id,
            "result": {"result": {"type": "object", "value": value}},
            "sessionId": session_id
        }),
    )?;
    Ok(())
}

fn write_evaluation_exception(
    output: &mut File,
    id: u64,
    message: &str,
    session_id: &str,
) -> Result<(), FakeChildError> {
    write_json_frame(
        output,
        &json!({
            "id": id,
            "result": {
                "result": {"type": "undefined"},
                "exceptionDetails": {"text": message}
            },
            "sessionId": session_id
        }),
    )?;
    Ok(())
}

fn scenario_whitelist(
    output: &mut File,
    sentinel: Option<usize>,
    sentinel_token: Option<String>,
) -> Result<(), FakeChildError> {
    let sentinel = sentinel.ok_or(FakeChildError::MissingArgument("--sentinel-handle"))?;
    let sentinel_token =
        sentinel_token.ok_or(FakeChildError::MissingArgument("--sentinel-token"))?;
    let mut bytes = [0_u8; 64];
    let mut bytes_read = 0_u32;
    // SAFETY: deliberately probes the identity of a parent-owned pipe without blocking. A reused
    // numeric handle is not considered inherited unless it exposes the unique preloaded token.
    let peeked = unsafe {
        PeekNamedPipe(
            sentinel as HANDLE,
            bytes.as_mut_ptr().cast(),
            bytes.len() as u32,
            &mut bytes_read,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } != 0;
    // SAFETY: called immediately after PeekNamedPipe when it failed.
    let error_code = if peeked { 0 } else { unsafe { GetLastError() } };
    let bytes_read = usize::try_from(bytes_read)
        .map_err(|_| FakeChildError::InvalidRequest("peek length does not fit usize".to_owned()))?;
    let inherited =
        peeked && bytes_read <= bytes.len() && &bytes[..bytes_read] == sentinel_token.as_bytes();
    write_json_frame(
        output,
        &json!({
            "method": "Fake.sentinel",
            "params": {
                "inherited": inherited,
                "handleWasPipe": peeked,
                "errorCode": error_code
            }
        }),
    )?;
    Ok(())
}

fn request_identity(request: Value) -> Result<(u64, String), FakeChildError> {
    let id = request
        .get("id")
        .and_then(Value::as_u64)
        .ok_or_else(|| FakeChildError::InvalidRequest("request id is not a u64".to_owned()))?;
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            FakeChildError::InvalidRequest("request method is not a string".to_owned())
        })?;
    Ok((id, method.to_owned()))
}

fn expect_method(
    request: Value,
    expected_method: &str,
    expected_session: Option<&str>,
) -> Result<u64, FakeChildError> {
    let (id, method) = request_identity(request.clone())?;
    if method != expected_method {
        return Err(FakeChildError::InvalidRequest(format!(
            "expected {expected_method}, received {method}"
        )));
    }
    if request.get("sessionId").and_then(Value::as_str) != expected_session {
        return Err(FakeChildError::InvalidRequest(format!(
            "{expected_method} had the wrong sessionId"
        )));
    }
    Ok(id)
}

fn framed_bytes(value: &Value) -> Result<Vec<u8>, FakeChildError> {
    let mut output = Vec::new();
    write_json_frame(&mut output, value)?;
    Ok(output)
}

fn parse_handle(value: &str) -> Result<usize, FakeChildError> {
    value
        .parse()
        .map_err(|_| FakeChildError::InvalidArgument(value.to_owned()))
}

fn os_string_to_ascii(value: OsString) -> Result<String, FakeChildError> {
    let units: Vec<_> = OsStr::new(&value).encode_wide().collect();
    if units.iter().any(|&unit| unit > 0x7f) {
        return Err(FakeChildError::InvalidArgument(
            "non-ASCII argument".to_owned(),
        ));
    }
    Ok(units.into_iter().map(|unit| unit as u8 as char).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(expression: &str) -> Value {
        json!({"params": {"expression": expression}})
    }

    #[test]
    fn marker_parser_rejects_arbitrary_runtime_evaluate() {
        assert!(marker_action(&request("true")).is_err());
        assert!(marker_action(&request("document.body !== null")).is_err());
    }

    #[test]
    fn marker_state_machine_requires_matching_insert_then_remove() {
        let insert = request(
            r#"(() => {
                const id = "codlet-test-marker";
                const marker = document.createElement('div');
                marker.id = id;
                marker.setAttribute('data-codlet-m0-probe', 'true');
                document.documentElement.appendChild(marker);
                return document.getElementById(id) === marker;
            })()"#,
        );
        let remove = request(
            r#"(() => {
                const id = "codlet-test-marker";
                const marker = document.getElementById(id);
                if (marker) marker.remove();
                return document.getElementById(id) === null;
            })()"#,
        );
        let mut marker = None;
        assert!(apply_marker_action(&mut marker, marker_action(&insert).unwrap()).unwrap());
        assert_eq!(marker.as_deref(), Some("codlet-test-marker"));
        assert!(apply_marker_action(&mut marker, marker_action(&remove).unwrap()).unwrap());
        assert_eq!(marker, None);
    }
}
