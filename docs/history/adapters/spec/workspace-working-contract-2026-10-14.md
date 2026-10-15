# Native Working state contract

`LoadedThreadSummary.working:boolean|null` is returned by authenticated `threads.loaded` and included in the existing `thread.summary.changed` payload. The earlier `runtimeStatus` projection is unchanged. Working means ongoing Native work, independent of whether its row is mounted, collapsed, virtualized or masked by unread presentation. It is not a final badge-visibility API; the initially proposed sidebarWorkingIndicator was superseded by this smaller execution-state contract.

True means established Native work; false means established stopped/idle work; null means unsupported/unready mapping. Consumers retain unknown entries and disable a destructive activity-only filter while relevant state is unknown. No per-thread/panel policy, running-count ceiling, added connection, row/editor reconstruction or DOM animation-class inference exists.

## Implemented source

`frontend/src/desktop/native-working.js` loads the already-present Initial/Shared modules only for the reviewed pair `app-initial-b8e1c8014bb4.js` / `app-shared-737655e1fb23.js` (Native 26.1007.2314). The role table is version-specific and does not carry private keys into unreviewed profiles. It verifies each selector's AppScope token/read interface and the existing facade's node/get/watch ownership. State requests never navigate/resume a cached thread or issue a backend request.

The three actual Native selectors are:

- Initial `f9n` (export `vfn`), original byte 2794912. It invokes Native `d9n` with response progress, runtime status, resume state, system error and `c9n` owned child work. It explicitly uses the `Ws` summary when the cached thread needs resume or its runtime is notLoaded. The adapter always lets this selector handle those cases, with no cached-state early null gate.
- Initial `k9n` (export `nfn`), byte 2799032. Native `T9n` resolves request kind/blocking status, and its asynchronous user-input path returns `blocking:false`. Input and approval blocking results are preserved rather than approximated from the Adapter's broad requests/attention projection.
- Initial `lGo` (export `AW`), byte 7484585. It resolves whether Native `cGo` is publishing. `cGo` (7484122) reads Native publication/saving state with its actual account/config ownership checks; the Adapter does not fabricate this state from runtimeStatus.

`nativeWorkingState` validates the selector shapes, then applies the execution contract: publication is working; a Native response state other than loading is not working; loading with an actual blocking request is paused; loading with no blocking request, including asynchronous input, is working. Unknown outputs return null. No unread, hover, hidden-row, room badge or mounted-row state enters this mapping. The broad runtimeStatus may legitimately remain attention or idle while working is true.

Cached threads use existing `facade.watch` dependencies; f9n's child dependencies naturally invalidate parent work when a child starts/stops. Each changed boolean/null updates only its summary and emits the normal event if the public projection changed. Repeated unchanged values emit nothing. Failed/unready reads stay subscribed where Native can establish its watch and recover when dependencies become ready. Thread removal releases that thread's watch; provider retirement releases all. There is no polling timer or total cached-thread count gate. Fresh page snapshots refresh current summary projections; continuation cursors preserve their existing 15-second snapshot semantics.

Saved original/formatting evidence: `.artifacts/workspace-context-source/symbols-c9dffae1-602a-4624-8538-c4c847a22f23`, `symbols-db3b7517-9e6d-499b-9465-18081864d196`, and `symbols-2cf30f21-f180-42ce-b4cf-2940ab13657f`. Only static parsing/read was performed; cached Native source was not evaluated.

## Verification limits

Synthetic tests cover Native selector/facade role checks, unsupported profile/shape, loading/idle/error, blocking approval/input, asynchronous input, publication, parent/child notifications, unchanged-event deduplication, unready recovery, retirement, and 4205 cached unresumed/notLoaded entries with no mounted DOM or count limit. Unread/folded/virtualized fixture values cannot suppress Native work. Public Desktop DTO tests preserve runtimeStatus and accept the new nullable field.

The activity-specific suite passed 7/7; the complete related workspace/UI/Desktop/navigation/history/permissions/activity suite passed 255/255 with zero failures or skips. Frontend build and diff checks passed. The count-unlimit commit eafdce1 remains an ancestor; this activity change is a separate commit.

The former Native PID is gone; this work does not launch or operate Native or rewrite historical samples. The current mapping is source-audited and regression-tested, with live Native read/event acceptance pending a separately authorized client. No actual permission change or turn was sent.
