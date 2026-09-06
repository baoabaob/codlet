#![cfg(windows)]

use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use codlet::plugins::{PluginRegistry, PluginRegistryError};
use tempfile::tempdir;

const FIXTURE_TIMEOUT: Duration = Duration::from_secs(15);
const INITIAL: &str = r#"{"schema":1,"plugins":{"future.plugin":{"enabled":false}}}"#;

fn wait_for(path: &Path) {
    let started = Instant::now();
    while !path.exists() {
        assert!(
            started.elapsed() < FIXTURE_TIMEOUT,
            "timed out waiting for {}",
            path.display()
        );
        thread::sleep(Duration::from_millis(5));
    }
}

fn open_lock(registry: &Path) -> File {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(registry.with_extension("json.lock"))
        .unwrap();
    file.try_lock().unwrap();
    file
}

struct Worker {
    child: Option<Child>,
    control: PathBuf,
}

impl Worker {
    fn spawn(directory: &Path, registry: &Path, mode: &str, id: &str) -> Self {
        fs::create_dir(directory).unwrap();
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "registry_process_worker", "--nocapture"])
            .env("CODLET_TEST_REGISTRY_MODE", mode)
            .env("CODLET_TEST_REGISTRY_PATH", registry)
            .env("CODLET_TEST_REGISTRY_CONTROL", directory)
            .env("CODLET_TEST_REGISTRY_ID", id)
            .env("LOCALAPPDATA", directory)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        Self {
            child: Some(child),
            control: directory.to_owned(),
        }
    }

    fn wait_for(&self, name: &str) {
        wait_for(&self.control.join(name));
    }

    fn signal(&self, name: &str) {
        fs::write(self.control.join(name), b"ready").unwrap();
    }

    fn finish(mut self) {
        let started = Instant::now();
        while self.child.as_mut().unwrap().try_wait().unwrap().is_none() {
            assert!(
                started.elapsed() < FIXTURE_TIMEOUT,
                "registry worker did not exit"
            );
            thread::sleep(Duration::from_millis(5));
        }
        let output = self.child.take().unwrap().wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "worker failed: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            // Reap only the test executable spawned by this fixture, including on panic.
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[test]
fn processes_contend_on_one_lock_and_merge_preloaded_snapshots() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("config.json");
    fs::write(&path, INITIAL).unwrap();
    let lock = open_lock(&path);
    let first = Worker::spawn(&directory.path().join("first"), &path, "writer", "codlet");
    let second = Worker::spawn(
        &directory.path().join("second"),
        &path,
        "writer",
        "codex.ui.adapter",
    );
    first.wait_for("loaded");
    second.wait_for("loaded");

    first.signal("attempt");
    second.signal("attempt");
    // Both saves must actually observe contention and fail within the production deadline.
    // A scheduler delay or two coincidentally serialized writes cannot satisfy this barrier.
    first.wait_for("blocked");
    second.wait_for("blocked");
    assert_eq!(fs::read_to_string(&path).unwrap(), INITIAL);
    drop(lock);

    first.signal("retry");
    second.signal("retry");
    first.finish();
    second.finish();
    let registry = PluginRegistry::load(&path).unwrap();
    assert!(!registry.is_enabled("codlet"));
    assert!(!registry.is_enabled("codex.ui.adapter"));
    assert!(!registry.is_enabled("future.plugin"));
    let snapshots: Vec<[bool; 2]> = ["first", "second"]
        .into_iter()
        .map(|name| {
            serde_json::from_slice(&fs::read(directory.path().join(name).join("snapshot")).unwrap())
                .unwrap()
        })
        .collect();
    assert!(
        snapshots.contains(&[false, false]),
        "last writer must refresh its full snapshot"
    );
    assert!(!directory.path().read_dir().unwrap().any(|entry| {
        entry
            .unwrap()
            .path()
            .extension()
            .is_some_and(|extension| extension == "tmp")
    }));
}

#[test]
fn process_exit_without_destructors_releases_registry_lock() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("config.json");
    fs::write(&path, INITIAL).unwrap();
    let worker = Worker::spawn(
        &directory.path().join("owner"),
        &path,
        "exit-lock",
        "codlet",
    );
    worker.wait_for("locked");
    let mut registry = PluginRegistry::load(&path).unwrap();
    registry.set_enabled("codlet", false).unwrap();
    let started = Instant::now();
    assert!(matches!(
        registry.save(),
        Err(PluginRegistryError::Busy { .. })
    ));
    assert!(started.elapsed() < FIXTURE_TIMEOUT);
    assert_eq!(fs::read_to_string(&path).unwrap(), INITIAL);

    worker.signal("exit");
    worker.finish();
    registry.save().unwrap();
    assert!(!registry.is_enabled("codlet"));
    assert!(!registry.is_enabled("future.plugin"));
    assert!(path.with_extension("json.lock").exists());
}

#[test]
fn temporary_name_collisions_are_retried_without_removing_existing_files() {
    for mode in ["collision", "exhaustion"] {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        fs::write(&path, INITIAL).unwrap();
        Worker::spawn(&directory.path().join("worker"), &path, mode, "codlet").finish();
    }
}

// This test is also a subprocess entry point. Normal cargo test runs leave it inert.
#[test]
fn registry_process_worker() {
    let Ok(mode) = std::env::var("CODLET_TEST_REGISTRY_MODE") else {
        return;
    };
    let path = PathBuf::from(std::env::var_os("CODLET_TEST_REGISTRY_PATH").unwrap());
    let control = PathBuf::from(std::env::var_os("CODLET_TEST_REGISTRY_CONTROL").unwrap());
    let id = std::env::var("CODLET_TEST_REGISTRY_ID").unwrap();

    match mode.as_str() {
        "writer" => {
            let mut registry = PluginRegistry::load(&path).unwrap();
            registry.set_enabled(&id, false).unwrap();
            fs::write(control.join("loaded"), b"ready").unwrap();
            wait_for(&control.join("attempt"));
            let started = Instant::now();
            assert!(matches!(
                registry.save(),
                Err(PluginRegistryError::Busy { .. })
            ));
            assert!(started.elapsed() < FIXTURE_TIMEOUT);
            fs::write(control.join("blocked"), b"ready").unwrap();
            wait_for(&control.join("retry"));
            registry.save().unwrap();
            fs::write(
                control.join("snapshot"),
                serde_json::to_vec(&[
                    registry.is_enabled("codlet"),
                    registry.is_enabled("codex.ui.adapter"),
                ])
                .unwrap(),
            )
            .unwrap();
        }
        "exit-lock" => {
            let _lock = open_lock(&path);
            fs::write(control.join("locked"), b"ready").unwrap();
            wait_for(&control.join("exit"));
            std::process::exit(0);
        }
        "collision" | "exhaustion" => {
            let count = if mode == "collision" { 1 } else { 128 };
            let collisions: Vec<_> = (1..=count)
                .map(|sequence| {
                    let mut name = path.as_os_str().to_owned();
                    name.push(format!(".{}.{}.tmp", std::process::id(), sequence));
                    let name = PathBuf::from(name);
                    fs::write(&name, b"preexisting temporary").unwrap();
                    name
                })
                .collect();
            let mut registry = PluginRegistry::load(&path).unwrap();
            registry.set_enabled(&id, false).unwrap();
            let result = registry.save();
            if mode == "collision" {
                result.unwrap();
                assert!(!PluginRegistry::load(&path).unwrap().is_enabled(&id));
            } else {
                assert!(result.is_err());
                assert_eq!(fs::read_to_string(&path).unwrap(), INITIAL);
            }
            for collision in &collisions {
                assert_eq!(fs::read(collision).unwrap(), b"preexisting temporary");
            }
            assert_eq!(
                path.parent().unwrap().read_dir().unwrap().count(),
                collisions.len() + 3
            );
        }
        _ => panic!("unknown registry worker mode"),
    }
}
