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
  | { action: 'enable' | 'reload'; plugin_id: string; permission?: never; cascade?: false; local_import?: never }
  | { action: 'disable' | 'remove'; plugin_id: string; permission?: never; cascade?: boolean; local_import?: never }
  | { action: 'revoke'; plugin_id: string; permission: PluginPermission; cascade?: false; local_import?: never }
  | { action: 'import'; plugin_id: string; local_import: LocalImportRequest; permission?: never; cascade?: false };

export interface LocalImportRequest {
  /** Exact canonical directory returned by previewLocal. The directory remains author-owned. */
  path: string;
  contentDigest: string;
  registrationDigest: string;
  trusted: true;
  grants: PluginPermission[];
  brokerPolicy?: BrokerPolicy;
  /** Defaults to false; activation uses the same receipt as registration. */
  enable?: boolean;
}

export interface ImportCapability { name: string; api: number; scope: 'runtime' | 'target' | 'backend-session' | 'thread'; }
export interface LocalImportPreview {
  schema: 1;
  kind: 'codlet.local-import-preview';
  path: string;
  contentDigest: string;
  registrationDigest: string;
  ownership: 'development-directory';
  existingRegistration: LocalPluginRegistration | null;
  existingEnabled: boolean;
  manifest: {
    schema: 1; id: string; name?: string; version: string;
    renderer?: { entry: string; world: 'isolated' | 'main' };
    host?: { entry: string; provides?: ImportCapability[]; requires?: ImportCapability[] };
    permissions: PluginPermission[]; provides: ImportCapability[]; requires: ImportCapability[];
  };
  /** Present on the live public service; CLI preview has no running-session assertion. */
  watchEnabled?: boolean;
  dependencyCheck?: {
    basis: 'runtime_list'; sampledAtUnixMs: number | null;
    requirements: { entry: 'host' | 'renderer'; capability: ImportCapability; status: 'available' | 'unavailable' | 'declared_by_import' | 'unknown' }[];
  };
}

export type FolderSelection =
  | { selectionId: string; status: 'selecting' | 'cancelled' }
  | { selectionId: string; status: 'selected'; path: string }
  | { selectionId: string; status: 'failed'; error: string };

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
  action: 'enable' | 'disable' | 'reload' | 'revoke' | 'import' | 'remove';
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
  brokerPolicy?: BrokerPolicy | null;
  ownership?: 'bundled' | 'development-directory';
  requestedPermissions: PluginPermission[] | null;
  providedCapabilities?: ImportCapability[] | null;
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
export interface RuntimeManageList {
  plugins: RuntimeManagePlugin[]; sampledAtUnixMs?: number;
  localManagement?: { available: true; watchEnabled: boolean; folderPicker: boolean };
}
/** The Host runtime.manage service always identifies the owner-published sample time. */
export interface RuntimeManageSnapshot extends RuntimeManageList { sampledAtUnixMs: number; }

export interface RuntimeManageMethods {
  list: { params: null; result: RuntimeManageList };
  prepare: { params: PluginControlRequest; result: ControlReport };
  submit: { params: RuntimeManageOperationInput; result: ControlReport };
  operation: { params: RuntimeManageOperationInput; result: ControlReport };
  previewLocal: { params: { path: string }; result: LocalImportPreview };
  permissions: { params: { pluginId: string }; result: PluginPermissionsReport };
  chooseLocalFolder: { params: null; result: FolderSelection };
  folderSelection: { params: { selectionId: string }; result: FolderSelection };
}

/** Read-only `codlet plugin permissions <id> --json`; no active-state assertion. */
export interface PluginPermissionsReport {
  schema: 1;
  kind: 'codlet.plugin-permissions';
  pluginId: string;
  registration: LocalPluginRegistration;
  enabled: boolean;
}
