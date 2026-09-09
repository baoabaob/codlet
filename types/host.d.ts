/** Host JS ABI v1. TS authors compile to CommonJS .js/.cjs before distribution. */
export interface CdpEvent {
  method: string;
  params: Record<string, unknown> | null;
  sessionId: string | null;
}
export type CdpFilter = { scope: 'root' | 'all' } | { scope: 'session'; sessionId: string };
export interface CdpSubscription {
  readonly id: number;
  unsubscribe(): Promise<{ unsubscribed: boolean }>;
}
export interface HostContext {
  readonly plugin: Readonly<{ id: string; version: string; generation: number }>;
  readonly root: string;
  readonly signal: AbortSignal;
  readonly log: Pick<Console, 'log' | 'info' | 'warn' | 'error' | 'debug'>;
  readonly cdp: {
    request<T = unknown>(method: string, params?: Record<string, unknown>, options?: { sessionId?: string; timeoutMs?: number }): Promise<T>;
    subscribe(filter: CdpFilter, onEvent: (event: CdpEvent) => void | Promise<void>, onEnd?: (reason: string) => void | Promise<void>): Promise<CdpSubscription>;
  };
  readonly core: {
    request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  };
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
