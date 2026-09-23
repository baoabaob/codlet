/** INTERNAL Core gateway and launch-source interfaces. Public Host API lives in host.d.ts. */
import type { HttpChannelRequest, HttpChannelResponse, HttpForwardRequest, HttpChannelExchange, WebSocketChannelRequest, WebSocketChannelExchange, WebSocketFrameTransform } from './host';
type MaybePromise<T> = T | Promise<T>;
export interface TrafficOwner {
  readonly pluginId: string;
  readonly generation: number;
  readonly signal: AbortSignal;
}
export interface InterceptorOptions {
  id: string;
  origins: string[];
  priority?: number;
  timeoutMs?: number;
}
type RequestUpdate = Pick<HttpForwardRequest, 'url' | 'method' | 'headers' | 'body'>;
export type RequestDecision = { request: Partial<RequestUpdate> } | { respond: HttpChannelResponse } | { block: true } | null | undefined;
export interface InterceptorCallbacks {
  request?(request: Readonly<HttpChannelRequest & { url: string }>, context: Readonly<{ signal: AbortSignal }>): MaybePromise<RequestDecision>;
  response?(response: Readonly<HttpChannelResponse>, context: Readonly<{ signal: AbortSignal; source: 'upstream' | 'synthetic'; request: Readonly<{ id: string; url: string; method: string }> }>): MaybePromise<Partial<HttpChannelResponse> | null | undefined>;
  webSocket?(request: Readonly<WebSocketChannelRequest & { url: string }>, context: Readonly<{ signal: AbortSignal }>): MaybePromise<{
    request?: Partial<Pick<RequestUpdate, 'url' | 'headers'>>;
    block?: true;
    clientToServer?: WebSocketFrameTransform;
    serverToClient?: WebSocketFrameTransform;
  } | null | undefined>;
}
export interface TrafficInterceptors {
  register(owner: TrafficOwner, options: InterceptorOptions, callbacks: InterceptorCallbacks): Readonly<{ dispose(): void; setEnabled(enabled: boolean): void }>;
  readonly handlers: Readonly<{
    http(request: HttpChannelRequest & { url: string }, exchange: HttpChannelExchange): Promise<HttpChannelResponse>;
    webSocket(request: WebSocketChannelRequest & { url: string }, exchange: WebSocketChannelExchange): Promise<unknown>;
  }>;
  close(): void;
  status(): { registered: number; active: number; retired: boolean };
}
export interface PlaintextSourceDescriptor {
  readonly version: 1;
  readonly kind: 'plaintext';
  readonly protocols: readonly ['http', 'sse', 'webSocket'];
  readonly operations: readonly ['route.register', 'route.update', 'route.close', 'http.intercept'];
  readonly endpoint: Readonly<{ host: '127.0.0.1'; port: number; token: string }>;
  readonly routeBaseUrl: string;
}
export interface PlaintextRoute {
  readonly baseUrl: string;
  readonly ready: Promise<unknown>;
  update(input: { upstreamBaseUrl: string; additionalCaPem?: string }): Promise<{ updated: true }>;
  close(): Promise<void>;
}
export interface PlaintextForwardRequest extends HttpForwardRequest {
  readonly credentialMode: 'original' | 'omit';
}
export interface PlaintextForwardResponse extends HttpChannelResponse {
  /** Actual last URL after redirects in the original client transport. */
  readonly finalUrl: string;
}
export interface PlaintextInterceptResponse extends Omit<PlaintextForwardResponse, 'body'> {
  /** Await cancellation to release the exchange before dependent requests. */
  readonly body: (AsyncIterable<Uint8Array> & { cancel(): Promise<void> }) | null;
}
export interface PlaintextSourceClient {
  /** Authenticated peer handshake. Route reservations can be made before this settles. */
  readonly ready: Promise<true>;
  reserveRoute(input: { upstreamBaseUrl: string; additionalCaPem?: string }): PlaintextRoute;
  registerRoute(input: { upstreamBaseUrl: string; additionalCaPem?: string }): Promise<PlaintextRoute>;
  interceptHttp(input: Pick<HttpForwardRequest, 'url' | 'method' | 'headers' | 'body'>, options: {
    forward(input: PlaintextForwardRequest, context: { signal: AbortSignal }): Promise<PlaintextForwardResponse>;
    signal?: AbortSignal;
  }): Promise<PlaintextInterceptResponse>;
  close(): void;
  status(): { open: boolean; routes: number; exchanges: number };
}
export declare function connectPlaintextSource(descriptor: PlaintextSourceDescriptor, options?: { signal?: AbortSignal }): PlaintextSourceClient;
export declare function createPlaintextSource(dependencies: {
  runtime: { api: { openChannel: (...args: unknown[]) => Promise<unknown> } };
  gateway: { handlers: TrafficInterceptors['handlers'] };
  signal: AbortSignal;
}): Promise<Readonly<{
  descriptor: PlaintextSourceDescriptor;
  close(): void;
  trustForProfile(id: string, target: URL): string;
  status(): { open: boolean; routes: number; exchanges: number };
}>>;
export declare function createTrafficInterceptors(dependencies: {
  rootSignal: AbortSignal;
  networkProfile?: string;
  maxActiveWebSocket?: number;
  authorize(owner: TrafficOwner, action: 'intercept' | 'sensitiveHeaders' | 'redirect', url: string, signal: AbortSignal): MaybePromise<boolean>;
}): TrafficInterceptors;
