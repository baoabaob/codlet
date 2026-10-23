# Core acceptance — 2026-10-22

Status: selected automated acceptance gates passed; cleanup and orderly VM shutdown verified. Runtime testing and deterministic regressions exposed
several startup and event-delivery defects. Corrections are in the working
branches. The optimized full functional gate and its explicit App Server restart
variant passed on Native 8120.0 after correcting startup admission and restart
policy preparation. All 20 independent cold starts and all 50 lifecycle cycles
passed on the final candidate. All ten original rc.13 MSI cases and
an earlier 50-cycle lifecycle run passed. The initial cold-start matrix stopped
on case 5 after four startup passes; that failed matrix is retained separately.

Core source: `67da46836ade94727f19b4c79226443eb05b455b` (rc.13), with release
evidence at checkout `4461d6190b0178469338935d2dd4aaab039e04dc`.
Split Workbench source: `570fcfdd1246a3b04ec6b3804ec87b0eb5d535c4` (rc.3).
Current restart-preparation candidate: acceptance executable SHA-256
`b46ad1ae9b9d5d86c420dc933f6c01585d0b6fa8aa30fab0d9a7130bc619a099`,
ordinary release executable
`42d9047bcaeec346ca52ebf993d3bdbe58ec6d2b322933f307a0ad5be35bb8fd`,
paired archive
`b5a29a0cb30c4ef20e82bd0cc38cfb1310b851a9306863dd4641b9b2ca9457b8`.
These are working-tree validation builds, not a published release.
Target Native package: `OpenAI.Codex_26.1016.6573.0_x64__2p2nqsd0c76g0`.
The recovery run found that Store servicing had replaced that package with
`OpenAI.Codex_26.1016.8120.0_x64__2p2nqsd0c76g0` and removed the old image.
Subsequent worker-build acceptance uses the latter package, with a separate
receipt and an automatic-update freeze confined to the disposable VM. Its
OpenAI image signature is valid; ASAR SHA-256 is
`760eae730e57438a0693cab4aba5ed8b7eb0ea1c5b7a7dc26dd0e84c2398810f`
and CLI SHA-256 is
`e757246b4de87359e660647fa9514955a0971ff6a30affdd8c145d1d5ece7b84`.
Evidence: Lab `verify-updated-native-20261022.details.json` and
`freeze-store-test-version-20261022.details.json`. The VM policy follows
[Microsoft's packaged-app update policy](https://learn.microsoft.com/windows/msix/group-policy-msix).

## Results from this run

| Check | Result | Evidence |
| --- | --- | --- |
| Rust library regression, locked dependencies, no default features | 569 passed, 0 failed, 7 ignored | `.codlet-artifacts/core-acceptance-20261022/core-rust-tests.log` |
| Rust all targets/all features with the final restart-preparation bundle | 846 passed, 0 failed, 8 ignored | `.codlet-artifacts/core-acceptance-20261022/core-all-targets-restart-final.log` |
| Core frontend regression on the pinned Node runtime, including final lifecycle observation | 397 passed, 0 failed | `.codlet-artifacts/core-acceptance-20261022/core-frontend-final-lifecycle.log` |
| Embedded Native adapter regression on the pinned Node runtime, with Core integration and GC checks enabled | 441 passed, 0 failed, 2 skipped | `.codlet-artifacts/core-acceptance-20261022/codex-frontend-restart-retry.log` |
| Two opt-in official App Server transport cases, run separately in the VM | HTTP and WebSocket passed actual start, response and cold restart/resume; no residual children | Lab `reports/official-app-server-transports-validated-20261022.json` |
| Clippy, all targets/all features, warnings denied | Passed | `.codlet-artifacts/core-acceptance-20261022/core-clippy-startup-final.log` |
| Split regression after asynchronous Desktop preparation | 159 passed, 0 failed | `.codlet-artifacts/core-acceptance-20261022/split-readiness-tests.log` |
| Reuse of an installed official Native Node runtime | Passed | `.codlet-artifacts/core-acceptance-20261022/node-provision-acceptance.log` |
| Fixed official Node download, integrity verification and cache reuse | Passed | Same Node provisioning log |
| Managed update with the real rc.13 portable ZIP | Passed: successful replacement and failed-restart rollback | `.codlet-artifacts/core-acceptance-20261022/managed-update-acceptance.log` |
| Final acceptance and ordinary release executables | Both built; host and guest hashes verified | Lab `reports/backend-restart-retry-build.json` and the final Native acceptance receipts |
| VM payload | Host and guest archive/file hashes verified; exact Native ASAR matches | Lab `reports/stage-core-20261022-b.details.json` |
| Production MSI lifecycle | All ten cases passed, including cancelled-upgrade rollback, repair, scope changes and downgrade rejection; user-data sentinels preserved and machine PATH restored | Lab `reports/core-installer-20261022-c.details.json` |
| GUI-only current-Native startup and normal shutdown | Passed with ordinary user token, renderer present, zero plugin errors and exit 0 | Lab `reports/core-smoke-bounded-20261022.details.json` |
| Patched Core + patched Split startup | Renderer and both plugins active, zero plugin errors and normal exit 0; one run also reached `split_ready` | Lab `reports/core-functional-split-ready-20261022.details.json` |
| 50 real plugin lifecycle cycles | Passed: 150 applied reload/disable/enable operations, unique retirement evidence, one final report node, zero plugin errors, normal exit 0 and no remaining Native/Core processes | Lab `reports/core-lifecycle-fifty-b-20261022.details.json` |
| Final ordinary release launcher on Native 8120.0 | Passed with GUI and Split visible, ordinary user token, normal exit 0 and no remaining owned processes | Lab `reports/plain-production-restart-retry-20261022.details.json` |
| Full Native functional gate after startup connection admission fix | 23 renderer/Desktop checks passed; actual model request/response transformation reached history; steering/interruption, Split open/close and one lifecycle cycle passed; normal exit 0, zero plugin errors, no Native remainder | Lab `reports/core-functional-startup-connection-wait-20261022.details.json` |
| Functional gate after an explicit Native App Server restart | Native restart completion log present; original thread resumed; 22 checks passed and one initial surface query was unavailable; subsequent workspace preparation and actual Split open/close passed; response transformation reached history; normal exit 0 and zero plugin errors | Lab `reports/native-backend-restart-retry-20261022.details.json` |
| Final 20 independent cold process starts | 20/20 passed: Desktop and model hooks ready, Split ready, skill ready, normal exit 0, zero plugin errors, owned processes exited and generated copies cleaned after each case | Lab `reports/core-cold-twenty-final-20261022.details.json` |
| Final 50 lifecycle cycles | 150 applied operations; final enabled generation 101 observed ready with exactly one report node; 212 explicitly unsubmitted busy retries; normal exit 0, zero plugin errors and owned processes exited | Lab `reports/core-lifecycle-fifty-final-b-20261023.details.json` |

The managed-update test uses an isolated simulated owner/restart process. It
exercises the compiled Core planner, real ZIP staging and update helper; it does
not establish that a running Native session survives an update.

The seven initially ignored Rust tests include three subprocess entry points
invoked by parent tests. The two Node tests and managed-update parent were then
run explicitly. The foreground desktop restart-bridge test remains unexecuted.

The earlier frontend, source-contract and synthetic stress results are recorded
in [rc.13 validation](releases/1.0.0-rc.13/validation.md). They are not new desktop
acceptance results from this run.

The opt-in App Server report initially marked its aggregate false because its
PowerShell parser expected TAP output, while Node emitted the spec reporter.
Both original tests passed with exit 0. A separate validation receipt binds the
original report hash and confirms two passes, zero failures, zero skips and no
remaining children; the original report is retained. These tests establish Core
transport behavior with the official CLI, not interception inside Native's UI.

An additional full run with the system Node 24.18.1 aborted in V8 during
`bootstrap_idle.test.mjs` (`Invoke in DisallowJavascriptExecutionScope`). That
failed log is retained as `core-frontend-connection-final.log`. The complete
394-test suite subsequently passed on the pinned runtime used by Core, followed
by the final 397-test suite after lifecycle-harness regressions were added. The
system-runtime abort has not been assigned a Core root cause.

## Reproduced defects and corrections

1. Core permanently stopped renderer discovery after a startup
   `Target.getTargets` timeout even though Native subsequently rendered its
   window. One explicit reload on the same owned client recovered it
   (`renderer-recovery-20261022.details.json`). Initial discovery now makes at
   most three attempts, with a fresh event subscription, only for timed-out
   idempotent discovery requests on a still-open connection. Attach/evaluate
   errors are not replayed. The fake-pipe regression covers recovery and the
   retry bound; live runs record the automatic retry and subsequent activation.
2. Split awaited Desktop readiness within the renderer activation RPC budget.
   Slow startup exhausted that budget and interrupted cleanup. Desktop
   preparation now begins after activation, entry remains disabled until all
   dependencies are ready, and retirement cancels queued work and rejects late
   replies. Unit and controller tests cover pending readiness, disposal and
   failure; the live combination no longer records activation/cleanup errors.
3. The built-in Codlet skill bridge permanently failed if the local App Server
   was not ready within 30 seconds. Live functional runs recorded this failure
   even after Desktop services became ready. The bridge now backs off to one
   owned discovery wait per second after that window, registers when the local
   connection becomes ready, and cancels the wait on retirement. New fake-clock
   tests cover delayed readiness and retirement; the lifecycle run ends with the
   real skill state `ready`.
4. The acceptance watchdog closed CDP but left the deliberately retained Native
   process alive after discovery failure. The test harness now retains the exact
   child handle, terminates that child on its deadline, writes an explicit failed
   verdict, and does not count deadline cleanup as normal shutdown. Two tests
   verify exact ownership and completion cancellation. This change is confined
   to the opt-in acceptance feature.

Additional findings from the extended run:

- The temporary inspector had a separate 1.5-second close deadline. A delayed
  callback in Native caused `client_bridge_inspector_detach_failed`; a real Node
  inspector fixture with 1.8-second retirement reproduced the failure. Closure
  now uses the remaining original transaction budget and still requires a
  refused connection before success. See `inspector-detach-before.log` and
  `inspector-detach-after.log`.
- Cold-start case 5 completed the package handoff but failed while waiting for
  the helper to exit (`collect-cold-failure-20261022.details.json`). After an
  authenticated commit, Core now gives the helper a short exit grace and can
  retire that exact retained process while retaining the transferred client.
  Uncommitted helpers retain their own abort deadline. Unit tests cover both
  ownership cases. Early delayed-helper attempts exposed further startup timing
  failures and remain failed evidence. The optimized delayed-helper run then
  confirmed forced retirement after commit, a rendered Native window, zero
  plugin errors and normal exit 0 (`core-helper-optimized-20261022.details.json`).
- First-run Native runtime preparation can block its main loop. A fixture that
  stalls the original readiness response for 35 seconds reproduces
  `client_bridge_uncertain`. Core now queries that original receipt within a
  bounded 45-second readiness phase, without replaying initialization. Each
  transport request also observes the remaining total deadline. See
  `bridge-startup-ready-before-enforced.log` and `bridge-startup-ready-after.log`.
- A concurrent frontend regression exposed event callbacks being counted as
  active before they had a chance to run. One coalesced pipe write containing
  96 fast events now reproduces it deterministically. The Host pauses input and
  yields between frames so completed callbacks settle; genuinely stalled
  callbacks still hit the existing concurrency bound. See
  `host-coalesced-events-before.log` and `host-coalesced-events-after.log`.
- A plain production launch returned empty target lists while Native was still
  creating its main window. `MainTargetNotFound` now participates in the same
  three-attempt discovery bound: no session has been attached on that path.
  The fake-pipe case fails before the correction and passes afterward, including
  an always-empty case that verifies exactly three attempts. See
  `empty-target-before-enforced.log` and `empty-target-after.log`.
- Native traffic registration was available while both actual Native source
  paths were unavailable. The real model test retained the unmodified response.
  A bounded module inventory showed the main, bootstrap and connection modules
  had not loaded before source readiness expired; the current modules' required
  method contracts passed separate offline inspection. Initial source readiness
  now has a 40-second bound inside Core's 45-second receipt phase; its internal
  module wait allows cold provisioning to finish. Hot replacement stays bounded
  at ten seconds. A packaged source with modules loaded after 12 seconds fails
  before the correction and passes afterward, querying the same readiness
  receipt when its original reply socket expires. See `late-source-before.log`,
  `late-source-after-receipt.log` and Lab
  `reports/source-inventory-diagnostic-20261022.details.json`. Live retesting
  confirmed all four method bindings and the Desktop HTTP source; backend policy
  probing then exposed its separate timeout (`collect-source-readiness-b-20261022.details.json`).
- The production launcher displayed both GUI entries and accepted the normal
  quit request, but a queued `Target.targetCreated` event outlived its window.
  `Target.attachToTarget` returned `-32602: No target with given id found`, which
  incorrectly failed the entire runtime. Discovery now ignores that exact
  no-session-created result and retains other sessions. The real-pipe regression
  fails before the correction and passes in the 846-test suite. See
  `vanished-target-before.log` and Lab `plain-production-launcher-c-20261022.details.json`.
- The initial backend policy probe had a separate 3.5-second timeout. Live
  diagnostics reported `backend_config_timeout` despite working Desktop source
  hooks. Startup probes now use the remaining initial readiness deadline, capped
  at 30 seconds; ordinary probes keep 3.5 seconds. A four-second initialization
  fixture verifies both paths and confirms its one owned child is retired.
  See `backend-probe-before.log` and `backend-probe-after.log` (34 passed).
- An owned-VM diagnostic captured the next backend failure: the policy child
  exited with code 1 while initializing the SQLite state directory shared with
  Native. The same executable, arguments and configuration succeeded outside
  Native startup. Metadata probes now use an owned temporary SQLite directory
  through both the environment and final CLI override, retaining the original
  configuration/account context. That directory is removed only after the owned
  children exit, with link checks before removal. The regression fails before
  the change and passes for both successful and failed probes. Evidence:
  `backend-state-before.log`, `backend-state-after.log` (20 passed), and Lab
  `owned-probe-stderr-diagnostic-20261022.details.json`. The next Native run read
  configuration but reported probe cleanup failure. Follow-up tracing observed
  a delayed child retirement followed by expiration before the second probe;
  SQLite isolation alone did not complete the model-routing gate.
- The metadata probe ran on Native's main event loop, so synchronous startup
  work could delay its pipe reads, timers and child-exit receipts. It now runs
  in an owned Node worker with the same deadline and cancellation signal; the
  parent waits for worker exit before publishing the result. A real subprocess
  regression stalls the parent for 4.5 seconds: the old implementation fails,
  while the worker completes configuration and routing proof within its own
  deadline. Cancellation confirms the child's exit and state-directory removal.
  See `backend-worker-before.log`, `backend-worker-after.log`,
  `backend-worker-cancel.log`, and Lab `probe-retirement-diagnostic-20261022.details.json`.
  The worker also explicitly retires after its completed receipt, before the
  parent publishes policy. A referenced embedding handle reproduces why waiting
  only for natural worker exit is insufficient (`backend-worker-retire-before.log`
  and `backend-worker-retired-gate.log`). The next 8120.0 functional run still reported
  `backend_config_pending` and zero model-interceptor callbacks. A separate
  diagnostic build subsequently observed both real workers completing their
  policy and routing-proof subprocesses and exiting normally. Worker failure
  therefore does not explain that later admission failure
  (`observe-metadata-worker-20261022.details.json`, owned run 025).
- Parallel Desktop/backend readiness could leave admission using an earlier
  backend snapshot. Admission now re-reads readiness, permits one verified idle
  recovery to refresh expired policy, and checks current Desktop/backend state
  before publishing capabilities. Pending requests and active turns still
  reject reconnection, and policy preparation cannot reconnect after its original
  deadline. Regression tests cover each ordering. Native run 028 still failed
  model routing: it found one verified connection constructor but zero observed
  instances. Its observer had 2,351 references and zero drops, ruling out the
  8,192-reference cap in this run.
- Constructor-only observation misses already-created connections. The verified
  incoming-message hook now records its actual receiver; repeated observations
  use a WeakSet to keep one weak reference per object. Tests reproduce both late
  observation and duplicate base/derived constructor registration before the
  correction and pass afterward. Observation failure cannot interrupt a Native
  message. Native run 029 still found zero instances during admission and failed
  the model-response transformation check. The observation correction alone does
  not resolve this gate. A bounded timeline in run 030 then showed admission
  finishing at 19.8 seconds, actual connections appearing at 20.8 seconds, local
  initialization completing at 21.8 seconds and policy readiness at 24.8 seconds.
  No later recovery occurred. Cold startup now waits for a local connection to
  initialize and become idle within the existing readiness deadline, then uses
  the same single verified recovery. Cancellation and deadline tests ensure the
  wait cannot start a late reconnect. Evidence: Lab
  `observe-connection-timeline-20261022.details.json`,
  `late-connection-before.log`, and `late-connection-after.log`. Native run 031
  then discovered two instances, admitted the one local process, reconnected it
  once and prepared its route. The full functional gate passed with two request
  and two response interceptor callbacks and the transformed history value.
  This Native gate used HTTP model responses; its one WebSocket attempt does
  not establish WebSocket frame interception inside Native.
- An explicit Native App Server restart preserved the test thread but lost
  model-response transformation. Native's own log confirms its restart command
  completed; interceptor counters remained at the seed turn's one request and
  one response. The current policy entry had been consumed by the previous
  launch, so the replacement started before asynchronous policy preparation.
  The verified connection restart hook now prepares policy while the current
  process remains alive, then delegates the original restart once. Failed
  preparation, owner retirement and a changed connection prevent that delayed
  restart. Unit tests reproduce the gap and verify these ownership boundaries.
  Evidence: Lab `native-backend-restart-20261022.details.json` (run 032),
  `backend-restart-before.log`, and `backend-restart-after.log`. An explicit retry
  after failed preparation performs a fresh probe while leaving the current
  process alive; it does not reuse a cached failure. Native run 033 passed its
  required functional gate after its confirmed restart, including transformed
  output in the original thread's history, normal shutdown and zero plugin
  errors. Its detail is 22 passed checks and one initial `workspace.surface`
  query marked unavailable. The subsequent workspace preparation and actual
  Split open/close succeeded. This unavailable query is retained as such.
- The explicit-source WebSocket fixture returned HTTP 502 with
  `proxy_resolution_failed`. Its synthetic HTTP response had not exercised
  upstream networking. The VM's system proxy resolver could not resolve the
  loopback destination; the offline acceptance environment now explicitly sets
  loopback `NO_PROXY`. Production proxy failure handling is unchanged. Evidence:
  Lab `core-functional-state-isolation-20261022.details.json`.
  On 8120.0 the corrected loopback environment passed explicit HTTP, SSE,
  WebSocket forwarding and both frame transformations
  (`core-functional-20261022-023-progress-011.details.json`).

Earlier desktop attempts used the unoptimized development binary. Their
functional/ownership observations remain evidence, but their startup latency
does not certify release performance. The dedicated `acceptance` profile uses
the release optimization level with test assertions enabled. The compile-time
prohibition on putting acceptance hooks into a release build remains in effect.

The functional fixture also needed current `thread/turns/list` queries, bounded
Desktop readiness polling, completion after report persistence, and handling of
the owned Native first-run dialogs. These fixture changes are distinct from the
Core/Split defects. Failed functional runs remain in the evidence set. A
functional run that stalls or fails is not promoted to a pass because startup
and shutdown succeeded.

The next functional coordinator exited on an unhandled TCP `ECONNRESET` from
the local fixture. Core subsequently reached normal exit 0 with zero plugin
errors; a later process inventory was empty. The fixture now handles accepted
socket resets and aborted request bodies, and final log readers permit Windows
write sharing. This incomplete run is not a functional pass
(`inspect-retired-worker-vm-20261022.details.json`). An ordinary-release attempt
also identified a staging mistake: the executable had been placed outside its
adjacent pinned Node runtime. It is now staged in the complete `bin` layout;
the failed attempt is retained as `plain-production-worker-20261022.details.json`.

The clean functional run `core-functional-20261022-014` passed 22 of its first
23 renderer/Desktop checks, including workspace preparation, navigation,
composer controls, toolbar, draft, task reads, streaming and interruption.
The model-response transformation check failed. Its progress reader also held
a report file without Windows write sharing, causing the observer's later report
write to fail; that run's watchdog shutdown is not a normal exit. The progress
reader now permits concurrent writes and final summaries escape non-ASCII
console output. Reports are retained in
`collect-functional-fourteen-b-20261022.details.json`.

The 50-cycle audit received 61 transient busy responses. Each explicitly stated
that the operation had not been submitted; the bounded retry then obtained a new
receipt. Uncertain receipts and timeouts are not retried. The first audit attempt
stopped at its initial busy response and is retained separately. These cycles
exercise Host/renderer registration and retirement; they do not claim successful
completion of the separate model/UI functional suite.

The first final-candidate lifecycle run completed all 150 operations, but its
aggregate rejected a last probe sampled during disable before the final enable.
The coordinator now waits for the exact generation from the final enable receipt
and one ready report node before requesting shutdown. The repeated 50-cycle run
recorded generation 101 ready, one node, normal exit 0 and zero plugin errors.
The original incomplete final-observation receipt remains retained separately.
An overly broad process inventory also matched the official Windows sandbox
service, which was started at 19:44 UTC before these tests. Its SCM registration,
image and creation time were verified; it is recorded as a baseline service,
not a per-run orphan. Evidence: `inspect-lifecycle-final-20261023.details.json`
and `inventory-final-core-output-b-20261023.details.json`.

## Desktop environment

The host restart and enabled Windows Hypervisor Platform were verified. The
owned Windows evaluation VM contains the exact target Store package. Two guest
inventory tasks completed, but the VM later stopped processing input and tasks
before Core was launched. Other QEMU/WHPX configurations failed during firmware
startup or with MMIO/virtual-processor errors. A QEMU 10.2 comparison also failed.
These observations do not identify a Core defect or establish a specific
hypervisor root cause.

The original VM is stopped. Its disk was converted to a separate VDI for
VirtualBox, preserving the original QCOW2. `qemu-img compare` completed with
`Images are identical` (lab `reports/qemu-vbox-disk-compare.log`).
Oracle VirtualBox 7.2.22 installation completed with exit code 0 and no required
host restart, using only the main application feature. The VM boots, accepts
keyboard input and completes queued tasks through the loopback fixture server.
The installer and extracted MSI have valid Oracle signatures.

The extended task runner later stopped polling. An orderly VM shutdown and
login restored execution. The recovery receipt records no running Native
processes and a guest clock within two seconds of the fixture server. The cause
of the earlier interruption remains unconfirmed; it is not a Core failure
verdict (`restore-runner-baseline-20261022.result.json`).

During the first worker-build run, progress and keyboard diagnostics stopped
returning. VirtualBox's time manager had accumulated about 960 seconds of
catch-up failures. An ACPI shutdown reached `poweroff`; the interrupted run is
recorded as an environment interruption with an undetermined Core outcome, not
a functional pass. Its reports and the timing log are retained; another recovery
preflight is required before the worker build's desktop verdict. See Lab
`core-functional-worker-20261022.result.json` and `vbox-worker-run-timing.log`.
Recovery subsequently confirmed that this interrupted attempt had stopped at
the first image-signature check, before creating Core's log or starting Native.
The restored guest clock was within one second of the host fixture server and
the runner resumed. The Store package had changed to 8120.0; the old Store image
was absent. The auto-started guest Native processes were separately cleaned up,
and the new package identity was recorded before re-running acceptance. These
recovery actions are not counted as normal Core shutdown or update continuity.

The first rc.12 MSI baseline attempt was blocked by the running-application
guard with helper result 1618 (MSI result 1603). Logs identify an official Native
process started by the guest Windows shell after login. No Core had been
started. That process had no main window; it and its owned descendants were
stopped inside the disposable VM to establish a clean test baseline. This
cleanup is not counted as a successful application-shutdown test. A retry
stopped before any MSI operation when its clean-process precondition failed.
The final clean run passed all ten installation scenarios.

Lab: `D:/codlet-vm-lab/native-adaptation-20261021`.
VM configuration and task scripts live in that lab's `tools/` and `inputs/`.
Reports and failed hypervisor attempts are retained in the lab's `reports/`
and the repository artifact directory above.

## Remaining acceptance

| Area | Required evidence | Current status |
| --- | --- | --- |
| VM baseline | Login, responsive desktop, task polling, orderly shutdown | Login/input/task execution verified; final ACPI shutdown reached poweroff |
| Production MSI | Clean user install, cancelled-upgrade rollback, upgrade, repair, downgrade rejection, user uninstall, machine install/repair/uninstall; preserve user data and restore machine PATH | Ten cases passed |
| Startup and shutdown | GUI-only first, then current GUI + Split; default startup deadline; renderer ready; no plugin errors; exit code 0 and owned processes exit | Final acceptance and ordinary release launch/shutdown passed; full functional and explicit backend-restart gates passed |
| Repeated use | 20 cold starts and 50 full reload/disable/enable cycles with explicit counters and failure records | Final 20/20 cold starts and 50/50 cycles passed; earlier and incomplete attempts retained separately |
| Native behavior | Service readiness, Working-state filtering, permission choices, split gestures, popup and titlebar interactions | Automated service, task, history, steering/interruption and Split toggle checks passed; manual permission, pointer and IME interaction remains unverified |
| Recovery and update continuity | Forced backend crashes, production resident and online provider activation, real Native state after restart, failure rollback | Explicit healthy-backend restart passed; forced crash recovery and whole-Native update continuity remain unverified |
| Soak | Eight-hour resource/process/error record, followed by cleanup and state checks | Not started |

The installed guest production Core is rc.13 at `C:/CodletLab/installed-user`.
The runtime smoke uses a separate current-source acceptance executable,
an ordinary user token, isolated profiles and a local synthetic API fixture.
It retains the default startup and signature deadlines and requires a clean
exit code of 0. The ordinary release executable has also passed its separate
launch/shutdown test; that does not certify a rebuilt installer or the full
model/UI suite.

The original rc.13 installer results do not certify a newly packaged startup fix.
The full functional gate passed in run 031. Sustained-performance,
update-continuity and soak acceptance remain incomplete. Owned test processes have exited after completed runs;
redundant runtime/backend copies are removed while reports, session data and
databases are retained (`cleanup-completed-core-runs-v2-20261022.details.json`).

Final component results and immutable evidence hashes are collected in
`.codlet-artifacts/core-acceptance-20261022/verification-summary-final.json`.
Final cleanup also removed superseded payload executables/archives and verified
225 downloaded-plugin/browser-component cache paths absent across 75 owned runs.
The first cache-cleanup operation completed its removals but failed while summing
its receipt; the separate verification receipt records the resulting state.
Reports, session JSONL and databases remain retained. See
`verify-retained-cache-cleanup-20261023.details.json`,
`cleanup-superseded-payload-20261023.details.json`, and
`superseded-host-candidates-committed-20261023.json` in the lab reports.

The final reconciliation checked 75 owned runs and found no remaining per-run
generated executables/profiles or owned test processes. The VM reached `poweroff`
after an ACPI shutdown, and the owned host fixture server exited. Evidence:
`reconcile-final-run-output-20261023.details.json`,
`verify-final-caches-and-storage-20261023.details.json`,
`final-vm-shutdown-20261023.json`, and `final-fixture-server-stop-20261023.json`.
The source snapshot and patches are saved under
`.codlet-artifacts/core-acceptance-20261022/final-source-snapshot-restart/`.
