# Owner-scoped Native context: consumer contract

This additive contract is for generic workspace consumers. It does not choose a grid, cache policy, panel selection or entry/exit strategy. Capability flags and readiness are independent; do not infer a feature from the presence of a method alone. No raw Native manager, fiber, router, scope or draft is returned.

The consumer chooses when to capture its entry position, which thread to select, whether to use an independent right viewport, and when to restore or release. All handles belong to the authenticated WorkspaceSession and are released by owner retirement. Native runtime mapping is still being verified; the types below are the minimal interface for parallel consumer/mock integration.

## Location capture and restore

`session.captureLocation(): WorkspaceLocationHandle` returns `{ready,kind,restore,dispose}`. `kind` is `thread` or `page`; Native route/state and any input identity stay private. Call capture on the entry page and **await ready before changing the page or selecting another thread**. Capture rejects for auxiliary/plugin pages, unavailable Native semantic navigation, or a page changed during readiness.

`restore({signal?}): Promise<{restored:true,kind}>` restores through the current mounted Native navigation bridge with the captured path/search/hash/state, never by exposing its router. No draft text is read, copied, injected or sent. If an input was captured, success requires its original **Native draft namespace** and an initialized Native EditorProvider for that namespace. Controller/React/scope instances may be rebuilt by Native. A transitional input from the previous page is awaited until the target semantic owner commits. A correctly owned target with a different draft namespace yields `workspace_location_state_evicted`. Restoration obeys trusted/controller IME guards and lifetime/cancellation. `dispose()` cancels pending work and drops private references; it does not navigate.

`features.locationRestore` is true only after the Native semantic restore driver prepares. A caller can capture to prepare it; use `ready` as the operation prerequisite. The exact page/input-state guarantee must be accepted on the owned Native candidate before production reliance.

Default exit can await entry.restore then dispose. An explicit enter-conversation action instead opens the requested thread and releases the entry handle without restoring. These choices belong to the consumer.

## Heading and selection presentation

`session.acquireSelectionPresentation({threadId:null,emptyLabel:'未选择会话'})` returns `{update,dispose}`. There is one exclusive presentation owner per Native document. Null selection replaces the Native title's presentation with the caller's bounded noninteractive label. Native heading actions remain visible and dimmed: native buttons/form controls receive `disabled`; actionable nodes receive `aria-disabled`, `inert`, pointer blocking and capture-phase activation blocking. Consumer-owned controls are excluded. Native route and saved thread title are unchanged; the outer titlebar/drag region is not overridden.

`update({threadId})` requires that route **and strict current input** agree with the chosen local thread. It then returns presentation to the Native heading/actions. An external route mismatch returns to the unselected presentation. The caller drives the update after its verified navigation commit; this method never navigates or sends. `dispose()` restores leased DOM fields using the journal, removes capture listeners and the owned label, and preserves later unrelated Native changes. `features.selectionPresentation` advertises the presentation mechanism; a selected thread still requires strict Native ownership.

## Optional independent right viewport

`session.createViewport({open?:boolean,width?:number})` returns `{ready,getSnapshot,subscribe,bind,update,close,dispose}`. Initial defaults are closed/360 CSS pixels; width is bounded 240..1600. One independent viewport owner per document. `features.independentViewport` remains false until an actual Native driver proves independent open/width state and cleanup; lack of a driver rejects `ready` with `workspace_viewport_unsupported`.

`bind({threadId,hostId?:'local'},{signal?})` requires the current strict Native input selection, then follows that thread's existing right-side content without selecting it. `bind(null,{signal?})` clears/disables content while preserving the workspace's open/width state. `update({open?,width?},{signal?})` changes that workspace-owned state. Snapshot is `{independent:true,open,width,threadId,hostId}` with null identity before bind. No left chat-list state is involved. `subscribe(listener)` immediately delivers the current snapshot and pushes subsequent Native close/resizer changes; its returned function and owner retirement both unsubscribe. The driver uses Native notifications, not a new polling loop.

`close():Promise<void>` is the required awaited exit path: restore each visited Native context to its own original viewport state and remove all owned overrides/persistence before releasing ownership. Explicit exit must not write the entry thread's width/open state into a different target thread. `dispose()` starts bounded cleanup and makes the handle unusable; Core owner cleanup must await the same pending close. A cleanup failure is reported and must not be treated as restored. Native resizer/control actions must not write any original per-thread open/width settings. A DOM-only width override does not satisfy this feature, and no fallback enables it.

The Native route/thread signal, width configuration and persisted-atom writer have a concrete optional driver candidate, documented in [independent viewport mapping](workspace-independent-viewport-2026-10-13.md). It leaves existing content intact and publishes the feature only after driver readiness; its source/offline verification does not substitute for consumer-owned Native persistence/content acceptance.

## Existing controls and resources

The action's actual event and entry lifecycle remain separate from placement. A Native toolbar rebuilding/removing an injected owned span must restore placement and rebind its providers. That recoverable lifecycle case is not claimed as the cause of the live user's click issue; the corrected live probe confirms the button exists/enabled. The consumer separately reproduced entry cancellation during inactive cleanup.

`mountTranscript` creates one owned React body root, scopes, scroll/search/virtualization state and temporary readiness observer per handle. Discovery, the Native backend manager, hydration queue/deduplication and the Adapter readiness listener are shared. It mounts Native Content and ThreadSubscription, not Frame/Composer, and opens no backend/renderer/editor instance. Native content may still have its own copy/scroll/history/search subscriptions and child code/tool UI; root disposal removes those component resources. Underlying Native history/model caches are owned by Native and are not globally cleared by a handle.

Any-main-page entry can use shell/main provider ancestry for a transcript instead of requiring the main composer. The consumer must use root/surface capability readiness appropriately rather than interpreting `snapshot.available` (which retains its existing composer availability meaning) as the sole permission to show a workspace overlay.

The Native home composer has no thread scroll container: `scroller` is null, `content` uses its Native main content layout/main surface, and `footer` is the actual home composer root including its controls. `bodyViewport` uses content/main bounds. Body leases suppress only branches outside this input, and composer disable/hide leases retain their normal reversible behavior. Consumers should use the returned geometry and choose their own home/unselected presentation.
