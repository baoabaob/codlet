/** Core renderer SDK API 1. Availability is probed per capability; these types
 * describe implementation coverage, not verified client/platform evidence. */
import type { CapabilityDescriptor, RpcOptions } from './renderer';
import type { RendererUiPageOptions, RendererUiPageHandle } from './renderer-ui';
import type { WorkspaceSession } from './codex-workspace';
import type { ComposerActionRegister, ComposerActionRegistration, ComposerActionStatus, ComposerActionClick } from './codex-ui';
import type { ReadMethods, WriteMethods, DesktopRead, DesktopWrite, DesktopCompatibility, DesktopEvent, EventRead, EventBatch, InterceptorOptions, SubmissionInterceptor, InterceptorHandle, InterceptorList, ThreadConfigurationOptions, ThreadConfigurationHandler, ThreadConfigurationHandle, ThreadConfigurationInfo } from './codex-desktop';
export * from './codex-desktop';
export * from './codex-workspace';
export * from './codex-permissions';
export * from './codex-ui';

type Read<M extends keyof ReadMethods> = (params: ReadMethods[M]['params'], options?: RpcOptions) => Promise<ReadMethods[M]['result']>;
type Write<M extends keyof WriteMethods> = (params: WriteMethods[M]['params'], options?: RpcOptions) => Promise<WriteMethods[M]['result']>;
type EmptyRead<M extends keyof ReadMethods> = (params?: ReadMethods[M]['params'], options?: RpcOptions) => Promise<ReadMethods[M]['result']>;
export interface CodexComposerActionHandle {
  readonly registration: Readonly<ComposerActionRegistration>;
  status(): Promise<ComposerActionStatus>;
  unregister(): Promise<{ removed: boolean }>;
  /** Immediate lease retirement; may be called after the owner has retired. */
  dispose(): void;
}
export interface CodexSdk {
  readonly api: 1;
  readonly capabilities: Readonly<Record<'navigation'|'composer'|'workspace'|'compatibility'|'submissions'|'read'|'write'|'events', CapabilityDescriptor>>;
  readonly navigation: {
    page(options: RendererUiPageOptions): Promise<Readonly<RendererUiPageHandle>>;
    newTaskDraft(params: { prompt: string }, options?: RpcOptions): Promise<{ opened: true; submitted: false }>;
  };
  readonly composer: {
    registerAction(options: Omit<ComposerActionRegister, 'token'> & { token?: string }, handler: (event: Readonly<ComposerActionClick & { anchor: HTMLElement | null }>) => unknown): Promise<CodexComposerActionHandle>;
  };
  readonly workspace: { connect(options?: RpcOptions): Promise<WorkspaceSession> };
  readonly compatibility: {
    probe(params?: Record<string, never>, options?: RpcOptions): Promise<DesktopCompatibility>;
    waitReady(params?: { timeoutMs?: number }, options?: RpcOptions): Promise<DesktopCompatibility>;
  };
  readonly backend: { readonly read: DesktopRead; readonly write: DesktopWrite };
  readonly selection: { readonly get: EmptyRead<'selection.get'> };
  readonly threads: { readonly list: EmptyRead<'threads.list'>; readonly loaded: EmptyRead<'threads.loaded'>; readonly get: Read<'threads.get'>; readonly configuration: Read<'threads.configuration'>; readonly open: Write<'threads.open'>; readonly reconfigure: Write<'threads.reconfigure'> };
  readonly turns: { readonly list: Read<'turns.list'>; readonly start: Write<'turns.start'>; readonly steer: Write<'turns.steer'>; readonly interrupt: Write<'turns.interrupt'> };
  readonly items: { readonly list: Read<'items.list'> };
  readonly models: { readonly list: EmptyRead<'models.list'> };
  readonly skills: { readonly list: EmptyRead<'skills.list'> };
  readonly providers: { readonly list: EmptyRead<'providers.list'> };
  readonly approvals: { readonly list: Read<'approvals.list'>; readonly respond: Write<'approvals.respond'> };
  readonly permissions: { readonly get: Read<'permissions.get'>; readonly update: Write<'permissions.update'>; register(options?: RpcOptions): Promise<() => void> };
  readonly events: { read(params?: EventRead, options?: RpcOptions): Promise<EventBatch>; onEvent(handler: (event: Readonly<DesktopEvent>) => unknown, options?: RpcOptions): Promise<() => void> };
  readonly submissions: { register(options: InterceptorOptions, handler: SubmissionInterceptor, invocation?: RpcOptions): Promise<InterceptorHandle>; list(params?: Record<string, never>, options?: RpcOptions): Promise<InterceptorList> };
  readonly configuration: { register(options: ThreadConfigurationOptions, handler: ThreadConfigurationHandler, invocation?: RpcOptions): Promise<ThreadConfigurationHandle>; list(params?: Record<string, never>, options?: RpcOptions): Promise<{ configurations: ThreadConfigurationInfo[] }> };
}
