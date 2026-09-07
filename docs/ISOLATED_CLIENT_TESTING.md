# Isolated Client Test Harness

`codlet-lab` is a separate, explicitly experimental binary for the source-audited
Windows package `26.901.6511.0`. Ordinary `codlet launch` retains its existing
process-conflict refusal and production status endpoint. The lab has no shared
Host IPC endpoint, no executable override, and no arbitrary CDP/JavaScript command.

The [2026-09-08 follow-up](ISOLATED_CLIENT_REPAIR_2026-09-08.md) repaired the initial
Shell timeout and windowless resident-client failures. Two fresh official
Dev/WebSocket runs passed the automatic startup gate in about 1.9 seconds,
activated both bundled renderer plugins, and exited normally in about one second.
The [initial results](ISOLATED_CLIENT_RESULTS_2026-09-07.md) and
[source audit](ISOLATED_CLIENT_EVIDENCE.md) retain the earlier evidence. Login,
GUI mount/interaction and production acceptance remain open. The coordinator owns
the backend lifecycle, connection ownership and before/after checks.

## Preparation and start

Use an existing plain local parent directory and an empty or nonexistent leaf
root. The harness does not create missing ancestors or reuse a root from an
earlier attempt. Example command shape (the port is an illustrative placeholder):

```text
codlet-lab --experimental-isolated-client --root C:/Users/cccake/.cache/codlet-lab/new-attempt --expected-package-version 26.901.6511.0 --app-server-url ws://127.0.0.1:49233
```

`--app-server-url=ws://127.0.0.1:49233` is also accepted. The URL must use the literal
IPv4 loopback address, scheme `ws`, a nonzero u16 port, and no path, credentials,
query or fragment. Default stdio, another package version and malformed options
fail with `preflightBlocked`/usage before a Desktop child or lab directory is
created. The package is resolved through current-user MSIX discovery; only that
package's official executable is eligible.

The harness claims the root, creates fresh configuration and prepares the audited
package's bundled Node runtime in the new local cache. It checks that all four
system PowerShell profile paths are absent, then probes the client's exact static
shell-environment command under that environment. It writes the clean environment
manifest and emits JSONL `prepared` followed by `awaiting_start`. **No Desktop
child exists at this point.** `prepared` reports the Host PID, package/executable,
directory paths and shell-check result; `runtime_assets_prepared` records source,
destination, cache key, marker hashes, file count and bytes copied.

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

The harness rechecks the exact package identity/version, runtime marker hashes,
shell profiles and environment probe, both core configuration byte sequences and
the absence of `codex-home/auth.json`. Backend-created runtime files such as SQLite
databases do not invalidate the root. It makes one `CreateProcessW` call with its explicit
Unicode environment block and working directory. That child receives only the
new inherited CDP pipe handles. Repeated `start` is reported as `already_started`;
it cannot create another child. No discovery or startup failure retries launch.

After `start`, the harness discovers the child's eligible CDP targets but defers
plugin loading until `startup_verified`. It polls only this new PID's `t0` log
under `home/AppData/Local/Codex/Logs`, requiring development flavor, disabled
updaters, local WebSocket transport, a successful initialize handshake and Shell
hydration with `status=loaded`. Any rejected condition, unreadable/oversized log,
or missing evidence after 30 seconds emits `startup_failed`, requests application
quit and leaves the Host result nonzero even if the child exits cleanly. The reader
accepts complete UTF-8 lines only, rejects links, and limits directory enumeration
to 128 entries per level, eight matching logs and 2 MiB per log. It reports flags
and failure reasons rather than raw log text. An exit code alone is not startup
acceptance; require the explicit verification event before GUI work.

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
| `PSModulePath` | Only `C:\Windows\System32\WindowsPowerShell\v1.0\Modules` in the initial environment |
| Bundled Node cache | `root/home/AppData/Local/OpenAI/Codex/runtimes/cua_node/<audited-key>` |
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

The profile check runs a static, read-only `-NoProfile -NonInteractive` command
with a ten-second budget. It obtains the four `$PROFILE` paths as JSON and refuses
any existing file/link or unreadable path. Only after that check does it run the
audited interactive `-NoLogo -Command` environment dump with a five-second budget,
then recheck profile absence. It verifies required environment values, except
search paths normalized by PowerShell, and rejects known secret/route overrides,
duplicate keys and invalid delimiters. Each output stream is limited to 64 KiB;
values are not printed. Timeout stops only the probe process it created. The
profile directories are not locked against later changes.

Runtime preparation copies only the installed package's `app/resources/cua_node`
tree, using the audited three-marker SHA-256 cache-key algorithm. It does not read
the production user's runtime cache. Copying requires new files and plain
directories, rejects reparse points and enforces limits of 32 nested levels,
20,000 files and 2 GiB. Source and destination marker hashes are checked again
before start. The observed package copied 4,684 files / 337,646,562 bytes. This
work occurs before Desktop creation, so the application's synchronous cache
materializer can use the prepared files. The package source guard is released
after preparation; only fresh lab directories stay pinned during the run.

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
| `runtime_assets_prepared`, `shell_preflight_verified` | Runtime copy and final shell probe completed before Desktop creation. |
| `child_created` | Exact new Desktop PID, handle-derived creation FILETIME, package and executable. |
| `cdp_transport_open` | Pipe worker startup succeeded; no protocol response claimed yet. |
| `cdp_connected` | Initial target discovery returned through that inherited connection. |
| `startup_verified` | All five actual startup conditions passed; plugin loading may begin. |
| `startup_failed` | Startup evidence failed; no plugins loaded and one application-quit request begins. |
| `target_discovery_failed`, `renderer_attach_failed` | Initial work failed; the same child/connection is retained for observation and quit. |
| `renderer_snapshot` | Actual owner lifecycle records from the existing renderer manager. |
| `host_waiting` | Foreground Host is servicing this child and fixed control input. |
| `quit_sent`, `quit_response_unavailable`, `quit_unavailable` | Result of the single fixed application-quit attempt; none proves process exit. |
| `quit_timed_out` | The child remains alive after 15 seconds; retain its handle and report failed graceful exit. |
| `child_exited`, `cdp_workers_reaped` | Exact child exit code and subsequent CDP worker cleanup. |

Every GUI-related row says `gui_mount_verified=false`: owner activation is not a
DOM mount assertion. A fresh profile may stop at sign-in, use a different route,
or provide no supported main target/menubar. Treat that as partial evidence, not
permission to copy auth or to alter the target allowlist. Existing renderer
timeouts bound startup calls; stdin control is handled after those owner calls
return. The harness never evaluates arbitrary inspection code.

Send `quit` before `start` to cancel without a Desktop child. After `start`,
`quit` makes **one** fixed main-world request through this child's inherited CDP
session, with a three-second request budget. The script requires the top-level
`app://-/index.html` document (optional query/fragment), the Electron window type
and the audited native bridge. It sends only `{type: "quit-app"}`; the official
trusted handler calls `app.quit()` without relaunch. No caller-supplied script,
message or endpoint is accepted. A shutdown may end the transport before the
reply, so only the retained process handle's `child_exited` result proves exit.

Repeated quit does not resend. After 15 seconds without exit, `quit_timed_out`
records a failed graceful-exit condition while retaining the child handle. If
there is no live eligible session or the bridge fails, the coordinator must
resolve the recorded test client; closing its window alone is insufficient on
this Windows build. The harness does not force-terminate the Desktop, match
process names, attach to production, reconnect, or fall back to another URL or
stdio. Shut down the coordinator-owned backend separately after Desktop exit,
using its own recorded process identity. In all six follow-up runs, the native
quit path exited the owned Desktop with code zero and reaped its CDP workers;
the coordinator used no force termination.

For optional startup diagnosis, append `--startup-trace` as the final option.
This adds a six-second Chromium controller trace at `logs/startup-trace.json`
and V8 `--prof --no-log-source-code` logs under `logs/`. Categories are fixed to
top-level/V8 work; no network trace or external output destination is accepted.
The harness requests native quit after 12 seconds; the same exit-failure behavior
above applies if that request cannot finish. V8 profiles can include function
names and paths even with source logging disabled, and remain local artifacts.
Only this optional mode requires an ASCII root without whitespace or single
quotes for V8 flag parsing. Ordinary lab roots retain Unicode/space support.

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

Fake-child transport tests cover Unicode inheritance/overrides/removal, child
CWD/PID and unchanged parent environment. Unit/CLI tests cover fresh-root and
configuration guards, runtime copy/tamper/reuse checks and known SHA-256 vectors,
shell output validation, PID-scoped startup logs and partial writes, deadlines,
quit acknowledgments, fixed profiling arguments and control ordering. Node VM
tests exercise the actual quit script and reject wrong documents, subframes and
missing bridges. The final full Rust run passed 246 tests with one external real
Codex gate ignored; the two new Node tests passed. These automated tests launch
no official Desktop or backend; real evidence is recorded separately above.
