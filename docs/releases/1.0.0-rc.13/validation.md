# Codlet 1.0.0-rc.13 / Split Workbench 1.0.0-rc.3

Core source: `67da46836ade94727f19b4c79226443eb05b455b`.
Split source: `570fcfd` in the separate `codlet-split-workbench` repository.

This pair repairs cold-start service readiness, Working-state mappings and
permission discovery for Native build 21161. It also removes repeated DOM
attribute/style writes, yields between hidden-document workspace commits, bounds
popup interaction regions, and matches gesture cancellation to its pointer.
See [the source-contract review](../../native-desktop-20261021.md).

Validation completed:

- Core frontend: 422 passed, 2 skipped. Type checking passed.
- Split Workbench: 153 passed. Production renderer build passed.
- Source and runtime-package contracts: 16 passed. Both Native snapshots pass
  all 15 Desktop checks; they are source checks, not live UI acceptance.
- Consumer stress benchmark: 18/18 scenarios passed, including up to 8 panes
  with 2000 synthetic items and 4 streams. No additional layout/model work on
  token updates; counted resources release after cleanup. Native painting and
  operating-system input latency are outside this fixture.
- Setup/MSI, full runtime ZIP, rc.12-compatible online payload and both update
  catalogs built. All six release assets pass local draft/publish validation.
- The actual rc.13 setup passes its payload and UI self-test, including upgrade,
  maintenance, downgrade, scope and feature handling. `installationPerformed`
  is false.

The online payload updates `core-ui-provider` and `core-desktop-provider`, retaining
the rc.12 resident. Online activation has not run. The full installer is ready
at `.codlet-artifacts/split-runtime-health-20261021/windows-2/release/`.

Current-host status is `not_running`; installed Core remains rc.12. Native build
21161 is running. The existing disabled Split registration points to
`X:/codlet-split-workbench` and validates as rc.3 after rebuilding that source.
Importing a copied installation failed with `managed_storage`: the existing
package-ID directory belongs to another source. It was not overwritten; the
registration remains on its original development path with its existing grants.

No rc.13 MSI transaction or current-client latency/interaction acceptance has run.
After installing the new Core, start Native through Codlet and enable the existing
Split registration to check entry readiness, activity filtering, permission
choices, sustained dragging and Native titlebar behavior. The rc.3 package ZIP
is also retained in the artifact root for later distribution.

Reports, failed attempts and the consumer benchmark are retained under
`.codlet-artifacts/split-runtime-health-20261021`; delivery hashes and outcomes are
in [evidence.json](evidence.json).
