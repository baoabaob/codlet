//! Independently published, advisory acceptance records. These never authorize
//! plugins, alter private mappings, download code, or infer client updates.
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::runtime_settings::RuntimeSettings;
use crate::runtime_update::newer_version;

const SOURCE: &str = "https://raw.githubusercontent.com/baoabaob/codlet/main/compatibility/tested-client-versions.json";
const BASELINE: &str = include_str!("../compatibility/client-compatibility-baseline.json");
const MAX_BYTES: usize = 64 * 1024;
const MAX_CACHE_BYTES: usize = MAX_BYTES + 1024;
const REFRESH: Duration = Duration::from_secs(6 * 3600);
const RETRY: Duration = Duration::from_secs(15 * 60);
const COALESCE: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Catalog {
    schema: u32,
    kind: String,
    repository: String,
    revision: u64,
    records: Vec<Record>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    platform: String,
    client_version: String,
    minimum_core_version: String,
    required_adapters: BTreeMap<String, String>,
    verified_with: Vec<Verification>,
    #[serde(default, skip_serializing_if = "is_false")]
    legacy_record: bool,
}

fn is_false(value: &bool) -> bool {
    !value
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Verification {
    core_version: String,
    adapters: BTreeMap<String, String>,
}

fn valid_version(value: &str) -> bool {
    newer_version(value, value).is_ok()
}
fn at_least(current: &str, minimum: &str) -> bool {
    matches!(newer_version(minimum, current), Ok(false))
}
fn valid_adapters(adapters: &BTreeMap<String, String>) -> bool {
    adapters.len() <= 2
        && adapters.iter().all(|(id, version)| {
            matches!(id.as_str(), "codex.desktop.adapter" | "codex.ui.adapter")
                && valid_version(version)
        })
}
fn parse_catalog(bytes: &[u8]) -> Result<Catalog, String> {
    if bytes.len() > MAX_BYTES {
        return Err("Compatibility manifest exceeds the size limit".into());
    }
    let catalog: Catalog = serde_json::from_slice(bytes)
        .map_err(|_| "Invalid compatibility manifest schema".to_owned())?;
    if catalog.schema != 3
        || catalog.kind != "codlet-client-compatibility"
        || catalog.repository != "baoabaob/codlet"
        || !(1..=(1u64 << 53) - 1).contains(&catalog.revision)
        || catalog.records.len() > 256
    {
        return Err("Invalid compatibility manifest identity or bounds".into());
    }
    let mut identities = BTreeSet::new();
    for record in &catalog.records {
        let client_parts: Vec<_> = record.client_version.split('.').collect();
        if !matches!(
            record.platform.as_str(),
            "windows-x86_64" | "windows-aarch64" | "macos-aarch64"
        ) || record.client_version.len() > 64
            || !(3..=4).contains(&client_parts.len())
            || client_parts
                .iter()
                .any(|part| part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()))
            || !valid_version(&record.minimum_core_version)
            || !valid_adapters(&record.required_adapters)
            || record.verified_with.is_empty() && !record.legacy_record
            || record.legacy_record
                && (!record.required_adapters.is_empty() || !record.verified_with.is_empty())
            || record.verified_with.len() > 8
            || !identities.insert((&record.platform, &record.client_version))
            || record.verified_with.iter().any(|verification| {
                !valid_version(&verification.core_version)
                    || !at_least(&verification.core_version, &record.minimum_core_version)
                    || !valid_adapters(&verification.adapters)
                    || record.required_adapters.iter().any(|(id, minimum)| {
                        verification
                            .adapters
                            .get(id)
                            .is_none_or(|version| !at_least(version, minimum))
                    })
            })
        {
            return Err("Invalid or duplicate client compatibility record".into());
        }
    }
    Ok(catalog)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cache {
    schema: u32,
    source_url: String,
    checked_at_unix_ms: u64,
    etag: Option<String>,
    catalog: Catalog,
}

fn cache_path(registry: &Path) -> PathBuf {
    let mut path = registry.as_os_str().to_owned();
    path.push(".compatibility-cache.json");
    PathBuf::from(path)
}
fn plain_path(path: &Path) -> Result<(), String> {
    for part in path.ancestors() {
        match std::fs::symlink_metadata(part) {
            Ok(metadata) => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes() & 0x400 != 0 {
                        return Err("Linked compatibility cache path rejected".into());
                    }
                }
                if metadata.file_type().is_symlink() || (part == path && !metadata.is_file()) {
                    return Err("Invalid compatibility cache path".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err("Compatibility cache is unavailable".into()),
        }
    }
    Ok(())
}
fn valid_etag(value: &str) -> bool {
    value.len() <= 256 && value.is_ascii() && reqwest::header::HeaderValue::from_str(value).is_ok()
}
fn read_cache(path: &Path, now: u64) -> Result<Option<Cache>, String> {
    plain_path(path)?;
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Compatibility cache is unavailable".into()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_CACHE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Compatibility cache is unreadable".to_owned())?;
    if bytes.len() > MAX_CACHE_BYTES {
        return Err("Compatibility cache exceeds the size limit".into());
    }
    let cache: Cache =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid compatibility cache".to_owned())?;
    if cache.schema != 1
        || cache.source_url != SOURCE
        || cache.checked_at_unix_ms > now.saturating_add(5 * 60 * 1000)
        || cache.etag.as_deref().is_some_and(|etag| !valid_etag(etag))
    {
        return Err("Invalid compatibility cache identity".into());
    }
    parse_catalog(&serde_json::to_vec(&cache.catalog).map_err(|_| "Invalid cached catalog")?)?;
    Ok(Some(cache))
}
fn write_cache(path: &Path, cache: &Cache) -> Result<(), String> {
    plain_path(path)?;
    let bytes = serde_json::to_vec(cache).map_err(|_| "Invalid compatibility cache")?;
    if bytes.len() > MAX_CACHE_BYTES {
        return Err("Compatibility cache exceeds the size limit".into());
    }
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("Cache has no parent")?)
        .map_err(|_| "Compatibility cache cannot be written".to_owned())?;
    file.write_all(&bytes)
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| "Compatibility cache cannot be written".to_owned())?;
    file.persist(path)
        .map_err(|_| "Compatibility cache cannot be replaced".to_owned())?;
    Ok(())
}

struct State {
    catalog: Catalog,
    source: &'static str,
    checked_at: Option<u64>,
    etag: Option<String>,
    phase: &'static str,
    error: Option<String>,
    last_attempt: Option<Instant>,
}
impl State {
    fn load(path: &Path) -> Self {
        let baseline = parse_catalog(BASELINE.as_bytes()).expect("bundled compatibility metadata");
        let mut state = Self {
            catalog: baseline,
            source: "local-package",
            checked_at: None,
            etag: None,
            phase: "idle",
            error: None,
            last_attempt: None,
        };
        match read_cache(path, unix_ms()) {
            Ok(Some(cache)) if cache.catalog.revision >= state.catalog.revision => {
                if cache.catalog.revision == state.catalog.revision
                    && cache.catalog != state.catalog
                {
                    state.error =
                        Some("Compatibility revision was reused with different content".into());
                } else {
                    state.catalog = cache.catalog;
                    state.source = "remote-cache";
                    state.checked_at = Some(cache.checked_at_unix_ms);
                    state.etag = cache.etag;
                }
            }
            Ok(_) => (),
            Err(error) => state.error = Some(error),
        }
        state
    }
    fn accept(&mut self, fetched: Fetched, path: &Path) -> Result<(), String> {
        if let Some(catalog) = fetched.catalog {
            if catalog.revision < self.catalog.revision {
                return Err("Older compatibility revision rejected".into());
            }
            if catalog.revision == self.catalog.revision && catalog != self.catalog {
                return Err("Compatibility revision was reused with different content".into());
            }
            self.catalog = catalog;
            self.etag = fetched.etag;
        } else if self.checked_at.is_none() {
            return Err("Unexpected compatibility not-modified response".into());
        }
        self.source = "remote-manifest";
        self.checked_at = Some(unix_ms());
        self.error = None;
        write_cache(
            path,
            &Cache {
                schema: 1,
                source_url: SOURCE.into(),
                checked_at_unix_ms: self.checked_at.unwrap(),
                etag: self.etag.clone(),
                catalog: self.catalog.clone(),
            },
        )
    }
}

struct Fetched {
    catalog: Option<Catalog>,
    etag: Option<String>,
}
async fn fetch(url: &str, etag: Option<&str>) -> Result<Fetched, String> {
    // Only the compiled source reaches this function in production. Redirects
    // are rejected; no API token, plugin credentials or client identity is sent.
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .user_agent("Codlet-client-compatibility/1")
        .build()
        .map_err(|error| error.without_url().to_string())?;
    let mut request = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json");
    if let Some(etag) = etag.filter(|value| valid_etag(value)) {
        request = request.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    let mut response = request
        .send()
        .await
        .map_err(|error| error.without_url().to_string())?;
    if response.status() == reqwest::StatusCode::NOT_MODIFIED {
        if etag.is_none() {
            return Err("Unexpected compatibility not-modified response".into());
        }
        return Ok(Fetched {
            catalog: None,
            etag: None,
        });
    }
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!(
            "Compatibility source returned HTTP {}",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BYTES as u64)
    {
        return Err("Compatibility manifest exceeds the size limit".into());
    }
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|header| header.to_str().ok())
        .filter(|value| valid_etag(value))
        .map(str::to_owned);
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| error.without_url().to_string())?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_BYTES {
            return Err("Compatibility manifest exceeds the size limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Fetched {
        catalog: Some(parse_catalog(&bytes)?),
        etag,
    })
}
fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

struct Worker {
    sender: mpsc::SyncSender<()>,
    handle: std::thread::JoinHandle<()>,
}
struct Owner {
    state: Arc<Mutex<State>>,
    running: String,
    platform: String,
    path: PathBuf,
    settings: Option<RuntimeSettings>,
    cancellation: CancellationToken,
    worker: Mutex<Option<Worker>>,
}
impl Drop for Owner {
    fn drop(&mut self) {
        self.stop();
    }
}
impl Owner {
    fn stop(&self) {
        self.cancellation.cancel();
        if let Some(worker) = self
            .worker
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            let _ = worker.sender.try_send(());
            let _ = worker.handle.join();
        }
    }
}
#[derive(Clone)]
pub(crate) struct ClientCompatibility(Arc<Owner>);
impl ClientCompatibility {
    pub(crate) fn new(running: &str, registry: &Path, settings: Option<RuntimeSettings>) -> Self {
        let path = cache_path(registry);
        Self(Arc::new(Owner {
            state: Arc::new(Mutex::new(State::load(&path))),
            running: running.into(),
            platform: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
            path,
            settings,
            cancellation: CancellationToken::new(),
            worker: Mutex::new(None),
        }))
    }
    pub(crate) fn start(&self) {
        self.start_with_source(SOURCE);
    }
    fn start_with_source(&self, source: &str) {
        if self.0.cancellation.is_cancelled() {
            return;
        }
        let mut worker = self
            .0
            .worker
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if worker.is_some() {
            return;
        }
        let state = self.0.state.clone();
        let path = self.0.path.clone();
        let running = self.0.running.clone();
        let platform = self.0.platform.clone();
        let settings = self.0.settings.clone();
        let cancellation = self.0.cancellation.clone();
        let source = source.to_owned();
        let (sender, receiver) = mpsc::sync_channel(1);
        match std::thread::Builder::new()
            .name("client-compatibility".into())
            .spawn(move || {
                refresh_loop(
                    state,
                    path,
                    running,
                    platform,
                    settings,
                    source,
                    receiver,
                    cancellation,
                );
            }) {
            Ok(handle) => *worker = Some(Worker { sender, handle }),
            Err(_) => {
                self.0
                    .state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .error = Some("Compatibility worker could not start".into())
            }
        }
    }
    pub(crate) fn check(&self) {
        self.start();
        if let Some(worker) = self
            .0
            .worker
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
        {
            let _ = worker.sender.try_send(());
        }
    }
    pub(crate) fn stop(&self) {
        self.0.stop();
    }
    pub(crate) fn status(&self, plugins: &Value) -> Value {
        let state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        status(
            &state,
            &self.0.running,
            &self.0.platform,
            env!("CARGO_PKG_VERSION"),
            plugins,
        )
    }
}

fn refresh_loop(
    state: Arc<Mutex<State>>,
    path: PathBuf,
    running: String,
    platform: String,
    settings: Option<RuntimeSettings>,
    source: String,
    receiver: mpsc::Receiver<()>,
    cancellation: CancellationToken,
) {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => {
            state
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .error = Some("Compatibility worker is unavailable".into());
            return;
        }
    };
    let mut next_check = {
        let state = state.lock().unwrap_or_else(|error| error.into_inner());
        let known = state
            .catalog
            .records
            .iter()
            .any(|record| record.platform == platform && record.client_version == running);
        let age = state.checked_at.map_or(REFRESH, |checked| {
            Duration::from_millis(unix_ms().saturating_sub(checked))
        });
        Instant::now()
            + if known {
                REFRESH.saturating_sub(age)
            } else {
                Duration::ZERO
            }
    };
    let mut manual = false;
    loop {
        if cancellation.is_cancelled() {
            break;
        }
        let automatic = settings
            .as_ref()
            .and_then(|settings| settings.cached().ok())
            .is_some_and(|settings| settings.values.automatic_update_checks);
        if automatic {
            let mut state = state.lock().unwrap_or_else(|error| error.into_inner());
            if state.phase == "disabled" {
                state.phase = if state.error.is_some() {
                    "error"
                } else {
                    "idle"
                };
            }
        }
        if manual || automatic && Instant::now() >= next_check {
            let etag = {
                let mut state = state.lock().unwrap_or_else(|error| error.into_inner());
                if manual
                    && state
                        .last_attempt
                        .is_some_and(|attempt| attempt.elapsed() < COALESCE)
                {
                    None
                } else {
                    state.phase = "checking";
                    state.last_attempt = Some(Instant::now());
                    Some(state.etag.clone())
                }
            };
            if let Some(etag) = etag {
                let result = runtime.block_on(async {
                    tokio::select! {
                        _ = cancellation.cancelled() => None,
                        result = fetch(&source, etag.as_deref()) => Some(result),
                    }
                });
                let Some(result) = result else {
                    break;
                };
                if cancellation.is_cancelled() {
                    break;
                }
                let mut state = state.lock().unwrap_or_else(|error| error.into_inner());
                let result = result.and_then(|fetched| state.accept(fetched, &path));
                next_check = Instant::now() + if result.is_ok() { REFRESH } else { RETRY };
                state.phase = if result.is_ok() { "idle" } else { "error" };
                state.error = result.err();
            }
            manual = false;
        } else if !automatic {
            state
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .phase = "disabled";
        }
        match receiver.recv_timeout(Duration::from_secs(1)) {
            Ok(()) => manual = true,
            Err(mpsc::RecvTimeoutError::Timeout) => (),
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn status(state: &State, running: &str, platform: &str, core: &str, plugins: &Value) -> Value {
    let records: Vec<_> = state
        .catalog
        .records
        .iter()
        .filter(|record| record.platform == platform)
        .collect();
    let record = records
        .iter()
        .find(|record| record.client_version == running)
        .copied();
    let mut missing = Vec::new();
    if let Some(record) = record {
        if !at_least(core, &record.minimum_core_version) {
            missing.push(json!({"kind":"core","minimumVersion":record.minimum_core_version,"currentVersion":core}));
        }
        for (id, minimum) in &record.required_adapters {
            let installed = plugins
                .as_array()
                .and_then(|plugins| plugins.iter().find(|plugin| plugin["id"] == *id));
            let version = installed.and_then(|plugin| plugin["version"].as_str());
            let active = installed.is_some_and(|plugin| plugin["active"] == true);
            if !active || version.is_none_or(|version| !at_least(version, minimum)) {
                missing.push(json!({"kind":"adapter","id":id,"minimumVersion":minimum,"currentVersion":version,"active":active}));
            }
        }
    }
    let supported = record.is_some() && missing.is_empty();
    json!({"source":state.source,"status":if supported {"matched"} else if record.is_some() {"requirements-unmet"} else {"unmatched"},
        "runningVersion":running,"platform":platform,"adaptedVersions":records.iter().map(|record| &record.client_version).collect::<Vec<_>>(),
        "matchesRunningClient":supported,"verificationRecord":record,"missingRequirements":missing,
        "compatibilityCatalog":{"sourceUrl":SOURCE,"revision":state.catalog.revision,"phase":state.phase,
            "checkedAtUnixMs":state.checked_at,"refreshIntervalSeconds":REFRESH.as_secs(),"error":state.error}})
}

#[cfg(test)]
mod tests;
