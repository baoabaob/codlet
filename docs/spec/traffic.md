# Traffic contract

This document is the stable contract for transparent traffic and the Host traffic API. It describes ownership and wire limits; client specific endpoint names stay in the official Adapter.

The current process ingress below is the implemented proxy transport, not proof of Desktop coverage. The Adapter's [request-chain verification](https://github.com/baoabaob/codlet-plugins/blob/main/docs/spec/request-chain.md) establishes separate Desktop JS and model-provider plaintext paths on the reviewed Windows build. Their production integration remains pending. Further work should admit those sources through generic lifecycle/traffic contracts, without making Core depend on official plugins or granting them exclusive capabilities; do not extend the unsupported Desktop proxy workaround.

## Ownership

Core creates one private Native traffic entrance for a launch. The entrance has two authenticated loopback peers: a Core owned gateway and one Host peer per plugin generation. Short service RPCs register policy and return status. Request bodies, response bodies and WebSocket frames use the separate bounded data peer. Renderer calls cannot create either peer or select an owner generation.

The Windows/macOS launch owner creates the gateway before the official client and retains its process lifetime. Core owns gateway authority, private launch descriptors, and the selected launch Adapter's bounded handshake; the Adapter owns the client-specific hooks. Plugin disable, revocation, generation replacement or peer failure retires the affected registrations and exchanges. A request already sent upstream is never replayed after retirement.

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

Normal launch prepares traffic only when its enabled Host catalog contains a plugin that both declares and has an explicit grant for `traffic.intercept`. Otherwise Native creates no traffic worker, applies no proxy or CA override, and preserves the ordinary client launch path. Installing or enabling the first traffic Host during that session requires restarting the client; the unavailable service error explains this requirement. An already prepared entrance supports handler registration, retirement and hot updates. Safe mode never prepares an entrance.

The fixed worker accepts `{endpoint,directory,trustInputs,trustOutputs}`. Native issues `endpoint` through `Traffic::gateway_endpoint()` and prepares the fixed script with `JsRuntime::prepare_traffic_worker()`. Wait for `Traffic::launch_descriptor()` before creating the client. The descriptor contains `proxyUrl`, `bundlePath`, `environmentPatch: {set, removeCaseInsensitive}`, `trust: {outputs,launchCaPem,inheritedInputsMerged,systemStoreModified}` and `bypass: 'preserve-original-no-proxy'`. `launchCaPem` is the public certificate of this launch's CA (never its key); Electron uses only this root for its temporary verification callback, not the first certificate from the merged bundle.

Apply removals to the original client environment before the `set` entries. Only proxy and selected CA variables change; no full worker environment is returned. `NO_PROXY` and unrelated original client variables remain intact. The proxy URL contains a secret, so the descriptor is private and must not enter diagnostics. Native must validate that the bundle remains inside its private launch directory and remove that directory after reaping the worker, including crashes. `set_attached(true)` is a Native-only confirmation after actual child integration, never a plugin registration result.

Standard proxy variables do not establish Electron `session`/`net` coverage. Electron main-process routing and temporary CA trust, and restoration of the original environment for backend tool children, are separate Adapter integrations. They must be completed and verified before claiming those coverage areas. Never use a global certificate verification bypass.

The Native prelaunch consumer selects exactly one enabled Host providing `codlet.client.launch@1` with `runtime` scope. This is an optional ABI phase of the same Host entry and immutable source generation; it is not a second plugin registry. The provider must declare and hold explicit `host.process` and `cdp.raw` grants. `cdp.raw` gives it privileged main-process access, including private launch descriptors, so it is not a restricted traffic-only permission. The provider does not need its own `traffic.intercept` grant: a separate enabled, authorized traffic consumer triggers the launch gate.

When that Host's effective capabilities contain only this one launch provider and no requirements, it is a Native-only launch entry. Core retains its source, trust checks and plugin identity but does not create an idle ordinary Host process or wait for ordinary Host readiness before activating its renderer. The reserved launch capability is never exported through service RPC. A Host with additional capabilities or requirements keeps the ordinary Host lifecycle as well as the optional launch phase.

The Host bundle exports `prepareClientLaunch({traffic, originalEnvironment, signal})`, returning `{arguments}`, and `attachClientLaunch({traffic, originalEnvironment, inspectorUrl, expectedPid, executable, signal})`. The fixed short-lived executor accepts only these two bounded private phases. Native requires exactly `--inspect-brk=127.0.0.1:0`, the descriptor-matching loopback HTTP/HTTPS `--proxy-server` argument, and `--proxy-bypass-list=<-loopback>` so Chromium does not silently exclude local origins from the launch route. Arbitrary flags and TLS/sandbox bypasses are rejected. The attach result must confirm `installed`, `exactChildVerified`, and one to 32 `configuredSessions`. The Adapter verifies the exact new child before sharing the proxy secret or launch CA, installs its bundled hooks before entry, awaits session configuration, and closes the inspector. Native reaps the temporary executor immediately after the handshake.

The inspector URL comes only from that exact child's dedicated stderr pipe, with a loopback host, ephemeral port and UUID path. Native neither scans ports nor reads shared logs. The stderr reader drains silently for the client's lifetime; handshake input is capped at 64 KiB and the endpoint-plus-attach deadline is ten seconds. A client fuse that prevents inspector startup therefore fails launch without declaring attachment. The complete authorization record is checked before and after each phase and at most one second apart during runtime; revocation exits the owned client through its normal quit/failure-cleanup path. `attached` records launch integration; it does not prove real Electron/backend requests, tool-child isolation, or every protocol path.

Rust error unwinding retains the private worker and trust directory until the exact newly spawned client has been asked to quit and its retained process handle has been checked; failure cleanup may terminate that exact client. The official client is not put in a kill-on-close Job, so independent updater descendants survive the normal update handoff. A hard Core crash or external kill does not execute Rust destructors: gateway disconnection stops the worker, but the existing client can survive with a dead proxy configuration. Automatic client recovery after such a crash is not currently verified or promised.

## Official Adapter

The official Adapter owns endpoint classification and launch compatibility. Core does not know thread ids, providers or model names. The Adapter may expose a capability such as `codex.backend.transport@1` and select a Core channel only for a verified client build. It applies changes at the client’s supported thread start/resume boundary. Existing loaded threads, active turns and established WebSockets are not migrated automatically.

The Adapter must report `available: false` until the Native gateway, child environment and protocol profile are all attached. Fixture hashes and isolated probes are evidence only; they do not upgrade OAuth, Desktop, attachment or everyday-provider coverage.

## Explicit channels

The existing `context.traffic.openChannel` and `openHttpChannel` APIs remain supported. A plugin may provide HTTP/SSE and WebSocket handlers and return its channel descriptor to an authorized consumer. Channel endpoints use a private random loopback path, expire with the Host generation, and must not be logged or persisted. Declare/grant `host.process`, `host.network`, and each exact upstream origin.

HTTP handlers receive a one-use body stream and may forward or return `{status, headers, body}`. Repeated headers remain arrays; SSE chunks are arbitrary byte chunks, not complete events. Each forward verifies current authority, has no implicit retry or redirect, and does not automatically copy incoming authentication. An explicit bounded `maxForwardAttempts` permits plugin-managed retries only after consuming/cancelling the prior response; replaying a consumed body requires the plugin's own bounded buffer.

WebSocket forwarding preserves ordering separately in each direction. Frame callbacks may pass, replace, or drop a message. Protocol conversion, model/provider routing and response repair belong to plugins. Cancellation reclaims local resources but cannot undo remote effects. The minimal [HTTP channel example](https://github.com/baoabaob/codlet/tree/main/examples/http-channel) and [Host types](../../types/host.d.ts) document usage.

## Validation

Core tests exercise authenticated peer roles, exact-origin grants, cross-owner lease rejection, revocation and the real local TCP data plane. Runtime tests exercise bounded one-shot streams, cancellation, body/frame limits and callback ordering. Adapter tests exercise build gates, endpoint classification, compressed JSON rewriting and conflict-free thread configuration. A real client acceptance run must use a fresh private home and emit only bounded counters and finite error codes.

Historical controlled/live AppServer evidence is retained in Git at `d109d54`. It used independent profiles and verifies a backend path, not installed Desktop coverage. Repeatable drivers are `scripts/probe-official-traffic.mjs`, `scripts/verify-live-backend-traffic.mjs` (explicit live opt-in), and `scripts/benchmark-process-traffic.mjs`. Do not copy credentials, raw traffic, dated run journals, or memory reports into the source repository.
