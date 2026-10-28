# Repository ownership

Core 1 owns the Codex integration. The UI and Desktop Adapter repositories are no longer development or distribution dependencies of the current product.

| Repository | Maintained responsibility | Release role |
| --- | --- | --- |
| [codlet](https://github.com/baoabaob/codlet) | Rust Core, CLI, public SDK, Codex UI/Desktop implementation, Native profiles and probes, runtime skill, installers | Core applications and compatible Core component updates |
| [codlet-plugins](https://github.com/baoabaob/codlet-plugins) | Ordinary first-party plugins: management GUI and the complete functional acceptance consumer | Builds GUI packages; acceptance consumer is packaged separately |
| `codlet-split-workbench` | Independent split-workbench source, tests and consumer evidence | Local versioned plugin packages; no GitHub remote is configured |
| [codlet-gui](https://github.com/baoabaob/codlet-gui) | Generated GUI source snapshot and release metadata | GUI distribution destination; edit its source in `codlet-plugins` |
| [codlet-ui-adapter](https://github.com/baoabaob/codlet-ui-adapter), [codlet-desktop-adapter](https://github.com/baoabaob/codlet-desktop-adapter) | Historical source snapshots, tags and Release assets for older Core installations | Retired from the v1 build and publisher plan; retain downloads and history |

The two Adapter distribution repositories can become read-only archives after the replacement Core release is available. Existing installations may still refer to old download URLs; retain those assets. Current package and publication status is recorded in [release readiness](release-readiness.md).

## Directory map

Within Core:

- `src/`: Rust runtime, CLI, platform and session ownership.
- `runtime/` and `frontend/src/`: Host runtime, Core component entrypoints and public renderer SDK.
- `codex/`: the single maintained Codex UI/Desktop implementation, client profiles, Native drivers and contract tests.
- `types/`: public TypeScript declarations. There is no second public declaration tree under `codex/`.
- `bundled/runtime/`: hand-maintained renderer runtime sources plus ignored UI/page bundles. `codex/bundled/` keeps compatibility manifests; renderer/Host bundles are generated and ignored. `runtime/core-modules/` is generated from these same sources for updates. Run `node frontend/build.mjs` before Rust; do not maintain a second copy of generated code.
- `tests/` and `scripts/`: Core regression and delivery tools; `codex/scripts/` contains the migrated Native diagnostics.
- `docs/spec/`: current contracts; `docs/releases/<version>/`: immutable release identity and validation records; `docs/history/`: dated research and retired Adapter records.

Within the plugin source repository, `frontend/src/codlet/`, `bundled/codlet/`, `tests/` and `scripts/` maintain the GUI and its release tools. The complete functional consumer has one source at `tests/fixtures/runtime-compatibility/consumer/`. Native provider sources, profiles, probes and duplicate types have been removed from that repository; their maintained copies are in Core.

The split workbench remains independently buildable. Its `src/`, `dist/renderer.js`, current documentation and tests belong to that repository. `docs/verification/` holds versioned Native evidence; `docs/history/` preserves earlier experiments. Existing `releases/<version>/` packages are never rewritten during source cleanup.

## Build and migration rules

Core builds using its root `frontend/package-lock.json`; `codex/frontend/package.json` only supplies the ESM boundary and delegates commands. It has no independent dependency installation. Run `node codex/test.mjs` for the maintained UI/Desktop suite.

GUI tests explicitly snapshot the matching built Core SDK with `scripts/prepare-core-sdk.mjs`. The ignored snapshot is a test input, not a maintained fork. Core does not require a sibling plugin checkout to build. The optional GUI and split workbench consume the public `context.codex` contract and remain independently reloadable.

Keep the existing plugin IDs and registered installation paths when upgrading consumers so their saved storage identity remains stable. Core preserves old Adapter registrations, grants, preferences and data while preventing duplicate providers. Do not delete those user records to reflect the source-tree cleanup.

The historical import inventory in [codex/PROVENANCE.json](../codex/PROVENANCE.json) records the original code import. The [document archive](history/README.md) records the later documentation moves. Current candidate identities and actual verification scope remain in the [release validation record](releases/1.0.0-rc.20/validation.md); a directory reorganization is not a new Native acceptance run.
