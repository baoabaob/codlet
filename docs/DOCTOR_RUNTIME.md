# Doctor Runtime Inspection

`codlet doctor` and `codlet doctor --json` retain the additive
`codlet.doctor/v1` report. Static package, executable, process, registry, catalog,
plugin-validation, and dependency checks remain independent from runtime
observation. When the current registry has a matching Host that supports the
versioned inspection requests, doctor adds a read-only runtime sample; it does not
change the public `codlet status` schema or wire contract.

The current client prefers `InspectExecution`, which adds independent JS process,
cleanup and retained-exit evidence under `runtime.hostProcesses`. An authenticated
older Host can fall back to the original `Inspect`; see the
[host inspection extension](HOST_INSPECTION_2026-09-10.md). The renderer/kernel
interpretation below remains unchanged.

## Collection boundary

Doctor derives the registry scope from the current `%LOCALAPPDATA%\Codlet\config.json`
path and queries the scoped authenticated control endpoint with `InspectExecution`,
falling back to `Inspect` only on an authenticated compatibility rejection. The
collection path does not acquire a mutation lease, reserve or submit a receipt,
execute CDP, read plugin source to infer loaded providers, or start/stop/attach
to Codex. It only reads one Host publication already owned by the foreground
runtime. The Host publisher and the response must agree on Host PID, Host
incarnation, and registry scope before the sample is accepted.

The control response keeps the existing schema version and old command replies
unchanged. Only inspection responses may carry the additive `inspection`
object; only `InspectExecution` adds `host_inspection`. These control-pipe operations are separate from status v1; status v1
continues to serve its existing sampled snapshot.

## Host selection and unavailable states

The runtime result is independent of the static report:

| Situation | Runtime result | Static doctor exit |
| --- | --- | --- |
| Matching Host returns authenticated `Inspected` | Evaluate its one publication | Static failures and fresh runtime issues only |
| No Host for this registry | `status: "not_running"`, runtime checks unavailable | No new failure solely for missing runtime |
| A Host for another registry scope | `status: "other_registry"`, runtime checks unavailable | No new failure solely for another scope |
| Legacy Host exposes status but no Inspect | `status: "unsupported"`, runtime checks unavailable | No new failure solely for unsupported legacy Host |
| Busy, timeout, untrusted identity, stale identity, malformed/oversized response, or other transport failure | `status: "unavailable"` with a `runtime_*` issue | `failedChecks` includes `runtime`; exit code is 1 |
| Authenticated Inspect response exceeds the 256 KiB response bound | `status: "unavailable"`, `runtime_inspection_too_large` issue | `failedChecks` includes `runtime`; exit code is 1 |

An Inspect response without a trustworthy snapshot is unavailable. Doctor does
not turn a missing, other-scope, or legacy-unsupported runtime into a static
configuration failure, and it never falls back to disk declarations as proof of
loaded runtime state.

## What the sample means

The native `RuntimeInspection` is one authenticated Host publication:

- `providers` are the current capability-kernel registrations that have actual
  non-empty `provides`, including their provider kind, generation, declared
  capability descriptors, and truncation flag. They are not `provides`
  declarations reread from plugin files.
- `targets` are the owner’s current target/session records with session liveness,
  document epoch, recovery state, scope state, and observed plugin lifecycle,
  generation, context, activation, and active fields. Observed consumer plugins
  remain in these target records even though they are not provider entries.
- `sequence` and `sampled_at_unix_ms` identify the publication. Doctor records
  `queried_at_unix_ms`, age, freshness, the five-second freshness limit, and
  whether the sample is complete.
- `recent_events` is a bounded history tail from the same publication. It is
  historical context and does not by itself mean that the current plugin is
  failing.
- `sample` also carries Host state, Codex identity when available, lifecycle
  busy state, and termination text. Compatibility and GUI readiness remain
  unprobed.

The owner publishes snapshots on lifecycle transitions, context changes, and
its normal roughly 50 ms foreground loop. Doctor does not create a new sample.
An age above 5 seconds is `stale`; a query timestamp before the publication is
`clock_skew`. `Starting`, `Terminated`, `lifecycle_busy`, an incomplete sample,
and target recovery/transition states describe an observation that is not ready
for an activation verdict. These states do not become plugin errors merely
because the sample is old, future-dated, busy, starting, terminated, incomplete,
or showing a transition.

`lifecycle_busy` is deliberately conservative and global to the publication. A
management operation, owner lifecycle work, or any target with
`recovery_pending` defers the current readiness verdict for every target in the
sample. The target rows and their observed plugin generations/lifecycles remain
available; only the readiness assessment is blocked.

Only a fresh, complete, quiet sample can produce runtime activation issues. In
that case doctor compares each actual kernel provider registration and generation
with the plugin observed on the same target publication. It can report a
generation mismatch or an inactive/not-observed actual plugin, with bounded
examples and target/provider identifiers. An observed inactive consumer is also
a runtime activation failure; doctor does not infer a missing consumer from disk
or invent an expected generation. `providerReady` evaluates actual providers
only, so a provider can be ready while a consumer failure is reported separately
in `runtime.issues`. `providerReady` distinguishes
`activation_ready`, `activation_unready`, partial target readiness, no targets,
and blocked observation states; it is not a GUI mount or Codex compatibility
verdict. Endpoint health and provider endpoint responsiveness are also
unprobed.

## Report shape and field naming

The doctor report adds runtime `sample`, `issues`, and `recentEvents` under the
existing `runtime` object. Doctor’s aggregate fields use camelCase, including
`hostPid`, `sampledAtUnixMs`, `queriedAtUnixMs`, `pluginGenerations`, and
`providerReady`. The nested native target records retain their native snake_case
fields such as `target_id`, `session_id`, `document_epoch`,
`recovery_pending`, `scope_active`, and plugin `activation_confirmed` / `active`.
Native Inspect DTOs similarly retain snake_case names. This is an additive
doctor aggregation rule; it does not alter status v1.

Sampling is bounded. Inspect retains at most 256 providers, 128 capabilities per
provider, 1024 capabilities in total, 128 targets, and 256 plugins per target.
Identity fields are limited to 1024 UTF-8 bytes. An overlong target, session,
plugin, or version identity is omitted from the native Inspect record as a whole;
it is never truncated, concatenated, or used as a shortened join key. Omitted
records make the sample incomplete rather than proving that the target or plugin
does not exist. If the serialized Inspect response exceeds 256 KiB, the control
status is `inspection_too_large` and doctor reports an unavailable runtime issue.

Doctor can therefore show static desired configuration and authenticated current
runtime evidence in one report while keeping their bases separate. A successful
runtime observation still does not close M0/M1, prove GUI compatibility, endpoint
health, ordinary production launch or launch+watch behavior, or complete M1c/doctor
as a whole; it only reports the verified owner publication available at query time.

The implementation boundaries are split across [runtime_inspection.rs](../src/runtime_inspection.rs), [diagnostics/runtime.rs](../src/diagnostics/runtime.rs), [probe.rs](../src/probe.rs), [runtime_control.rs](../src/runtime_control.rs), and [windows/control_pipe.rs](../src/windows/control_pipe.rs).

## Final validation record

The final validation ran against source commit
`0802046e8ce6227547b248ddbe073d37f73ded13`. Locked Rust validation with all
targets and features passed 307 tests with 0 failures; one existing production
M0 startup gate remained ignored by its established convention. The grouped
counts were: lib 166, doctor CLI 6, doctor model 13, doctor runtime 7, fake child
46, lab 2, local-plugin CLI 7, local-plugin registry 16, local plugins 30,
plugin CLI 6, plugin registry 6, and status CLI 2. Clippy for all targets and
features with `-D warnings`, all-format `--check`, and locked release binaries
also passed; the release build took 12.54 seconds. JavaScript was unchanged in
this batch, so the existing Node 63-test result was not rerun and is not counted
as a result of this validation.

The release binary’s local read-only `codlet doctor --json` exited 0 and reported
`runtime.status: "not_running"`, package version `26.901.6511.0`, and a blocked
`launchPreflight` because the original Codex was already running. The registry
`config.json` was absent before and after the command, and the doctor did not
create it. The original Desktop PID 13460 and backend PID 27176 retained the
same PID and creation time before and after. Native pipe Inspect transport and
the two-target fake-child publications were validated in separate fixtures. No
real Codex or lab was started, and this record makes no real-GUI acceptance claim.
Evidence is stored under
`.codlet-artifacts/doctor-runtime-2026-09-08/`: `verification.json`,
`cargo-test.log`, `doctor-local.json`, `doctor-local-verification.json`,
`codlet.exe`, and `codlet-lab.exe`.

This record covers the runtime Inspect and local read-only doctor validation only.
Production M0/M1, `DEFECT-001`, and `DEFECT-002` remain open; M2 has not started.
It does not claim complete M1c, complete doctor, or release publication.
