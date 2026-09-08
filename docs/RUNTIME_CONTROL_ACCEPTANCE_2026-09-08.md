# Runtime Control Isolated Acceptance — 2026-09-08

> Scope: manual lifecycle control through the experimental isolated-client lab. The run used source commit `5a0be1e` and the audited official package `26.901.6511.0`. The manual control sequence completed; watcher execution was outside this lab run. The separate final repository validation is recorded below.

The manual-run evidence consists of the five artifacts listed below. The lab keeps `gui_mount_verified=false`: lifecycle records and the separate visual checks do not represent an automated DOM-mount assertion.

## Evidence set

| Evidence | Use |
| --- | --- |
| [`build.json`](../.codlet-artifacts/runtime-control-2026-09-08/build.json) | Source commit, captured build hashes, and lab binary identity. |
| [`backend-probe.json`](../.codlet-artifacts/runtime-control-2026-09-08/backend-probe.json) | Dedicated backend initialization, authentication, file credential store, read-only readiness, and rejected foreign origin. |
| [`backend-identity.json`](../.codlet-artifacts/runtime-control-2026-09-08/backend-identity.json) | Owned backend PID, executable identity, and loopback listener. |
| [`result.json`](../.codlet-artifacts/runtime-control-2026-09-08/result.json) | Final process, port, exit, generation, and control outcome checks. |
| [`lab-report.jsonl`](../.codlet-artifacts/runtime-control-2026-09-08/lab-report.jsonl) | Startup, target, stdin control, lifecycle result, and shutdown events. |

The backend probe passed: the dedicated loopback backend initialized and authenticated, used the file credential store, reported Windows readiness `ready`, and rejected a foreign origin with HTTP 403. The coordinator independently owned that backend lifecycle; the lab owned only its new Desktop child and inherited CDP connection.

## Startup and initial state

The lab emitted `startup_verified` after **3312 ms**. The initial renderer snapshot had two bundled plugins on generation 1:

- `codex.ui.adapter` — active, activation confirmed;
- `codlet` — active, activation confirmed.

The first additional target snapshot showed the same generation on the second eligible renderer target. Later snapshots reached three eligible CDP targets. The final artifact records **two visible windows** and `rendererTargetCount: 3`; the target count is not a claim that three visible windows existed.

## Manual control sequence

The fixed stdin commands used the lab owner and the bundled plugin ids. Results were observed in the following order:

1. `plugin disable codex.ui.adapter` was correctly rejected with `dependency_conflict` because `codlet` was still an enabled/running dependent. No lifecycle generation was changed.
2. `plugin reload codex.ui.adapter` applied to the adapter and its dependent GUI. Both reached generation 2, with no target failures.
3. A second visible window was created. The Host then reported three eligible CDP targets; the run still counted two visible windows.
4. `plugin disable codlet` applied. The Host cleared the GUI from all three eligible targets, and the second window's visible entry was removed; the first window was obscured at this point, so there was no complete visual evidence for that window in this step. `codex.ui.adapter` remained active at generation 2.
5. `plugin enable codlet` applied at generation 3. The adapter remained at generation 2. The result artifact records the re-enable/list check as verified.
6. After generation 3, a GUI self-disable confirmation removed the entry from the fully observed first window; this was the complete-window visual confirmation of self-disable. The result artifact records `guiSelfDisableVerified: true`.
7. Two consecutive stdin lines were handled serially: enabling `codlet` produced generation 4, then reloading `codex.ui.adapter` produced adapter generation 3 and GUI generation 5. Both operations applied with empty `target_failures`; unrelated runtime state was retained.

After the recovery and re-enable sequence, the second window showed the GUI panel with an active plugin list and working toggle. The first window had also opened the list during the earlier re-enable stage. These are manual GUI observations accompanying the lifecycle records; the lab report continues to mark `gui_mount_verified=false`.

## Shutdown and identity checks

The fixed quit path completed in **1218 ms**. The Desktop and Host both exited with code 0, CDP workers were reaped, and the owned-process count after cleanup was zero. The listener on port 54718 was gone. The coordinator stopped its own backend through the retained console with Ctrl+C; its wrapper returned 1 as an intentional stop result.

The two original process identities, PIDs 13460 and 27176, were unchanged. The result records two tested visible windows, final generations `codex.ui.adapter: 3` and `codlet: 5`, `guiSelfDisableVerified: true`, and `guiReenableAndListVerified: true`.

## Scope and acceptance boundary

This run used the lab's fixed stdin path and the same `RendererRuntime.manage_plugin` owner as the isolated renderer. It did **not** open the production runtime control named pipe. The production pipe's SID/image/scope behavior remains covered by native fixtures; it was not re-tested through this lab. The run also did not test a file watcher or an explicit `codlet launch --watch` mode.

The production M0/M1 gates remain open, as do `DEFECT-001` and `DEFECT-002`. The run demonstrates manual lifecycle behavior and manual GUI observations in the audited isolated client; it is not an acceptance of ordinary production launch or the production GUI.

The GUI exit prompt displayed the old `then start Codlet again` sentence during observation. That obsolete wording was removed afterward and included in the final Node regression batch.

## Verification status

The isolated manual-control automation historically reported **277 Rust tests passed**: the earlier 276-test batch plus one authorization regression. The related recheck covered **44/44** cases, Clippy passed, and **63 Node tests** passed. These numbers describe the isolated-control batch, not the final repository suite.

## Final repository validation

The separate final validation passed `cargo test --locked --all-targets --all-features`
with **289 Rust tests passed** and one explicit real-production-start gate left
default-ignored. `node --test tests/*.test.mjs` passed **63 tests**; Clippy,
fmt, diffcheck, and `cargo build --locked --release --bins` passed. The watcher
source and safety/UI cleanup are in commit `851395a`; its 12 regressions covered
7 clock/file-state cases, 1 execution-path guard, 1 dual-target end-to-end case,
2 parser/scheduling cases, and 1 registry-limit case. The final summary is
[`verification.json`](../.codlet-artifacts/runtime-watch-2026-09-08/verification.json).

This repository result is distinct from the `5a0be1e` isolated manual-control
run. It does not close ordinary production launch, production GUI,
`codlet launch --watch`, M0/M1, `DEFECT-001`, or `DEFECT-002` acceptance.

Cross-reference the [runtime control contract](RUNTIME_CONTROL.md) for the CLI, receipt, lifecycle, and authenticated production IPC semantics, and the [isolated-client harness contract](ISOLATED_CLIENT_TESTING.md) for the lab's fixed stdin boundaries.
