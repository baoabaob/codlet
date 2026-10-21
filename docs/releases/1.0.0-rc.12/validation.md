# Codlet 1.0.0-rc.12 validation

This release adapts the official update service and keymap query to Native build
21161 (`26.1016.51333`, Store package `26.1016.6573.0`). Build source:
`860aa33963b980ceafc089e669169eacffd0104f`.

The installed rc.8 reports `runtime_update_not_published` when checking its
configured channel. Its official update probe also lacks a matching profile for
the running Native build 20770. The new exact profiles resolve the existing
update selector and the service that moved to the shared renderer module.

The new Native query factory accepts an options callback and returns keymap data
directly. The shared offline/runtime query contract now recognizes that form,
while retaining lexical binding, returned-data, scope and uniqueness checks.
The [source review](../../../codex/compatibility/native-source-reviews/26.1016.6573.json)
records both declarations and their hashes.

Validation completed:

- All 28 workspace roles located in the new snapshot; 27 Core source checks pass
  against both build 20770 and build 21161.
- 26 source/update tests pass. Core frontend suite: 409 pass, 2 skip. Rust official
  update test: 1 pass.
- Complete setup/MSI, full runtime ZIP, rc.8-compatible UI online payload and both
  update catalogs generated in one build. All six release assets pass the local
  draft/publish checks.
- The actual rc.12 setup passes payload, version/maintenance/downgrade and UI
  self-tests; `installationPerformed` is false.

The online payload updates `core-ui-provider`. The resident official-update
bridge is compiled into Core and needs the complete installer upgrade. No actual
Native hot activation or rc.12 MSI transaction has run. The current host remains
on rc.8 and Native build 20770; the new Native source was read from the staged
Store package. Unresolved dependency changes remain in the source comparison.

The owned VM and report server exited. Reports, source snapshots, delivery
packages and hashes are retained in
`.codlet-artifacts/native-update-workflow-20261021-2`. Machine-readable results are
in [evidence.json](evidence.json).
