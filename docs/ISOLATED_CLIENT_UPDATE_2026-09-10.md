# Independent client update — 2026-09-10

The independent manual-test client now uses installed Windows package
`OpenAI.Codex_26.903.8094.0_x64__2p2nqsd0c76g0` and the current M2 plugin runtime.
It reuses the existing authenticated profile at
`C:/Users/cccake/.cache/codlet-lab/20260908-acceptance-a`.
No production login/profile was copied. GUI and plugin feature testing remain
with the user; the checks here cover preparation, runtime wiring and lifecycle.

## Delivered entrypoints

`scripts/Build-IsolatedClient.ps1` creates a separate directory containing the
matching `codlet-lab.exe`, pinned Node runtime, coordinator, configuration,
start/stop/plugin commands, usage guide and the hide-usage-banner source package.
The official CLI stays in its installed location and is selected by an explicit
path and SHA-256. The normal production distribution and launcher are unchanged.

`Start-TestClient.cmd` starts a hidden coordinator, verifies a new loopback
backend, then launches one visible official development client. It selects the
latest closed report; a live or incomplete prior run is rejected by the native
root lease and receipt checks. `Stop-TestClient.cmd` sends a fixed quit-file
signal to that run's coordinator. The coordinator sends the original native
application quit request through its retained lab stdin, waits for Desktop and
Codlet exit, then stops its retained backend process. It never selects a process
to terminate by name or controls an existing backend.

`Test-Plugins.cmd` accepts normal plugin commands, with explicit trust/grants.
Its child environment selects only the lab registry. The native entrypoint checks
the marked root, directory ancestry and resolved registry scope before forwarding.
Only the exact matching lab executable/user can use the private control pipe.
The lab does not publish production discovery/status. The offline fallback retains
the ordinary CLI's conservative checks for older Codlet owners.

## Runtime changes

- The lab prepares the same M2 catalog and Host/Renderer execution plans as normal
  Codlet, before creating Desktop.
- After the actual startup gate, it starts Host RPC, OS brokers and public
  `runtime.manage@1`, then attaches managed renderers with shared entry readiness.
- The foreground loop drives `HostControl`, permission revocation, dependency
  retirement, management receipts and lifecycle observations. Stdin, GUI and the
  private CLI share one broker; no plugin source watcher is enabled.
- Shutdown retires managed renderers, joins Host resources and OS workers, and
  records the result before CDP teardown. An explicitly failed plugin cleanup
  prevents a later resume.
- Resume accepts exact package identity or the specifically reviewed x64
  `26.901.6511.0 → 26.903.8094.0` transition. It retains closed-process proof,
  the latest-report rule, configuration snapshots and metadata-only auth checks.
- A new official Node cache key gets a new version directory. The old cache and
  existing test account/history remain in place.

## Installed-build audit

The installed archive was extracted only as data into ignored local research
artifacts. No installed code, package asset or shortcut was edited.

| Compiled module / anchor | Confirmed behavior |
| --- | --- |
| `bootstrap-DLA2e4cG.js`, `w`, user-data setup before single-instance lock | Explicit Electron test profile is selected before the lock. |
| `main-C8LNyWut.js`, `registerIpcClientForWebContents` | Fixed desktop IPC construction still requires the local transport to be stdio. |
| `main-C8LNyWut.js`, `F5/I5`; `src-J2PvP4xj.js`, `sH` | The explicit WebSocket URL selects the WebSocket transport. FORCE_CLI remains excluded. |
| `file-based-logger-CundK_TU.js`, flavor/updater controls | Development flavor and disabled updater flags remain effective. |
| `main-C8LNyWut.js`, `pr/mr`, Chrome candidate filters | All 26 retained override keys remain valid; browser/Chrome and computer-control paths stay disabled. |
| `main-C8LNyWut.js`, shell hydration and SQLite guard | Guarded system PowerShell is still required; explicit SQLite home skips legacy reconciliation. |
| `main-C8LNyWut.js`, trusted `quit-app` handler | The fixed message invokes application quit without relaunch. |
| `window-all-closed-BKkx4ypf.js`, protocol registration | Windows still returns before protocol registration. |

The official CLI has a valid Authenticode signature and reports `codex-cli 0.153.4`.
Its SHA-256 is
`CCDC9EB9DD71FBCFB03AD42C4ECA2B0D6FF6FBD32EBE9416550E6244561E559B`.
The exact CLI generated local protocol schemas; the coordinator uses
`plugin/installed` without install suggestions to check existing Chrome state.
OpenAI's [App Server documentation](https://learn.chatgpt.com/docs/app-server)
describes the public initialize/initialized and WebSocket transport model.
Desktop-private isolation still depends on the installed-build audit and actual
startup checks, rather than that public API documentation alone.

## Verification

- All **25 lab tests** passed, including reviewed upgrade, cache preservation,
  local catalog preparation, private control readiness, profile/lease checks,
  bounded input, shell validation, startup evidence and quit handling.
- Clippy over all targets/features with warnings denied passed. The release lab
  executable and Node coordinator syntax checks passed.
- One real resumed test launch passed development flavor, disabled updates,
  loaded shell environment and initialized local WebSocket checks. The backend
  confirmed the existing account was authenticated, credential storage was file
  based, sandbox mode remained read-only, Windows readiness was ready, no Chrome
  plugin was installed, and a foreign Origin received HTTP 403.
- A real online command to keep the local hide-usage-banner plugin disabled
  returned one completed receipt from the expected private registry scope.
- Fixed quit completed with Desktop/Host exit 0. The recorded Desktop, Codlet,
  coordinator and backend were gone, and its listener was absent.
- A second resumed launch passed the same checks and was left running for manual
  testing. Both original daily process identities (Desktop and App Server)
  remained unchanged.

The hide-usage-banner example is registered only in the retained test registry
and left disabled. These runs did not click through its feature behavior or send
a model turn. Host/combined functionality uses the already verified M2 engines;
this update's real-client check does not claim a separate GUI acceptance matrix
for every local plugin. The backend retains the earlier restricted test settings;
directory/environment separation does not sandbox trusted Node plugin code.

See [the current harness contract](ISOLATED_CLIENT_TESTING.md) for startup,
recovery and profile rules, and [M2 acceptance](M2_ACCEPTANCE_2026-09-10.md) for the
underlying executor/RPC/broker evidence.

