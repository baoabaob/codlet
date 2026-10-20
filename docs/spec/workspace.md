# Workspace API 1

Core v1 provides `codex.ui.workspace@1` (target scope) through `await context.codex.workspace.connect()`. Consumers declare this capability, `ui.dom`, and `ui.mainWorld`, run in the main world, and use Core directly for controls, storage and lifecycle. Layout, selection policy, dragging, caching and render scheduling belong to the consumer. Core also owns Desktop metadata/events and RPC navigation. No separate Adapter installation is required. [types/codex-workspace.d.ts](../../types/codex-workspace.d.ts) defines the complete API; [Codex SDK](codex.md) defines facade admission, update checkpoints and availability.

The [archived acceptance record](../history/adapters/spec/workspace-review.md) preserves earlier Native evidence and its limits. Current candidate identities and scope are in [release validation](../releases/1.0.0-rc.1/validation.md). The [composer contract](../history/adapters/spec/workspace-composer-contract.md) distinguishes the offline protocol implementation from the unvalidated Native driver. No production Native profile currently advertises `composerRebind`.

```js
const workspace = await context.codex.workspace.connect();
const unsubscribe = workspace.subscribe(snapshot => { /* snapshot changed */ });
const slot = workspace.createSlot('activity.before');
// slot.container is an owned HTMLElement. Render Core UI into it.
```

The asynchronous facade acquires and consumes a Core-authenticated single-use ticket, returning a frozen owner-scoped session. The retained low-level `getApi` descriptor is `{api:1,symbol,ticket}`; its 15-second ticket binds the authenticated plugin and renderer generation. Its local `connect` call is synchronous, unlike the facade above. Consumers do not need to read global symbols themselves. Sessions, subscriptions and handles retire on consumer or provider retirement/replacement. `dispose()` is idempotent. Retired methods throw `workspace_retired`; invalid tickets throw `api_ticket_retired`. No client modules, export names, React fibers, providers or manager objects are public.

Core also supplies `resolveThreadInteraction` and `hasBlockingOverlay` for Native gesture semantics, `captureLocation` for owned return-page/draft identity, `acquireSelectionPresentation` for an unselected workspace, `createViewport` for independent Native sidebars, and `acquireComposerControl` for a temporary consumer control. These remain generation-owned handles; feature flags and the TypeScript contract define availability. Location `exportState` transfers a short-lived opaque token in the same Native document; it never serializes draft text and does not survive a process restart. See [state and ownership rules](codex.md).

## Snapshot and surface

`getSnapshot()` synchronously returns a frozen value:

```ts
interface WorkspaceSnapshot {
  api: 1;
  revision: number;
  route: { pathname: string; search: string; hash: string } | null;
  threadId: string | null;
  hostId: 'local' | null;
  auxiliary: boolean;
  available: boolean;
  features: { surface: boolean; activitySlot: boolean; transcript: boolean; shortcuts: boolean; navigation: boolean; navigationInput?: boolean; locationRestore?: boolean; selectionPresentation?: boolean; independentViewport?: boolean; action: boolean; composer: boolean; composerRebind: boolean };
  diagnostic: { code: string; message: string } | null;
}
```

`subscribe(listener)` invokes `listener(snapshot)` immediately, then after route, availability or semantic surface changes, including resize. It returns an unsubscribe function. Listener failures are diagnosed and do not break other owners. `available` describes the main workspace; individual feature availability is separate. Auxiliary windows report `auxiliary:true`, `available:false`, and do not initialize main-workspace modules.

`composerRebind` is a separate capability from `composer`. A supported profile prepares it asynchronously and publishes the change through `subscribe` before an input must be created. Consumers must wait for that flag; an unknown or unvalidated profile remains false. It does not become supported merely because a composer component was discovered. Reconnect and retirement cancel pending capability publication.

`await workspace.prepare({features:['navigation','transcript']})` resolves the
requested interface dependencies without mounting UI, navigating, reading drafts
or loading conversation history. It returns
`{api:1,evidence:'interface-contract',available,features,lifecycleVerified:false}`.
Each feature has its own `available` and `diagnostic` result; one failure does not
disable other features. Supported names are `navigation`, `transcript`,
`composer`, `shortcuts`, `action` and `viewport`. The default is navigation plus
transcript. Empty, duplicate and unknown feature names are rejected. Auxiliary
windows reject preparation before initializing main-window modules. Retirement
rejects pending completion. This is an additive API 1 method; consumers should
feature-detect it when supporting older Core builds.

Consumers keep their entry disabled while required interfaces are pending or
failed, and check the navigation handle's `inputApi === 1` when strict input
ownership is required. Shortcut failure can leave a pointer entry usable with
its accelerator hidden. Preparation verifies interface contracts; it does not
certify rendering, IME, attachment, permission or full lifecycle behavior.

`getSurface()` synchronously returns `{available, main, content, scroller, composer, footer, header, rightPanel}`. Every role is either `null` or `{element:HTMLElement,rect:{x,y,width,height,top,right,bottom,left}}`. `main` is the main AppShell surface; `content` contains the native thread body and footer; `scroller` is the primary thread scroll container; `composer` is its composer root; `footer` contains that composer; `header` is the main titlebar; `rightPanel` is the native right resource panel. There is no fiber or provider data. Nodes and geometry are ephemeral: read them again after a snapshot change. An unopened optional panel is `null`. Ambiguous or unknown host structure reports a diagnostic and returns an unavailable surface, rather than selecting another pane.

`resolveThreadReference(element)` synchronously returns `{threadId,hostId:'local'}` or `null`. It accepts an Element from this document, resolves a native sidebar thread row through bounded mounted ancestry, and rejects main content, plugin nodes, remote/cloud entries and ambiguous identities. It performs no navigation or history loading. The consumer owns pointer handling and dragging.

The Desktop Read API adds `threads.loaded({limit?:number,cursor?:string,threadId?:string})`, returning `{threads,cursor}`. Each summary is `{id,title,cwd,hostId:'local',runtimeStatus:'running'|'attention'|'idle'|'loading',working:boolean|null}` without turns, items or manager objects. Limit defaults to 20 and is 1..100 per page; Core imposes no total cached-summary count limit. A specific `threadId` returns only that cached summary or an empty array; it does not load it. Cursors are opaque, single-use snapshot continuations, expire after 15 seconds, and support at most 32 simultaneous pagination snapshots. Page size and snapshot lifecycle do not cap the total entries traversed. This enumerates the Native manager's current cache, not its full persistent thread catalog. The existing Desktop Events API emits `thread.summary.changed` with `{threadId,thread:summary|null}` only when that thread's projection changes, including working; consumers update that entry. Unchanged streaming tokens do not emit summary changes.

`runtimeStatus` is a coarse Core projection, not a guarantee that the Native sidebar displays its spinning indicator. Pending requests and approval/input flags take attention priority; otherwise Native runtime active maps to running, with a last-turn fallback when runtime status is absent. Native's actual indicator additionally depends on response/owned-work state, blocking input, publication, unread count and row presentation. See the [read-only semantic audit](../history/adapters/spec/workspace-count-and-list-semantics-2026-10-14.md) before using it to implement the Native-spinner-only activity filter.

`working` is the separately adapted Native work state. It ignores final unread badges, collapsed groups, virtualization and offscreen presentation. Supported Native selectors resolve response/owned child work, blocking versus asynchronous input, and publication through the existing AppScope; a blocking request pauses ordinary work, while publication or nonblocking input can remain working. True/false are established selector results; null means the profile, facade or state shape cannot be proved, never idle. A cached `needs_resume`/`notLoaded` thread still uses Native's summary/child-work path and is not rejected merely because it has not resumed. Existing Native state watches update one affected summary, including parent changes originating from child work, without polling or mounting rows/editors. See [the Working contract](../history/adapters/spec/workspace-working-contract-2026-10-14.md). Consumers must preserve unknown entries rather than treating null as false.

## Owned activity slot

`createSlot('activity.before')` synchronously returns `{container,dispose}`. Its owned `display:contents` span is a sibling of the entire native activity control, outside its tooltip/coachmark trigger and preserving its internal layout. It reattaches when that control remounts. The consumer may render Core UI into this container and must dispose its rendering root.

`createSlot('workspace.overlay')` returns the same shape, placed inside the stable native host root, outside conversation body/footer suppression. It adds no layout, position, selection or overlay behavior. Render a consumer-owned overlay into it. A transient conversation surface does not remove this container. At most 8 slots per session are allowed; unknown names throw `invalid_argument`.

## Native toolbar actions

```js
const action = workspace.registerAction({
  id: 'tools', label: 'Tools',
  icon: { paths: ['M3 3H21V21H3Z'], viewBox: '0 0 24 24' },
  shortcut: 'Ctrl+K', pressed: false, disabled: false,
  onInvoke() { /* consumer action */ }
});
await action.ready;
action.update({ pressed: true });
```

The handle renders the actual native button and tooltip beside the activity control. `icon.paths` contains filled SVG path strings, with `currentColor`; the default viewBox is `0 0 24 24`. Native control sizing, icon sizing, selected state and tooltip shortcut presentation are retained. `shortcut` is a display hint, not a second binding; use `registerShortcut` for the actual command/settings registration. `update(partial)` preserves the native root and schedules a native commit. `dispose()` removes only this owned action. IDs are unique per owner, labels are 1–128 characters, and at most 16 actions per session / 64 per provider are supported. Retired/disabled actions do not invoke callbacks.

## Direct native navigation and input confirmation

```js
const navigation = workspace.createNavigation();
await navigation.ready; // prepare once; no Core RPC is needed per selection
if (navigation.inputApi !== 1 || typeof navigation.focus !== 'function')
  throw new Error('Strict Native input navigation is unavailable');
const operation = navigation.open({ threadId }, { signal });
// Only an accepted open may disable the input: an IME-busy open throws above.
lease.update({ composerEnabled: false });
const executed = await operation.executed;   // actual native route selected
const committed = await operation.committed; // physical native composer owner confirmed
if (committed.threadId === threadId && workspace.getSnapshot().threadId === threadId) {
  lease.update({ composerEnabled: true });
  navigation.focus({ revision: committed.revision }); // explicit; may return false
}
```

`ready` resolves to `undefined`; it never exposes Native objects. `features.navigationInput` and `navigation.inputApi === 1` identify the candidate strict input contract after preparation. Older providers may omit them; a package version or `features.navigation` alone does not prove this contract. The prepared session reports `inputApi:0` when unsupported and `focus` throws `workspace_navigation_unsupported`.

`ready` completes discovery; it does not flush the frame-batched workspace snapshot. Immediately after it resolves, `inputApi` may be `1` while the previously published snapshot still has `navigationInput:false`. Consumers requiring both must retain the `inputApi === 1` check and wait for feature publication through `subscribe` (with bounded setup cancellation/timeout), before opening a task. Record `getSnapshot().revision`, feature flags and `diagnostic.code` to distinguish discovery failure from publication delay. This setup wait does not weaken either receipt or change a `committed` continuation into a delayed surface check.

`open` synchronously returns `{executed,committed,dispose}`. A prepared cached selection executes in this renderer immediately, without Core RPC or redundant metadata reads. `executed` resolves to `{threadId,resumeState,streamRole,status,alreadySelected,revision,synchronousMs}`; it confirms route identity, not input readiness. `committed` resolves to `{threadId,hostId:'local',inputConfirmed:true,submitDisabled,revision}` only after the currently mounted Native local composer facade, canonical Thread/Route scopes, actual controller and submission handler agree with that task. Outer props, a route or an editable DOM node alone cannot confirm it. An already-selected model/controller replacement during confirmation fails closed. `submitDisabled` projects Native's own pending/history state. Neither receipt contains private nodes or services. The workspace snapshot is updated before either successful receipt is delivered.

After `ready`, an IME-busy `open` synchronously throws `workspace_composer_busy` before accepting or superseding an operation, navigating or moving focus. It checks Native's composing flag and capture-phase composition state, including the home input. Cold metadata validation checks again immediately before routing; IME starting during that wait rejects the accepted operation without navigation. The consumer must apply an inert lease only after `open` has returned successfully. `open` does not explicitly focus or blur; Native owns its normal route lifecycle.

`focus({revision})` returns true only for this session's latest successful, unchanged committed input on the same full route. It compares the current model, scope values, actual controller, submission handler and editable identity with the commit pin, refuses disabled/inert/hidden input and does not steal focus during composition. A stale revision, changed model/controller/handler, changed route or disposed operation returns false. Owner/session/provider retirement throws `workspace_retired`. It adds no selection policy.

One navigation session per workspace session is supported. Abort, operation disposal, owner/provider retirement and a newer valid operation reject pending confirmation. Invalid or already-aborted calls do not cancel another valid operation. Late metadata responses cannot navigate after cancellation/supersession. Cancellation does not undo a route already executed. A user route change supersedes pending confirmation. A bounded 5-second confirmation timeout reports `workspace_navigation_commit_timeout`; there is no polling. The observer is connected only while a valid execution awaits input confirmation; queued frames/microtasks are cancelled at settlement. The consumer owns selection ordering, highlighting and input enablement policy.

## Owned native composers

This section describes an unpublished fixed-identity prototype. Its Native draft handoff to an already-live main editor has not passed acceptance. It is not the fallback for a consumer requiring `composerRebind`; the split consumer waits for the explicit capability instead of constructing a pool of these inputs.

```js
const input = workspace.mountComposer(container, { threadId, hostId: 'local' });
await input.ready; // Native input, handlers and immutable conversation scope exist
const receipt = await input.activate(); // no navigation and no automatic focus
if (receipt.threadId === selectedThreadId) input.focus();
input.deactivate(); // synchronously blocks editing and cancels late activation
input.dispose();
```

`mountComposer` returns a frozen `{threadId,hostId,ready,activate,deactivate,focus,dispose}` handle. Identity is immutable. The connected empty container must be in this document, outside Core UI style regions. It supports `height:auto`: Core follows Native's actual footer height, including multiline drafts and attachment changes. A consumer `ResizeObserver` may observe its own container. Layout, input visibility, pool size and eviction policy remain consumer decisions.

`ready` confirms the mounted input's current Native conversation binding. `activate()` returns `{threadId,hostId:'local',inputConfirmed:true,submitDisabled:false}` after the same input can edit the loaded owner task. A preheated owner input activates without rebuilding Native or changing the main route. Activation and deactivation affect only this handle; the consumer coordinates any selection or exclusivity policy. `deactivate()` immediately makes the owned subtree inert, blurs its active editor, and rejects pending activation with `workspace_composer_deactivated`; a late completion cannot enable it. `focus()` is separate, requires an active ready input, and returns whether Native's editable element received focus. Calls after disposal or owner/provider retirement throw `workspace_retired`.

The prototype uses Native's thread Frame with its body hidden, retaining editor behavior and per-thread actions as well as extra layout/route work. Core creates independent Thread/Route/Composer scopes without copying a previous input's submit closure. This does not prove safe simultaneous draft synchronization or durable save completion. Preheating does not ask Native to resume a task or acquire stream ownership. Activating an unloaded or non-owner task uses Native's own resume lifecycle and stays inert until confirmed. Main-route navigation remains separate. The prototype supports 16 composer handles per session and 32 per provider, without an eviction policy.

Optional `onState` receives `{phase,threadId,hostId:'local',diagnostic}` where phase is `preparing`, `ready`, `activating`, `active`, `inactive`, `error` or `disposed`. Readiness/activation have bounded 10-second timeouts. Disposal disconnects owned observers, cancels pending callbacks, unmounts Native and removes the owned subtree.

### Rebindable composer contract

The candidate types also describe a single logical handle with `bind(identity,{signal})`, revision-aware `activate`/`focus`, and `close({signal})`. This protocol and its ownership/cancellation boundary are implemented and tested with a fake Native driver. The actual direct-composer driver is pending; the real discovery returns `composerRebind:false`. A true flag is required before relying on these methods. See the [agreed contract](../history/adapters/spec/workspace-composer-contract.md) for the complete semantics.

Every accepted bind increments `bindingRevision`, blocks only its own input and stays inactive until activation confirms the same revision. Invalid, already-aborted or IME-busy calls preserve the current binding. Receipts include `threadId`, `hostId`, `bindingRevision`, `inputConfirmed:true` and `submitDisabled`. Bind does not focus, navigate, send or resume. Native may recreate its keyed editor; the container and logical handle remain stable. Consumer callbacks should always pass the returned revision to activation and focus.

`close` retires immediately and waits for the driver's Native draft checkpoint and resource release. Synchronous `dispose` starts the same process but does not certify persistence; `close` remains awaitable afterward. The provider's Core `onCleanup` waits for it. An abort, timeout or checkpoint failure rejects and remains visible to later Core cleanup even after the DOM and handle have been removed. A successful fake checkpoint is not evidence of Native disk persistence or live-main draft synchronization.

## Temporary native surface control

`acquireSurface(options)` synchronously returns `{update,dispose}`. Options are:

```ts
interface SurfaceOptions {
  hideBody?: boolean;          // default false; preserves the composer footer
  hideHeader?: boolean;        // default false
  hideComposer?: boolean;      // default false; hides the footer
  composerEnabled?: boolean;  // default true
  rightPanelEnabled?: boolean;// default true
}
```

`update(partialOptions)` merges the specified fields. Suppression uses visibility, inert and aria-hidden without removing native nodes or changing layout. Multiple leases compose: any hide request hides; any disabled request disables. Only properties changed by Core are restored, including exact inline values/priorities and original attribute presence. If another owner changed a property meanwhile, disposal preserves that newer value. Navigation restores the previous nodes and applies the lease to the new surface. Non-conversation pages receive no conversation patches. The consumer decides when to release or change the lease. At most 8 leases per session are allowed.

## Native transcripts

```js
const transcript = workspace.mountTranscript(container, {
  threadId, hostId: 'local', readOnly: true, trackReadState: false,
  onState(state) { /* loading / ready / error / disposed */ }
});
await transcript.ready;
transcript.update({readOnly:false,trackReadState:true});
transcript.dispose();
```

`mountTranscript(container, options)` synchronously returns `{ready:Promise<void>,update,dispose,getScrollPosition,setScrollPosition}`. After `ready`, `getScrollPosition()` returns `{top,left}` and `setScrollPosition({top,left})` restores finite CSS offsets (including negative offsets used by reverse scrolling and RTL) in this handle's independent native scroller. The consumer never needs a private selector. The container must be a connected, empty HTMLElement in this document, owned by the consumer; native surface nodes and shared mount containers are rejected. `threadId` is required (8–256 letters, digits, underscores or hyphens), `hostId` defaults to and only accepts `'local'`, `readOnly` defaults to `true`, and `trackReadState` defaults to `false`. `onState` is optional. State is `{phase,threadId,hostId:'local',diagnostic:null|{code,message}}`. `ready` resolves after native rendering is committed; failure rejects it and emits `phase:'error'`. Consumers should catch the promise. `update(partialOptions)` changes flags/callback or rebinds a new thread; it is synchronous and reports asynchronous failures through `onState`. Native component errors are contained and diagnosed.

Core owns provider reconstruction, native history loading, active-interest and stream lifecycle through the existing local Desktop manager, and an independent scroll container. It does not open a second backend connection or implement a composer in the transcript. Scroll position within a handle is preserved on flag updates; caching scroll positions across disposed handles is the consumer's responsibility. Read-only disables transcript interaction; it does not choose or navigate the main thread. There is no per-session or per-Target transcript count limit: each accepted mount creates its requested instance and remains owned until explicitly disposed or its owner/provider retires. No hidden count-based truncation or eviction is applied.

History reads are deduplicated by thread and at most two queued reads start concurrently, with interactive/visible mounts first. Retirement cancels queued work and prevents late native roots, callbacks or commits. An already dispatched shared Native history read can finish under Native's ownership; the current manager does not expose an independent abort for that shared read.

Flag-only updates and main-route switches retain `phase:'ready'`, providers, native thread subscription, scope value, root, body and scroll identity. Main-route changes do not rebind independent transcripts. Each candidate transcript supplies its own Native Thread/Route/Composer scope for its requested identity. This is covered by a context fixture; Native actions that use a global main-route resource panel still require independent acceptance. Updates across owners are combined in one microtask and use Native React's scheduled commits. Only initial mounting or an explicit `update({threadId})` requires a synchronous initial commit. Readiness requires a loaded native thread and a committed conversation body, with rendered content when that thread has history; an empty scroll element alone does not qualify. Current Windows Native requires a separate native thread-subscription component beside Content; Core discovers and mounts it privately.

Keep native transcript containers outside Core UI's `[data-codlet-official-ui]` styled scope. Use neutral DOM/portals for body containers and small Core UI regions for consumer controls. Native CSS applies normally inside or outside `#root`; an enclosing SDK reset can override it. Core does not copy or override native stylesheets.

The Target limits shortcuts to 64; it has no transcript count limit. Semantic changes are batched by frame in visible web documents and by microtask in hidden documents: current Native UIKit can display a foreground window backed by a Chromium document whose visibility remains hidden. No periodic polling or synthetic clock advancement is used.

### Opt-in Core measurements

The private provider constructor accepts `testPoints:{enabled:true,runId,capacity?}` for an explicit test run. Production activation supplies no option. Disabled measurements create no recorder, timers, observers or samples and do not read a clock. Enabled records use a bounded ring and numeric view/operation/thread aliases; they do not accept message, draft, attachment or path fields. Reports remain private to the test provider rather than becoming a Workspace RPC method.

Navigation phase points distinguish call-entry preflight, optional metadata, Native dispatch, pending checks, confirmed surface/geometry/publication and focus attempts. Diagnostic operation aliases do not consume public revisions. Nested spans are not additive; unallocated waiting is not CPU attribution, and overwritten ring points must be treated as incomplete. See [phase definitions and the offline reader](../history/adapters/spec/workspace-navigation-phase-points-2026-10-13.md).

From Core, run `node codex/tests/fixtures/workspace-acceptance/bench-wrapper.mjs` for the offline 0/1/2/4/5/8-transcript matrix. It exercises scheduling, subscriptions, geometry reads and teardown with React/jsdom fixtures. It does not measure Native editor behavior, paint, sustained CPU or whole-window responsiveness. Real acceptance uses a separately owned test client and synthetic data after verifying its run, profile, registry, PID, Target and backend/home isolation.

The [strict navigation acceptance record](../history/adapters/spec/workspace-navigation-input-2026-10-11.md) documents owned Native probes and their failures. `build-native-navigation.mjs <verified-owned-run> <fresh-navigation-label> --performance-only` builds a temporary Host probe for counterbalanced Native/Adapter navigation and an empty-history body matrix. `--body-only` separates body testing; `--inspect-only` and `--shell-only` are diagnostics. Reports contain model readiness and optional renderer task-time samples, not Native paint or foreground frame latency. Synthetic composition events do not certify physical IME. No probe runs during ordinary production activation.

## Native shortcut settings

```js
const shortcut = workspace.registerShortcut({
  id: 'toggle', label: 'Toggle workspace', description: 'Open or close the workspace',
  accelerator: 'CmdOrCtrl+Shift+S',
  onInvoke() { /* consumer action */ },
  onChange(accelerator) { /* persist string or null */ }
});
await shortcut.ready;
```

`registerShortcut(options)` synchronously returns `{ready:Promise<void>,getSnapshot,update,dispose}`. IDs are 1–64 letters, digits, underscores, dots or hyphens and unique within a session. Native command IDs are namespaced by authenticated owner. Labels are nonempty, at most 128 characters; descriptions are at most 512 characters. `accelerator` is a single native accelerator string (at most 128 characters) or `null`; it is also the restore default unless `defaultAccelerator` is supplied. Sequences and bare modifiers are unsupported. `onInvoke` is required; `onChange` is optional. `getSnapshot()` returns `{id,accelerator,defaultAccelerator,conflict:null|string}`. `update(partialOptions)` accepts the registration fields except `id`; it merges fields, rerenders the native row and changes the effective binding. Binding conflicts throw `shortcut_conflict` for programmatic changes and appear in the native capture control for user edits.

Rows appear in the official keyboard-shortcut settings and follow its search, capture, conflict validation, clear and restore interactions. Clearing emits `onChange(null)`, restoring emits the default binding, and editing emits the accepted accelerator. Callback promises are handled and failures diagnosed. Shortcuts are ignored during capture and modal text entry according to the native command policy. Platform comes from the actual client navigator identity used by Native's detector; Windows is the current acceptance platform. macOS mappings may be derived from native contracts but are not claimed as tested. Core stores no consumer shortcut preferences and supplies no tooltip. At most 16 shortcuts per session are allowed.

## Errors and compatibility

`invalid_argument`, `invalid_owner`, `resource_limit`, `workspace_retired`, `api_ticket_retired`, `workspace_host_pending`, `workspace_host_drift`, `workspace_transcript_unavailable`, `workspace_shortcuts_unavailable`, `workspace_composer_busy`, `workspace_composer_binding_drift`, `workspace_navigation_unsupported`, `workspace_navigation_superseded`, `workspace_navigation_commit_timeout`, and `shortcut_conflict` are stable error categories. More specific structural discovery diagnostics may accompany snapshots and transcript state. A pending route can recover. Unknown structures fail closed and do not silently use a fixed resource hash, a guessed export, or a hard-coded shortcut platform.

All handles and callbacks are owned by their session. Consumers should release handles explicitly when their feature closes and call `workspace.dispose()` on teardown; Core deactivation is the final cleanup boundary. Main-world plugins already have privileged client access; the ticket scheme enforces Core declaration and lifecycle ownership, and is not an OS security sandbox.
