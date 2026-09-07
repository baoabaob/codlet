# Isolated Client Test Harness

`codlet-lab` is a separate, explicitly experimental binary for the source-audited
Windows package `26.901.6511.0`. Ordinary `codlet launch` retains its existing
process-conflict refusal and production status endpoint. The lab has no shared
Host IPC endpoint, no executable override, and no arbitrary CDP/JavaScript command.

This implementation has been exercised with fake children and local directory/
control fixtures, and one official Desktop with its own App Server on 2026-09-07.
The real run reached sign-in and confirmed both bundled renderer activations, but
failed the shell-environment acceptance condition and did not verify the GUI.
`Browser.close` closed its window without terminating the client. See the
[real experiment results](ISOLATED_CLIENT_RESULTS_2026-09-07.md) and
[source audit](ISOLATED_CLIENT_EVIDENCE.md). The coordinator owns the backend
lifecycle and before/after checks; this recipe has not passed isolation acceptance.

## Preparation and start

Use an existing plain local parent directory and an empty or nonexistent leaf
root. The harness does not create missing ancestors or reuse a root from an
earlier attempt. Example command shape (the port is an illustrative placeholder):

```text
codlet-lab --experimental-isolated-client --root C:/Users/cccake/.cache/codlet-lab/20260907-profile-a --expected-package-version 26.901.6511.0 --app-server-url ws://127.0.0.1:49233
```

`--app-server-url=ws://127.0.0.1:49233` is also accepted. The URL must use the literal
IPv4 loopback address, scheme `ws`, a nonzero u16 port, and no path, credentials,
query or fragment. Default stdio, another package version and malformed options
fail with `preflightBlocked`/usage before a Desktop child or lab directory is
created. The package is resolved through current-user MSIX discovery; only that
package's official executable is eligible.

The harness then claims the root, creates fresh configuration, validates the
specified system PowerShell's four profile paths, writes its clean environment
manifest and emits JSONL `prepared` followed by `awaiting_start`. **No Desktop
child exists at this point.** `prepared` reports the Host PID, package/executable,
root, user-data, Codex home, workspace and environment-manifest paths.

The coordinator must now:

1. Read `logs/child-environment.json`. It is a flat JSON object built from a small
   OS-variable whitelist plus fixed lab values, with no copied credentials/proxies
   or production Codex bridge variables. Apply it to the new backend's child-only
   environment (clear inherited variables first), never the coordinating process
   or machine environment. `CODEX_APP_SERVER_WS_URL` is for the Desktop; omit it
   from the backend environment. Desktop flavor/feature settings have no required
   backend role. Keep the directory values, especially `CODEX_HOME` and
   `CODEX_SQLITE_HOME`, identical for both processes.
2. Start the separately verified official CLI App Server with its own
   `--listen ws://127.0.0.1:<port>`, working directory `root/project`, and the fresh
   configuration. The harness does not start or own this second process.
3. Verify the newly created backend's listener ownership, rejection of foreign
   WebSocket Origins, effective `file` auth storage, unauthenticated account result,
   and absence of installed Chrome plugins. Keep its exact PID/start time and
   executable metadata. Do not attach an existing server or send a model turn.
4. Send the complete stdin line `start`. This is the coordinator's attestation of
   those checks; the harness does not probe the endpoint or independently verify
   the listener's process identity. A bare loopback URL is not authentication.

The harness rechecks the exact package identity/version, fixed shell-profile
absence, both core configuration byte sequences and the absence of
`codex-home/auth.json`. Backend-created runtime files such as SQLite databases do
not invalidate the root. It makes one `CreateProcessW` call with its explicit
Unicode environment block and working directory. That child receives only the
new inherited CDP pipe handles. Repeated `start` is reported as `already_started`;
it cannot create another child. No discovery or startup failure retries launch.

After `start`, inspect the new client's own startup log immediately, before any
GUI interaction. Require a successful shell-environment load and the expected
WebSocket transport and development flavor. The first real run reported
`status=timed_out`; stop that run instead of treating inherited values as a pass.
The harness does not yet monitor this log or enforce this post-start gate itself.

Keep the helper running in a foreground task/PTY, or start the helper with a
hidden window and a retained redirected stdin handle. Send stdin commands through
that exact helper's handle. EOF disables stdin input while retaining the Host
and any existing child; it does not send a close request. A helper waiting before
start after stdin EOF cannot be started through another transport.

## Directories and fixed policy

| Child setting / artifact | New location or value |
| --- | --- |
| `CODEX_ELECTRON_USER_DATA_PATH` | `root/user-data` |
| `CODEX_HOME` | `root/codex-home` |
| `CODEX_SQLITE_HOME` | `root/sqlite`; prevents legacy SQLite reconciliation in the audited build |
| `USERPROFILE`, `HOME` | `root/home` |
| Windows Documents known folder | Empty `root/home/Documents`; required before querying the redirected PowerShell profile paths |
| `APPDATA`, `LOCALAPPDATA` | `root/home/AppData/Roaming`, `root/home/AppData/Local` |
| `TEMP`, `TMP` | `root/temp` |
| Working directory | `root/project` |
| Codlet registry | `root/codlet/config.json`; bundled plugins only |
| `BUILD_FLAVOR` | `dev` |
| `CODEX_APP_SERVER_WS_URL` | The explicit audited loopback URL |
| `CODEX_APP_SERVER_FORCE_CLI` | Absent, preventing a stdio override |
| `CODEX_SPARKLE_ENABLED` | `false` |
| `CODEX_ELECTRON_PRIMARY_RUNTIME_UPDATE_MODE` | `manual` |
| `SHELL` | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` |
| Environment and observations | `root/logs/child-environment.json`, `root/logs/report.jsonl` |

`codex-home/config.toml` contains exactly
`cli_auth_credentials_store = "file"`. No auth, sessions, cookies, installed
plugins, user settings or project files are copied from production. The registry
starts as schema 2 with empty `plugins` and `localPlugins` maps, so only this build's
bundled renderer plugins participate.

The fixed `CODEX_ELECTRON_DESKTOP_FEATURE_OVERRIDES` JSON sets all 26 audited keys
to false: `externalBrowserUseAllowed`, `externalBrowserUse`,
`inAppBrowserUseAllowed`, `inAppBrowserUse`, `browserExtensions`,
`browserSettingsCloudSync`, `browserPane`, `computerUse`, `computerUseAutoInstall`,
`computerUseNodeRepl`, `browserUseTinysky`, `cuaPIP`, `appshotsEnabled`, `quickChat`,
`sites`, `autoAuthForSites`, `control`, `skysight`, `messages`, `codexLocalAccess`,
`workCloudAccess`, `workLocalAccess`, `ambientSuggestions`,
`ambientSuggestionsFeatureDiscovery`, `artifactSession`, `recordAndReplay`.
There is no CLI override for this policy. It deliberately omits production
features; a result under these settings is not normal-product equivalence.

The shell check runs one static, read-only `-NoProfile -NonInteractive` command
with the lab environment and only the system PowerShell module path. It obtains
the actual four `$PROFILE` paths as JSON and refuses any existing file/link or
unreadable path. It never loads or reads a profile's content. This is an observed
pre-start condition; it does not lock those shared profile directories against
later changes.

On the first real preparation attempt, an empty redirected home without Documents
made Windows return an empty MyDocuments path and two empty PowerShell profile
paths. Preparation correctly stopped before creating a Desktop child. The harness
now creates the empty Documents directory first; no user document/profile is copied.

Root claiming rejects UNC/device/drive-relative paths, traversal/alias names,
nonempty roots and reparse-point directories in the complete ancestry. Directory
handles deny deletion/renaming while held. Files use `create_new`, including the
root claim marker and logs. Root evidence is retained on cancellation/failure or
completion; repeated runs need another empty/new root. This is not a sandbox
against a malicious same-user process changing filesystem state.

## Observation and shutdown

Every report line has `schema_version`, `event`, Host PID, nullable child PID,
sample time and `detail`. Key events are:

| Event | Interpretation |
| --- | --- |
| `prepared`, `awaiting_start` | Fresh directories/configuration are available; no Desktop child yet. |
| `child_created` | Exact new Desktop PID, handle-derived creation FILETIME, package and executable. |
| `cdp_transport_open` | Pipe worker startup succeeded; no protocol response claimed yet. |
| `cdp_connected` | Initial target discovery returned through that inherited connection. |
| `target_discovery_failed`, `renderer_attach_failed` | Initial work failed; the same child/connection is retained for observation and quit. |
| `renderer_snapshot` | Actual owner lifecycle records from the existing renderer manager. |
| `host_waiting` | Foreground Host is servicing this child and fixed control input. |
| `quit_sent`, `quit_response_unavailable` | One fixed `Browser.close` was attempted; wait for the actual child-exit result. |
| `child_exited`, `cdp_workers_reaped` | Exact child exit code and subsequent CDP worker cleanup. |

Every GUI-related row says `gui_mount_verified=false`: owner activation is not a
DOM mount assertion. A fresh profile may stop at sign-in, use a different route,
or provide no supported main target/menubar. Treat that as partial evidence, not
permission to copy auth or to alter the target allowlist. Existing renderer
timeouts bound startup calls; stdin control is handled after those owner calls
return. The harness never evaluates arbitrary inspection code.

Send `quit` before `start` to cancel without a Desktop child. After `start`,
`quit` sends **one** `Browser.close` over this child's inherited CDP connection,
with a three-second request budget, then continues holding the exact process
handle until it exits. A closing browser may end the transport before answering;
that is reported separately from child exit. Repeated quit does not resend. If
CDP is unavailable, manually close the lab window identified by its recorded PID;
the harness reports the remaining child and keeps waiting. No force-kill, process
name matching, production attach/detach, reconnection, fallback URL or stdio
recovery exists. Shut down the coordinator-owned backend separately after the
Desktop exits, using its own recorded process identity.

The real run established that a successful `Browser.close` response can leave a
windowless Desktop process alive. Do not equate `quit_sent`, a destroyed target,
or an absent window with `child_exited`. In that run the coordinator stopped the
owned backend, then separately terminated the empty test client's process tree
after verifying its retained handle, PID, creation FILETIME, parent and executable.
That cleanup is recorded as a failed graceful-exit gate and is not a new automatic
termination path in this harness or ordinary Codlet.

The stop point for the real experiment is sign-in. Login, model turns, browser/
Chrome operations, official plugin installation and production gates are outside
this harness validation. Windows KnownFolder behavior, HKCU, OS credentials,
shared shortcuts/native endpoints and unauthenticated loopback access are not
made private by directory/environment redirection. The audited fixed strategy
reduces specific startup interactions; the coordinator still checks actual
behavior and the original session before/after. No same-user sandbox is claimed.

## Implementation checks

`ChildEnvironment` builds sorted, case-insensitive Unicode environment blocks,
including Win32 drive-current-directory pseudo-entries for general callers.
Overrides/removals never mutate host environment variables. The ordinary launch
wrapper still passes null environment/CWD pointers and retains its inheritance
behavior. Microsoft documents this contract under
[CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw)
and [Changing Environment Variables](https://learn.microsoft.com/en-us/windows/win32/procthread/changing-environment-variables).

Fake-child tests cover Unicode inheritance/overrides/removal, child CWD/PID,
fixed `Browser.close` and unchanged parent environment. Unit/CLI tests cover
fresh-root exclusivity, reparse/alias rejection, no overwrites, fixed config/auth
checks, valid backend-created state, whitelist manifests, exact package and URL
guards, profile absence, bounded control input and prepared/start/cancel ordering.
The external real Codex gate remains ignored; these tests launch no official
Desktop or backend.
