# Core capability RPC

Host and Renderer use the same Core-authenticated plugin identity, generation, dependency and scope model. Host→Host, Host→Renderer, Renderer→Host and Renderer→Renderer calls are supported. The provider defines method names and JSON business data; Core does not place Codex private page/task objects in the generic protocol. Types: [Host](../../types/host.d.ts), [Renderer](../../types/renderer.d.ts).

## Declaration and routing

A descriptor is `{name, api, scope}`. Calls must match the calling entry's exact `requires`; handlers must match its `provides`. Host providers support Runtime or Target. Renderer providers support Target and can consume both. Declaration placement for Host-only and combined packages is defined in [plugin format](plugin-format.md).

Core validates provider conflicts, missing requirements and actual entry cycles before activation. It resolves the provider generation once, including when waiting for readiness; a call is never silently rerouted to a replacement generation and waiting never extends its deadline. Combined Renderer activation depends on its own Host readiness. A Host can await an unrelated acyclic Renderer provider while the coordinator continues pumping RPC.

```js
const math = { name: 'example.math', api: 1, scope: 'runtime' };
context.rpc.provide(math, 'double', (params, invocation) => ({
  value: params.value * 2,
  caller: invocation.caller.pluginId
}));
// In another entry with the matching requires declaration:
const reply = await context.rpc.request(math, 'double', { value: 3 }, { timeoutMs: 1000 });
```

`request` returns the handler result or rejects with its bounded error. Host `notify` returns a Promise that resolves when the handler finishes, discarding its result; errors still reject. Renderer `notify` retains its synchronous void ABI without a response receipt; Core bounds delivery and records provider failures. Neither is a durable message queue. Renderer shorthand `request(method, params?, options?)` / `notify(method, params?)` remains available only when there is exactly one declared requirement.

## Runtime and Target lifetime

Runtime is a singleton scope within one Core run. A Runtime call made by a Renderer still belongs to its originating document and is cancelled when that caller document retires. Target identifies a current Core-observed target/document lifetime. Epochs are opaque values, not navigation counters. Backend-session/thread descriptors do not create generic instances without an explicit supported lifecycle provider.

Host Target calls inherit an inbound Target scope or use a Core-issued handle:

```js
const { sessionId } = await context.cdp.request('Target.attachToTarget', {
  targetId: selectedTargetId, flatten: true
});
const scope = await context.rpc.target({ sessionId });
try {
  await context.rpc.request(targetCapability, 'inspect', null, { scope });
} finally {
  await scope.close();
}
```

This requires a flattened raw session created through Core and owned by that Host generation, hence the appropriate `cdp.raw` grant. A payload containing a target ID or a copied handle is not authorization. The opaque handle is local to one Host and cannot be serialized into another owner's authority. `close()` cancels its pending calls, not the target itself, and is not equivalent to raw detach. Navigation, target/session closure, revocation or owner retirement invalidates old handles. A still-owned live session can be revalidated for a new handle; an old handle never upgrades itself.

Host→Renderer dispatch additionally requires the current document's actual provider realm to be ready. Core does not fabricate a Renderer instance to satisfy an otherwise valid Target descriptor.

## Budget and cancellation

Default and maximum request timeout are 15,000 ms; explicit values are 1–15,000. `signal` requests cancellation. An invocation exposes immutable caller/capability/scope/generation/depth, `signal`, `remainingMs()` and a bound `rpc`. Caller fields come from Core, not business parameters.

Host AsyncLocalStorage carries the parent lineage into managed RPC/CDP/OS continuations. Renderer handlers must use `invocation.rpc` for nested calls because browsers lack that Host async context:

```js
context.rpc.provide(viewCapability, 'calculate', (params, invocation) =>
  invocation.rpc.request(mathCapability, 'double', params));
```

Renderer `context.rpc` starts a new root call. Core validates nested parent tokens against the owner, generation, target/session, document epoch and execution context. Maximum nested depth is eight. Parent completion, cancellation, original deadline or scope retirement cancels children; asynchronous results cannot reach a new generation. A timeout or cancellation does not reverse an already accepted page/OS effect.

## Bounds, authority and errors

| Resource | Current bound |
| --- | --- |
| Host outbound capability/raw/OS requests | Four per category |
| Host provider calls / endpoints | 4 / 256 |
| Host capability outstanding or unconsumed results / admission queue | 16 / 8 |
| Renderer SDK pending requests / provider calls / endpoints | 16 / 4 / 256 |
| Target scopes / opaque handles / owned raw attach reservations | 64 / 64 / 128 |
| General JSON payload | Approximately 1 MiB, reserving protocol-envelope space |

Service-specific payload limits can be smaller. Overload rejects admission rather than silently allocating unlimited pending work. Fresh [authorization](permissions.md) is checked at admission, provider dispatch and result delivery. Complete trust-record changes cannot be bypassed by an old snapshot or a replacement candidate. `enabled` is a separate lifecycle preference, not a substitute for trust validation.

Typical codes are `capability_denied`, `scope_required`, `scope_denied`, `scope_ended`, `authorization_revoked`, `rpc_depth_limit`, `invocation_cancelled`, `request_timeout`, `request_limit`, `host_unavailable`, `provider_unavailable` and `method_not_found`. Renderer local timeout preserves `rpc_timeout`; remote Core timeout uses `request_timeout`. Treat uncertain writes according to their operation/receipt contract, not by automatically repeating RPC.

Built-in capabilities include `codlet.runtime.ping@1`, [management](management.md) and Runtime [Core services](services.md). Generic Host/raw primitives remain available without the official adapters. Codex-specific methods and main-world callback tickets are specified in the [official plugin repository](https://github.com/baoabaob/codlet-plugins/blob/main/docs/spec/adapters.md).
