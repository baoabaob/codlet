/** Adapter SDK: bundle this module into the consuming plugin's Host entry. */
export type TrafficBody = string | Uint8Array | Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array> | null;
export type TrafficHeaders = readonly (readonly [string, string])[];
export interface HttpChannelResponse { status: number; headers?: TrafficHeaders; body?: TrafficBody }
export interface TrafficRequest { readonly id: string; readonly url: string; readonly path: string; readonly method: string; readonly headers: TrafficHeaders; readonly body: AsyncIterable<Uint8Array> & { cancel(): boolean } }
export interface TrafficFrame { readonly data: string | Uint8Array; readonly binary: boolean }
export type TrafficTransform = (frame: TrafficFrame, context: { readonly signal: AbortSignal; readonly direction: 'clientToServer' | 'serverToClient' }) => TrafficFrame | string | Uint8Array | null | Promise<TrafficFrame | string | Uint8Array | null>;
export interface TrafficInterceptorOptions { id: string; origins: readonly string[]; priority?: number; timeoutMs?: number }
export interface TrafficInterceptor { readonly id: string; close(): Promise<void>; dispose(): Promise<void>; setEnabled(enabled: boolean): Promise<void>; inspect(): { registered: boolean; enabled: boolean; exchanges: number } }
export type TrafficRequestDecision = { request: Partial<Pick<TrafficRequest, 'url' | 'method' | 'headers'> & { body: TrafficBody }> } | { respond: HttpChannelResponse } | { block: true } | null | undefined;
export interface TrafficInterceptorHandlers {
  request?(value: TrafficRequest, context: { readonly signal: AbortSignal }): TrafficRequestDecision | Promise<TrafficRequestDecision>;
  response?(value: Readonly<HttpChannelResponse>, context: { readonly signal: AbortSignal; readonly source: 'upstream' | 'synthetic'; readonly request: Readonly<{ id: string; url: string; method: string }> }): Partial<HttpChannelResponse> | null | undefined | Promise<Partial<HttpChannelResponse> | null | undefined>;
  webSocket?(value: Readonly<Omit<TrafficRequest, 'method' | 'body'> & { protocols: readonly string[] }>, context: { readonly signal: AbortSignal }): { request?: { url?: string; headers?: TrafficHeaders }; block?: true; clientToServer?: TrafficTransform; serverToClient?: TrafficTransform } | null | undefined | Promise<{ request?: { url?: string; headers?: TrafficHeaders }; block?: true; clientToServer?: TrafficTransform; serverToClient?: TrafficTransform } | null | undefined>;
}
export interface HostContext {
  readonly signal: AbortSignal;
  readonly traffic: {
    registerInterceptor(options: TrafficInterceptorOptions, handlers: TrafficInterceptorHandlers): Promise<TrafficInterceptor>;
    inspect(): Promise<{ available: boolean; listening: boolean; attached: boolean; activatedSources: readonly { id: string; operations: readonly string[]; protocols: readonly string[]; coverage: readonly string[] }[]; registered: number; active: number; pending: number }>;
  };
}
export interface CodexTrafficCompatibility { platform?: 'win32' | 'darwin'; binarySha256?: string }
export interface CodexTrafficMetadata { readonly kind: 'model.responses' | 'model.list' | 'unknown'; readonly threadId: string | null; readonly model: null }
export type CodexTrafficHandlers = {
  [K in keyof TrafficInterceptorHandlers]?: TrafficInterceptorHandlers[K] extends ((value: infer V, context: infer C) => infer R) | undefined
    ? (value: V, context: C & Readonly<{ codex: CodexTrafficMetadata }>) => R : never;
};
export interface CodexTrafficStatus {
  readonly available: boolean;
  readonly fixtureVerified: boolean;
  readonly listening: boolean;
  readonly attached: boolean;
  readonly restartRequired: boolean;
  readonly officialOAuth: false;
  readonly existingLoadedThreads: false;
  readonly desktop: false;
  readonly attachments: false;
  readonly reason: string | null;
}
export declare function createCodexTraffic(context: Pick<HostContext, 'traffic' | 'signal'>, compatibility?: CodexTrafficCompatibility): Readonly<{
  probe(): Promise<CodexTrafficStatus>;
  registerInterceptor(options: Omit<TrafficInterceptorOptions, 'origins'> & { origins?: readonly string[]; kinds?: ('model.responses' | 'model.list')[] }, handlers: CodexTrafficHandlers): Promise<TrafficInterceptor>;
  classify: typeof classifyCodexTraffic;
  readJsonBody: typeof readCodexJsonBody;
  rewriteJsonBody: typeof rewrittenCodexJsonBody;
}>;
export declare function classifyCodexTraffic(request: { url: string; method: string; headers?: TrafficHeaders }): CodexTrafficMetadata;
export declare function readCodexJsonBody(request: { headers: readonly (readonly [string, string])[]; body: AsyncIterable<Uint8Array> | Iterable<Uint8Array> }, maximum?: number): Promise<unknown>;
export declare function rewrittenCodexJsonBody(request: Pick<HttpChannelResponse, 'headers'> & { headers: NonNullable<HttpChannelResponse['headers']> }, value: unknown): { body: string; headers: NonNullable<HttpChannelResponse['headers']> };
