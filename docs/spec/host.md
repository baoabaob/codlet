# Managed Node Host

Each active Host generation runs in its own Core-owned Node process. A [directory package](plugin-format.md) declares `host.entry` and obtains `host.process`; Host-only packages need no Renderer, GUI or Codex adapter. [host.d.ts](../../types/host.d.ts) is the public method/DTO reference.

## Runtime and lifecycle

Core selects the fixed Node runtime described by its runtime manifest, verifies its digest and controls bootstrap/flags/transport. It does not fall back to PATH, system Node or the client's embedded executable. The distribution supplies Node once; plugins do not supply arbitrary host commands. Native addons and runtime TypeScript stripping are disabled. Dangerous inherited Node/OpenSSL preload settings are removed; ordinary current-user JavaScript remains trusted native code.

The bootstrap compiles the immutable main source at its original filename, preserving package-relative `__dirname`, `require` and resource lookup. Other dependency files are not an atomic snapshot. Core owns JSONL request identity, readiness, events, cancellation and shutdown; plugin authors do not write the protocol. `context.log` and `console` use stderr. Writing directly to protocol stdout can fail the Host.

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

A Host that provides `codlet.client.launch@1` at Runtime scope may additionally export `prepareClientLaunch` and `attachClientLaunch`. Only a selected, enabled provider with `host.process` and `cdp.raw` receives the private launch context. These optional phases use the same immutable Host source snapshot in a short-lived executor before ordinary activation; they have no general Core RPC endpoint. See [traffic](traffic.md) for deadlines, allowed arguments, exact-child verification, and revocation behavior. Ordinary Host plugins need only their existing activation exports.

## Resource bounds and observations

Current Host limits include 16 active process owners, 64 retained terminal observations, four pending outbound capability/raw/OS requests per category, four provider invocations and 256 endpoints per Host. The OS broker has four workers, eight queued operations and 16 outstanding/unconsumed receipts. Limits reject overload; they do not create unbounded cancellation workers.

Execution observations report actual PID, generation, starting/active/stopping/failed/exited state, cleanup phase and confirmed exit facts. Starting/stopping may still own resources. Bounded terminal history can be truncated, so an absent observation is not proof that a plugin never ran. Host and Renderer observations keep their actual origin; neither substitutes for the other's state. Entry replacement and recovery are coordinated through [management receipts](management.md).
