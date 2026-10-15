# Native workspace switching candidates

UI Adapter **0.1.12** and Desktop Adapter **0.2.17** extend [Workspace API 1](../workspace-api.md). Published UI 0.1.11 / Desktop 0.2.16 remained installed during the independent probes. This candidate includes the previously unpublished `81cf614` work and uses new versions.

This is a historical navigation/transcript record from the earlier client run. It is not acceptance of the October 11 binding/cleanup changes or of a direct Native composer. The [current contract and evidence](workspace-composer-contract.md) keep the actual rebind feature disabled until Native draft handoff is proven. The user's daily client is now launched natively; subsequent runtime tests belong to an independently owned Codlet test client with synthetic data.

## Changes and integration

`workspace.createSlot('activity.before')` now sits beside the entire native activity control, outside the tooltip/coachmark trigger. `workspace.createSlot('workspace.overlay')` provides an owned `display:contents` span under the stable host root, outside `hideBody` suppression. Neither slot implements consumer layout.

`workspace.registerAction({id,label,icon:{paths,viewBox?},shortcut?,pressed?,disabled?,onInvoke})` returns `{ready,update,dispose}` and uses Native's actual button and tooltip. SVG paths are filled with currentColor. Shortcut is a native tooltip hint; continue using `registerShortcut` for command registration and settings. Handles are owner-scoped and preserve the rendering root across updates.

`workspace.createNavigation()` returns `{ready,open,dispose}`. Prepare it once. `open({threadId},{signal?})` synchronously returns `{executed,committed,dispose}`. Cached identities execute through the existing native router in the current renderer, with no per-selection Core RPC or metadata read. The executed receipt confirms the route. The committed receipt confirms the actual mounted native composer through current-tree ancestry and its local conversation binding. Both include threadId. Input remains visible but should stay inert until the committed ID and current workspace snapshot match the consumer's latest intent.

The navigation observer exists only while input confirmation is pending. Microtask and animation-frame queues have separate deduplication/cancellation state. Settlement disconnects the observer and cancels queued work. Arguments and signal are validated before replacing another operation. Every operation has an internal AbortController: cancellation, supersession and retirement abort late validation, and the shared thread opener checks again after metadata awaits and immediately before routing. A late cold response cannot navigate after a newer operation remains on the same current route.

Main-route changes no longer rebind independent transcripts. Their providers, scope values, native subscriptions, roots, bodies and scroll nodes remain committed. Only explicit thread updates change a transcript's identity. Main-route changes do not call global synchronous rendering for each panel or emit loading on already-ready handles.

## Actual native evidence

The temporary provider uses the production workspace code under a separate test capability/symbol; the consumer obtains a real Core-authenticated ticket. The official adapters are neither replaced nor reloaded by the probes. Target `F6A028F01F7CF0D943DB75CF88BA040F`, Core PID 48220, Windows package 26.1002.7124.0 / Core 0.2.0-preview.29 were used. Five panels of the existing split consumer remained open alongside three candidate probe transcripts.

Native action evidence: both new action and existing activity button measured **28×28 px**. The action was outside the native activity trigger; its click callback ran once. Its actual native tooltip displayed the action label and `Ctrl+Alt+Shift+F11`, with background `rgb(13,13,13)` and white text. It preserved Native's button radius (9.375 px). Native tooltip appearance and the shortcut line were inspected after pointer hover.

Three different native transcript bodies contained 12,271 / 3,981 / 4,977 characters in the first run. Across all switches they retained the same body/scroller nodes and top offset -31. Their root count stayed 3 and synchronous flush count stayed 3 (initial mounts only). No ready view returned to loading. The original selected route was restored. These samples measure candidate-owned views; the older adapter continued managing the existing five panes.

| Run | Synchronous call | Executed receipt | Input/composer confirmation |
| --- | --- | --- | --- |
| First, three switches | 0.2–1.2 ms | 0.4–1.5 ms | 374.8–1,778.9 ms |
| Second, three switches | 0.2–1.1 ms | 0.4–1.2 ms | 362.7–776.9 ms |

Both runs passed actual route/input ownership checks and retained all candidate transcript identities. The final committed latency is **not yet satisfactory for the requested seamless experience**. The mixed setup retained the old adapter's five-pane route rebinding; the source-level evidence does not quantify its cost. The subsequent split design selects a bounded number of native bodies and a single logical input, with independent consumer, Adapter and Core measurements. Native draft handoff is still unresolved. These historical measurements do not establish end-to-end latency, the current client state or publication of the candidate.

Reports: `.artifacts/workspace-seamless-probe/consumer/report-first.json` and `report.json`. The temporary provider and consumer were removed through supported CLI in reverse dependency order. Cleanup receipts and final runtime evidence are beside the reports. The standalone toolbar/style inspection was also removed.

## Style finding

The same native button clone kept Native border/radius in either `#root` or ordinary body, and lost them inside the consumer's Core styled region. The consumer subsequently moved native transcript bodies into a neutral portal and scoped Core UI only around its own controls, confirming the real fix. This adapter copies or overrides no Native stylesheet and changes no consumer CSS. Keep transcript containers outside `[data-codlet-official-ui]`.

## Public sampling

Use [sample-workspace-navigation.mjs](../../../examples/sample-workspace-navigation.mjs) from an already-connected workspace and prepared navigation session. It records synchronous execution, route receipt and native input confirmation separately, plus the current snapshot at each receipt. Run it from the consumer's selection flow; it intentionally performs the requested native navigation. It uses public APIs only.

Regression includes ticket ownership/retirement, raw/action tooltip isolation, overlay lifetime, transcript identity/scroll reuse, ready-state preservation, synchronous cached navigation, wrong input ownership, invalid/aborted calls, delayed cold read cancellation, queue deduplication and idle observer disconnection, in addition to existing adapter tests. Exact test counts and candidate hashes are in the handoff file.
