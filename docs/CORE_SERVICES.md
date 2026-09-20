# Core services API 1

Host and renderer plugins use `context.services`. A renderer-only plugin needs no
Host process to store settings, access approved files, run an approved child
program, or use the desktop services. The underlying built-in capability is
`{ "name": "codlet.core.services", "api": 1, "scope": "runtime" }`; declare it in
the calling entry's `requires`. A combined package declares Host requirements
separately inside `host.requires`.

The checked-in contracts are [core-services.d.ts](../types/core-services.d.ts),
[plugin-storage.d.ts](../types/plugin-storage.d.ts), and
[core-resources.d.ts](../types/core-resources.d.ts). They describe the implemented
method shapes and limits. The architecture proposal is a design reference, not
a claim that every optional extension in it is available.

## Permissions and scopes

| Service | Required permission | Additional scope |
| --- | --- | --- |
| Configuration, KV, data/cache directories | `core.storage` | Own plugin/source namespace |
| Credential metadata, put, rotate, remove | `core.credentials` | Own OS credential records |
| Use a credential reference | `core.credentials.use` | Record's exact HTTP(S) origin |
| Files read/stat/readDir | `host.fs` | `readRoots` |
| Files atomic write/mkdir/remove | `host.fs.write` | `writeRoots` |
| File watches | `host.fs.watch` | `watchRoots` or an explicitly selected reference |
| Native open/save dialog | `core.files.dialog` | Temporary reference to the selection |
| Events | `core.events` | Own topics; exported topics additionally use exact capability declarations |
| Background tasks | `core.tasks` | Own runners and tasks |
| Streaming child processes | `host.process.spawn` | `executables`, optional `cwdRoots`, `envKeys` |
| Network profiles / proxy resolution | `core.network` | Destination and selected proxy also need `host.network` + `networkOrigins` |
| Bounded HTTP fetch | `host.network` | Exact destination and proxy origins |
| Notifications | `core.notifications` | Own notifications |
| Clipboard text | `core.clipboard.read` / `core.clipboard.write` | Separate read/write grants |
| Global shortcuts | `core.shortcuts` | Each combination in `shortcuts` |
| Own resources and diagnostic records | `core.diagnostics` | Never another plugin's data |

GUI import supports all these scope fields. The CLI additionally accepts
`--write-root`, `--watch-root`, `--cwd-root`, `--env-key`, and `--shortcut` alongside
the existing `--grant`, `--read-root`, `--network-origin`, and `--executable`.
Empty scope lists do not grant ambient access. Revoking a grant clears its
corresponding scopes and retires the old plugin generation.

## Storage and credentials

```js
const snapshot = await context.services.storage.snapshot();
await context.services.storage.transaction({
  expectedRevision: snapshot.revision,
  config: { ...snapshot.config, selectedProvider: 'work' },
  operations: [{ op: 'set', key: 'lastUsed', value: Date.now() }],
});
```

Configuration and KV commit together under a cross-process lock and atomic file
replacement. A concurrent writer receives `storage_conflict`, then reads a fresh
snapshot before making a new decision. `storage.changes({afterCursor})` provides
bounded replay and returns a fresh snapshot when history has expired. Poll only
while a consumer needs updates. Plugin ID directories remain readable; ownership
metadata prevents a different source reusing that ID from inheriting data.

Credential values go to Windows Credential Manager or macOS Keychain. Metadata
contains only opaque references, origin bindings, labels and revisions. The SDK
does not expose a plaintext getter. `network.fetch({credentialRef,...})` and
traffic `exchange.forward({credentialRef,...})` use the credential as an explicit
Bearer token for its bound origin. A proxy credential uses `username:password`
and never becomes the origin Authorization header. Host implementations remain
trusted native code, not an OS sandbox.

OS credentials and metadata cannot commit as one OS transaction. A failed commit
is rolled back where possible and reports uncertainty if recovery is incomplete.
No secret value is put in the Core operation log.

## Files

`openDialog` and `saveDialog` immediately return a dialog ID; poll `dialogStatus`
for a selected reference or cancellation. A selection permits reading that file,
or writing the exact save target, without a permanent directory grant. Directory
scope grants remain separate. `read` returns base64 chunks; `writeAtomic` accepts
at most 256 KiB with `expectedVersion` (null means create without overwrite).
`stat` returns a version for optimistic replacement. External editors do not
participate in Core's lock, so this is not a transaction across arbitrary writers.

Replacement is prepared in the pinned parent directory. Windows preserves the
existing file's ACL; macOS uses directory-relative native operations. Symlink,
reparse-point and hard-link restrictions remain in the existing path broker.
`remove` is deliberately nonrecursive.

Watches are bounded, nonrecursive change hints. They inspect at most 1,024 direct
directory entries, use a one-second polling interval that backs off to five
seconds while idle, and retain 128 changes. After a gap, read the current state.
There are at most four watches per plugin and sixteen per runtime.

## Events and tasks

Own topics work across a plugin's Host and renderer windows. To export a topic,
its provider declares a Runtime capability in `provides` and includes that exact
descriptor in `events.createTopic`. The consumer must declare it in `requires`
and include it in `events.subscribe`. A dependency on another capability from the
same provider does not authorize the topic. Cursors are ordered, replayable and
bounded; missing history reports a gap. Provider retirement terminates old
subscriptions instead of silently attaching them to a new generation.

```js
const runner = await context.services.tasks.register('index-files', async (input, task) => {
  await task.progress({ completed: 0 });
  // Pass task.signal to cancellable operations and stop cooperatively.
  if (task.signal.aborted) throw task.signal.reason;
  return { indexed: input.paths.length };
});
const started = await runner.start({
  input: { paths: [] }, operationKey: 'index-request-1', timeoutMs: 60_000,
});
const status = await context.services.tasks.get({ task: started.task });
```

Control calls remain short; the actual callback is detached from the RPC that
registered it. A Host runner survives closing its observing panel. Renderer
callbacks belong to their document and are interrupted when that document ends.
`cancel` requests cooperative cancellation; it does not undo an already completed
effect. Ignore-and-complete callbacks must report success rather than fabricate
cancellation. Running tasks are not automatically replayed after Core restart;
task handles and results are generation-local. Durable business state belongs
in storage.

## Processes, networking and desktop integration

`processes.start` launches an explicitly granted executable without a shell.
`read`, `write`, `endInput`, `status`, `wait`, `terminate`, and `close` control a
real process with bounded binary pipes. Repeated stdin writes carry a sequence
number so uncertain replies cannot duplicate input. Windows uses owned Job
Objects; macOS uses the existing process-group owner. Groups are lifecycle
boundaries, not an arbitrary-code security sandbox.

Network profiles select direct, native system/PAC, or explicit HTTP(S) proxies,
with optional additional PEM certificates. They do not change system settings.
The profile reference can be supplied as `networkProfile` to HTTP/SSE and WS/WSS
traffic forwarding. Certificate verification stays enabled. Proxy resolution
failure is an error, not silent direct fallback. Profiles affect new dispatches;
existing connections retain their selected route. See [traffic channels](TRAFFIC_CHANNELS.md).

Notifications report submission, not proof the user saw them. Clipboard access
is explicit text read/write, never background polling. Global shortcuts register
only approved combinations and report conflicts; no all-key keyboard hook is
installed. `resources.list` includes plugin-owned jobs, watches, selections,
desktop resources, network profiles and managed Host traffic observations.
`diagnostics.read` stores bounded method/error records without parameters,
clipboard content, notification text, credentials or response bodies.

If a call retires after committing an external effect, inspect the resulting
state before retrying. `outcome_unknown` never means the effect was rolled back.
Windows and macOS have native code paths; actual macOS UI, Keychain prompts,
shortcut delivery and client integration require acceptance on a Mac.
