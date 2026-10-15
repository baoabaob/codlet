# Workspace implementation and acceptance

UI Adapter **0.1.11** adds target capability `codex.ui.workspace@1`. Desktop Adapter **0.2.16** adds `codex.backend.read@1 / threads.loaded` and `thread.summary.changed` events. The stable consumer contract is [workspace-api.md](../workspace-api.md); declarations are in `types/workspace.d.ts`. Layout, persistence, dragging, selection and tooltips remain consumer responsibilities.

## Current native evidence

Acceptance used the running Windows x86-64 client **26.1002.7124.0** with Core **0.2.0-preview.29**, through supported local acceptance registrations and Core-owned CDP sessions. Initial probes retained UI Adapter 0.1.10, Desktop Adapter 0.2.15 and GUI 0.1.9. With explicit user authorization, integration then migrated the two adapters to local sources, installed UI 0.1.11 / Desktop 0.2.16 and exercised the independent split-workbench consumer. The final source migration restores their original GitHub repositories after publishing these versions; release receipts, not this document, establish publication.

The actual current module graph and mounted component ownership established native React factories, the main surface/body/footer, activity placement, ComposerScope, transcript Content, native thread subscription, shortcut capture/row/command hooks and the existing keymap signal. Generated export names and hashes are discovered privately. UIKit's callable source proxies are skipped when inspection is unavailable; role matching still requires unique positive evidence.

Native Content does **not** own the required thread subscription in this client: the subscription sits beside it in Native's own page wrappers. Workspace mounts that discovered component privately. Three simultaneously mounted copies each contained 5,966 conversation-body characters; readiness was not inferred from an empty scroller. Native scroll uses `flex-direction:column-reverse`: `scrollTop=41` clamps to zero and `scrollTop=-41` round-trips, so the API accepts finite signed CSS offsets. Flags preserve the ready state, subscription, providers, scope value, root and scroll node. Native history already dispatched is shared and has no independent abort API; queued work and late commits are cancelled by adapter retirement.

The activity slot, composed suppression/restoration, loaded metadata without history, native shortcut registration and its official settings row all passed. The fixture restored its original route and removed its containers and subscriptions. Native capture/conflict/clear/restore/search behavior also has regression coverage using real React with a deterministic native-shell fixture. The real-client probe verified the actual row and programmatic binding changes; it did not claim full OS accessibility, screenshot/theme or macOS acceptance.

## Performance scope

The main Codex window was brought to the foreground during acceptance. Its backing target `2ECFBB849AAD6E44715AB0FE665072D4` continued to report `visibilityState:hidden`; `Page.bringToFront` did not change that report. Results below measure native commit completion through an owned commit marker, not a claim of foreground paint latency. The final fixture uses no animation-frame timeout as an update-completion substitute.

Earlier 60-second samples came from Chromium throttling chained background timers in the probe. They were removed from operation measurements. Workspace now batches committed semantic events by microtask when the backing document reports hidden and by frame when visible; it uses no recurring timer. Streaming body mutations do not invalidate the workspace structure. An idle observation produced zero workspace revision changes; this is not a claim of zero CPU use by Native or the whole client.

One final native run observed:

| Operation | Measured time / evidence |
| --- | --- |
| Native base discovery at adapter activation | 795 ms, previously about 5,291 ms |
| Initial three transcript mounts | 1,351 ms, including feature discovery and native commits |
| Cached one-transcript mount | 244 ms |
| Flags-only enqueue | 0–0.1 ms |
| Flags-only native commit, 8 samples | 64–170 ms |
| Rebind to another already-loaded thread, waiting for ready | 315 ms |
| Activity slot after synchronous placement | 1 ms |
| Shortcut readiness with native settings discovery | 156 ms |
| 10,000 cached snapshot reads | 0.4 ms |
| Idle revision changes | 0 |

These are one-machine samples with existing conversation content and simultaneous client work, not general latency guarantees. The fixture report records each sample and source-read timing in `.artifacts/workspace-acceptance/consumer/report.json`. A standalone local parser benchmark on the current formatted shared source (10,325,008 characters) took about 349 ms. The new tokenizer constructs ASTs only for possible CommonJS factories and the export map; it does not construct an AST for Native's unrelated UI functions. It preserves export-relationship and ambiguity validation.

Discovery/modules/connection and history are cached; history starts at most two reads concurrently. Transcript loading state shares one manager listener. Flags across roots are merged into one microtask and scheduled through Native React instead of repeated `flushSync`. Synchronous initial commits are limited to mounting and rebinding. Native providers' own per-view subscriptions and rendering remain Native's responsibility.

## Large-tree integration fix

The first split-workbench integration reported `Desktop tree exceeds the discovery limit`. Its exact trigger was `hostFibers()` in `localConnection()`: this collected the entire root tree before examining any AppScope candidates and rejected more than 20,000 fibers. Workspace called that path on first transcript/shortcut discovery. Desktop's separate 4,096-fiber scope/navigation walks also depended on conversation size or traversal order.

UI and Desktop now share the native navigation landmark's ancestry, bounded to 256 levels. This contains the shell's AppScope and router, without descending into messages or pane trees. React can mix committed alternate parents with reused children: each edge must exist in the parent's actual child list. The search is capped at 512 ancestor candidates and 2,048 child links. Cold/auxiliary documents without that landmark retain the existing bounded fallback; duplicate landmarks, detached/cyclic ancestry and unknown large trees still fail closed. The whole-tree limit was not raised.

Captured AppScope providers are checked against the current root through actual parent/child links. This handles committed alternates and reused children, rejects stale detached providers even when their return links still point at an old root, and preserves the outer AppScope when a route/sidebar unmounts. Steady-state connection checks reread only the two previously verified local families, and Workspace uses the same private ownership check. Desktop also captures the discovered message-transport export bindings rather than enumerating all native exports on every callback. No private fiber, scope or service object is added to the consumer API.

Regression tests construct three simultaneous native panes with **72,008 fibers**. Discovery visits **5 shell ancestors**, and repeated Desktop/Workspace connection checks perform **zero shell rediscovery queries**. The test acquires the public Desktop events ticket, reads loaded summaries and receives native state callbacks while preserving compatibility/navigation availability. Separate checks cover alternate commits, shared children, provider replacement/removal, duplicate landmarks and the bounded fallback.

A read-only follow-up probe on Core PID **48220** passed on the actual mixed-alternate tree. It found **150 shell ancestors**, **4,873 whole-tree fibers**, **7.8 ms** discovery and **889.7 ms** for 1,000 full Desktop identity checks (0.890 ms/check). The backing target reported visible. Electron reported app version `26.1002.52244`, build `13536`, App Server `0.162.0-alpha.2`; the Windows package remained `26.1002.7124.0`. The route had changed since the original size failure and was below 20,000 fibers, so the 72,008-fiber fixture supplies the large-tree reproduction. Evidence and cleanup receipts are in `.artifacts/workspace-discovery-probe/`. The same rebuilt adapters were subsequently installed and the split consumer activated and reloaded successfully.

## Cold transcripts and cached navigation

Background history deliberately leaves an unselected conversation in `needs_resume`. Readiness now requires a committed native scroller and actual conversation body; it no longer waits for `resumed`, which would require selecting the conversation. The existing manager's `loadRemainingTurnItems` completes summary-only content after background history. Read-only panes do not retain active stream interest. These methods remain private adapter details.

The cold probe reproduced two original panes stuck in `loading` despite 3,819/3,987 body characters. Four different unselected conversations with the fix reached ready in **147.5, 427.4, 517.9 and 635.8 ms**, with 1,221–2,641 body characters. Their stream role stayed `none`, resume state stayed `needs_resume`, and the current route did not change. This is a single-device sample, not a latency guarantee or identical-content before/after benchmark. Evidence: `.artifacts/workspace-cold-probe/report.json`; fixture: `tests/fixtures/workspace-acceptance/build-cold-probe.mjs`.

`threads.open` now skips the redundant metadata network request when the existing local manager already confirms the exact thread ID and local host. Uncached identities still use the original read validation. The existing route stamp, cancellation, serialization and identity receipt checks remain enforced. A regression verifies cached navigation makes no native request and returns the confirmed route receipt.

The operation is shared internally by Desktop and an independent native acceptance provider. This allows measuring Core RPC through the real native router without installing another Desktop transport interceptor or replacing its public symbol. On the reported target, two cached warm selections returned `opened` receipts in **684.8 / 540.7 ms**, with **1.8 / 2.0 ms** spent inside the shared operation and **zero metadata reads**; the original route was restored. A later control-only run measured the same capability's read-only metadata RPC at **1.7 / 7.1 ms**. It skipped navigation because a local selected route and two resumed owners were no longer available. The remaining selection delay is therefore associated with the actual switch; these samples do not establish how much belongs to Native rendering or scheduling, and do not promise an instantaneous receipt. Evidence: `.artifacts/workspace-navigation-probe/consumer/report-first.json` and `report.json`.

Before any navigation latency run, the standalone discovery probe inspected both DOM-attached alternates without changing routes. The initially attached side returned to `root.current` but failed actual parent/child ownership; its alternate proved a 150-level path. After the navigation run, a separate read-only probe found the opposite side valid, again at 150 levels. Both actual trees passed connection/navigation discovery. Regression tests also force the case where both raw return chains reach the old root while a reused child belongs to the new root through an alternate parent. This validation does not recover the tree by navigation or client restart.

## Regression checks

The full repository run completed with **270 passed / 4 skipped / 0 failed** (274 tests), before the final focused refinements. The earlier large-tree suite passed 98 tests; after the mixed-alternate, cold-history and cached-navigation refinements, 63 integration tests passed (`.artifacts/workspace-integration-final.log`). The final expanded adapter/workspace/discovery/composer/navigation/distribution run passed **104 tests / 0 failed / 0 skipped** (`.artifacts/workspace-final-adapters.log`). The independent split-workbench consumer previously passed 19 tests. Coverage includes ticket ownership/retirement, restoration, alternate commits, metadata pagination/events, stream filtering, different cold identities, hydration failure/cancellation, history deduplication/concurrency, root/subscription reuse, signed scroll, cached RPC navigation, wrong-host/mismatched identities, shortcut operations and hidden-document scheduling. GUI source was not changed.

## Candidate packages and current registrations

Local review packages are generated by:

```text
node frontend/build.mjs
node scripts/package.mjs --output .artifacts/workspace-candidates
```

Candidate directories are `X:\codlet-plugins\.artifacts\workspace-candidates\packages\codex.ui.adapter` and `X:\codlet-plugins\.artifacts\workspace-candidates\packages\codex.desktop.adapter`. ZIPs and SHA-256 receipts are beside them in `catalog.json`. Build/package validation preserves the IDs and permission sets. Before the coordinating chat's authorized migration, the scoped CLI rejected local previews of the managed IDs with `managed_preview_required: Use a managed update preview to change a managed registration or its grants`; those historical refusals are saved in `local-preview-refusals.json`. A generated catalog's repository/tag fields are not evidence of a published release or of a successful installation of the rebuilt fix.

UI 0.1.11 and Desktop 0.2.16 were installed under the default local `packages/<id>` directories, retaining the original `packages/github` contents. Integration confirmed four real split transcripts, live content, selection synchronized with the native composer, Esc cancellation, reload cleanup and the native shortcut. Source changes use the scoped CLI with the previously granted permissions. Do not copy into managed `packages/github`, edit the registry or fabricate source receipts.

The exact original registration/source/authorization recovery record is `X:\codlet-plugins\.artifacts\workspace-original-registrations.json`:

| Original plugin | Repository | Release / asset | SHA-256 |
| --- | --- | --- | --- |
| UI 0.1.10 | `baoabaob/codlet-ui-adapter` | release 400059473 / asset 600954287 | `0ea659c2bfbb7303d6c5cc7bfb9c8878bd4857646b2fd6570eb8d9bf5de8c5e2` |
| Desktop 0.2.15 | `baoabaob/codlet-desktop-adapter` | release 406585909 / asset 621193874 | `d4808fd1ffc082e4539af349bfa55ef2893c5fcb6684a6c6345fe8fd52e66df1` |

For a still-managed source, supported recovery uses scoped `plugin github preview <repository-url> --release <release-id> --asset <asset-id> --update <id> --json`, followed by `plugin github update <id> <preview.path> --trust --grant <existing-permission> ... --enable --json`. Use the returned preview path and verify its digest. For a registration deliberately migrated to a local source, restoring GitHub requires inspecting the dependency closure, retaining local files, removing/re-registering through supported commands and reusing only the actual previously granted permissions. The user authorized this source migration and adapter publication.

The acceptance runner is built with `node tests/fixtures/workspace-acceptance/build.mjs`. Its temporary IDs are `dev.workspace.audit-provider`, `dev.workspace.audit-consumer` and a read-only `dev.workspace.audit-observer`. Discovery and cold probes use `dev.workspace.discovery-probe` / `dev.workspace.cold-probe`. The navigation probe is built with `node tests/fixtures/workspace-acceptance/build-navigation-probe.mjs`; register its temporary provider before its consumer and remove them in reverse order. All probes are removed after their runs, retaining their local reports. Probes do not reload official registrations; subsequent installation/reload is a separate supported CLI operation. The final navigation/discovery run left both installed adapters at generation 6.

Platform derivation uses the actual navigator identity and Native's effective binding resolver. Windows was tested. macOS behavior is derived, not tested; the existing base adapter support remains, and unfamiliar new workspace structures fail with diagnostics.
