/** Public codlet.runtime.manage@1 DTOs. Type-only authoring material; no runtime
 * module or automatic retry helper is supplied by this declaration file. */
export type PluginPermission =
  | 'ui.dom' | 'ui.mainWorld' | 'cdp.raw' | 'host.process'
  | 'host.fs' | 'host.network' | 'host.system' | 'runtime.manage';

export interface BrokerPolicy {
  readonly readRoots?: readonly string[];
  readonly networkOrigins?: readonly string[];
  readonly executables?: readonly string[];
}

export interface LocalPluginRegistration {
  readonly path: string;
  readonly grants: readonly PluginPermission[];
  /** Omitted/empty means no filesystem roots, network origins or child programs. */
  readonly brokerPolicy?: BrokerPolicy;
}

export interface RuntimeManageDescriptor {
  readonly name: 'codlet.runtime.manage';
  readonly api: 1;
  readonly scope: 'runtime' | 'target';
}

/** prepare uses plugin_id, matching the existing control receipt protocol. */
export type PluginControlRequest =
  | { action: 'enable' | 'reload'; plugin_id: string; permission?: never; cascade?: false }
  | { action: 'disable'; plugin_id: string; permission?: never; cascade?: boolean }
  | { action: 'revoke'; plugin_id: string; permission: PluginPermission };

/** submit and operation take camelCase input even though replies are snake_case. */
export interface RuntimeManageOperationInput { operationId: string; }

export interface PluginControlError { code: string; message: string; }
export interface PluginGeneration { plugin_id: string; generation: number; }
export interface PluginTargetFailure {
  /** Empty for a native/process failure; never a fabricated renderer target. */
  target_id: string;
  plugin_id: string;
  stage: string;
  error: string;
}

export interface PluginControlReport {
  action: 'enable' | 'disable' | 'reload' | 'revoke';
  plugin_id: string;
  outcome: 'applied' | 'unchanged' | 'rolled_back' | 'degraded';
  desired_enabled: boolean;
  affected_plugin_ids: string[];
  generations: PluginGeneration[];
  target_failures: PluginTargetFailure[];
  message: string | null;
}

export type ControlCompletion =
  | { kind: 'report'; report: PluginControlReport }
  | { kind: 'error'; error: PluginControlError };

export interface ControlOperation {
  operation_id: string;
  request: PluginControlRequest;
  completion: ControlCompletion | null;
}

export type ControlStatus =
  | 'identified' | 'inspected' | 'inspection_too_large'
  | 'prepared' | 'queued' | 'running' | 'completed'
  | 'not_running' | 'busy' | 'not_ready' | 'stopping' | 'expired' | 'stale_host'
  | 'invalid_request' | 'incompatible' | 'untrusted_server' | 'communication_error' | 'timeout';

export interface ControlReport {
  schema_version: 1;
  host_pid: number;
  registry_scope: string | null;
  status: ControlStatus;
  operation: ControlOperation | null;
  error: string | null;
  /** Reserved for the separate read-only control inspection commands. */
  inspection?: unknown;
  host_inspection?: unknown;
}

export type PluginValidation =
  | { status: 'ok'; basis: 'runtime' | 'catalog_snapshot' }
  | { status: 'failed'; basis: 'catalog_snapshot'; error: PluginControlError }
  | { status: 'not_loaded'; basis: 'registration' };

export interface RuntimeManagePlugin {
  id: string;
  /** Manifest name, with the stable ID as fallback for older packages. */
  name: string;
  /** Other enabled/running plugins included by an explicit cascade disable. */
  disableDependents: string[];
  version: string | null;
  source: 'bundled' | 'local';
  path: string | null;
  grants: PluginPermission[];
  requestedPermissions: PluginPermission[] | null;
  validation: PluginValidation;
  enabled: boolean;
  active: boolean;
  registered: boolean;
  loaded: boolean;
  generation: number | null;
  loadedPath: string | null;
  metadataSource: 'runtime' | 'catalog_snapshot' | 'unavailable';
  execution?: {
    kind: 'host';
    state: 'starting' | 'active' | 'stopping' | 'failed' | 'exited';
    processId: number | null;
    error: string | null;
    /** Present only for combined packages; requires the matching renderer generation. */
    rendererActive?: boolean;
  };
}

/** Managed renderer list retains immediate registry semantics and may omit time. */
export interface RuntimeManageList { plugins: RuntimeManagePlugin[]; sampledAtUnixMs?: number; }
/** The Host runtime.manage service always identifies the owner-published sample time. */
export interface RuntimeManageSnapshot extends RuntimeManageList { sampledAtUnixMs: number; }

export interface RuntimeManageMethods {
  list: { params: null; result: RuntimeManageList };
  prepare: { params: PluginControlRequest; result: ControlReport };
  submit: { params: RuntimeManageOperationInput; result: ControlReport };
  operation: { params: RuntimeManageOperationInput; result: ControlReport };
}

/** Read-only `codlet plugin permissions <id> --json`; no active-state assertion. */
export interface PluginPermissionsReport {
  schema: 1;
  kind: 'codlet.plugin-permissions';
  pluginId: string;
  registration: LocalPluginRegistration;
  enabled: boolean;
}
