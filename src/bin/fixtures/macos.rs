//! Native integration fixture. No official client, registry, network or UI.
use codlet::macos::{identity::ProcessIdentity, lifecycle::ShutdownSignal};
use codlet::plugin_host::{HostEvent, HostIdentity, HostSupervisor};
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};
use std::path::Path;
use std::time::{Duration, Instant};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const WAIT: Duration = Duration::from_secs(8);

pub fn run() -> Result<()> {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if arguments.as_slice() == ["__codlet_process_owner"] {
        return Ok(codlet::macos::process_owner::run()?);
    }
    let [mode, executable] = arguments.as_slice() else {
        return Err("Expected a native fixture mode and absolute fake-host executable".into());
    };
    if !matches!(
        mode.as_str(),
        "cooperative"
            | "descendant"
            | "group-interrupt"
            | "handled-signal"
            | "malformed"
            | "refuse-stdin"
    ) {
        return Err("Unknown native fixture mode".into());
    }
    let signal = if mode == "handled-signal" {
        Some(ShutdownSignal::install()?)
    } else {
        None
    };
    let host_mode = match mode.as_str() {
        "group-interrupt" | "handled-signal" => "descendant",
        mode => mode,
    };
    let cwd = std::env::current_dir()?;
    let mut host = HostSupervisor::spawn(
        HostIdentity {
            plugin_id: "dev.native-fixture".into(),
            generation: 1,
        },
        Path::new(executable),
        &[host_mode.to_owned()],
        &cwd,
    )?;
    let parameters = if mode == "refuse-stdin" {
        json!({"padding":"x".repeat(128 * 1024)})
    } else {
        json!({"protocol":1})
    };
    let request = host.send_request(
        "initialize",
        parameters,
        if mode == "refuse-stdin" {
            Duration::from_millis(150)
        } else {
            WAIT
        },
    )?;
    let mut descendant = None;
    let mut initialized = false;
    let deadline = Instant::now() + WAIT;
    let expects_failure = matches!(mode.as_str(), "malformed" | "refuse-stdin");
    loop {
        let mut failed = false;
        for event in host.poll() {
            match event {
                HostEvent::Response { id, result } if id == request => {
                    result.map_err(|error| format!("{}: {}", error.code, error.message))?;
                    initialized = true;
                }
                HostEvent::Notification { method, params } if method == "fixture.descendant" => {
                    descendant = Some(ProcessIdentity::inspect(
                        params["pid"].as_u64().ok_or("Missing descendant PID")? as u32,
                    )?);
                }
                HostEvent::Failed { error } if expects_failure => {
                    emit(json!({"event":"failure", "code":error.code}))?;
                    failed = true;
                }
                HostEvent::Failed { error } => return Err(error.into()),
                _ => {}
            }
        }
        if failed {
            emit(json!({"event":"stopped", "report":host.stop()?}))?;
            return Ok(());
        }
        if initialized && (host_mode != "descendant" || descendant.is_some()) {
            break;
        }
        if Instant::now() >= deadline {
            return Err("Native Host initialization timed out".into());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    host.mark_ready()?;
    emit(
        json!({"event":"ready", "host":ProcessIdentity::inspect(host.process_id())?, "descendant":descendant}),
    )?;
    if let Some(signal) = signal {
        let deadline = Instant::now() + WAIT;
        while !signal.requested() {
            if Instant::now() >= deadline {
                return Err("Shutdown signal was not received".into());
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    } else {
        let mut command = String::new();
        io::stdin().lock().read_line(&mut command)?;
        if command.trim() != "stop" {
            return Err("Expected stop command".into());
        }
    }
    emit(json!({"event":"stopped", "report":host.stop()?}))?;
    Ok(())
}
fn emit(value: Value) -> Result<()> {
    let mut output = io::stdout().lock();
    serde_json::to_writer(&mut output, &value)?;
    output.write_all(b"\n")?;
    Ok(output.flush()?)
}
