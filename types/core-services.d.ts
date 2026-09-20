import type {
  CredentialListInput,
  CredentialListResult,
  CredentialMetadata,
  CredentialPutInput,
  CredentialPutResult,
  CredentialRemoveInput,
  CredentialRemoveResult,
  PluginCoreServiceMethods,
  PluginStorageChangesInput,
  PluginStorageChangesResult,
  PluginStorageDirectories,
  PluginStorageGetInput,
  PluginStorageGetResult,
  PluginStorageSnapshot,
  PluginStorageTransactionInput,
} from './plugin-storage';
import type {
  CoreResourceMethods,
  EventBatch,
  ProcessSnapshot,
  ResourceBytes,
  ResourceCallOptions,
  TaskRunnerInvocation,
  TaskSnapshot,
} from './core-resources';

export type CoreServiceCallOptions = ResourceCallOptions;
export type CoreServiceRequest = (
  method: string,
  params: unknown,
  options?: CoreServiceCallOptions,
) => Promise<unknown>;

export interface CoreFileMethods {
  'files.openDialog': { params: { kind?: 'file' | 'directory'; suggestedName?: string }; result: FileDialogStatus };
  'files.saveDialog': { params: { kind?: 'file'; suggestedName?: string }; result: FileDialogStatus };
  'files.dialogStatus': { params: { dialog: string }; result: FileDialogStatus };
  'files.cancelDialog': { params: { dialog: string }; result: FileDialogStatus };
  'files.read': { params: FileTarget & { offset?: number; maxBytes?: number }; result: { data: string; encoding: 'base64'; offset: number; eof: boolean; size: number } };
  'files.stat': { params: FileTarget; result: FileMetadata };
  'files.readDir': { params: FileTarget; result: { entries: FileDirectoryEntry[] } };
  'files.writeAtomic': { params: FileTarget & { expectedVersion: string | null; data: string }; result: { version: string; bytesWritten: number } };
  'files.mkdir': { params: FileTarget; result: { created: true } };
  'files.remove': { params: FileTarget & { expectedVersion: string }; result: { removed: true } };
  'files.watch': { params: FileTarget; result: { watch: string; cursor: number; snapshot: unknown; recursive: false; pollIntervalMs: 300 } };
  'files.changes': { params: { watch: string; after?: number }; result: { events: { cursor: number; kind: 'changed'; rescan: true }[]; cursor: number; gap: boolean } };
  'files.unwatch': { params: { watch: string }; result: { closed: true } };
}

export type FileTarget =
  | { path: string; reference?: never }
  | { reference: string; path?: never };
export interface FileMetadata {
  kind: 'file' | 'directory';
  size: number;
  version: string;
  modifiedMs: number | null;
}
export interface FileDirectoryEntry {
  name: string;
  kind: 'file' | 'directory' | 'link';
  size: number;
  modified: string | null;
}
export type FileDialogStatus =
  | { dialog: string; status: 'selecting' | 'cancelled' }
  | { dialog: string; status: 'selected'; reference: string; path: string; access: 'read' | 'write' }
  | { dialog: string; status: 'failed'; code: string; message?: string };

/** Exact implemented Core service method map. */
export interface CoreServiceMethods
  extends PluginCoreServiceMethods,
    CoreFileMethods,
    Omit<CoreResourceMethods, 'resources.list'> {
  'resources.list': {
    params: Record<string, never>;
    result: {
      jobs: CoreResourceMethods['resources.list']['result'];
      files: unknown;
      desktop: DesktopResources;
      network: unknown;
    };
  };
  'diagnostics.read': {
    params: { after?: number };
    result: { events: readonly Record<string, unknown>[]; cursor: number; gap: boolean };
  };
  'network.profiles': { params: Record<string, never>; result: NetworkProfilesResult };
  'network.createProfile': { params: NetworkCreateProfileInput; result: { profile: string; revision: string } };
  'network.resolve': { params: NetworkRouteInput; result: NetworkRoute };
  'network.closeProfile': { params: { profile: string }; result: { closed: true } };
  'network.status': { params: Record<string, never>; result: { events: readonly NetworkStatusEvent[] } };
  'network.fetch': { params: NetworkFetchInput; result: NetworkFetchResult };
  'desktop.notify': { params: DesktopNotificationInput; result: DesktopNotificationReceipt };
  'desktop.dismissNotification': { params: { notification: string }; result: { dismissed: boolean; released: true } };
  'desktop.notificationEvents': { params: DesktopEventsInput; result: DesktopEventBatch<DesktopNotificationEvent> };
  'desktop.clipboardRead': { params: Record<string, never>; result: { text: string } };
  'desktop.clipboardWrite': { params: { text: string }; result: { written: true } };
  'desktop.registerShortcut': { params: DesktopShortcutInput; result: DesktopShortcutRegistration };
  'desktop.unregisterShortcut': { params: { registration: string }; result: { removed: true } };
  'desktop.shortcutEvents': { params: DesktopEventsInput; result: DesktopEventBatch<DesktopShortcutEvent> };
}

export interface CoreStorageServices {
  snapshot(options?: CoreServiceCallOptions): Promise<PluginStorageSnapshot>;
  get(params: PluginStorageGetInput, options?: CoreServiceCallOptions): Promise<PluginStorageGetResult>;
  transaction(params: PluginStorageTransactionInput, options?: CoreServiceCallOptions): Promise<PluginStorageSnapshot>;
  changes(params: PluginStorageChangesInput, options?: CoreServiceCallOptions): Promise<PluginStorageChangesResult>;
  directories(options?: CoreServiceCallOptions): Promise<PluginStorageDirectories>;
  clearCache(options?: CoreServiceCallOptions): Promise<{ cleared: true }>;
}

export interface CoreCredentialServices {
  list(params?: CredentialListInput | null, options?: CoreServiceCallOptions): Promise<CredentialListResult>;
  metadata(params: { reference: string }, options?: CoreServiceCallOptions): Promise<{ revision: number; credential: CredentialMetadata }>;
  put(params: CredentialPutInput, options?: CoreServiceCallOptions): Promise<CredentialPutResult>;
  remove(params: CredentialRemoveInput, options?: CoreServiceCallOptions): Promise<CredentialRemoveResult>;
}

type MethodGroup<Prefix extends string> = {
  [M in keyof CoreServiceMethods as M extends `${Prefix}.${infer Name}` ? Name : never]:
    M extends keyof CoreServiceMethods
      ? (params: CoreServiceMethods[M]['params'], options?: CoreServiceCallOptions) => Promise<CoreServiceMethods[M]['result']>
      : never;
};

export type CoreEventServices = MethodGroup<'events'>;
export type CoreFileServices = MethodGroup<'files'>;

export interface RegisteredTaskRunner {
  readonly runner: string;
  start(
    params: { input: unknown; operationKey: string; timeoutMs?: number },
    options?: CoreServiceCallOptions,
  ): Promise<TaskSnapshot>;
  close(): Promise<{ unregistered: boolean }>;
}
export interface CoreTaskServices {
  /** Callbacks acknowledge cancellation by throwing invocation.signal.reason or an AbortError. */
  register(
    name: string,
    callback: (input: unknown, invocation: TaskRunnerInvocation) => unknown | Promise<unknown>,
    options?: CoreServiceCallOptions,
  ): Promise<RegisteredTaskRunner>;
  start(params: CoreResourceMethods['tasks.start']['params'], options?: CoreServiceCallOptions): Promise<TaskSnapshot>;
  get(params: { task: string }, options?: CoreServiceCallOptions): Promise<TaskSnapshot>;
  result(params: { task: string }, options?: CoreServiceCallOptions): Promise<TaskSnapshot>;
  cancel(params: { task: string }, options?: CoreServiceCallOptions): Promise<TaskSnapshot>;
  list(params?: CoreResourceMethods['tasks.list']['params'], options?: CoreServiceCallOptions): Promise<CoreResourceMethods['tasks.list']['result']>;
}

export interface CoreProcessServices {
  start(params: CoreResourceMethods['processes.spawn']['params'], options?: CoreServiceCallOptions): Promise<CoreResourceMethods['processes.spawn']['result']>;
  status(params: { process: string }, options?: CoreServiceCallOptions): Promise<ProcessSnapshot>;
  read(params: CoreResourceMethods['processes.read']['params'], options?: CoreServiceCallOptions): Promise<CoreResourceMethods['processes.read']['result']>;
  /** Uint8Array and canonical base64 are converted to Rust's bounded byte array. */
  write(params: { process: string; bytes: ResourceBytes | Uint8Array | string; sequence: string }, options?: CoreServiceCallOptions): Promise<CoreResourceMethods['processes.write']['result']>;
  endInput(params: { process: string }, options?: CoreServiceCallOptions): Promise<{ closed: true }>;
  terminate(params: { process: string }, options?: CoreServiceCallOptions): Promise<{ requested: true }>;
  wait(params: CoreResourceMethods['processes.wait']['params'], options?: CoreServiceCallOptions): Promise<ProcessSnapshot>;
  close(params: { process: string }, options?: CoreServiceCallOptions): Promise<{ closed: true; processesReaped: true }>;
}

export type NetworkProxy =
  | 'direct'
  | 'system'
  | { url: string; credentialRef?: string };
export interface NetworkCreateProfileInput { proxy?: NetworkProxy; caPem?: string }
export interface NetworkRouteInput { url: string; profile?: string; proxy?: NetworkProxy }
export interface NetworkRoute {
  proxyUrl: string | null;
  source: 'direct' | 'system' | 'explicit';
  revision: string;
  caPem: string | null;
  trust: 'system+bundled';
  proxyCredentialRef: string | null;
}
export interface NetworkProfilesResult {
  proxyModes: readonly ['direct', 'system', 'explicit'];
  proxyProtocols: readonly ['http', 'https'];
  trustSources: readonly ['system', 'bundled', 'additionalPem'];
  profiles: readonly { profile: string; revision: string; proxy: 'direct' | 'system' | 'explicit'; additionalCa: boolean }[];
}
export interface NetworkFetchInput extends NetworkRouteInput {
  method?: string;
  headers?: readonly (readonly [string, string])[];
  /** Base64 request body. */
  data?: string;
  maxBytes?: number;
  /** Resolved as an origin-bound bearer token inside Core. */
  credentialRef?: string;
}
export interface NetworkFetchResult {
  status: number;
  headers: readonly (readonly [string, string])[];
  data: string;
  encoding: 'base64';
  profileRevision: string;
}
export interface NetworkStatusEvent {
  time: number;
  origin: string;
  elapsedMs: number;
  profileRevision: string;
  proxy: NetworkRoute['source'];
  phase: 'complete' | 'failed';
  code: string | null;
}
export interface CoreNetworkServices {
  profiles(params?: Record<string, never>, options?: CoreServiceCallOptions): Promise<NetworkProfilesResult>;
  createProfile(params: NetworkCreateProfileInput, options?: CoreServiceCallOptions): Promise<{ profile: string; revision: string }>;
  resolve(params: NetworkRouteInput, options?: CoreServiceCallOptions): Promise<NetworkRoute>;
  closeProfile(params: { profile: string }, options?: CoreServiceCallOptions): Promise<{ closed: true }>;
  status(params?: Record<string, never>, options?: CoreServiceCallOptions): Promise<{ events: readonly NetworkStatusEvent[] }>;
  fetch(params: NetworkFetchInput, options?: CoreServiceCallOptions): Promise<NetworkFetchResult>;
}

export interface DesktopNotificationInput {
  title: string;
  body?: string;
  /** Native notifications currently support only whole-notification clicks. */
  actions?: readonly [];
}
export interface DesktopNotificationReceipt {
  notification: string;
  state: 'submitted';
  /** Visibility cannot be confirmed by the native APIs. */
  visible: null;
}
export interface DesktopShortcutInput { shortcut: string; actionId: string }
export interface DesktopShortcutRegistration {
  registration: string;
  normalized: string;
}
export interface DesktopEventsInput { after?: number }
export interface DesktopEventBase {
  cursor: number;
  resource: string;
  time: number;
}
export interface DesktopNotificationEvent extends DesktopEventBase {
  kind: 'notification';
  event: 'submitted' | 'clicked' | 'hidden' | 'dismissed' | 'released';
  actionId: null;
}
export interface DesktopShortcutEvent extends DesktopEventBase {
  kind: 'shortcut';
  event: 'pressed';
  actionId: string;
}
export interface DesktopEventBatch<Event extends DesktopEventBase> {
  events: readonly Event[];
  cursor: number;
  gap: boolean;
}
export interface DesktopResources {
  shortcuts: readonly { registration: string; shortcut: string; actionId: string }[];
  notifications: readonly string[];
}
export interface CoreDesktopServices {
  notify(params: DesktopNotificationInput, options?: CoreServiceCallOptions): Promise<DesktopNotificationReceipt>;
  dismissNotification(params: { notification: string }, options?: CoreServiceCallOptions): Promise<{ dismissed: boolean; released: true }>;
  notificationEvents(params?: DesktopEventsInput, options?: CoreServiceCallOptions): Promise<DesktopEventBatch<DesktopNotificationEvent>>;
  clipboardRead(params?: Record<string, never>, options?: CoreServiceCallOptions): Promise<{ text: string }>;
  clipboardWrite(params: { text: string }, options?: CoreServiceCallOptions): Promise<{ written: true }>;
  registerShortcut(params: DesktopShortcutInput, options?: CoreServiceCallOptions): Promise<DesktopShortcutRegistration>;
  unregisterShortcut(params: { registration: string }, options?: CoreServiceCallOptions): Promise<{ removed: true }>;
  shortcutEvents(params?: DesktopEventsInput, options?: CoreServiceCallOptions): Promise<DesktopEventBatch<DesktopShortcutEvent>>;
}

export interface CoreServices {
  readonly storage: CoreStorageServices;
  readonly credentials: CoreCredentialServices;
  readonly events: CoreEventServices;
  readonly files: CoreFileServices;
  readonly tasks: CoreTaskServices;
  readonly processes: CoreProcessServices;
  readonly network: CoreNetworkServices;
  readonly desktop: CoreDesktopServices;
  readonly resources: { list(params?: Record<string, never>, options?: CoreServiceCallOptions): Promise<CoreServiceMethods['resources.list']['result']> };
  readonly diagnostics: { read(params?: { after?: number }, options?: CoreServiceCallOptions): Promise<CoreServiceMethods['diagnostics.read']['result']> };
  close(): Promise<{ closed: true }>;
}

export interface CoreServicesRuntimeOptions {
  request: CoreServiceRequest;
  rootSignal: AbortSignal;
  /** Runs callback outside an inherited capability RPC AsyncLocalStorage lineage. */
  detach<T>(callback: () => T): T;
}

export declare function createCoreServicesRuntime(options: CoreServicesRuntimeOptions): CoreServices;

export type { EventBatch };
