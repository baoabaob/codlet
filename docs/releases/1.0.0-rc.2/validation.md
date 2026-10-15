# 1.0.0-rc.2: client capability integration

## Fixed behavior

The installed rc.1 Core rejected backend `0.162.0-alpha.17.2` because its complete
file digest was absent from the recorded list. It also missed the entry module:
Node had compiled that module before Core installed its CommonJS observer. The
combined source failure suspended Core's Desktop provider and ordinary consumers.

rc.2 makes executable identity separate from interface admission. Unknown binaries
must pass actual app-server initialization, configuration and account reads, plus
readback of the provider overrides needed for the launch. Unlisted source modules
can supply uniquely identified classes whose method contracts match the integration.
The already compiled entry is captured from its paused lexical frame.

A missing traffic source no longer suspends independent Desktop read/write services
or a plugin merely because it holds a traffic permission. Plugins use Core's live
capabilities without specifying a client fingerprint. Source updates retain the
previously active capability set or roll back. The [contract](../../spec/client-compatibility.md)
describes discovery and operation ownership.

## Verification

- Rust all-target/all-feature suite: **804 passed, 9 ignored**; strict Clippy passed.
- Core Node suite: **347 passed**.
- Codex implementation suite: **380 passed, 2 skipped**. The skipped cases require
  separately selected official AppServer fixtures.
- Startup recovery tests: **6 passed**, including preservation of Core Desktop
  consumers and ordinary traffic consumers.
- Real Core catalog migration CLI: **2 passed** with `ipc-test-isolation`.
  This test feature uses independent Windows endpoints and is rejected by release
  builds; it keeps the production catalog and migration behavior.
- Public SDK TypeScript check passed.
- The real inspector test captures and hooks a class in the already compiled
  entry module after resuming the same process. The IPC suite preserves the live
  process, streams and operation receipts across source handoff.
- The actual Windows backend with SHA-256
  `e98c516f1c8935789aabe9122ee7e05ec4c3efd1ba6acf179242e031c495b99e`
  remains absent from the recorded list and passed runtime contract probing. A
  separate run of the production spawn hook automatically owned this backend and
  read back both built-in and custom provider overrides; the child and reserved
  routes were retired. These runs use fresh synthetic profiles and read-only RPCs.
- The actual extracted client source resolves all four private roles through the
  structural method checks without using its filename/hash mapping: network `tr`,
  desktop fetch `ple`, Stdio `Gs` and connection `mB`.

Recorded evidence: [backend contract](backend-contract.json),
[automatic backend launch](backend-auto-launch.json), and
[private source contracts](native-source-contracts.json).

Detailed local outputs are under
`.codlet-artifacts/capability-compatibility-20261015/`. The backend auto-launch
check uses a local route-service stub and starts no model turn. It verifies the
production launch function with the real backend, not a complete Electron session.

## Production restart acceptance

The entry capture correction changes the resident bootstrap and bridge. Install
the complete rc.2 package and start a new Codlet session for it to take effect.
This change cannot repair the already missed entry frame in a running rc.1 session.

Full production-desktop restart acceptance is pending. The existing managed
Codex window must close before the production launcher can start its replacement.
Acceptance must identify the installed rc.2 executable, its new Native process,
automatic backend source activation, Desktop capability readiness and ordinary
plugin activation. It must not enable the private fixture source or substitute a
`desktop-acceptance` executable for the installed Core.

The rc.1 Windows Native stream and macOS packaging records remain evidence for
their original artifacts; they are not rc.2 desktop acceptance results.
