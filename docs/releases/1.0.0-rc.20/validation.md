# 1.0.0-rc.20 validation

**Windows x64 preview published; actual Native acceptance passed.** The same
ordinary production executable passed on both identities below. Core includes
UI implementation `0.1.18` and Desktop `0.2.21`; the optional GUI remains
`1.0.0-rc.6`.

| Native package | App / build | AppServer | Actual run |
| --- | --- | --- | --- |
| `26.1023.6123.0` | `26.1023.50603` / `22391` | `0.165.0-alpha.1.2` | `f1ff1011-b413-418d-a343-18e8cb8ada3e` |
| `26.1021.3705.0` | `26.1021.31345` / `21828` | `0.164.0-alpha.11.1` | `4738fa21-01a9-4f2d-a70b-97df9506872f` |

The production executable is 26,280,960 bytes, built with no features. SHA-256:
`da7dd047eb6608e5f91b7cad147a130eca079f5ef29860c88597752df714c351`.
`final-build-freeze-v2.json` binds the compiled source and generated inputs.

## Release changes

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
`26.1023.6621.0` does not extend this release's evidence to that package.

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

## Public release verification

[v1.0.0-rc.20](https://github.com/baoabaob/codlet/releases/tag/v1.0.0-rc.20)
was published on **2026-10-28 at 13:59:19 UTC** as a public preview
(`draft: false`, `prerelease: true`, release ID `426663608`). The tag resolves to
source commit
[`0fb5febc6bf02003be92f336afaed42166f097de`](https://github.com/baoabaob/codlet/tree/0fb5febc6bf02003be92f336afaed42166f097de).

All five canonical GitHub release download URLs were fetched without
authentication, followed to `release-assets.githubusercontent.com`, and checked
against the release plan's sizes and SHA-256 values and GitHub's asset digests.
The retained `public-verification.json` records `passed: true`;
`publication-receipt.json` records the published release identity.

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `Codlet-1.0.0-rc.20-windows-x64-setup.exe` | 8,878,592 | `5b8d9562138f9e405d98153e375b6b9e128e031dbc2f5edff21a994deb0d801e` |
| `codlet-runtime-1.0.0-rc.20-win-x64-portable.zip` | 9,843,142 | `a026cbc45779bceaf3c9bdec204ed76ca31154afa757d654eca69f6e06428a25` |
| `codlet-update-managed.json` | 561 | `dc6c4232f0c1685774a4bc91ee4665e042564a2afd9f90b320f66bc73a1b865d` |
| `codlet-update-managed-v2.json` | 561 | `4d45c7d93db6841c1727eb3a20db15b275f23fd8b4bdb8109c57dffcf219d1c2` |
| `SHA256SUMS.txt` | 410 | `36250cba6810dec28645294c9acafad54b8cd7353e32437050123d91c468ae18` |

Both update catalogs declare the `preview` channel and the complete
`win-x64`/`portable` runtime package. The setup EXE is the Windows installation
and MSI upgrade download.

The public
[tested-client catalog](https://raw.githubusercontent.com/baoabaob/codlet/main/compatibility/tested-client-versions.json)
was also downloaded and verified: revision **2026102801**, seven records,
SHA-256 `51c3a27335ba49b16ace830f1a6d6558264a82840b31588c731e4b0409f14bdf`.
It requires Core `1.0.0-rc.20`, Desktop `0.2.21` and UI `0.1.18` for
`26.1023.6123.0`. The `26.1021.3705.0` record retains its rc.19 minimum and adds
the verified rc.20 pair.

## Delivery scope

The Windows setup EXE is unsigned; the GUI publisher signature does not sign it.
Published downloads and installer structure/payload checks are separate from
actual MSI installation or upgrade. The rc.19 in-app Core update, MSI
upgrade and joint official-client/Core update have not yet been exercised;
the ordinary Core/Native VM runs above did not exercise those transactions.
No real-account/OAuth, physical-keyboard, macOS or Windows ARM64 acceptance is
claimed here.
Earlier rc.19 evidence retains its original executable and Native identity.
