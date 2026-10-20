# Development

Use Rust from `rust-toolchain.toml`, the npm lockfile in `frontend/`, and the platform-specific Node pins in `runtime/node-runtime.json`. Build the generic SDK before Rust because Core embeds its output. Official plugins are a separate repository and are not needed to compile Core.

Generated JavaScript bundles are ignored by Git. A clean checkout requires `npm ci --prefix frontend` and `node frontend/build.mjs`; the latter also generates the pinned source parser and online-update modules. Rust reports this prerequisite when generated inputs are absent. Source files and third-party license notices remain tracked.

## Windows

```powershell
npm ci --prefix frontend
node frontend/build.mjs
npm run typecheck --prefix frontend
node scripts/check-dev-storage.mjs
cargo build --locked --bin codlet
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Install-JsRuntime.ps1 -Destination target/debug
```

Use a supported native Rust linker/toolchain. `CARGO_TARGET_DIR` changes executable paths; stage Node beside the executable actually being tested, not an assumed `target/debug` directory. Release delivery uses `cargo build --locked --release --bin codlet --no-default-features`.

`scripts/Build-Core.ps1` checks the development storage budget before and after
building, including Cargo's actual target directory. When invoking Cargo directly,
run `node scripts/check-dev-storage.mjs` first; pass `--target-dir` when using a
target directory configured outside `CARGO_TARGET_DIR`.

## macOS Apple Silicon

```sh
npm ci --prefix frontend
node frontend/build.mjs
sh scripts/build-macos.sh
sh scripts/test-macos.sh
```

The build stages the pinned native Node runtime and prints the executable path. Pass `release` to build the distributable Core. An official Codex installation is required for a real desktop session; CI's fake-client and native process tests do not replace that acceptance.

## Validation

Run checks appropriate to the changed behavior. The wider regression suite is:

```sh
cargo fmt --all -- --check
node scripts/check-dev-storage.mjs
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked --all-targets --all-features -- --test-threads=2
cargo test --locked --no-default-features --features ipc-test-isolation --test core_sdk_migration -- --test-threads=2
cargo build --locked --features test-fixtures --bin codlet-traffic-fixture
node --test --test-concurrency=2 tests/*.test.mjs
```

Stage Node in both the executable directory and `debug/deps` for Host test binaries. Use the pinned Windows Node version; a different V8 build can change lifecycle/GC behavior. `test-fixtures` enables synthetic plugins and the isolated native traffic harness only for tests and is rejected when debug assertions are disabled. Windows fixture builds use separate status/control/launch IPC names, and CLI fixtures clear inherited `CODLET_HOME` before selecting temporary data. The harness uses temporary registries and in-memory credentials.

`ipc-test-isolation` retains the production Core catalog while selecting separate
Windows status/control/launch endpoints. Use it for real-catalog CLI checks when
a daily Core is running. Release builds reject this feature.

Run `node codex/test.mjs` for all maintained UI/Desktop implementation tests. The [Native diagnostic tools](../codex/scripts/README.md) and their opt-in workflows also live in Core. The plugin source repository separately validates the GUI and complete functional consumer against an explicit snapshot of Core's SDK; it no longer contains a duplicate Adapter implementation or Native toolchain.

Installer-specific checks are described in [distribution](distribution.md). Keep tests that exercise real invariants, failure paths, and public contracts. Avoid making tests depend on incidental documentation filenames or dated experiment output.

`node --expose-gc scripts/profile-renderer.mjs /absolute/report.json` runs the repeatable offline renderer/RPC memory probe. It uses the actual bootstrap with an in-memory transport; it does not measure Chromium or the complete GUI.

## Independent Windows test client

`codlet-lab` and the scripts in `scripts/` coordinate a separate, explicitly marked experimental profile. `Build-IsolatedClient.ps1` requires an existing owned lab root, a built lab executable, the pinned Node runtime, a signed installed official CLI, and the expected package version. It creates local developer tooling, not a redistributable copy of Codex.

Use the generated `Start-TestClient.cmd`, `Stop-TestClient.cmd`, `Test-Plugins.ps1`, and `Export-Diagnostics.cmd`. A failed readiness check prints the coordinator state and startup/error logs. After confirming the prior owner has exited, `Start-TestClient.cmd -RecoverInterrupted` can recover an interrupted lab. Do not remove live locks or point a lab at a normal user profile.

For actual acceptance, use a normal release build, record the official package/frontend identity, and test start/stop, runtime skill, GUI/CLI management, dependencies, permission revocation, reload, safe mode, and update restart. Traffic acceptance must additionally distinguish fixture sockets, the official AppServer, and the actual desktop path.

## Repository layout and generated files

See [repository ownership](repository-layout.md) for the three source repositories and generated distribution targets. `frontend/build.mjs` regenerates the embedded SDK bundles, Codex modules and UI attribution. Core's root frontend lockfile owns these builds; `codex/frontend/package.json` only delegates commands and preserves ESM. Do not edit generated bundles by hand. Versioned compatibility profiles and repeatable tests belong in Git; local account data, logs, heap snapshots, downloaded runtimes, and temporary reports belong outside tracked source.

After changing Rust dependencies, run `python scripts/collect-rust-licenses.py`. It collects actual locked crate notices and Rust standard-library attribution for the distributed platforms; `--check` detects stale output on the same build toolchain. Standard-library/build-host dependencies can differ across toolchains, so native packaging regenerates the notices in its own build environment. The resulting `THIRD_PARTY_RUST_LICENSES.txt` ships with both installers.

Current contracts live in `docs/spec/`, versioned delivery evidence in `docs/releases/`, and dated investigations in [docs/history](history/README.md). Original source paths and hashes are retained in the archive inventory and Git. Keep ongoing limitations in [known-issues](known-issues.md).

Keep the primary checkout on the current `main` branch after integrating work.
Temporary worktrees are for concurrent changes, not permanent alternate project
directories; preserve useful uncommitted source in Git before removing them with
`git worktree remove`. Core, `codlet-plugins` and the split workbench remain separate repositories and
can be moved together as sibling directories. Move the primary checkout, including
its `.git` directory, rather than copying a linked worktree's `.git` pointer.

Use one build-output directory per active platform/toolchain instead of one cache
for every experiment. Cargo's normal `target/` follows the checkout; alternatively,
set `CARGO_TARGET_DIR` to a single directory on the development drive. Stop build
and test processes before clearing it with `cargo clean` (or `cargo clean
--target-dir <directory>` for an explicit cache). Build output, `node_modules`, old
client copies and experiment downloads can be regenerated. Keep current source,
lockfiles and compiler installations; retain only the latest useful installers
locally. Clearing caches makes the next build slower but does not remove source.

### Development storage budget

Development builds retain line tables for source locations in backtraces. Test
builds omit debug information and symbol tables; assertion failures still identify
their source location. Both disable incremental compilation. Dependency/object caches remain
reusable; changes to Rust code may take longer to rebuild. For variable inspection
or complete symbolic test backtraces, explicitly use `--profile full-debug`, for
example `cargo build --locked --profile full-debug --bin codlet` or
`cargo test --locked --profile full-debug --test <name>`. Clear that profile with
`cargo clean --profile full-debug` after stopping its processes. Stage Node beside
that profile's executable when launching Core.

`node scripts/check-dev-storage.mjs --json` reports Rust build output, local
artifacts and available space on both volumes. The limits are 8 GiB for build
output, 4 GiB for `.codlet-artifacts`, and at least 20 GiB free on each volume.
`Build-Core.ps1`, Core Native run preparation and the fixture launch entry point
refuse to add more output when those limits are exceeded. The check counts
hardlinked files once and skips links inside each selected directory. It does not
delete files.

After an independent test has stopped, retain its reports, session JSONL and
databases; remove obsolete executable/runtime copies, temporary profile `home`
directories, downloaded plugin caches and superseded candidate packages. Keep
current installers outside the cleanup set. Clear only paths owned by the stopped
test, and never remove a live profile or an unresolved run. The budget is an
entry-point check, not a filesystem quota; direct Cargo commands and other tools
can still write past it.
