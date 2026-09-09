# Runtime Plugin Control

> Status: manual enable/disable/reload are implemented in source commit `5a0be1e`; native fixtures validate the authenticated control IPC, and the manual isolated acceptance validates lifecycle behavior. The watcher and its safety guards are in source commit `851395a`; the final automated regression passed. Ordinary production launch+watch acceptance remains open, as do the production M0/M1 gates and `DEFECT-001` / `DEFECT-002`.

This contract covers the first live plugin lifecycle controls. It is separate from the read-only `codlet status` protocol in [RUNTIME_STATUS.md](RUNTIME_STATUS.md). The foreground Runtime Host is the only component that owns renderer lifecycle work; the CLI only prepares, submits, and reads operation receipts.

## Responsibilities

| Component | Responsibility |
| --- | --- |
| DTOs | Carry typed plugin requests, reports, outcomes, generations, and target failures; they hold no transport or execution authority. |
| Control transport | Authenticate the scoped pipe and exchange bounded frames using shared Windows IPC primitives. |
| Mailbox | Reserve/submit/query receipts and bound queue and retention independently of the renderer and Windows transport. |
| Lifecycle plan | Resolve the affected dependency closure, validate catalog/registrations/grants, allocate generations, and define compensation. |
| Renderer executor | `RendererRuntime.manage_plugin` owns detach, provider removal, activation, persistence, rollback, and per-target diagnostics on the foreground owner. |
| Watch observer | Inspect only already-loaded local sources and emit a typed reload request; it does not load code or execute a lifecycle action. |
| Foreground orchestrator | Prioritize one CLI mailbox job over at most one watcher request on each owner-loop round, then invoke the shared renderer executor. |

## Launch modes and registry identity

```text
codlet launch
codlet launch --watch
```

Ordinary `codlet launch` does not watch files. `--watch` is explicit and opt-in;
its scope and scheduling rules are defined below. The Host and online control CLI
must use the same `codlet.exe` image path and the same current-user registry at
`%LOCALAPPDATA%\Codlet\config.json` to communicate. A copied executable is rejected
by image authentication. A different registry gets a separate scope and cannot
control that Host; its offline eligibility follows the evidence rules below.

The bundled GUI's canonical plugin ID is `codlet-gui`; its menu, window, and
product name remains `Codlet`, and its capability names remain
`codlet.runtime.*`. For backward compatibility, `enable`, `disable`, and
`reload` accept the legacy ID `codlet` and normalize it to `codlet-gui` before
preparing a receipt. `list`, `doctor`, `status`, and GUI rows use the canonical
ID. Both IDs are reserved and cannot be claimed by a local plugin.

The explicit `plugins.codlet-gui` preference wins. If absent, the legacy
`plugins.codlet` preference is read as a read-only fallback. `list` and `doctor`
never migrate these keys. An explicit GUI preference update writes the new key
and removes the legacy key while holding the existing registry save lock. A
running Host's identities and already-issued receipts are not rewritten in
place; the canonical identity takes effect on the next launch with the updated
binary.

## CLI surface

The commands are:

```text
codlet plugin enable <id> [--json]
codlet plugin disable <id> [--json]
codlet plugin reload <id> [--json]
codlet plugin operation <receipt> [--json]
```

`enable`, `disable`, and `reload` address one plugin id. The legacy bundled GUI
alias is normalized before `prepare`, so receipts identify the canonical plugin
used by the Host. `operation` accepts the opaque receipt returned by a prepared
or submitted operation and performs a read-only lookup. A receipt is bound to
the Host incarnation that issued it; callers must not construct, edit, or reuse
it as a new mutation request.

Human output reports the control status, operation id, requested action and plugin, lifecycle outcome, affected plugins, remaining generations, target failures, and any diagnostic message. JSON output has schema version `1` and includes `outcome`, `operation_id`, `control`, `offline`, and `error` fields. A completed lifecycle report with `applied` or `unchanged` is successful. `rolled_back` and `degraded` are completed reports that still represent a failed or compensated lifecycle request, so the CLI returns an error while preserving the report for inspection.

## Online transaction

When a verified Host owns the registry, the CLI performs this sequence:

1. `prepare` validates the action and plugin id and creates an inert, Host-issued receipt. It does not run plugin code or change the registry.
2. `submit` is sent exactly once for that receipt. The receipt already binds the action and id, so submission carries no second mutation body.
3. The Host queues the job and the foreground renderer owner calls `manage_plugin`. Renderer detach, provider removal, activation, persistence, and compensation stay on that owner thread.
4. The CLI polls `result` only as a read-only query. A separate `codlet plugin operation <receipt>` query is also read-only and can be used after the original command returns.

The plugin command uses a bounded wait. If the Host does not return a terminal result before the wait expires, the result is `uncertain`; the CLI must tell the operator to query the receipt. It never submits the same receipt again, converts an uncertain online action into an offline edit, or retries the mutation automatically. If submission itself was not accepted, the command reports `not_submitted`; a later attempt may prepare a new receipt after checking the Host state.

The control mailbox admits at most eight queued or running operations and retains at most 128 receipts. A completed or prepared receipt may be evicted when the table is full. An old Host receipt, an unknown receipt, or an evicted receipt is terminal for control purposes and can never execute again. Host shutdown rejects new work and clears queued jobs; a late completion cannot reopen admission.

The transport uses control schema version `1`, bounded request and response frames, and one request/response exchange with an acknowledgement. Its status values distinguish `identified`, `inspected`, `inspection_too_large`, `prepared`, `queued`, `running`, `completed`, `not_running`, `busy`, `not_ready`, `stopping`, `expired`, `stale_host`, `invalid_request`, `incompatible`, `untrusted_server`, `communication_error`, and `timeout`. The two inspection-specific outcomes appear only on `Inspect`; legacy command replies keep their original field set.

## Lifecycle semantics

### Enable

`enable` affects the requested plugin only. It does not implicitly enable providers or other dependencies. The Host validates the current catalog, grants, registrations, and capability graph; every affected renderer target must activate successfully before `enabled=true` is persisted. A failed enable does not persist the preference and compensates any candidate runtime state with retired resources and fresh generations.

If the plugin is already enabled and active with valid authorization, the operation may be `unchanged`; the registry is still checked against the current trust record before that result is returned.

Normal enablement changes only the requested root and does not implicitly enable
dependencies. If an already-loaded root needs recovery, the lifecycle plan may
restart that root's currently loaded transitive dependents as one affected
runtime closure. The enable commit guards every affected local registration and
grant together; a concurrent authorization/path change fails the commit rather
than persisting a partial preference.

### Disable

`disable` first checks the current runtime and enabled catalog. It is rejected when the target still has enabled or running dependents; callers must disable the dependent plugins first. After validation, the Host persists `enabled=false` and then removes the target's renderer resources and provider. If teardown reports target failures, the outcome is `degraded`, but the persisted disabled state remains authoritative and the plugin stays disabled in that runtime.

### Reload

`reload` requires a running target plugin and a Host. It rebuilds the target and its transitive dependents as one affected closure, while preserving unrelated plugins. It retires the old resources, allocates new generations, removes the old providers, and activates the replacement graph in dependency order. Reload does not implicitly alter enablement preferences.

If replacement activation or validation fails, the Host retires candidate resources before compensation. It rechecks the original local registration and grants, restores the previous runtime code under fresh generations and capability epochs, and reports `rolled_back` when restoration is complete. If cleanup or restoration remains incomplete, it reports `degraded` with per-target failure details; affected plugins remain stopped when the prior runtime cannot be safely restored. A rollback never resurrects an old generation, binding, scope, or principal.

### GUI registry reconciliation

The GUI management list reads the latest registry and the current loaded plugin
set on each refresh. A registered loaded plugin uses its actual target active
state. A plugin that is no longer registered but remains loaded stays visible
until the runtime unloads it and is shown as `Registration removed; still
loaded`. Once the plugin is both unloaded and unregistered, the row disappears. Removal alone does not unload running code.
A newly registered `not_loaded` plugin contributes metadata only; the GUI does
not read its source to invent runtime state. A registry read failure is shown as
an explicit error and never falls back to stale cached registry data.

Lifecycle outcomes are:

| Outcome | Meaning |
| --- | --- |
| `applied` | The requested state or replacement was installed for the affected closure. |
| `unchanged` | The requested state was already in effect and remained authorized. |
| `rolled_back` | The request failed, and the prior runtime was restored with fresh generations. |
| `degraded` | The request or its compensation left cleanup or affected-target failures requiring inspection. |

Reports identify `affected_plugin_ids`, the generations remaining in the runtime catalog, and `target_failures` with target, plugin, stage, and error fields. The report's `desired_enabled` reflects the registry preference observed by the Host.

## Opt-in file watching

`codlet launch --watch` adds a foreground observer to an otherwise ordinary
launch. It watches only local plugins that are already loaded by the renderer
runtime. For each such source it fingerprints the registered `codlet.json` and
that manifest's `renderer.entry`; bundled plugins, unregistered directories,
new plugin ids, and new roots are outside the watch set and are never adopted
automatically. A normal `codlet launch` creates no watcher.

The observer is a state machine polled by the existing foreground owner loop:

- it schedules a poll every 250 ms, samples at most four loaded local sources per
  poll, and advances through them round-robin;
- a candidate must have two identical observations and remain quiet for at least
  250 ms before it is settled;
- every local source in a proposed reload closure must be settled with that same
  quiet/two-identical-observation rule. If any provider or consumer in the
  closure is still changing, the whole reload waits;
- its baseline is the source and generation actually loaded by the Host. When a
  lifecycle operation changes the generation, the observer rebaselines from that
  loaded source/generation rather than rereading the disk after the operation;
  a save during reload therefore cannot be swallowed as the new baseline;
- each poll rereads the registry. The selected source must retain the registered
  path, and the shared lifecycle transaction revalidates that path and its grants
  before committing a reload. The final watch execution policy requires the same
  lifecycle manager to guard against a registration path changing after the poll
  by using the loaded-catalog path; this is an internal watch policy and does not
  expand the public request DTO;
- when a provider and its consumers change together, the observer selects the
  provider closure so one reload covers the provider and transitive dependents;
  unrelated loaded plugins remain untouched;
- the CLI mailbox has priority and at most one management job is taken per owner
  loop. A watcher reload is considered only when no CLI job was taken that round;
- an attempted content signature is remembered. A failure with the same content,
  path, and grants is quiet until one of those observations changes.

If a registration is deleted, watching pauses with a diagnostic such as
`watch_registration_removed` and asks for explicit registration plus enable or
reload. If its registered path changes, watching pauses with
`watch_registration_path_changed` and asks for a manual enable or reload. A
registry read failure also pauses with a diagnostic. No diagnostic path creates
a new plugin, selects a new root, or runs code. The observer has no extra thread
or execution entry; it emits the same typed reload request consumed by the
foreground renderer executor. Registry reads and writes use one shared **1 MiB**
bound, preventing a 250 ms observer from reading an unbounded registry document.

## Offline enablement and disablement

Only `enable` and `disable` may edit the registry without a running Host, and only after the client proves that this registry has no Host. An absent scoped control pipe by itself is insufficient evidence. The client acquires the registry scope lease and launch mutex, rechecks the endpoint, and accepts offline editing only when the discovery and legacy status evidence cannot identify an active Host for this configuration.

An identified Host for another registry scope may coexist. An older or unverified Host that cannot prove its registry identity causes offline editing to be refused. This prevents an offline writer from racing a Host that might still own the same configuration.

An accepted offline edit is atomic and applies on the next `codlet launch`:

```text
plugin-state: id=<id>; enabled=<true|false>; applies=next-codlet-launch
```

JSON reports use `outcome: "offline_saved"` and an `offline` object with the plugin id, the new enabled value, and `applies: "next-codlet-launch"`. Offline enable still validates a registered local plugin's source and grants; offline disable does not require the plugin source to be readable. `reload` always requires the matching running Host and returns `host_required` when it is offline.

An online timeout or uncertain result never falls through to this offline path. Query the original receipt instead.

## Scope, lease, and authentication

The control endpoint is derived from the canonical registry path and current-user SID. Each registry scope has its own named pipe and mutex lease. The Host acquires the lease before loading runtime configuration and holds it for the full Host lifetime; offline writers hold the same scope lease through their evidence check and atomic save.

Authentication is mutual. The server verifies the connecting client's current-user SID and executable image identity before accepting a request. The client verifies the server's SID, live PID, executable image path, control schema, registry scope, and liveness before sending a management body and again before accepting the result. A different build directory, mismatched scope, squatted endpoint, or identity change is rejected as untrusted. The discovery pipe accepts only an identify request and cannot execute a mutation.

The control pipe is independent of the status pipe. `codlet status [--json]` remains a read-only Host snapshot and is not upgraded by this contract into a lifecycle control channel.

`codlet doctor` may use the same scoped pipe's pure read-only `Inspect` request
to obtain one authenticated owner publication. It never prepares/submits a
receipt or executes renderer work; actual provider registrations and target
activation facts are documented in [DOCTOR_RUNTIME.md](DOCTOR_RUNTIME.md).

## Implementation and verification status

The current implementation is represented by [plugin_cli.rs](../src/plugin_cli.rs), [runtime_control.rs](../src/runtime_control.rs), [plugin_control.rs](../src/plugin_control.rs), [plugin_lifecycle.rs](../src/plugin_lifecycle.rs), [renderer/management.rs](../src/renderer/management.rs), [plugin_watch.rs](../src/plugin_watch.rs), [probe.rs](../src/probe.rs), [windows/control_pipe.rs](../src/windows/control_pipe.rs), and [windows/control_scope.rs](../src/windows/control_scope.rs). Manual control, IPC, and watcher regression are covered by the final validation record; ordinary production launch+watch acceptance remains open.

The [2026-09-08 isolated manual-control acceptance](RUNTIME_CONTROL_ACCEPTANCE_2026-09-08.md) records startup, dependency rejection, reload closure, enable/disable persistence, multi-target generation changes, receipt-free lab stdin sequencing, and clean shutdown. It does not exercise the production control named pipe or a watcher; native fixtures cover the production pipe. Thus the native fixtures validate IPC, while this report validates manual lifecycle behavior; the final watcher/full-suite result is recorded separately and does not close production gates.

Final validation coverage is:

- parser and JSON coverage for all four commands, optional `--json`, invalid ids, unknown flags, and opaque receipt handling;
- one-submit-only behavior, read-only `operation` queries, uncertain timeout recovery, stale/expired/evicted receipts, the eight-job queue limit, and the 128-record retention bound;
- bidirectional SID/image authentication, registry-scope isolation, lease ordering, discovery-only behavior, and separation from status v1;
- enable persistence only after all target activations, no implicit dependency enablement, dependent rejection on disable, persist-before-teardown, and degraded disable results;
- reload closure selection, unrelated-plugin preservation, fresh generations on replacement and rollback, grant/registration revalidation, and rollback/degraded target diagnostics;
- positive offline no-Host evidence, rejection for an unidentified older Host, next-launch reporting, and mandatory Host presence for reload.
- explicit `launch --watch` opt-in, ordinary-launch no-watch behavior, four-source round-robin polling, quiet/two-sample settling, CLI priority, closure coalescing, loaded-generation baselines, paused registration diagnostics, and same-content failure suppression.
- whole-closure settling, the execution-time loaded-catalog path guard, and the shared bounded registry read/write limit.

The final batch passed `cargo test --locked --all-targets --all-features` with 289
tests and one explicit real-production-start gate left default-ignored;
`node --test tests/*.test.mjs` passed 63 tests; Clippy, fmt, diffcheck, and
`cargo build --locked --release --bins` passed. The 12 watcher regressions were
7 clock/file-state tests, 1 execution-path guard, 1 dual-target end-to-end test,
2 parser/scheduling tests, and 1 registry-limit test. The final watcher source is
`851395a`, while the isolated manual-control evidence uses `5a0be1e`; see the
[final verification summary](../.codlet-artifacts/runtime-watch-2026-09-08/verification.json).
These results validate the candidate and leave ordinary production launch+watch,
production GUI, M0/M1, `DEFECT-001`, and `DEFECT-002` gates open.
