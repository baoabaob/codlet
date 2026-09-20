//! Explicit local support exports. Project typed diagnostic facts into a small
//! allowlist; do not archive logs, configuration files, plugin source or raw errors.
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::diagnostics::{Check, DoctorReport};

const MAX_SUMMARY_BYTES: usize = 4 * 1024 * 1024;
const README: &str = "Codlet diagnostic bundle / Codlet 诊断包\n\n\
This is a local, read-only snapshot, not a successful runtime acceptance verdict.\n\
No upload was performed. An exported bundle may describe failed checks.\n\n\
Included: Codlet/platform/package versions, plugin IDs and versions, declared\n\
capabilities and permission names, configuration/check status, lifecycle facts,\n\
process IDs, sample times and error/event codes. Target identifiers are aliases\n\
within this bundle. Missing runtime evidence remains unavailable.\n\n\
Excluded: paths, registry contents, permission resource paths, raw messages,\n\
plugin source, log files, environment variables, conversations and credentials.\n\
Plugin metadata is retained; inspect the JSON before sharing it.\n\n\
manifest.json lists SHA-256 and size for each payload. Hashes check integrity,\n\
not authenticity. doctor-summary.json deliberately omits free-form errors.\n\
Use codlet doctor locally when the full error and recovery instructions are needed.\n\n\
诊断包仅导出到指定本地文件，不上传。检查失败也能导出，导出成功不代表运行正常。\n\
保留版本、插件 ID、权限名、生命周期与错误代码；不包含路径、原始日志、会话或凭据。\n\
完整错误及修复提示请在本机运行 codlet doctor 查看。\n";

#[derive(Debug, thiserror::Error)]
pub enum BundleError {
    #[error("Choose an absolute .zip path in an existing directory")]
    InvalidOutput,
    #[error("The diagnostic output already exists; choose a new filename")]
    Exists,
    #[error("The diagnostic summary exceeds the export limit")]
    TooLarge,
    #[error("Diagnostic export I/O: {0}")]
    Io(#[from] io::Error),
    #[error("Diagnostic export ZIP: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("Diagnostic serialization: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReceipt {
    pub schema: &'static str,
    pub path: PathBuf,
    pub bytes: u64,
    pub sha256: String,
    pub doctor_status: &'static str,
}

/// Validate the destination before collecting any OS or Host observations.
/// Publishing uses no-clobber even if another writer wins after this check.
pub fn validate_output(output: &Path) -> Result<(), BundleError> {
    let name = output
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or(BundleError::InvalidOutput)?;
    if !output.is_absolute()
        || !name.to_ascii_lowercase().ends_with(".zip")
        || name.contains(':')
        || name.ends_with([' ', '.'])
        || output.parent().is_none_or(|parent| !parent.is_dir())
    {
        return Err(BundleError::InvalidOutput);
    }
    match fs::symlink_metadata(output) {
        Ok(_) => Err(BundleError::Exists),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub fn export(output: &Path, report: &DoctorReport) -> Result<ExportReceipt, BundleError> {
    validate_output(output)?;
    let summary = serde_json::to_vec_pretty(&summary(report))?;
    if summary.len() > MAX_SUMMARY_BYTES {
        return Err(BundleError::TooLarge);
    }
    let payloads = [
        ("doctor-summary.json", summary.as_slice()),
        ("README.txt", README.as_bytes()),
    ];
    let files: Vec<_> = payloads
        .iter()
        .map(|(name, bytes)| json!({"path":name,"bytes":bytes.len(),"sha256":digest(bytes)}))
        .collect();
    let manifest = serde_json::to_vec_pretty(&json!({
        "schema":"codlet.diagnostic-bundle/v1", "codletVersion":env!("CARGO_PKG_VERSION"),
        "exporterSha256":exporter_digest().ok(),
        "platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,
        "collectedAtUnixMs":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
        "projection":"summary-v1", "files":files
    }))?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(output.parent().ok_or(BundleError::InvalidOutput)?)?;
    {
        let mut archive = zip::ZipWriter::new(temporary.as_file_mut());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored)
            .unix_permissions(0o600);
        for (name, bytes) in payloads
            .into_iter()
            .chain([("manifest.json", manifest.as_slice())])
        {
            archive.start_file(name, options)?;
            archive.write_all(bytes)?;
        }
        archive.finish()?;
    }
    temporary.as_file().sync_all()?;
    let bytes = temporary.as_file().metadata()?.len();
    let sha256 = digest(&fs::read(temporary.path())?);
    temporary.persist_noclobber(output).map_err(|error| {
        if error.error.kind() == io::ErrorKind::AlreadyExists {
            BundleError::Exists
        } else {
            BundleError::Io(error.error)
        }
    })?;
    Ok(ExportReceipt {
        schema: "codlet.diagnostic-export/v1",
        path: output.to_owned(),
        bytes,
        sha256,
        doctor_status: report.result.status,
    })
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn exporter_digest() -> io::Result<String> {
    let file = fs::File::open(std::env::current_exe()?)?;
    let limit = 512 * 1024 * 1024;
    if file.metadata()?.len() > limit {
        return Err(io::Error::other("Exporter exceeds the hash size limit"));
    }
    let mut source = file.take(limit + 1);
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut total = 0;
    loop {
        let read = source.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > limit {
            return Err(io::Error::other("Exporter changed during hashing"));
        }
        hash.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn check<T>(value: &Check<T>) -> Value {
    match value {
        Check::Ok { .. } => json!({"status":"ok"}),
        Check::Failed { error } => json!({"status":"failed","code":error.code}),
        Check::Unavailable { .. } => json!({"status":"unavailable"}),
    }
}
fn data<T>(value: &Check<T>) -> Option<&T> {
    if let Check::Ok { data } = value {
        Some(data)
    } else {
        None
    }
}
fn capabilities(values: &[crate::capabilities::CapabilityDescriptor]) -> Value {
    json!(
        values
            .iter()
            .map(|c| json!({"name":c.name,"api":c.api,"scope":c.scope}))
            .collect::<Vec<_>>()
    )
}
#[derive(Default)]
struct Targets(BTreeMap<String, String>);
impl Targets {
    fn alias(&mut self, target: &str) -> String {
        let next = format!("target-{}", self.0.len() + 1);
        self.0.entry(target.to_owned()).or_insert(next).clone()
    }
}

/// Every exported field is selected here. New fields in Doctor/Inspect cannot
/// silently add paths, arbitrary plugin messages or credentials to an archive.
pub fn summary(report: &DoctorReport) -> Value {
    let mut aliases = Targets::default();
    let plugins = data(&report.plugins).map(|plugins| plugins.iter().map(|p| json!({
        "id":p.id,"version":p.version,"source":p.source,"desiredEnabled":p.desired_enabled,"defaultEnabled":p.default_enabled,
        "grants":p.grants,"requestedPermissions":p.requested_permissions,"provides":capabilities(&p.provides),"requires":capabilities(&p.requires),"validation":check(&p.validation)
    })).collect::<Vec<_>>());
    let generations = data(&report.runtime.plugin_generations).map(|g| json!({"basis":g.basis,"complete":g.complete,"targets":g.targets.iter().map(|t| json!({
        "target":aliases.alias(&t.target_id),"sessionLive":t.session_live,"documentEpoch":t.document_epoch,
        "recoveryPending":t.recovery_pending,"scopeActive":t.scope_active,"plugins":t.plugins.iter().map(|p|json!({"id":p.id,"version":p.version,"generation":p.generation,"lifecycle":p.lifecycle,"contextPresent":p.context_present,"activationConfirmed":p.activation_confirmed,"active":p.active})).collect::<Vec<_>>()
    })).collect::<Vec<_>>()}));
    let providers = data(&report.runtime.provider_ready).map(|p| json!({"basis":p.basis,"assessment":p.assessment,"complete":p.complete,
        "providers":p.providers.iter().map(|p| json!({"id":p.id,"generation":p.generation,"kind":p.kind,"provides":capabilities(&p.provides),"capabilitiesTruncated":p.capabilities_truncated,
            "targets":p.targets.iter().map(|t| json!({"target":aliases.alias(&t.target_id),"observedGeneration":t.observed_generation,"readiness":t.readiness})).collect::<Vec<_>>()
        })).collect::<Vec<_>>()
    }));
    let sample = report.runtime.sample.as_ref().map(|s| json!({
        "hostPid":s.host_pid,"codletVersion":s.codlet_version,"hostState":s.host_state,"sequence":s.sequence,"sampledAtUnixMs":s.sampled_at_unix_ms,
        "queriedAtUnixMs":s.queried_at_unix_ms,"ageMs":s.age_ms,"freshness":s.freshness,"complete":s.complete,"lifecycleBusy":s.lifecycle_busy,
        "codex":s.codex.as_ref().map(|c|json!({"pid":c.pid,"packageVersion":c.package_version})),"hasTerminationReason":s.termination.is_some()
    }));
    let hosts = report.runtime.host_processes.as_ref().map(|h| json!({
        "basis":h.basis,"assessment":h.assessment,"freshness":h.freshness,"ageMs":h.age_ms,"states":{"starting":h.states.starting,"active":h.states.active,"stopping":h.states.stopping,"failed":h.states.failed,"exited":h.states.exited},
        "findings":h.findings.iter().map(|f|json!({"pluginId":f.plugin_id,"generation":f.generation,"code":f.code,"terminal":f.terminal})).collect::<Vec<_>>(),
        "sample":{"sequence":h.sample.sequence,"sampledAtUnixMs":h.sample.sampled_at_unix_ms,"runtimeStopping":h.sample.runtime_stopping,"ownerAlive":h.sample.owner_alive,"historyTruncated":h.sample.history_truncated,
            "plugins":h.sample.plugins.iter().map(|p|json!({"id":p.id,"version":p.version,"generation":p.generation,"state":p.state,"processId":p.process_id,"hasError":p.error.is_some(),
                "pendingCoreRequests":p.pending_core_requests,"subscriptions":p.subscriptions,"outbox":p.outbox,"launching":p.launching,
                "cleanup":{"phase":p.cleanup.phase,"remainingBudgetMs":p.cleanup.remaining_budget_ms,"pendingRequests":p.cleanup.pending_requests,"hasError":p.cleanup.error.is_some()},"exit":p.exit.as_ref().map(|e|json!({"processId":e.process_id,"exitCode":e.exit_code,"forced":e.forced,"workersReaped":e.workers_reaped}))
            })).collect::<Vec<_>>()}
    }));
    json!({"schema":"codlet.diagnostic-summary/v1","mode":"read_only",
        "checks":{"package":check(&report.package),"executable":check(&report.executable),"processes":check(&report.processes),"registry":check(&report.registry),"plugins":check(&report.plugins),"pluginValidation":check(&report.plugin_validation),"dependencyGraph":check(&report.dependency_graph)},
        "package":data(&report.package).map(|p|json!({"familyName":p.family_name,"version":p.version})),
        "processes":data(&report.processes).map(|p|json!({"launchConflict":p.launch_conflict,"matchBasis":p.match_basis,"processIds":p.matching_processes.iter().map(|p|p.process_id).collect::<Vec<_>>()})),
        "plugins":plugins,"activationOrder":data(&report.dependency_graph).map(|g| &g.activation_order),
        "runtime":{"status":report.runtime.status,"checks":{"targets":check(&report.runtime.targets),"pluginGenerations":check(&report.runtime.plugin_generations),"providerReady":check(&report.runtime.provider_ready),"compatibility":check(&report.runtime.compatibility)},
            "sample":sample,"generations":generations,"providers":providers,"hosts":hosts,
            "issueCodes":report.runtime.issues.iter().map(|i|i.code).collect::<Vec<_>>(),
            "events":report.runtime.recent_events.iter().map(|e|json!({"target":aliases.alias(&e.target_id),"code":e.code})).collect::<Vec<_>>()},
        "result":{"status":report.result.status,"exitCode":report.result.exit_code,"failedChecks":report.result.failed_checks,"launchPreflight":report.result.launch_preflight}
    })
}
