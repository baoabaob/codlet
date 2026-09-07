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

1. Completed in the subsequent delivery below: explicitly trusted local plugin
   directories, entry-path validation, shared catalog/graph, and explicit grants.
2. Add session-scoped Runtime Host control IPC, then connect CLI enable, disable,
   reload, and status to the same authenticated management transactions as the GUI.
3. Add file-watch reload after manual reload has a tested generation replacement,
   reverse dependency teardown, rollback, and diagnostics contract.
4. Re-run the current-build GUI, navigation, DOM rebuild, multi-window, and normal
   exit gates in a deliberately started Codlet session before closing M1.

Runtime Host IPC and subsequent reload work build on these foundations and should
be integrated serially in the shared lifecycle files. L2/L3/L4 expansion remains behind the
existing product gates; backend research does not justify a second App Server.

## Local plugin delivery

The follow-up batch starts from `b0006a8`. Two new independent Astra xhigh worktrees
implemented registration and loading; the existing diagnostic task handled catalog,
renderer, and GUI integration. The coordinator implemented CLI commands, the
launch-preparation boundary, examples, shared Windows bindings, and final checks.

| Executor | Scope | Reviewed result |
| --- | --- | --- |
| `01a079c8-ae94-7510-b514-494fbe6ce108` | Schema 2 local registrations, explicit grants, read-only v1 compatibility, registration CAS under the existing lock | Integrated as `887a393` from `1236f556` |
| `01a079c9-7e35-7c51-b7ff-295c06c3d149` | Bounded UTF-8 directory loading, path/link/identity/grant checks, unchanged CommonJS source | Integrated as `d52b6be` from `a8f12843` |
| `01a077bf-acc0-7c32-b502-76a8fe66c9c9` | Shared catalog/graph, per-entry diagnostics, runtime management snapshots, GUI refresh and asynchronous cleanup | Integrated as `9279eac` |

`plugin add` previews by default. `--trust` plus each requested `--grant` records
authorization; `remove` forgets registration without deleting source. The launch
path validates the catalog before package discovery or process creation. Tests use
that preparation function directly instead of risking a real CLI launch when
testing invalid source. Enabling pins the validated registration through the
commit; disabling broken directories remains available for recovery.

Integration review also addressed two cross-module issues:

- Real target state makes the GUI's initial activation-time `list` correctly say
  its own plugin is not yet active. The panel now refreshes through the authenticated
  endpoint when opened, restoring the self-disable control after readiness without
  publishing a false active state. Late responses cannot mutate an unloaded panel.
- A graph can be structurally valid while a local renderer's requirement uses a
  scope the current transport cannot route. Catalog validation rejects non-target
  local requirements before launch and reports the same failure in doctor, while
  the generic manifest parser and capability kernel keep all four scopes.

The file-handle checks use the repository's existing `windows-sys` dependency with
its FileSystem feature, replacing duplicate hand-written Win32 structs/bindings.
The example and guide are in `examples/local-echo` and [LOCAL_PLUGINS.md](LOCAL_PLUGINS.md).

Combined verification after integration:

| Check | Result |
| --- | --- |
| Rust format and all-target/all-feature Clippy with warnings denied | Passed |
| All-target/all-feature Rust tests | 210 passed, 1 real Codex gate ignored |
| Bootstrap, management GUI, and local example Node tests | 24 passed |
| Normal and crash acceptance data fixtures, Windows PowerShell and PowerShell 7 | All four combinations passed |
| Production release build (`--locked --release --bin codlet`) | Passed; release binary is 3,110,400 bytes |
| Release `doctor --json` | Exit 0; registry, plugin validation, and graph `ok`; build `26.901.6511.0`; runtime `not_probed` |
| Release inspection of `examples/local-echo` without `--trust` | Correct candidate and permissions, expected exit 1, no registration |

The Rust total includes 94 unit, 18 doctor, 34 fake-child, 7 local CLI, 16 local
registry, 30 local loader, 5 existing plugin CLI, and 6 registry-process tests.
Windows symbolic-link and junction cases executed successfully on this machine.
Source is not executed by inspection, listing, or doctor. No real Codex process
was launched, attached, or terminated, and no real plugin registration was written.

The local release artifact is `.codlet-artifacts/local-plugins-2026-09-07/codlet.exe`,
outside Git. SHA-256:
`7c23478d915bda21dad3344f1e1ab909836a1c7ab9787c7d29e0a801623717c2`.

## Native GUI and runtime status batch

Baseline: `2ecb27e`. The user explicitly requested a first-party Codlet entry in
the official top toolbar, with appearance and interaction consistent with Codex.
The management surface may remain a panel; a separate window is optional.

Three independent Astra xhigh worktrees are executing this batch:

| Task | Ownership | Acceptance | Status |
| --- | --- | --- | --- |
| Native GUI (`01a07a4d-849c-74c1-845e-fe5957eaeb8b`) | Bundled GUI, behavioral tests, isolated preview | Native menu entry, settings dialog and confirmation, keyboard/focus cleanup, recoverable list failures and late mounts | Foundation `d9ac2d5` from `140965c`; native component correction `5e49797` from `669c3cf` |
| Toolbar and theme adapter (`01a07a4e-0f29-7292-a6d0-612968b2ca2f`) | Adapter, dedicated tests, installed-build evidence | Verify native-menu versus renderer location; preserve capability boundary; repair mounts without duplicates; bridge native theme variables only within adapter-owned surfaces | Reviewed and integrated as `42bed1b` from `9562ee0` |
| Read-only runtime status (`01a07a4e-f254-7af2-b2e9-8898fe0d0fa1`) | Windows IPC, host snapshots, CLI and dedicated tests | Versioned `status --json`, actual target/plugin lifecycle, no-host distinction, bounded transport and cleanup, current-user access | Reviewed and integrated as `7c0d6eb` from `92476b3`; coordinator applied repository formatting |

The coordinator owns integration, browser verification, and project documentation.
GUI tests and preview use real bundled source with simulated host/RPC inputs.
Preview screenshots establish layout and interaction evidence, not a current-build
injection gate. Installed-package research is read-only; proprietary source and
assets are not copied into this repository.

Integration review found that React may create the header after provider activation.
A valid mount token with `available: false` must allow the GUI to observe a later
mount, rather than permanently exiting. List errors must likewise remain retryable
after the entry has mounted. These cases are included in the GUI task.

Runtime status is the first control-channel increment. This batch does not promise
detached launch, live arbitrary plugin enable/reload, or file watching.

The static preview is [scripts/preview-codlet-gui.html](../scripts/preview-codlet-gui.html).
It loads the actual bundled GUI and adapter with simulated host DOM, theme seeds
and RPC inputs. The
in-app browser URL safety policy rejected opening its local file URL; no alternate
browser or server was used to bypass that denial. GUI screenshots, desktop/narrow
layout, real tab order, and icon rendering remain unverified. The adapter executor
had already completed a separate synthetic-DOM CSS/observer check before receiving
this restriction; that result is not a substitute for the GUI screenshot gate.

The user reviewed the initial preview and found that its panel/controls still did
not match the native client. The first GUI commit establishes the interaction and
lifecycle foundation, not completed native-style acceptance. The same GUI and
adapter executors continued from `42bed1b`, tracing actual settings, button,
switch and dialog components and correcting the implementation. Richer reusable
adapter capabilities are proposed in [UI_ADAPTER_CAPABILITIES.md](UI_ADAPTER_CAPABILITIES.md);
they are not a claim that a complete native component library exists today.

The integrated status foundation passed all-target/all-feature Clippy and 228 Rust
tests, with one real gate ignored. The final GUI/adapter integration passed 58
Node tests (18 bootstrap, 11 adapter, 27 GUI, 2 example). All four PowerShell
acceptance fixture combinations passed.

The semantic appearance extension is integrated as `0017a34` from `7bd5044`.
It adds only the 16 aliases consumed by the corrected GUI (27 total), including
distinct setting/group/dialog surfaces, type hierarchy, accent and destructive
states. Native component evidence now records the actual row consumers and dialog
variants, rather than assuming every settings row uses the same height token.

The final GUI uses the observed wide 600px dialog and compact 420px confirmation
variant, native row/group spacing, 32x20px switches, native type hierarchy and
dialog-action buttons. The browser's dialog primitive owns modal inertness and
focus scope; plugin handlers own dismissal, state transitions and cleanup. Tests
cover failed opens, native close before a response, queued close after reopening,
unloading a pending request, and outside-click confirmation cancellation. The
preview opens the settings surface first with test controls folded, and obtains
all 27 aliases from the real adapter. Visual agreement remains a separate open
gate, including actual Tab behavior and narrow-window rendering.

Final integration verification:

| Check | Result |
| --- | --- |
| Rust format and all-target/all-feature Clippy with warnings denied | Passed |
| Full Rust suite after status integration | 228 passed, 1 real Codex gate ignored |
| Doctor and fake-child regression after final GUI and diagnostic copy updates | All 53 passed |
| Final combined JavaScript suite | All 58 passed |
| Normal/crash acceptance data fixtures on Windows PowerShell and PowerShell 7 | All four combinations passed |
| Release build | Passed; 3,401,216 bytes |
| Release `status --json` | Exit 0; schema 1; `not_running` with no invented snapshot |
| Release `doctor --json` | Exit 0; build `26.901.6511.0`; registry, plugin validation and graph `ok`; future launch blocked by existing Codex |

Static doctor now directs runtime inquiries to `codlet status` instead of claiming
the IPC does not exist. It still does not itself probe the Host or establish GUI
compatibility. No official process or real plugin configuration was modified.

Final binary: `.codlet-artifacts/native-ui-2026-09-07/codlet.exe` (outside Git).
SHA-256: `4c031de0d39b8d6e6a0120a6b448a07f0c4cea426555df3d84f900d1f9b3db8c`.

The plugin-list naming follow-up labels the `codlet` entry `Codlet GUI`; its ID,
toolbar entry and window title are unchanged. All 27 GUI tests and the refreshed
release build passed after that display-name change.

## Open product gates

`DEFECT-001` (Electron's single root instance) and `DEFECT-002` (a Runtime Host crash
may leave Codex running) remain open. Automated fixture success does not close M0
or M1 and does not establish compatibility with a newer Desktop build. The current
working Codex session is not a test target for this development batch.

The host's deadline limits waiting, not arbitrary JavaScript execution. It cannot
forcibly preempt an already-running plugin or promise rollback of irreversible
side effects. A genuinely blocked pipe write still follows the transport's existing
connection-close contract. Neither limitation is presented as a passed runtime gate.
