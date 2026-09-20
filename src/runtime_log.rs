//! Bounded local operational logs. Never subscribes to CDP payloads or conversations.
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const MAX_BYTES: u64 = 1024 * 1024;
const MAX_MESSAGE: usize = 8 * 1024;
static LOG: OnceLock<Mutex<PathBuf>> = OnceLock::new();

pub fn directory(registry: &Path) -> io::Result<PathBuf> {
    registry
        .parent()
        .filter(|path| path.is_absolute())
        .map(|path| path.join("logs"))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Registry has no absolute parent",
            )
        })
}

/// Only launch owners initialize logging. Doctor and diagnostic exports stay read-only.
pub fn initialize(registry: &Path) {
    let result = directory(registry).and_then(|path| {
        fs::create_dir_all(&path)?;
        append(&path, "info", "runtime_started", "Codlet runtime starting")?;
        let _ = LOG.set(Mutex::new(path));
        Ok(())
    });
    if let Err(error) = result {
        eprintln!("codlet-log: {error}");
    }
}

pub fn error(code: &str, message: &str) {
    let Some(log) = LOG.get() else {
        return;
    };
    let path = log.lock().unwrap_or_else(|error| error.into_inner());
    if let Err(error) = append(&path, "error", code, message) {
        eprintln!("codlet-log: {error}");
    }
}

fn regular_or_missing(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(io::Error::other("Log path is not a regular file")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn append(directory: &Path, level: &str, code: &str, message: &str) -> io::Result<()> {
    let path = directory.join("runtime.jsonl");
    regular_or_missing(&path)?;
    if fs::metadata(&path).is_ok_and(|metadata| metadata.len() >= MAX_BYTES) {
        let older = directory.join("runtime.2.jsonl");
        let recent = directory.join("runtime.1.jsonl");
        regular_or_missing(&older)?;
        regular_or_missing(&recent)?;
        if older.exists() {
            fs::remove_file(&older)?;
        }
        if recent.exists() {
            fs::rename(&recent, &older)?;
        }
        fs::rename(&path, &recent)?;
    }
    let truncate = |text: &str| text.chars().take(MAX_MESSAGE).collect::<String>();
    let record = serde_json::json!({
        "timeUnixMs": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
        "level":level, "code":truncate(code), "message":truncate(message),
        "codletVersion":env!("CARGO_PKG_VERSION"), "pid":std::process::id()
    });
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    serde_json::to_writer(&mut file, &record)?;
    file.write_all(b"\n")?;
    file.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn logs_rotate_and_escape_multiline_errors_without_changing_registry() {
        let temp = tempfile::tempdir().unwrap();
        let registry = temp.path().join("config.json");
        fs::write(&registry, "preserve me").unwrap();
        let logs = directory(&registry).unwrap();
        fs::create_dir(&logs).unwrap();
        for _ in 0..4 {
            fs::write(logs.join("runtime.jsonl"), vec![b'x'; MAX_BYTES as usize]).unwrap();
            append(&logs, "error", "plugin_failure", "first\nsecond").unwrap();
        }
        assert_eq!(fs::read_dir(&logs).unwrap().count(), 3);
        let text = fs::read_to_string(logs.join("runtime.jsonl")).unwrap();
        assert_eq!(text.lines().count(), 1);
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["message"], "first\nsecond");
        assert_eq!(fs::read_to_string(registry).unwrap(), "preserve me");
    }
}
