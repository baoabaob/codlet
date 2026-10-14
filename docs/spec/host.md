# Managed Host

Each ordinary active Host generation runs in its own Core-owned Node process. A
[directory package](plugin-format.md) declares `host.entry` and its execution mode.
Host-only packages need no Renderer, GUI or installed Codex adapter. Core supplies
the Codex semantic SDK and its implementation providers. A dedicated raw
client-source entry uses the temporary extraction executor and Core-owned bridge
described below. [host.d.ts](../../types/host.d.ts) is the public method/DTO reference.

## Execution modes

New ordinary compute packages should declare `"host": {"entry":"dist/host.cjs","mode":"sdk"}`.
SDK mode needs no full raw Host grant. It executes bundled CommonJS in a compute
realm with local JavaScript wrappers and a JSON/callback membrane for Core APIs.
Ambient `process`, `Buffer`, Node/disk module loaders and raw HTTP clients are absent;
dynamic/static import syntax is rejected before evaluation. Bundle dependencies
ahead of time. Timers, byte streams, callback handlers, signals and opaque Core scopes
cross only the supported membrane. File/network/process/CDP calls retain their own
declared permissions and applicable scopes.

`"mode":"node"` explicitly admits full Node and requires `host.raw`. It can use
Node modules and direct current-user OS access outside the SDK brokers. An omitted
mode preserves legacy full Node admission under `host.process`; no stored grant or
data is silently converted to `host.raw`. A migration to explicit Node requires a
newly reviewed raw grant. SDK mode does not inherit a saved raw grant's ambient APIs.
The compute realm uses Node `vm`: this is a trusted-code API boundary, not an OS or
hostile-code sandbox. See [permissions](permissions.md) for the enforced/review boundaries.

## Runtime and lifecycle

Core selects the fixed Node runtime described by its runtime manifest, verifies its digest and controls bootstrap/flags/transport. It prepares a private cached copy from an exactly verified official-client runtime or the pinned download. It does not execute an arbitrary PATH or embedded client Node. Plugins do not supply arbitrary host commands. Native addons and runtime TypeScript stripping are disabled. Dangerous inherited Node/OpenSSL preload settings are removed; ordinary current-user JavaScript remains trusted native code.

The bootstrap compiles the immutable main source at its original filename. Full Node
mode preserves package-relative `__dirname`, `require` and resource lookup; its other
dependency files are not an atomic snapshot. SDK mode has no disk imports. Verified
Core bootstrap module bytes are captured once for each started process; a running
process retains its old bytes until replacement. Core owns JSONL request identity,
readiness, events, cancellation and shutdown; plugin authors do not write the protocol.
`context.log` and `console` use stderr. Raw stdout writes can fail a Node Host.

```js
module.exports = {
  async activate(context) {
    const info = await context.system.info(); // declare/grant host.system
    context.log.info(info.os, info.architecture);
  },
  async deactivate(cleanup) {
    // Release this generation's owned page effects within cleanup.remainingMs().
  }
};
```

Activation has a five-second readiness budget. Core calls are available during asynchronous activation, but the provider is not active until ready. Ordinary requests use their original deadline (at most 15 seconds); nested calls inherit the stricter parent budget. Stopping aborts the ordinary signal and retires requests/subscriptions before invoking `deactivate(cleanup)`, including when asynchronous activation has not resolved. Blocking JavaScript can be forcibly terminated.

Cleanup has its own signal, `remainingMs()`, plugin metadata, root and logger. It admits only `cleanup.cdp.request(...)` or equivalent `cleanup.core.request('cdp.request', ...)`, under current `cdp.raw` authority. No new subscription, OS work or renewed deadline is granted. Delivery and all cleanup calls share at most **1,500 ms**. Native process/descendant/IO retirement has a separate total stop boundary of two seconds; an unconfirmed exit yields `cleanup_incomplete`, not successful replacement. See [permissions](permissions.md).

Core can forcibly end its process scope (Windows Job / macOS process group) and reclaim managed sessions. A cleanup acknowledgment or process exit does not certify reversal of arbitrary page or OS effects. Late callbacks cannot deliver into the next generation. A malformed protocol or failed active event callback can fail this Host; already-retiring callback failures cannot abort the separate cleanup phase.

## Public surfaces

| Surface | Contract |
| --- | --- |
| `plugin`, `root`, `signal`, `log` | Authenticated ID/version/generation, original package directory, ordinary retirement signal and stderr logging |
| `rpc` | Exact capability request/provide/notify and opaque Target scopes; see [RPC](rpc.md) |
| `codex` | Core-owned Codex semantic API 1; every method still consumes the caller's declared capability/grants |
| `cdp.request(method, params?, options?)` | Raw CDP result; optional sessionId/deadline/signal; no official application-method allowlist |
| `cdp.subscribe(filter, onEvent, onEnd?)` | One current subscription; root/all or an owned session, with optional 1–32 distinct exact event names |
| `core.request(...)` | Versioned low-level Core channel; use typed helpers when available |
| `fs.readText/readDir/stat` | Legacy bounded UTF-8 read broker under explicit read roots |
| `network.fetch` | Legacy bounded GET/HEAD text response for an exact approved HTTP(S) origin |
| `process.run` | Legacy finite child execution with argument array and explicit executable |
| `system.info` | OS, architecture and logical CPU count only |
| `services` | Shared storage, credentials, files, tasks, events, streaming processes, network and desktop APIs; see [services](services.md) |
| `traffic.openChannel/openHttpChannel` | Private explicit HTTP/SSE or WebSocket channels; see [traffic](traffic.md) |
| `traffic.registerInterceptor/inspect` | Generation-bound interception and current attachment status; exact-origin grants required |

The legacy fetch does not follow redirects, use inherited system/environment proxies or accept hop-by-hop/proxy overrides. The newer Core network profile API is separate. Legacy reads, HTTP bodies and combined process output default to 64 KiB and allow at most 256 KiB; the full encoded broker request/response is also bounded. `readDir` defaults to 128 entries, maximum 256, with a truncation flag. Legacy `process.run` has no interactive stdin or arbitrary cwd/env override; use `services.processes` for approved streaming process control.

Raw flattened sessions obtained through Core attach are owned by this Host generation. Cancellation after attach dispatch does not forget a late session: Core retains the receipt and detaches it. If the remote attach never returns or a known session cannot be reclaimed within the absolute retirement budget, Core reports incomplete cleanup and may close the shared CDP connection to end its remote session namespace. That failure affects the current Core session, not merely one plugin.

## Explicit state lifecycle

Optional exports `saveState(context)` and `restoreState(snapshot, context)` transfer
`{schema: positive uint32, value: JSON}`. Each Host snapshot is bounded to 256 KiB;
only finite, acyclic plain JSON is accepted. Functions, DOM objects, getters, promises,
streams and external process objects are rejected. Authors must keep credential
secrets, consent and pending effects out of snapshots; JSON validation cannot identify
a secret serialized as an ordinary string.

`HostRuntime.begin_snapshot(id, generation)` pauses new ordinary SDK/RPC admission
with `core_updating`, drains accepted invocations and pending requests, then invokes
`saveState`. The JS checkpoint has a 1,400 ms budget inside Core's 1,500 ms receipt
budget. A snapshot hook cannot introduce new SDK writes. Core-authenticated retiring
renderer cleanup and its bound descendants remain admitted while paused; business
parameters cannot request that exception. Host's separate finite deactivate cleanup
retains its current raw-CDP grant and deadline checks.

Failure or timeout leaves the old generation owned. Before keeping it running, Core
sends `begin_resume` and waits for `{resumed:true}`; a failed resume is explicit,
not evidence that ordinary admission reopened. A Host without `saveState` returns
`null` so ordinary legacy reload remains available without promising state transfer.
Declared hooks that fail or return invalid state reject the checkpoint.

`begin_start_restored(plugin, snapshot)` calls activate, then restore, and only then
publishes readiness. `context.restoringState` is true during activate/restore and false
after successful restore; consumers use it to suppress autorun effects. Combined
replacement captures Host state before renderer state, preserves each renderer
document's state, and retains the old source/state for rollback if candidate restore
fails. Late responses and snapshot completions cannot revive the retired generation.

Session-preserving Core JS updates require explicit state support from active consumers.
Missing support or incompatible binary/runtime changes defer activation to the next
natural start. A deferred receipt describes locally staged bytes, not installed live
components. Online receipts list applied and retained components separately; the
compiled Core version can remain unchanged. An unknown takeover or persistence
receipt is not automatically replayed. State transfer does not serialize arbitrary
external effects or establish exactly-once execution of unknown native writes.

Whole-Core admission is a separate, Core-authenticated transaction lease. Host
preflight reserves its identity while old traffic remains usable; only after every
Host pause receipt confirms does the shared broker hold new ordinary work. New
candidate and rollback processes inherit that identity even without a state snapshot.
Their finite activate/restore lane may rebuild owned resources, but timers lose that
exception before readiness. An ordinary snapshot resume cannot clear the Core lease.
Accepted invocation descendants and authenticated retiring cleanup retain their lane.

Live plugin-owned traffic registrations, sources, channels, exchanges or pending peer
calls make whole-Core activation return `core_admission_traffic_busy` and defer until
the next start, retaining the current owner. Snapshotting under the lease rechecks
these resources. Existing stream reads/cancellation and accepted exchange forwarding
remain usable during a hold; ordinary reload retains its previous retirement behavior.
Core holds new SDK operations, not pure event delivery: event callbacks continue,
and their attempted new writes receive `core_updating`.

Release starts only after the selected Host/Renderer owners are ready and Native
source takeover is confirmed. Host receipts are queued in bounded batches, and the
shared lease clears only after every release acknowledgment. This is not an atomic
cross-process unlock: an acknowledged Host peer may resume before another Host.
Partial release failure re-holds all captured owners and reports an unknown result;
it does not replay effects or roll back already confirmed source ownership.

Core's Desktop provider transfers only logical permission-guard thread and owner
identities. Restored guards reread the current Native canonical permissions before
dispatch; they never serialize or reapply Native permission settings. A fresh
authenticated consumer generation reclaims its guards, and normal owner retirement
removes them. Accepted permission/configuration/submission work must settle before
the provider checkpoint succeeds.

Whole-Core replacement also pauses the reviewed local renderer request ingress
before retiring providers. A private, same-document API 1 forwarding stub retains
the existing Native postbox/client and at most 64 queued requests / 4 MiB. It retains
original request identity, pending-record identity and deadline (at most ten seconds),
then admits still-live queued requests once through the acknowledged current provider
after a determinate applied or rolled-back result. Already accepted requests and
responses are not replayed; responses continue while admission is paused. Missing
support, changed document/transport ownership, or an unknown takeover cannot be
treated as a successful pause/resume. Ordinary provider disable restores Native's
original hook when no update owns the gate.
New documents inherit the trusted renderer admission identity before attaching their
Native gate. A changed target/document set remains held until explicitly resolved.

The frozen API and minimal forwarding stub are retained Core ABI resources during
the transaction, not serialized JavaScript closures. New providers replace their
dispatch and gate implementation. Changes to this resident stub's ABI require next-start
activation; online replacement does not promise to unload every existing JS closure.

A Host that provides `codlet.client.launch@1` at Runtime scope may export `clientSource({features, signal})`, returning `{code}` for its client entry. Core owns a process-bound bridge established before application entry independently of the plugin. Enable, reload, update, rollback, disable and revocation manage this entry in the same package receipt as Host and Renderer. Replacement validates the current native module fingerprints before retiring previous hooks; uncertain operations are queried by their original ID, never replayed. External launch entries require `cdp.raw` plus explicit Node/`host.raw`, or the preserved omitted-mode/`host.process` alias. SDK mode does not admit a raw Native launch entry. Core's internal provider ownership is separate from external grants. The plugin's immutable source and full registration are revalidated before and after execution.

The bridge records original CommonJS module fingerprints and scoped resolvers. This lets a reviewed replacement attach to modules already initialized without retaining an open Node inspector. Client transport routes can outlive a plugin instance as forwarding resources; plugin callbacks and module subscriptions retire with their generation. Backend reconnection, when required for a previously uninstrumented verified local process, must not interrupt an active turn, replay native requests or restart the desktop.

Core v1 loads `clientSource` only. The retired `prepareClientLaunch`, `beforeClientResume` and `attachClientLaunch` executor is absent; optional plugin exports for older consumers do not create another startup path. Historical adapter IDs are reserved Core capability aliases; old external registrations and files are preserved without executing a second provider. There is no separately installed adapter requirement for ordinary SDK consumers.

If its effective Host provides contain exactly that launch capability and its effective Host requirements are empty, Core treats it as a dedicated Native launch entry. It starts no ordinary Host process and skips ordinary Host activation/readiness, including when the same package has a renderer. Its snapshot, grants, management identity and reload coordination remain checked. A combined package's renderer retains its ordinary capability dependencies and lifecycle. Adding another Host capability or requirement opts back into the existing ordinary Host lifecycle; launch capability selection remains private to Native. See [traffic](traffic.md) for deadlines, allowed arguments, exact-child verification, and revocation behavior. Ordinary Host plugins need only their existing activation exports.

## Resource bounds and observations

Current Host limits include 16 active process owners, 64 retained terminal observations, four pending outbound capability/raw/OS requests per category, four provider invocations and 256 endpoints per Host. The OS broker has four workers, eight queued operations and 16 outstanding/unconsumed receipts. Limits reject overload; they do not create unbounded cancellation workers.

Execution observations report actual PID, generation, starting/active/stopping/failed/exited state, cleanup phase and confirmed exit facts. Starting/stopping may still own resources. Bounded terminal history can be truncated, so an absent observation is not proof that a plugin never ran. Host and Renderer observations keep their actual origin; neither substitutes for the other's state. Entry replacement and recovery are coordinated through [management receipts](management.md).
