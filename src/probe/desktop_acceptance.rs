//! Opt-in real desktop acceptance. This never runs in the normal test suite or
//! ships in Core. The coordinator provides an isolated profile and owned backend.
use super::*;
use base64::Engine;
use serde_json::json;

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
    let mut runtime = start_codlet_runtime_with_connector(LaunchOptions::default(), None, |services, traffic| {
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
        return;
    }
    let client = runtime.client.clone();
    let status = runtime.status.clone();
    let report_root = root.clone();
    let duration = std::env::var("CODLET_ACCEPTANCE_DURATION")
        .ok()
        .map(|value| value.parse::<u64>().expect("acceptance duration"))
        .unwrap_or(35);
    assert!((35..=180).contains(&duration));
    let probe_script = std::env::var_os("CODLET_ACCEPTANCE_PROBE").map(PathBuf::from);
    let worker = std::thread::spawn(move || {
        let result = (|| -> Result<Value, String> {
            let started = Instant::now();
            let mut samples = Vec::new();
            let mut sid = None;
            let mut probes = Vec::new();
            while started.elapsed() < Duration::from_secs(duration) {
                std::thread::sleep(Duration::from_secs(2));
                let snapshot = status.snapshot();
                std::fs::write(
                    root.join("status.json"),
                    serde_json::to_vec_pretty(&*snapshot).unwrap(),
                )
                .unwrap();
                if sid.is_none() {
                    // Auxiliary/pet targets can attach before the main window.
                    // Pick the owned desktop surface by size, not event order.
                    for target in &snapshot.renderer.targets {
                        let dimensions = client.request("Runtime.evaluate", Some(json!({"expression":"innerWidth>=480&&innerHeight>=400","returnByValue":true})), Some(&target.session_id), Duration::from_secs(2));
                        if dimensions
                            .ok()
                            .and_then(|r| r.result)
                            .is_some_and(|r| r["result"]["value"] == true)
                        {
                            sid = Some(target.session_id.clone());
                            break;
                        }
                    }
                }
                if let Some(sid) = &sid {
                    if started.elapsed() > Duration::from_secs(6)
                        && let Some(path) = &probe_script
                    {
                        let script =
                            std::fs::read_to_string(path).map_err(|error| error.to_string())?;
                        if script.len() > 131072 {
                            return Err("probe script exceeds 128 KiB".into());
                        }
                        let result = client.request("Runtime.evaluate", Some(json!({"expression":script,"awaitPromise":true,"returnByValue":true})), Some(sid), Duration::from_secs(10));
                        let result = match result {
                            Ok(response) => json!({"response":response.result}),
                            Err(error) => json!({"error":error.to_string()}),
                        };
                        probes.push(
                            json!({"elapsedMs":started.elapsed().as_millis(),"result":result}),
                        );
                        std::fs::write(
                            root.join("probe.json"),
                            serde_json::to_vec_pretty(&probes).unwrap(),
                        )
                        .unwrap();
                    }
                    let response = client.request("Runtime.evaluate", Some(json!({"expression":"JSON.stringify({url:location.href,title:document.title,state:document.readyState,bridge:{type:window.electronBridge?.windowType,send:typeof window.electronBridge?.sendMessageFromView},text:document.body?.innerText?.slice(0,8000),buttons:[...document.querySelectorAll('button')].map(b=>b.innerText||b.getAttribute('aria-label')).filter(Boolean)})","returnByValue":true})), Some(sid), Duration::from_secs(4)).map_err(|e|e.to_string())?;
                    samples.push(
                        json!({"elapsedMs":started.elapsed().as_millis(),"dom":response.result}),
                    );
                    std::fs::write(
                        root.join("dom.json"),
                        serde_json::to_vec_pretty(&samples).unwrap(),
                    )
                    .unwrap();
                    if probe_script.is_none() && started.elapsed() > Duration::from_secs(15) {
                        let _ = client.request("Runtime.evaluate", Some(json!({"expression":"(()=>{const e=[...document.querySelectorAll('a,button')].find(e=>e.textContent.trim()==='Codlet');if(e){e.click();return true}return false})()","returnByValue":true})), Some(sid), Duration::from_secs(4));
                    }
                }
            }
            let sid = sid.ok_or("no renderer session")?;
            let screenshot = client
                .request(
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
        // Only the exact CDP-owned test window receives the normal app quit IPC.
        if let Some(target) = status.snapshot().renderer.targets.first() {
            let quit = client.request("Runtime.evaluate", Some(json!({"expression":include_str!("../lab/quit.js"),"awaitPromise":true,"returnByValue":true})), Some(&target.session_id), Duration::from_secs(3));
            std::fs::write(root.join("quit.txt"), format!("{quit:?}")).unwrap();
        }
        std::fs::write(
            root.join("acceptance.json"),
            serde_json::to_vec_pretty(&json!({"result":result})).unwrap(),
        )
        .unwrap();
        result
    });
    // Run the actual production event loop while the independent observer checks
    // its state. A deadline closes only our CDP connection, retiring the owned child.
    let deadline_client = runtime.client.clone();
    let (done, deadline) = std::sync::mpsc::channel();
    let watchdog = std::thread::spawn(move || {
        if deadline
            .recv_timeout(Duration::from_secs(duration + 30))
            .is_err()
        {
            let _ = deadline_client.shutdown();
        }
    });
    let outcome = runtime.wait_inner();
    let exit_started = Instant::now();
    let final_exit = runtime.process.wait(Duration::from_secs(15));
    println!(
        "owned-client-exit-after-loop: {final_exit:?}; wait-ms={}",
        exit_started.elapsed().as_millis()
    );
    let observed = worker
        .join()
        .expect("observer thread")
        .expect("rendered client observation");
    let _ = done.send(());
    watchdog.join().unwrap();
    println!("full-runtime-exit: {outcome:?}");
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
        "rendered":rendered,"pluginErrorCount":plugin_errors,"normalShutdown":outcome.is_ok(),
        "exit":format!("{final_exit:?}"),"msixUpdateAccepted":false,"signedInSessionAccepted":false
    })).unwrap()).unwrap();
    assert!(rendered, "no rendered client UI");
    assert!(outcome.is_ok(), "normal shutdown failed: {outcome:?}");
    assert!(
        observed["snapshot"]["renderer"]["targets"]
            .as_array()
            .is_some_and(|targets| !targets.is_empty()),
        "no renderer target"
    );
}
