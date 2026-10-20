# 1.0.0-rc.9 signed plugin update manifests

Review date: 2026-10-21. Windows candidate with optional GUI **1.0.0-rc.5**.

## Changes

All plugins use the same [signed update manifest contract](../../spec/plugin-updates.md).
Automatic and manual checks read static public files and compare versions locally.
Plugins sharing a feed use one request; separate feeds use at most four concurrent
downloads. Verified results persist for six hours across restarts. Manual refresh
retains a one-minute minimum and server retry times. A failed refresh preserves
the previous result and its original timestamp, with the error visible in the GUI.

Each new release includes `codlet-update.json` inside the ZIP and a signed
`codlet-updates.json` Release asset. Core pins the publisher's Ed25519 key in the
installation receipt and verifies the signature, repository, ID, version, ZIP size
and SHA-256 before replacement. Existing permission and transaction checks apply.
Missing or invalid feeds never cause an update check to fall back to the REST API.

The shared Node publisher generates and verifies both files. The runtime `/codlet`
skill includes the tool, schema and publishing instructions. GUI packaging and
distribution reject missing or invalid signatures and fixture signing keys.
A fixed raw-file channel supports prereleases; publication advances that channel
only after all referenced assets are public. Merging preserves other plugin
entries and the newest stable and prerelease version for each ID.

An older installation without a pinned signing key can use its previously
recorded GitHub repository and owner identity during an explicit first migration.
That migration can use the REST API. Later signed updates download public files
directly. Marketplace searches and initial GitHub imports retain their existing
API paths.

## Verification

- Rust `cargo test --locked --features test-fixtures`: **827 passed, 8 ignored**.
  One subsequently added migration regression test passed, for **828 distinct
  passing tests**. It verifies key enrollment and rejects a changed repository
  identity.
- HTTP fixtures cover **20 independent repositories: 20 file GETs, zero REST API
  calls**. Rechecking valid persisted caches makes no network requests. Twenty
  plugins sharing one feed make one request. Tests also cover ETag/304, stale
  results, retry intervals, cross-feed rate-limit pauses, rejected API redirects,
  altered signatures and end-to-end signed installation.
- The generic publisher's **4 tests** passed, including Node/Rust signature
  interoperability. The GUI's complete **131-test suite** passed in a clean
  checkout of the recorded source.
- Strict Clippy for all targets with test fixtures and the frontend typecheck
  passed. PowerShell publisher tests passed for asset verification, channel
  publication order, idempotency, source ownership and invalid-signature refusal.
- Windows MSI structure checks and the actual setup's Chinese and English
  self-tests passed. The **39 distribution payload hashes**, embedded MSI,
  GUI archive, signed feed and bundled public-key source all verified.
- Optional uninstall cleanup of the new metadata cache passed in an isolated
  filesystem and credential fixture.

Reports and logs are retained under
`.codlet-artifacts/plugin-manifests-20261021/`; `verification.json` records package
identities and installer check results. Installer self-tests performed no
installation. This candidate does not include a new live Native startup benchmark
or a live public-channel update test.

## Distribution

Core source: `baoabaob/codlet@71e9dddbdf39dc23f4e9d1054e79d1e443b16f6b`.

GUI source: `baoabaob/codlet-plugins@518227467a11931bc1177ea5fe9799d66483a967`.

| Package | Bytes | SHA-256 |
| --- | ---: | --- |
| `Codlet-1.0.0-rc.9-windows-x64-setup.exe` | 8,551,936 | `3d934d9a816546425d543f1f6e10fd4be0f3309aca385bc20f78f3793d72bd26` |
| Internal MSI | 8,470,528 | `fdb1486c709060118115f662bc67c37a2fc74d0dc446e53145b4f06138c9cddd` |
| `codlet-gui-1.0.0-rc.5.zip` | 73,887 | `da57e8118b9fd1cf4706d46f4f5565d2e455d13565458bd11f1d7bf37217a9db` |
| GUI `codlet-updates.json` | 752 | `9a0b7aff0606ab48fbc2e9363290fafd91a4a11069079945670cd7f5197f3c28` |

The Core executable SHA-256 is
`8215eb99573928614d80a4d2bd5a67e5a1af94994b42d0fd2c53746dd7a61bb4`.
The MSI product version is `1.0.509`. The Windows installer is unsigned.
The installer and its verification receipts are in `windows-final/`; GUI packages,
release assets and the prepared distribution plan are in `gui/`.

These local candidates have not been uploaded or installed. The prepared GUI
channel URL is
`https://raw.githubusercontent.com/baoabaob/codlet-gui/codlet-updates/codlet-updates.json`;
it becomes usable after publishing the corresponding release and channel file.
The latest macOS package remains 1.0.0-rc.7.
