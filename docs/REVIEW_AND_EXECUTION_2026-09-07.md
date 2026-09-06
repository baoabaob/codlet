# Codlet review and execution plan

Review date: 2026-09-07. Baseline: `35c9b74`.

## Findings

| Priority | Finding at the baseline | Consequence | Execution task |
| --- | --- | --- | --- |
| P1 | `src/renderer.rs` pumps binding events during activation, but provider invocation and deactivation still block in synchronous evaluation. `deactivate_target` revokes the scope and removes the session before cleanup. | Awaited cleanup or a provider's nested RPC cannot complete its normal round trip. Timeout replaces successful cleanup and delays the host. | Lifecycle and nested RPC |
| P1 | `src/plugins.rs` saves the entire document captured by `load`, including when the long-lived GUI saves a clone. Atomic replacement does not serialize read-modify-write transactions. | Two writers changing different plugin IDs can silently undo each other's persisted preferences. | Registry transactions |
| P1 | Ordinary response-delivery failures escape `route_binding_call`, then propagate through `pump_bindings()?` in `src/probe.rs`. Only committed management actions have special isolation. | A disappearing renderer can end the Runtime Host and close the inherited CDP transport for every window. | Lifecycle and nested RPC |
| P2 | Provider results deserialize `value` as `Option<Value>`, collapsing a present JSON `null` and an absent field. | An endpoint's valid `null` response is reported as a provider error. | Lifecycle and nested RPC |

All four findings are fixed in the integrated batch below. Diagnosis also gained an
independent static report so environment failures no longer hide registry errors.

The existing capability principal/lease epochs, strict session routing, deterministic
dependency graph, and separation of the UI adapter from the GUI are useful foundations.
The review does not justify replacing the Rust kernel, adding an async framework, or
reorganizing modules solely because their embedded tests make the files long.

## Current execution

All three executors use `gpt-6-astra` with `xhigh` reasoning. The coordinator owns
cross-task review, integration, documentation, and the combined verification gate.

| Task | Location and ownership | Acceptance | Status |
| --- | --- | --- | --- |
| Lifecycle and nested RPC (`01a077b5-d26c-72c0-bb71-a22da61d5f80`) | Separate worktree; renderer, CDP request wait, bootstrap, fake child and associated tests | Held outer responses prove nested RPC progress; bounded depth and inherited absolute deadlines; active/deactivating/destroyed states retain correct authorization; ordinary response failure remains local | Reviewed and integrated as `413797b` from `c849cbc` |
| Registry transactions (`01a077b6-74c1-7f03-95d7-6b7f41b7c027`) | Separate worktree; plugin registry and its dedicated tests | Stale snapshots merge only intended changes; cross-process mutual exclusion; bounded contention; crash releases the lock; corrupt state and failed writes stay explicit | Reviewed and integrated as `1c2c85a` from `97bfcd4` |
| Read-only diagnostics (`01a077bf-acc0-7c32-b502-76a8fe66c9c9`) | Main checkout; diagnostic model, CLI entry and dedicated tests | Versioned `doctor --json`; independent environment/configuration checks; dependency validation; actionable errors; runtime state marked unprobed; no registry creation | Reviewed and integrated as `c47f6dd` |

Each executor committed only its owned files. The coordinator reviewed each commit,
integrated the worktree changes, and replaced the diagnostic copy of the built-in
Host provider declarations with the runtime's existing crate-local definitions.
Unrelated files, including the pre-existing untracked `in`, are outside these
commits. No remote push or release is part of this batch.

## Verification

Baseline evidence on this machine:

- Rust: 86 unit tests, 27 fake-child integration tests, and 2 plugin CLI tests passed.
- JavaScript: all 12 bootstrap tests passed.
- Windows PowerShell: M0 acceptance data-fixture tests passed.
- PowerShell 7: crash-acceptance data-fixture tests passed.
- The real Codex gate remained ignored. No real process was launched or attached.

Final combined verification passed after all three implementations and the shared
declaration integration:

| Check | Result |
| --- | --- |
| `cargo fmt --all -- --check` | Passed |
| `cargo clippy --locked --all-targets --all-features -- -D warnings` | Passed |
| `cargo test --locked --all-targets --all-features` | 148 passed: 94 unit, 32 fake child, 13 doctor, 5 plugin CLI, 4 registry; 1 real Codex gate ignored |
| `node --test tests/bootstrap.test.mjs` | 18 passed |
| `scripts/Test-M0Acceptance.ps1` | Passed under Windows PowerShell 5.1 and PowerShell 7 |
| `scripts/Test-M0CrashAcceptance.ps1` | Passed under Windows PowerShell 5.1 and PowerShell 7; data fixtures only |
| `codlet doctor --json` on the installed package | Exit 0, `codlet.doctor/v1`, build `26.901.6511.0`, registry and dependency graph `ok`, future launch `blocked` by existing Codex, runtime `not_probed` |
| `git diff --check` | Passed |

Regressions include deliberately blocked outer CDP responses, independent registry
writers, lock-owner process exit, failed persistence, deferred replacement cleanup,
ordinary response rejection, and target destruction during each lifecycle phase.

The repository pins Rust 1.97.1. This machine needed a local toolchain restored and an
ASCII build-output directory for GNU linking. This is a build-environment detail,
not a reason to rename the source directory or alter the repository's pinned version.

The coordinator's local test invocation used the following environment. These paths
refer to this machine's isolated cache; CI continues to use its normal Windows
toolchain. No global PATH, default toolchain, or project toolchain pin was changed.

```powershell
$codletTools = "$env:USERPROFILE/.cache/codlet-toolchain"
$env:CARGO_HOME = "$codletTools/cargo"
$env:RUSTUP_HOME = "$codletTools/rustup"
$env:CARGO_TARGET_DIR = "$codletTools/targets/main"
$env:RUSTFLAGS = '-C link-self-contained=yes -C linker=rust-lld'
$env:Path = "$codletTools/rustup/toolchains/1.97.1-x86_64-pc-windows-gnu/lib/rustlib/x86_64-pc-windows-gnu/bin;$codletTools/w64devkit/bin;$env:Path"
& "$codletTools/cargo/bin/cargo.exe" test --locked --all-targets --all-features
```

## Next development sequence

1. Add explicitly trusted local plugin directory loading with strict manifest and
   entry-path validation. Reuse the same registry and capability graph as bundled
   plugins; keep permission grants explicit.
2. Add session-scoped Runtime Host control IPC, then connect CLI enable, disable,
   reload, and status to the same authenticated management transactions as the GUI.
3. Add file-watch reload after manual reload has a tested generation replacement,
   reverse dependency teardown, rollback, and diagnostics contract.
4. Re-run the current-build GUI, navigation, DOM rebuild, multi-window, and normal
   exit gates in a deliberately started Codlet session before closing M1.

External plugin loading and IPC depend on the first batch and should not be started
concurrently in the same lifecycle files. L2/L3/L4 expansion remains behind the
existing product gates; backend research does not justify a second App Server.

## Open product gates

`DEFECT-001` (Electron's single root instance) and `DEFECT-002` (a Runtime Host crash
may leave Codex running) remain open. Automated fixture success does not close M0
or M1 and does not establish compatibility with a newer Desktop build. The current
working Codex session is not a test target for this development batch.

The host's deadline limits waiting, not arbitrary JavaScript execution. It cannot
forcibly preempt an already-running plugin or promise rollback of irreversible
side effects. A genuinely blocked pipe write still follows the transport's existing
connection-close contract. Neither limitation is presented as a passed runtime gate.
