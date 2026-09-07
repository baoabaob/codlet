# Isolated Client Runtime Results — 2026-09-07

One independent official Desktop was launched alongside the existing Desktop.
It reached sign-in and both bundled renderer plugins reported confirmed
activation. **The experiment did not pass isolation acceptance or the live GUI
gate:** shell-environment hydration timed out, and graceful close left the
client process resident. No login or model turn was performed.

The [2026-09-08 follow-up](ISOLATED_CLIENT_REPAIR_2026-09-08.md) subsequently fixed
both startup and application-exit failures and verified two fresh runs. This
document preserves the original failed run; GUI and production gates remain open.

## Build and scope

- Official MSIX: `OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0`;
  application version `26.901.51231`.
- Official materialized CLI: `0.153.4`; SHA-256
  `E5AA76D19C7C94E2E9EF9B707D590206A73AC0E97C8DDC8382181242494BEF75`.
  It matched the packaged CLI bytes.
- Source integration: audit `478023e`, harness `c0e8d27`, plus the empty
  redirected Documents-directory fix made during preparation.
- Tested `codlet-lab.exe` SHA-256:
  `B21513C94412C12EE3FF5F6B787B759B7B054F8F53D1164CDC2286C723963F88`.
- Fresh root: `C:/Users/cccake/.cache/codlet-lab/20260907-profile-b`.
  An earlier preparation root, `20260907-profile-a`, was retained after its
  preflight failure; no Desktop was created for that attempt.
- Strategy: official binary, `BUILD_FLAVOR=dev`, dedicated
  `ws://127.0.0.1:61113` App Server, redirected directories, file-mode credential
  storage, guarded system Windows PowerShell and the 26 fixed false feature
  overrides described in the [source audit](ISOLATED_CLIENT_EVIDENCE.md).

The development feature restrictions and WebSocket transport differ from normal
Codlet deployment. Directory redirection is not a same-user security sandbox.
The loopback route rejects foreign browser Origins but has no compatible bearer
handshake established for this Desktop branch. This empty experiment therefore
does not authorize introducing real account credentials into that endpoint.

## Observations

| Check | Actual result |
| --- | --- |
| First root preparation | Blocked before Desktop creation: the absent redirected Documents directory made Windows return two empty PowerShell profile paths. |
| Preparation correction | Creating empty `home/Documents` yielded four absolute profile paths, all absent. No profile or document was copied. |
| Dedicated backend | One listener, `127.0.0.1:61113`, owned by newly started CLI PID `34368`, parent `27664`, created `09:42:43.561172 UTC`. |
| Backend protocol | `initialize`, `account/read` and `config/read` succeeded. Account was null, credential store was `file`, sandbox mode was `read-only`. The same checks passed again after window close. |
| Origin rejection | A WebSocket handshake with `Origin: https://codlet-lab.invalid` returned HTTP `403`, not `101`. |
| New Desktop identity | PID `40024`, parent lab Host `37080`, creation FILETIME `134332478782820533` (`09:44:38.2820533 UTC`), exact installed official executable. |
| Runtime transport | Desktop startup log reported `buildFlavor=dev`, `transport=websocket`, and a successful initialize handshake. Application updater was disabled and primary runtime polling reported manual mode. |
| Inherited CDP | `cdp_connected` at `09:44:45.568 UTC`, initially one eligible target; no TCP CDP listener was used. |
| Bundled activation | `codex.ui.adapter` and `codlet`, version `0.1.0`, generation `1`, both `activation_confirmed=true` and `active=true`. A short-lived second target activated, then ended normally in lifecycle records. |
| Window | A distinct `ChatGPT (Dev)` window, HWND `9046896`, matched the owned Desktop PID. The original `ChatGPT` window remained present. The test stopped at sign-in. |
| Shell environment | **Failed:** startup log reported `Failed to load shell env`, `Timed out after 5000ms`, and `shell environment hydrated ... status=timed_out`. A correct initial manifest does not satisfy the required successful post-start hydration check. |
| GUI | **Unverified.** Owner activation is not a DOM mount or click assertion. Every harness GUI observation retained `gui_mount_verified=false`; menu entry, settings dialog, switches and layout were not accepted. |
| Computer Use | Window discovery/state inspection was possible. The user reported a pointer conflict while connected through UU remote control. Further UI automation stopped and the JavaScript session was reset; pointer recovery itself was not independently verified. |

The Desktop wrote its own fresh configuration entries, including a disabled
`mcp_servers.cua_repl` entry. The fresh backend's installed-plugin directory
remained absent. No production auth, configuration, sessions, browser state or
workspace files were imported. The initial backend attempt with
`approval_policy="untrusted"` was rejected by CLI `0.153.4` before listening;
the actual run omitted that unsupported override and kept `sandbox_mode="read-only"`.

## Close and cleanup

At `09:50:34.537 UTC`, the coordinator sent one `quit` line to the exact lab Host.
It issued `Browser.close` through the inherited pipe and received a response.
The window disappeared and its renderer session ended, but PID `40024` and its
helper processes remained alive without a main window. This is a failed
graceful-exit check, not a successful shutdown.

The coordinator rechecked that the dedicated backend was still unauthenticated,
then stopped that backend through its retained PTY. After revalidating the test
client's handle, creation FILETIME, parent, executable and absent main window,
the coordinator terminated only that owned test process tree. The lab Host then
reported `child_exited` with code `4294967295`, reaped its CDP workers and exited
nonzero. No automatic force-termination behavior was added to Codlet or the lab.

The final snapshot confirmed:

- Original Desktop PID `20224` and original App Server PID `26172` retained their
  original executable, parent and creation time.
- All four Chrome native-host registration names and manifest paths matched the
  pre-test snapshot, including `com.openai.codexextension`.
- No recorded test process remained and port `61113` had no listener.
- The fresh test home contained no `auth.json`.

These checks establish the recorded process/registration results. They are not a
full audit of every shared OS resource or proof that no unobserved side effect
was possible.

## Evidence and next gates

Local reports are retained under `.codlet-artifacts/isolated-client-2026-09-07/`:
`before.json`, `backend-identity.json`, `backend-probe.json`,
`backend-probe-after-client.json`, `client-cleanup.json`, `after.json` and the
final Rust check logs. The fresh root retains `logs/report.jsonl`, the child
environment manifest and its own Desktop startup logs. These machine-specific
artifacts are ignored by Git; no official source or credentials are committed.

Repository checks after the preparation fix passed: formatting, Clippy with
`--all-targets --all-features -- -D warnings`, and
`cargo test --locked --all-targets --all-features` (237 passed, 1 external real
Codex gate intentionally ignored). Those tests validate implementation behavior;
they do not override the failed live experiment gates above.

Before another live run, resolve the shell-hydration failure and make its
post-start check automatic, then establish a bounded exit procedure. A separate
authenticated transport/account review is needed before login. While UU is in
use, coordinate any future Computer Use inputs with the user. Full GUI mount,
interaction, narrow-window/theme checks and ordinary production M0/M1 gates
remain open; this result does not close `DEFECT-001` or `DEFECT-002`.
