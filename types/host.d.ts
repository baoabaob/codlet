/** Host JS ABI v1. TS authors compile to CommonJS .js/.cjs before distribution. */
export interface CdpEvent {
  method: string;
  params: Record<string, unknown> | null;
  sessionId: string | null;
}
export type CdpFilter = ({ scope: 'root' | 'all' } | { scope: 'session'; sessionId: string }) & { methods?: string[] };
export interface CdpSubscription {
  readonly id: number;
  unsubscribe(): Promise<{ unsubscribed: boolean }>;
}
export type HttpHeader = readonly [name: string, value: string];
/** One-shot binary stream. A second iteration fails with body_already_consumed. */
export interface HttpBody extends AsyncIterable<Uint8Array> {
  /** Stops and releases an unread or partially-read stream. */
  cancel(): boolean;
}
export interface HttpChannelRequest {
  readonly id: string;
  readonly method: string;
  /** Path and query below the private channel endpoint. */
  readonly path: string;
  readonly headers: readonly HttpHeader[];
  readonly body: HttpBody;
}
export interface HttpChannelResponse {
  status: number;
  headers?: readonly HttpHeader[];
  body?: string | Uint8Array | Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array> | null;
}
export interface HttpForwardRequest {
  /** Generation-owned Core network profile; declare codlet.core.services@1 and core.network. */
  networkProfile?: string;
  /** Origin-bound credential used as an explicit Bearer token. */
  credentialRef?: string;
  /** Absolute HTTP(S) URL. Core checks its exact origin for every dispatch. */
  url: string;
  method?: string;
  /** No incoming headers, including Authorization, are inherited implicitly. */
  headers?: readonly HttpHeader[];
  body?: string | Uint8Array | Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array> | null;
}
export interface HttpChannelExchange {
  readonly signal: AbortSignal;
  /** Cancels this owned exchange and releases its upstream streams. */
  cancel(): void;
  /** Number of explicit forward calls charged to this exchange. */
  readonly forwardAttempts: number;
  readonly maxForwardAttempts: number;
  /** Dispatches only on explicit calls. Consume or cancel each response body before the next attempt. Redirects are returned and are never followed. */
  forward(request: HttpForwardRequest): Promise<Readonly<Required<Pick<HttpChannelResponse, 'status' | 'headers'>> & { body: HttpBody }>>;
}
export interface TrafficChannelOptions {
  /** Active HTTP exchanges, default and maximum 4. */
  maxConcurrent?: number;
  /** Active WebSocket exchanges, defaulting to maxConcurrent and bounded by 32. */
  maxWebSocketConcurrent?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  /** Explicit forward calls allowed per inbound HTTP exchange. Defaults to 1; maximum 8. Core never retries automatically. */
  maxForwardAttempts?: number;
  handlerTimeoutMs?: number;
  maxWebSocketMessageBytes?: number;
  maxWebSocketQueueBytes?: number;
  maxWebSocketQueueFrames?: number;
}
export interface WebSocketChannelRequest {
  readonly id: string;
  readonly path: string;
  readonly headers: readonly HttpHeader[];
  readonly protocols: readonly string[];
}
export interface WebSocketFrame {
  readonly data: string | Uint8Array;
  readonly binary: boolean;
}
export type WebSocketFrameTransform = (frame: WebSocketFrame, context: Readonly<{ signal: AbortSignal; direction: 'clientToServer' | 'serverToClient' }>) => string | Uint8Array | WebSocketFrame | null | Promise<string | Uint8Array | WebSocketFrame | null>;
export interface WebSocketForwardRequest {
  networkProfile?: string;
  credentialRef?: string;
  /** Absolute ws:// or wss:// URL. ws/wss use the matching HTTP/HTTPS origin grant. */
  url: string;
  protocols?: readonly string[];
  /** Incoming Authorization and channel credentials are never inherited. */
  headers?: readonly HttpHeader[];
  clientToServer?: WebSocketFrameTransform;
  serverToClient?: WebSocketFrameTransform;
}
export interface WebSocketChannelExchange {
  readonly signal: AbortSignal;
  /** Cancels the handshake or both sides of an established bridge. */
  cancel(): void;
  /** Connects upstream before accepting the downstream handshake; dispatches at most once. */
  forward(request: WebSocketForwardRequest): Promise<Readonly<{ protocol: string | null; closed: Promise<{ code: string }> }>>;
}
export interface TrafficInterceptorOptions { id: string; origins: readonly string[]; priority?: number; timeoutMs?: number; }
export type TrafficRequestDecision = { request: Partial<Pick<HttpForwardRequest, 'url' | 'method' | 'headers' | 'body'>> } | { respond: HttpChannelResponse } | { block: true } | null | undefined;
export interface TrafficInterceptorContext { readonly signal: AbortSignal }
export interface TrafficResponseContext extends TrafficInterceptorContext { readonly source: 'upstream' | 'synthetic'; readonly request: Readonly<{ id: string; url: string; method: string }>; }
export interface TrafficInterceptorHandlers {
  request?(request: Readonly<HttpChannelRequest & { url: string }>, context: TrafficInterceptorContext): TrafficRequestDecision | Promise<TrafficRequestDecision>;
  response?(response: Readonly<HttpChannelResponse>, context: TrafficResponseContext): Partial<HttpChannelResponse> | null | undefined | Promise<Partial<HttpChannelResponse> | null | undefined>;
  webSocket?(request: Readonly<WebSocketChannelRequest & { url: string }>, context: TrafficInterceptorContext): { request?: Partial<Pick<WebSocketForwardRequest, 'url' | 'headers'>>; block?: true; clientToServer?: WebSocketFrameTransform; serverToClient?: WebSocketFrameTransform } | null | undefined | Promise<{ request?: Partial<Pick<WebSocketForwardRequest, 'url' | 'headers'>>; block?: true; clientToServer?: WebSocketFrameTransform; serverToClient?: WebSocketFrameTransform } | null | undefined>;
}
export interface TrafficInterceptor { readonly id: string; close(): Promise<void>; dispose(): Promise<void>; setEnabled(enabled: boolean): Promise<void>; inspect(): Readonly<{ registered: boolean; enabled: boolean; exchanges: number }>; }
export interface TrafficChannelHandlers {
  http?: (request: HttpChannelRequest, exchange: HttpChannelExchange) => HttpChannelResponse | Promise<HttpChannelResponse>;
  webSocket?: (request: WebSocketChannelRequest, exchange: WebSocketChannelExchange) => void | Promise<void>;
}
export interface TrafficChannel {
  readonly id: string;
  /** Private, generation-owned loopback URL. Append the caller's API path. */
  readonly endpoint: string;
  readonly protocols: readonly ('http' | 'websocket')[];
  status(): Readonly<{ open: boolean; activeRequests: number; forwardAttempts: number; transport: 'loopback'; coverage: 'explicit-endpoint'; protocols: readonly ('http' | 'websocket')[] }>;
  close(): Promise<{ closed: boolean }>;
}
/** Compatibility name for the HTTP-only openHttpChannel helper. */
export type HttpChannelOptions = TrafficChannelOptions;
/** Compatibility name for callers using the HTTP-only helper. */
export type HttpChannel = TrafficChannel;
export interface CapabilityDescriptor {
  readonly name: string;
  readonly api: number;
  readonly scope: 'runtime' | 'target';
}
export interface ManagedOptions { timeoutMs?: number; signal?: AbortSignal }
/** Opaque and local to one Host generation. Obtain with rpc.target; never construct. */
export interface HostTargetScope {
  readonly kind: 'target';
  close(): Promise<{ closed: boolean }>;
}
export type InvocationScope = Readonly<{ kind: 'runtime' } | { kind: 'target'; targetId: string; epoch: number }>;
export interface HostRpc {
  request<T = unknown>(capability: CapabilityDescriptor, method: string, params?: unknown, options?: ManagedOptions & { scope?: HostTargetScope }): Promise<T>;
  /** Resolves after the selected handler finishes; its result is discarded. */
  notify(capability: CapabilityDescriptor, method: string, params?: unknown, options?: ManagedOptions & { scope?: HostTargetScope }): Promise<void>;
  /** sessionId must be obtained by this generation through Core raw attachToTarget(flatten:true). */
  target(input: { sessionId: string }, options?: ManagedOptions): Promise<HostTargetScope>;
  provide<P = unknown, R = unknown>(capability: CapabilityDescriptor, method: string, handler: (params: P, invocation: HostCapabilityInvocation) => R | Promise<R>): Readonly<{ ok: true }>;
}
export interface HostCapabilityInvocation {
  readonly pluginId: string;
  readonly generation: number;
  readonly capability: Readonly<CapabilityDescriptor>;
  readonly method: string;
  /** Authenticated by Core; renderer params cannot replace these fields. */
  readonly caller: Readonly<{ pluginId: string; generation: number; targetId: string; documentEpoch: number }>;
  readonly signal: AbortSignal;
  readonly scope: InvocationScope;
  readonly depth: number;
  /** Host async continuations also inherit this lineage through AsyncLocalStorage. */
  readonly rpc: HostRpc;
  remainingMs(): number;
}
export interface HostContext {
  /** Requires the declared Runtime codlet.core.services@1 capability and each method's permission. */
  readonly services: import('./core-services').CoreServices;
  readonly plugin: Readonly<{ id: string; version: string; generation: number }>;
  readonly root: string;
  readonly signal: AbortSignal;
  readonly log: Pick<Console, 'log' | 'info' | 'warn' | 'error' | 'debug'>;
  readonly cdp: {
    request<T = unknown>(method: string, params?: Record<string, unknown>, options?: ManagedOptions & { sessionId?: string }): Promise<T>;
    subscribe(filter: CdpFilter, onEvent: (event: CdpEvent) => void | Promise<void>, onEnd?: (reason: string) => void | Promise<void>): Promise<CdpSubscription>;
  };
  readonly core: {
    request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  };
  readonly rpc: HostRpc;
  readonly fs: {
    readText(params: { path: string; maxBytes?: number }, options?: ManagedOptions): Promise<{ text: string; bytes: number }>;
    readDir(params: { path: string; maxEntries?: number }, options?: ManagedOptions): Promise<{ entries: { name: string; kind: string }[]; truncated: boolean }>;
    stat(params: { path: string }, options?: ManagedOptions): Promise<{ kind: string; bytes: number; modifiedUnixMs: number | null }>;
  };
  readonly network: {
    fetch(params: { url: string; method?: 'GET' | 'HEAD'; headers?: Record<string, string>; maxBytes?: number }, options?: ManagedOptions): Promise<{ status: number; url: string; headers: Record<string, string>; body: string; bytes: number }>;
  };
  readonly process: {
    run(params: { executable: string; args: string[]; maxOutputBytes?: number }, options?: ManagedOptions): Promise<{ processId: number; exitCode: number; stdout: string; stderr: string; stdoutBytes: number; stderrBytes: number; processesReaped: boolean; ownershipScope: 'windows-job' | 'posix-process-group'; jobReaped?: boolean; processGroupReaped?: boolean }>;
  };
  readonly system: { info(options?: ManagedOptions): Promise<{ os: string; architecture: string; logicalCpus: number }> };
  readonly traffic: {
    /** Own-source ingress through the real Core interceptor pipeline (HTTP/SSE/WS).
     * Requires traffic.intercept, host.network and the upstream exact-origin grant.
     * Does not imply that the official client's Native sources are attached.
     * Opaque loopback endpoint is generation-owned; close cancels active exchanges.
     * Base path accepts unescaped ASCII path segments; no credentials/query/hash.
     */
    openSource(options: { upstreamBaseUrl: string }): Promise<Readonly<{ endpoint: string; close(): Promise<void>; dispose(): Promise<void> }>>;
    /** Creates one private loopback endpoint for the handlers that are present. */
    openChannel(options: TrafficChannelOptions, handlers: TrafficChannelHandlers): Promise<TrafficChannel>;
    /** Requires host.network and an explicit origin grant for every forward call. */
    openHttpChannel(options: HttpChannelOptions, handler: (request: HttpChannelRequest, exchange: HttpChannelExchange) => HttpChannelResponse | Promise<HttpChannelResponse>): Promise<HttpChannel>;
    /** Registers a Core-authorized interceptor for exact origins in this Host generation. */
    registerInterceptor(options: TrafficInterceptorOptions, handlers: TrafficInterceptorHandlers): Promise<TrafficInterceptor>;
    inspect(): Promise<Readonly<{ available: boolean; listening: boolean; attached: boolean; activatedSources: readonly ClientActivatedSource[]; unsupportedSources: readonly ClientUnsupportedSource[]; registered: number; active: number; pending: number }>>;
  };
}
export type ClientSourceProtocol = 'http' | 'sse' | 'webSocket';
/** route.update changes future exchanges on the same local route; active exchanges keep their selected upstream. */
export type ClientSourceOperation = 'route.register' | 'route.update' | 'route.close' | 'http.intercept';
/** Private to one authorized launch provider. Both addresses and tokens are launch-scoped. */
export interface ClientPlaintextSource {
  readonly version: 1;
  readonly kind: 'plaintext';
  readonly protocols: readonly ClientSourceProtocol[];
  readonly operations: readonly ClientSourceOperation[];
  readonly endpoint: Readonly<{ host: '127.0.0.1'; port: number; token: string }>;
  readonly routeBaseUrl: string;
}
export interface ClientActivatedSource {
  readonly id: string;
  readonly operations: readonly ClientSourceOperation[];
  readonly protocols: readonly ClientSourceProtocol[];
  /** Opaque, path-specific labels supplied by the launch plugin; Core does not infer full coverage. */
  readonly coverage: readonly string[];
}
export interface ClientUnsupportedSource {
  readonly id: string;
  readonly reason: 'unsupported_build' | 'hook_unavailable' | 'child_unavailable' | 'route_unavailable' | 'timeout';
}
/** Private to one authorized codlet.client.launch@1 provider; never log this DTO. */
export interface ClientLaunchContext {
  readonly signal: AbortSignal;
  readonly originalEnvironment: Readonly<Record<string, string>>;
  readonly traffic: Readonly<{
    source: Readonly<ClientPlaintextSource>;
    environmentPatch: Readonly<{ set: Readonly<Record<string, never>>; removeCaseInsensitive: readonly [] }>;
  }>;
}
export interface ClientAttachContext extends ClientLaunchContext {
  readonly inspectorUrl: string;
  readonly expectedPid: number;
  readonly executable: string;
}
export interface HostPlugin {
  activate(context: HostContext): void | Promise<void>;
  deactivate(cleanup: HostCleanupContext): void | Promise<void>;
  /** Optional startup ABI. Requires host.process + cdp.raw and the exact launch capability. */
  prepareClientLaunch?(context: ClientLaunchContext): { arguments: readonly string[] } | Promise<{ arguments: readonly string[] }>;
  /** Bounded, exact-child handshake. Success does not claim verified coverage of every request path. */
  attachClientLaunch?(context: ClientAttachContext): Promise<{ installed: true; exactChildVerified: true; activatedSources: readonly ClientActivatedSource[]; unsupportedSources: readonly ClientUnsupportedSource[] }>;
}

/** A separate, generation-scoped phase; no subscriptions or renewed deadline.
 * Core's total shutdown budget is at most 1500 ms, including message delivery.
 * Reuse only permissions already granted to this generation. This is no sandbox
 * and Codlet does not automatically undo arbitrary page or operating-system effects.
 */
export interface HostCleanupContext {
  readonly plugin: Readonly<{ id: string; version: string; generation: number }>;
  readonly root: string;
  readonly signal: AbortSignal;
  readonly log: Pick<Console, 'log' | 'info' | 'warn' | 'error' | 'debug'>;
  remainingMs(): number;
  readonly cdp: {
    request<T = unknown>(method: string, params?: Record<string, unknown>, options?: { sessionId?: string; timeoutMs?: number }): Promise<T>;
  };
  readonly core: {
    request<T = unknown>(method: 'cdp.request', params: { method: string; params?: Record<string, unknown>; sessionId?: string; timeoutMs?: number }, timeoutMs?: number): Promise<T>;
  };
}
