# Codlet

Codlet is a Windows-first launcher and lightweight extension runtime for Codex Desktop. Plugins are JS/TS directory packages with `codlet.json`, built JS entrypoints and resources. Host JS runs in Codlet's managed Node process; renderer JS runs in the page. Official GUI and adapter plugins are optional. Start with the [Host development workflow](docs/HOST_DEVELOPMENT_2026-09-10.md) or the [M3/M4 Desktop Adapter](docs/DESKTOP_ADAPTER_DEVELOPMENT_2026-09-10.md). The [technical plan](docs/PRODUCT_TECHNICAL_PLAN.md) keeps implementation evidence and production gates separate.

The launcher does not patch the Codex package, official shortcuts or launch protocols, and never terminates an existing Codex process to make room. Normal Codex launches do not run Codlet. Explicitly trusted plugins and broker operations can have their own effects; ordinary user Node code is not an OS sandbox.

## Development status

The M3/M4 candidate adds explicitly granted managed main worlds and an optional
Desktop Adapter for submission interception, conversation reads/writes, events,
and approval replies over the current Desktop connection. Its [semantic SDK](types/codex-desktop.d.ts)
and [test panel](examples/desktop-m3-m4/README.md) keep private Desktop mappings
out of Core. [The compatibility follow-up](docs/DESKTOP_COMPATIBILITY_2026-09-11.md)
supports package `26.903.9818.0` and fixes isolated-client native task creation and
cold resume. The existing M0/M1 production gates remain open.

The [next development plan](docs/NEXT_DEVELOPMENT_PLAN_2026-09-11.md) places reusable
UI helpers and Desktop API extensions in M3.1/M4.1, local/GitHub plugin import and
simple in-client management in M5, and platform preparation alongside current work.
GitHub Topics and community directories handle discovery; a separate Codlet Market
is outside the current plan. These additions are planned, not implemented features.
The [P0 platform audit](docs/PLATFORM_P0_AUDIT_2026-09-11.md) now records Windows dependencies,
proposed internal interfaces and the per-platform evidence required before a port.

The current M2 developer contract uses `host.entry: "dist/host.js"`. Both entry kinds export CommonJS
`activate(context)` and `deactivate()`; TypeScript is compiled to JS before loading.
Codlet supplies the pinned JS runtime and handles JSONL internally. Arbitrary
executable entries and native Node addons are not supported. This unifies the
package format and runtime contract.

Public [Core RPC](docs/CORE_RPC_2026-09-10.md) supports Host and managed-renderer
providers/consumers with Runtime and Target ownership, fixed provider generations,
bounded nested calls, cancellation and explicit notification semantics. The
[Core RPC examples](examples/core-rpc/README.md) exercise these interfaces without
private provider privileges. The [raw-m2 example](examples/raw-m2/README.md) owns
its injection, navigation recovery and message bridge using public raw CDP alone.

Independent [OS brokers](docs/OS_BROKER_2026-09-10.md) provide bounded file reads,
HTTP(S), approved child processes and system information. Grants and scope policy
are explicit, atomically persisted and revocable. The
[OS example](examples/host-os-broker/README.md) uses only its selected data
directory and HTTP origin. Public [runtime.manage@1](docs/RUNTIME_MANAGE_2026-09-10.md)
backs third-party management and GUI/CLI prepare, submit and operation receipts.
Type-only authoring contracts cover [Host](types/host.d.ts),
[renderer](types/renderer.d.ts) and [management DTOs](types/runtime-manage.d.ts).

The [standalone JS example](examples/raw-host/README.md) uses `context.cdp` without
an official plugin or renderer entry. M2b adds online host enable/disable/reload
through the existing CLI receipts, including hosts registered after launch. See
the [host lifecycle contract](docs/M2B_HOST_CONTROL_2026-09-10.md) and
[unified JS contract and migration](docs/JS_PLUGIN_RUNTIME_2026-09-09.md).
The host development path now also includes [source watching](docs/HOST_WATCH_2026-09-10.md),
[bounded CDP cleanup](docs/HOST_CLEANUP_2026-09-10.md), and
[process-aware doctor inspection](docs/HOST_INSPECTION_2026-09-10.md).
The [development walkthrough](docs/HOST_DEVELOPMENT_2026-09-10.md) covers scoped
grants, permissions/revoke, public management, automatic reload and cleanup.
The [portable distribution builder](docs/DISTRIBUTION.md) packages the fixed Node
runtime, examples, types and documentation together. A directory can now contain
[both host and renderer entries](docs/COMBINED_PACKAGES_2026-09-10.md), sharing one
generation, lifecycle receipt and recovery transaction. Renderers can call declared
[Host capability endpoints](docs/HOST_CAPABILITY_2026-09-10.md) with authenticated
target/document identity and a bounded asynchronous bridge. The
[combined example](examples/local-host-renderer-capability/README.md) and
[actual JavaScript acceptance](docs/HOST_RENDERER_VM_ACCEPTANCE_2026-09-10.md)
cover activation, reload, document replacement, cleanup and failed replacements.
Packaging validates file/link closure and read-only CLI behavior. Its hashes and
smoke report do not replace the [runtime acceptance evidence](docs/M2_ACCEPTANCE_2026-09-10.md).

The optional [hide usage banner plugin](examples/hide-usage-banner/README.md) hides the specific
English out-of-usage card using `ui.dom`. It restores the card when disabled and leaves other
messages visible. Its [browser preview](scripts/preview-hide-usage-banner.html) uses the actual
plugin source against a local fixture based on the installed build's markup.

The [independent manual-test client](docs/DESKTOP_COMPATIBILITY_2026-09-11.md)
supports reviewed x64 builds `26.903.8094.0` and `26.903.9818.0`, reuses the original test login profile,
and runs the current local-plugin runtime with optional M3/M4 adapters. Its
separate start/stop/plugin/doctor launchers target the test registry and dedicated backend.

The 2026-09-07 review added bounded nested renderer RPC and deactivation, merged concurrent registry edits under a process lock, and introduced versioned read-only diagnostics. See [the review and execution plan](docs/REVIEW_AND_EXECUTION_2026-09-07.md) for evidence, ownership, and the next development sequence. Read-only package discovery found build `26.901.6511.0`; its real M1 gate remains open.

The authorized [isolated-client follow-up](docs/ISOLATED_CLIENT_REPAIR_2026-09-08.md) fixed the initial Shell timeout and resident-client shutdown failures. Two fresh Dev/WebSocket runs passed automatic startup checks in about 1.9 seconds, activated both bundled renderer plugins, and exited normally in about one second. The [experimental lab harness](docs/ISOLATED_CLIENT_TESTING.md) prepares the official package's Node runtime files in its own fresh cache and checks startup before loading plugins. Those runs did not exercise login or live GUI interactions; ordinary `codlet launch` keeps its conflict refusal.

The subsequent [manual-login GUI acceptance](docs/GUI_ACCEPTANCE_2026-09-08.md) exposed a lost plugin connection and missing reload recovery. The [GUI repair and retest](docs/GUI_REPAIR_2026-09-08.md) now passes in the authenticated isolated client: populated lists, refresh, two native reloads, light/dark themes, narrow layout, a second window and GUI self-disable. Renderer ownership is tied to the main frame, navigation performs a fresh activation handshake, and unanswered RPCs expire after 15 seconds. Production M0/M1 gates remain open.

Explicitly registered local renderer directories now use the same launch catalog, capability graph, management list, and diagnostics as bundled plugins. See [local plugin registration and authoring](docs/LOCAL_PLUGINS.md) for the user-consent, permissions, path, and recovery contracts.

The [2026-09-09 GUI repair and acceptance record](docs/GUI_REGISTRY_REPAIR_2026-09-09.md) records the user-run M0, M1 and M1-watch observations. The normal M0 harness was verified with exit `0` (Host PID `63976`, child PID `11692`); the ordinary M1 run ended with exit `1` without a stopped marker, and its cause remains unknown; M1-watch exited `0` with active and stopped observations (Host PID `29692`, child PID `36240`). The user also confirmed the visual checks, hot-added `dev.codlet.acceptance-marker`, online enable/reload/disable/reenable, two applied watch changes, and doctor Inspect. These observations do not close the complete M0/M1 gates, the 100-run baseline, or the crash gate.

## M0 commands

The repair build was subsequently retested with `launch --watch`: Host `41432`,
Codex `20540`, exit `0`, active/stopped observed and no remaining related process
or listener. The older exit-1 report remains inconclusive. Routine development
continues with focused checks; the open repetition/crash gates are retained for
milestone closure and do not require repeating full M0/M1 tests for each small fix.

Launch the current renderer-runtime candidate with the bundled first-party `codlet-gui` plugin:

```powershell
codlet launch
codlet launch --watch
```

Each isolated renderer plugin receives its own world per generation, named `codlet.plugin.<id>.g<generation>`. Explicitly granted main-world plugins share the page's default context while retaining separate bindings and principals. The bundled GUI adds a plain `Codlet` entry immediately after Help in the current build's application menu row. It opens a settings dialog using the client's observed 600px wide variant, native setting-row proportions and 32x20px switches; confirmation uses the 420px compact variant. The adapter owns the observed menu selectors and native theme mappings; the GUI consumes scoped aliases and uses the browser's modal dialog primitive. An explicitly identified legacy header remains the only fallback. See [the installed-build adapter evidence](docs/CODEX_UI_ADAPTER_EVIDENCE.md) for structural requirements and limits.

New BrowserWindows receive the same plugin generation automatically. Main-document navigation retires the old target authorization and recreates plugins in dependency order, with fresh world and binding names ending in `.d2`, `.d3`, etc. Both initial and recovered activation wait for each plugin's ready promise; Host and renderer-provider RPC remain routable through the authenticated binding while that promise is pending. The panel can persistently disable its own GUI plugin after an inline confirmation; the host confirms the registry write before attempting the reply, then unloads that plugin from every attached renderer. A reply lost to renderer teardown is diagnostic rather than fatal because the persisted action remains authoritative. Explicitly registered local directories are loaded on a new launch.

The entry tolerates a late or rebuilt toolbar. Plugin lists load when the dialog opens and can be refreshed after errors, including a 15-second RPC timeout. Escape is handled inside the GUI, and close/unload retires pending work and restores focus. [Open the standalone GUI preview](scripts/preview-codlet-gui.html) to inspect the actual GUI source with simulated toolbar, theme and RPC inputs. It opens the management surface first and keeps test controls folded; it needs no server. Live interaction and 1280/782 px window layouts passed in the isolated-client retest; that evidence does not close the ordinary-launch production gate.

`codlet launch` never watches files. The explicit `codlet launch --watch` mode observes already-loaded local plugins' `codlet.json` and every declared renderer/host JS entry. Both executors share the bounded scanner and stable-save checks. Reload follows the loaded capability dependency closure, including cross-executor consumers, through one lifecycle receipt. Packages with a Host anchor the selected canonical root and full grants, then check them again before retiring a generation. Registry reads/writes retain the 1 MiB bound. See [combined packages](docs/COMBINED_PACKAGES_2026-09-10.md) and [host watch](docs/HOST_WATCH_2026-09-10.md) for the current scope and targeted evidence.

The next adapter layer is planned in [native UI capabilities](docs/UI_ADAPTER_CAPABILITIES.md): host slots, semantic appearance roles and local control interactions have separate ownership. Matching colors alone is not native-style acceptance, and a reusable component library is not implemented yet.

The [appearance follow-up](docs/APPEARANCE_FOLLOWUP_2026-09-08.md) fixes the menu entry's normal/hover/open color roles and its sizing at larger UI fonts. Official-style aliases inherit the client's effective palette, contrast, font family/face, text sizes and accent; control cursor and reduced-motion preferences also follow the host. This applies to the adapter's mount and opted-in plugin surfaces, including Codlet GUI. Other plugins keep their own styling.

Query a running Codlet Host from another terminal using the same executable:

```powershell
codlet status
codlet status --json
```

The versioned, read-only response distinguishes a missing Host from a busy pipe, timeout, incompatible protocol or untrusted server. It includes sampled Host/child identity and target/plugin lifecycle, not configuration enablement. Context creation alone remains unconfirmed; navigation recovery must complete the new document's activation handshake before `active` becomes true. The local pipe is restricted to the current user and verifies the server executable path; another build directory is conservatively rejected. See [the runtime status contract](docs/RUNTIME_STATUS.md). Manual CLI enable/disable/reload lifecycle is covered by the isolated acceptance, while authenticated control IPC is covered by native fixtures; watcher regression is covered by the final validation batch. File watching is available only through explicit `codlet launch --watch`; ordinary production launch+watch acceptance and detached launch remain open/future work.

Inspect plugin registrations and request offline or running-host lifecycle control:

```powershell
codlet plugin list
codlet plugin disable codlet-gui
codlet plugin enable codlet-gui
codlet plugin reload codlet-gui
codlet plugin permissions dev.my-tools --json
codlet plugin revoke dev.my-tools host.fs --json
codlet plugin operation <receipt>
codlet plugin add .\examples\local-echo
codlet plugin add .\examples\local-echo --trust
codlet plugin remove dev.example.local-echo
```

`enable`, `disable`, `reload`, and `revoke` accept an optional `--json`. `permissions` reads saved grants and broker scope policy. `operation <receipt> [--json]` performs a read-only lookup after a prepared or submitted control request. With a verified Host, enable changes only the requested plugin, disable rejects enabled or running dependents, and reload updates the target plus its transitive dependents while preserving unrelated plugins. Revoke saves the reduced grants/policy, invalidates the old managed authority and retires its dependent closure without restoring old authorization. A loaded root that needs recovery may restart its currently loaded transitive dependents under one authorization guard; enable still does not implicitly turn on an unloaded dependency. A submitted mutation has one receipt and one submit; an uncertain timeout must be checked with `operation` and is never retried or converted to an offline edit. See the [public management contract](docs/RUNTIME_MANAGE_2026-09-10.md) and [runtime plugin control](docs/RUNTIME_CONTROL.md).

The legacy ID `codlet` remains accepted as a compatibility alias for `enable`, `disable`, and `reload`; control normalizes it to canonical ID `codlet-gui` before preparing an operation. `list`, `doctor`, `status`, and GUI rows use `codlet-gui`.

`add` without `--trust` only inspects the directory and exits nonzero without registering it. Requested permissions need explicit matching `--grant` arguments; the local-echo example needs none. Removal preserves its files. Registration/grant edits keep existing enablement preferences; the next launch or an explicit enable/reload uses the updated authorization record. Renderer watch validates changed grants at the same path; host watch pauses when its full grant record changes and requires manual selection of the new trust settings. Schema 1 configurations remain readable; explicit saves migrate to schema 2 with the `localPlugins` map.

The registry is stored at `%LOCALAPPDATA%\Codlet\config.json` with atomic replacement. `list` does not create the file. The status IPC remains read-only; runtime lifecycle control uses a separate per-registry authenticated pipe and Host mailbox. Online commands must use the same `codlet.exe` image path and registry as the Host they control; a copied executable is rejected by image authentication. A different registry is a separate scope and cannot control that Host. Only after proving that a registry has no Host may enable/disable save a preference or revoke reduce grants/policy for the next `codlet launch`; reload requires a running Host. The in-Codex GUI and third-party plugins use the authenticated `codlet.runtime.manage@1` receipt endpoints. Current isolated M2 checks are recorded separately from production gates. Bundled GUI registry reconciliation and the `codlet` compatibility alias are defined in [the 2026-09-09 registry repair record](docs/GUI_REGISTRY_REPAIR_2026-09-09.md).

The 2026-09-08 validation batch passed 289 Rust tests with one explicit real-production-start gate left default-ignored, 63 Node tests, Clippy, fmt, diffcheck, and the locked release build. That historical result is separate from the isolated manual-control evidence at source commit `5a0be1e`; its renderer watcher source is `851395a`. See the [2026-09-08 verification summary](.codlet-artifacts/runtime-watch-2026-09-08/verification.json). Current host development checks are recorded with their individual contracts above.

Writers serialize on `config.json.lock`, re-read the latest valid document, and merge only their explicit edits. Different plugin enablement edits are preserved; the last committed enablement assignment to the same plugin wins. Local registrations and grants additionally compare the original record under that lock, so concurrent changes fail instead of replacing another writer's authorization. A busy lock returns an error after two seconds. The sidecar remains on disk, while its OS lock is released when the writer closes the handle or exits. Successful saves refresh the in-memory snapshot; failed saves preserve pending edits for an explicit retry.

For routine changes, run the affected checks. The comprehensive Windows commands
below are available for milestone closure or changes that justify the wider scope:

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

`doctor --json` emits one additive `codlet.doctor/v1` report. Package, executable, process snapshot, registry, catalog, and dependency checks retain their own results, so a package failure does not hide a configuration error. When a matching Host supports the authenticated scoped `Inspect` request, doctor adds one read-only owner sample with actual kernel registrations, target/session records, generations, and activation facts; it never treats disk `provides` declarations as loaded state. No Host, another registry, and an unsupported legacy Host remain unavailable without adding a failure solely for that reason. Transport or identity failures are reported as runtime-unavailable issues and add the `runtime` failed check; a fresh, complete, quiet sample with an observed generation mismatch or inactive/not-observed plugin can also add that check. Doctor does not launch or stop Codex, attach CDP, prepare/submit a receipt, or write the registry; compatibility remains unprobed. See [the doctor runtime inspection contract](docs/DOCTOR_RUNTIME.md). An existing Codex instance still blocks a later launch but does not itself fail read-only doctor.

The reproducible external M0 acceptance entry takes an existing `codlet.exe` by explicit path. Run this one command from the repository root only after manually closing every ChatGPT/Codex window:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-M0Acceptance.ps1 -CodletPath "C:\absolute\path\to\codlet.exe"
```

The script first takes a read-only snapshot of exact `ChatGPT.exe` and `Codex.exe` processes. If either exists, it fails explicitly without invoking Codlet or modifying any process. Otherwise it invokes `codlet.exe m0-runtime --launch-codex` exactly once and shows its output live. When Codlet emits the exact active-runtime protocol line, the script takes one active snapshot while the inherited pipes are held; after Codlet returns, it takes the final snapshot. It never terminates a process, retries, starts the official entry, changes Codex configuration, or monitors later launches.

While the runtime is active, each newly attached BrowserWindow prints one live `renderer-bootstrap: target-id=...; marker-inserted=true; marker-removed=true` line. This is the manual M0 signal for the "open in new window" path. Duplicate target events do not print another line, and the diagnostic is intentionally outside the persisted report allowlist.

Each attempt writes one machine-readable `codlet.m0-acceptance/v1` JSON report under `.codlet-artifacts/m0-acceptance/`. The report records UTC start/end times; the Codlet path, fixed arguments, invocation state and exit code; the launched PID plus active/stopped protocol observations; allowlisted M0 stdout plus an omitted-line count; preflight conflicts; `before` / `active` / `after` related-process snapshots; TCP listening endpoints owned by those snapshot processes; and the script result. The active snapshot must contain the exact launched Codex PID. All Codlet output is still shown live, but stderr and stdout outside the fixed M0 report grammar are not persisted. The report does not collect process command lines, page content, CDP pipe handles, or secrets. A failed capture is represented by `captureError` and `null` snapshot data rather than invented evidence.

The report always leaves `runtime_visible_and_usable`, `user_closed_codex_normally`, `official_entry_zero_behavior`, and `runtime_crash_contract` at `pending_manual_confirmation`, with `m0Decision: not_determined`. Script exit `0` therefore means only that this one Codlet command returned `0`, emitted its launched/active/stopped protocol, produced all three phase snapshots, bound the active snapshot to the launched PID, and left no new related process in the after snapshot; it does not mean M0 passed. Evidence mismatches are reported without terminating the remaining process. Exit `2` is a preflight conflict, `64` is argument validation, `70` is snapshot/report/evidence infrastructure failure, and any other nonzero command result preserves Codlet's exit code when possible.

For a production plugin session, the same harness accepts explicit M1 mode:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-M0Acceptance.ps1 -CodletPath "C:\absolute\path\to\codlet.exe" -RuntimeMode M1 -Watch
```

Omit `-Watch` to test ordinary `launch`. M1 emits a separate `codlet.m1-acceptance/v1` report with the same process/lifecycle checks; GUI, live control, doctor and file-watch observations remain pending manual checks. Existing Codex instances are still refused. See [the current M0/M1 acceptance record and procedure](docs/M0_M1_ACCEPTANCE_2026-09-09.md).

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

The confirmed M2–M4 architecture is an open Core with an optional managed renderer runtime and optional UI/backend adapters. Independent host JS plugins already use public CDP requests and events without a renderer entry or official functional plugin. Grants and managed routing do not guarantee plugin safety or rollback of arbitrary effects. See [the confirmed Core boundary](docs/CORE_EXTENSION_BOUNDARY_2026-09-09.md).

The candidate includes inherited CDP pipes, bounded request/event routing, strict Windows handle inheritance, package discovery and launch conflict checks. The optional managed renderer supports isolated worlds, generation and scope checks, deterministic capabilities, navigation recovery and the bundled `codlet-gui`. Its reentrant lifecycle/provider pump retains one inherited deadline and at most eight nested waits.

Independent host JS runs in Codlet's pinned Node processes and per-plugin Jobs. CLI enable/disable/reload and opt-in watch use the same serialized lifecycle transactions, fresh generations and current-registration compensation guards. Ordinary requests retire before `deactivate(cleanup)`; explicit cleanup CDP requests share Core's finite stop budget. Process exit, whole-Job retirement and joined IO remain separate from cooperative cleanup acknowledgement. Read-only execution inspection exposes those facts without manufacturing renderer targets or providers.

Combined host+renderer packages share startup, reload, rollback and disable; the Host reaches Ready before renderer activation, and renderer cleanup runs before Host retirement. Current M2 includes Core RPC with Runtime/Target ownership, independent scoped OS brokers and public management receipts for Host and renderer clients. The optional M3/M4 Desktop Adapter uses Target-scoped capabilities for the current local connection. Cross-host adapters, a reusable native UI component library, detached launch, a permission-consent UI and marketplace are outside the current delivery. Real Codex acceptance and the remaining M0/M1 production/crash gates are recorded separately from actual JavaScript, fake-CDP and native-process tests.
