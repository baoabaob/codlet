# Native context candidate: A/B acceptance boundary

This candidate adds opaque main-page capture/restore, owner-scoped heading presentation and any-main-page transcript provider lookup. It also repairs generic action placement after Native removes an injected owned span, and refreshes the action's Native providers after anchor replacement. No grid, preview, active-panel policy or consumer cache strategy is added to Adapter.

The location handle keeps the original Native location/state and input identity private. Capture and restore share the navigation IME guard. Restore retires conflicting pending navigation and holds a route guard until completion/cancellation. Native route changes during readiness or restoration fail explicitly. Draft text is neither read nor copied. If Native evicts the original input controller/scope, restoration fails with `workspace_location_state_evicted`.

Null selection masks the Native main heading's contents and shows the consumer's bounded label. Strictly confirmed Native selection restores its own title/actions. The outer titlebar/drag region is retained. Later unrelated DOM property writes are preserved when the presentation lease closes.

The optional right viewport contract includes `bind(null)` and push subscriptions. Its actual Native driver is still under investigation, and this candidate advertises `independentViewport:false`; this intermediate package is not completion of the right viewport work. See [the contract](workspace-context-contract-2026-10-13.md).

## Validation

The frontend build passed. The related suite passed **147 tests**, with zero failures/cancellations: `node --test tests/workspace*.test.mjs tests/codex_ui_adapter.test.mjs tests/codex_ui_composer_action.test.mjs tests/host_discovery.test.mjs tests/native_navigation.test.mjs tests/synthetic_history.test.mjs`.

The initial repository-wide test run was interrupted while its unchanged `codlet_gui.test.mjs` worker remained running. It is not recorded as a repository-wide pass. Focused context/navigation/workspace tests passed 69 cases before the broader related run.

The current owned Native instance remains exclusively controlled by the split consumer chat. This source/build/offline result does not prove new-chat draft retention in Native, window dragging, pinned-summary rendering or right viewport persistence isolation.

## Native checks for this frozen candidate

Use the existing consumer-owned instance and its retained user history/drafts; do not run zero-turn seeding or cleanup fixtures against it. Capture a new unsent page and await capture readiness before entering. Default exit must return to the same Native page and retained input state. Explicit enter-conversation must keep the chosen target and release the capture without restoration. Observe IME rejection and cancelled/failed restoration without clearing a draft. Confirm null selection heading/action masking, confirmed selected heading, and lease release.

Pinned-summary/composer offset remains unconfirmed. Native's thread frame owns additional content-shift/layout behavior that the Adapter's transcript Content does not mount. The reliable geometry is still the currently confirmed Native footer/composer; no hardcoded offset or speculative summary fix is included. If the scene reproduces, compare the consumer's pinned surface with the bounded read-only DOM/geometry report before changing the footer role contract.
