# Isolated Client Test Harness

`codlet-lab` is a separate, explicitly experimental binary for the source-audited
Windows package `26.903.8094.0`. Ordinary `codlet launch` retains its existing
process-conflict refusal and production status endpoint. The lab binds only its
own registry control endpoint, authenticated to the same `codlet-lab.exe` and user.
It never publishes the production discovery/status endpoint. There is no official
Desktop executable override or arbitrary stdin CDP/JavaScript command.

The [2026-09-10 update](ISOLATED_CLIENT_UPDATE_2026-09-10.md) adds the current M2
Host/Renderer runtime, trusted local plugins and a reusable manual-test launcher.
It reuses the existing test login in place and supports the specifically reviewed
upgrade from `26.901.6511.0`. The user performs the feature/GUI tests.

For that retained profile, build a separate client directory with
`scripts/Build-IsolatedClient.ps1`. Its generated `Start-TestClient.cmd` starts a
hidden coordinator and the visible official development client. `Stop-TestClient.cmd`
sends the fixed quit request and stops the owned backend after Desktop exit.
`Test-Plugins.cmd` provides the normal plugin subcommands against the test registry.
The generated configuration pins the lab executable and official CLI hashes.
Do not use ordinary `codlet launch` to start this test profile.

The [2026-09-08 follow-up](ISOLATED_CLIENT_REPAIR_2026-09-08.md) repaired the initial
Shell timeout and windowless resident-client failures. Two fresh official
Dev/WebSocket runs passed the automatic startup gate in about 1.9 seconds,
activated both bundled renderer plugins, and exited normally in about one second.
The [initial results](ISOLATED_CLIENT_RESULTS_2026-09-07.md) and
[source audit](ISOLATED_CLIENT_EVIDENCE.md) retain the earlier evidence. Those fresh
runs stopped before login or GUI interaction. The coordinator owns
the backend lifecycle, connection ownership and before/after checks.

The later [manual-login GUI acceptance](GUI_ACCEPTANCE_2026-09-08.md) is a separate
scope extension: the user completed login and Windows setup. A restart of only
the dedicated backend cleared its stale setup-readiness result, but GUI list
loading and window-reload recovery failed. The [GUI repair and retest](GUI_REPAIR_2026-09-08.md)
subsequently passed with that retained authenticated profile, including two native
reloads and self-disable across two windows. Production acceptance remains open.
Fresh-root preparation below retains its unauthenticated precondition; explicit
profile resume has a separate contract.

## Preparation and start

Use an existing plain local parent directory and an empty or nonexistent leaf
root. Without `--resume-from`, the harness does not create missing ancestors or
reuse a root from an earlier attempt. Example command shape (the port is an illustrative placeholder):

```text
codlet-lab --experimental-isolated-client --root C:/Users/cccake/.cache/codlet-lab/new-attempt --expected-package-version 26.903.8094.0 --app-server-url ws://127.0.0.1:49233
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

## Plugin control

After the coordinator has verified startup, the lab accepts one fixed lifecycle
line at a time:

```text
plugin enable <id>
plugin disable <id>
plugin reload <id>
```

These lines are parsed by the lab's bounded stdin input, with exactly three
space-separated fields. They do not accept `--json`, extra arguments, paths,
`eval`, or a directory path. IDs may name bundled or explicitly trusted local
plugins. The same catalog, grants, Core RPC, OS brokers and `HostControl` used by
M2 manage Renderer, Host and combined packages in this test instance.

The generated `Test-Plugins` launcher accepts `list`, `add`, `remove`, `permissions`,
`enable`, `disable`, `reload`, `revoke`, and `operation`, with the normal options.
For example, from the generated client directory:

```powershell
.\Test-Plugins.ps1 list
.\Test-Plugins.ps1 add C:\my-plugins\example --trust --grant ui.dom
.\Test-Plugins.ps1 enable my.example --json
.\Test-Plugins.ps1 reload my.example --json
.\Test-Plugins.ps1 disable my.example --json
```

Only the CLI child receives `LOCALAPPDATA=<lab root>`, selecting
`root/Codlet/config.json`; Windows resolves that to the existing lab registry.
The native lab entrypoint checks the marker, plain ancestry and resolved registry
identity before dispatch. It rejects a default/different registry. The Desktop,
backend and Host JS keep their separate `root/home/AppData/Local` environment.
Use the generated launcher so pipe authentication uses the exact same lab executable.
Local `add` retains explicit `--trust` and permission/scope grants. A malformed or
untrusted registration does not become an exception to the M2 permission checks.

Before `start`, a plugin line emits the JSONL event
`plugin_control_rejected` with `reason: "not_started"` and
`child_created: false`. After `start` but before `startup_verified`, or after
quit/CDP/renderer failure makes the owner unavailable, the same event reports
`reason: "runtime_not_ready"`. `start` itself remains a one-time attestation;
repeated `start` emits `already_started` and never creates another child.

The foreground lab loop selects at most one plugin request per round and defers
additional input lines for a later round. The selected request is executed by
the same prepare/submit/operation broker used by public `runtime.manage@1` and
the test CLI. The foreground `HostControl` drives the actual lifecycle. Stdin
emits `plugin_control_requested`, then `plugin_control_queued` with a receipt,
then `plugin_control_result` with the completed control report. Submission occurs
once; later polls query only that receipt. Revoke and external grant changes
retire the affected authority and dependency closure through the M2 owner.

Every lab control result continues to report `gui_mount_verified: false`.
`plugin_control_requested`, `plugin_control_result`, and
`plugin_control_failed` are JSONL lifecycle observations, not GUI visual
acceptance. They do not prove a menu mount, populated panel, theme/layout
behavior, navigation recovery, or production compatibility. The lab control is
manual and one-shot; it does not add a file watcher or extend the lab with a
`launch --watch` mode.

The completed [2026-09-08 isolated manual-control acceptance](RUNTIME_CONTROL_ACCEPTANCE_2026-09-08.md)
records the earlier bundled-only implementation. The 2026-09-10 update supersedes
that local-plugin restriction. The production-control and watcher exclusions remain.

## Directories and fixed policy

The following table describes the fresh-root layout. Resume keeps the same
application directories and gives each run its own environment/report subdirectory.

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
| Codlet registry | `root/codlet/config.json`; bundled and trusted local plugins |
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
completion; another fresh run needs an empty/new root, while resume requires the
closed-run checks below. This is not a sandbox
against a malicious same-user process changing filesystem state.

## Resuming a closed experimental profile

Append `--resume-from <absolute-report-path>` after the app-server URL options to
reuse a previously created lab profile. It cannot be combined with `--startup-trace`.
The root, package version and dedicated backend are still explicit:

```text
codlet-lab --experimental-isolated-client --root C:/Users/cccake/.cache/codlet-lab/known-attempt --expected-package-version 26.903.8094.0 --app-server-url ws://127.0.0.1:49233 --resume-from C:/Users/cccake/.cache/codlet-lab/known-attempt/logs/report.jsonl
```

Resume acquires a read/write lease on the existing experimental marker and pins
the plain root ancestry and lab directories. It accepts only `logs/report.jsonl`
or `logs/run-*/report.jsonl` under that root. A complete schema-1 report must name
the same root/Host and a compatible package, and record either child exit 0 plus CDP worker cleanup,
or `no_child_created` from a completed preparation-only attempt. The old child's
PID and creation FILETIME are checked with a read-only process handle; a still-live
matching process or an inaccessible identity blocks resume. A newer/ambiguous run
report blocks selecting an older receipt. These are conservative local evidence
checks, not authentication against another process running as the same user.
Package compatibility accepts exact identity or the one reviewed x64 package
transition `26.901.6511.0` to `26.903.8094.0`, with the original family/publisher.
It is not a general version bypass or a downgrade path. Reports with explicitly
failed plugin-runtime cleanup cannot authorize resume.

No configuration, login state or history is copied or rewritten by resume.
The two core configuration files are bounded, read as snapshots and checked again
before Desktop creation; the M2 catalog validates local registrations and grants.
An optional `auth.json` receives metadata/link checks only, with no credential byte
read. Plain files must have a single hard link. Runtime cache directories are
revalidated under the existing size/depth budgets and all three marker hashes are
compared to the official package. If the reviewed package uses a new cache key,
only that new version directory is populated from official immutable resources;
the prior runtime cache and test account files are retained.

Each resumed run writes `logs/run-<time>-<pid>/report.jsonl` and a new
`child-environment.json`. Use the **exact `environment_manifest` from this run's
`prepared` event** when starting its backend. The coordinator must verify the new
listener's process ownership, effective file credential storage, expected account
state and readiness before sending `start`. An authenticated profile is expected
only after the separately authorized manual-login flow; do not apply the fresh
run's null-account assertion to it. Neither the harness nor this option performs
login, sandbox setup or background-service restart. A prior backend also has to be
stopped and its cleanup verified by the coordinator, which owns that lifecycle.

Startup evidence must be from a log created no earlier than the new Desktop's
creation FILETIME, as well as match its PID. This prevents a retained old log from
satisfying the gate if Windows later reuses a process ID. Process creation still
happens once, after the same package, environment and shell checks.

## Observation and shutdown

Every report line has `schema_version`, `event`, Host PID, nullable child PID,
sample time and `detail`. Key events are:

| Event | Interpretation |
| --- | --- |
| `lab_opened` | Fresh root or validated resume lease acquired; records the selected run log directory. |
| `prepared`, `awaiting_start` | Directories/configuration and this run's clean environment manifest are available; no Desktop child yet. |
| `runtime_assets_prepared`, `shell_preflight_verified` | Runtime copy and final shell probe completed before Desktop creation. |
| `child_created` | Exact new Desktop PID, handle-derived creation FILETIME, package and executable. |
| `cdp_transport_open` | Pipe worker startup succeeded; no protocol response claimed yet. |
| `cdp_connected` | Initial target discovery returned through that inherited connection. |
| `startup_verified` | All five actual startup conditions passed; plugin loading may begin. |
| `startup_failed` | Startup evidence failed; no plugins loaded and one application-quit request begins. |
| `target_discovery_failed`, `renderer_attach_failed` | Initial work failed; the same child/connection is retained for observation and quit. |
| `renderer_snapshot` | Actual owner lifecycle records from the existing renderer manager. |
| `plugin_runtime_ready` | M2 executors and the private registry control broker are ready. |
| `host_plugin_diagnostic`, `host_plugin_stopped` | Native Host process lifecycle observations. |
| `plugin_runtime_stopped` | Managed resources stopped; `clean` is required when present in a resumed report. |
| `host_waiting` | Foreground Host is servicing this child and fixed control input. |
| `quit_sent`, `quit_response_unavailable`, `quit_unavailable` | Result of the single fixed application-quit attempt; none proves process exit. |
| `quit_timed_out` | The child remains alive after 15 seconds; retain its handle and report failed graceful exit. |
| `child_exited`, `cdp_workers_reaped` | Exact child exit code and subsequent CDP worker cleanup. |
| `no_child_created` | Preparation ended without creating a Desktop; permits a later explicit resume. |

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

The initial fresh experiment stopped at sign-in. The later user-authorized GUI
acceptance used manual login and setup; resume does not automate either. Model
turns, browser/Chrome operations, official plugin installation and production gates
remain outside this harness validation. Windows KnownFolder behavior, HKCU, OS credentials,
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
missing bridges. Resume checks additionally cover profile preservation, exclusive
leases, latest receipts, live/recycled PID identities and stale startup logs. The
GUI repair's full Rust run passed 255 tests with one external real Codex gate
ignored; all 63 Node tests passed. These automated tests launch no official Desktop
or backend; real evidence is recorded separately above.

Current lab-update checks are recorded separately in the
[2026-09-10 update evidence](ISOLATED_CLIENT_UPDATE_2026-09-10.md). Historical full
suite counts below describe their original commits, not this update's verification.

The separate manual lifecycle-control batch historically reported 276 Rust tests
passed with one real-start gate still ignored by default, and all 63 Node tests
passed. At that stage the re-enable multi-plugin authorization guard and its
integration recheck were still pending; this remains a historical batch record,
not the final repository result.

The follow-up acceptance report records the guard's manual-control recheck and
the resulting historical 277 Rust / 63 Node totals, including 44/44 related
cases. The final repository validation then passed 289 Rust tests with one
explicit real-production-start gate left default-ignored, 63 Node tests, Clippy,
fmt, diffcheck, and the locked release build. It included 12 watcher regressions
(7 clock/file-state, 1 execution-path guard, 1 dual-target end-to-end, 2
parser/scheduling, 1 registry-limit). The isolated lab run remains distinct from
ordinary production launch and production GUI acceptance; M0/M1 and
`DEFECT-001`/`DEFECT-002` remain open.
The isolated manual-control evidence is based on source commit `5a0be1e`; the
watcher/safety/UI cleanup source is `851395a`. The final suite summary is recorded
in [verification.json](../.codlet-artifacts/runtime-watch-2026-09-08/verification.json).
