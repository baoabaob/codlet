# Isolated Client Startup and Exit Repair — 2026-09-08

The two failures from the [initial experiment](ISOLATED_CLIENT_RESULTS_2026-09-07.md)
are repaired for the audited Dev/WebSocket lab configuration. Two fresh directories
passed the automatic startup gate in 1.875 and 1.909 seconds, confirmed both bundled
renderer activations, and exited normally in 1.011 and 1.112 seconds. All six
follow-up clients and their dedicated backends have exited; no force termination
was used in this follow-up.

This verifies startup and application exit under the fixed experimental policy.
Login, GUI mount/click behavior, themes, narrow windows and production M0/M1 gates
remain unverified. No model turn, authentication, Computer Use input or browser
integration was performed. `DEFECT-001` and the Host-crash contract `DEFECT-002`
remain open.

## Build and ownership

- Official MSIX: `OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0`;
  application version `26.901.51231`.
- Official CLI: `0.153.4`, SHA-256
  `E5AA76D19C7C94E2E9EF9B707D590206A73AC0E97C8DDC8382181242494BEF75`;
  matched the packaged executable.
- Final tested lab binary: `codlet-lab-seeded.exe`, SHA-256
  `96E2F2C9C7933741B326075BA4890A6B0C6F45BBB4EEB5A4CF2A4306DC2B647F`.
- Fresh roots: `C:/Users/cccake/.cache/codlet-lab/20260908-profile-a` through
  `20260908-profile-f`; each has its own home, data, cache and workspace.
- Every Desktop was created once by its recorded lab Host with inherited CDP
  pipes. Every backend was separately created and owned by the coordinator.
  The ordinary `codlet launch` path and its conflict refusal are unchanged.

The final two Desktop identities were PID `32968`, parent `33128`, creation
FILETIME `134332760095276577`, and PID `25216`, parent `42388`, FILETIME
`134332764016684314`. Their dedicated backend PIDs were `47056` on loopback port
`51669` and `19548` on `51673`. Active observations confirmed each Desktop's
connection to its own backend. Process identity, rather than a reusable PID
alone, governed observation and cleanup.

## Why the Shell result was late

The fixed system PowerShell probe completed promptly with the prepared lab
environment. In baseline run B, the Desktop's own PowerShell child was observed
for about 0.313 seconds, while the Desktop reported a 4.229-second Shell hydration
phase. This pointed to delayed main-process handling of the result.

V8 sampling in run D identified synchronous file copying through
`copyFileSync -> lL -> uL -> cL` in the installed shared module. A source review of
`.vite/build/src-VqXTPopo.js:681` confirmed that `cL` and its callers `oL` / `QI`
materialize the bundled `resources/cua_node` tree into the redirected runtime
cache during startup. The synchronous work blocks main-process JavaScript.
`main-DpnWwRdP.js:471` (`fue`) races Shell loading against a five-second timer;
line 1526 starts the Windows Shell load in the background. No supported timeout
environment override was found in the inspected implementation.

The profile processor was a different V8 version and reported four unsupported
state entries. Its stacks are qualitative evidence of the blocking path, not a
reliable CPU-percentage measurement. The source inspection and two subsequent
fresh-directory improvements provide the corroborating evidence. Extracted source
remains in the external research directory recorded by the
[source audit](ISOLATED_CLIENT_EVIDENCE.md); no official code is committed here.

The lab now prepares only the installed package's `app/resources/cua_node` tree
before creating the Desktop. It computes the same cache key from these fixed
markers, in order: `manifest.json`, `bin/node.exe`, `bin/node_repl.exe`. The hash
input is each relative name, NUL, its lowercase hexadecimal SHA-256 digest, NUL;
the first 16 hexadecimal digits of the combined SHA-256 form the key.

For this package the key was `b474a88d5d105afa`, independently reproduced with
Node's crypto implementation and confirmed by the client. Each final run copied
4,684 files / 337,646,562 bytes into its own new cache. It did not import production
runtime caches, configuration, credentials or sessions. The implementation uses
new-file creation, reparse-point rejection, depth/file/byte limits and marker
revalidation before start. Package source handles are released after preparation;
only lab directories remain pinned. See [runtime preparation](../src/lab/runtime_seed.rs).

Preparation therefore moves the copy cost before Desktop creation. The timings
below measure the client's startup gate, not total preparation-plus-start time.

## Startup gate and normal quit

The lab now verifies the actual new PID's main-process log before loading any
renderer plugin. Required conditions are development flavor, disabled updaters,
local WebSocket transport, successful initialize and Shell hydration `status=loaded`.
Failure or missing evidence within 30 seconds requests application quit and
preserves a failed Host result. Run A exercised this path: no plugins activated,
the Desktop quit cleanly, and the Host still returned exit code 1.

The original `Browser.close` failure was consistent with the Windows tray
lifecycle: `.vite/build/window-all-closed-KNH8jchn.js:11` does not quit the app
merely because its windows close. The audited preload at `preload.js:1` exposes
`electronBridge.sendMessageFromView` over `codex_desktop:message-from-view`.
The shared channel mapping (`ow` / exported `tt`) and trusted sender check in
`main-DpnWwRdP.js:1321` lead the fixed `quit-app` message to `app.quit()`.

The lab's [fixed quit script](../src/lab/quit.js) checks the exact top-level main
document and Electron bridge, then sends that one message without relaunch.
The inherited session request has a three-second deadline. Only the retained
child handle's exit result establishes shutdown; a response, closed target or
missing window does not. Fifteen seconds without exit reports failure and keeps
the child handle for the coordinator. No automatic force-kill or retry was added.

## Recorded runs

All durations are milliseconds. Shell time is the client's logged hydration
phase time; startup time is the Host's elapsed automatic-check time. Exit time
runs from the quit request to the observed Desktop exit. Each row used a new root.

| Run | Runtime preparation / diagnosis | Shell | Startup gate | Quit to exit | Result |
| --- | --- | ---: | ---: | ---: | --- |
| A | No preparation; failure-path validation | Five-second timeout | Failed at 6032 | 1255 | No plugin activation; Desktop 0, Host 1 |
| B | No preparation; child process sampling | 4229 | 5183 | 1060 | Startup and exit passed |
| C | No preparation; Chromium trace | 4015 | 5000 | 1062 | Startup and exit passed |
| D | No preparation; Chromium + V8 profile | 4193 | 5330 | 1164 | Startup passed; timed diagnostic quit passed |
| E | Runtime prepared; no profiling | 942 | 1875 | 1011 | Startup, both activations and exit passed |
| F | Runtime prepared; fresh repeat, no profiling | 950 | 1909 | 1112 | Startup, both activations and exit passed |

In E and F, `codex.ui.adapter` and `codlet` reported confirmed activation only
after `startup_verified`. All GUI observations remain `gui_mount_verified=false`.
The two improved runs support this repair; they do not establish a long-run
success rate or ordinary production compatibility.

## Cleanup and retained evidence

Before connection and after each client run, each dedicated backend accepted
`initialize`, returned a null account and effective `file` credential storage,
and reported the intended read-only sandbox. A foreign-Origin handshake returned
HTTP 403. Every test home retained no `auth.json` and no installed-plugin directory.

The final snapshot found zero recorded test processes and zero listeners on the
six test ports. The original Desktop PID `20224` and App Server PID `26172`
retained their executable, parent and creation time. All four Chrome native-host
registration names and manifest paths matched the pre-test snapshot. These are
specific observed checks, not a same-user sandbox or a full shared-OS-state audit.

Machine-local artifacts remain under
`.codlet-artifacts/isolated-client-2026-09-08/`: `run-summary.json`,
`after-final.json`, the per-run backend identity/protocol reports, active process
observations, traces/profiles, tested binaries and final check logs. Each fresh
root retains `logs/report.jsonl`, its environment manifest and Desktop logs.
The derived summary preserves creation FILETIMEs as decimal strings; the raw
reports remain authoritative. Dates in UTC log folders may be September 7 while
the local test date in Asia/Shanghai is September 8. Artifacts are ignored by Git.

Final implementation checks passed: formatting; Clippy with
`--locked --all-targets --all-features -- -D warnings`; all 246 Rust tests with one
external real Codex gate intentionally ignored; and both Node tests of the actual
quit script. The [current recipe](ISOLATED_CLIENT_TESTING.md) documents preparation,
automatic gating, optional diagnostics and failure handling for another run.
