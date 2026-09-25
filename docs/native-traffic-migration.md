# Native traffic engine migration

**Status: proposed implementation design, not current behavior.** The current
[traffic contract](spec/traffic.md) remains authoritative until cutover. This
document records the implementation boundaries and acceptance gates for replacing
the generic JavaScript traffic engine with Rust. After cutover, consolidate the
result into the contract and remove this plan; Git retains the history.

## Decision and scope

Use one Core-owned Rust traffic engine for transparent sources and explicit Host
channels. Remove the permanent Node traffic worker. Keep ordinary plugin code in
its existing Host process, with a small JavaScript SDK for callbacks, streams and
lifetime notifications. Do not merge the engine into an arbitrary plugin Host or
the official client's main thread.

Core already owns registration, authorization, generations, leases and the Host
data peer in `src/core_services/traffic.rs` and `traffic/wire.rs`. The migration
extends that ownership to forwarding and scheduling; it does not require Core to
import an official Adapter or understand tasks, providers or models.

The memory opportunity is removal of the independent Node/V8 runtime and its
allocation retention. Rust still needs sockets, TLS state, queues and buffers.
Do not promise a particular final footprint from a bare Rust HTTP proxy or compare
RSS with private committed memory. Measure the complete implementation against
the optimized worker, not just the older unoptimized baseline.

## Final ownership

| Responsibility | Final owner |
| --- | --- |
| HTTP/HTTPS and SSE streaming, WS/WSS handshakes and frames | Rust Core |
| Interceptor order, request/response decisions and frame transforms | Rust scheduling; plugin callbacks remain JavaScript |
| Exact-origin grants, redirect/secret access, generation and lease checks | Existing Core authority, extended without new implicit grants |
| Routes, explicit channels, one-use body streams, limits, cancellation | Rust Core with SDK stream handles |
| System/environment proxy choice, additional CA, credentials | Core network policy and transport, keeping current behavior per entry type |
| Official client discovery, compatibility hashes, early hooks and backend launch arguments | Ordinary authorized Adapter |
| Provider selection, model policy, response repair or retries | Consuming plugin |

There are two different network boundaries that must remain supported:

1. A registered route forwards an owned backend or explicit channel through Core.
2. Desktop `http.intercept` delegates `http.forward` back to the original client
   transport. Its session cookies, client policy and redirect behavior cannot be
   replaced with a generic reqwest request. Core runs the interception sequence
   and relays the result; the Adapter retains this client-specific forwarding.

Neither boundary makes unsupported client paths become supported. Existing
coverage labels and unavailable-source reports remain necessary.

## API and protocol compatibility

Preserve the public shapes in `types/host.d.ts`, including:

- `openChannel`, `openHttpChannel`, `openSource`, `registerInterceptor`, `inspect`;
- callback arguments, header-pair arrays, binary frames and one-use async bodies;
- `exchange.forward`, `forwardAttempts`, `maxForwardAttempts`, cancellation and
  the WebSocket close promise;
- synchronous channel `status()` / interceptor `inspect()`, and asynchronous
  close / enable operations.

The SDK will retain callback tables and local status projections. Update them
from ordered Core events and acknowledged operations; do not silently convert a
synchronous getter to a Promise or weaken close/enable acknowledgment semantics.
Validate the observable ordering of counter changes inside callbacks as well as
after awaited operations.

Keep the existing private plaintext source descriptor and protocol for the first
cutover: `route.register`, `route.update`, `route.close`, `http.intercept`,
`http.forward`, `http.cancel`, `http.release` and body relay operations. The
Adapter's source client can then be tested unchanged against Rust. A different
implementation behind this descriptor is not a reason to change its coverage.

The first migration should retain the bounded JSON/Base64 Host wire format.
Opaque stream references pass through Core; read/encode body chunks only when a
plugin actually consumes them. An unmatched request needs neither a callback nor
a body round trip through JavaScript. Binary IPC optimization is a later measured
change, not a prerequisite or a second transport to keep indefinitely.

Do not require `traffic.intercept` or a Codex Adapter merely to use an explicit
channel. Existing `host.process`, `host.network`, origin grants and optional
credential/profile permissions remain the authority for that API. A headless Host
must still be able to create a channel without launching a desktop client.

## Rust structure and reuse

Extend `src/core_services/traffic/` rather than introducing another traffic
registry. Suggested responsibilities are an engine/dispatcher, source admission,
channels, owned streams, HTTP forwarding and WebSocket forwarding. The existing
wire module stays responsible for authenticated plugin/source peers and bounded
framing. Replace the internal Gateway socket hop with direct typed calls into the
same authority; retain plugin/source peer separation.

Reuse the existing traffic event loop where practical. Blocking platform proxy
resolution and certificate loading must stay off its asynchronous execution path
and remain bounded. Never hold a registration/state mutex while awaiting network
I/O or a plugin callback. Idle expiry work should be scheduled from live deadlines,
not new high-frequency polling.

The lockfile already contains tokio, reqwest, hyper, hyper-util, http-body-util and
rustls dependencies. Explicit server/stream features and WebSocket support still
need review and appropriate direct dependency declarations. Use a maintained
protocol implementation rather than writing an HTTP or WebSocket parser.

`src/core_services/network.rs::Network::fetch` is **not** a drop-in engine: it has
a finite request timeout, a small buffered-body contract and a JSON return value.
Reuse proxy resolution, authority and credential helpers, not that fetch method's
limits or buffering. Disable implicit redirects, decompression, cookies and
retries where the current entry type does not provide them. Preserve repeated
headers and the original byte stream.

Proxy behavior is entry-specific. Transparent traffic preserves the launch-time
environment's routing semantics plus the platform resolver; explicit channels
keep their declared network-profile behavior. HTTPS proxy CONNECT authentication,
system roots and origin-scoped additional CA must work for both HTTP and WSS.
Never leak a proxy credential into an upstream header or a route's extra CA into
another origin. A resolver error must not become a silent direct connection.

## Lifecycle and product behavior

`TrafficOwner` becomes an owner of the native engine and the authorized launch
integration, not a permanent Node child. Its stop/health/update behavior must be
rewritten accordingly, including the macOS update-retirement path. The Adapter's
short-lived Node launch executor and ordinary plugin Hosts remain: removing one
worker does not remove every use of Node from Codlet.

Preserve cancellation on channel close, plugin retirement, source disconnect and
grant revocation. A route update changes future exchanges atomically; already
active streams keep their original upstream and trust. No cancelled, uncertain or
already-sent request may be replayed as a recovery strategy. Engine failure is a
finite error, not permission to bypass a configured interceptor.

Preparation of the native engine and preparation of official client hooks are
separate decisions. Explicit channels can start the engine lazily. For transparent
traffic, the desired product behavior is early preparation through an enabled,
compatible and authorized launch Adapter, followed by dynamic plugin activation.
No new automatic grants are needed or permitted. Safe mode still skips plugin
attachment; a Core-only setup must not depend on an Adapter being installed.

Native migration alone does not eliminate the startup timing requirement. The
official backend's base URLs and Desktop hooks still need early preparation.
Only advertise installation without a client restart after that path is tested
with no initial consumers and a later authorized plugin. Existing WebSockets and
requests are not silently migrated mid-flight. Retiring the last interceptor
cannot close an engine still carrying backend traffic.

Moving the engine in-process also changes its failure domain. The Node worker's
independent exit is no longer available. Untrusted frame/body limits, bounded
allocation, connection deadlines and structured errors must protect Core itself;
do not use `unwrap` on peer input or log URLs, headers, credentials or payloads.

## Implementation order and removal

1. Extract backend-independent acceptance scenarios from the existing source,
   channel and authority fixtures. Define receipts for bytes, order, cancellation,
   live-resource counts and finite errors. Do not begin with a feature-incomplete
   production switch.
2. Add native stream ownership, source-peer handling and interceptor dispatch to
   the existing authority. Prove real JS Host callbacks and the unchanged Adapter
   source client against this boundary, including cancellation races.
3. Implement HTTP/SSE and WS/WSS forwarding, proxy/trust behavior and the delegated
   Desktop forward path. Require parity for all supported protocol paths.
4. Route explicit channels through this same engine. Reduce `host-traffic.cjs` to
   SDK bindings while preserving its exported bootstrap entry and public API.
5. Replace the worker launch on Windows and macOS, then remove the obsolete worker
   implementation and build outputs in the same cutover. Run full compatibility,
   resource and real-client acceptance before changing default preparation.

During development the JavaScript implementation may serve as a test oracle. The
shipping product must have one engine, without a permanent legacy toggle or an
automatic fallback that can hide partial coverage or change request semantics.

Expected removal/consolidation at cutover:

- `runtime/traffic-worker.cjs`, `traffic-worker-entry.cjs`,
  `traffic-worker-bundle.cjs`, `traffic-gateway.cjs`, `traffic-interceptors.cjs` and
  `plaintext-source.cjs` once their responsibilities have moved;
- `JsRuntime::prepare_traffic_worker`, traffic child-process/config lifetime code,
  and corresponding frontend build entries;
- Node-specific transport code in `host-traffic.cjs` and its generated bundle,
  replaced by the thin SDK rather than keeping a second network engine;
- migrated tests must target the native engine rather than retaining dead
  production JS solely to make the old tests pass.

Keep `traffic-wire.cjs`, Host callback/stream bindings and the Adapter's
`plaintext-source-client` as needed for the unchanged peer protocol. Regenerate
bundles and third-party notices after dependency changes. Ordinary plugin code
may still import Node networking itself under the existing Host trust model; this
migration does not prohibit arbitrary plugin JavaScript.

## Acceptance gates

| Gate | Required evidence |
| --- | --- |
| API and policy | Ordered request callbacks and reversed response callbacks; block/synthetic/rewrite; exact origins; hidden credentials; cross-origin stripping; local synchronous status semantics |
| HTTP/SSE | Uploads, repeated headers, arbitrary split SSE chunks, unread-body cancellation, redirects including empty 302, HEAD/bodyless responses, abort before connection and during transfer |
| WebSocket | WS and WSS, protocols, text/binary, ordered bidirectional replace/drop, 426 HTTP fallback, close propagation and independent HTTP/WS capacity |
| Trust/routing | System/environment proxies, authenticated HTTP/HTTPS CONNECT, trusted/untrusted certificates, route-scoped custom CA, no ambient auth forwarding or direct fallback on resolver failure |
| Lifetime | Disable/revoke/update while active; late callback/stream replies; atomic route changes; owner/generation separation; no automatic upstream replay; bounded shutdown |
| Capacity | Existing per-entry defaults and maxima; at least four concurrent 64 MiB HTTP responses and an 8 MiB frame without whole-response buffering |
| Channels | Headless operation without Adapter or `traffic.intercept`; explicit forward count/response-consumption gate; scoped credentials; peer reconnect/retirement |
| Client integration | Owned Windows and macOS launches; unchanged Adapter source peer; current path-specific coverage; official-update restart; prepare first, install consumer later |
| Resources | Same pinned runtime/client and workload as optimized Node baseline; combined Core+worker/Host memory and CPU; cold/idle/busy/after-load; latency/stream delivery; connection/task/stream counts return to baseline |

Rust memory/performance results do not exist yet. Completion requires the full
engine to pass these gates and removal of the redundant implementation; a local
HTTP forwarding demo is only a feasibility experiment.
