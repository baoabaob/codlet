# 1.0.0-rc.18 validation

Windows x64; Native package `26.1021.3705.0`, application `26.1021.31345`, build `21828`. Includes UI implementation `0.1.16`, Desktop implementation `0.2.20`, and optional GUI `1.0.0-rc.6`.

## Workspace detection and Native limits

The reported split-workspace failure occurred with a valid 259-level committed React ancestry. Core stopped at 256 levels and treated the main input as unavailable. Ancestry now follows committed parent/child relationships with identity-based cycle detection. Stale, disconnected and cyclic references remain rejected.

The audit also removed fixed traversal, history, hook, source-size and declaration-count cutoffs from Native discovery, permissions, working-state detection and source parsing. Native initialization follows owner cancellation and actual readiness; optional working-state preparation no longer blocks the thread list. Existing Native input and requests do not inherit plugin payload or concurrency budgets. Plugin-owned resource and transport framing limits remain separate.

A read-only probe in the running client recognized all 259 ancestors, the main input, its draft and composer scope, and matching route ownership. It also found Native's actual 20-pixel download glyph and notification badge. The temporary probe was removed. This probe did not switch workspaces or install the new Core into the running client.

## Update behavior

The GUI tracks available Core updates while its page is closed and sets the navigation badge. Its header offers download, status and version information. Joint updates require the exact prepared Native package identity and a published verification for the candidate Core version. A changed target invalidates prior consent.

Direct official updates show a cancellable confirmation with a persistent “Don't show this again” preference. Accepting the update still proceeds if saving that preference fails. Joint updates use the verified setup EXE for MSI installations, retain installation scope/features, and wait for the official update result and old processes to exit before handing over to Windows Installer.

## Checks

- 140 focused JavaScript tests passed, including deep/cyclic ownership, large Native histories and inputs, source discovery, update guards, target identity, MSI handoff and page lifecycle.
- 33 final GUI interaction tests passed; header and settings confirmation paths return focus correctly. The broader available GUI tests passed earlier; the separate functional-fixture suite cannot run in the working checkout because its consumer fixture files are absent.
- Rust: 16 compatibility tests, 4 settings tests, 1 official-update owner test and 32 runtime-update tests passed. Four isolated/opt-in entrypoints were not run by those filters.
- 27 decoders passed against captured bytes from the exact Native build. Core SDK type checking passed.
- The native installer compiled. Light/dark GUI rendering and both confirmation dialogs were inspected using the actual Core UI bundles with simulated update state.

The joint-update handoff tests use owned process/file fixtures. No real official MSIX update or MSI upgrade was performed during this validation. Installer packaging and read-only installed-product preflight are recorded in the release receipts.
