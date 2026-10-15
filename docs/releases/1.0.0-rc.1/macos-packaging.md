# macOS 1.0.0-rc.1 packaging

On 2026-10-15, [build 38687170643](https://github.com/baoabaob/codlet/actions/runs/38687170643) completed successfully on native Apple Silicon. It built Core commit `0778c70fcb331fbb1c7a3a85f26499199f4e17ba` from `codex/macos-v1-20261015`. The package requires macOS 13 or later. This is an unpublished candidate; no public Release or daily-client installation was performed.

| Artifact | SHA-256 |
| --- | --- |
| `Codlet-1.0.0-rc.1-macos-arm64.dmg` (8,208,018 bytes) | `5718e3af400ac180badb38a0c4e68451b39497f3f7e2b7af67e7e922032e4a9b` |
| `Codlet-1.0.0-rc.1-darwin-arm64-update.zip` | `21e2ac1365e92f50ea040e31978b7dc2f50d7531b4530c93c66382505816ad8e` |
| `Codlet-1.0.0-rc.1-darwin-arm64-legacy-update.zip` | `1171f8d3dc799a8e95f0a8ef00aa04b38037c6c4603dc4b60f136ca8d3415381` |

Local delivery is under `.codlet-artifacts/macos-v1-20261015/`, with the native distribution manifest, GitHub run/log receipts, independent archive verification, checksums and the matching optional GUI ZIP. GitHub artifact `11951675200` has SHA-256 `17f23852700f0c22335feb3f6f66c404b5ae63f29cf488547e2f0b04744cee98`; the downloaded archive matched it.

## Validation

- Strict all-target/all-feature macOS Clippy and Swift typechecking passed.
- Rust all-target/all-feature suite: 446 passed, 3 explicitly ignored, 0 failed.
- Mac initializer Node tests: 12/12; Python package checks: 6/6.
- Reviewed official CUA Node: signature, executable/license hashes, Host ABI and 43 Host tests passed. The real Mac runtime resolver passed its separate explicit test.
- The sealed app passed signed update staging, legacy/managed replacement, scoped owner waiting, rollback and runtime preparation failure checks. The signed archive also rejected an online portable-component declaration.
- `hdiutil verify`, read-only DMG mount, launcher smoke and real Core initialization passed. Local verification confirmed ARM64 Mach-O binaries and all 58 files, hashes and POSIX modes across both update ZIPs.

## Repairs and limits

The first run, [38685249687](https://github.com/baoabaob/codlet/actions/runs/38685249687), failed strict compilation because Windows-owned Native update fixtures were compiled on macOS. Commit `f1c69a7` limits those private lab paths to Windows; 8 existing Windows fixture tests passed.

The second run, [38686173602](https://github.com/baoabaob/codlet/actions/runs/38686173602), passed strict compilation but ran two Windows portable online-update tests on Mac. Commit `0778c70` gives those fixtures their proper Windows scope and extends real signed-Mac archive validation to reject online-component claims. Existing Windows updater regressions passed 26 tests, with 1 explicit child entry ignored by the outer suite. Production update behavior was not relaxed.

The app has an ad-hoc integrity seal, no Apple Developer ID signature and no notarization. These build/CLI/package checks do not establish actual Codex GUI, real-account/conversation, physical-input, split-workbench or Intel Mac acceptance. Full macOS application updates remain next-start-only. The optional GUI candidate is delivered separately; the stable online plugin channel does not supply this unpublished rc.1.
