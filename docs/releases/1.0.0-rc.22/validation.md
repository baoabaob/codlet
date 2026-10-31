# 1.0.0-rc.22 validation

**Windows x64 production acceptance.** Core source
`b32fc5e8e607a480f0b9c1ce1c788535eaed828f` was built with the release
profile and packaged as the native setup EXE. Desktop implementation `0.2.22`,
UI implementation `0.1.19` and optional GUI `1.0.0-rc.6` are included.
The exact installed Core passed the functional checks in run `47312` below.
Its original harness failure and separate successful update check are retained.

## Official client target

The reviewed Microsoft package is `26.1027.3384.0` x64, app `26.1027.30824`,
build `22943`. Its 1,004,631,986-byte MSIX has SHA-256
`d442a3d7d5c229f45e5e11995711ac2619c8dbc89e3fa2bc185287dc8db8e76e`
and a valid Authenticode signature. Its ASAR SHA-256 is
`6fbedf054a8d8cafaf5c745b40aa59176512e106e0bd6308275ae123b60fd074`.
Download, signature and static source review do not establish desktop acceptance.

## Acceptance catalog

The production Core retains the bundled offline baseline at revision
`2026102801` with its seven historical records and no `26.1027.3384.0` entry.
After installed acceptance, source metadata commit
`a32ece1d4fe7775f3b58d1e9e8dfbf0829da25d3` synchronized this branch's catalog
and baseline at revision `2026103101`, preserving the seven records and adding
the accepted package with minimum Core `1.0.0-rc.22` and Desktop `0.2.22` /
UI `0.1.19`.

That metadata commit prepares future builds; it does not rebuild this accepted
binary or change its embedded baseline. Publication of the fixed public `main`
catalog is a separate operation with its own receipt.

## Changes

The new Main entry uses a Webpack bootstrap and lazy CommonJS chunks. Core now
captures class bindings from the factory's own lexical scope after Native
executes that synchronous factory. Observation preserves its receiver,
arguments, return value and original thrown value; it never executes an extra
factory to discover a class. Lexical variable identities distinguish outer
bindings, lazy assignments and nested shadowing.

The current Webpack cache and exported object determine the captured module's
lifetime. Replacing a factory-table entry alone does not retire an existing
cached owner. Replacing the cache or exports retires its record and future
hooks. Accepted HTTP requests, sends, backend objects and routes retain their
original dispatch and completion. Closing the observer restores only the
wrappers it still owns, including their copied runtime-table entries.

Permission discovery verifies the actual wire-settings and canonical-mode
projections. The reviewed Working and official-update mappings include build
22943. These mappings remain separate from a passing acceptance record.

The Desktop adapter uses the current local AppScope's cached RPC manager and
request client. Initialization reads host identity and cached thread identities;
thread snapshots follow the selected Native route, mounted plugin views or an
explicit SDK request. Owner replacement, navigation and cancellation retire
Core-owned subscriptions, including late initialization receipts. Permission
updates await Native's actual acknowledgement. Approval snapshots retain the
current request identity and discard older asynchronous reads.

Each plugin/document startup receives its own existing request budget. Nested
operations retain their original transaction deadline, and an already queued
completion settles before a deadline error. Neither change extends production
time constants or replays an activation request.

The release also includes the post-rc.21 MSI handoff repair: Windows' shared
PowerShell executable is accepted as a read-only restart executable and its
digest is rechecked before launch. Mutable update payloads keep their strict
link checks. The earlier Electron upload-close correction remains present.

## Observer startup correction

The earlier `9635e3e` candidate completed MSI installation but its first VM
startup lost the source peer and timed out attaching the renderer. A separate
worker reproduced a five-second hello expiry while the actual unoptimized
Native chunk was being transformed. The optimized observer traverses AST nodes,
avoids scopes with no local bindings, and applies source insertions in one pass.
All three reviewed chunk outputs remain byte-for-byte identical. The worker
handshake now succeeds with the same five-second limit. The following
`425e7af` candidate connected the source and activated the Host in the VM;
Desktop activation then exposed the new RPC manager contract. The final
candidate includes that contract and the renderer budget corrections. Run
`47312` supplies its installed Native and Split evidence below.

## Source handshake and loaded-asset correction

The source facade and route reservations are installed before Native's entry
resumes. Its TCP connection now starts from the authenticated Core ready
operation, after the existing CDP pipe reader is live. Cancelling an unstarted
source rejects its original pending readiness and routes before runtime cleanup.
The five-second handshake, token validation and single-source admission remain
unchanged.

A controlled bridge/worker fixture held a Promise-imported startup stack for
6.2 seconds. Both eager connection and connection at the bridge's listening
event reached the server's original five-second hello deadline. Starting from
the owned ready operation created no socket during that stack and authenticated
immediately afterwards. The third VM logged `peer_closed` without server-side
accept/hello timings; this fixture establishes the scheduling defect without
claiming to reconstruct that exact close branch.

The `c386c4a` VM connected the source and verified its five roles, but the UI
page entry remained absent. Native's current entry imports its root module
dynamically; that module imports `initial` statically, and the `initial` URL
appeared in none of the document's preload, script or ResourceTiming entries.

The final resolver verifies the current entry's unique root import, the lexical
createRoot/render relationship, and the live public root/FiberRoot/DOM identity.
It reads only the static dependency graph needed for that mounted root, with
`shared` and `initial` as semantic endpoints. It preserves dotted module names,
rejects unsupported edges and ambiguous roles, and checks ownership and
cancellation across reads and cache reuse. Normal React current-fiber flips
retain the same root identity.

In the preserved VM session, a read-only graph probe read three modules totaling
12,217 bytes in 95.4 ms and matched their verified package hashes. It imported no
modules. A separate selector probe reused two cached Native namespaces, matched
rail and group components to the mounted Home ancestors, and completed in
104.3 ms. It invoked no React factory or Native hook, mounted no UI and performed
no business writes. The final installed smoke is recorded under run `47312`.

## Draft, transcript and shortcut correction

The `b0ec13c` VM mounted the UI entry, but its single new-draft request was
rejected with `ui_composer_unavailable` before a Native action ran. Source review
found the current action identifier begins with `$`; the earlier word-boundary
selector missed it. The final selector verifies the actual hook's free action
binding and retains the current draft owner.

The current root's `initializeApp` runtime now owns the relevant transcript,
settings and primary-module links. The old lookup expected those links directly
in Main or `initial`. The final discovery follows the root's bounded runtime
graph to the transcript wrapper/implementation and shortcut settings entry.
Repeated failed preparations retain their original error and a single source
read/owner proof; a replaced public root still retires that proof.

## Published notification correction

The `851c296` installed candidate created one Native draft and dispatched one
Send. Its first response completed, but the public event history had no
`thread.started` event. The complete cursor range was 1–15 with no gap. Native
had used a prewarmed thread: its formal creation publication reaches the current
window notification stream while bypassing the Main manager handler previously
observed by the adapter.

The window observer introduced in `723cd59` observes
Native's initialized window publication stream for thread, turn and item
notifications. It preserves the original envelope and synchronous delivery
order. Metadata and stream-role RPC subscriptions retain their existing paths.
The failed smoke's Send was not replayed. The later `f7` run received the original
published creation event; the current candidate retains that correction.

## Permission acceptance scope

The installed `851c296` read-only probes verified the selected main thread,
`threads.get`, turn/item pagination and `permissions.get`. The actual Native
permission menu exposes granular, guardian, full and custom modes. Its
server-default/source-unknown result is the real branch without an override.

This target exposes no read-only permission option. A read-only permission
mutation is unsupported and was not executed; no broader mode was substituted.
Permission-write acceptance is outside this evidence.

## Preceding candidate outcomes

Run `vm-20261030-64b44044-44c7-45c3-b933-4838a72a4721` installed the exact
`723cd59` setup over rc.21. The original setup reached `installed`, the MSI
transaction ended with status 0, and the installed Core hash, user scope,
installation folder, new ProductCode and registration matched the `723cd59`
candidate.
The outer controller exited 1 without its aggregate receipt; the original
installer and MSI terminal records were checked separately. Installation was
not replayed. The sealed-helper same-version maintenance check also passed,
including the system PowerShell executable with two hard links and CLI restart
status 0. Full release-selector installation was not covered.

Native startup then failed before renderer adaptation executed: CDP request 3,
`Target.attachToTarget`, exceeded its deadline and its outcome remained unknown.
Core had no managed renderer target. Its source connection, five roles, HTTP and
task configuration were healthy, and Native displayed its normal Home page.
No additional attach was issued and no business operation was dispatched; the
original owner was retained for diagnosis. The published-notification correction,
Native workflow, permission matrix and Split matrix were not reached. This run
does not pass full Native acceptance.

The disposable profile uses a synthetic loopback API-key backend. Real OAuth
account behavior was not validated. The prior `851c296` read probes and draft/
response evidence remain separate from the `723cd59` startup result.

After normal retirement of every `64b` owner, run
`vm-20261030-f7c85339-4e5e-46b9-8210-c4897d4aca13` started the same installed
Core with a fresh profile. It reused the original installation evidence without
reinstalling or repeating maintenance. Renderer bootstrap and the initial UI
entry succeeded. The original event subscription received `thread.started` at
cursor 3; one Native draft and one Send produced a completed first turn.

That run then exceeded its Native idle observation deadline. Core also reported
`desktop_scope_ambiguous: Native manager RPC has multiple owners`; their causal
relationship remains under investigation. No second turn, saved history, GUI/
Skills, sidebar, permission, Split or update-discovery matrix was completed.
The owner/session was retained without business replay or diagnostic attach.
The successful independent startup does not erase the preceding cold-start
failure or establish full functional acceptance.

## Local producer correction

The `f7` read-only owner probe found a manager producer and a derived family in
the same Native AppScope. They exposed the same HostClient and callable RPC
objects. The derived family had been counted as a second authority. The signed
Native constructors distinguish signal-family producers from readable-family
projections; Native itself reads the producer's current client.

`c7436bb` captures that producer's kind, scope, read/resolve identities, local
binding, HostClient, RPC and request client. Derived projections can change
without retiring it. Distinct producers remain ambiguous even if their values
alias. An explicitly unready producer cannot be promoted by a stale ready
projection, and malformed authority remains a contract error. Legacy synchronous
managers retain their object contract; callable RPC capabilities are not probed
through legacy manager methods.

The live probe established alias identities without manager/resolve calls,
subscriptions or business writes. The separate kind-only probe was not executed
after normal owner retirement because its guest source and runtime receipt were
absent. Kind semantics come from the reviewed signed constructors.

The `c7436bb` candidate's installed matrix ran under
`vm-20261030-5ed2ead4-ee7a-48c6-81c0-519229e311d7`. Its exact rc.21 setup
upgrade passed with controller exit 0, a complete aggregate receipt, installed
Core hash `50b851bf…`, MSI registration `1.0.522` and setup status `installed`.
Same-version sealed-helper maintenance also passed: helper/owner processes
exited, the system PowerShell executable retained its two hard links and exact
digest, and the requested CLI restart exited 0. Full release-selector installation
and a Native restart through that helper were not exercised.

Its first renderer session timed out on `Runtime.enable`. The original retirement
ended on an actual `session_ended` event, after which existing startup recovery
activated the renderer. No diagnostic attach was added. Native smoke, activity
idle/busy/idle transitions, first and second turns, history, saved-thread reopen,
workspace, GUI, skills, sidebar and Split checks passed. The synthetic loopback
API-key backend does not establish real OAuth acceptance. The permission-write
exclusion above still applies.

The final management gate returned a settled `runtime_update_network` error,
`error sending request`, while an earlier check in the same owner had succeeded.
A separate same-user probe found DNS/TCP connectivity and two successful curl
GETs. That different HTTP stack does not identify the Core failure's cause.
The generic original error does not identify its failed hop. With all network
settings unchanged, one new Core check settled
`upToDate`, current version `1.0.0-rc.22`, no error and no candidate. The original
failed matrix and the later successful check are retained as separate receipts.

## Explicit consumer cancellation correction

Two Split cleanup response-delivery errors in that run lacked request IDs and
methods, so their individual causes cannot be reconstructed. Independent code
review established that Core could still send a terminal response after the
same consumer binding/request ID had explicitly cancelled and removed its
pending entry.

`59341d5` checks the original live call's cancellation state and suppresses only
that call's terminal delivery. Ancestor cancellation, owner retirement, deadline
expiry and a rejected response do not provide that proof. The existing
after-response management action remains in place. Other response failures
retain diagnostics with request ID, method and fixed internal rejection reasons.
The `50b851bf…` results belong to the preceding binary. The new production
binary's separate installation and functional evidence is recorded below.

The first targeted build compiled successfully but three new tests could not
activate their consumer because the fixture provider lacked its required
`deactivate` export. The test-only `b32fc5e` correction completes that lifecycle
and checks activation diagnostics immediately. All four targeted commands then
passed, covering six host-RPC cases and three exact regressions. No production
implementation or frontend payload changed in that fixture correction.

## Installed final candidate

Run `vm-20261030-47312e60-4a70-4233-87e1-190b85dd4bc3` used the exact
`b32fc5e` setup and installed Core `c30f696c…`. Its actual user-scope rc.21 upgrade and
same-version sealed-helper maintenance passed with this binary. Setup reached
`installed`; MSI registration was `1.0.522`. Maintenance verified the system
PowerShell executable's two hard links and exact digest, and its requested Core
CLI restart exited 0. Helper and owner processes exited normally.

Native's source connected with all five roles. The first renderer session's
`Runtime.enable` request 5 exceeded its deadline. Its original retirement
request 6 reached `session_ended`, and the existing recovery activated the next
session. No diagnostic attach or business replay was introduced.

The installed functional evidence passed:

- Original Native draft/send and completed response, a second turn, Working
  idle/busy/idle transitions, published thread events, history/pagination and
  saved-thread reopen.
- Workspace, optional GUI, skills and sidebar classic/rail and grouping checks.
- Split Workbench integration and permission reads. The Core error log contains
  no `cleanup-failed` or consumer response-rejection error in this run.

The original harness result remains `failed`: its final explicit update check
settled with `runtime_update_network` / `error sending request`. After that
terminal receipt, the same installed Core and owner dispatched exactly one new
check. It settled `upToDate`, current version `1.0.0-rc.22`, with no error and no
candidate. Nine status reads observed that check; network settings and Native
business state were unchanged. The installation, functional checks, clean
response cleanup and successful new discovery check supply the release's
functional admission.

Both the preceding `5ed`/`50b851bf…` run and this `47312`/`c30f696c…` run
recorded the same generic transport error followed by one successful new Core
check. Their stored failures do not identify the failed request hop or
distinguish DNS, connection, TLS, proxy or another transport cause. The separate
successful DNS/TCP/curl probe in `5ed` used a different HTTP stack and cannot
resolve that cause. Neither run changed network configuration or product code
to obtain the successful check.

This VM uses a synthetic loopback API-key backend and the existing verified
Node `v24.21.0` pin staged beside the installed Core. Real OAuth, real account
settings, Statsig network behavior and a first-time Node download were not
validated. The Native menu has no explicit read-only
permission mode; that mutation was unsupported and not executed, and no broader
mode was substituted. Full public-release-selector installation and a Native
restart through the sealed helper were also not exercised; the helper check
used a Core CLI restart.

Normal Native File-menu Quit retired every owned Native/Core process and the
coordinator exited 0. The retained archive contains 394 verified files,
2,632,489 bytes, SHA-256
`1960a99bce5f996732ff1e57d7f36e312f6fc369ec3a6a8ac5dcfbc94626205a`.
Redundant runtime/profile/cache copies were removed, the installed `c30f696c…`
Core was preserved, and the final actual C/D storage checks passed.

`acceptance-scope.json` records `functionalAcceptancePassed: true` and
`originalMatrixPassed: false`. Its SHA-256 is
`2ec79b05959abe3cbcaf247ed526f8916167806a3d97585bcc9e6ec9edc9763c`.

## Component evidence

These groups belong to their recorded correction commits and freeze reports.
The final candidate's direct checks are listed separately below.

- The observer, bridge, Desktop HTTP and source handoff component gate passed
  **53** regressions. These cover one real factory invocation, return/error
  identity, early-return and throw terminal states, cache/export retirement,
  independent runtimes, lexical shadowing, replacement proofs and close cleanup.
- The HTTP cases retain response/error delivery after Writable upload close,
  original errors, cancellation and one dispatch. Accepted sends and source
  handoff retain the same backend objects and routes.
- An independent synthetic probe combined the actual observer and Desktop
  source with a real Node Writable using `autoDestroy`. It retired the factory
  after upload close and before the original response/error. Both cases used
  one dispatch, zero aborts and zero fallback fetches; the error case retained
  the same Error object. This is a fixture, not an Electron session run.
- The RPC manager integration passes **213** cases, with focused lifecycle,
  Desktop and final ownership/approval reruns passing **25**, **61** and **8**
  cases respectively. These cover selected-thread reads, navigation and child
  supersession, late owner retirement, actual permission acknowledgements,
  cancelled discovery cleanup and out-of-order approval snapshots.
- Four Rust fixture regressions pass: independent startup budgets across two
  plugins and two documents; an original completion queued during nested
  delivery; the original nested absolute deadline; and the existing management
  transaction/compensation deadlines.
- The handshake, source lifecycle and loaded-asset corrections pass **60**
  focused cases. Three checks using the actual Rust endpoint retain accepted
  exchanges across update, reject invalid credentials/paths/collisions, and
  preserve single-source admission and shutdown.
- The preceding UI graph and four consumer gate passed **266** related cases,
  including owner replacement, cancellation, cache reuse, Native Working
  retirement and cleanup. The unchanged Rust and handshake groups were not
  rerun for that UI commit.
- The subsequent draft, transcript, shortcut and runtime-graph change passed
  **126** related cases and **29** focused lifecycle cases. These are separate
  component gates, with their exact source artifacts recorded in
  `native-ui-draft-transcript-shortcuts-freeze.json`. The final installed
  production evidence is recorded separately under run `47312`.
- The published notification correction passed **84** related cases and a
  final **5** registration-failure cases. These cover original envelope/order,
  prewarmed creation publication, owner replacement, disposal and inert callbacks
  after a failed registration. These component gates do not establish acceptance
  of the next production binary.
- The producer-authority correction passed **108** related cases and a final
  **26** focused host-discovery cases. These cover derived aliases, genuine
  multiple producers, captured-owner replacement and the signed unready-state
  contract. The full Native matrix remains a separate gate.
## Final candidate checks

- The final Rust cancellation gate passed **9** cases across four commands:
  six host-RPC cases plus exact response-rejection, reused-request-identity and
  management after-response regressions. Every command used the actual managed
  target and passed its preceding storage check. These are direct fixtures,
  separate from the final installed Native matrix.
- Portable and MSI payloads each passed all **39** file hash checks. Setup's
  embedded MSI exactly matches the generated MSI, and production setup has no
  fixture-only members. Eight exact current source artifacts are embedded in
  the production Core: bridge bundle/bootstrap, client source, Desktop host and
  renderer, UI renderer, and both provider manifests. MSI structure checks
  passed without installation.
- Both provider renderers and manifests also match the final reviewed freeze's
  four exact size/hash records, verified from their bytes inside the Core.
- All **13** verified source/build inputs are also present byte-for-byte in
  the Core. The complete Rust include/build-input inventory resolved all 95
  unique inputs before the successful compilation.
- GUI rc.6 passed the publisher Ed25519 signature, signed archive, release
  declaration and payload checks. Its source is
  `809487346ad506bc8def5622723797d914e3c75e`; archive SHA-256 is
  `4cdee8226d4bafa69149ed95692ac2411114312f80b03b9eb39940d5d33a0b9b`.
## Release-tool evidence

- Earlier offline release plan/draft/publish tests passed with no external writes,
  including exact-commit tags, interrupted-operation recovery and tamper
  rejection. Chinese/English installer self-tests and zh-CN/en-US/de-DE actual
  window layout checks passed without installing software.

## Candidate identities

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Production `codlet.exe` | 26,870,272 | `c30f696ca84fe50aff5ec39227b9a93ca0a258349319fbca5eab6ffab74c592f` |
| `Codlet-1.0.0-rc.22-windows-x64.msi` | 8,896,512 | `5807fc65fdb2e4721bc7d65b9e440c4e4ad1e459e1466ab670ee615897b5bfe3` |
| `Codlet-1.0.0-rc.22-windows-x64-setup.exe` | 8,993,280 | `e05cfeb074d11b86694688b369c632fca150b5b47a9f4c710d3f1144485d48e6` |
| Full runtime `codlet-runtime-1.0.0-rc.22-win-x64-portable.zip` | 9,965,790 | `6f2756c1f012259eaabe582e75613f44928bc754ac9ff9f7295d3682d5b76eee` |

MSI numeric version is `1.0.522`, ProductCode
`{22CEC5C7-4665-5362-A33E-28E4670B2E9D}`. Setup and MSI are unsigned.
The production source is the commit above. Its embedded runtime skill document
and offline catalog retain that commit's bytes. Acceptance and publication
documentation is recorded afterwards and does not rebuild the accepted payload.
The managed runtime and both preview catalogs use a complete update package;
this release changes resident observer and Rust updater code and requires a
new start. It does not offer a targeted rc.21 online artifact.

## Upgrade path

Existing rc.20/rc.21 MSI owners must save their work, fully quit the client and
run the rc.22 setup EXE directly. Setup retains the registered folder, scope and
feature choices. The new handoff repair becomes active after rc.22 is installed;
it cannot repair the updater inside an already running older Core.

The preceding [rc.21 recovery](../1.0.0-rc.21/validation.md#completed-msi-recovery)
records a completed direct-setup upgrade with the installed Core hash,
registration, feature choices and ready Core/Native processes.

## Retained local evidence

`D:/codlet-vm-lab/delivery-20261031/rc22-b32fc5e/` contains
`core-candidate.json`, `candidate-receipt.json`, `build-result.json`,
`candidate-verification.json`, `embedded-source-verification.json`,
`freeze-artifact-verification.json`, `build-input-embedding-verification.json`
and `msi-structure/report.json`. `managed-source-inputs.json` records the exact
13 source/build inputs copied from the frozen full build without frontend regeneration.
`targeted-rust-gates.json`, `rust-gate-provenance.json` and the copied Rust freeze
bind the four passing commands to the final source. The preceding `c7436bb`
directory retains its initial compile failure with three missing ignored inputs
and its completed before/after inventory. The final release compile produced one
candidate used by every new package. `cargo-metadata-target.json` and the
storage receipts bind the actual managed workspace/target and D delivery output
to the original storage limits. The earlier release-cache relocation proof
remains in `rc22-723cd59/release-output-relocation-receipt.json`.

The native review directory retains
`observer-startup-root-cause-review.json`,
`observer-optimized-regressions.log`,
`native-manager-rpc-adaptation-review.json` and
`renderer-budget-regressions.json`, plus
`source-owned-ready-freeze-review.json` and its controlled scheduling probes.
`native-static-assets-final-freeze.json` binds the preceding UI source hashes,
targeted regression group and live read-only graph/selector evidence.
`native-ui-draft-transcript-shortcuts-freeze.json` records the subsequent
126/29-case correction and the final provider artifact hashes.
`native-published-notification-freeze.json` records the later 84/5-case correction,
the prewarmed thread evidence and the next frozen provider hashes.
`native-local-producer-freeze.json` binds the final producer authority change,
108/26 component gates, signed source semantics, live alias proof and the
unexecuted kind-only probe.
`renderer-explicit-cancellation-freeze.json` records the following Rust-only
correction and its unchanged frontend provenance. Targeted Cargo results are
retained in `delivery-20261031/rust-gates-b32fc5e/`; the preceding
`rust-gates-59341d5/` directory preserves the fixture activation failures.
The `next-native-acceptance-20261030/vm-20261030-64b44044-44c7-45c3-b933-4838a72a4721`
directory retains `acceptance-status.json`, `setup-upgrade-evidence.json`, original
installer logs, same-version maintenance output and the startup diagnostic
archive. It records the unaccepted Native scope and the preserved original owner.
The sibling `vm-20261030-f7c85339-4e5e-46b9-8210-c4897d4aca13` directory records
the subsequent startup, original published event, completed first turn and
unaccepted idle/owner scope in `acceptance-status.json` and
`startup-full-logs-1/001-adaptation-report.json`.
The later `vm-20261030-5ed2ead4-ee7a-48c6-81c0-519229e311d7` directory retains
the exact `50b851bf…` setup/maintenance receipts, functional matrix,
`network-readonly-1/` and `management-recheck-1-snapshot-1.json`. All owners were
normally retired and 390 evidence files were verified in its retained archive.
The final `vm-20261030-47312e60-4a70-4233-87e1-190b85dd4bc3` directory retains
`acceptance-scope.json`, `acceptance-status.json`, original installer evidence,
same-version maintenance output, the unchanged failed matrix, successful
`management-recheck-1-snapshot-1.json`, complete logs and the verified retirement
archive. Its post-VM scope report supplements the earlier packaging receipt.
Offline release and native-installer
reports remain under the preceding `rc22-9635e3e` candidate directory.
The parent delivery directory retains
`gui-publisher-verification.json`, `webpack-factory-audit.json` and
`factory-http-retirement-probe.json`.
