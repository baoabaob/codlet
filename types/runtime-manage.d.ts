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

export interface PluginTranslation { name?: string; description?: string; }
export type PluginTranslations = Partial<Record<'zh' | 'en', PluginTranslation>>;
export interface SourceRemovalRequest { registrationDigest: string; sourceIdentity: string | null; }
export interface SourceRemovalPreview extends SourceRemovalRequest {
  schema: 1; kind: 'codlet.source-removal-preview'; pluginId: string; path: string;
  status: 'available' | 'missing' | 'blocked'; warning: string | null;
}

export interface RuntimeUpdateStatus {
  currentVersion: string;
  phase: 'development' | 'checking' | 'upToDate' | 'available' | 'downloading' | 'downloaded' | 'installRequested' | 'failed';
  configured: boolean;
  channel: string;
  lastCheckedAt: number | null;
  nextCheckAt: number | null;
  candidate: { id: string; version: string; platform: string; size: number; sha256: string; releaseUrl: string | null } | null;
  downloadedBytes: number;
  totalBytes: number;
  installAvailable: boolean;
  unavailableReason: string | null;
  error: { code: string; message: string } | null;
}

/** prepare uses plugin_id, matching the existing control receipt protocol. */
export type PluginControlRequest =
  | { action: 'enable' | 'reload'; plugin_id: string; permission?: never; cascade?: false; local_import?: never }
  | { action: 'disable'; plugin_id: string; permission?: never; cascade?: boolean; local_import?: never; remove_source?: never }
  | { action: 'remove'; plugin_id: string; permission?: never; cascade?: boolean; local_import?: never; remove_source?: SourceRemovalRequest }
  | { action: 'revoke'; plugin_id: string; permission: PluginPermission; cascade?: false; local_import?: never }
  | { action: 'import'; plugin_id: string; local_import: LocalImportRequest & { managed?: 'install' }; permission?: never; cascade?: false }
  | { action: 'update'; plugin_id: string; local_import: LocalImportRequest & { managed: 'update' }; permission?: never; cascade?: false }
  | { action: 'rollback'; plugin_id: string; local_import: LocalImportRequest & { managed: 'rollback' }; permission?: never; cascade?: false };

export interface LocalImportRequest {
  /** Exact canonical directory returned by the preview. Local development paths remain author-owned; managed paths are Core-owned. */
  path: string;
  contentDigest: string;
  registrationDigest: string;
  trusted: true;
  grants: PluginPermission[];
  brokerPolicy?: BrokerPolicy;
  /** Defaults to false; activation uses the same receipt as registration. */
  enable?: boolean;
  /** Core validates the package receipt; caller-supplied source metadata is never trusted. */
  managed?: 'install' | 'update' | 'rollback';
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
    schema: 1; id: string; name?: string; description?: string; i18n?: PluginTranslations; version: string;
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
  action: 'enable' | 'disable' | 'reload' | 'revoke' | 'import' | 'remove' | 'update' | 'rollback';
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
  description: string | null;
  i18n: PluginTranslations | null;
  /** Other enabled/running plugins included by an explicit cascade disable. */
  disableDependents: string[];
  version: string | null;
  source: 'bundled' | 'local';
  path: string | null;
  grants: PluginPermission[];
  brokerPolicy?: BrokerPolicy | null;
  ownership?: 'bundled' | 'development-directory' | 'core-managed-github';
  managedSource?: GitHubSource;
  managedVersionKey?: string;
  metadata?: PackageMetadata | null;
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
  runtimeVersion: string;
  clientStatus?: { status: 'officialUpdateAvailable' | 'unmatched' | 'matched' | 'unknown'; installedVersion?: string; latestVersion?: string | null; officialUpdateAvailable?: boolean; matchesLatestClient?: boolean; checkedAt?: number };
  plugins: RuntimeManagePlugin[]; sampledAtUnixMs?: number;
  localManagement?: { available: true; watchEnabled: boolean; folderPicker: boolean };
  githubManagement?: { available: true };
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
  sourceRemovalPreview: { params: { pluginId: string }; result: SourceRemovalPreview };
  openFolder: { params: { pluginId: string }; result: { pluginId: string; opened: true } };
  chooseLocalFolder: { params: null | { locale: 'zh' | 'en' }; result: FolderSelection };
  runtimeUpdateStatus: { params: null | Record<string, never>; result: RuntimeUpdateStatus };
  checkRuntimeUpdate: { params: null | Record<string, never>; result: RuntimeUpdateStatus };
  downloadRuntimeUpdate: { params: null | Record<string, never>; result: RuntimeUpdateStatus };
  installRuntimeUpdate: { params: null | Record<string, never>; result: RuntimeUpdateStatus };
  folderSelection: { params: { selectionId: string }; result: FolderSelection };
  githubReleases: { params: { url: string }; result: GitHubJob };
  githubPrepare: { params: { repositoryUrl: string; releaseId: number; assetId: number } & ({ operation?: 'install'; pluginId?: string } | { operation: 'update'; pluginId: string }); result: GitHubJob };
  githubJob: { params: { jobId: string }; result: GitHubJob };
  cancelGitHubJob: { params: { jobId: string }; result: GitHubJob };
  managedHistory: { params: { pluginId: string; cursor?: number }; result: ManagedHistory };
  previewRollback: { params: { pluginId: string; versionKey: string }; result: ManagedPreview };
}

/** Read-only `codlet plugin permissions <id> --json`; no active-state assertion. */
export interface PluginPermissionsReport {
  schema: 1;
  kind: 'codlet.plugin-permissions';
  pluginId: string;
  registration: LocalPluginRegistration;
  enabled: boolean;
  ownership?: 'development-directory' | 'core-managed-github';
  managedSource?: GitHubSource;
  managedVersionKey?: string;
  metadata?: PackageMetadata | null;
}

export interface GitHubRepository { owner: string; name: string; url: string; }
export interface GitHubReleaseAsset {
  id: number; name: string; size: number; contentType: string; downloadUrl: string; digest: string | null;
}
export interface GitHubRelease {
  id: number; tag: string; name: string; url: string; prerelease: boolean;
  publishedAt: string | null; assets: GitHubReleaseAsset[];
}
export interface GitHubReleaseCatalog {
  repository: GitHubRepository; releases: GitHubRelease[]; truncated: boolean;
  requestedTag: string | null; requestedAsset: string | null;
}
export interface GitHubSource {
  repositoryUrl: string; owner: string; repository: string;
  releaseId: number; tag: string; assetId: number; assetName: string; assetUrl: string;
  assetSize: number; sha256: string; upstreamDigestVerified: boolean;
}
/** Author declarations. Missing values mean unknown, never a compatibility assertion. */
export interface PackageMetadata {
  schema: 1; runtimeApi?: number | null; platforms?: string[] | null;
  author?: string | null; adapters?: unknown;
}
export interface ManagedVersion {
  versionKey: string; packagePath: string; contentDigest: string;
  source: GitHubSource; manifest: LocalImportPreview['manifest'];
  metadata?: PackageMetadata | null;
}
/** A bounded page of at most eight retained versions. History entries omit metadata;
 * previewRollback rereads the selected package and returns its complete metadata. */
export interface ManagedHistory { pluginId: string; currentVersion: string | null; history: ManagedVersion[]; nextCursor: number | null; }
export interface ManagedPreview {
  schema: 1; kind: 'codlet.managed-preview'; operation: 'install' | 'update' | 'rollback';
  ownership: 'core-managed-github'; path: string; contentDigest: string; registrationDigest: string;
  manifest: LocalImportPreview['manifest']; source: GitHubSource; metadata: PackageMetadata | null;
  existingRegistration: LocalPluginRegistration | null; existingEnabled: boolean;
  currentVersion: ManagedVersion | null;
  /** Full history remains available in CLI previews and older public replies. */
  history?: ManagedVersion[];
  /** Public RPC previews omit full history to stay within the response budget. */
  historyCount?: number;
  changes: {
    permissionsAdded: PluginPermission[]; permissionsRemoved: PluginPermission[];
    requirementsAdded: ImportCapability[]; requirementsRemoved: ImportCapability[];
    providesAdded: ImportCapability[]; providesRemoved: ImportCapability[];
  };
  dependencyCheck?: LocalImportPreview['dependencyCheck'];
}
/** Background preparation only. Completion does not register, trust or enable a plugin.
 * Poll the same job ID after an uncertain read; do not automatically repeat the start.
 * Cancellation invalidates delivery and may leave temporary downloaded bytes. */
export type GitHubJob =
  | { jobId: string; kind: 'releases' | 'package'; status: 'running'; stage?: string }
  | { jobId: string; kind: 'releases'; status: 'completed'; stage?: string; result: GitHubReleaseCatalog }
  | { jobId: string; kind: 'package'; status: 'completed'; stage?: string; result: ManagedPreview }
  | { jobId: string; kind: 'releases' | 'package'; status: 'cancelled'; stage?: string }
  | { jobId: string; kind: 'releases' | 'package'; status: 'failed'; stage?: string; error: PluginControlError };
