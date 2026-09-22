# Traffic channels

Core's Host `context.traffic` provides explicit HTTP(S), streaming HTTP/SSE, and WS/WSS channels. It handles traffic that enters a registered channel; page CDP traffic, Desktop's internal RPC, login traffic, and other backend requests are separate scopes. Transparent process-wide ingress is under integration and is not implied by this API.

See [host.d.ts](../../types/host.d.ts) for signatures, [Host](host.md) for process ownership, and [permissions](permissions.md) for authorization. Declare and obtain `host.process`, `host.network`, and explicit upstream origins. A `ws://` origin maps to its `http://` origin; `wss://` maps to `https://`.

```js
const channel = await context.traffic.openChannel({}, {
  async http(request, exchange) {
    const response = await exchange.forward({
      url: upstreamOrigin + request.path,
      method: request.method,
      headers: [['content-type', 'application/json']],
      body: ['GET', 'HEAD'].includes(request.method) ? null : request.body
    });
    return {status: response.status, headers: response.headers, body: response.body};
  },
  async webSocket(request, exchange) {
    await exchange.forward({
      url: upstreamWebSocketOrigin + request.path,
      protocols: request.protocols,
      clientToServer: frame => frame,
      serverToClient: frame => frame
    });
  }
});
```

`upstreamOrigin` and `upstreamWebSocketOrigin` must be approved destinations. Either handler may be omitted; `channel.protocols` reports actual support. The returned endpoint has a dynamic loopback port and a private random path. It expires with the Host generation and must not be persistently stored, logged, or shared.

## Requests and streams

HTTP requests expose ID, method, path without the private prefix, header pairs, and a one-use body stream. Plugins can change the destination, method, headers, and body before forwarding or return their own response. Header arrays preserve repeated fields. SSE remains a byte stream: a transport chunk is not necessarily a complete event.

WebSocket handlers bridge after the upstream handshake. Per-direction callbacks receive `{data, binary}` and may return the original message, replacement text/bytes/frame, or `null` to drop it. Each direction remains ordered. Business-event parsing, protocol conversion, provider selection, and response recovery belong to plugins; Core does not interpret messages as model turns or tool results.

Each `forward` checks current generation, permissions, and upstream origin. It does not implicitly copy incoming authentication, follow redirects, retry, or reconnect. HTTP defaults to one dispatch; a plugin may explicitly set a bounded `maxForwardAttempts` and must consume or cancel the previous response before deciding to dispatch again. Reusing a consumed incoming body requires an explicitly budgeted replay buffer.

Channel limits bound bodies, concurrency, handler decision time, and WebSocket message/queue sizes. Long streams do not occupy an endless JSON RPC. The Host generation owns actual sockets; revoke, disable, reload, exit, or channel close cancels owned resources. Local cancellation does not prove a remote request had no side effects.

TLS validates upstream certificates normally. This API does not offer ignored certificate errors, CONNECT interception, or system trust-store modification. Trusted Node code still has the user's OS privileges; managed permissions are not an OS sandbox.

## Optional Desktop Adapter integration

The independent Desktop Adapter's `codex.backend.transport@1` can attach an explicit channel to supported thread start/resume requests. The Renderer declares the exact Target capability and `ui.mainWorld`, probes availability, obtains its one-use API ticket, and registers a transport callback. See the adapter's current types and specification in the [official plugin repository](https://github.com/baoabaob/codlet-plugins).

A selected channel supplies `{endpoint, protocols}` with optional path (default `/v1`) and model. No selection leaves the native request unchanged. The adapter maps protocol support to private client configuration; a WebSocket-only channel does not silently claim HTTP fallback. Configuration goes through the existing native connection and does not change global client settings or start a second production backend.

Selection is bounded to two seconds per callback and five seconds overall, with 32 registrations and 16 pending requests. Tickets bind the requesting plugin and generation; retirement cancels pending choices. Multiple selections produce a conflict rather than duplicate dispatch. Diagnostics omit private endpoint paths, request bodies, and arbitrary callback errors.

Existing loaded threads, in-flight turns, and established sockets do not migrate automatically when a registration changes. Plugins must distinguish a changed setting from the effective transport of an active request. `examples/http-channel` demonstrates explicit opt-in and authentication filtering; it is not a complete gateway product.

## Validation boundary

Tests cover real local sockets, permissions/lifecycle, same-connection adapter selection, and isolated official AppServer HTTP/WS requests. Fixtures, standalone AppServer evidence, and real Desktop UI acceptance are distinct and must be reported separately. Transparent interception requires its own source classification, ingress ownership, trust, cancellation, and actual-client acceptance before delivery.
