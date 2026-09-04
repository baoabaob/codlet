# Codlet

Codlet is a Windows-first launcher and lightweight extension runtime for Codex Desktop. The current code contains the M0 inherited-CDP transport, an M1b capability-kernel candidate, the first M1c renderer authorization slice, and a persistent bundled-plugin enablement registry described in `docs/PRODUCT_TECHNICAL_PLAN.md`. On 2026-09-01, the installed Codex build `26.825.6671.0` passed the real inherited-pipe and continuous multi-window target gates. This records build coverage for those runs, not a permanent compatibility guarantee; the complete repetition gates and the current-build M1 GUI gate have not passed yet.

It does not modify the Codex package, official shortcuts, protocols, configuration, or user data. It never terminates or restarts an existing Codex process. Normal Codex launches do not run Codlet.

## M0 commands

Launch the current renderer-runtime candidate with the bundled first-party `codlet` GUI plugin:

```powershell
codlet launch
```

Each matching Codex renderer receives one isolated world per enabled plugin and generation, named `codlet.plugin.<id>.g<generation>`. The bundled plugin mounts a compact `Codlet` button at the start of the app-shell header surface and opens an unframed management panel. New BrowserWindows and renderer navigations receive the same generation automatically. The panel can persistently disable its own GUI plugin; the host confirms the registry write before attempting the reply, then unloads that plugin from every attached renderer. A reply lost to renderer teardown is diagnostic rather than fatal because the persisted action remains authoritative. This candidate does not yet include external plugin directories, hot reload, or live Runtime Host control IPC for separate CLI processes.

Inspect or change the persistent enablement state for bundled plugins without launching or attaching to Codex:

```powershell
codlet plugin list
codlet plugin disable codlet
codlet plugin enable codlet
```

The registry is stored at `%LOCALAPPDATA%\Codlet\config.json` with atomic replacement. `list` does not create the file. Until Runtime Host control IPC is implemented, CLI enable and disable changes apply to the next `codlet launch`; the command reports that limitation explicitly. The in-Codex GUI uses the authenticated `codlet.runtime.manage@1` endpoint, so its own disable switch takes effect immediately. Re-enable it with the CLI and launch Codlet again.

Run the automated checks on Windows:

```powershell
cargo fmt --all -- --check
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked --all-targets --all-features
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-M0Acceptance.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-M0Acceptance.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-M0CrashAcceptance.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-M0CrashAcceptance.ps1
```

The PowerShell tests use explicitly marked data fixtures. They validate path handling, conflict refusal, process-identity evidence, and report schemas without discovering, launching, or controlling a real Codex process.

Inspect the installed package and report any running process from the Codex package without launching anything:

```powershell
cargo run --locked --bin codlet -- doctor
```

The reproducible external M0 acceptance entry takes an existing `codlet.exe` by explicit path. Run this one command from the repository root only after manually closing every ChatGPT/Codex window:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-M0Acceptance.ps1 -CodletPath "C:\absolute\path\to\codlet.exe"
```

The script first takes a read-only snapshot of exact `ChatGPT.exe` and `Codex.exe` processes. If either exists, it fails explicitly without invoking Codlet or modifying any process. Otherwise it invokes `codlet.exe m0-runtime --launch-codex` exactly once and shows its output live. When Codlet emits the exact active-runtime protocol line, the script takes one active snapshot while the inherited pipes are held; after Codlet returns, it takes the final snapshot. It never terminates a process, retries, starts the official entry, changes Codex configuration, or monitors later launches.

While the runtime is active, each newly attached BrowserWindow prints one live `renderer-bootstrap: target-id=...; marker-inserted=true; marker-removed=true` line. This is the manual M0 signal for the "open in new window" path. Duplicate target events do not print another line, and the diagnostic is intentionally outside the persisted report allowlist.

Each attempt writes one machine-readable `codlet.m0-acceptance/v1` JSON report under `.codlet-artifacts/m0-acceptance/`. The report records UTC start/end times; the Codlet path, fixed arguments, invocation state and exit code; the launched PID plus active/stopped protocol observations; allowlisted M0 stdout plus an omitted-line count; preflight conflicts; `before` / `active` / `after` related-process snapshots; TCP listening endpoints owned by those snapshot processes; and the script result. The active snapshot must contain the exact launched Codex PID. All Codlet output is still shown live, but stderr and stdout outside the fixed M0 report grammar are not persisted. The report does not collect process command lines, page content, CDP pipe handles, or secrets. A failed capture is represented by `captureError` and `null` snapshot data rather than invented evidence.

The report always leaves `runtime_visible_and_usable`, `user_closed_codex_normally`, `official_entry_zero_behavior`, and `runtime_crash_contract` at `pending_manual_confirmation`, with `m0Decision: not_determined`. Script exit `0` therefore means only that this one Codlet command returned `0`, emitted its launched/active/stopped protocol, produced all three phase snapshots, bound the active snapshot to the launched PID, and left no new related process in the after snapshot; it does not mean M0 passed. Evidence mismatches are reported without terminating the remaining process. Exit `2` is a preflight conflict, `64` is argument validation, `70` is snapshot/report/evidence infrastructure failure, and any other nonzero command result preserves Codlet's exit code when possible.

The forced Runtime Host crash gate has a separate, explicitly destructive acceptance entry. Run it only after manually closing every ChatGPT/Codex window and any Codlet process:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-M0CrashAcceptance.ps1 -CodletPath "C:\absolute\path\to\codlet.exe" -ConfirmRuntimeCrash
```

This harness refuses to start if any exact `ChatGPT.exe`, `Codex.exe`, or `codlet.exe` process already exists. It starts the supplied Runtime Host, waits for the exact active protocol, records the Runtime Host and launched Codex identities using PID, parent PID, executable path, and start time, opens both process handles, and verifies those identities again immediately before the action. It records that both processes are still alive, then force-terminates only the Runtime Host process object that it created. It never calls a termination API for Codex. The exact Codex handle and the residual-process scan share one 15-second deadline. A failure leaves any surviving Codex process untouched for manual inspection and closure.

Each attempt writes one `codlet.m0-crash-acceptance/v1` report under `.codlet-artifacts/m0-crash-acceptance/`. Exit `0` means the desired no-residual-process contract passed for that attempt; `1` means the contract evidence failed, `2` is a preflight conflict, `64` is validation, and `70` is infrastructure or identity refusal. The report still records `m0Decision: not_determined`. The 2026-09-01 report for build `26.825.6671.0` correctly failed because the exact launched root `ChatGPT.exe` remained alive: Electron pipe disconnect requests cooperative quit, but does not guarantee process exit. Codlet does not paper over this result with process termination.

The one-shot transport smoke probe remains available:

```powershell
cargo run --locked --bin codlet -- m0-probe --launch-codex
```

This is not a production launcher. Completing the smoke probe closes its remote-debugging pipe. Electron binds that disconnect to a cooperative application-quit request; the Codex instance may remain alive, especially as a Windows tray process, and Codlet calls no process-termination API.

The equivalent ignored integration gate additionally requires explicit authorization. It must only be run after the user has deliberately closed every Codex window and confirmed that launching a fresh Codex instance is acceptable:

```powershell
$env:CODLET_RUN_REAL_CODEX_GATE = "1"
try {
    cargo test --locked --test real_codex_gate installed_codex_accepts_inherited_cdp_pipe -- --ignored --exact --nocapture
} finally {
    Remove-Item Env:CODLET_RUN_REAL_CODEX_GATE
}
```

Do not run that command merely to exercise CI. Use the normal acceptance script for the foreground lifecycle and the dedicated crash acceptance script for the explicitly authorized Runtime Host failure gate. Repeated launches, aggregate success rate, orphan checks across repetitions, and interpretation of the active TCP-listener snapshot remain external M0 gates.

## Scope

The current candidate covers NUL framing, blocking request/event routing, EOF teardown, exact Windows handle inheritance, current-user package discovery, conflict detection, continuous multi-target discovery for every matching BrowserWindow in one Electron root, per-plugin isolated renderer worlds, structured capability manifests, deterministic provider/consumer ordering, opaque generation- and scope-bound capability principals, target-destruction revocation before same-ID reattachment, generation-aware activate/deactivate, navigation persistence, the bundled first-party `codlet` GUI, the renderer binding/RPC bridge, and a strict persistent enablement registry for bundled plugins. Principal and lease validation is the Core authorization gate: provider identity and registration/scope epochs are not exposed, and stale consumer/provider generations, revoked target scopes, wrong sessions, duplicate or out-of-order request IDs, and unknown bindings are rejected before a renderer endpoint action runs. The bridge includes a fixed, side-effect-free `codlet.runtime.ping@1` endpoint and the first authenticated management transaction, `codlet.runtime.manage@1` list/disableSelf. The latter requires the `runtime.manage` grant, persists before acknowledging, and only then revokes and unloads the caller across active targets; fake-CDP verifies the normal ordering plus cleanup and response-delivery fault isolation. This is not the full L3 broker: file, process, network, and system capabilities are not implemented. A detached runtime process and launcher/runtime IPC are deferred. External plugin loading, file watching, hot reload, separate-process live CLI control, host processes, permission consent UI, SDK, and marketplace remain outside the current slice. Renderer activation also still starts the GUI's initial RPC asynchronously; a true ready handshake requires activation-time event pumping and remains open.
