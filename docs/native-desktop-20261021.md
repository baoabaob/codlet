# Native Desktop 20770 / 21161

Core 1.0.0-rc.13 repairs the first-start preparation, permission discovery and
Working-state projection used by Split Workbench 1.0.0-rc.3.

The installed rc.12 runtime log recorded Split Workbench activation failing with
`Waiting for the existing Desktop app-host services`. The consumer now uses
`compatibility.waitReady` while the provider reports initialization. Workspace
and permission preparation retry transient missing-service/export states with
bounded backoff, clear rejected readiness caches, and cancel with their owner.
Ambiguous or incompatible interfaces remain errors.

Permission scopes and reducers are exported across both `app-shared` and
`app-initial`. Discovery now uses the union of those modules and deduplicates
aliases by object identity. The Full Access warning classifier is distinguished
from the separate `daybreak-red` classifier by its parsed function body.

| Native app / build | Store package | Response | Pending input | Publication |
| --- | --- | --- | --- | --- |
| 26.1013.40934 / 20770 | 26.1013.4894.0 | Sbn | nbn | oZ |
| 26.1016.51333 / 21161 | 26.1016.6573.0 | NCn | pCn | JQ |

The selectors preserve the reviewed response/owned-work, blocking versus
asynchronous input, and publication projections. Their normalized declarations
match across these two snapshots. Runtime loading still requires the exact
asset pair, the existing mounted AppScope and live selector contracts.

`scripts/native-desktop-analysis.mjs INDEX_JSON NEW_ABSOLUTE_REPORT_JSON`
verifies snapshot and file hashes, four scope exports, eight permission functions,
and three Working selectors. The selectors must resolve to the AppScope binding
and match their reviewed normalized declaration shapes. Reports are saved as
`native-desktop-20770.json` and `native-desktop-21161.json` beside this document.
This check executes no Native modules and does not establish live UI behavior.

Unchanged composer and titlebar reconciliation now performs zero DOM writes in
the 60-frame regression cases. Hidden-document workspace updates yield through
a task queue after the initial microtask, allowing Native input tasks to run.
Split popup containers have zero area until visible controls occupy them, and
pointer cancellation only affects its matching gesture.

Validation: Core frontend 422 passed / 2 skipped; Split Workbench 153 passed.
The live Core was not running at the final pre-installation status check. Native
drag latency, operating-system titlebar hit testing, and the installed-client
permissions workflow still require acceptance after updating both packages.
