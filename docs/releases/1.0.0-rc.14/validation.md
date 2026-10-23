# Codlet 1.0.0-rc.14 validation

The Windows release integrates the startup, backend reconnection, event delivery
and plugin readiness corrections from the [2026-10-22 acceptance run](../../core-acceptance-20261022.md).
It adds reviewed Native mappings for builds 21421 and 21477. The
[adaptation report](../../native-adaptation-20261023.md) records the exact source
contracts and signed Native package identities.

## Release identity

| Item | Identity |
| --- | --- |
| Core build source | `b0bd54be27b1b227239b09e17445650241e78e48` |
| Core version | `1.0.0-rc.14` |
| Ordinary release executable SHA-256 | `e5371f25ccb960a439c55d27656a9e0a9108b1acf7a92fc1922b6241ccbb754a` |
| Acceptance executable SHA-256 | `28c6162bb6de2ec815df4244ed52cc0ce45d0f50ec9c7a4ce952480f8dae9d36` |
| Setup EXE SHA-256 | `ba922ee3d484e72baf2c286025e0b1bb9c2fd35f21f992c6f814a6e782495e4d` |
| Embedded MSI SHA-256 | `e3928a3295a9cc0977fad5c32ba11c630a24460c3f7502fca7574cced86da196` |
| GUI | `1.0.0-rc.5`, source `518227467a11931bc1177ea5fe9799d66483a967` |
| Split Workbench runtime | `1.0.0-rc.4`, source `ba94a6ecbec975ba11f9a68d840768f28f7b82d4` |
| Split renderer SHA-256 | `f53f7c8b2a55a2a159a098f4888ad1c5d1da4077a073773097e51ed9b4cdb4b2` |

The ordinary executable is the release profile with no acceptance feature. Its
bytes are identical in the installer, portable distribution and production smoke
run. Later documentation commits do not replace these release bytes.

## Native versions

| Windows package | App version / build | Validation |
| --- | --- | --- |
| `26.1016.8120.0` | `26.1016.61520` / `21421` | 27 workspace and 15 Desktop source checks; the preceding acceptance campaign used this package |
| `26.1016.8622.0` | `26.1016.62342` / `21477` | 27 workspace and 15 Desktop source checks; current release desktop checks below |

The latest package was installed in the disposable VM through Windows package
deployment. The installed ASAR hash, OpenAI executable signature and package
identity match the reviewed official download. A running sandbox service first
caused deployment to roll back with `0x80073D02`; after stopping that owned VM
service, deployment succeeded and the service was restored with the new image.
This is evidence of a stopped-client package upgrade, not session continuity
across an official update.

## Automated checks

| Check | Result |
| --- | --- |
| Rust, all targets and all features | 846 passed, 0 failed, 8 ignored |
| Core frontend on the pinned Node runtime | 398 passed, 0 failed |
| Embedded Native adapter tests | 442 passed, 0 failed, 2 skipped |
| Both final Native profile mappings | 21 passed, 0 failed |
| Split consumer tests | 159 passed, 0 failed |
| TypeScript, Rust formatting, Clippy with warnings denied | Passed |
| Release contract and native installer UI checks | Passed |
| Final packaged setup self-test | Passed |

The complete suites ran on the integrated rc.14 source. The additional 21421
catalog entry was then covered by the 21 final profile tests, which enumerate
the update and Working mappings. Rust and consumer runtime code did not change
after the complete suites.

Local logs and build manifests are under
`.codlet-artifacts/native-release-20261023`. Desktop receipts are under
`D:/codlet-vm-lab/native-adaptation-20261021/reports`.

## Windows desktop and installer checks

| Check | Result | Receipt |
| --- | --- | --- |
| Production MSI lifecycle | Baseline reset and ten install/upgrade/repair/cancel/downgrade/uninstall cases passed; data sentinels retained and machine PATH restored | `rc14-installer-20261023.details.json` |
| Ordinary production launcher on Native 21477 | GUI and Split entries visible, both adapters and plugins active, ordinary desktop user token, normal exit 0, no remaining owned processes | `rc14-production-retry-b-20261023.details.json` |
| Native functional gate | 23 renderer/Desktop and 12 Host checks passed; request/response transformation reached thread history; steering, interruption, Split open/close and one lifecycle cycle passed; normal exit 0 and zero plugin errors | `rc14-functional-20261023.details.json` |
| Explicit Native App Server restart | Original thread readable after the restart; 23 renderer/Desktop and 12 Host checks passed, Split open/close and one lifecycle cycle passed; normal exit 0, zero plugin errors, no Native remainder | `rc14-backend-restart-retry-20261023.details.json` |

[Compact receipts](desktop-receipts.json) bind the scripts and original report
hashes, list the individual checks and retain the earlier failed restart attempt.
The model operations use a local synthetic response fixture in isolated
conversations. Split entry checks open an empty workbench; they do not repeat
the older multi-pane interaction campaign.

The first production run retained a ready Core status but its test observer
rejected the new dated run directory. That run was interrupted after VM clock
lags and is not a pass. The rerun corrected only the observer's owned-directory
guard. A stale scheduled task from the interrupted run was removed before the
successful rerun; the release executable did not change.

The first backend-restart run completed the Native restart and subsequent
conversation operations, but one Host fixture stopped reading when
`workerDone` became true. Process completion does not empty buffered stdout or
stderr; the status can change between a read and the following status request.
The fixture now waits for EOF from both output streams before asserting their
contents. The rerun read all 13 stdout and 4 stderr bytes, observed zero buffered
bytes and passed the full gate. Only the fixture changed; the failing report
remains `rc14-backend-restart-20261023.details.json`.

Each completed desktop run was followed by an owned-process check and cleanup
of copied backend executables, downloaded runtime/plugin caches and temporary
profiles. Reports, session logs and databases are retained. The final receipt
records no Native, Core or owned Node processes and the restored sandbox service
using package `26.1016.8622.0`.

## Distribution and scope

GUI rc.5 is published with its signed update manifest. Public downloads and the
raw update feed were fetched again and matched the recorded byte lengths and
SHA-256 hashes. The package ZIP hash is
`da57e8118b9fd1cf4706d46f4f5565d2e455d13565458bd11f1d7bf37217a9db`.

Use the full setup EXE to upgrade MSI installations: this release changes
resident Core files. Windows packages are unsigned. The release contains
Windows x64 artifacts only.

The preceding campaign's 20 cold starts and 50 lifecycle cycles remain separate
evidence. They were not repeated as a new endurance campaign on Native 21477.
Physical IME input, attachments, dragging latency, macOS, long-duration soak
and uninterrupted sessions through an official Native update are outside the
current release checks.
