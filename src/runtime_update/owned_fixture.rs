//! Test-build-only input for the already claimed isolated lab owner. This is not
//! a management RPC, does not launch a backend, and never permits restart fallback.
use super::{
    Result, RuntimeProcessIdentity, RuntimeUpdateCandidate, RuntimeUpdatePhase, error, io_error,
    package,
};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub(super) struct Authority {
    root: PathBuf,
    marker: package::RuntimeFile,
    native: RuntimeProcessIdentity,
    pub consumed: bool,
    route_consumed: bool,
    route_pending: Option<SourceDescriptor>,
    route_id: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceDescriptor {
    schema: u32,
    kind: String,
    id: String,
    host_pid: u32,
    host_creation_time: String,
    native: RuntimeProcessIdentity,
    lab_root: PathBuf,
    install_root: PathBuf,
    marker_sha256: String,
    backend: RuntimeProcessIdentity,
    fixture: RuntimeProcessIdentity,
    upstream_base_url: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Descriptor {
    schema: u32,
    kind: String,
    id: String,
    host_pid: u32,
    native: RuntimeProcessIdentity,
    lab_root: PathBuf,
    install_root: PathBuf,
    marker_sha256: String,
    version: String,
    bytes: u64,
    sha256: String,
}
impl Authority {
    pub(super) fn template(&self) -> Result<serde_json::Value> {
        let executable = std::env::current_exe().map_err(io_error)?;
        let install = package::canonical_directory(executable.parent().ok_or_else(|| {
            error(
                "core_fixture_owner_invalid",
                "Missing installation directory.",
            )
        })?)?;
        Ok(
            serde_json::json!({"schema":1,"kind":"codlet-owned-online-update-fixture","id":null,"hostPid":std::process::id(),"native":self.native,"labRoot":self.root,"installRoot":install,"markerSha256":self.marker.sha256,"version":null,"bytes":0,"sha256":null}),
        )
    }
    pub(super) fn new(root: &Path, native: RuntimeProcessIdentity) -> Result<Self> {
        let root = package::canonical_directory(root)?;
        let marker_path = root.join(".codlet-lab-owner.json");
        let marker = package::file_record(&marker_path, ".codlet-lab-owner.json")?;
        let value: serde_json::Value =
            serde_json::from_slice(&package::read_file(&marker_path, 4096)?).map_err(|_| {
                error(
                    "core_fixture_owner_invalid",
                    "Invalid experimental lab marker.",
                )
            })?;
        if value["schema_version"] != 1
            || value["experimental"] != true
            || value["host_pid"].as_u64().is_none()
            || native.pid == 0
            || native.creation_time.is_empty()
        {
            return Err(error(
                "core_fixture_owner_invalid",
                "Fixture requires a claimed experimental lab and exact Native identity.",
            ));
        }
        Ok(Self {
            root,
            marker,
            native,
            consumed: false,
            route_consumed: false,
            route_pending: None,
            route_id: None,
        })
    }
    fn read_descriptor(&mut self, install: &Path) -> Result<Option<Descriptor>> {
        if self.consumed {
            return Err(error(
                "core_fixture_already_used",
                "This run already consumed its single fixture input; no replay is allowed.",
            ));
        }
        let descriptor = self.root.join("codlet/online-update-fixture.json");
        if !descriptor.exists() {
            return Ok(None);
        }
        self.consumed = true;
        if package::file_record(&self.root.join(&self.marker.path), &self.marker.path)?
            != self.marker
        {
            return Err(error(
                "core_fixture_owner_changed",
                "Experimental lab marker changed.",
            ));
        }
        let value: Descriptor =
            serde_json::from_slice(&package::read_file(&descriptor, 16 * 1024)?)
                .map_err(|_| error("core_fixture_invalid", "Invalid owned update descriptor."))?;
        if value.schema != 1
            || value.kind != "codlet-owned-online-update-fixture"
            || value.id.len() != 64
            || !value
                .id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || value.host_pid != std::process::id()
            || value.native != self.native
            || value.lab_root != self.root
            || value.install_root != install
            || value.marker_sha256 != self.marker.sha256
            || value.bytes == 0
            || value.bytes > super::MAX_DOWNLOAD_BYTES
            || value.sha256.len() != 64
            || self.route_id.as_ref().is_some_and(|id| id != &value.id)
            || self
                .route_pending
                .as_ref()
                .is_some_and(|route| route.id != value.id)
            || !value
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(error(
                "core_fixture_identity_invalid",
                "Fixture does not belong to the current owned run or payload identity.",
            ));
        }
        if !super::source::newer(&value.version, super::CURRENT_VERSION)? {
            return Err(error(
                "core_fixture_version_invalid",
                "Fixture version must be newer than the resident build.",
            ));
        }
        Ok(Some(value))
    }
    fn read_source_descriptor(&mut self, install: &Path) -> Result<Option<SourceDescriptor>> {
        if let Some(value) = &self.route_pending {
            return Ok(Some(value.clone()));
        }
        if self.route_consumed {
            return Ok(None);
        }
        let descriptor = self.root.join("codlet/online-update-source.json");
        if !descriptor.exists() {
            return Ok(None);
        }
        self.route_consumed = true;
        let value: SourceDescriptor =
            serde_json::from_slice(&package::read_file(&descriptor, 16 * 1024)?).map_err(|_| {
                error(
                    "core_fixture_source_invalid",
                    "Invalid owned source descriptor.",
                )
            })?;
        if value.schema != 1
            || value.kind != "codlet-owned-online-update-source"
            || value.id.len() != 64
            || !value
                .id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || value.host_pid != std::process::id()
            || value.host_creation_time != super::install::current_process_identity()?.creation_time
            || value.native != self.native
            || value.lab_root != self.root
            || value.install_root != install
            || value.marker_sha256 != self.marker.sha256
            || package::file_record(&self.root.join(&self.marker.path), &self.marker.path)?
                != self.marker
        {
            return Err(error(
                "core_fixture_source_identity_invalid",
                "Owned source descriptor belongs to another run.",
            ));
        }
        // The existing isolated launcher attests exactly one pre-Native backend.
        // Bind this fixture to that record; no backend is discovered or launched.
        let run: serde_json::Value = serde_json::from_slice(&package::read_file(
            &self.root.join("logs/manual-client.json"),
            256 * 1024,
        )?)
        .map_err(|_| {
            error(
                "core_fixture_source_identity_invalid",
                "Owned launcher record is invalid.",
            )
        })?;
        if !self.matches_launcher_record(&run, &value)? {
            return Err(error(
                "core_fixture_source_identity_invalid",
                "Source fixture does not match the existing owned backend.",
            ));
        }
        verify_process(&value.native)?;
        verify_process(&value.backend)?;
        verify_process(&value.fixture)?;
        let backend = url::Url::parse(run["endpoint"].as_str().unwrap_or("")).map_err(|_| {
            error(
                "core_fixture_source_identity_invalid",
                "Owned backend URL is invalid.",
            )
        })?;
        if backend.scheme() != "ws"
            || backend.host_str() != Some("127.0.0.1")
            || backend.username() != ""
            || backend.password().is_some()
            || backend.query().is_some()
            || backend.fragment().is_some()
        {
            return Err(error(
                "core_fixture_source_identity_invalid",
                "Owned backend URL is not literal loopback.",
            ));
        }
        verify_listener(
            backend.port().ok_or_else(|| {
                error(
                    "core_fixture_source_identity_invalid",
                    "Owned backend port is missing.",
                )
            })?,
            value.backend.pid,
        )?;
        let upstream = url::Url::parse(&value.upstream_base_url).map_err(|_| {
            error(
                "core_fixture_source_invalid",
                "Synthetic upstream URL is invalid.",
            )
        })?;
        if value.upstream_base_url.len() > 256
            || upstream.scheme() != "http"
            || upstream.host_str() != Some("127.0.0.1")
            || !upstream.username().is_empty()
            || upstream.password().is_some()
            || upstream.query().is_some()
            || upstream.fragment().is_some()
            || upstream
                .path()
                .split('/')
                .any(|piece| piece == "." || piece == "..")
            || value.upstream_base_url.contains('%')
        {
            return Err(error(
                "core_fixture_source_invalid",
                "Synthetic upstream must be one literal loopback HTTP base.",
            ));
        }
        let port = upstream
            .port()
            .filter(|port| *port >= 1024)
            .ok_or_else(|| {
                error(
                    "core_fixture_source_invalid",
                    "Synthetic upstream port is invalid.",
                )
            })?;
        verify_listener(port, value.fixture.pid)?;
        self.route_pending = Some(value.clone());
        Ok(Some(value))
    }
    fn matches_launcher_record(
        &self,
        run: &serde_json::Value,
        value: &SourceDescriptor,
    ) -> Result<bool> {
        // The launcher writes an ordinary drive path, while canonical Windows
        // paths use the verbatim prefix. Resolve the real directory with the
        // same no-link checks as Authority::new rather than comparing spelling.
        let launcher_root = run["labRoot"]
            .as_str()
            .map(Path::new)
            .map(package::canonical_directory)
            .transpose()?;
        Ok(run["schema"] == 1
            && run["hostPid"] == value.host_pid
            && run["desktopPid"] == value.native.pid
            && run["desktopCreated"] == value.native.creation_time
            && run["backendPid"] == value.backend.pid
            && launcher_root.as_deref() == Some(self.root.as_path())
            && value.fixture.pid != value.backend.pid
            && value.fixture.pid != value.native.pid
            && value.fixture.pid != value.host_pid)
    }
    fn write_source_receipt(&self, receipt: &serde_json::Value) -> Result<()> {
        if package::canonical_directory(&self.root)? != self.root
            || package::file_record(&self.root.join(&self.marker.path), &self.marker.path)?
                != self.marker
        {
            return Err(error(
                "core_fixture_owner_changed",
                "Experimental lab marker changed before source receipt publication.",
            ));
        }
        package::canonical_directory(&self.root.join("codlet"))?;
        let destination = self.root.join("codlet/online-update-source-receipt.json");
        if destination.exists() {
            package::ordinary(&destination, false)?;
        }
        package::atomic_json(&destination, receipt)
    }
    fn stage(
        &self,
        value: &Descriptor,
        install: &Path,
        state_root: &Path,
    ) -> Result<package::StagedRuntime> {
        let archive = self.root.join("codlet/online-update-fixture.zip");
        let expected = package::file_record(&archive, "online-update-fixture.zip")?;
        if expected.bytes != value.bytes || expected.sha256 != value.sha256 {
            return Err(error(
                "core_fixture_payload_changed",
                "Owned ZIP differs from the exact descriptor digest.",
            ));
        }
        let state_root = package::ensure_state_root(state_root)?;
        let mut snapshot = tempfile::NamedTempFile::new_in(&state_root).map_err(io_error)?;
        std::io::copy(
            &mut std::fs::File::open(&archive).map_err(io_error)?,
            &mut snapshot,
        )
        .map_err(io_error)?;
        snapshot.as_file().sync_all().map_err(io_error)?;
        let actual = package::file_record(snapshot.path(), "online-update-fixture.zip")?;
        if actual != expected {
            return Err(error(
                "core_fixture_payload_changed",
                "Owned ZIP changed while making its immutable snapshot.",
            ));
        }
        let selected = super::source::Candidate {
            public: RuntimeUpdateCandidate {
                online_only: false,
                id: value.id.clone(),
                version: value.version.clone(),
                platform: super::PLATFORM.into(),
                size: value.bytes,
                sha256: value.sha256.clone(),
                release_url: None,
            },
            profile: super::RuntimePayloadProfile::IsolatedClient,
            url: url::Url::parse("https://owned-fixture.invalid/runtime.zip").expect("fixed URL"),
            origins: std::collections::BTreeSet::new(),
        };
        let staged = package::stage_archive(snapshot.path(), &selected, &state_root)?;
        let contract = staged.manifest.online.as_ref().ok_or_else(|| {
            error(
                "core_fixture_online_required",
                "Fixture must declare the compatible Core module contract.",
            )
        })?;
        if contract.modules.len() != super::modules::MODULE_LIMIT
            || !super::online::compatible(install, &staged)?
        {
            return Err(error(
                "core_fixture_online_required",
                "Fixture must contain all eleven modules and unchanged resident files; restart is never permitted.",
            ));
        }
        Ok(staged)
    }
}
pub(super) fn poll(
    shared: &Arc<Mutex<super::State>>,
    install: &Path,
    state_root: &Path,
) -> Result<bool> {
    poll_source(shared, install)?;
    let (authority, descriptor, target) = {
        let mut state = shared.lock().unwrap();
        if state.busy || state.install_blocked {
            return Ok(false);
        }
        let target = state.online_target.clone().ok_or_else(|| {
            error(
                "core_fixture_target_missing",
                "The claimed lab has no authenticated Native source.",
            )
        })?;
        let Some(authority) = state.owned_fixture.as_mut() else {
            return Ok(false);
        };
        if authority.consumed {
            return Ok(false);
        }
        let Some(descriptor) = authority.read_descriptor(install)? else {
            return Ok(false);
        };
        let authority = authority.clone();
        state.busy = true;
        state.status.phase = RuntimeUpdatePhase::Downloading;
        (authority, descriptor, target)
    };
    let staged = authority.stage(&descriptor, install, state_root)?;
    // The same preflight and staging functions used by the release worker.
    super::modules::prepare(&staged, &target)?;
    let mut state = shared.lock().unwrap();
    state.status.candidate = Some(staged.candidate.clone());
    state.status.downloaded_bytes = descriptor.bytes;
    state.status.total_bytes = descriptor.bytes;
    state.staged = Some(staged);
    state.status.phase = RuntimeUpdatePhase::InstallRequested;
    state.status.error = None;
    Ok(true)
}
fn poll_source(shared: &Arc<Mutex<super::State>>, install: &Path) -> Result<()> {
    let selected = {
        let mut state = shared.lock().unwrap();
        if state.busy || state.install_blocked {
            return Ok(());
        }
        let target = state.online_target.clone();
        let Some(authority) = state.owned_fixture.as_mut() else {
            return Ok(());
        };
        let descriptor = match authority.read_source_descriptor(install) {
            Ok(value) => value,
            Err(failure) => {
                // The input never established its declared identity. Publish
                // only a bounded code to this already attested owner's fixed
                // receipt path; no input path, token or other field is echoed.
                authority.write_source_receipt(&serde_json::json!({
                    "schema":1,"kind":"fixture-explicit-source","id":null,
                    "status":"rejected","error":failure.code
                }))?;
                return Err(failure);
            }
        };
        let Some(descriptor) = descriptor else {
            return Ok(());
        };
        let Some(target) = target else {
            authority.write_source_receipt(&serde_json::json!({
                "schema":1,"kind":"fixture-explicit-source","id":descriptor.id,
                "status":"rejected","error":"core_fixture_target_missing"
            }))?;
            authority.route_pending = None;
            return Err(error(
                "core_fixture_target_missing",
                "Owned source is not attached.",
            ));
        };
        (authority.clone(), descriptor, target)
    };
    let (authority, descriptor, target) = selected;
    match target.install_owned_fixture_route(&descriptor.id, &descriptor.upstream_base_url) {
        Err(failure) if failure.code == "client_bridge_uncertain" => Ok(()),
        result => {
            let receipt = match &result {
                Ok(route) => {
                    serde_json::json!({"schema":1,"kind":"fixture-explicit-source","id":descriptor.id,"status":"registered","routeBaseUrl":route["routeBaseUrl"],"native":descriptor.native,"backend":descriptor.backend,"fixture":descriptor.fixture})
                }
                Err(failure) => {
                    serde_json::json!({"schema":1,"kind":"fixture-explicit-source","id":descriptor.id,"status":"rejected","error":failure.code})
                }
            };
            authority.write_source_receipt(&receipt)?;
            if let Some(current) = shared.lock().unwrap().owned_fixture.as_mut() {
                current.route_pending = None;
                if result.is_ok() {
                    current.route_id = Some(descriptor.id);
                }
            }
            result
                .map(|_| ())
                .map_err(|failure| error(failure.code, failure.message))
        }
    }
}
#[cfg(windows)]
fn verify_process(identity: &RuntimeProcessIdentity) -> Result<()> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, identity.pid) };
    if handle.is_null() {
        return Err(error(
            "core_fixture_process_changed",
            "Owned process is no longer available.",
        ));
    }
    let mut created = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exited = created;
    let mut kernel = created;
    let mut user = created;
    let mut exit = 0;
    let matched = unsafe {
        GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) != 0
            && GetExitCodeProcess(handle, &mut exit) != 0
            && exit == 259
    } && (((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
        .to_string()
        == identity.creation_time;
    unsafe {
        CloseHandle(handle);
    }
    if !matched {
        return Err(error(
            "core_fixture_process_changed",
            "Owned process creation identity changed.",
        ));
    }
    Ok(())
}
#[cfg(windows)]
fn verify_listener(port: u16, pid: u32) -> Result<()> {
    // ABI verified against local Windows SDK iphlpapi.h/iprtrmib.h. This reads
    // listener ownership only; it neither probes nor opens a backend connection.
    #[link(name = "iphlpapi")]
    unsafe extern "system" {
        fn GetExtendedTcpTable(
            table: *mut std::ffi::c_void,
            size: *mut u32,
            order: i32,
            family: u32,
            class: i32,
            reserved: u32,
        ) -> u32;
    }
    let mut size = 0;
    let first = unsafe { GetExtendedTcpTable(std::ptr::null_mut(), &mut size, 0, 2, 3, 0) };
    if first != 122 || !(4..=4 * 1024 * 1024).contains(&size) {
        return Err(error(
            "core_fixture_listener_invalid",
            "Cannot inspect bounded owned listener table.",
        ));
    }
    let mut table = vec![0u32; size.div_ceil(4) as usize];
    let result = unsafe { GetExtendedTcpTable(table.as_mut_ptr().cast(), &mut size, 0, 2, 3, 0) };
    if result != 0 {
        return Err(error(
            "core_fixture_listener_invalid",
            "Owned listener table changed.",
        ));
    }
    let count = table[0] as usize;
    if count > table.len().saturating_sub(1) / 6 {
        return Err(error(
            "core_fixture_listener_invalid",
            "Invalid owned listener table.",
        ));
    }
    let matches = table[1..1 + count * 6]
        .chunks_exact(6)
        .filter(|row| u16::from_be(row[2] as u16) == port)
        .collect::<Vec<_>>();
    if matches.len() != 1 || matches[0][1].to_ne_bytes() != [127, 0, 0, 1] || matches[0][5] != pid {
        return Err(error(
            "core_fixture_listener_invalid",
            "Literal loopback listener is not owned by the declared process.",
        ));
    }
    Ok(())
}
#[cfg(not(windows))]
fn verify_process(_: &RuntimeProcessIdentity) -> Result<()> {
    Err(error(
        "core_fixture_platform_unsupported",
        "Owned source fixtures require Windows identity attestation.",
    ))
}
#[cfg(not(windows))]
fn verify_listener(_: u16, _: u32) -> Result<()> {
    Err(error(
        "core_fixture_platform_unsupported",
        "Owned source fixtures require Windows listener attestation.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source_value(authority: &Authority, install: &Path) -> serde_json::Value {
        serde_json::json!({"schema":1,"kind":"codlet-owned-online-update-source","id":"a".repeat(64),"hostPid":std::process::id(),"hostCreationTime":super::super::install::current_process_identity().unwrap().creation_time,"native":authority.native,"labRoot":authority.root,"installRoot":install,"markerSha256":authority.marker.sha256,"backend":{"pid":10,"creationTime":"1"},"fixture":{"pid":11,"creationTime":"2"},"upstreamBaseUrl":"http://127.0.0.1:49123/v1"})
    }
    #[cfg(windows)]
    #[test]
    fn source_launcher_accepts_real_ordinary_and_verbatim_spellings_of_the_same_owned_root() {
        let (_temp, authority, install, _) = fixture();
        let descriptor: SourceDescriptor =
            serde_json::from_value(source_value(&authority, &install)).unwrap();
        let ordinary = PathBuf::from(
            authority
                .root
                .to_str()
                .unwrap()
                .strip_prefix(r"\\?\")
                .expect("Windows canonical paths use the verbatim prefix"),
        );
        assert_ne!(ordinary, authority.root);
        let mut run = serde_json::json!({"schema":1,"hostPid":descriptor.host_pid,"desktopPid":descriptor.native.pid,"desktopCreated":descriptor.native.creation_time,"backendPid":descriptor.backend.pid,"labRoot":ordinary});
        assert!(
            authority
                .matches_launcher_record(&run, &descriptor)
                .unwrap()
        );
        run["labRoot"] = serde_json::json!(authority.root);
        assert!(
            authority
                .matches_launcher_record(&run, &descriptor)
                .unwrap()
        );
        run["labRoot"] = serde_json::json!(install);
        assert!(
            !authority
                .matches_launcher_record(&run, &descriptor)
                .unwrap()
        );
        run["labRoot"] = serde_json::json!(ordinary);
        run["backendPid"] = serde_json::json!(descriptor.backend.pid + 1);
        assert!(
            !authority
                .matches_launcher_record(&run, &descriptor)
                .unwrap()
        );
        run["backendPid"] = serde_json::json!(descriptor.backend.pid);
        run["desktopCreated"] = serde_json::json!("changed");
        assert!(
            !authority
                .matches_launcher_record(&run, &descriptor)
                .unwrap()
        );
    }
    #[test]
    fn source_validation_failure_publishes_one_bounded_owned_receipt_without_replay() {
        let (temp, authority, install, _) = fixture();
        let mut value = source_value(&authority, &install);
        value["native"]["creationTime"] = "changed".into();
        std::fs::write(
            authority.root.join("codlet/online-update-source.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        let receipt_path = authority
            .root
            .join("codlet/online-update-source-receipt.json");
        let service = super::super::RuntimeUpdateService::start(
            install.clone(),
            temp.path().join("state"),
            None,
        )
        .unwrap();
        service.shared.lock().unwrap().owned_fixture = Some(authority);
        assert_eq!(
            poll_source(&service.shared, &install).unwrap_err().code,
            "core_fixture_source_identity_invalid"
        );
        let bytes = package::read_file(&receipt_path, 4096).unwrap();
        let receipt: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            receipt,
            serde_json::json!({"schema":1,"kind":"fixture-explicit-source","id":null,"status":"rejected","error":"core_fixture_source_identity_invalid"})
        );
        assert!(
            service
                .shared
                .lock()
                .unwrap()
                .owned_fixture
                .as_ref()
                .unwrap()
                .route_consumed
        );
        poll_source(&service.shared, &install).unwrap();
        assert_eq!(package::read_file(&receipt_path, 4096).unwrap(), bytes);
    }
    #[test]
    fn source_receipt_refuses_changed_owner_and_linked_destinations() {
        let (temp, authority, _install, _) = fixture();
        let outside = temp.path().join("outside-receipt.json");
        std::fs::write(&outside, b"preserved").unwrap();
        std::fs::hard_link(
            &outside,
            authority
                .root
                .join("codlet/online-update-source-receipt.json"),
        )
        .unwrap();
        assert_eq!(
            authority
                .write_source_receipt(&serde_json::json!({}))
                .unwrap_err()
                .code,
            "runtime_update_path_invalid"
        );
        assert_eq!(std::fs::read(&outside).unwrap(), b"preserved");
        std::fs::write(authority.root.join(&authority.marker.path), b"changed").unwrap();
        assert_eq!(
            authority
                .write_source_receipt(&serde_json::json!({}))
                .unwrap_err()
                .code,
            "core_fixture_owner_changed"
        );
        assert_eq!(std::fs::read(&outside).unwrap(), b"preserved");
    }
    #[test]
    fn source_fixture_rejects_another_native_identity_and_consumes_once() {
        let (_root, mut authority, install, template) = fixture();
        let value = serde_json::json!({"schema":1,"kind":"codlet-owned-online-update-source","id":"a".repeat(64),"hostPid":std::process::id(),"hostCreationTime":super::super::install::current_process_identity().unwrap().creation_time,"native":{"pid":99,"creationTime":"changed"},"labRoot":template["labRoot"],"installRoot":install,"markerSha256":template["markerSha256"],"backend":{"pid":10,"creationTime":"1"},"fixture":{"pid":11,"creationTime":"2"},"upstreamBaseUrl":"http://127.0.0.1:49123/v1"});
        std::fs::write(
            authority.root.join("codlet/online-update-source.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        assert_eq!(
            authority.read_source_descriptor(&install).unwrap_err().code,
            "core_fixture_source_identity_invalid"
        );
        assert!(
            authority
                .read_source_descriptor(&install)
                .unwrap()
                .is_none()
        );
    }
    #[cfg(windows)]
    #[test]
    fn source_listener_requires_exact_loopback_pid_and_live_creation_identity() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        verify_listener(port, std::process::id()).unwrap();
        assert!(verify_listener(port, 0).is_err());
        let mut identity = super::super::install::current_process_identity().unwrap();
        verify_process(&identity).unwrap();
        identity.creation_time.push('0');
        assert!(verify_process(&identity).is_err());
    }
    fn fixture() -> (tempfile::TempDir, Authority, PathBuf, serde_json::Value) {
        let temp = tempfile::tempdir().unwrap();
        let lab = temp.path().join("lab");
        let install = temp.path().join("install");
        std::fs::create_dir_all(lab.join("codlet")).unwrap();
        std::fs::create_dir(&install).unwrap();
        std::fs::write(
            lab.join(".codlet-lab-owner.json"),
            br#"{"schema_version":1,"experimental":true,"host_pid":1}"#,
        )
        .unwrap();
        let authority = Authority::new(
            &lab,
            RuntimeProcessIdentity {
                pid: 99,
                creation_time: "1234".into(),
            },
        )
        .unwrap();
        let install = install.canonicalize().unwrap();
        let value = serde_json::json!({"schema":1,"kind":"codlet-owned-online-update-fixture","id":"a".repeat(64),"hostPid":std::process::id(),"native":{"pid":99,"creationTime":"1234"},"labRoot":authority.root,"installRoot":install,"markerSha256":authority.marker.sha256,"version":"9.0.0","bytes":1,"sha256":"b".repeat(64)});
        (temp, authority, install, value)
    }
    fn write(authority: &Authority, value: &serde_json::Value) {
        std::fs::write(
            authority.root.join("codlet/online-update-fixture.json"),
            serde_json::to_vec(value).unwrap(),
        )
        .unwrap();
    }
    #[test]
    fn rejects_stale_pid_creation_and_another_run_before_staging() {
        for field in ["pid", "creation", "root", "host", "marker"] {
            let (_temp, mut authority, install, mut value) = fixture();
            match field {
                "pid" => value["native"]["pid"] = 100.into(),
                "creation" => value["native"]["creationTime"] = "1235".into(),
                "root" => value["labRoot"] = install.to_string_lossy().to_string().into(),
                "host" => value["hostPid"] = 1.into(),
                _ => value["markerSha256"] = "c".repeat(64).into(),
            };
            write(&authority, &value);
            assert_eq!(
                authority.read_descriptor(&install).err().unwrap().code,
                "core_fixture_identity_invalid"
            );
        }
    }
    #[test]
    fn tampered_zip_and_reused_input_never_stage_or_replay() {
        let (temp, mut authority, install, value) = fixture();
        write(&authority, &value);
        let descriptor = authority.read_descriptor(&install).unwrap().unwrap();
        std::fs::write(
            authority.root.join("codlet/online-update-fixture.zip"),
            b"x",
        )
        .unwrap();
        assert_eq!(
            authority
                .stage(&descriptor, &install, &temp.path().join("state"))
                .err()
                .unwrap()
                .code,
            "core_fixture_payload_changed"
        );
        assert_eq!(
            authority.read_descriptor(&install).err().unwrap().code,
            "core_fixture_already_used"
        );
        assert!(!temp.path().join("state").exists());
    }
    #[test]
    fn redirected_or_hardlinked_descriptor_is_rejected() {
        let (temp, mut authority, install, value) = fixture();
        let outside = temp.path().join("outside.json");
        std::fs::write(&outside, serde_json::to_vec(&value).unwrap()).unwrap();
        std::fs::hard_link(
            &outside,
            authority.root.join("codlet/online-update-fixture.json"),
        )
        .unwrap();
        assert!(authority.read_descriptor(&install).is_err());
    }
}
