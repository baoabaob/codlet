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
        write_evaluation_boolean(output, insert_id, inserted)?;
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
        write_evaluation_exception(output, remove_id, "simulated marker remove failure")?;
        return Ok(());
    }
    let removed = apply_marker_action(&mut marker, remove_action)?;
    write_evaluation_boolean(output, remove_id, removed)?;
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

    let attach_request = reader.next()?;
    let attach = expect_method(attach_request.clone(), "Target.attachToTarget", None)?;
    if attach_request.pointer("/params/targetId") != Some(&json!("main"))
        || attach_request.pointer("/params/flatten") != Some(&json!(true))
    {
        return Err(FakeChildError::InvalidRequest(
            "attach request did not select main with flatten=true".to_owned(),
        ));
    }
    write_json_frame(
        output,
        &json!({"id": attach, "result": {"sessionId": "session-main"}}),
    )?;

    for method in ["Runtime.enable", "Page.enable"] {
        let id = expect_method(reader.next()?, method, Some("session-main"))?;
        write_json_frame(
            output,
            &json!({"id": id, "result": {}, "sessionId": "session-main"}),
        )?;
    }
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
    write_evaluation_exception(output, id, "expression is not a Codlet marker transition")
}

fn scenario_wrong_session(input: &mut File, output: &mut File) -> Result<(), FakeChildError> {
    let mut reader = RequestReader::new(input);
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

fn write_evaluation_boolean(output: &mut File, id: u64, value: bool) -> Result<(), FakeChildError> {
    write_json_frame(
        output,
        &json!({
            "id": id,
            "result": {"result": {"type": "boolean", "value": value}},
            "sessionId": "session-main"
        }),
    )?;
    Ok(())
}

fn write_evaluation_exception(
    output: &mut File,
    id: u64,
    message: &str,
) -> Result<(), FakeChildError> {
    write_json_frame(
        output,
        &json!({
            "id": id,
            "result": {
                "result": {"type": "undefined"},
                "exceptionDetails": {"text": message}
            },
            "sessionId": "session-main"
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
