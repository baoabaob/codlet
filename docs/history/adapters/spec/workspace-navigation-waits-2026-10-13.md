# Navigation confirmation: observed phases and remaining attribution

This review reads the already captured Native acceptance profile and runs the production navigation state machine offline. It does not start, stop or operate a client, change production source, weaken input ownership checks, or certify paint/Native history streaming.

## Existing Native phase evidence

Source: `X:/codlet-split-workbench/.checks/native-comparison/consumer-55847389-ba72-48f3-a659-a743989aab4e/acceptance-summary-utf8.json`, sample `consumer-55847389-ba72-48f3-a659-a743989aab4e`, frozen consumer hash `80e4553f869e86ae914b4932197c0fedf6b4f36e83988b3cef24f00e187af97f`.

The explicit 100-operation measurement windows report input-confirmation median/P95:

| Window | Median | P95 | Min |
| --- | ---: | ---: | ---: |
| Zero before | 162.4ms | 206.8ms | 141.9ms |
| Five panes | 199.0ms | 226.7ms | 172.3ms |
| Zero after | 152.1ms | 165.2ms | 136.1ms |

These are end-to-end programmatic selection through verified input/focus/read-back. The additional rAF timestamp is separately measured and is not paint. The before/after drift and the different execution paths prevent treating their difference as pure Adapter or pure split-plugin cost. Zero-pane selection directly calls navigation; five-pane selection also runs the consumer's controller/input coordination.

The profile's `selection` and nested `input.navigate` events allow a more useful decomposition. The read-only analyzer matches all **129 complete selections**, with no dropped events or skipped selections, to one nested input operation by time and synthetic alias. This aggregate includes entry/warmup/cycle activity; it is **not an isolated five-100 window** and contains no corresponding controller profile for the zero-pane direct path.

| Recorded interval | Median | P95 | Meaning |
| --- | ---: | ---: | --- |
| Selection start → input token start | 5.0ms | 11.9ms | Consumer prechecks plus synchronous `navigation.open`, including Adapter validation and Native dispatch |
| Input token start → executed | 1.9ms | 3.5ms | Promise observation and accepted-selection work |
| Executed → committed | 179.2ms | 214.8ms | Awaiting strict input confirmation, including checks, scheduling, Native state availability, surface publication and consumer read-back |
| Committed → consumer binding marker | 0.1ms | 0.2ms | Consumer post-confirmation coordination |
| Consumer binding marker → focused | 5.2ms | 11.6ms | Strict focus check plus DOM/Native focus work |
| Selection start → input ready | 193.7ms | 231.1ms | Complete matched controller selections |

Quantiles across intervals are not additive. In the captured consumer, `input.navigate.start` is recorded **after** `navigation.open` returns (`consumer/renderer.js:769` vs `:784`), so it excludes that call's synchronous work. The outer selection token (`:1704`) precedes the call and recovers that missing interval. A small input-token-to-executed value alone would understate synchronous dispatch cost.

The dominant recorded interval is executed-to-committed. It is not yet divided into Native work, queue delay, observer wakeup delay, binding inspection, or synchronous surface/geometry publication. The data does not justify labelling all 179ms as Adapter CPU, backend latency, or Native render cost.

Analyzer and derived report:

```powershell
node tests/fixtures/workspace-acceptance/analyze-native-selection-profile.mjs '<absolute acceptance-summary.json>'
```

`.artifacts/workspace-navigation-waits/profile-b626fadf-fc64-4ed9-b54f-374a09f53337/report.json` pins the input file's bytes and retains only phase durations and numeric operation aliases. It starts no Native client and copies no message/draft content.

## Code-path observations

- `workspace-navigation.js:61-64` performs composition/current-binding inspection **before** `op.started`; existing `navigation.executed`/`navigation.committed` duration points also exclude this first precheck. New phase measurements should begin at public call entry.
- `thread-navigation.js:21-25` avoids the metadata request for a correctly identified cached local thread. The uncached path can await `thread/read`; it should be counted separately from a warm navigation. The opener does not wait for Native resume or composer readiness.
- `workspace-navigation.js:70-74` resolves executed after Native dispatch, then installs its operation-scoped observer and schedules a microtask and one visible-document rAF. Its 5-second timer is an error deadline, not a 100ms success delay.
- `workspace-navigation.js:26-38` confirms only when current route, local Thread/Route/composer scopes, editor controller and submit identity match. `pulse()` returns when binding is pending. The queued rAF is not automatically rearmed after a pending read; later checks rely on DOM mutations or workspace reconciliation. A state becoming valid before the next relevant notification can create an observation gap.
- `workspace-native-input.js:23-77` inspects only the main editor's committed ancestry and bounded input branch (2048 nodes). `host-discovery.js:46-82` proves current-root edges with bounded parent/sibling checks; it does not scan all transcript descendants. Repeated checks still have a measurable cost and should be timed, including unsuccessful pending checks.
- `workspace.js:103-112` publishes the proven input's surface before committed resolves. That can include lease reconciliation, seven role geometry reads and snapshot callbacks. `geometry()` uses `getBoundingClientRect`, which may synchronously charge layout/style work; zero style writes in the consumer do not prove these reads are free. Keep this publication ordering: the successful acceptance depends on receipt and `getSurface()` agreeing immediately.
- The pinned Native DF/AppNavigationSignalBridge/local-navigation entry is synchronous at the dispatch boundary. The inspected entry functions do not insert a fixed 100ms await; they do not describe the whole subsequent Native render/subscribe/editor lifecycle. No claim about unseen Native work follows from this static inspection.

## Offline scheduler separation

`analyze-navigation-waits.mjs` runs the production `createWorkspaceNavigation` in jsdom with injected synthetic verified bindings and a stub cached manager. It tests **observation/scheduling**, bypassing real Native binding discovery, geometry, React commit and backend work. It adds no instrumentation or timers to production.

```powershell
node tests/fixtures/workspace-acceptance/analyze-navigation-waits.mjs
```

Report `.artifacts/workspace-navigation-waits/analysis-2bf7ee3a-f1cd-4232-93d6-9a6055664274/report.json` pins the inspected production sources and marks Native evidence false:

| Controlled synthetic case | Commit observed | Binding ready → commit observed |
| --- | ---: | ---: |
| Binding valid at synchronous dispatch | 1.74ms | 0.84ms |
| Binding and DOM notification both requested at 130ms | 138.04ms | 1.07ms |
| Binding requested at 130ms, DOM notification at 170ms | 180.00ms | 47.19ms |

Timer delivery is subject to Node scheduling, so actual injected timestamps are retained. This demonstrates that the navigation state machine does not impose a fixed 100ms minimum and that ready-state time and observation delay are separable. The deliberately delayed notification is a test condition; it does **not** establish a 47ms notification delay in the actual Native profile.

## Priorities for another authorized Native measurement

First add private, disabled-by-default phase points rather than changing readiness semantics. Reuse the existing bounded metrics ring and numeric aliases; record no text, paths, raw scope/editor objects, or private notifications. Normal activation must remain without instrumentation clocks, storage, observers or timers.

1. Public call entry; first composition/binding check end; optional metadata begin/end/count; Native dispatch begin/end; executed.
2. Each pending pulse's wake reason and check duration; first valid binding; count/duration of unsuccessful checks. Measure event-loop scheduling separately where possible. Without an independent ready-state timestamp, retain the rest as unallocated waiting rather than assigning it to Native CPU.
3. Confirmed surface reconciliation, geometry reads and snapshot publication begin/end; committed; focus begin/end. Keep Core/RPC scheduling outside Renderer-native timing and label it separately.

If observation delay is material, an operation-scoped rAF that rechecks pending binding until commit/abort/timeout is a candidate. It would reduce dependence on a later DOM mutation, but can add repeated binding scans and compete with Native rendering. Compare the existing path and that candidate in the same source/profile and interleaved windows; report pending-pulse count/CPU and complete cleanup. A verified Native state/commit notification could be preferable if a suitable lifecycle signal actually exists. Neither candidate is implemented or claimed faster here.

Preflight deduplication within one synchronous call and narrower pending-stage checks are secondary candidates. The current Native aggregate's pre-input interval is median 5ms/P95 11.9ms, so they do not explain or eliminate the dominant 179ms interval by themselves. Never cache across a changed committed root/editor/scope or bypass the cold-path post-await IME check, stale revision checks, full input ownership, or surface consistency.

The result is a measured location for further work, not a claimed fix: **separate the executed-to-committed interval first**, then optimize only the stage shown to dominate it. Split retains layout/instance/cache policy and its own CPU/geometry/render budget; Adapter retains generic binding and observation costs.

Private phase points and a bounded report reader have subsequently been implemented and verified offline; see [the precise definitions, retention limits and checks](workspace-navigation-phase-points-2026-10-13.md). The scheduling candidates above remain unimplemented and unmeasured in Native. The closed profile was not reopened.
