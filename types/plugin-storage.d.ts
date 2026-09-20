/** DTOs for plugin-owned persistence exposed through codlet.core.services@1. */
export type PluginJson =
  | null
  | boolean
  | number
  | string
  | readonly PluginJson[]
  | { readonly [key: string]: PluginJson };

export interface PluginStorageSnapshot {
  readonly schema: 1;
  readonly revision: number;
  /** Durable cursor for storage.changes. Equal to revision in API v1. */
  readonly cursor: number;
  readonly config: Readonly<Record<string, PluginJson>>;
  readonly entries: Readonly<Record<string, PluginJson>>;
}

export interface PluginStorageGetInput {
  readonly key: string;
}

export interface PluginStorageGetResult {
  readonly revision: number;
  readonly key: string;
  readonly found: boolean;
  /** Null when the key does not exist; found distinguishes a stored null. */
  readonly value: PluginJson | null;
}

export type PluginStorageOperation =
  | { readonly op: 'set'; readonly key: string; readonly value: PluginJson }
  | { readonly op: 'remove'; readonly key: string };

export interface PluginStorageTransactionInput {
  /** The current snapshot revision. A stale value fails with storage_conflict. */
  readonly expectedRevision: number;
  /** When present, atomically replaces the complete plugin configuration object. */
  readonly config?: Readonly<Record<string, PluginJson>>;
  readonly operations?: readonly PluginStorageOperation[];
}

export interface PluginStorageChange {
  readonly cursor: number;
  readonly configChanged: boolean;
  readonly keys: readonly string[];
}

export interface PluginStorageChangesInput {
  readonly afterCursor: number;
  /** 1..100; defaults to 50. */
  readonly limit?: number;
}

export interface PluginStorageChangesResult {
  readonly cursor: number;
  readonly revision: number;
  readonly resetRequired: boolean;
  readonly changes: readonly PluginStorageChange[];
  /** Present when the requested cursor has fallen out of bounded history. */
  readonly snapshot?: PluginStorageSnapshot;
}

export interface PluginStorageDirectories {
  /** Stable across reloads and updates for the same registered source identity. */
  readonly dataPath: string;
  readonly cachePath: string;
  readonly dataBytes: number;
  readonly cacheBytes: number;
  readonly dataQuotaBytes: number;
  readonly cacheQuotaBytes: number;
  /** Core enforces quotas for its own writes. A Host with a raw path is not sandboxed. */
  readonly quotaEnforcement: 'core-writes-only';
}

export interface CredentialMetadata {
  /** Opaque reference scoped to the authenticated plugin registration. */
  readonly reference: string;
  /** Canonical HTTP(S) origin. ws/wss inputs normalize to http/https. */
  readonly origin: string;
  readonly label: string | null;
  readonly createdRevision: number;
  readonly updatedRevision: number;
}

export interface CredentialListInput {
  readonly origin?: string;
}

export interface CredentialListResult {
  readonly revision: number;
  readonly credentials: readonly CredentialMetadata[];
}

export interface CredentialPutInput {
  readonly expectedRevision: number;
  /** Omit to create a new opaque reference; include to rotate an existing secret. */
  readonly reference?: string;
  readonly origin: string;
  readonly label?: string;
  readonly secret: string;
}

export interface CredentialPutResult {
  readonly revision: number;
  readonly credential: CredentialMetadata;
}

export interface CredentialRemoveInput {
  readonly expectedRevision: number;
  readonly reference: string;
}

export interface CredentialRemoveResult {
  readonly revision: number;
  readonly removed: true;
}

/**
 * Method map for the shared Core dispatcher. There is deliberately no public
 * credential resolve/get-secret method; authorized Host network operations
 * resolve references inside Core at their final dispatch point.
 */
export interface PluginCoreServiceMethods {
  'storage.snapshot': { params: null; result: PluginStorageSnapshot };
  'storage.get': { params: PluginStorageGetInput; result: PluginStorageGetResult };
  'storage.transaction': { params: PluginStorageTransactionInput; result: PluginStorageSnapshot };
  'storage.changes': { params: PluginStorageChangesInput; result: PluginStorageChangesResult };
  'storage.directories': { params: null; result: PluginStorageDirectories };
  'storage.clearCache': { params: null; result: { readonly cleared: true } };
  'credentials.list': { params: CredentialListInput | null; result: CredentialListResult };
  'credentials.metadata': {
    params: { readonly reference: string };
    result: { readonly revision: number; readonly credential: CredentialMetadata };
  };
  'credentials.put': { params: CredentialPutInput; result: CredentialPutResult };
  'credentials.remove': { params: CredentialRemoveInput; result: CredentialRemoveResult };
}

export type PluginCoreServiceMethod = keyof PluginCoreServiceMethods;
export type PluginCoreServiceParams<M extends PluginCoreServiceMethod> =
  PluginCoreServiceMethods[M]['params'];
export type PluginCoreServiceResult<M extends PluginCoreServiceMethod> =
  PluginCoreServiceMethods[M]['result'];
