# 1.0.0-rc.20 validation

**Windows x64 local candidate: actual Native acceptance passed.** The same
ordinary production executable passed on both identities below. Core includes
UI implementation `0.1.18` and Desktop `0.2.21`; the optional GUI remains
`1.0.0-rc.6`. Remote rc.20 publication is not recorded.

| Native package | App / build | AppServer | Actual run |
| --- | --- | --- | --- |
| `26.1023.6123.0` | `26.1023.50603` / `22391` | `0.165.0-alpha.1.2` | `f1ff1011-b413-418d-a343-18e8cb8ada3e` |
| `26.1021.3705.0` | `26.1021.31345` / `21828` | `0.164.0-alpha.11.1` | `4738fa21-01a9-4f2d-a70b-97df9506872f` |

The production executable is 26,280,960 bytes, built with no features. SHA-256:
`da7dd047eb6608e5f91b7cad147a130eca079f5ef29860c88597752df714c351`.
`final-build-freeze-v2.json` binds the compiled source and generated inputs.

## Candidate changes

- Follow the mounted classic/rail sidebar across live layout changes while
  preserving plugin page leases and routes. Recognize the current rail tooltip's
  own defaults provider and reject unrelated or ambiguous insertion anchors.
- Resolve each new workspace action preparation against the current navigation
  owner instead of retaining an earlier preparation indefinitely.
- Map build `22391` working state, permission conversion, exact Windows bootstrap
  data and official-update selectors. Read the current permission picker's
  uncached return using its actual loaded hook, current objects and consumed
  fields; preserve Native's override ambiguity and confirmation gates.
- Recover initial CDP domain attachment only after the failed transaction's exact
  sessions confirm retirement, while the original Native process and connection
  remain live. An unknown business operation is not replayed by this recovery.
- Preserve complete terminal metadata and the source error when readiness fails;
  prevent a retired owner from starting or republishing readiness. Activation
  identity validation remains in force.

The [source adaptation record](../../native-adaptation-20261028.md) identifies
the reviewed package and interface changes. A Store notification naming
`26.1023.6621.0` does not extend this candidate's evidence to that package.

## Automated validation

- The downloaded x64 `.6123.0` MSIX passes Authenticode verification; the extracted
  snapshot records the app/build identity and exact ASAR hash.
- With pinned Node `24.21.0`, the integrated group completed 537 tests:
  **535 passed, 0 failed, 2 skipped**. The skips are opt-in official AppServer
  HTTP/WebSocket tests, not executed transport acceptance.
- The final generated bridge group passed **29/29**. Earlier focused navigation
  and permission groups are included in their respective input receipts; they
  are not added again to the integrated test count.
- **72 distinct Rust tests** passed: 37 runtime/session tests, 17 compatibility
  catalog tests and 18 activation/bridge tests. The original failing fixture's
  separate successful rerun is not an additional unique test.
- SDK type checking exited 0.
- Formatting and `clippy --all-targets --all-features -- -D warnings` exited 0.

## Actual Native VM acceptance

Both runs used a fresh synthetic profile, loopback model responses and ordinary
`codlet.exe launch`, with no acceptance feature in the production binary.
They completed real Native turns, observed idle/working/idle, read saved history,
reopened the same conversation and used the actual GUI/plugin page.

The permission read reached `ready` with `server-default`; Full access still
required confirmation. Shortcut preparation returned an available interface.
This is not physical-keyboard shortcut acceptance.

Each run performed four same-owner rail/classic transitions. Each plugin entry
remained unique; the registered page/root survived, the page opened, and the
original Native thread was restored. The actual Native menu changed **In one
list → By project** and restored the original selection and gate. **By connection**
was not exercised without an eligible remote owner.

The build `22391` log records an initial `Runtime.enable` request timing out,
then the exact failed session reaching `session_ended`, followed by automatic
generation-1 bootstrap and the complete functional run. No manual plugin reload
was used to recover it. Both runs finished with Native, Core and coordinator
exit codes 0 and zero remaining owned processes.

The original reports are the two `vm-20261028-<run-id>/adaptation-report.json`
files and their `core.err.log`/closeout receipts under the 2026-10-28 lab.
An earlier `client_launch_adapter_unconfirmed` attempt did not retain its
activation payload, so its actual trigger remains unknown. The separately
reproduced terminal-metadata and retirement defects have their own regression
evidence; the final passing runs do not establish that earlier trigger.

## Delivery scope

This candidate can be packaged for Windows x64. Installer structure/payload
checks and actual MSI installation or upgrade are separate from the Core/Native
VM checks above. The installer is unsigned unless an actual Authenticode signing
step is recorded; the GUI publisher signature does not sign the Windows EXE.
No rc.20 remote publication, official-client update, real-account/OAuth,
physical-keyboard test, macOS or Windows ARM64 acceptance is claimed here.
Earlier rc.19 evidence retains its original executable and Native identity.
