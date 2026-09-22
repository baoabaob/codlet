# Core services API 1

Host and Renderer use `context.services`, backed by `{name:'codlet.core.services', api:1, scope:'runtime'}`. Declare this requirement on the calling entry and explicitly grant each needed [permission](permissions.md). Combined packages use `host.requires` for Host calls. Renderer-only packages do not need an empty Host merely to store settings, use approved files, launch an approved child or access desktop services.

The method/DTO maps are [core-services.d.ts](../../types/core-services.d.ts), [plugin-storage.d.ts](../../types/plugin-storage.d.ts) and [core-resources.d.ts](../../types/core-resources.d.ts). Public groups are `storage`, `credentials`, `files`, `events`, `tasks`, `processes`, `network`, `desktop`, `resources` and `diagnostics`. Handles authenticate the plugin/source/generation; business parameters cannot select another owner. Slow OS work uses bounded Core workers rather than blocking the coordinator.

## Storage and credentials

`storage.snapshot/get/transaction/changes/directories/clearCache` provide owner config/KV and data/cache directories. Config and KV changes commit atomically under a cross-process lock and optimistic revision check:

```js
const before = await context.services.storage.snapshot();
await context.services.storage.transaction({
  expectedRevision: before.revision,
  config: { ...before.config, selectedProvider: 'work' },
  operations: [{ op: 'set', key: 'lastUsed', value: Date.now() }]
});
```

A stale revision returns `storage_conflict`; read again before deciding a new write. `changes({afterCursor,limit?})` has bounded replay and returns `resetRequired` plus a snapshot when the requested history has expired. Missing keys are distinguished from stored null by `found`. Source ownership prevents an unrelated registration reusing the same plugin ID from inheriting its namespace. Storage survives normal reload/update; generation-owned task/event handles do not.

Current storage bounds are 768 KiB serialized state, 128 KiB per value, 1,024 keys, 128 operations per transaction, 256 retained change records and pages of at most 100. Data/cache quotas are 64/256 MiB. Quotas constrain Core writes, not arbitrary trusted Host writes through a returned path.

`credentials.list/metadata/put/remove` expose opaque references, origin/label and revisions. Secret values use Windows Credential Manager or macOS Keychain. There is no plaintext-getter convenience API. Creating/rotating/removing records uses `expectedRevision`; records are limited to 256 per namespace, secrets to 2,048 bytes and labels to 128 bytes. OS secret storage and metadata cannot form one OS transaction: failed commits attempt recovery and report uncertainty if recovery fails.

`core.credentials.use` permits explicit reference use at an authorized dispatch. `network.fetch` and traffic `exchange.forward` resolve an origin-bound credential inside Core as a Bearer token. A proxy credential is `username:password` for that proxy and is not forwarded as the origin Authorization header. Metadata/logs do not contain secret values. This is not an OS sandbox against already-authorized native Host code.

## Files and native selection

`files.openDialog/saveDialog` return a dialog ID immediately. Poll `dialogStatus`; cancel with `cancelDialog` and release selected references with `release`. A selected reference constrains read or write access to the actual selection without a permanent directory grant. `files.read/stat/readDir/writeAtomic` accept either a path or a reference, never both. See the precise selected-reference permission exception in [permissions](permissions.md).

`read` returns bounded base64 chunks. `stat` returns the current version; `writeAtomic({expectedVersion,data,...})` accepts at most 256 KiB. `expectedVersion: null` means create without overwrite. Replacement is staged in a pinned parent; Windows preserves the existing file ACL and macOS uses directory-relative operations. Core checks its version under its lock, but external editors do not participate in that lock. `mkdir` and `remove` use write authority; removal is nonrecursive.

Watches are nonrecursive change hints, not an exact durable filesystem event stream. They inspect at most 1,024 direct entries, retain 128 changes, poll every second and back off to five seconds while idle. At most four watches per owner and 16 per runtime are admitted. `changes` reports `gap`/`rescan`; reread current state rather than infer absent changes. Unwatch or retirement releases ownership.

## Events

`events.createTopic/publish/subscribe/read/ack/close` implement bounded replayable logs. Owner topics work across that plugin's Host and Renderer windows. Cross-plugin export requires a Runtime capability declared by the provider and supplied to `createTopic`; the consumer must declare that exact requirement and supply it to `subscribe`. Another capability from the same provider is not sufficient.

An omitted subscription `after` starts after the newest event; use the creation cursor to replay. Repeated reads may repeat events; acknowledgments advance the consumer position. A gap means history was evicted. Provider retirement terminates old subscriptions (`provider_retired`), rather than attaching them to a replacement generation. A closed topic reports `topic_closed`.

Topics default to 256 events and at most 1 MiB, configurable up to 1,024 events. One event is at most 32 KiB. There are at most 16 topics per owner/128 globally, and read pages contain at most 64 events within their response budget. The log is not durable delivery across a Core restart.

## Callback tasks

```js
const runner = await context.services.tasks.register('index-files', async (input, task) => {
  await task.progress({ completed: 0 });
  if (task.signal.aborted) throw task.signal.reason;
  return { indexed: input.paths.length };
});
const started = await runner.start({ input: { paths: [] }, operationKey: 'index-1', timeoutMs: 60000 });
const status = await context.services.tasks.get({ task: started.task });
```

The SDK claims callbacks outside the short registering RPC's lineage and tracks task cancellation/deadline separately. A Host runner can survive closure of its observing panel. Renderer runners belong to their document and are interrupted when it ends. Runners/tasks are owner-local; they are not a cross-plugin job scheduler or durable workflow engine.

`operationKey` with identical parameters returns the original task; different work cannot reuse that key. `cancel` requests cooperation. Throw the invocation's signal reason or an AbortError to acknowledge cancellation; ignoring cancellation and returning normally remains success. Running tasks are not automatically replayed after restart. Inspect `terminal` and `outcomeKnown`; an interrupted task is not proof that external effects were undone.

Task input is at most 64 KiB, progress/error 16 KiB, result 128 KiB of JSON (`undefined` becomes null). Invalid results fail the task. Current bounds are 16 runners/64 retained tasks per owner and 128 runners/256 tasks globally. Low-level `claim/progress/finish` use unguessable claim tokens; only the claimant can finish and cancellation acknowledgment requires a preceding request.

## Streaming processes

`processes.start` uses a granted executable and argument array without a shell string. `cwd` and caller-provided environment keys require their additional scopes. `read/write/endInput/status/wait/terminate/close` control bounded binary pipes and a real Windows Job or macOS process group. This is a lifecycle boundary, not containment for arbitrary child code.

Stdin has one sequenced writer: start at `"0"`, use the returned next sequence, and only retry the last receipt. A repeated sequence does not duplicate bytes. An unconfirmed write closes stdin and terminates the managed process scope. Output buffers are bounded to 256 KiB per stream and read chunks to 32 KiB. Check exit/EOF, worker completion, `processesReaped` and `outputDiscarded`; a termination request alone does not prove native resource retirement.

## Network and desktop

`network.profiles/createProfile/resolve/closeProfile/status/fetch` support direct, native system/PAC and explicit HTTP(S) proxy routes, with optional additional PEM trust. They do not change system settings. Destination and proxy each require the exact network-origin grant. Resolution failure is an error, not silent direct fallback; TLS verification remains enabled. New dispatches use the selected profile revision; existing connections keep their route. Fetch uses base64 bytes and bounded responses. Profile references also work with [HTTP/SSE and WS/WSS traffic channels](traffic.md); retries, provider selection and recovery are plugin policy.

`desktop.notify` reports `submitted` with `visible: null`, not proof of display. Only whole-notification clicks are supported (`actions` is empty). Clipboard is explicit text read/write with separate permissions, not background polling. Global shortcuts register only granted combinations and return conflicts; no all-key hook is installed. Native platform code still requires real-device UI/Keychain/shortcut acceptance.

`resources.list` returns only the caller's jobs, files, desktop/network resources and managed Host traffic observations. `diagnostics.read` records bounded method/error facts without parameters, credentials, clipboard/notification contents or response bodies. A retired call may already have committed an external effect: `outcome_unknown` is a reason to inspect state, not automatically repeat the operation.
