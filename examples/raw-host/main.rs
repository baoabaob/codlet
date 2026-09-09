//! Standalone JSONL plugin: this executable imports no Codlet Rust API.
use std::fs;
use std::io::{self, BufRead, Read, Write};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

const MAX_FRAME: usize = 1024 * 1024;
const MAX_EVENTS: usize = 16;
const INITIALIZE_BUDGET: Duration = Duration::from_millis(4500);
const DISCOVERY_BUDGET: Duration = Duration::from_millis(3500);
const CLEANUP_RESERVE: Duration = Duration::from_millis(500);
const DISCOVERY_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Debug)]
struct Failure {
    code: String,
    message: String,
}
impl Failure {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
    fn json(&self) -> Value {
        json!({"code":self.code,"message":self.message})
    }
}
impl From<io::Error> for Failure {
    fn from(error: io::Error) -> Self {
        Self::new("io_error", error.to_string())
    }
}
impl From<serde_json::Error> for Failure {
    fn from(error: serde_json::Error) -> Self {
        Self::new("protocol_error", error.to_string())
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("raw-host example: {}: {}", error.code, error.message);
        std::process::exit(1);
    }
}

#[derive(Default)]
struct Options {
    expression: Option<String>,
    target_id: Option<String>,
    report: Option<PathBuf>,
}
impl Options {
    fn parse() -> Result<Self, Failure> {
        let mut result = Self::default();
        let mut arguments = std::env::args().skip(1);
        while let Some(argument) = arguments.next() {
            let value = arguments
                .next()
                .ok_or_else(|| Failure::new("arguments", format!("{argument} requires a value")))?;
            match argument.as_str() {
                "--expression" => result.expression = Some(value),
                "--target-id" => result.target_id = Some(value),
                "--report" => result.report = Some(PathBuf::from(value)),
                _ => {
                    return Err(Failure::new(
                        "arguments",
                        format!("unknown argument {argument}"),
                    ));
                }
            }
        }
        Ok(result)
    }
}

fn run() -> Result<(), Failure> {
    let options = Options::parse()?;
    let mut input = io::stdin().lock();
    let initialize = receive(&mut input)?;
    if initialize["v"] != 1
        || initialize["type"] != "request"
        || initialize["method"] != "initialize"
        || initialize["pluginId"].as_str().is_none()
        || initialize["generation"].as_u64().is_none()
        || initialize["id"].as_u64().is_none()
    {
        return Err(Failure::new(
            "protocol_error",
            "expected a version-1 initialize request",
        ));
    }
    let mut peer = Peer {
        input,
        identity: initialize.clone(),
        next_id: 1,
        events: Vec::new(),
        events_truncated: false,
        initialize_deadline: Instant::now() + INITIALIZE_BUDGET,
        shutdown_received: false,
    };
    let result = demonstrate(&mut peer, &options);
    if peer.shutdown_received {
        return Ok(());
    }
    let report = match &result {
        Ok(value) => value.clone(),
        Err(error) => json!({"ready":false,"error":error.json()}),
    };
    if let Some(path) = options.report {
        fs::write(path, serde_json::to_vec_pretty(&report)?)?;
    }
    match result {
        Ok(_) => peer.reply(&initialize, Ok(json!({"ready":true})))?,
        Err(error) => peer.reply(&initialize, Err(error))?,
    }
    // All nested CDP work finishes before initialize replies. shutdown itself
    // needs no Core callbacks, so it also works while Core is retiring a failure.
    loop {
        let message = peer.receive()?;
        if message["type"] == "request" {
            if message["method"] == "shutdown" {
                peer.reply(&message, Ok(Value::Null))?;
                return Ok(());
            }
            peer.reply(
                &message,
                Err(Failure::new(
                    "method_not_found",
                    "only initialize and shutdown are exposed by this example",
                )),
            )?;
        }
    }
}

fn demonstrate(peer: &mut Peer<impl BufRead>, options: &Options) -> Result<Value, Failure> {
    let target_id = discover_target(peer, options)?;
    let attached = peer.cdp(
        "Target.attachToTarget",
        json!({"targetId":target_id,"flatten":true}),
        None,
    )?;
    let session_id = attached["sessionId"]
        .as_str()
        .ok_or_else(|| Failure::new("cdp_result", "attachToTarget returned no sessionId"))?
        .to_owned();
    let mut subscription_id = None;
    let evaluated = (|| {
        let subscribed = peer.rpc(
            "cdp.subscribe",
            json!({"scope":"session","sessionId":session_id}),
        )?;
        subscription_id =
            Some(subscribed["subscriptionId"].as_u64().ok_or_else(|| {
                Failure::new("cdp_result", "subscribe returned no subscriptionId")
            })?);
        peer.cdp("Runtime.enable", json!({}), Some(&session_id))?;
        let expression = options.expression.as_deref().unwrap_or(
            "typeof document === 'object' ? document.title : 'No document in this target'",
        );
        peer.cdp(
            "Runtime.evaluate",
            json!({"expression":expression,"returnByValue":true}),
            Some(&session_id),
        )
    })();
    // This finally-style path covers every operation after attach. Cleanup gets
    // the reserved end of the original budget and never masks the first failure.
    // Once shutdown is received, replying to it is our final Core IO.
    let mut cleanup_error = None;
    let mut unsubscribed = false;
    if !peer.shutdown_received
        && let Some(id) = subscription_id
    {
        match peer.rpc("cdp.unsubscribe", json!({"subscriptionId":id})) {
            Ok(value) => unsubscribed = value["unsubscribed"] == true,
            Err(error) => cleanup_error = Some(error),
        }
    }
    if !peer.shutdown_received {
        let deadline = peer.initialize_deadline;
        if let Err(error) = peer.cdp_until(
            "Target.detachFromTarget",
            json!({"sessionId":session_id}),
            None,
            deadline,
        ) && cleanup_error.is_none()
        {
            cleanup_error = Some(error);
        }
    }
    let evaluated = evaluated?;
    if let Some(error) = cleanup_error {
        return Err(error);
    }
    Ok(
        json!({"ready":true,"targetId":target_id,"sessionId":session_id,
        "evaluation":evaluated,"events":peer.events,"eventsTruncated":peer.events_truncated,
        "unsubscribed":unsubscribed,"detached":true}),
    )
}

fn discover_target(peer: &mut Peer<impl BufRead>, options: &Options) -> Result<String, Failure> {
    let deadline = (Instant::now() + DISCOVERY_BUDGET).min(peer.work_deadline());
    loop {
        // Selection and waiting belong to the plugin. No Codex URL,
        // TargetController, renderer bootstrap, or official adapter participates.
        let result = peer.cdp_until("Target.getTargets", json!({}), None, deadline)?;
        let targets = result["targetInfos"].as_array().ok_or_else(|| {
            Failure::new("cdp_result", "Target.getTargets returned no targetInfos")
        })?;
        let target = if let Some(id) = &options.target_id {
            targets.iter().find(|target| target["targetId"] == *id)
        } else {
            targets
                .iter()
                .find(|target| target["type"] == "page")
                .or_else(|| {
                    targets
                        .iter()
                        .find(|target| target["targetId"].as_str().is_some())
                })
        };
        if let Some(target) = target {
            return target["targetId"]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| Failure::new("cdp_result", "target has no id"));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining <= DISCOVERY_INTERVAL {
            return Err(Failure::new(
                "no_target",
                "no selected CDP target appeared within the startup discovery budget",
            ));
        }
        std::thread::sleep(DISCOVERY_INTERVAL);
    }
}

struct Peer<R> {
    input: R,
    identity: Value,
    next_id: u64,
    events: Vec<Value>,
    events_truncated: bool,
    initialize_deadline: Instant,
    shutdown_received: bool,
}
impl<R: BufRead> Peer<R> {
    fn receive(&mut self) -> Result<Value, Failure> {
        let message = receive(&mut self.input)?;
        if message["v"] != 1
            || message["pluginId"] != self.identity["pluginId"]
            || message["generation"] != self.identity["generation"]
        {
            return Err(Failure::new(
                "protocol_error",
                "Core message does not match this plugin generation",
            ));
        }
        Ok(message)
    }

    fn envelope(&self, kind: &str, fields: Value) -> Value {
        let mut message = json!({"v":1,"type":kind,"pluginId":self.identity["pluginId"],"generation":self.identity["generation"]});
        message
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        message
    }

    fn reply(&self, request: &Value, result: Result<Value, Failure>) -> Result<(), Failure> {
        let fields = match result {
            Ok(value) => json!({"id":request["id"],"ok":true,"result":value}),
            Err(error) => json!({"id":request["id"],"ok":false,"error":error.json()}),
        };
        send(&self.envelope("response", fields))
    }

    fn cdp(
        &mut self,
        method: &str,
        params: Value,
        session_id: Option<&str>,
    ) -> Result<Value, Failure> {
        self.cdp_until(method, params, session_id, self.work_deadline())
    }

    fn work_deadline(&self) -> Instant {
        self.initialize_deadline - CLEANUP_RESERVE
    }

    fn cdp_until(
        &mut self,
        method: &str,
        params: Value,
        session_id: Option<&str>,
        deadline: Instant,
    ) -> Result<Value, Failure> {
        let timeout_ms = deadline
            .min(self.initialize_deadline)
            .saturating_duration_since(Instant::now())
            .as_millis();
        if timeout_ms == 0 {
            return Err(Failure::new(
                "initialize_timeout",
                "the shared initialization call budget has expired",
            ));
        }
        let mut request = json!({"method":method,"params":params,"timeoutMs":timeout_ms as u64});
        if let Some(session_id) = session_id {
            request["sessionId"] = json!(session_id);
        }
        self.rpc("cdp.request", request)
    }

    fn rpc(&mut self, method: &str, params: Value) -> Result<Value, Failure> {
        if self.shutdown_received {
            return Err(Failure::new("host_stopping", "Core stopped initialization"));
        }
        if Instant::now() >= self.initialize_deadline {
            return Err(Failure::new(
                "initialize_timeout",
                "the shared initialization call budget has expired",
            ));
        }
        let id = self.next_id;
        self.next_id += 1;
        send(&self.envelope("request", json!({"id":id,"method":method,"params":params})))?;
        loop {
            let message = self.receive()?;
            match message["type"].as_str() {
                Some("response") if message["id"] == id => {
                    return if message["ok"] == true && message.get("result").is_some() {
                        Ok(message["result"].clone())
                    } else {
                        Err(Failure::new(
                            message["error"]["code"].as_str().unwrap_or("rpc_error"),
                            message["error"]["message"]
                                .as_str()
                                .unwrap_or("Core rejected the request"),
                        ))
                    };
                }
                Some("notification") if message["method"] == "cdp.event" => {
                    if self.events.len() < MAX_EVENTS {
                        self.events.push(message["params"].clone());
                    } else {
                        self.events_truncated = true;
                    }
                }
                Some("notification") if message["method"] == "cdp.subscriptionEnded" => {
                    return Err(Failure::new(
                        "subscription_ended",
                        message["params"]["reason"]
                            .as_str()
                            .unwrap_or("Core ended the event subscription"),
                    ));
                }
                Some("request") if message["method"] == "shutdown" => {
                    self.shutdown_received = true;
                    self.reply(&message, Ok(Value::Null))?;
                    return Err(Failure::new("host_stopping", "Core stopped initialization"));
                }
                _ => {
                    return Err(Failure::new(
                        "protocol_error",
                        "unexpected Core message while waiting for an RPC response",
                    ));
                }
            }
        }
    }
}

fn receive(input: &mut impl BufRead) -> Result<Value, Failure> {
    let mut line = Vec::new();
    input
        .take((MAX_FRAME + 2) as u64)
        .read_until(b'\n', &mut line)?;
    if line.last() != Some(&b'\n') {
        return Err(Failure::new(
            "protocol_error",
            "Core closed or exceeded one JSONL frame",
        ));
    }
    line.pop();
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    if line.is_empty() || line.len() > MAX_FRAME {
        return Err(Failure::new("protocol_error", "invalid JSONL frame length"));
    }
    Ok(serde_json::from_slice(&line)?)
}

fn send(message: &Value) -> Result<(), Failure> {
    let bytes = serde_json::to_vec(message)?;
    if bytes.len() > MAX_FRAME {
        return Err(Failure::new(
            "protocol_error",
            "outgoing JSONL frame exceeded one MiB",
        ));
    }
    let mut output = io::stdout().lock();
    output.write_all(&bytes)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}
