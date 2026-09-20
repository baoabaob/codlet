/** Core-managed resources, invoked through codlet.core.services@1.
 * The dispatcher checks current grants; handles remain generation-owned.
 * Cross-plugin events require a centrally verified capability dependency;
 * topic provider generations and subscription consumer generations are pinned.
 * Callback tasks currently share only within the same owner.
 */
export interface ResourceCallOptions { timeoutMs?: number; signal?: AbortSignal }
export type ResourceBytes = readonly number[];
export interface ResourceError { code: string; message?: string }
export interface EventBatch<T = unknown> {
  events: { cursor: string; value: T }[];
  cursor: string;
  gap: boolean;
  terminal: 'topic_closed' | 'provider_retired' | null;
}
export interface TaskSnapshot {
  task: string;
  operationId: string;
  runner: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  cancelRequested: boolean;
  progress: unknown;
  result: unknown | null;
  error: unknown | null;
  revision: string;
  createdAt: number;
  deadlineAt: number;
  outcomeKnown: boolean;
  terminal: boolean;
}
export interface ClaimedTask {
  task: string;
  /** Returned only by claim; required for progress/finish. Never guess or reuse. */
  claim: string;
  input: unknown;
  remainingMs: number;
  deadlineAt: number;
}
export interface ProcessSnapshot {
  process: string;
  operationId: string;
  pid: number;
  closed: boolean;
  exitCode: number | null;
  processesReaped: boolean;
  ownershipScope: 'windows-job' | 'posix-process-group';
  workerDone: boolean;
  streamsClosed: boolean;
  stdoutEof: boolean;
  stderrEof: boolean;
  stdoutBuffered: number;
  stderrBuffered: number;
  outputDiscarded: boolean;
  error: string | null;
  nextWriteSequence: string;
}
export interface CoreResourceMethods {
  'events.createTopic': { params: { name: string; maxEvents?: number; maxBytes?: number; capability?: { name: string; api: number; scope: 'runtime' } }; result: { topic: string; cursor: string; scope: 'owner' | 'capability'; capability: { name: string; api: number; scope: 'runtime' } | null; maxEvents: number; maxBytes: number } };
  'events.publish': { params: { topic: string; event: unknown }; result: { cursor: string } };
  /** Omitted after starts after the latest event. Supply createTopic.cursor to replay. */
  'events.subscribe': { params: { topic: string; after?: string; capability?: { name: string; api: number; scope: 'runtime' } }; result: { subscription: string; cursor: string; scope: 'owner' | 'capability' } };
  /** Bounded replay log, not durable delivery. Repeated reads may repeat events. */
  'events.read': { params: { subscription: string; after?: string; limit?: number; waitMs?: number }; result: EventBatch };
  'events.ack': { params: { subscription: string; cursor: string }; result: { acknowledged: true; cursor: string } };
  'events.close': { params: { resource: string }; result: { closed: true } };
  'tasks.register': { params: { name: string }; result: { runner: string } };
  /** Same operationKey + same parameters returns the original task. No auto-retry. */
  'tasks.start': { params: { runner: string; input: unknown; operationKey: string; timeoutMs?: number }; result: TaskSnapshot };
  'tasks.claim': { params: { runner: string; limit?: number; waitMs?: number }; result: { tasks: ClaimedTask[]; cancellations: { task: string; state: TaskSnapshot['state']; cancelRequested: true }[] } };
  'tasks.progress': { params: { task: string; claim: string; progress: unknown }; result: TaskSnapshot };
  /** Only the claimant can finish. cancelled requires a preceding cancel request. */
  'tasks.finish': { params: { task: string; claim: string; state: 'succeeded' | 'failed' | 'cancelled'; result?: unknown; error?: unknown }; result: TaskSnapshot };
  'tasks.get': { params: { task: string }; result: TaskSnapshot };
  'tasks.result': { params: { task: string }; result: TaskSnapshot };
  'tasks.cancel': { params: { task: string }; result: TaskSnapshot };
  'tasks.list': { params: { limit?: number; after?: string }; result: { tasks: TaskSnapshot[]; cursor: string | null } };
  'tasks.unregister': { params: { runner: string }; result: { unregistered: true } };
  'processes.spawn': { params: { executable: string; args: string[]; cwd?: string; env?: Record<string, string>; stdin?: 'pipe' | 'closed'; operationKey: string }; result: ProcessSnapshot | { process: string; operationId: string; closed: true } };
  'processes.status': { params: { process: string }; result: ProcessSnapshot };
  'processes.read': { params: { process: string; stream: 'stdout' | 'stderr'; maxBytes?: number; waitMs?: number }; result: { bytes: number[]; eof: boolean; closed: boolean; error: string | null } };
  /** Single stdin writer. Start sequence at "0", then use nextSequence. Only the
   * last receipt is retained. Retrying that sequence never writes again; an
   * unconfirmed write closes stdin and terminates the managed process scope. */
  'processes.write': { params: { process: string; bytes: ResourceBytes; sequence: string }; result: { acceptedBytes: number; nextSequence: string; replayedReceipt?: true } };
  'processes.endInput': { params: { process: string }; result: { closed: true } };
  'processes.terminate': { params: { process: string }; result: { requested: true } };
  'processes.wait': { params: { process: string; waitMs?: number }; result: ProcessSnapshot };
  'processes.close': { params: { process: string }; result: { closed: true; processesReaped: true } };
  'resources.list': { params: Record<string, never>; result: { resources: Record<string, unknown>[]; bounded: true } };
}
export interface CoreResourceRequest {
  <M extends keyof CoreResourceMethods>(method: M, params: CoreResourceMethods[M]['params'], options?: ResourceCallOptions): Promise<CoreResourceMethods[M]['result']>;
}

/** Host callback runner integration contract:
 * 1. register a name; poll claim (waitMs <= 1000, no overlapping poll per runner).
 * 2. start each callback outside the claim RPC's AsyncLocalStorage lineage, with
 *    its own AbortController and deadline from remainingMs; retain task/claim.
 * 3. on each poll, abort matching cancellations, including interrupted tasks.
 *    Cancellation is cooperative: callbacks acknowledge it by throwing
 *    signal.reason or an AbortError. A normal return remains a success.
 * 4. progress/finish authenticate the claim; never finish again after a terminal
 *    response. cancelled means the callback has acknowledged cancellation.
 * 5. on plugin/document retirement abort local controllers and unregister; Core
 *    retires every owner resource. Current records are bounded, in-memory and
 *    generation-local; they do not promise durable restart/resume.
 * Callback results must serialize to at most 128 KiB of JSON. undefined is
 * normalized to null; invalid or oversized results finish the task as failed.
 */
export interface TaskRunnerInvocation {
  readonly task: string;
  /** Throw signal.reason (or an AbortError) to acknowledge cooperative cancellation. */
  readonly signal: AbortSignal;
  remainingMs(): number;
  progress(value: unknown): Promise<TaskSnapshot>;
}
