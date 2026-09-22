# Development

Use Rust from `rust-toolchain.toml`, the npm lockfile in `frontend/`, and the platform-specific Node pins in `runtime/node-runtime.json`. Build the generic SDK before Rust because Core embeds its output. Official plugins are a separate repository and are not needed to compile Core.

## Windows

```powershell
npm ci --prefix frontend
node frontend/build.mjs
cargo build --locked --bin codlet
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Install-JsRuntime.ps1 -Destination target/debug
```

Use a supported native Rust linker/toolchain. `CARGO_TARGET_DIR` changes executable paths; stage Node beside the executable actually being tested, not an assumed `target/debug` directory. Release delivery uses `cargo build --locked --release --bin codlet --no-default-features`.

## macOS Apple Silicon

```sh
sh scripts/build-macos.sh
sh scripts/test-macos.sh
```

The build stages the pinned native Node runtime and prints the executable path. Pass `release` to build the distributable Core. An official Codex installation is required for a real desktop session; CI's fake-client and native process tests do not replace that acceptance.

## Validation

Run checks appropriate to the changed behavior. The wider regression suite is:

```sh
cargo fmt --all -- --check
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked --all-targets --all-features -- --test-threads=2
node --test --test-concurrency=2 tests/*.test.mjs
```

Stage Node in both the executable directory and `debug/deps` for Host test binaries. Use the pinned Windows Node version; a different V8 build can change lifecycle/GC behavior. `test-fixtures` enables synthetic plugins only for protocol/lifecycle tests and is rejected in release builds. The official plugin repository validates its own adapters and GUI against a prepared Core SDK snapshot.

Installer-specific checks are described in [distribution](distribution.md). Keep tests that exercise real invariants, failure paths, and public contracts. Avoid making tests depend on incidental documentation filenames or dated experiment output.

`node --expose-gc scripts/profile-renderer.mjs /absolute/report.json` runs the repeatable offline renderer/RPC memory probe. It uses the actual bootstrap with an in-memory transport; it does not measure Chromium or the complete GUI.

## Independent Windows test client

`codlet-lab` and the scripts in `scripts/` coordinate a separate, explicitly marked experimental profile. `Build-IsolatedClient.ps1` requires an existing owned lab root, a built lab executable, the pinned Node runtime, a signed installed official CLI, and the expected package version. It creates local developer tooling, not a redistributable copy of Codex.

Use the generated `Start-TestClient.cmd`, `Stop-TestClient.cmd`, `Test-Plugins.ps1`, and `Export-Diagnostics.cmd`. A failed readiness check prints the coordinator state and startup/error logs. After confirming the prior owner has exited, `Start-TestClient.cmd -RecoverInterrupted` can recover an interrupted lab. Do not remove live locks or point a lab at a normal user profile.

For actual acceptance, use a normal release build, record the official package/frontend identity, and test start/stop, runtime skill, GUI/CLI management, dependencies, permission revocation, reload, safe mode, and update restart. Traffic acceptance must additionally distinguish fixture sockets, the official AppServer, and the actual desktop path.

## Repository layout and generated files

See [architecture](architecture.md) for source ownership. `frontend/build.mjs` regenerates the embedded SDK bundles and UI attribution. Do not edit generated bundles by hand. Versioned compatibility profiles and repeatable tests belong in Git; local account data, logs, heap snapshots, downloaded runtimes, and experiment reports belong outside tracked source.

After changing Rust dependencies, run `python scripts/collect-rust-licenses.py`. It collects actual locked crate notices and Rust standard-library attribution for the distributed platforms; `--check` detects stale output on the same build toolchain. Standard-library/build-host dependencies can differ across toolchains, so native packaging regenerates the notices in its own build environment. The resulting `THIRD_PARTY_RUST_LICENSES.txt` ships with both installers.

Current contracts live in `docs/spec/`; older decisions and experiments are available in Git history. Keep ongoing limitations in [known-issues](known-issues.md), rather than copying historical progress reports into each release.
