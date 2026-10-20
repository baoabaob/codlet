# 1.0.0-rc.7 review and delivery

Review date: 2026-10-20. This candidate updates the plugin authoring workflow,
generated-source policy and macOS distribution. Packages remain unpublished.

## Changes

- Source projects use `projects/`; Core-managed installation copies use `packages/`.
  The runtime skill builds and updates copies explicitly, preserves data and enable
  preference, and chooses routine defaults instead of blocking on setup questions.
- Generated bundles are rebuilt by one frontend command, including the source
  parser and online-update modules. Clean builds no longer use committed duplicate
  bundles. Source, attribution and historical acceptance records remain tracked.
- Mac packages accept an optional GUI bundle with separate source provenance.
  Installation uses Core's existing verified seed transaction, matching Windows.
- The Mac update helper accepts the already verified current Native Node for an
  unchanged candidate runtime contract; it still verifies every recorded file hash.
- Mac build/test entrypoints check the development storage budget. CI builds all
  embedded JavaScript before Rust compilation.

## Native review

The installed app's updater returned `up_to_date` for 26.1013.40934, build 20770.
The Windows package is `OpenAI.Codex_26.1013.4894.0_x64__2p2nqsd0c76g0`.
The public [Mac update feed](https://persistent.oaistatic.com/codex-app-prod/appcast.xml)
lists the same frontend version, published 2026-10-16. The downloaded archive's
identity and hashes are recorded in `tests/fixtures/native-macos.json`.

The previous cache profiles remain compatibility inputs. The latest Mac Node
has a different hash, so native acceptance exercises the runtime contract path.

## Verification and artifacts

Both packages were built from Core `de37f59870288b6084199d9d5e89138c8b5b2749`.
The optional GUI is **1.0.0-rc.3**, independently built from
`baoabaob/codlet-plugins@e3f1e984350df895a5f7adf2a12b505469a5e5ca`.

| Installer | Bytes | SHA-256 |
| --- | ---: | --- |
| `Codlet-1.0.0-rc.7-windows-x64-setup.exe` | 8,556,032 | `753eea1841b24ce41e6672d1a0073ed7779ad608937c5df8a0e8300378aad311` |
| `Codlet-1.0.0-rc.7-macos-arm64.dmg` | 8,331,234 | `27bf8302b5022f1e4630390043eaa1432147d106a57ee2f7ec985365bcf13902` |

Local delivery root: `.codlet-artifacts/release-review-20261020/`, with `windows/`
and `macos/` installers, checksum files, distribution manifests and verification
receipts. The Windows MSI and portable ZIP are retained as internal build inputs.
Mac update/legacy transition ZIPs are also retained. Release assets were not published.

Windows checks:

- Strict Clippy and frontend typecheck passed. The complete Rust suite passed
  **824 tests**, with 9 explicit opt-in/platform cases ignored. The production
  catalog migration passed another 2 tests; current installed Native Node reuse
  passed its opt-in test.
- Node **24.21.0** passed **354 Core JavaScript tests** and **384 Codex tests**
  (2 opt-in tests skipped). An initial run under the unsupported local 24.18.1
  hit a V8 inspector crash; the complete suite was rerun with the locked runtime.
- The release CLI exercised source project → copied install → source edit →
  explicit update → disable → uninstall, confirming the source project survived.
  Both PowerShell and Python skill wrappers preserved the intended data scope.
  Skill frontmatter validation passed.
- MSI structure, actual Chinese/English setup layouts, native self-tests and
  **38 payload file hashes plus 6 GUI files** passed. No installation was performed
  on the working machine. The installed Native source and Node hashes match the
  October 18 review; no new interface change was found in those paths.

macOS checks ran natively on Apple Silicon in
[Actions run 39356089997](https://github.com/baoabaob/codlet/actions/runs/39356089997):

- Clean checkout frontend generation, Swift typecheck, strict Clippy and
  **462 Rust tests** passed; 3 opt-in/platform cases were ignored.
- Current official client **26.1013.40934 / 20770** passed signature, CUA Node
  identity, Host flags/modules, 43 Host/launch JavaScript tests, and the real Core
  runtime resolver test. The GUI/account was not launched.
- **15 initializer tests** and **8 packaging tests** passed, followed by a real
  signed update-archive Rust check and native update replacement/rollback cases.
  Managed updates used the current Native Node whose hash is absent from the old
  cache profiles, exercising the rc.7 regression fix.
- The DMG passed integrity verification, read-only mount, launcher smoke test and
  fresh real-Core GUI initialization. Local verification checked all **35 app
  files**, update ZIP file hashes/modes and Core/GUI source provenance.
- Windows and Mac GUI builds differ only in source-file and embedded CSS/SVG line
  endings; content and permissions match. Each package has its own verified hashes.

The downloaded Actions artifact was 59,767,215 bytes with SHA-256
`55fb7c7bdb23a56093b5358385da398afb9a758b59a0dec59c7e43cf542e34f7`.

## Repository and architecture review

Tracked file content decreased from **15,930,145 to 11,078,354 bytes** at the
implementation commit (about 30.5%). Twenty-four generated files moved out of Git;
the build regenerates them from maintained sources and pinned dependencies.
No history rewrite or license removal was needed. Later evidence-only documentation
adds a small amount to that snapshot.

Inactive prior project/test outputs and the downloaded Native review archive were
cleaned after their checks. The development target returned from approximately
7.75 to 5.51 GiB, and no owned build/test process remained. Logs, manifests,
validation reports and useful delivery packages were retained.

The eager prelaunch bridge is retained: enabling a later plugin can require
modules that load before application entry. Removing it based only on the initial
plugin list would break this behavior. Renderer-only plugins still do not need
an additional per-plugin Host process. See [architecture](../../architecture.md).

Manual Mac desktop/account/IME acceptance, clean-device Windows installation and
upgrade/uninstall, Windows code signing and Apple Developer ID/notarization remain
outside the automated package checks. Mac bundles use ad-hoc integrity signing.
