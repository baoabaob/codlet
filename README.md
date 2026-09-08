# Codlet

Codlet is a Windows-first launcher and lightweight extension runtime for Codex Desktop. The current code contains the M0 inherited-CDP transport, an M1b capability-kernel candidate, the first M1c renderer authorization slice, and a persistent bundled/local plugin registry described in `docs/PRODUCT_TECHNICAL_PLAN.md`. On 2026-09-01, the installed Codex build `26.825.6671.0` passed the real inherited-pipe and continuous multi-window target gates. This records build coverage for those runs, not a permanent compatibility guarantee; the complete repetition gates and the current-build M1 GUI gate have not passed yet.

It does not modify the Codex package, official shortcuts, protocols, configuration, or user data. It never terminates or restarts an existing Codex process. Normal Codex launches do not run Codlet.

## Development status

The 2026-09-07 review added bounded nested renderer RPC and deactivation, merged concurrent registry edits under a process lock, and introduced versioned read-only diagnostics. See [the review and execution plan](docs/REVIEW_AND_EXECUTION_2026-09-07.md) for evidence, ownership, and the next development sequence. Read-only package discovery found build `26.901.6511.0`; its real M1 gate remains open.

The authorized [isolated-client follow-up](docs/ISOLATED_CLIENT_REPAIR_2026-09-08.md) fixed the initial Shell timeout and resident-client shutdown failures. Two fresh Dev/WebSocket runs passed automatic startup checks in about 1.9 seconds, activated both bundled renderer plugins, and exited normally in about one second. The [experimental lab harness](docs/ISOLATED_CLIENT_TESTING.md) prepares the official package's Node runtime files in its own fresh cache and checks startup before loading plugins. Those runs did not exercise login or live GUI interactions; ordinary `codlet launch` keeps its conflict refusal.

The subsequent [manual-login GUI acceptance](docs/GUI_ACCEPTANCE_2026-09-08.md) did not pass. The Windows setup loop cleared after restarting only the test backend to reload its configuration. Codlet appeared after Help and its dialog opened and closed, but the plugin list remained loading and the entry disappeared after a native window reload. Renderer context recovery and bounded RPC failure are the next blockers; production M0/M1 gates remain open.

Trusted local renderer directories now use the same launch catalog, capability graph, management list, and diagnostics as bundled plugins. See [local plugin registration and authoring](docs/LOCAL_PLUGINS.md) for the trust, permissions, path, and recovery contracts.

## M0 commands

Launch the current renderer-runtime candidate with the bundled first-party `codlet` GUI plugin:

```powershell
codlet launch
```

Each matching Codex renderer receives one isolated world per enabled plugin and generation, named `codlet.plugin.<id>.g<generation>`. The bundled GUI adds a plain `Codlet` entry immediately after Help in the current build's application menu row. It opens a settings dialog using the client's observed 600px wide variant, native setting-row proportions and 32x20px switches; confirmation uses the 420px compact variant. The adapter owns the observed menu selectors and native theme mappings; the GUI consumes scoped aliases and uses the browser's modal dialog primitive. An explicitly identified legacy header remains the only fallback. See [the installed-build adapter evidence](docs/CODEX_UI_ADAPTER_EVIDENCE.md) for structural requirements and limits.

New BrowserWindows and renderer navigations receive the same generation automatically. Initial activation is not reported active until the plugin's ready promise completes; Host and renderer-provider RPC remain routable through the authenticated binding while that promise is pending. The panel can persistently disable its own GUI plugin after an inline confirmation; the host confirms the registry write before attempting the reply, then unloads that plugin from every attached renderer. A reply lost to renderer teardown is diagnostic rather than fatal because the persisted action remains authoritative. Explicitly trusted local directories are loaded on a new launch.

The entry tolerates a late or rebuilt toolbar. Plugin lists load when the dialog opens and can be refreshed after errors. Escape is handled inside the GUI, and close/unload retires pending work and restores focus. [Open the standalone GUI preview](scripts/preview-codlet-gui.html) to inspect the actual GUI source with simulated toolbar, theme and RPC inputs. It opens the management surface first and keeps test controls folded; it needs no server. The current-build live GUI gate and desktop/narrow-window screenshot verification remain open; the in-app browser's URL policy rejected the local preview URL.

The next adapter layer is planned in [native UI capabilities](docs/UI_ADAPTER_CAPABILITIES.md): host slots, semantic appearance roles and local control interactions have separate ownership. Matching colors alone is not native-style acceptance, and a reusable component library is not implemented yet.

Query a running Codlet Host from another terminal using the same executable:

```powershell
codlet status
codlet status --json
```

The versioned, read-only response distinguishes a missing Host from a busy pipe, timeout, incompatible protocol or untrusted server. It includes sampled Host/child identity and target/plugin lifecycle, not configuration enablement. A context recreated by navigation remains explicitly unconfirmed until a future readiness handshake exists. The local pipe is restricted to the current user and verifies the server executable path; another build directory is conservatively rejected. See [the runtime status contract](docs/RUNTIME_STATUS.md). Live CLI enable/disable/reload, file watching and detached launch remain future work.

Inspect or change plugin registrations and enablement without launching or attaching to Codex:

```powershell
codlet plugin list
codlet plugin disable codlet
codlet plugin enable codlet
codlet plugin add .\examples\local-echo
codlet plugin add .\examples\local-echo --trust
codlet plugin remove dev.example.local-echo
```

`add` without `--trust` only inspects the directory and exits nonzero without registering it. Plugins that request permissions additionally need explicit `--grant ui.dom` and/or `--grant runtime.manage`. The example needs no extra grants. Removal preserves its files. Registration/grant changes keep existing enablement preferences and apply to the next launch. Schema 1 configurations remain readable; explicit saves migrate to schema 2 with the new `localPlugins` map.

The registry is stored at `%LOCALAPPDATA%\Codlet\config.json` with atomic replacement. `list` does not create the file. The new status IPC is read-only: CLI enable and disable changes still apply to the next `codlet launch`, and the command reports that limitation explicitly. The in-Codex GUI uses the authenticated `codlet.runtime.manage@1` endpoint, so its own disable switch takes effect immediately. Re-enable it with the CLI and launch Codlet again.

Writers serialize on `config.json.lock`, re-read the latest valid document, and merge only their explicit edits. Different plugin enablement edits are preserved; the last committed enablement assignment to the same plugin wins. Local registrations and grants additionally compare the original record under that lock, so concurrent changes fail instead of replacing another writer's authorization. A busy lock returns an error after two seconds. The sidecar remains on disk, while its OS lock is released when the writer closes the handle or exits. Successful saves refresh the in-memory snapshot; failed saves preserve pending edits for an explicit retry.

Run the automated checks on Windows:

```powershell
cargo fmt --all -- --check
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked --all-targets --all-features
node --test tests/bootstrap.test.mjs tests/codlet_gui.test.mjs tests/codex_ui_adapter.test.mjs tests/local-example.test.mjs tests/lab_quit.test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-M0Acceptance.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-M0Acceptance.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-M0CrashAcceptance.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-M0CrashAcceptance.ps1
```

The PowerShell tests use explicitly marked data fixtures. They validate path handling, conflict refusal, process-identity evidence, and report schemas without discovering, launching, or controlling a real Codex process.

Inspect the installed package and report any running process from the Codex package without launching anything:

```powershell
cargo run --locked --bin codlet -- doctor
cargo run --locked --bin codlet -- doctor --json
```

`doctor --json` emits one `codlet.doctor/v1` report. Package, executable, process snapshot, registry, catalog, and dependency checks retain their own results, so a package failure does not hide a configuration error. Plugin `desiredEnabled` and capability declarations describe the next launch; runtime targets, generations, provider readiness, and compatibility remain explicitly unprobed. Check failures return exit code `1`. An existing Codex instance blocks a later launch but does not itself fail read-only doctor. Neither output mode creates registry state or attaches to Codex.

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

The current candidate covers NUL framing, blocking request/event routing, EOF teardown, exact Windows handle inheritance, current-user package discovery, conflict detection, continuous multi-target discovery for every matching BrowserWindow in one Electron root, per-plugin isolated renderer worlds, structured capability manifests, deterministic provider/consumer ordering, opaque generation- and scope-bound capability principals, target-destruction revocation before same-ID reattachment, generation-aware activate/deactivate, navigation persistence, the bundled first-party `codlet` GUI, the renderer binding/RPC bridge, and a strict persistent registry for bundled enablement and trusted local plugin directories. Principal and lease validation is the Core authorization gate: provider identity and registration/scope epochs are not exposed, and stale consumer/provider generations, revoked target scopes, wrong sessions, duplicate or out-of-order request IDs, and unknown bindings are rejected before a renderer endpoint action runs. Activation uses one CDP request deadline while response and binding activity share a wake path; an activating candidate can receive its own authenticated RPC responses, but is not exposed as active through the bootstrap, provider dispatch, or management actions before ready. The separate Host status snapshot may report its unready lifecycle with active=false. A candidate that never becomes ready expires on that original request deadline, rolls back, and leaves the Host usable. The bridge includes a fixed, side-effect-free `codlet.runtime.ping@1` endpoint and the first authenticated management transaction, `codlet.runtime.manage@1` list/disableSelf. The latter requires the `runtime.manage` grant, persists before acknowledging, and only then revokes and unloads the caller across active targets; fake-CDP verifies the normal ordering plus cleanup and response-delivery fault isolation. This is not the full L3 broker: file, process, network, and system capabilities are not implemented. Read-only Host status IPC is implemented; detached launch and mutating launcher/runtime commands remain deferred. File watching, hot reload, separate-process live CLI control, host processes, permission consent UI, SDK, and marketplace remain outside the current slice. Activation, deactivation, and awaited renderer-provider handlers now share a reentrant binding pump with one inherited absolute deadline and a maximum of eight nested waits. Stopping plugins remain addressable for cleanup replies while hidden from provider dispatch; actual target destruction invalidates session clones before further dispatch. Ordinary response-delivery failures remain diagnostic. Host deadlines do not forcibly stop already-running plugin JavaScript or guarantee reversal of its side effects.
