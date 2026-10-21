# 1.0.0-rc.10 — Native source adaptation

Core rc.10 adapts workspace discovery and input ownership to Windows Native
package `26.1013.4894.0`, internal app `26.1013.40934`, build `20770`.
The source workflow, contract changes and reproducible commands are documented
in [Native source adaptation](../../native-source-adaptation.md).

## Implementation

| Repository / component | Source commit |
| --- | --- |
| Core rc.10 | `20140eea07eefc188f5f221eb61b246b94dfa5d2` |
| Split workbench rc.2 | `5e185a49f9695a8940cd6c4c210db3f7eed6a91b` |
| Functional consumer rc.2 | `9312b844b04abe58556a3d293e9c1e8dc99d5b14` |
| Bundled official GUI rc.5 | `518227467a11931bc1177ea5fe9799d66483a967` |

Core resolves moved scopes and factories across module namespaces, follows
keymap query/getter/consumer bindings, and resolves both local and imported
viewport writers. Main input selection verifies its Native controller and draft
namespace, excluding independent request-card editors, and matches retained
editors against the current route. Navigation readiness triggers a fresh surface
scan. The split entry waits for critical interfaces and reports optional
shortcut failure independently.

The functional consumer inventories 219 contracts/scenarios and separates
source, simulated, interface, read and operation evidence. Reading a snapshot
does not mark the reported capability usable. Restored observations keep their
original build identity and are historical.

## Evidence

| Layer | Result and boundary |
| --- | --- |
| Captured source | 281 current workspace modules; all 28 roles located; 27 Core workspace source checks and 4 main-process source roles pass |
| Cross-build comparison | 34,479 mapped bindings; 5 mechanical renames, 3 relocations, 2 reviewed interface changes, 2 reviewed behavior changes and 16 unresolved comparisons |
| Core Node tests | 776 pass; 5 skipped |
| Core Rust tests | 828 pass; 8 ignored |
| Split consumer | 150 pass |
| GUI and functional consumer | 135 pass |
| Type checking and build | TypeScript check, Core frontend/release build and split bundle pass |
| Live Native, candidate definitions | 13 read-only interface/ownership/surface checks pass; connection and focus retained; zero roots mounted, routes changed, drafts read or messages sent |
| Installer | MSI structure and actual setup EXE self-tests in Chinese and English pass; payload hash verified; installation not performed |

The baseline contains only two preserved renderer files from package
`26.1007.9446.0`, app `26.1007.71326`, build `20398`. Missing old modules and
unmapped external relationships remain unresolved. Equal normalized syntax is
not semantic equivalence. [Native role locations](native-roles.json) retain
both sides' ranges and hashes; [review decisions](../../../codex/compatibility/native-source-reviews/26.1013.4894.json)
bind the manual classifications to those exact declarations.

The live probe evaluates the candidate Core definitions against the running
Native instance. The resident Core remains **rc.8**; this is not an installed
rc.10 lifecycle run. Full split entry/select/exit/reload, physical IME and
attachment acceptance on build 20770 remain unverified. The desktop harness
requires a disposable Windows VM. Source matching of network/stdio/connection
roles also does not prove that live traffic hooks are attached.

A disposable Windows VM was subsequently installed. Four interaction attempts
stopped in executable-signature preflight or the Native launch bridge; no
interaction check passed from those attempts. The host's Windows Hypervisor
Platform was enabled with user approval, and Windows requires a host restart
before hardware-accelerated acceptance can continue. The selected runtime,
different Store registration, timing reports and remaining cases are recorded in
the [VM evidence](../../native-source-adaptation.md#disposable-windows-vm-evidence).

The installed functional consumer was updated to rc.2 and its read-only run
completed on the resident rc.8. Its report shows **2 operation verifications
(RPC request/provide), 12 read verifications, 4 unavailable capabilities and
201 unverified items**. Workspace surface/preparation and both Native traffic
sources appear as unavailable. The current source identities, coverage and
checks are in [evidence.json](evidence.json).

## Delivery

Local outputs are under
`X:/codlet/.codlet-artifacts/native-adaptation-20261021/`:

| Artifact | Location | Bytes |
| --- | --- | --- |
| Windows setup | `windows/Codlet-1.0.0-rc.10-windows-x64-setup.exe` | 8,588,800 |
| Split plugin | `delivery/dev.split-workbench-1.0.0-rc.2.zip` | 159,064 |
| Functional consumer | `delivery/functional/compatibility.acceptance-1.0.0-rc.2.zip` | 28,842 |

Setup SHA-256:
`9e488f14f792c77a1ad4faf5821bd8ef9c21b35d1577e4c723eea273d262f734`.
Full package hashes, source commits and the 39 verified portable payload entries
are recorded in `verification.json` and the committed evidence file.
The split ZIP's 31 files and functional ZIP's 9 files match their prepared
source bytes. Temporary probes were removed; their reports remain available.
The MSI and portable directory are internal packaging inputs.

The rc.9 installer retains SHA-256
`3d934d9a816546425d543f1f6e10fd4be0f3309aca385bc20f78f3793d72bd26`.
Its signed GUI rc.5 bundle is reused unchanged and its signature was reverified.
No public release was published. The Windows setup remains unsigned.
The ICE61 build warning reflects the existing same-version repair policy.

Install rc.10 and start Codlet again when the current daily session can be
closed normally; then update the split plugin from its rc.2 package. The daily
Native process was not closed or restarted for these checks.
