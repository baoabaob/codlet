/** INTERNAL prototype: not part of ctx.host or the renderer plugin ABI. */
import type { HttpChannelRequest, HttpChannelResponse, HttpForwardRequest, HttpChannelExchange, WebSocketChannelRequest, WebSocketChannelExchange, WebSocketFrameTransform, TrafficChannelOptions } from './host';
type MaybePromise<T> = T | Promise<T>;
export interface ProcessTrafficOwner {
  readonly pluginId: string;
  readonly generation: number;
  /** Trusted owner signal, aborted on disable, crash, revocation, or replacement. */
  readonly signal: AbortSignal;
}
export interface ProcessHttpRequest extends HttpChannelRequest { readonly url: string; }
export interface ProcessWebSocketRequest extends WebSocketChannelRequest { readonly url: string; readonly method?: 'GET'; }
export interface InterceptorOptions {
  id: string;
  /** Exact HTTP(S) origins; also apply to the corresponding WS(S) origin. */
  origins: string[];
  priority?: number;
  timeoutMs?: number;
}
type RequestUpdate = Pick<HttpForwardRequest, 'url' | 'method' | 'headers' | 'body'>;
export type RequestDecision = { request: Partial<RequestUpdate> } | { respond: HttpChannelResponse } | { block: true } | null | undefined;
export interface InterceptorCallbacks {
  request?(request: Readonly<ProcessHttpRequest>, context: Readonly<{ signal: AbortSignal }>): MaybePromise<RequestDecision>;
  response?(response: Readonly<HttpChannelResponse>, context: Readonly<{ signal: AbortSignal; source: 'upstream' | 'synthetic'; request: Readonly<{ id: string; url: string; method: string }> }>): MaybePromise<Partial<HttpChannelResponse> | null | undefined>;
  webSocket?(request: Readonly<ProcessWebSocketRequest>, context: Readonly<{ signal: AbortSignal }>): MaybePromise<{
    request?: Partial<Pick<RequestUpdate, 'url' | 'headers'>>;
    block?: true;
    clientToServer?: WebSocketFrameTransform;
    serverToClient?: WebSocketFrameTransform;
  } | null | undefined>;
}
export interface ProcessIngressConfiguration {
  origins: string[];
  /** A private per-launch certificate provider, never a public test key. */
  certificateFor(origin: string, signal: AbortSignal): MaybePromise<{ key: string | Uint8Array; cert: string | Uint8Array }>;
  /** Hard lifetime for a request or tunnel. Default 5 minutes; ceiling 1 hour. */
  lifetimeMs?: number;
}
export interface ProcessIngress {
  readonly id: string;
  /** Sensitive authenticated child-only proxy URL. Never include in diagnostics. */
  readonly proxyUrl: string;
  /** Disruptively closes owned connections while retaining the listener. Never replays. */
  disconnect(): void;
  status(): Readonly<{ open: boolean; activeRequests: number; forwardAttempts: number; transport: 'loopback'; coverage: 'process-proxy-unverified'; protocols: readonly ('http' | 'websocket')[] }>;
  close(): Promise<{ closed: boolean }>;
}
export interface ProcessInterceptors {
  register(owner: ProcessTrafficOwner, options: InterceptorOptions, callbacks: InterceptorCallbacks): Readonly<{ dispose(): void; setEnabled(enabled: boolean): void }>;
  readonly handlers: Readonly<{
    http(request: ProcessHttpRequest, exchange: HttpChannelExchange): Promise<HttpChannelResponse>;
    webSocket(request: ProcessWebSocketRequest, exchange: WebSocketChannelExchange): Promise<unknown>;
  }>;
  close(): void;
  status(): { registered: number; active: number; retired: boolean };
}
export interface InternalTrafficRuntime {
  openProcessIngress(options: TrafficChannelOptions, handlers: ProcessInterceptors['handlers'], configuration: ProcessIngressConfiguration): Promise<ProcessIngress>;
  closeAll(reason?: Error): void;
}
export declare function createTrafficInterceptors(dependencies: {
  rootSignal: AbortSignal;
  /** The trusted launch owner must resolve this before child proxy overrides. */
  networkProfile?: string;
  authorize(owner: ProcessTrafficOwner, action: 'intercept' | 'sensitiveHeaders' | 'redirect', url: string, signal: AbortSignal): MaybePromise<boolean>;
}): ProcessInterceptors;
export declare function prepareProcessTrafficEnvironment(options: {
  platform?: 'win32' | 'darwin';
  environment: Record<string, string | undefined>;
  directory: string;
  proxyUrl: string;
  additionalCaPem: string;
  trustInputs?: string[];
  trustOutputs: string[];
}): Promise<Readonly<{
  environment: Readonly<Record<string, string | undefined>>;
  upstreamEnvironment: Readonly<Record<string, string | undefined>>;
  bundlePath: string;
  status(): { prepared: boolean; coverage: 'process-configuration-only'; inheritedBypass: boolean };
  close(): Promise<void>;
}>>;
