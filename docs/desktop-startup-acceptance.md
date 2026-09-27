# Isolated Windows desktop startup acceptance

This developer harness reuses the production Core's plugin preparation, Host and
renderer executors, native restart bridge, management loop and shutdown. Only
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

Run `node scripts/desktop-acceptance.mjs <absolute-config.json>` in an owned hidden
PowerShell helper created with `Invoke-CommandInDesktopPackage`, specifying
`-PackageFamilyName OpenAI.Codex_2p2nqsd0c76g0 -AppId App -PreventBreakaway`.
Keep the coordinating shell alive until `root/completed.json` appears; redirect
helper stdout/stderr to a local log. The helper command should use `-NoProfile
-NonInteractive -WindowStyle Hidden`. Running unpacked Windows client files
without a package context fails before startup.

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

This uses the machine's existing registered package context with selected signed
program files. It does **not** establish new-MSIX installation/update acceptance,
equivalence of the package registration, or acceptance of an existing user profile.
