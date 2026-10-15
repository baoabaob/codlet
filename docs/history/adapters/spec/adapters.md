# Codex adapter contract

This retained Adapter contract describes the capability API imported into Core v1. The implementations now live under Core's `codex/` and are no longer separately installed plugins. Ordinary consumers use `context.codex` without inheriting provider implementation permissions; existing capability descriptors remain compatible. See the [Core Codex contract](https://github.com/baoabaob/codlet/blob/main/docs/spec/codex.md). Profiles, source paths and Native observations in the historical sections below retain their original provenance.

## Compatibility and ownership

`compatibility/client-profiles.json` supplies a fast path for known module URLs and native exports. Its version numbers are observations, not an allowlist. Unlisted builds use bounded structural discovery of the mounted local connection, loaded native modules, component identities and routing contracts. A backend version change alone is not a startup rejection. Missing or ambiguous contracts stop the affected integration. `bundled/codex-ui-adapter/client-versions.json` separately records versions accepted in real UI tests; source review or simulated tests alone do not add an acceptance record. Keep working older profiles.

The discovery path reads only local modules already referenced by the native document. An AST parser resolves React CommonJS factories through their export relationships; no source text is evaluated, and arbitrary exports are never called to guess their purpose. Native rail components must also occur in the mounted Home ancestry. The page header and draft hook are checked separately. Composer DOM actions can continue even when page navigation is unavailable.

Page routing inspects the unique native rail's ancestry (or the legacy sidebar),
bounded to 256 fibers and tied to the current React root. It does not walk the
conversation on each page click: long conversations can exceed the former
20,000-fiber limit and otherwise block an already registered page. React's
alternate is accepted only when its ancestry reaches the current root. Duplicate
landmarks and detached or cyclic ancestry remain unavailable. Cold startup and
the auxiliary pet window retain bounded discovery without a sidebar landmark.

Build 12246 preconverts its JSX routes into route objects. The adapter finds the existing root in mounted RouteContext matches and appends/removes only its own route in the authenticated child collection. Legacy JSX collections still use their original path. Both paths preserve the native router, history and providers.

Windows package `26.928.1915.0` (frontend `26.928.20755` / `12246`, AppServer
`0.159.0`) passed isolated acceptance without a version-table entry: GUI,
Desktop readiness and task reads, composer registration/click, native page
toolbar, unsubmitted draft creation, lease cleanup, and normal shutdown. The
Core runtime skill was ready. The reusable consumer is in
`tests/fixtures/runtime-compatibility`; this used synthetic onboarding and a
loopback API fixture, not the user's credentials or a new MSIX installation.

Adapters use the existing local Desktop connection, React scope and native navigation. They must not create another `connect-app-host` connection that replaces the Desktop view. Missing modules, changed object identity or a replaced patch make affected capabilities unavailable and produce diagnostics. Teardown restores only hooks still owned by that instance; conflicting patches can produce `reloadRequired`.

Windows package `26.930.2377.0` (frontend `26.930.21537` / `12776`, AppServer
`0.159.0-alpha.12.1`) passed the expanded 0.0.2 consumer with Desktop Adapter
0.2.7 and UI Adapter 0.1.10. The original UI checks were retained; 24 checks
passed in each HTTP/SSE and WebSocket fixture, covering Core services, native
task open/configuration, submit rewrite/context injection, events/history,
model request/response transforms and steer/interrupt. External scoped CLI
reload/disable/enable retired the old generations. These were owned profiles
and synthetic loopback model endpoints, with zero plugin errors and normal exit.

Desktop Adapter 0.2.8 separates the bounded metadata scan from the 512 local
service-read budget. Thousands of already cached task families in an auxiliary
window no longer reject the existing local connection families. Unbound families
remain unread; excessive local candidates and ambiguous owners still fail closed.
The live update reached ready state in both the primary and auxiliary daily
windows, with the original Core/client PIDs and permissions retained.

Windows package `26.924.2738.0` reports frontend `26.924.22138`, build `11645`,
and AppServer `0.158.0-alpha.2.1`. Its scope, connection families, services and
postbox moved into the shared module; the native sidebar, Header and new-task
hook are in the initial module. A profile can name `page.initial` independently
of the connection module. The new data router owns a single wildcard root and
the existing authenticated JSX route collection. `native-navigation.js` adapts
its location, navigation and subscriptions without creating a second router or
changing its private route graph. Its global navigation uses the narrow native
rail rather than the contextual task/project sidebar. Native task drafts include
the reviewed Codex app mode. Older memory-history and sidebar profiles remain.

Build 11645's rail is the `data-app-navigation-rail` landmark. Placement verifies
the native `SidebarGroup` identity and its `itemSpacing="rail"` ancestor of Home;
page entries sit after the fixed Customize destination, before Explore and
outside the sortable pins. A `display:contents` owner lets the original group
control spacing and scrolling. Entries use the reviewed shared Button (`HQt`)
and Tooltip (`sS`) exports with the same `xl` square button, `lg` icon, ghost
secondary variant, selected state, right-side tooltip and keyboard behavior as
the built-in destinations. Labels remain accessible without consuming rail
width. No official component props or destination preferences are overwritten.
The Codlet puzzle icon uses a filled silhouette for the selected destination and
returns to its outline when another destination becomes active.
Ambiguous/missing rail landmarks do not redirect registration to the task list.

The native HeaderToolbar's default inset is explicitly reset to zero inside the
new page surface. This profile uses the native `inset="page"` mode instead:
content width and panel padding come from the host theme. Other reviewed builds
keep their original inset. Route departure retires the toolbar and selection;
rail replacement reconciles the same owned entry, without duplicating it.
The page content outlet is a bounded scroll container. Pages that render natural
document-height content can scroll under the new clipped AppShell; pages with
their own full-height scroll area, including the GUI, retain that inner scroller.

Isolated build 11645 acceptance measured identical native/plugin rail buttons
(36 × 36 CSS pixels, 20-pixel icons), native tooltip/focus behavior, selected
state, back/forward, settings and the Add menu. At 1280 pixels, the page toolbar
and GUI content share their left/right alignment with 12-pixel native toolbar
insets. An 840-pixel window retained the controls without horizontal overflow;
the capability test page scrolled a 3403-pixel document inside a 726-pixel outlet.
Changing the live accent token between blue, purple and orange updated tag
icons in place. These are client UI/fixture checks, not installer acceptance.

The isolated Windows UI acceptance covered Codlet registration, full GUI and
settings, native back/forward, editable draft creation, and composer action
registration/click. The API fixture read compatibility, selection, tasks, models,
providers and events through ordinary plugin RPC. After seeding one persisted
fixture turn, it opened that task through `threads.open`, confirmed resumed owner
state, submitted a second turn through `turns.start`, and read its completed
status and assistant text through `turns.list` and `items.list`. A fresh empty
task has no persisted rollout to cold-resume; the fixture must seed it first.
This is separate from MSIX,
signed-in account and transparent traffic acceptance; see [known issues](https://github.com/baoabaob/codlet-plugins/blob/main/docs/known-issues.md).

These plugins run in the main world and explicitly require `ui.mainWorld`; UI navigation also requires `ui.dom`. Main-world code is high trust. Core-authenticated tickets prevent accidental cross-owner API use but do not turn shared page JavaScript into an OS sandbox. Raw `ui.mainWorld`, `cdp.raw` and `host.process` capability ceilings remain Core policy, independent of these semantic adapters.

## UI adapter

Cold startup observes the existing native router before importing or initializing
the main AppShell. It never bootstraps the client on its behalf. The avatar window
declines page/composer leases without loading any main-window UI modules. This
matters for build 10789: calling the lazy Header initializer before its owning
shell initializes can reenter native module initialization and throw in an
uninitialized registration Set, leaving the official page loading indefinitely.
The fix was checked against the real Windows 26.917.8451.0 client in a fresh,
private profile; a fake local API key avoids accessing the user's account.
The original adapter reproduced `z4r → g3r.add` through `reviewedHeader → pq`;
the guarded adapter let both the main onboarding page and avatar render. This is
cold-start evidence, not full authenticated GUI or macOS acceptance.

`codex.ui.adapter` provides target capability `codex.ui.navigation.page@1` through `frontend/src/adapter/navigation.js`:

- `register({label, icon, token, toolbar?})` requires a Core-authenticated caller and a matching live DOM page lease owned by its plugin ID and generation. The route is `/codlet/<pluginId>/*`; auxiliary windows return an unavailable page with `path: null`.
- Native routing owns page activation, back/forward navigation and teardown. The adapter supplies the reviewed sidebar entry, native content outlet and optional native Header toolbar outlet. Lease removal retires its route and navigation entry.
- `newTaskDraft({prompt})` is restricted to the caller's active live page. It opens an editable local task composer and returns `{opened: true, submitted: false}`; it never submits the prompt.

The Core UI SDK registers these leases and renders the plugin's complete React tree. Native React objects and DOM elements remain in their existing execution worlds. There is no Worker rendering ABI or fixed-component/JSON UI restriction.

`codex.ui.composer.action@1` is a separate Target capability for ordinary plugins in either Renderer world. It checks the composer root and native utility bar structure independently of the version table and page router. A consumer creates an empty DOM lease with `data-codlet-composer-action-lease=<token>`, `data-codlet-composer-action-owner=<context.pluginId>` and `data-codlet-generation=<context.generation>`, then calls `register({token,label})`. The Adapter verifies the live lease against Core's authenticated RPC caller. It renders a button in each matching composer utility bar and dispatches `codlet:composer-action` on the lease when one is clicked. `CustomEvent.detail` is a JSON string `{api:1,token,placement,instance}` so main and isolated consumers have the same event contract. `instance` names the current `[data-codlet-composer-action-instance-id]` button container for a consumer-owned popover; it expires when that composer unmounts. The event contains no task ID or user text; the consumer must use a separately declared Desktop read capability and check current selection before acting. The event never submits a turn.

`status({token})` reports whether the caller's action remains registered and how many composer instances are currently mounted. `unregister({token})`, lease removal, provider retirement, composer replacement or window closure removes only that owner's button. Registration can be pending during cold startup; auxiliary windows decline the outlet. An accepted registration can have zero mounted buttons when no matching composer is present. Up to 32 actions per Target and eight per owner are accepted. Buttons remain tied to the caller generation through the live lease; a consumer removes its lease in `context.onDeactivate`. The Adapter never reads or edits another plugin's lease. The original Windows build 10789 outlet review established `data-codex-composer-root` around `data-composer-utility-bar-scroll-area` with a single controls container. Unlisted builds can use the same verified structure; absent or ambiguous landmarks never receive a button.

The navigation observer ignores ordinary streaming-content mutations. Native navigation or lease changes still trigger reconciliation; removing this filtering requires a performance regression check.

UI Adapter 0.1.11 adds the owner-scoped `codex.ui.workspace@1` session described in [workspace-api.md](../workspace-api.md). This contains semantic surface/slot discovery, composable temporary surface leases, native transcripts and shortcut settings integration. Native providers and managers stay private. Layout and persistence remain consumer policy. Features initialize lazily from the current client resource graph and share one discovery cache and existing local connection; no fixed resource hashes or background connections are added.

## Desktop adapter

`codex.desktop.adapter` provides target-scoped API 1 capabilities from `frontend/src/desktop/entry.js`:

| Capability | Operations |
| --- | --- |
| `codex.desktop.compatibility` | `probe`, `waitReady`; report readiness, reviewed build and capability availability |
| `codex.backend.read` | `selection.get`, `threads.list/loaded/get/configuration`, `turns.list`, `items.list`, `models.list`, `skills.list`, `providers.list`, `approvals.list` |
| `codex.backend.write` | `threads.open`, `threads.reconfigure`, `turns.start/steer/interrupt`, `approvals.respond`, `getApi`, `configurations.list`; task-local model/provider configuration callback |
| `codex.backend.events` | Cursor-based `read`, `getApi` for an owned callback |
| `codex.ui.preSubmit` | `getApi`, `interceptors.list`; input rewrite/context injection before native `turn/start` |

Read results are bounded DTOs. Provider results omit credentials, URLs, environment mappings and raw config. Writes to a task require its resumed state and owner stream in this Desktop window. Opening a task validates its identity and lets the native route own resume. Cancellation after a dispatched write may yield `outcome_unknown`; callers inspect state/events rather than blindly repeat the write.

Desktop Adapter 0.2.16 adds `threads.loaded({limit?,cursor?,threadId?})`: at most 100 summaries per page, one bounded cached collection of at most 4096 local threads, no history or backend requests. Specific-thread queries do not enumerate the collection. Summary changes produce `thread.summary.changed` only for the affected thread; unchanged tokens produce no summary event. Cursors retain at most 32 snapshots for 15 seconds and are single-use. The detailed DTO is in [workspace-api.md](../workspace-api.md).

Native JSON-RPC integer error codes become `desktop_request_failed` with the
bounded original rejection message. Ordinary backend refusals must not produce
malformed Core error DTOs or retire otherwise working adapter capabilities.

Approval responses use instance-owned tokens, revalidate the live request and reject unsupported schemas. Event cursors belong to one adapter instance, report gaps after eviction, and are invalid after retirement. The bounded event history is not a durable audit log.

Callback APIs require a declared capability acquired through Core RPC `getApi`, a one-use ticket tied to plugin ID/generation/capability, and a live main-world RendererContext. Tickets expire after 15 seconds. The returned `symbol` identifies the main-world API; plain RPC clients should use serializable operations instead of trying to serialize callbacks.

Pre-submit hooks have deterministic priority/owner/order, bounded concurrency and deadlines. Their failures stop that submission rather than silently bypassing requested transformations. They do not rewrite presentation or mutate stored history.

## Task configuration and explicit channels

`frontend/src/desktop/thread-configuration.js` applies one plugin-selected model or provider change to a local native `thread/start` or `thread/resume` request. A callback sees the task ID, working directory, model and provider. It can select an existing provider ID, or define one task-local Responses provider whose `baseUrl` is a private loopback HTTP endpoint, such as `context.traffic.openChannel` with an API path. A new provider has no ambient official OAuth. The Adapter does not edit global configuration, rebind an active turn or change the provider of an already-loaded task.

`registerThreadConfiguration({ appliesAt: ['turn.start'] }, handler)` lets a plugin choose the model for each task turn using the exact `draft.threadId`. It defaults to the thread start/resume phases when `appliesAt` is omitted. At `turn.start`, only `{ model }` is accepted; a provider change is rejected. The Adapter updates both the native `model` parameter and an existing `collaborationMode.settings.model`, preserving the rest of the mode. This matters because the Desktop composer can send `model: null` with an older model in collaboration settings. Task configuration runs before the existing text/context pre-submit hooks; with no matching configuration hook, the native request is unchanged.

An explicit `threads.reconfigure` operation can cold-resume the selected idle owner task on reviewed builds. It requires an already installed resume hook and checks the actual Native response against the requested model/provider; see [the traffic contract](traffic.md). Read `threads.configuration` before a change to retain a non-secret restoration point; either returned field may be null, in which case a plugin must not guess an original value. Provider routes are owned by their plugin generation and are not automatically restored after forced retirement.

Desktop Adapter 0.2.14 adds opt-in restoration for a configuration registration:

```js
const handle = api.registerThreadConfiguration(context, ticket, {
  id: 'private-provider', appliesAt: ['thread.resume'], restoreOnDeactivate: true
}, () => ({ provider: { id: 'codlet_example', baseUrl: channelEndpoint }, model: 'chosen-model' }));
await handle.reconfigure({ threadId, modelProvider: 'codlet_example', model: 'chosen-model' });
// Before explicitly closing the route, or leaving this task for other work:
await handle.restore();
// Normal Core retirement also awaits restoration through context.onCleanup.
```

This requires Core's `context.onCleanup` and a reviewed `reconfigureLoadedThread` contract. It refuses opt-in when either is absent. The handle captures the actual non-secret original provider/model before changing a loaded task; null originals fail before native release. The applying resume must select that registration's hook. The Adapter keeps at most 16 leases, keyed by task and exact registration owner/generation; another registration cannot take over or restore one. `handle.inspect()` and `configurations.list` expose restoration receipts without URLs or credentials.

`handle.restore()` disables the selection hook and restores only if the task is still locally owned, selected and idle and its provider/model still match that lease's expected state. A later choice of a different provider is preserved (`superseded`); a changed model on the same provider requires explicit review. Restoration uses one scoped resume override, preserving other native parameters and checking the native receipt. Awaiting the callable handle also retires the registration and restores its leases. Repeated callable disposal joins the first disposal; a retired public handle cannot start another manual restore.

Normal plugin retirement unregisters selection synchronously and awaits restoration before exported renderer `deactivate()` and Host teardown. A pending apply is cancelled before cleanup waits for its settlement. Forced retirement, active/background tasks, ownership drift and uncertain native results are reported as incomplete; they do not authorize interruption or silently overwrite user choices. Keep routes alive until acknowledged restoration during ordinary operation, and restore each task before leaving it selected elsewhere. Merely registering the option does not enroll unrelated native start/resume calls: automatic restoration applies to changes made through `handle.reconfigure`. The legacy `threads.reconfigure` RPC remains explicit/manual.

The Host channel or verified plaintext source owns forwarding policy, credentials, permissions and traffic lifetime. Multiple configuration changes conflict. Retirement cancels pending selection, and late results cannot dispatch a retired request. The callback does not grant arbitrary backend settings or direct remote URLs; remote forwarding uses the consuming Host's exact-origin Core grants. Changes to this boundary must update this spec and the HTTP/WebSocket regression tests together.
