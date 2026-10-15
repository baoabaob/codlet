# Private phase points for navigation confirmation

The [captured Native phase analysis](workspace-navigation-waits-2026-10-13.md) located the dominant interval between executed and committed, without assigning it to a single layer. This change makes that interval easier to inspect in a subsequent authorized test. It adds private, opt-in measurements; it does not change scheduling, input readiness, routing, focus, the public receipt or the release gate.

Production activation supplies no `testPoints` option. Disabled instrumentation creates no recorder or diagnostic handler and reads no instrumentation clock. Enabled data uses the existing bounded ring (default 1024, supported maximum 4096), fixed fields and numeric operation aliases. It records no thread IDs, paths, messages, drafts, attachments, error strings, scope objects or editor objects. The aliases are independent of public navigation revisions: a rejected IME preflight can have a diagnostic alias without consuming a revision or superseding the pending operation.

## Measured stages

| Point / span | Meaning |
| --- | --- |
| `navigation.call`, `navigation.preflight` / `.failed` | Call entry through argument, lifetime, initial IME and current-input preflight. The total executed/committed measurements now start at call entry. |
| `navigation.input.read`, `.bind` | Existing main-editor discovery and identity projection. These are nested in some larger spans. |
| `navigation.input.pending.*` | Closed stage labels: editable, ancestry, scope, controller, submission, identity, binding, host or other. Stage diagnostics omit richer per-view/hook inspection. |
| `navigation.metadata.begin`, `.metadata` | Optional Adapter metadata request for a noncached identity; not all requests made by Native itself. |
| `navigation.dispatch.begin`, `.dispatch` | Existing Native local-thread dispatch, or the older nonstrict route path. |
| `navigation.execution.publish`, `.executed` | Immediate execution publication and receipt resolution. |
| `navigation.wake.*`, `navigation.pulse.microtask` / `.frame`, `.pulse` | Existing wake/coalescing paths and each actual confirmation pulse. These points add no extra wakeup or polling loop. |
| `navigation.input.inspect` | Native connection check and binding projection in each pulse. Includes Native getters as well as Adapter code. |
| `navigation.confirmation.wait`, `.input.confirmed` | Executed to the first verified binding, before confirmed-surface publication. Includes queue/state waiting and all checks in that interval. |
| `navigation.surface.scan`, `.control`, `.publish`, `.surface` | Confirmed surface lookup, lease reconciliation, public snapshot callbacks and aggregate publication. |
| `surface.geometry.complete` | Successful existing geometry reads, associated with the confirming operation when invoked by its surface publication. May synchronously charge layout/style work. |
| `navigation.committed`, `.focus`, `.finished` | Call-to-commit total, eligible/stale focus attempt duration, and failed/cancelled operation completion. Focus timing alone is not proof that focus succeeded. |

The Native diagnostic callback's `countsOnly` mode avoids its usual per-provider/dependency/hook view details. Existing diagnostic callers retain those richer details by default; normal input discovery supplies no callback. No new Native subscriptions, DOM observers, timer loops, editors or connections are introduced.

The strict full input pin, synchronous IME rejection before supersession, cold-path post-await composition check, explicit revision-aware focus and confirmed-surface-before-commit ordering remain intact. The receipt has exactly the same fields. Tests compare enabled/disabled observer/frame creation and cleanup, and prove that measurement aliases do not alter public revisions.

## Offline report reader

```powershell
node tests/fixtures/workspace-acceptance/analyze-navigation-waits.mjs
node tests/fixtures/workspace-acceptance/summarize-navigation-test-points.mjs '<absolute private-report.json>'
```

The summarizer accepts an existing private test-point report or the offline scheduler's `cases[].testPoints`. It never starts a client. Its per-operation output separates:

- Confirmation wait and the sum of **pulse inspection spans only**. Nested input-read/bind/pulse durations are not added again.
- The remaining time as **unallocated confirmation time**, which can include Native work, queues, workspace reads, scheduling and instrumentation. It is not labelled pure Native or CPU cost.
- Surface/geometry/publication durations and focus-attempt counts. Missing or unused timed stages are `null`, with separate observed request/dispatch counts.
- Ring retention and completeness. Wrapped/unfinished operations do not receive reconstructed wait numbers. An inconsistent subtraction is marked and retained as unknown.

For a longer test, read the bounded recorder between small batches and retain each immutable report with its source/run/profile pins. `written` versus retained samples exposes overwritten points. A single final 1024-point snapshot cannot certify that every phase of a 100-switch matrix was retained; increasing capacity remains bounded and does not remove the need to check completeness. Transport reports should use the consumer's bounded chunk reader rather than depending on one large JSONL payload.

## Executed checks and limitations

The normal bundles were rebuilt. 148 related offline tests passed, covering Workspace, strict navigation/IME, Native discovery/navigation/composer compatibility, Desktop/UI adapters and synthetic history. Five new regressions cover stage/wait separation without double counting, wrapped reports, preflight aliases/revisions, enabled/disabled lifecycle equivalence and lightweight diagnosis; the existing surface consistency regression also verifies correlated phase order and one geometry update.

Offline scheduler output: `.artifacts/workspace-navigation-waits/analysis-dc92269f-21ef-4781-a055-d15184522ead/report.json`. Its private phase reader output: `.artifacts/workspace-navigation-waits/phases-54d5f713-d234-48a2-bf21-e62a2ac10b9f/report.json`. The new points work in controlled synchronous-ready and delayed-state/notification cases. These are Node/jsdom conditions with injected bindings, not Native CPU, input-discovery, paint or latency improvements. The original Native phase evidence remains pinned to its older frozen source.

No profile was reopened for this change. The split chat's final acceptance remains `not-accepted`; subsequent actual Native phase data is required before choosing or claiming a scheduling optimization.

## Latest profile retirement acknowledged

The split chat archived its final acceptance in `X:/codlet-split-workbench/docs/consumer-final-acceptance-2026-10-13.md` / `.json` after consumer commit `629dd74`. The read snapshot used here has JSON SHA-256 `e4b8832bb2f2aa6fdaba33cbb6f8b5b576744246affbab417d6d3b87e74165c6` and Markdown SHA-256 `10f27985ea3e6398af85834387c527b545f71b6cdce1ff222c6144d881b700dd`.

Coordinator `1791857416908-16000` ended normally at `2026-10-13T03:30:46.287Z`, Host exit 0. The final records confirm zero scoped registrations and all 27 captured creation identities exited, with no rejected ancestry edges or manual termination. The bounded update-registration wait ended without installation confirmation or an automatic second client. These are endpoint/captured-cohort facts; short-lived processes between scans are not claimed covered. The Adapter chat only read those records and did not operate the retired profile.
