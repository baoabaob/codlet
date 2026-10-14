# Functional acceptance consumer 0.0.3

Extends the original 0.0.1 UI acceptance plugin. The unchanged original passed
Windows 26.930's basic UI checks; broader coverage required these additions.
The installable plugin is `consumer/`, with ordinary Core/adapter APIs, a native
report page, explicit run button and JSON export. See its README for permissions,
effects and manual boundaries. Ordinary installation never auto-submits a model
turn. Its Windows x64 package can be reproduced with:

```text
node tests/fixtures/runtime-compatibility/package.mjs ABSOLUTE_OUTPUT_DIRECTORY
```

## Owned desktop run

Build Core's opt-in `codlet-desktop-acceptance` binary and use the Core runner
`scripts/desktop-acceptance.mjs` with a new absolute `root`, verified official
`clientApp`, four-component `packageVersion`, `pluginsRoot`, and `testBinary`.
Supply this absolute `consumer` path in `extraPlugins`. Generate the probe first:

```text
node tests/fixtures/runtime-compatibility/build-probe.mjs ABSOLUTE_PROBE_JS
```

Pass that file as `probeScript`; configure `localApiKeyFixture: true`,
`ownedBackend: true`, `functionalTestAuto: true`, `foreground: true`,
`fixtureResponseDelayMs: 1500`, and a sufficient `durationSeconds` (110–180).
The fixture needs `extraPluginPolicies: {"compatibility.acceptance":
{"clientPermissions": true}}` for its declared OS categories. Use
`fixtureWebSocket: false` for HTTP/SSE and `true` for Responses WebSocket.
`lifecyclePlugin: "compatibility.acceptance"` invokes the same exact test binary's
scoped public CLI after completion, snapshots the functional report, and audits
reload/disable/enable plus Host cleanup. It does not self-disable through RPC.

The probe allocates one synthetic local task through the already mounted Native
connection, waits for one seed turn to persist, then lets the plugin use public
task-open/read/write/events and submit APIs. No alternate app-host connection or
Native factory is created. It registers the owned model interceptor before that
task opens a WebSocket, since a later registration cannot retroactively change
an existing connection. Failed/unknown writes are never automatically retried.

Complete synthetic onboarding via `fixtureState` if the fresh client needs it.
For the accepted Windows 26.930 run, the observed `electron-persisted-atom-state`
included the completed conversational onboarding, role `engineering`,
`workMode: "coding"`, completed projectless onboarding, and composer mode `work`.
These are fixture preferences, not changes to the daily client.

Require a completed report with 14 Renderer and 10 Host checks passed, no fixture
error, both native sources activated, ready runtime skill, zero plugin errors and
normal shutdown. Also require `lifecycle.json.passed` when lifecycle auditing is
requested; after re-enable, the live probe should have one owned navigation
entry/report node and no leftover composer leases. Preserve the report before
reload because the live plugin starts with an empty report. Merely enabling a
plugin or reporting source activation is insufficient.

The Windows `26.930.2377.0` / frontend `26.930.21537` / build `12776` / backend
`0.159.0-alpha.12.1` fixture passed both protocols with Desktop Adapter 0.2.7 and
UI Adapter 0.1.10. The startup worker regression required consuming the Adapter's
own inspector argument and filtered native worker defaults. Live OAuth, new
MSIX installation, native dialogs/clipboard/notifications/shortcuts and other
platforms are not established by these synthetic checks.
