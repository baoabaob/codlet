# Host deactivate and execution sampling

Host plugins can release their own CDP resources during `deactivate(cleanup)`.
The directory package, JS/TS build model, fixed Node runtime and public raw CDP
surface are unchanged. The optional cleanup argument is compatible with existing
zero-argument `deactivate` functions.

## Lifecycle contract

When an online stop/reload or the enclosing runtime stops a generation, Core
retires its ordinary pending CDP requests, event subscription and queued events.
The JS bootstrap aborts the ordinary `HostContext.signal`; saved ordinary
`context.cdp`/`context.core` calls reject with `host_stopping`.
An event or subscription-end callback already running when retirement begins
may reject because its ordinary request was cancelled. Such a late callback
failure cannot abort cleanup. Callback failures during activation or active
execution retain their normal fatal-error behavior.

The bootstrap then invokes `deactivate(cleanup)`. An unresolved asynchronous
`activate` Promise does not prevent this invocation. JavaScript that blocks the
event loop still cannot cooperate and is terminated by the native owner.

`cleanup` has a separate abort signal, `remainingMs()`, logging/root/plugin
metadata and two equivalent request forms:

```js
async function deactivate(cleanup) {
  await cleanup.cdp.request('Runtime.evaluate', {
    expression: 'delete globalThis.myPluginOwnedValue',
    returnByValue: true,
  }, { sessionId: ownedSession });
  await cleanup.core.request('cdp.request', {
    method: 'Target.detachFromTarget',
    params: { sessionId: ownedSession },
  });
}
```

Only Core's `cdp.request` primitive is admitted in this phase. Its raw CDP method
remains open; there is no official-adapter or application-method allowlist.
Subscriptions and ordinary activation/runtime calls are not admitted. Requests
use the same validated permission snapshot as the loaded owner, including
`cdp.raw`; cleanup does not add a grant or bypass validation.

Core owns a single monotonic deadline of at most **1500 ms** beginning with its
shutdown request. Delivery, local cleanup and every CDP request consume that same
window. Per-request timeouts are clamped to it; another request cannot renew it.
The bootstrap's remaining-time estimate is an upper bound, while the Core
deadline is authoritative. Requests use the existing bounded RPC queues and no
thread is created for each request.

On completion, error or expiry the bootstrap retires its cleanup requests and
signal and sends one shutdown result. An error exits with a nonzero code. At the
native deadline, Core terminates an unresponsive plugin Job and continues
confirming process/descendant exit and IO worker retirement. The existing
two-second resource-retirement boundary remains distinct from the cooperative
cleanup window. An unconfirmed retirement reports `cleanup_incomplete` and keeps
ownership; another generation cannot start over it.

The fixed RPC owner continues serving other plugins while one plugin cleans up.
Whole-runtime shutdown also pumps cleanup requests for all stopping hosts before
final joins. If an online stop has already entered cleanup, another stop keeps
that phase's pending replies and original deadline. Protocol faults explicitly
cancel the affected phase instead. Generation-specific pending requests and events are dropped at
retirement, so a late response cannot activate or deliver into a replacement.
CDP effects already accepted by the remote target are not automatically undone.

`HostOperationResult::Stopped` continues to report native exit facts: PID, exit
code, forced termination and joined workers. The execution sample separately
reports whether a cleanup acknowledgement completed, failed, timed out or was
unavailable. Neither a cooperative acknowledgement nor process exit certifies
that arbitrary page or operating-system effects were reversed.

## Public execution sample

`HostRuntime::execution_snapshot()` reads published scalar facts; it does not
execute a plugin, read its source or send CDP requests. The cross-platform DTOs
are defined in `plugin_execution.rs` and re-exported by `host_runtime`:

- `HostRuntimeSnapshot`: independent sequence and sample time, runtime stopping
  and owner-liveness flags, retained record limit, history truncation and plugins.
- `HostPluginSnapshot`: ID/version/generation, lifecycle state, PID/error,
  pending Core request/subscription/outbox counts, launching flag, cleanup and
  optional confirmed process exit facts.
- `HostCleanupSnapshot`: `not_started`, `running`, `completed`, `failed`,
  `timed_out` or `unavailable`; remaining budget, pending requests and error.

DTOs contain no `LoadedPlugin`, executable-source or package-path fields,
`Instant`, `Duration` or OS handles. Bounded diagnostic text retains the error
messages produced by the executor and plugin. Their field set is strict and serializable. Runtime
samples retain at most 16 current resource owners and 64 latest terminal records.
`history_truncated` becomes true after an earlier generation or terminal record
leaves this list; absence is never evidence that a plugin has never run.

`Starting` and `Stopping` still mean resources may be owned. `Failed` and
`Exited` are published after native process/Job/IO retirement. A completed cleanup
acknowledgement may therefore coexist briefly with `Stopping` while native
resources finish retiring. Sample sequence/time do not advance merely because a
consumer reads the snapshot; an unavailable owner cannot manufacture freshness.

## Example and targeted validation

[`examples/cleanup-host`](../examples/cleanup-host/README.md) keeps one raw CDP
session and one generation-specific global until stop, then removes its own
global and detaches. It demonstrates partial initialization cleanup without
depending on a renderer or official adapter. [`types/host.d.ts`](../types/host.d.ts)
defines the cleanup argument for TS authors.

Focused tests cover online and whole-runtime cleanup, initialization cancellation,
ordinary-call rejection, shared deadlines, delayed replies after replacement,
permission denial, exceptions, blocked JS, native retirement and bounded scalar
sampling. The raw-host fake CDP fixture can defer/release responses and record
requests while continuing to answer another plugin's pings. Bootstrap tests also
cover unresolved activation and the separate cleanup signal/request channel.

This package was verified with 16 unique Rust cases from `host_cleanup`,
`host_lifecycle`, `host_runtime`, the bounded snapshot unit and delayed-creation
unit, plus nine `host_bootstrap.test.mjs` cases, including active and retired
subscription callback failures. Changed subscription, protocol
fault and overlapping-stop assertions were rerun by their test name. No full
repository suite, real Codex launch or user registry mutation was used.

This remains ordinary current-user JS, not a safety sandbox. Cleanup is optional
cooperation under a finite lifecycle budget; detached targets, broken CDP,
protocol corruption and arbitrary plugin effects can limit what can be released.
