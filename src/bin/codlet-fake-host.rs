//! Native fixture for the host-plugin stdio contract. It never launches Codex.
use std::io::{self, BufRead, Write};
use std::time::Duration;

use serde_json::{Value, json};

fn main() {
    if let Err(error) = run() {
        eprintln!("fake-host fixture failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<_> = std::env::args().skip(1).collect();
    let mode = arguments
        .first()
        .map(String::as_str)
        .unwrap_or("cooperative");
    if mode == "stream-echo" {
        io::stdout().write_all(&[0, 255, 66])?;
        io::stdout().flush()?;
        io::stderr().write_all(b"ready\n")?;
        io::stderr().flush()?;
        let mut line = String::new();
        io::stdin().lock().read_line(&mut line)?;
        io::stdout().write_all(line.trim_end_matches(['\r', '\n']).as_bytes())?;
        io::stdout().flush()?;
        return Ok(());
    }
    if mode == "stream-flood" {
        io::stdout().write_all(&vec![0; 1024 * 1024])?;
        io::stdout().flush()?;
        std::thread::sleep(Duration::from_secs(60));
        return Ok(());
    }
    if matches!(mode, "sleep" | "refuse-stdin") {
        loop {
            std::thread::sleep(Duration::from_secs(60));
        }
    }
    let mut input = io::stdin().lock();
    let initialize = receive(&mut input)?;
    if initialize["method"] != "initialize" {
        return Err("expected initialize".into());
    }
    match mode {
        "malformed" => {
            io::stdout().write_all(b"{bad-json}\n")?;
            io::stdout().flush()?;
            loop {
                std::thread::sleep(Duration::from_secs(60));
            }
        }
        "truncated" => {
            io::stdout().write_all(b"{\"v\":1")?;
            io::stdout().flush()?;
            return Ok(());
        }
        "flood" => {
            for _ in 0..64 {
                send(&envelope(
                    &initialize,
                    "notification",
                    json!({"method":"fixture.flood","params":null}),
                ))?;
            }
            loop {
                std::thread::sleep(Duration::from_secs(60));
            }
        }
        "wrong-generation" => {
            let mut response = response(&initialize, json!({"ready":true}));
            response["generation"] = json!(initialize["generation"].as_u64().unwrap() + 1);
            send(&response)?;
            loop {
                std::thread::sleep(Duration::from_secs(60));
            }
        }
        "nested" => {
            send(&envelope(
                &initialize,
                "request",
                json!({"id":1,"method":"fixture.core","params":{"during":"initialize"}}),
            ))?;
            let answer = receive(&mut input)?;
            if answer["type"] != "response" || answer["id"] != 1 || answer["ok"] != true {
                return Err("expected Core's answer during initialization".into());
            }
            if let Some(raw) = arguments.get(1) {
                attempt_signal_unlisted_handle(raw.parse()?)?;
            }
            io::stderr().write_all(&vec![b'd'; 96 * 1024])?;
            io::stderr().flush()?;
            send(&response(
                &initialize,
                json!({"ready":true,"coreResult":answer["result"],"cwd":std::env::current_dir()?,"args":arguments.iter().skip(2).collect::<Vec<_>>()}),
            ))?;
        }
        _ => send(&response(&initialize, json!({"ready":true})))?,
    }
    if mode == "partial-hang" {
        io::stdout().write_all(b"{\"v\":1")?;
        io::stdout().flush()?;
        loop {
            std::thread::sleep(Duration::from_secs(60));
        }
    }
    if mode == "descendant" {
        // This child deliberately outlives normal stdio handling; the fixture's
        // owning Job is what the integration test verifies will reap it.
        let mut command = std::process::Command::new(std::env::current_exe()?);
        command
            .arg("sleep")
            .stdin(std::process::Stdio::inherit())
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        }
        #[allow(clippy::zombie_processes)]
        let descendant = command.spawn()?;
        send(&envelope(
            &initialize,
            "notification",
            json!({"method":"fixture.descendant","params":{"pid":descendant.id()}}),
        ))?;
        loop {
            std::thread::sleep(Duration::from_secs(60));
        }
    }
    let mut repeated = false;
    loop {
        let message = match receive(&mut input) {
            Ok(message) => message,
            Err(_) => return Ok(()),
        };
        match message["method"].as_str() {
            Some("shutdown") => {
                send(&response(&message, Value::Null))?;
                return Ok(());
            }
            Some("fixture.slow") => {
                send(&envelope(
                    &initialize,
                    "notification",
                    json!({"method":"fixture.waiting","params":null}),
                ))?;
                let release = receive(&mut input)?;
                if release["method"] != "fixture.release" {
                    return Err("expected late-response release".into());
                }
                send(&response(&message, json!("late")))?;
            }
            Some("fixture.repeat") => {
                let request = envelope(
                    &initialize,
                    "request",
                    json!({"id":7,"method":"fixture.core","params":null}),
                );
                send(&request)?;
                if repeated {
                    return Err("repeat fixture was invoked twice".into());
                }
                repeated = true;
                send(&request)?;
            }
            Some(method) if message["type"] == "notification" => {
                send(&envelope(
                    &initialize,
                    "notification",
                    json!({"method":method,"params":message["params"]}),
                ))?;
            }
            _ => send(&response(&message, message["params"].clone()))?,
        }
    }
}

fn receive(input: &mut impl BufRead) -> Result<Value, Box<dyn std::error::Error>> {
    let mut line = String::new();
    if input.read_line(&mut line)? == 0 {
        return Err("stdin EOF".into());
    }
    Ok(serde_json::from_str(&line)?)
}
fn envelope(source: &Value, kind: &str, fields: Value) -> Value {
    let mut message =
        json!({"v":1,"type":kind,"pluginId":source["pluginId"],"generation":source["generation"]});
    message
        .as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    message
}
fn response(source: &Value, result: Value) -> Value {
    envelope(
        source,
        "response",
        json!({"id":source["id"],"ok":true,"result":result}),
    )
}
fn send(message: &Value) -> Result<(), Box<dyn std::error::Error>> {
    let mut output = io::stdout().lock();
    serde_json::to_writer(&mut output, message)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}

#[cfg(windows)]
fn attempt_signal_unlisted_handle(value: usize) -> Result<(), Box<dyn std::error::Error>> {
    // The native parent supplies only a fixture event that should NOT inherit.
    unsafe {
        windows_sys::Win32::System::Threading::SetEvent(
            value as windows_sys::Win32::Foundation::HANDLE,
        );
    }
    Ok(())
}
#[cfg(not(windows))]
fn attempt_signal_unlisted_handle(_: usize) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}
