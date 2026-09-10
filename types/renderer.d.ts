/** Official renderer ABI v1. Renderer instances provide Target capabilities. */
export interface CapabilityDescriptor { readonly name: string; readonly api: number; readonly scope: 'runtime' | 'target' }
export interface RpcOptions { timeoutMs?: number; signal?: AbortSignal }
export interface RendererInvocation {
  readonly pluginId: string;
  readonly generation: number;
  readonly capability: Readonly<CapabilityDescriptor>;
  readonly method: string;
  readonly caller: Readonly<{ pluginId: string; generation: number; targetId: string; documentEpoch: number }>;
  readonly scope: Readonly<{ kind: 'runtime' } | { kind: 'target'; targetId: string; epoch: number }>;
  readonly depth: number;
  readonly signal: AbortSignal;
  remainingMs(): number;
  /** Use this bound client for nested calls; browsers have no Host AsyncLocalStorage. */
  readonly rpc: RendererRpc;
}
export interface RendererRpc {
  request<T = unknown>(capability: CapabilityDescriptor, method: string, params?: unknown, options?: RpcOptions): Promise<T>;
  /** Legacy shorthand requires exactly one declared requirement. */
  request<T = unknown>(method: string, params?: unknown, options?: RpcOptions): Promise<T>;
  /** A bounded notification has no response receipt; provider errors are diagnosed by Core. */
  notify(capability: CapabilityDescriptor, method: string, params?: unknown): void;
  notify(method: string, params?: unknown): void;
  provide<P = unknown, R = unknown>(capability: CapabilityDescriptor & { scope: 'target' }, method: string, handler: (params: P, invocation: RendererInvocation) => R | Promise<R>): Readonly<{ ok: true }>;
  onNotification(handler: (message: unknown) => void): () => void;
}
export interface RendererContext { readonly pluginId: string; readonly version: string; readonly generation: number; readonly rpc: RendererRpc }
export interface RendererPlugin { activate(context: RendererContext): void | Promise<void>; deactivate(): void | Promise<void> }
