# Isolated Client Experiment Evidence

Captured: 2026-09-07. Audit baseline: `master 42725d6`. This document records a read-only source audit and a constrained experiment recipe. It does not record a successful client launch, login, injection, or isolation acceptance test.

The coordinator subsequently performed one real launch. Its [separate results](ISOLATED_CLIENT_RESULTS_2026-09-07.md) record successful inherited-CDP/renderer activation, a failed shell-environment gate, and a client that remained alive after `Browser.close`. Those observations do not turn this source audit into an isolation or production acceptance result.

## Decision

**Do not start a second ordinary Windows Codex instance beside the existing one using only a different `CODEX_HOME` and Electron `userData`.** The inspected build opens a fixed machine-level desktop IPC pipe before login. That router carries conversation operations, not just harmless presence notifications.

A narrower experiment has a source-supported route: the same official binary, `BUILD_FLAVOR=dev`, an explicitly owned fresh App Server on loopback WebSocket, fresh data/home/cache directories, a guarded explicit Windows PowerShell executable, and disabled browser/automation/capture features. The WebSocket transport skips the identified desktop IPC constructor. Development feature overrides suppress the identified Chrome native-host registration path. This route is for **unsigned-in GUI/renderer smoke testing only**, and is different from normal production deployment. The coordinator must establish the runtime conditions below before attempting it; this audit did not start any process.

## Evidence Scope

- MSIX identity was confirmed using read-only package metadata: `OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0`.
- Archive: `C:/Program Files/WindowsApps/OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0/app/resources/app.asar`.
- Previously recorded archive SHA-256: `E75BAE2B8A02F174C7CEEED6D631AAFF355E44F8AF5C798FA3628089F11D659E`.
- Package application version: `26.901.51231`; `package.main` is `.vite/build/early-bootstrap.js`.
- Compiled main-process modules were extracted as data using the existing `@electron/asar.extractFile` and `node:path.join`, into the external research directory `C:/Users/cccake/Documents/ChatGPT/codlet-research/ui-adapter-26.901.6511.0/`. No package JavaScript was executed. No official code or assets are included in this repository.
- File references below are relative to that archive unless otherwise stated. Long minified lines contain multiple functions; function names are retrieval anchors for this exact build, not public APIs.
- A pre-existing official public source archive at commit `8d32abc` was consulted for CLI credential-storage semantics. Its relevant `codex-rs/login/src/auth` files were extracted outside the repository. That reference is **not proven to be the exact source of the installed CLI binary**.
- The coordinator reported a materialized official CLI at `C:/Users/cccake/AppData/Local/OpenAI/Codex/bin/8e5b6932251c2c1c/codex.exe`, version `0.153.4`, and its `app-server --help` support for `--listen ws://IP:PORT`. This audit did not execute that binary; launch/transport validation belongs to the coordinator.
- No production auth file, secret configuration, environment secret value, browser profile, or running Codex process was read or controlled. The supplied production PID is not an authorization target and is not used in this recipe.

## Why Ordinary Double-Directory Startup Fails Isolation

### Bootstrap and Single-Instance Lock

`.vite/build/early-bootstrap.js:1` loads `bootstrap-Bs1h9muX.js`. In `bootstrap-Bs1h9muX.js:1`, function `w` resolves a non-empty `CODEX_ELECTRON_USER_DATA_PATH` before using the normal application-data path. Line 134 calls `app.setPath('userData', ...)` before requesting the single-instance lock. This supports a distinct Chromium user-data directory and lock input; it does not namespace all application services.

`window-all-closed-KNH8jchn.js:7`, `TD`, returns true for packaged non-macOS builds regardless of the explicit data path. The Windows application still requests a lock. The audit does not assume that passing a new directory alone proves independent ownership; the runtime harness must verify the process and its effective data path. The bootstrap also explicitly requires the Owl app shell. Stock Electron is not a substitute for the official executable.

The demo launcher in `main-DpnWwRdP.js:609` invokes macOS `open -n` with separate data paths. It is not evidence of a Windows isolation guarantee.

### Fixed Desktop IPC and Login-Independent Construction

`src-VqXTPopo.js:1192`, `f9`, returns `node:path.join('\\\\.\\pipe', 'codex-ipc')` on Windows. There is no home, account, profile, PID, or flavor suffix. On other platforms this function uses `CODEX_HOME/ipc`; that other-platform behavior must not be applied to Windows.

The same line contains the router/client implementation:

1. `IpcClient`'s constructor immediately calls `connect()`.
2. `getOrStartRouterEndpoint()` attempts to host the fixed pipe; an in-use error is treated as another router being active. The client connects to the returned pipe regardless of which process owns it.
3. `initialize` records a random client ID, the supplied client type and the socket. It does not register a `CODEX_HOME`, Electron data path, account or authenticated principal.
4. Broadcasts fan out to other clients, optionally filtered by client IDs. Requests use an explicit target or discovery across other clients, with the first willing handler selected.
5. `Tde` registers thread-owner discovery and follower operations including start, steer and interrupt turn, edit last user turn, settings changes, approval decisions and submitted user input. Handler eligibility uses host/conversation ownership and method version. The local host identifier can be omitted; it is not a test-profile namespace.

`main-DpnWwRdP.js:1295`, `registerWindow`, calls `registerIpcClientForWebContents`. That function constructs `new IpcClient('desktop', ...)` whenever the local transport is `stdio` and the window is not already registered. It has no login check. `src-VqXTPopo.js:704` initializes the stdio transport's `kind` to `stdio` in its constructor; line 705 returns it directly from `getTransportKind()`. Main startup (`dze`, line 1526) creates/registers the initial window through `ensureWindow`; the IPC path therefore does not wait for account login or a successful authenticated turn.

Searching all extracted `.vite/build/*.js` found the desktop constructor at that guarded location and the router/client implementation in the shared module. No supported environment variable to disable or rename this desktop pipe was found. This is scoped to the inspected code, not a claim about every native dependency.

**Consequences:** an empty login screen is not enough to make stdio startup safe beside the production instance. A different Windows account also does not change the fixed pipe name; no ACL isolation was established by this source audit. A separate-kernel VM would separate this pipe namespace, but is not an already-available launch plan on this machine. The coordinator reported no ready Windows Sandbox/VM tooling; enabling virtualization or constructing a VM is outside this work.

## Dedicated WebSocket Route

`main-DpnWwRdP.js:1295`, `P5`/`F5`, selects a WebSocket transport from `CODEX_APP_SERVER_WS_URL` through `src-VqXTPopo.js:703`, `gH`. `CODEX_APP_SERVER_FORCE_CLI='1'` overrides it back to stdio and **must not be set for this experiment**. `hH`'s constructor sets `kind='websocket'`. The `registerIpcClientForWebContents` stdio condition therefore returns before constructing the fixed-pipe client.

This is a real transport change, not a cosmetic setting. It must point only at an App Server started and owned for this exact experiment, never at an inherited address or existing production server. The local connection's token requests, configuration writes and thread access then go to that server. The inspected local selection code does not silently fall back from the selected WebSocket transport to a new local stdio service; connection failures must be treated as failed experiment preparation, not a reason to retry with `FORCE_CLI`.

The WebSocket class can accept handshake headers/protocols through an optional callback. **The standard local `P5` branch passes that callback as `undefined`.** No supported bearer-token environment/argument channel was found for this desktop route. Do not invent a header variable, put a credential in the URL, or assume that CLI `--ws-auth` can be enabled without a compatible desktop handshake.

The coordinator's planned `--listen ws://127.0.0.1:<fresh-port>` must bind only loopback, with ownership checked against the new server process. A random loopback port is not authentication. Until a compatible authenticated handshake is demonstrated, the test server must contain no account token, production sessions, files or workspace access. Do not open an external page or allow unrelated tools to use that port. Server Origin checks, optional token enforcement and actual listener behavior require the coordinator's protocol test; this source audit did not claim them verified. Do not use `0.0.0.0`, a LAN address, port forwarding, or a production endpoint.

## Environment Restoration and Development Flavor

### PowerShell Profiles Can Defeat an Initially Clean Environment

`main-DpnWwRdP.js:471` loads an interactive shell environment and merges it with `Object.assign(process.env, userEnv)`. If an explicit Electron data path was present when the module loaded, only the original `CODEX_HOME` is explicitly restored after this merge. The code does not similarly pin the WebSocket URL, build flavor or API-key variables.

`src-VqXTPopo.js:683`, `PR`/`GR`/`kR`/`VR`, explains the Windows behavior:

- A `SHELL` whose basename is `powershell`, `powershell.exe`, `pwsh`, or `pwsh.exe` is selected directly before PATH discovery.
- Otherwise the resolver searches for PowerShell, which can select the user's PowerShell 7 installation.
- Interactive PowerShell invocation uses `-NoLogo -Command`, **without `-NoProfile`**.
- If the selected shell fails, the resolver can try fallback shells. An experiment must not accept that fallback as equivalent to its guarded shell.

The coordinator identified an applicable PowerShell 7 user profile, without reading its contents. The bounded alternative is an explicit system Windows PowerShell path and a preflight proving that all four of that executable's `$PROFILE` paths are absent. The paths must be obtained with that same executable using `-NoProfile`, not guessed from `USERPROFILE`, because Windows known-folder resolution can differ. The coordinator reported absence checks in progress; this document does not substitute a historical existence snapshot for the guard on each run.

Before launch, check profile absence under the actual intended child environment, including redirected home variables. Abort preparation if any profile exists, the shell is not the selected system executable, or the probe fails. Do not inspect, delete or alter those profiles. Require the shell-environment load to succeed and retain the expected WebSocket/flavor/directory values; if it fails or selects a fallback, stop the test child. This is a machine-specific guarded path, not a general claim that setting `SHELL` suppresses PowerShell profiles.

### Source-Supported Development Controls

`file-based-logger-DhdrY1cq.js:1` resolves a valid `BUILD_FLAVOR` environment value before package metadata. `src-VqXTPopo.js:66` defines `Dev='dev'` and validates it. Windows distribution resolution only maps `prod` plus the beta package identity to `public-beta`; it leaves `dev` intact. Setting the environment does not require changing or replacing the package.

`main-DpnWwRdP.js:8` applies `CODEX_ELECTRON_DESKTOP_FEATURE_OVERRIDES` only in `dev`, with a strict partial schema of known feature fields. Overrides are spread after incoming feature values. Line 1526 applies the override early through `Dr(Or(...))`, and later feature updates also call `Or` before passing their result to bundled-plugin reconciliation. This makes the selected false values effective both initially and after renderer updates. The environment must survive shell restoration for that statement to remain true.

## Chrome Registration, Other IPC, and OS Resources

The important shared write was traced to a concrete startup path:

- Main line 103's bundled-plugin table includes Chrome, Chrome Dev and Chrome Internal, each requiring `externalBrowserUseAllowed`. They are filtered through `isAvailable` before reconciliation.
- Main line 38 can synchronize installed Chrome extensions with bundled plugins and invoke the native-host registrar; this is not exclusively a manually invoked install command.
- `src-VqXTPopo.js:709`, `IX`/`rZ`/`hZ`, writes native-host manifests under `os.homedir()/AppData/Local/OpenAI/extension` on Windows. Line 710, `RZ`, runs `reg add` under `HKCU\Software\Google\Chrome\NativeMessagingHosts\<native-host-name>`.
- Redirecting home variables isolates the files, but **does not isolate HKCU**. Registering a test manifest there would affect the current Windows user's Chrome integration.

With the development override `externalBrowserUseAllowed=false`, all three Chrome candidates are excluded from that reconciliation list. With a new server home containing no installed plugins, the disabled-installed-plugin cleanup list is also empty (`No`, main line 38, returns immediately for an empty list). These are necessary conditions for the no-login experiment. Disabling an already installed Chrome plugin, importing settings or using a reused home is not an equivalent preparation. No plugin install/uninstall/sync or browser operation is authorized as part of this audit recipe.

Other identified resources have narrower implications:

| Resource | Observed behavior and experiment constraint |
| --- | --- |
| Windows protocol registration | `window-all-closed-KNH8jchn.js:7` returns early on Windows before `setAsDefaultProtocolClient`. The inspected JS startup does not re-register the Windows application protocol. OS/MSIX registration during install/update is a separate concern. |
| Application updater | `file-based-logger-DhdrY1cq.js:1` checks `CODEX_SPARKLE_ENABLED==='false'` before platform updater eligibility. Use that exact value; do not trigger any update action. |
| Primary runtime update polling | `main-DpnWwRdP.js:1066` returns from polling when `BUILD_FLAVOR==='dev'` and `CODEX_ELECTRON_PRIMARY_RUNTIME_UPDATE_MODE==='manual'`. This does not mean a manually requested install would be isolated or permitted. |
| Browser-use pipes | Main lines 8/110 use a common `codex-browser-use` prefix plus a random UUID for each server. Chrome discovery enumerates that prefix and filters by extension/build, not by test data directory. Do not invoke browser discovery, tab mentions or external browser actions. |
| Dynamic app-tool pipe | Main line 1526 creates a native app-tool endpoint with a generated path and overwrites the child process's tool-pipe environment value. It is not the fixed desktop router. Windows peer authorization for that endpoint is not account authentication; do not connect an unrelated client. |
| Computer-use helper pipe | Main line 26 generates `codex-computer-use-<UUID>` by default. Clear inherited `SKY_CUA_*` and `NODE_REPL_*` transport settings; the experimental feature configuration disables computer use. |
| Global shortcuts | Main line 112 uses OS-global registration. The pet shortcut is gated by `w7` on line 1513; setting all three access flags false keeps that path disabled. Global dictation/hotkey-window/realtime-voice commands have no default OS bindings in the inspected command table (`src:759`). Quick-chat/capture features stay disabled, and no production keymap/settings are copied. Runtime registration conflicts are a test failure, not a reason to unregister or close the production app. |
| Remote-control device keys | Main line 1238 wraps a native OS device-key addon; it is not scoped solely by a filesystem directory. Do not enroll, sign in, connect a remote host or import enrollment state. Empty test state supplies no existing enrollment/key ID. |
| Authentication callbacks | Main line 1077's remote enrollment login can bind localhost ports 1455/1457. This occurs in the login flow, not as a required GUI smoke step. Stop at sign-in and notify the user; do not initiate login. |

## Credential and Storage Boundary

The inspected desktop code obtains account tokens through its App Server's `getAuthStatus` RPC (`src-VqXTPopo.js:705`). Its token cache is an instance field in that process. Main line 475 reuses that cache or requests the token from the same connection. No direct `keytar`, `safeStorage` or `auth.json` credential loader was found in the extracted main-process JavaScript. This negative finding does not prove that native CLI/Chromium components have no OS storage behavior.

The public reference at `8d32abc` provides narrower affirmative evidence:

- `login/src/auth/storage.rs:154`, `:195` and `:518`: file mode reads only the supplied Codex home's `auth.json`; missing file returns no credentials. `File` selects `FileAuthStorage`, while `Keyring`/`Auto` select other implementations. File mode does not fall back to the shared system keyring.
- `login/src/auth/manager.rs:1456`: enabled `CODEX_API_KEY` takes precedence over stored auth. `CODEX_ACCESS_TOKEN` is also considered before persisted storage. File mode alone does not neutralize inherited environment tokens.
- Main's installed source line 670 also exposes `OPENAI_API_KEY` directly from its process environment.

Therefore an empty, newly created server home plus `cli_auth_credentials_store = "file"` is the defensible credential-store setting for this experiment, provided it is effective in the actual CLI. It is not a complete isolation switch. The actual server's account result must be unauthenticated before attaching the desktop. An unexpected authenticated account is a failed preparation: do not read/copy its token, call logout/revoke, or continue UI actions.

Electron `userData`, browser persistence, Statsig state and language-server data use the chosen app data path in the observed main paths (lines 1044/1295). Logs use `LOCALAPPDATA` on Windows (`file-based-logger:1`); some caches/native-host manifests use `os.homedir()`. Set both sets of locations to the fresh root. An explicit `CODEX_SQLITE_HOME` also prevents the startup SQLite reconciliation branch at main line 121 from searching/reconciling legacy state. The WSL stdio path sets a Linux SQLite location independent of the Windows home (`src:704`); WSL is excluded from this experiment.

Chromium cookies and persistent session partitions must be verified to reside under the fresh Electron profile. Do not copy browser/ChatGPT cookies, import Chrome, or bootstrap authenticated webviews. The inspected authenticated webview path itself takes a token from the App Server; this is another reason not to attach an existing backend.

## Minimal Prepared Environment for the Bounded Experiment

This is a preparation specification for the coordinator's two-phase harness, **not a launch command**. The parent environment and production process stay unchanged. Build independent child environment maps for the App Server and client from a small OS-runtime allowlist, then add the values below. Prefer this to inheriting and trying to enumerate every possible provider secret. Preserve only needed OS executable-resolution/platform values; do not log their full environment maps.

An allowlist approach excludes inherited `CODEX_*`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, provider-specific credentials/endpoints, `NODE_OPTIONS`, `ELECTRON_RUN_AS_NODE`, `NODE_REPL_*`, browser-auth broker sockets and crash-handler pipe variables. Only reconstruct the specifically justified `CODEX_*` entries below. No Azure or other provider needs to be configured for an unsigned-in GUI test. Use an absolute official CLI/executable path rather than inheriting a custom CLI command or PATH wrapper.

| Value | Prepared setting |
| --- | --- |
| Working directory | Fresh empty experiment workspace, outside any real repository or user task. |
| `CODEX_HOME` | Fresh absolute `<labRoot>/codex-home` for both server and client. No auth, settings, sessions, symlinks/junctions or plugins copied from production. |
| `CODEX_SQLITE_HOME` | Fresh absolute `<labRoot>/sqlite` for both processes. |
| `CODEX_ELECTRON_USER_DATA_PATH` | Fresh absolute `<labRoot>/user-data` for the client. |
| `USERPROFILE`, `HOME` | Fresh absolute `<labRoot>/home`. Keep required OS account identity metadata accurate; this is directory redirection, not a new Windows identity. |
| `APPDATA`, `LOCALAPPDATA` | Fresh `<labRoot>/home/AppData/Roaming` and `.../Local`. |
| `TEMP`, `TMP` | Fresh `<labRoot>/temp`. |
| `BUILD_FLAVOR` | Client: `dev`. |
| `CODEX_SPARKLE_ENABLED` | Client: `false`. |
| `CODEX_ELECTRON_PRIMARY_RUNTIME_UPDATE_MODE` | Client: `manual`. |
| `SHELL` | Client: verified system Windows PowerShell executable, e.g. `C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`, with all four actual profile paths proven absent. |
| `CODEX_APP_SERVER_WS_URL` | Client only: exact `ws://127.0.0.1:<owned-test-port>` of the dedicated new server. No URL credentials. |
| `CODEX_APP_SERVER_FORCE_CLI` | Absent. Never use it as recovery from a WebSocket error. |
| `CODEX_CLI_PATH` | If required by the prepared harness, the verified official materialized executable; never an inherited custom path. Setting it does not replace the WebSocket ownership check. |

Create the test server's own configuration under its new `CODEX_HOME` with `cli_auth_credentials_store = "file"`; confirm the CLI accepted the effective setting and returned no account before connecting the client. An empty file directory by itself is not that confirmation.

The client feature override is the following JSON value for `CODEX_ELECTRON_DESKTOP_FEATURE_OVERRIDES`. These keys are present in the inspected strict schema; do not add invented disable flags:

```json
{
  "codexLocalAccess": false,
  "workCloudAccess": false,
  "workLocalAccess": false,
  "externalBrowserUseAllowed": false,
  "externalBrowserUse": false,
  "inAppBrowserUseAllowed": false,
  "inAppBrowserUse": false,
  "browserPane": false,
  "browserExtensions": false,
  "browserSettingsCloudSync": false,
  "browserUseTinysky": false,
  "computerUse": false,
  "computerUseAutoInstall": false,
  "computerUseNodeRepl": false,
  "cuaPIP": false,
  "appshotsEnabled": false,
  "quickChat": false,
  "sites": false,
  "autoAuthForSites": false,
  "control": false,
  "skysight": false,
  "messages": false,
  "ambientSuggestions": false,
  "ambientSuggestionsFeatureDiscovery": false,
  "artifactSession": false,
  "recordAndReplay": false
}
```

Preparation must resolve and validate every absolute path against the fresh root; detect junctions/reparse points and refuse reuse. Before launch, validate the official executable identity, the owned listener, unauthenticated server state, effective file credential storage, PowerShell profile absence, and that no Chrome plugin is installed in the test backend. Keep a launch manifest with the specific new process identity/start time and allowed artifacts, not a naked PID.

The start phase must keep the WebSocket route, dev flavor and feature values intact after shell restoration. If the backend dies, the settings differ, an unexpected account appears, or a shared registration/IPC path is observed, stop only the manifest-owned experimental processes and report the failed condition. Do not fall back to production settings, a default shell, stdio, a different app-server URL, stock Electron, or a modified package.

## Remaining Gates

The coordinator, not this audit task, owns any subsequent launch, computer-use work and renderer smoke test. No claim is made here that the prepared environment was exercised, that the current Windows user/profile guards passed, or that the official binary can complete startup under these redirected paths. Those are observable test results to record separately.

The experiment stops at sign-in. Login requires notifying the user and separately considering the actual account and device enrollment side effects. External browser/Chrome integration, production-flavor behavior, normal stdio deployment, original session data and updater behavior remain untested. A successful development-flavor WebSocket smoke test would validate that limited scenario only; it is not a production M0 or ordinary deployment equivalence gate.
