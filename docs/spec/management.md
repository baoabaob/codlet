# Registration, lifecycle and package management

CLI, GUI and authorized plugins use the same Core registration and lifecycle coordinator. Public `codlet.runtime.manage@1` supports Runtime and Target scope and requires an exact requirement plus declared/granted `runtime.manage`. This is broad administrative authority, including importing plugins and choosing grants for them; it is not a harmless read-only list permission. Parameters cannot choose another caller or registry. Types are in [runtime-manage.d.ts](../../types/runtime-manage.d.ts).

## Register an explicitly reviewed source

```text
plugin preview ABSOLUTE_PLUGIN_DIRECTORY --json
plugin add ABSOLUTE_PLUGIN_DIRECTORY --trust --grant ui.dom --enable --json
plugin permissions dev.notes --json
```

Preview inspects the manifest and built entries without executing JavaScript, compiling code or installing dependencies. Add without trust does not register or activate code. A confirmed import selects every grant and [broker scope](permissions.md); omitted `--enable` means disabled. Each supported permission may be granted once. Unknown and duplicate grants are rejected. A directory inside the default packages folder is not automatically trusted or loaded.

The canonical path, logical ID, complete grants/policy and enabled preference form the reviewed state. Reusing an ID at another development path conflicts; remove the prior registration and explicitly trust the new source. A stopped same-ID/same-path registration can be replaced with the complete confirmed trust record. Dependency inspection is an observation; activation still validates the actual entry graph. Core does not automatically download missing providers.

## One operation, one receipt

1. `prepare({action, plugin_id, ...})` checks and snapshots the intended mutation and returns `status:'prepared'` with `operation.operation_id`.
2. Persist that ID in caller state before `submit({operationId})`. Submit once.
3. Query `operation({operationId})` until completion or an explicit expired/stale/failure state. A lost submit response is not proof the operation was never admitted.

```js
const manage = { name: 'codlet.runtime.manage', api: 1, scope: 'runtime' };
const prepared = await context.rpc.request(manage, 'prepare', {
  action: 'reload', plugin_id: 'dev.notes'
});
if (prepared.status !== 'prepared') throw new Error(prepared.status);
const operationId = prepared.operation.operation_id;
try { await context.rpc.request(manage, 'submit', { operationId }); }
catch { /* Keep operationId; inspect the same receipt. */ }
const current = await context.rpc.request(manage, 'operation', { operationId });
```

Prepare uses `plugin_id`; submit/query use `operationId`. Control replies retain snake_case (`schema_version`, `host_pid`, `registry_scope`, `operation`). Completion is either an error or a report with `applied`, `unchanged`, `rolled_back` or `degraded`. `rolled_back` means the attempted transaction failed and prior state was restored; it is not success of the requested update. `target_failures` records actual executor/stage failures.

Repeated valid receipt submission is idempotent in Core, but clients must not invent another receipt or switch to an offline registry write after uncertainty. Use bounded polling and caller cancellation; do not wait indefinitely in an activation callback for a mutation of its own provider. Management requests are bounded to 4 KiB, responses to 256 KiB; admission supports eight pending operations and 128 retained records. Receipts are bounded session records, not permanent history.

## Lifecycle and source ownership

`enable`, `disable`, `reload`, `revoke`, `remove`, `import` and managed `update` use the same transaction path. The compatibility `rollback` action still exists with the restrictions below.

- Disable/remove reject enabled or running dependents unless `cascade:true` is explicit. Cascade disables the dependent closure, but removes only the requested registration. Core persists the whole disabled closure before retirement; it does not reactivate it as compensation.
- Reload validates sources/trust, retires the selected provider and transitive dependents, then replaces them at fresh generations. Renderer cleanup precedes Host stop; Host readiness precedes dependent Renderer activation. Failed replacement may restore prior immutable snapshots under current trust. It never restores concurrently revoked authority.
- Revoke saves reduced grants/scopes before retiring the affected generation and dependents. Enabled preferences remain, but missing declared grants prevent renewed execution; there is no automatic compensation that regains the revoked authority.
- Default removal preserves source files and independent plugin data. Optional source deletion requires a fresh `sourceRemovalPreview` and matching registration/source identity, or explicit CLI `--delete-source`. Missing/blocked sources remain unregisterable. Core must verify its target ownership before deleting files.

Official GUI/adapters are ordinary independently registered packages, not privileged embedded identities. Their display names do not grant extra trust. Legacy actually-bundled entries are handled according to their real ownership; do not treat all official IDs as unremovable.

Online commands identify the matching runtime and share its receipt. Offline mutations require proving that registry has no running owner; they save next-start intent, not an active-state claim. Reload requires a live runtime. Safe mode preserves registrations and files but permits only reduction of authority, such as disable/revoke/removal while keeping source; it does not admit activation/import/update.

## Local import and live information

`previewLocal({path})` returns canonical source, manifest, `contentDigest`, `registrationDigest`, existing registration/enablement and optional dependency/watch observations. A confirmed import includes these exact digests, `trusted:true`, selected `grants`/`brokerPolicy` and optional `enable`. Core checks the state again before commit; a changed path/content/trust requires a fresh decision.

`list` reports one row per logical package: registration, loaded snapshot, source/metadata, enabled intent, active execution and failures remain distinct. Combined active state requires matching entry generations. Host lists identify their published sample time; Renderer listing may omit it. `permissions({pluginId})` reads fresh registration, not proof of healthy execution. `chooseLocalFolder` returns an asynchronous selection ID; poll `folderSelection` and only preview a successfully selected path. `openFolder` accepts a plugin ID, not arbitrary shell input; `openRuntimeFolder` accepts only `installation` or `logs`.

## GitHub preparation and single-version installation

The unauthenticated importer reads public GitHub Release assets. It does not use local GitHub credentials, browser login or private/draft release access. Accepted URLs are GitHub repository/release/tag/latest/asset forms without credentials/query/fragment; arbitrary hosts and Enterprise URLs are not accepted. Release listing is bounded to 100 records and reports truncation. Use an explicitly selected built plugin ZIP, not GitHub's source-code archive. [Plugin format](plugin-format.md) defines archive/metadata limits.

`githubDiscover({query?,page?,refresh?})` searches public GitHub repositories with the `codlet-plugin` topic. Name terms and `#tag` terms may be combined; tags filter GitHub topics, not every unpublished manifest label. Pages contain at most ten repository candidates, up to page ten. Each request owns a separate cancellable job; only completed pages are shared through a ten-minute bounded cache, and `refresh:true` starts a new lookup. Each candidate includes numeric GitHub repository/owner IDs and the latest Release containing an uploaded, size-bounded ZIP candidate.

A publisher may add a separate `codlet-release.json` asset to a Release. Core reads at most 16 KiB and matches its single named ZIP, byte size and SHA-256 against GitHub's Release asset metadata and digest. A match exposes `declaredPackage` with the publisher's manifest/metadata, its designated asset's `downloadCount`, and declaration-based device compatibility. This is an author claim, not verification of the ZIP contents or certification. `latestReleaseVerified` remains false and discovery `pluginId` remains null; `githubPrepare` still downloads and inspects the exact ZIP, then records its fresh Release publication time in the Core receipt. `latestInstallablePublishedAt` can be shown as declaration-based publication data when the latest ZIP candidate has a matching declaration. `totalDownloads` sums only designated ZIP assets when the Release page is complete and every ZIP-bearing Release has a matching declaration and known count; truncation, gaps, inconsistent declarations or more than four candidate Releases keep it null. README/example ZIPs are never included merely because of their names or extension. Search failures remain queryable job errors and can be retried; the four-worker limit also applies.

`githubReleases` and `githubPrepare` start asynchronous preparation jobs; `githubJob` reads the same job and `cancelGitHubJob` cancels delivery. These jobs are separate from mutation receipts and never register/trust/enable code. At most four workers and 16 retained results are admitted; network preparation is bounded to two minutes. Cancellation can leave temporary downloaded bytes while work finishes. A completed package job returns a managed preview with source identity, hashes, candidate manifest/metadata and permission/dependency changes.

```text
plugin github releases https://github.com/OWNER/REPO --json
plugin github discover '#adapter' --page 1 --json
plugin github preview https://github.com/OWNER/REPO --release RELEASE_ID --asset ASSET_ID --json
plugin github install PREVIEW_PATH --trust --grant ui.dom --enable --json
plugin github preview https://github.com/OWNER/REPO --release NEW_RELEASE_ID --asset NEW_ASSET_ID --update dev.notes --json
plugin github update dev.notes PREVIEW_PATH --trust --grant ui.dom --enable --json
plugin github preview https://github.com/OWNER/REPO --release RELEASE_ID --asset ASSET_ID --adopt dev.notes --json
plugin github adopt dev.notes PREVIEW_PATH --trust --grant ui.dom --enable --json
```

Core generates the source receipt; caller-supplied provenance is not accepted as authority. The final import request pairs `managed:'install'` with `action:'import'`, or `managed:'update'|'adopt'` with `action:'update'`, retains the exact preview digests, and confirms grants/scopes/enablement. Changing repositories or changing from local to managed ownership does not inherit trust silently. Installed managed sources are checked again at startup/enable/reload and should not be edited in place.

`managed:'adopt'` pairs with `action:'update'` only after an explicit `githubPrepare` adoption preview. Core requires the existing registration to be an unmodified installer package proven by its local receipt and complete file record. A same-ID custom local registration cannot be adopted. This transaction preserves the reviewed grants, broker policy and enabled preference selected by the caller, while publishing a new verified GitHub package for offline use. Fresh package receipts include GitHub repository and owner numeric IDs; clients classify maintained sources by these IDs together with the full repository name and inspected plugin ID, not by topic, ID alone or author text. Core has no official repository allowlist.

`codlet-package.json` metadata is read through one bounded validator for local imports, installer packages and GitHub packages. Its platform and Runtime API declarations produce `deviceCompatibility` with explicit `compatible`, `incompatible` or `unknown` status. Missing declarations remain unknown. Incompatible packages may be previewed but cannot be registered. Adapter declarations are author data and do not establish client build support or certification.

**Normal successful installs and updates maintain one current package at `packages/github/<plugin-id>` beside the registry, and remove the old package after success.** Registration at that installation path keeps a one-item current record. Temporary staging/checkpoints support an in-progress transaction and failure recovery; they are not a user-facing version archive. A failed activation attempts restoration only if the transaction still owns the expected registration/provenance. Concurrent trust changes prevent unsafe restoration and are reported as degradation.

### Compatibility history API

`managedHistory({pluginId,cursor?})`, `previewRollback({pluginId,versionKey})`, CLI `github history/rollback` and the `rollback` action remain in the public implementation. Do not remove them merely as document cleanup. History pages contain at most eight retained records and omit large metadata; previews reread complete candidate metadata. These endpoints expose records actually present in a compatible registry, including legacy records, not a promise that every update preserves old versions.

Rollback requires a retained version key, an existing source directory and revalidated matching source/content/trust. Missing records or deleted directories return `managed_version_not_found` or `managed_version_missing`; download an available release again if a different version is desired. The legacy record validator's 64-entry bound is not a policy to maintain 64 installed versions. The production GUI no longer offers retained history/rollback browsing. Keep this explicit historical selection separate from `rolled_back` recovery of a failed current transaction.

## Settings and updates

`getSettings/saveSettings` use their own revision CAS, not a plugin mutation receipt. Save the complete preferences: `automaticUpdateChecks`, `checkPluginUpdatesOnStartup`, `showPluginTags`, `updateCheckIntervalSeconds` (null or integer 300–86400) and `localSourceAutoReload` (null or boolean). Null inherits the configured default. A lost save reply is reconciled with `getSettings`, not another write. Settings live in a bounded atomic sidecar, do not change plugin trust and reject writes at incompatible lifecycle states.

`versionStatus` combines current runtime/client facts, update discovery and batch state without inferring an available release from publication evidence. `checkPluginUpdates` is read-only discovery of registered GitHub sources and coalesces while running/for 60 seconds afterward. `updatePlugins` is an explicit batch action; it preserves grants and enabled preferences, and yields `reviewRequired` when authority changes. `pluginUpdateReview` binds review to that batch/candidate. Local projects and offline installer imports do not become GitHub update sources because they have official names.

Core check/download/install methods are separate actions. Combined official-client/Core updates use one explicit `installCombinedUpdate({candidateId})` operation; reconcile a lost reply through status instead of replaying. An unconfigured development channel is not “up to date.” Installer-managed Core files and portable self-update follow their respective ownership rules; an OS package upgrade is not permission to overwrite unrelated installations.

The optional GUI and Codex native adapter semantics are documented in the [official plugin specifications](https://github.com/baoabaob/codlet-plugins/blob/main/docs/README.md). Core's management service and runtime skill remain available without that GUI.
