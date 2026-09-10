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
    run(params: { executable: string; args: string[]; maxOutputBytes?: number }, options?: ManagedOptions): Promise<{ processId: number; exitCode: number; stdout: string; stderr: string; stdoutBytes: number; stderrBytes: number; jobReaped: boolean }>;
  };
  readonly system: { info(options?: ManagedOptions): Promise<{ os: string; architecture: string; logicalCpus: number }> };
}
export interface HostPlugin {
  activate(context: HostContext): void | Promise<void>;
  deactivate(cleanup: HostCleanupContext): void | Promise<void>;
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
