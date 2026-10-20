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

Package identities and completed native checks are added after the build run.

Manual Mac desktop/account/IME acceptance, clean-device Windows installation and
upgrade/uninstall, Windows code signing and Apple Developer ID/notarization remain
outside the automated package checks. Mac bundles use ad-hoc integrity signing.
