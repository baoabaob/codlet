# 1.0.0-rc.23 validation

**Windows x64 production upgrade and page/health acceptance.** The R3 setup
passed an upgrade from published rc.22, and its installed Core passed the page
and health stages below. Scroll and drag-region changes have focused regression
and live Native evidence. The final exact Split package's independent cold-start
matrix was not executed after the VM environment failed; it is not recorded as
a pass.

## Candidate identity

The binary was built from Core
`ba1ecd6afb122cc1aaaf1ec6b0942c80819368bc` with the release profile and default
features disabled. It includes Desktop `0.2.22` and UI `0.1.20`. The installer
offers optional GUI `1.0.0-rc.7`, built from plugin source
`287721ea97e20cad11e82e79803379b6e939ce2b` with the existing publisher key.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Core executable | 27,109,376 | `51287f132ad25b911856de724997e78e1179af9ba073fbb1623a19533e710c2f` |
| Windows setup EXE | 9,013,760 | `3ac2512fa904ff6840922f609b34c519878bcfcb3c458708149eb07180226f0d` |
| Windows MSI | 8,916,992 | `be51de6441a1b82eef3c159a7ad4c8f307956070e90b556864a33f9290ae5591` |
| GUI rc.7 ZIP | 77,641 | `90d3794e126280fc048195882ddb60a45d928530b10032acbd384c7599dcfe02` |
| Portable runtime update ZIP | 10,032,843 | `e0b5f45deda05709a57db39485d44fb1f88852ca010525b9b54345e57c1413ac` |

The official client target is Microsoft package `26.1027.3384.0` x64,
app `26.1027.30824`, build `22943`, matching the signed package recorded in the
[rc.22 validation](../1.0.0-rc.22/validation.md#official-client-target).

## Changes

- Page registration returns an accepted lease promptly. `page.ready` settles
  after registration, and the current lease owns its pending state, result and
  errors. Cancellation and owner retirement prevent late completions from
  modifying a newer page.
- Native toolbar discovery follows the mounted root's `initializeApp` runtime
  graph to the primary module. It no longer depends on a primary-module URL
  appearing in the initial module. Resource reads and registration writes retain
  their current owner checks.
- Core reports renderer failures and current diagnostics separately from the
  enabled preference. GUI rc.7 shows health and operation errors on the affected
  plugin, refreshes active diagnostics, and clears resolved errors.
- Transcript restoration uses Native's owned scroll controller and virtualizer
  to preserve follow-latest state or a semantic history anchor. Fractional
  viewport sizes use the computed border-box size when converting coordinates.
- Plugin viewport drag regions are scoped to the owned embedded surface. The
  final Split stage also checks its outer scrolling container.

## Build and focused checks

The 95 recorded Rust include/build inputs match the frozen source. All 14
required generated/runtime/provider inputs were found in the binary. Portable
and MSI distributions each match all 39 declared payload files. The setup's
embedded MSI, product constants and production-only members match the candidate;
the MSI structure check passed without performing an installation.

The complete portable updater contains the exact Core executable and managed
Node descriptor. Both payload hashes and its manifest were verified. Its
Windows preview channel files and checksum summary are prepared locally.

The final page regression set passed 90 tests; the final workspace regression
set passed 78. GUI's 115 fresh-SDK checks and the two Rust diagnostic export
checks were retained from R2: the six subsequent changed paths are confined to
Native discovery/navigation/scroll implementation and their tests. Rust source,
public SDK/types and the clean plugin source commit are unchanged. The reused
GUI archive was reverified against its signature, seven package files and 36
distribution-source files.

## Production Windows upgrade

Run `health-20261102-ce727488-de86-4ea1-96ac-80dfe727f524` first removed the
temporary R2 rc.23 lab installation and restored published rc.22. The published
setup SHA-256 is
`e05cfeb074d11b86694688b369c632fca150b5b47a9f4c710d3f1144485d48e6`.
The restored executable matched rc.22, and the R3 production setup then upgraded
that installation successfully with exit code 0. The user scope and existing
installation directory were preserved. The installed executable matched
`51287f13…` before the cold Native run.

Earlier lab attempts to replace different rc.23 bytes under the same version
encountered Windows Installer SecureRepair. Those receipts remain separate.
This candidate's successful installer evidence is the rc.22-to-rc.23 upgrade.

## Installed page and health acceptance

The same run used the Core-owned SDK/CDP target and session. The driver accepted
its page lease at 9.88 seconds and reached readiness at 34.76 seconds. The
functional plugin's cold page appeared once, with its actual Native
HeaderToolbar component `cCt` and the reviewed source marker.

The functional plugin's single idle reload completed as `applied`, moving from
generation 1 to 2. Afterward the target contained one entry and one lease. Its
read-only checks completed with zero failures. `workspace.surface` and the
owned backend provider route reported `unavailable`; interface checks do not
claim business operations for those paths.

The original matrix remains `failed`. Its observation code called `.includes`
on the structured `renderer.error` value and threw before the next assertion.
It also contained an incorrect diagnostic-field lookup. The preserved report is
`acceptance-report-before-continuation.json`; the completed functional reload
was not repeated.

An independent health continuation read the real renderer and diagnostic
fields and completed the remaining stages:

| Stage | Result |
| --- | --- |
| Activation failure and active diagnostic | The affected plugins reported failed/active health, with scoped GUI details |
| Diagnostic resolution | One resolution dispatch changed the current diagnostic to `resolved` |
| GUI reload of `dev.health.reload-error` | One click, operation suffix `0002`, completed as `rolled_back` with the error on that plugin |
| GUI reload of `dev.health.diagnostic` | One click, operation suffix `0003`, completed as `applied` |
| GUI reload of `dev.health.reload-error` after recovery | One click, operation suffix `0004`, completed as `applied` |

`pre-split-health-completion.json` records all six requested page/health stages
as covered at `2026-11-02T11:47:43Z`, with zero model requests before Split.
The continuation report SHA-256 is
`58f2906cb4595b91b96ef41c88bf36a1fc8cffefce8d349493cde6438915835f`.
The reports and five screenshots were copied from the guest and verified by
file hash. The three GUI screenshots show only the first three list rows;
the failure/recovery targets are below that viewport. Those target-row results
come from the report's DOM row snapshots and Core operation receipts.
This stage result does not replace the failed original matrix.

## Offline plugin update rehearsal

A separate VM profile exercised the local update procedure while the installed
R2 Core was stopped. GUI rc.6-to-rc.7 used the official seed preview/install
transaction. Its official receipt, signed update source, disabled preference and
revoked grant were preserved. The functional plugin's rc.2-to-rc.3 update used
its existing `clientPermissions` and executable selection, with all current
grants unchanged. The private Split source advanced by a verified fast-forward.

The four mutation receipts completed, all nine stored data files retained their
hashes, and a second execution made no changes. Dirty Split source and an
unresolved receipt each stopped the procedure. A separate functional profile
with a revoked declared permission was rejected by the CLI before mutation;
the procedure did not restore that grant.

The tested helper SHA-256 is
`eb8debe56b1bea67936584bd61846eadf2815b0409d47ad5eb31600603a01d93`.
The original R3 helper differs only in its expected Core hash and has SHA-256
`b88550d7b810f67c7724cd2176b2c9a6d8663d3a4dabaad05f77acf6bf111629`.
All 88 retained evidence files were verified; their archive SHA-256 is
`8672e25cdd9af366bef251ea2a719c15e098bdccd1b7ed61554cd8b476d5a3bb`.
Owned test processes exited, and redundant guest/host profiles, clones and
portable Git copies were removed. The user's active installation was not
updated during this rehearsal.

The final local delivery retains that transaction flow with the final Split
commit, renderer and bundle pins. It also selects the first Git Application in
PowerShell's command resolution order: the actual host exposes two Git
executables. The selected executable matched implicit `git` resolution and
returned `git version 2.55.0.windows.3`. The final bundle was verified, fetched
and fast-forwarded from the baseline in a separate generated clone; the resulting
renderer hash matched. The final helper's plan-only check passed against the
user's existing registrations. Its SHA-256 is
`36373f46c613ac3c61fa9b319e386ab1ae60b3442798f08778dda1533a33b92a`.

## Split evidence and unexecuted scope

The final private Split rc.8 candidate uses source
`d25fa931e85a964bff64bc6f319273932a2a7532`. Its 167,667-byte package has SHA-256
`68addadd2ff3ad7ce250529dce795bfc9a029fcd47688ece621cb99f9d50916d`;
its 168,446-byte renderer has SHA-256
`178e3877acbb07da131315f91bc211fb91f9f90d590bc6178b3454ce1df64d62`.
The 9,033-byte private Git bundle advances the retained baseline to this commit
and has SHA-256
`6cfd087746c64e5d13a2e7467a339f09127bac64853009df70d229c3d714010e`.
Its focused build/test set passed 157 tests.

The scroll implementation passed 78 focused tests. In the real Native owner,
controller and virtualizer probes exercised follow-latest and semantic history
anchors. A module comparison corrected a 37-pixel restoration error to zero by
using the computed fractional border-box height instead of integer
`offsetHeight`. The installed R3 Core subsequently reached four ready Split
panes with the four retained synthetic conversations.

At outer-stage scroll position 156, 21 computed `no-drag` rectangles intersected
the Native caption strip at y=0..36. Applying the candidate CSS in the same
Native owner reduced those intersections to zero across 5,427 computed-style
observations. The Native header retained `drag`, and external popups retained
`no-drag`. The final d25 source and packaged CSS bytes match that tested change;
the embedded CSS SHA-256 is
`d976f370c3363bc67a85cdec29fc519a807dd8e7d436bc45af877218741d63e8`.
After removing that CSS literal, the compiled renderer JavaScript is byte-for-
byte identical to the preceding rc.8 renderer. This is source/CSS/geometry
evidence, not a physical window-drag test.

The single live import operation
`6102698354ded20c9ca4b2839fc90a84-0000000000000005` completed as `rolled_back`.
A state-snapshot `Runtime.evaluate` request reached its deadline on a secondary
target, so the old generations were retained and admission resumed. The main
target still had Split generation 1, four ready panes and the preceding CSS.
The operation was not replayed and did not establish activation of the final
d25 renderer. A later optional probe has an unconfirmed outcome and was not
replayed.

A separate cold continuation was prepared to use the exact final package and
retained profile. Guest-control and heartbeat failures interrupted the lab
environment; the replacement 6GB VM failed again before the new Core test
started. The final cold matrix therefore never began. Its end-to-end checks of
initial tail position, pane resize/history retention, hidden restoration,
content growth, cancellation, owner retirement and outer-stage geometry remain
unexecuted for the exact final package. No passing final renderer generation is
inferred from the package hash or the earlier CSS comparison. The consolidated
Split evidence review has SHA-256
`85a0ae6c462590a42b938b6f776d48db3f8ac3c90f03f0661656d0392a96b611`.

The original R3 input manifest retains the preceding Split package identity;
the final local delivery composition is recorded separately with SHA-256
`346e37fde0cb95d990392baade4e773c0e9cde1261d7d6424643b9a42263f73b`.
The Split source/package and its local helper are not public Core or GUI release
assets.

Physical window dragging was not performed. Source, CSS and geometric checks
do not establish the result of a physical drag. macOS, Windows ARM64, true
upstream model/OAuth traffic and other unexecuted system interactions remain
outside this Windows VM evidence.

## VM termination and publication

At `2026-11-02T14:07:32Z`, an explicitly authorized administrator helper
terminated the original R3 VM's owned host `VBoxHeadless` process, PID 11932.
This was forced hypervisor-process termination, not Native Quit; normal exits
of the individual guest Core and Native processes were not verified.

Four VDI/configuration/NVRAM backup files were verified by hash. Only the VM RAM
setting changed, to 6144 MiB, before the headless restart. That guest failed
before the new Core acceptance or final cold matrix began. At
`2026-11-02T14:46:27Z`, one `VBoxManage controlvm poweroff` call returned 0.
The final receipt verified `VMState=poweroff` and host PID 23588 exited. Its
SHA-256 is
`6c871eb7fe24f73a44bb61e772b3101f27e623939c03152dc2f43b32bd9c8a8c`.
These records establish that the guests stopped, not a graceful application
shutdown. Frozen-disk evidence is retained separately from product acceptance.

Core and GUI publication use the fixed hashes above and the completed scope in
this record. Documentation and source-history reconciliation do not rebuild the
binary. The Rust health export changes take effect on the next Core launch.
Installed Windows versions upgrade through the matching setup; the complete
runtime ZIP serves existing portable installations.
