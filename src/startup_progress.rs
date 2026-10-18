//! Structured startup facts for the native launcher's progress window and CLI.
//! The launcher follows its own Core log, so no shared status file is needed.
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    schema: u8,
    process_id: u32,
    phase: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    received_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_bytes: Option<u64>,
}

pub(crate) fn stage(phase: &str) {
    runtime(phase, None, None, None, None);
}

pub(crate) fn runtime(
    phase: &str,
    version: Option<&str>,
    source: Option<&str>,
    received_bytes: Option<u64>,
    total_bytes: Option<u64>,
) {
    let value = Progress {
        schema: 1,
        process_id: std::process::id(),
        phase,
        version,
        source,
        received_bytes,
        total_bytes,
    };
    if let Ok(encoded) = serde_json::to_string(&value) {
        eprintln!("codlet-startup: {encoded}");
    }
}
