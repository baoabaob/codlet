use super::*;

pub(super) fn run() -> Result<(), ProbeError> {
    while run_once()? {}
    Ok(())
}
fn run_once() -> Result<bool, ProbeError> {
    let scope = RegistryScope::for_path(&default_registry_path()?)?;
    let path = scope.path().to_owned();
    let lease = scope
        .acquire(REGISTRY_LEASE_DEADLINE)
        .map_err(|error| match error {
            StatusPipeError::Timeout => ProbeError::RegistryOwned { path: path.clone() },
            other => ProbeError::from(other),
        })?;
    crate::runtime_log::initialize(&path);
    let status = StatusPublisher::new();
    let (connected, servers) = start_connected_codex_with_services(Some(PreparedServices {
        status: status.clone(),
        lease,
    }))?;
    let _servers = servers.expect("safe launch owns IPC servers");
    let manage = crate::runtime_manage::RuntimeManageService::new(_servers.control.broker());
    let mut official_update = crate::official_update::OfficialUpdateOwner::start(
        &connected.process,
        &connected.package,
        manage,
    );
    let session = crate::safe_mode::RecoverySession::new(path, _servers.control.broker(), status);
    drop(connected.events);
    session.ready();
    println!(
        "package: {}\nversion: {}\nlaunched-process-id: {}",
        connected.package.full_name,
        connected.package.version,
        connected.process.process_id()
    );
    println!(
        "runtime-mode: safe\nruntime-state: active; all plugins skipped; saved enablement unchanged"
    );
    println!("action: close Codex, then launch normally to leave safe mode");
    let result = (|| {
        let mut disconnected = false;
        loop {
            if let Some(code) = connected.process.wait(RUNTIME_WAIT_SLICE)? {
                connected.client.shutdown()?;
                println!("codex-exit-code: {code}");
                let restart =
                    official_update.finish() == crate::official_update::UpdateExit::Restart;
                return if code == 0 || restart {
                    Ok(restart)
                } else {
                    Err(ProbeError::CodexExit { exit_code: code })
                };
            }
            if !disconnected && connected.client.closed_reason().is_some() {
                disconnected = true;
                session.stop("safe_mode_transport_closed; owned client retained");
                crate::runtime_log::error(
                    "safe_mode_transport_closed",
                    "Client connection closed; the owned client was retained until exit",
                );
            }
            if !disconnected {
                session.pump();
            }
            official_update.poll(false);
        }
    })();
    session.stop(if result.is_ok() {
        "safe_mode_client_exit"
    } else {
        "safe_mode_runtime_error"
    });
    result
}
