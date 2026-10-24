# Core Codex SDK API 1

Core embeds the complete UI, Desktop and Native launch implementations in
[codex/](../../codex/README.md). GUI, split workbench and test plugins remain
independently reloadable consumers. No UI or Desktop adapter installation is
required. `codex.ui.adapter` and `codex.desktop.adapter` remain capability routing
aliases owned by Core. Legacy user registrations, grants and storage remain in
the registry, but cannot compete with the internal providers.

[types/codex.d.ts](../../types/codex.d.ts) is the renderer contract.
[types/codex-traffic.d.ts](../../types/codex-traffic.d.ts) is the Host contract.
The [Workspace guide](workspace.md) and [workspace declarations](../../types/codex-workspace.d.ts) describe local Native handles in detail.
Existing `context.ui`, `context.services`, API 1 capability descriptors, RPC
methods and one-use local API tickets remain supported.

## Renderer namespace

Each operation uses the consumer's declared capability and generation. A facade
does not bypass admission or borrow the implementation's raw permissions.

| Namespace | Methods | Required API 1 Target capability |
| --- | --- | --- |
| `navigation` | `page(options)`, `newTaskDraft({prompt}, options?)` | `codex.ui.navigation.page` |
| `composer` | `registerAction({label,token?}, callback)` | `codex.ui.composer.action` |
| `workspace` | `connect(options?)` | `codex.ui.workspace` |
| `compatibility` | `probe({}, options?)`, `waitReady({timeoutMs?}, options?)` | `codex.desktop.compatibility` |
| `backend` | `read(method, params, options?)`, `write(method, params, options?)` | `codex.backend.read` / `codex.backend.write` |
| `selection` | `get` | `codex.backend.read` |
| `threads` | `list`, `loaded`, `get`, `configuration`, `open`, `reconfigure` | Read for metadata; write for navigation/configuration |
| `turns` | `list`, `start`, `steer`, `interrupt` | Read for history; write for turn operations |
| `items`, `models`, `skills`, `providers` | `list` | `codex.backend.read` |
| `approvals` | `list`, `respond` | Read / write respectively |
| `permissions` | `get`, `register`, `update` | Read for settings; write for registration/update |
| `events` | `read(params?, options?)`, `onEvent(callback, options?)` | `codex.backend.events` |
| `submissions` | `register(options, callback, rpcOptions?)`, `list({}, rpcOptions?)` | `codex.ui.preSubmit` |
| `configuration` | `register(options, callback, rpcOptions?)`, `list({}, rpcOptions?)` | `codex.backend.write` |

The named data groups preserve the existing RPC method DTOs and cancellation
options. They are available from isolated and main worlds. Native writes have
the existing ownership, idle-state and confirmation requirements. A submitted
receipt is not proof that a turn or permission request has completed.

Local callback and workspace registrations acquire a fresh Core-authenticated
ticket before claiming the Native API. They require the managed main world to
retain native functions, React context and DOM handles. Consumers that need this
world still declare its exceptional permission; the SDK does not claim a sandbox
around main-world JavaScript. Registration handles and listeners retire with the
consumer generation. Workspace sessions retain the full Native transcript,
composer, navigation, location, viewport, surface, shortcut and action APIs.
Transcripts have no total per-session or per-target cap and are not evicted when
offscreen.

During a compatible update checkpoint, ordinary SDK RPC and new local handle
writes refuse with `core_updating`. Core drains accepted RPC plus local handle
`ready`, navigation `executed`/`committed`, and asynchronous method promises before
calling `saveState`. Pure snapshot/surface/reference reads and `exportState` stay
available; disposal and awaited `close` remain available for restoration. A
checkpoint deadline failure resumes the existing generation rather than replaying
an uncertain write. Main-world plugins can still execute arbitrary JavaScript;
this SDK admission contract is not a sandbox for direct Native DOM access.
Whole-Core updates also hold a separate operation lease across all live realms
and future candidate or rollback generations. Resuming a plugin checkpoint cannot
release that lease. The finite activate/restore lifecycle and cleanup lanes remain
available; ordinary APIs stay held after readiness until the coordinator confirms
the whole-Core takeover. The retained realm registry contains only ABI and
operation identity, and keeps no old provider or dispatcher closures.

`workspace.resolveThreadInteraction(element)` recognizes a Native sidebar task
gesture while excluding embedded controls and Codlet-owned surfaces.
`workspace.hasBlockingOverlay(target?)` recognizes a target inside a modal or a
visible dialog/menu/listbox. Consumers use these semantics instead of private
Native selectors. The returned Native DOM handles remain local objects.

`composer.registerAction` owns its DOM lease, click callback and disposal. Its
callback receives the existing click fields plus a local `anchor` for the owned
composer action instance. The handle exposes `registration`, `status()`,
`unregister()` and synchronous `dispose()`.

## Availability and evidence

Version profiles are a discovery fast path. Unknown client versions probe the
loaded Native interfaces rather than disabling every consumer. Workspace features
are discovered independently on use. Desktop compatibility reports navigation,
configuration, loaded-task enumeration, nullable Working mapping and individual
approval response support independently. An unavailable approval response does
not disable ordinary reads or other reply kinds.

`implemented: true` describes Core's coverage. `available: true | false | null`
describes the current interface probe; null means unresolved. Neither is the
consumer author's support declaration or verified client/platform evidence.
Historical profiles and imported acceptance probes retain their provenance.
Unit tests and Windows Native evidence do not establish macOS acceptance.

Loaded-task activity is `working: boolean | null`. Waiting while execution is
idle is not working; publication and concurrent owned work use the reviewed
Native mapping. Unknown mappings retain unknown state and must not be converted
to false or used to remove existing task members. Loaded summaries paginate
without a total count cap. Summaries and thread reads expose `isSubagent` and
`parentThreadId`; workspace consumers exclude child agent tasks from independent
input selection. No operation opens another App Server connection.

## Host namespace

`context.codex.traffic.create(compatibility?)` returns the complete former Codex
traffic helper, bound to the consumer's `context.traffic` broker and signal.
`traffic.probe(compatibility?)`, `classify`, `readJsonBody` and `rewriteJsonBody`
also remain available. The bounded JSON decoder retains gzip, Brotli, deflate and
zstd support; helper code is embedded into Core. Broker grants continue to govern
interception, sensitive headers, redirection and network credentials.

Native launch attachment remains a private Core lifecycle operation. See
[client-source.md](client-source.md) for its embedded source, installed update pin,
resource ownership and platform validation boundary.
Captured workspace locations may transfer across a compatible renderer reload:
`await handle.exportState()` returns only `{api:1,token}`, and the later generation
calls `workspace.captureLocation({restoreState})`. Core retains the original
Native router reference and draft identity in the same document; it never reads
or serializes draft text. Transfers are limited to 64 resources, require the
same plugin and a later generation, reject concurrent adoption and host drift,
and expire after ten dormant minutes. Teardown during a candidate handoff keeps
the token for rollback. A final user exit uses
`handle.dispose({releaseTransfer:true})` to release it immediately. These tokens
do not survive a Native process restart. Independent viewport teardown restores
captured Native settings before a new generation acquires its own lease.
