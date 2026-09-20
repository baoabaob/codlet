use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const BUNDLE_ID: &str = "com.openai.codex";
// Read from the CodeDirectory of the official 26.908.70816 ARM64 DMG.
const REQUIREMENT: &str = "=anchor apple generic and identifier \"com.openai.codex\" and certificate leaf[subject.OU] = \"2DC432GLL2\"";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Application {
    pub bundle: PathBuf,
    pub executable: PathBuf,
    pub identifier: String,
    pub version: String,
    pub build: String,
    pub minimum_macos: String,
    info_digest: String,
}

impl Application {
    pub fn discover() -> io::Result<Self> {
        let mut candidates = vec![
            PathBuf::from("/Applications/ChatGPT.app"),
            PathBuf::from("/Applications/Codex.app"),
        ];
        if let Some(home) = std::env::var_os("HOME") {
            for name in ["ChatGPT.app", "Codex.app"] {
                candidates.push(PathBuf::from(&home).join("Applications").join(name));
            }
        }
        let mut valid = Vec::new();
        let mut failures = Vec::new();
        for path in candidates.into_iter().filter(|p| p.exists()) {
            match Self::inspect(&path) {
                Ok(app) if !valid.iter().any(|v: &Self| v.bundle == app.bundle) => valid.push(app),
                Ok(_) => {}
                Err(error) => failures.push(format!("{}: {error}", path.display())),
            }
        }
        if valid.len() == 1 {
            return Ok(valid.remove(0));
        }
        Err(io::Error::other(if valid.is_empty() {
            format!(
                "No verified official Codex application found; select its .app with --app. {}",
                failures.join("; ")
            )
        } else {
            "Multiple official applications found; select one with --app".into()
        }))
    }

    pub fn inspect(path: &Path) -> io::Result<Self> {
        let bundle = path.canonicalize()?;
        if bundle.extension().and_then(|v| v.to_str()) != Some("app") {
            return Err(invalid("Expected an application bundle"));
        }
        let info = bundle.join("Contents/Info.plist");
        let mut data = Vec::new();
        std::io::Read::read_to_end(
            &mut std::io::Read::take(std::fs::File::open(&info)?, 1024 * 1024 + 1),
            &mut data,
        )?;
        if data.len() > 1024 * 1024 {
            return Err(invalid("Application metadata exceeds its limit"));
        }
        let json = super::command::output(
            Command::new("/usr/bin/plutil")
                .args(["-convert", "json", "-o", "-"])
                .arg(&info),
            Duration::from_secs(5),
        )?;
        let value: serde_json::Value = serde_json::from_slice(&json).map_err(invalid)?;
        let text = |key| {
            value
                .get(key)
                .and_then(serde_json::Value::as_str)
                .filter(|v| !v.is_empty() && v.len() < 512)
                .map(str::to_owned)
                .ok_or_else(|| invalid(format!("Missing application field {key}")))
        };
        let identifier = text("CFBundleIdentifier")?;
        if identifier != BUNDLE_ID {
            return Err(invalid(
                "This bundle is not the official Codex desktop application",
            ));
        }
        let name = text("CFBundleExecutable")?;
        if name.contains(['/', '\\', '\0']) || name == "." || name == ".." {
            return Err(invalid("Invalid application executable name"));
        }
        let executable = bundle.join("Contents/MacOS").join(&name).canonicalize()?;
        if executable.parent() != Some(bundle.join("Contents/MacOS").as_path()) {
            return Err(invalid(
                "Application executable redirected outside its bundle",
            ));
        }
        let mut file = std::fs::File::open(&executable)?;
        let mut header = [0u8; 8];
        std::io::Read::read_exact(&mut file, &mut header)?;
        if header != [0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1] {
            return Err(invalid(
                "This target requires the official ARM64 Mach-O executable",
            ));
        }
        super::command::output(
            Command::new("/usr/bin/codesign")
                .args([
                    "--verify",
                    "--deep",
                    "--strict",
                    "--test-requirement",
                    REQUIREMENT,
                ])
                .arg(&bundle),
            Duration::from_secs(30),
        )?;
        Ok(Self {
            bundle,
            executable,
            identifier,
            version: text("CFBundleShortVersionString")?,
            build: text("CFBundleVersion")?,
            minimum_macos: text("LSMinimumSystemVersion")?,
            info_digest: format!("{:x}", Sha256::digest(data)),
        })
    }

    pub(crate) fn revalidate(&self) -> io::Result<()> {
        let current = Self::inspect(&self.bundle)?;
        if current.executable != self.executable || current.info_digest != self.info_digest {
            return Err(invalid(
                "The application changed during launch preparation; retry with its current version",
            ));
        }
        Ok(())
    }

    pub(crate) fn running(&self) -> io::Result<Vec<super::identity::ProcessIdentity>> {
        let uid = unsafe { libc::geteuid() };
        let mut bundles = std::collections::BTreeMap::<PathBuf, bool>::new();
        bundles.insert(self.bundle.clone(), true);
        let mut running = Vec::new();
        for process in super::identity::process_ids()?
            .into_iter()
            .filter_map(|pid| super::identity::ProcessIdentity::inspect(pid).ok())
            .filter(|p| p.uid == uid)
        {
            if process.executable.starts_with(self.bundle.join("Contents")) {
                running.push(process);
                continue;
            }
            // A second installed copy can use the same application profile. A
            // name only narrows inspection; the bundle identifier decides a match.
            let candidate = process
                .executable
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| {
                    n.starts_with("Codex")
                        || n.starts_with("ChatGPT")
                        || Some(std::ffi::OsStr::new(n)) == self.executable.file_name()
                });
            if !candidate {
                continue;
            }
            let mut matched = false;
            for bundle in process
                .executable
                .ancestors()
                .filter(|p| p.extension().is_some_and(|e| e == "app"))
            {
                let is_codex = if let Some(cached) = bundles.get(bundle) {
                    *cached
                } else {
                    let info = bundle.join("Contents/Info.plist");
                    let value = super::command::output(
                        Command::new("/usr/bin/plutil")
                            .args(["-extract", "CFBundleIdentifier", "raw", "-o", "-"])
                            .arg(info),
                        Duration::from_secs(2),
                    )?;
                    let matches = String::from_utf8_lossy(&value).trim() == BUNDLE_ID;
                    bundles.insert(bundle.to_owned(), matches);
                    matches
                };
                if is_codex {
                    matched = true;
                    break;
                }
            }
            if matched {
                running.push(process);
            }
        }
        Ok(running)
    }
}
fn invalid(message: impl std::fmt::Display) -> io::Error {
    io::Error::other(message.to_string())
}
