# Traffic contract

This document is the stable contract for transparent traffic and the Host traffic API. It describes ownership and wire limits; client specific endpoint names stay in the official Adapter.

## Ownership

Core creates one private Native traffic entrance for a launch. The entrance has two authenticated loopback peers: a Core owned gateway and one Host peer per plugin generation. Short service RPCs register policy and return status. Request bodies, response bodies and WebSocket frames use the separate bounded data peer. Renderer calls cannot create either peer or select an owner generation.

The launch owner must create the gateway before the official client and retain its process lifetime. This branch supplies the gateway/Host SDK and Native authority; Windows/macOS normal-launch ownership is integrated separately. Plugin disable, revocation, generation replacement or peer failure retires the affected registrations and exchanges. A request already sent upstream is never replayed after retirement.

## Registration

Host code calls `context.traffic.registerInterceptor({ id, origins, priority?, timeoutMs? }, handlers)`. Origins are exact `http://` or `https://` origins with no path, credentials, query or fragment. Their `ws://` and `wss://` forms use the corresponding HTTP(S) origin grant. A registration is pending until its Host generation activates it on the data peer.

Core permits at most 32 registrations, 8 registrations per owner, 128 live leases, 512 pending data calls and 4 active intercepted exchanges per gateway. Registration metadata is at most 1024 bytes; handler timeout is 1–2000 ms. Priority is an integer from -1000 through 1000. Await `setEnabled(false)` to disable a registration and cancel its leases. `close()` and `dispose()` are equivalent asynchronous removals. `inspect()` is a synchronous local registration snapshot.

Request handlers run in ascending priority, plugin id and registration order. Response handlers run in reverse participation order. A handler may return one request rewrite, a synthetic response or a block. Redirects require `traffic.redirect` and a grant for the destination. Cross-origin rewrites carry only `Accept`, `Content-Type` and `Content-Encoding`. The transparent rewrite API does not accept `credentialRef`; the separate explicit channel forwarding API does.

Sensitive headers and WebSocket subprotocols are hidden unless the matching grant is declared and granted. The callback receives a frozen request view and an abort signal. Callback failures are reduced to finite public error codes; URLs, headers, credentials, body contents and callback error text are never written to diagnostics.

## Data limits and cancellation

Frames are length-prefixed JSON records no larger than 64 KiB. Each peer has at most 512 queued frames or 512 KiB queued bytes. Body sources have at most 8 live streams and 64 MiB per body; chunks are at most 32 KiB. WebSocket frames are at most 8 MiB. Reads, callback execution and leases have bounded deadlines. A cancelled, retired or expired lease rejects pending calls with `stream_retired` or `traffic_timeout` and sends no late result to a new generation.

## Process ingress

The Native owner gives the child a random authenticated loopback proxy and a launch-only CA bundle. The bundle is merged with the selected system and user trust inputs in the child environment; the parent process and system proxy settings are unchanged. TLS interception is created only for an exact registered origin and uses TLS 1.2 or newer with HTTP/1.1. Upstream certificate verification remains enabled.

CONNECT traffic whose origin has no active registration stays opaque and is forwarded end to end by the Native route. It never reaches plugin callbacks. Proxy loops, malformed destinations, credentials in target URLs and unsupported protocols are rejected. `NO_PROXY` is preserved for the child and system/PAC resolution is performed by Core with bounded time and no ambient credential forwarding.

## Native launch descriptor

The fixed worker accepts `{endpoint,directory,trustInputs,trustOutputs}`. Native issues `endpoint` through `Traffic::gateway_endpoint()` and prepares the fixed script with `JsRuntime::prepare_traffic_worker()`. Wait for `Traffic::launch_descriptor()` before creating the client. The descriptor contains `proxyUrl`, `bundlePath`, `environmentPatch: {set, removeCaseInsensitive}`, `trust: {outputs,inheritedInputsMerged,systemStoreModified}` and `bypass: 'preserve-original-no-proxy'`.

Apply removals to the original client environment before the `set` entries. Only proxy and selected CA variables change; no full worker environment is returned. `NO_PROXY` and unrelated original client variables remain intact. The proxy URL contains a secret, so the descriptor is private and must not enter diagnostics. Native must validate that the bundle remains inside its private launch directory and remove that directory after reaping the worker, including crashes. `set_attached(true)` is a Native-only confirmation after actual child integration, never a plugin registration result.

Standard proxy variables do not establish Electron `session`/`net` coverage. Electron main-process routing and temporary CA trust, and restoration of the original environment for backend tool children, are separate Adapter integrations. They must be completed and verified before claiming those coverage areas. Never use a global certificate verification bypass.

## Official Adapter

The official Adapter owns endpoint classification and launch compatibility. Core does not know thread ids, providers or model names. The Adapter may expose a capability such as `codex.backend.transport@1` and select a Core channel only for a verified client build. It applies changes at the client’s supported thread start/resume boundary. Existing loaded threads, active turns and established WebSockets are not migrated automatically.

The Adapter must report `available: false` until the Native gateway, child environment and protocol profile are all attached. Fixture hashes and isolated probes are evidence only; they do not upgrade OAuth, Desktop, attachment or everyday-provider coverage.

## Validation

Core tests exercise authenticated peer roles, exact-origin grants, cross-owner lease rejection, revocation and the real local TCP data plane. Runtime tests exercise bounded one-shot streams, cancellation, body/frame limits and callback ordering. Adapter tests exercise build gates, endpoint classification, compressed JSON rewriting and conflict-free thread configuration. A real client acceptance run must use a fresh private home and emit only bounded counters and finite error codes.
