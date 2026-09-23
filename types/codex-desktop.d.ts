/** Optional Desktop semantic API v1. These types belong to the adapter, not Core. */
import type { RendererContext, RpcOptions } from './renderer';

export interface DesktopCompatibility {
  api: 1;
  initializing: boolean;
  available: boolean;
  unavailable: { code: string; message: string } | null;
  build: { appVersion: string; buildNumber: string; appServerVersion: string | null };
  connection: 'existing-desktop-local' | null;
  transport: 'existing-app-host-services-and-native-request-client' | null;
  inputRewrite: true;
  contextInjection: true;
  presentationTransform: false;
  historyMutation: false;
  hooks: number;
  pendingSubmits: number;
  /** Independently probed; failure does not disable existing backend or submit APIs. */
  navigation: { available: boolean; unavailable: { code: string; message: string | null } | null };
  /** Present after initialization; changes only local task start/resume configuration. */
  threadConfiguration?: ThreadConfigurationCompatibility;
}
export interface Item {
  id: string;
  kind: 'user' | 'assistant' | 'reasoning' | 'command' | 'fileChange' | 'tool' | 'plan' | 'other';
  text: string | null;
  status: string | null;
  command?: string | null;
  cwd?: string | null;
  exitCode?: number | null;
  name?: string | null;
}
export interface Turn { id: string; status: string; items: Item[]; error: string | null }
export interface Thread {
  id: string;
  title: string | null;
  cwd: string | null;
  provider: string | null;
  /** Unix seconds from the authoritative thread metadata. */
  createdAt: number | null;
  updatedAt: number | null;
  turns: Turn[];
}
export interface Page { cursor?: string | null; limit?: number }
export interface DesktopSelection {
  /** Selected local task in this window; null on home, settings or other routes. */
  threadId: string | null;
  /** Running turn, never the most recently completed turn or a historical UI selection. */
  activeTurnId: string | null;
  /** False when history is unloaded, unsupported or exceeds the projection bound. */
  activeTurnKnown: boolean;
  resumeState: 'resumed' | 'loading' | 'unloaded';
  /** Native manager value; multiple Desktop windows can report owner. */
  streamRole: 'owner' | 'follower' | 'none';
}
export interface Model { id: string; model: string; name: string | null; description: string | null; isDefault: boolean; reasoningEfforts: string[] }
export interface Skill { name: string; description: string | null; path: string | null; enabled: boolean }
export interface ApprovalRequest {
  /** Opaque adapter-instance handle; never an underlying request id. */
  token: string;
  kind: 'command' | 'fileChange' | 'permissions' | 'userInput';
  threadId: string;
  turnId: string;
  itemId: string;
  reason: string | null;
  command?: string | null;
  cwd?: string | null;
  /** False means only decline is supported; use Desktop to grant these paths. */
  canApprove?: boolean;
  permissions?: { network: boolean; read: string[]; write: string[]; hasOtherPaths: boolean };
  questions?: { id: string; header: string | null; question: string; secret: boolean; options: { label: string; description: string | null }[] }[];
}
export interface ReadMethods {
  'selection.get': { params: Record<string, never>; result: DesktopSelection };
  'threads.list': { params: Page & { archived?: boolean }; result: { threads: Thread[]; cursor: string | null } };
  /** Metadata read; use paginated turns/items methods for history. */
  'threads.get': { params: { threadId: string }; result: Thread };
  'turns.list': { params: Page & { threadId: string }; result: { turns: Turn[]; cursor: string | null } };
  'items.list': { params: Page & { threadId: string; turnId?: string }; result: { items: { turnId: string; item: Item }[]; cursor: string | null } };
  'models.list': { params: Page; result: { models: Model[]; cursor: string | null } };
  'skills.list': { params: { cwd?: string }; result: { directories: { cwd: string | null; skills: Skill[]; errors: { path: string | null; message: string | null }[] }[] } };
  'providers.list': { params: Record<string, never>; result: { providers: { id: string; name: string; selected: boolean }[] } };
  'approvals.list': { params: { threadId: string }; result: { requests: ApprovalRequest[] } };
}
export type ApprovalReply = { token: string; decision: 'approve' | 'decline' } | { token: string; answers: Record<string, string[]> };
export interface WriteMethods {
  /** One-use, generation-bound ticket for registerThreadConfiguration. */
  getApi: { params: Record<string, never>; result: CallbackAccess };
  'configurations.list': { params: Record<string, never>; result: { configurations: ThreadConfigurationInfo[] } };
  /** Opens the existing Native task route. Native performs cold resume; opening
   * is a navigation receipt, not proof that loading or stream ownership finished.
   * Observe selection.changed or read selection.get before starting a turn. */
  'threads.open': { params: { threadId: string }; result: DesktopSelection & { status: 'opened' | 'opening'; alreadySelected: boolean } };
  /** Requires a task already open/resumed in the current owner Desktop window. */
  'turns.start': { params: { threadId: string; text: string; model?: string; effort?: string }; result: { threadId: string; turn: Turn } };
  'turns.steer': { params: { threadId: string; turnId: string; text: string }; result: { threadId: string; turnId: string } };
  /** Submitted is a request receipt; wait for turn.completed for the final state. */
  'turns.interrupt': { params: { threadId: string; turnId: string }; result: { threadId: string; turnId: string; status: 'submitted' } };
  'approvals.respond': { params: ApprovalReply; result: { token: string; status: 'submitted' } };
}
export type DesktopEvent = ({ type: 'adapter.ready'; connection: 'existing-desktop-local' }
  | { type: 'adapter.drift'; code: string; message: string | null }
  | ({ type: 'selection.changed' } & DesktopSelection)
  | { type: 'selection.unavailable'; code: string; message: string | null }
  | { type: 'thread.started'; thread: Thread }
  | { type: 'turn.started' | 'turn.completed'; threadId: string; turn: Turn }
  | { type: 'item.started' | 'item.completed'; threadId: string; turnId: string; item: Item }
  | { type: 'item.text.delta' | 'item.output.delta'; threadId: string; turnId: string; itemId: string; delta: string }
  | { type: 'approval.requested'; request: ApprovalRequest }
  | { type: 'approval.retired' | 'approval.resolved'; token: string; threadId: string }
  | { type: 'submission.blocked'; threadId: string | null; pluginId: string | null; message: string | null }
) & { readonly cursor: string };
export interface EventRead { cursor?: string; limit?: number; threadId?: string; waitMs?: number }
export interface EventBatch { events: DesktopEvent[]; cursor: string; gap: boolean }
export interface SubmissionDraft { readonly threadId: string; readonly text: string; readonly contextSources: readonly string[]; readonly source: 'turn.start' }
export interface SubmissionChange { text?: string; context?: { text: string; kind?: 'untrusted' | 'application' }[] }
export type SubmissionInterceptor = (draft: SubmissionDraft, options: Readonly<{ signal: AbortSignal }>) => void | SubmissionChange | Promise<void | SubmissionChange>;
export interface InterceptorOptions { id: string; priority?: number; timeoutMs?: number; enabled?: boolean }
export interface InterceptorInfo {
  pluginId: string; generation: number; id: string; priority: number; timeoutMs: number; enabled: boolean;
  calls: number; failures: number; lastDurationMs: number | null; totalDurationMs: number;
  /** Bounded SDK failure code and Unix milliseconds; no draft, context or error text. */
  lastFailure: { code: string; at: number } | null;
}
/** Returned only to the registering owner. The callable form preserves v1 disposal. */
export interface InterceptorHandle {
  (): void;
  /** Disabling also cancels submissions that already captured this interceptor. */
  setEnabled(enabled: boolean): void;
  inspect(): InterceptorInfo;
}
/** codex.ui.preSubmit@1 RPC also supports interceptors.list with empty arguments. */
export interface InterceptorList { interceptors: InterceptorInfo[] }
export interface CallbackAccess { api: 1; symbol: string; ticket: string }
export interface ThreadConfigurationCompatibility {
  available: boolean;
  appliesAt: ('thread.start' | 'thread.resume' | 'turn.start')[];
  existingLoadedThreads: boolean;
  hooks: number;
  pending: number;
  unavailable: { code: string; message: string } | null;
}
export interface ThreadConfigurationDraft {
  readonly source: 'thread.start' | 'thread.resume' | 'turn.start';
  readonly threadId: string | null;
  readonly cwd: string | null;
  readonly model: string | null;
  readonly provider: string | null;
}
export interface ThreadConfigurationChange {
  /** Model choice before backend request construction. At turn.start this also
   * updates an existing collaborationMode.settings.model. */
  model?: string;
  /** Select an already configured model provider. Mutually exclusive with provider. */
  modelProvider?: string;
  /** Create one task-local Responses provider without using ambient OAuth.
   * baseUrl must be a private loopback HTTP URL, such as an openChannel endpoint
   * with its API path appended. The Host channel owns upstream authentication. */
  provider?: { id?: string; baseUrl: string; name?: string; supportsWebSockets?: boolean };
}
/** Return nothing to leave Native configuration alone. More than one returned
 * change rejects the request. At turn.start only model is accepted; provider
 * changes remain limited to thread.start and thread.resume. */
export type ThreadConfigurationHandler = (draft: ThreadConfigurationDraft, options: Readonly<{ signal: AbortSignal }>) => void | ThreadConfigurationChange | Promise<void | ThreadConfigurationChange>;
export interface ThreadConfigurationOptions extends InterceptorOptions {
  /** Defaults to thread.start and thread.resume. Select turn.start to choose a
   * model for an existing task using draft.threadId. */
  appliesAt?: ('thread.start' | 'thread.resume' | 'turn.start')[];
}
export interface ThreadConfigurationInfo {
  pluginId: string; generation: number; id: string; enabled: boolean;
  priority: number; timeoutMs: number; appliesAt: ('thread.start' | 'thread.resume' | 'turn.start')[]; calls: number; applied: number; failures: number;
}
export interface ThreadConfigurationHandle {
  (): void;
  setEnabled(enabled: boolean): void;
  inspect(): ThreadConfigurationInfo;
}
/** Obtain a fresh getApi ticket through the corresponding declared capability.
 * The ticket can be claimed once, within 15 seconds, by the same live generation.
 * Callback registration requires main world; all data operations use Core RPC.
 */
export interface DesktopCallbackApi {
  readonly api: 1;
  registerPreSubmit(owner: RendererContext, ticket: string, options: InterceptorOptions, handler: SubmissionInterceptor): InterceptorHandle;
  registerThreadConfiguration(owner: RendererContext, ticket: string, options: ThreadConfigurationOptions, handler: ThreadConfigurationHandler): ThreadConfigurationHandle;
  onEvent(owner: RendererContext, ticket: string, handler: (event: Readonly<DesktopEvent>) => void): () => void;
}
/** Convenience typing for an author's own Core RPC wrapper. No private transport. */
export interface DesktopRead {
  <M extends keyof ReadMethods>(method: M, params: ReadMethods[M]['params'], options?: RpcOptions): Promise<ReadMethods[M]['result']>;
}
export interface DesktopWrite {
  <M extends keyof WriteMethods>(method: M, params: WriteMethods[M]['params'], options?: RpcOptions): Promise<WriteMethods[M]['result']>;
}
