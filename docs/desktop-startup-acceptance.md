# Isolated Windows desktop startup acceptance

This developer harness reuses the production Core's plugin preparation, Host and
renderer executors, package-aware child creation, native restart bridge,
management loop and shutdown. Only
package discovery, process conflict checks and the legacy global status listener
are replaced by an explicitly selected, newly owned test child and isolated
registry listener. It does not attach to an existing desktop. It is excluded
from release builds and must not be used as an installed launcher.

Build `cargo build --locked --features desktop-acceptance --bin codlet-desktop-acceptance`
and stage the pinned Node runtime beside the debug executable as for the existing
Host tests. Do not combine this feature with `test-fixtures`: those fixtures
reserve the official plugin IDs and are not the real plugins.

Prepare an absolute-path JSON configuration:

```json
{
  "root": "C:/work/codlet/.codlet-artifacts/new-desktop-test",
  "clientApp": "C:/work/reviewed-msix/unpacked/app",
  "pluginsRoot": "C:/work/codlet-plugins",
  "testBinary": "C:/work/codlet/target/debug/codlet-desktop-acceptance.exe",
  "packageVersion": "26.924.2738.0"
}
```

`root` must not exist. The signed client and bundled official CLI must come from
the reviewed package matching `packageVersion`; the coordinator verifies their
OpenAI Authenticode signatures. `pluginsRoot` explicitly selects trusted official
plugin source. Their declared permissions are granted only in this new registry.

Run `node scripts/desktop-acceptance.mjs <absolute-config.json>` from an ordinary
unpackaged shell. The harness rejects a creator that already has package identity:
pre-supplying a package context hides defects in the installed launch path. Keep
the coordinator alive until `root/completed.json` appears. Core must detect a
missing/wrong child identity itself, activate its short-lived package helper and
transfer only its owned CDP/stderr handles. No permanent helper remains.

The optional `rawLaunch: true` diagnostic control deliberately skips this repair.
It reproduces the old launch path and is expected to fail if the selected program
does not acquire package identity. It is not a production launcher setting.

The coordinator creates fresh user-data, Codex, Codlet, SQLite and temporary
directories, file-only authentication, and a dedicated loopback app-server. It
verifies the listener belongs to the exact child before initializing WebSocket
RPC. It never copies account credentials or uses the normal desktop's backend.
The ordinary app-tools bridge is disabled in the test backend. Close only the
owned test child and backend; never use a process-name kill or close the daily
desktop. No package is registered or updated by this harness.

Inspect `verdict.json`, `status.json`, `core.err.log`, `dom.json` and
`desktop.png`. A rendered login page proves startup and rendering, not signed-in
conversation behavior. Plugin-reported errors are recorded separately; a Core
ready flag or an executor's active state alone does not prove a usable GUI.
Shutdown must return the owned client's real exit code, rather than treating
CDP EOF as immediate process exit. An observer deadline fails the test and
cleans up its owned child; it does not turn failure into success.

`client.json` records the unpackaged creator and the resulting child family.
This uses the machine's existing registered package context with selected signed
program files. It does **not** establish new-MSIX installation/update acceptance,
equivalence of the package registration, or acceptance of an existing user profile.

## Production package handoff

Core creates the client suspended and verifies the full registered package name
before resuming it. A mismatch retires that exact unstarted process. A same-build
helper is then activated in the selected package via Windows DesktopAppXActivator
(v2, with v1 fallback). This is an internal Windows COM contract, checked at
runtime; unavailable interfaces and policy rejection are surfaced, not bypassed.

The transaction uses a random, current-user-only local named pipe, exact owned
helper PID/creation time, and mutual executable/user checks. The helper duplicates
only the selected inherited handles from the live Core. Environment and working
directory are transferred in memory; they are not written to a request file.
The child is held suspended until Core verifies its image, full package identity,
PID, creation time and thread ownership. Failure before commit retires the owned
child. Normal successful handoff leaves Core owning the client's native handles.

Only the immediate official child receives `DESKTOP_APP_BREAKAWAY_OVERRIDE`.
The helper is not activated with a force-entire-process-tree policy: unrelated
shells and child applications must retain Windows' normal breakaway behavior.
Core and plugin hosts remain outside the official package. The helper exits after
handoff; no Node service or PowerShell process is added to the installed startup.
