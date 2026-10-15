# Core-owned Codex implementation

UI, Desktop, Native launch hooks and their discovery/probe modules are maintained
here as part of Core. They are compiled into the executable; no adapter package
installation is required. Historical capability API 1 names and provider IDs are
compatibility aliases. Core catalog ownership prevents legacy installed adapters
from competing with these implementations while preserving their user records.

`PROVENANCE.json` is the unchanged historical import inventory from
`baoabaob/codlet-plugins`, based on commit
`da7c0ea3f151532522b654341db7f8ef0ac5e1f8` and the preserved local snapshot.
Its hashes describe the import, not today's maintained tree. The import and
removed files remain recoverable from Core Git history (including implementation
commit `9a40546`). Unused upstream GUI/release tests, standalone package metadata
and duplicate public declarations have been removed; current public declarations
live in [`../types`](../types/codex.d.ts). The Apache-2.0 license, notices,
implementation, compatibility profiles and workspace probes remain here.
Build-generated bundles include third-party notices.

Install dependencies only with `npm ci --prefix frontend` from Core. Run
`node frontend/build-codex.mjs`, or the standard frontend build, to regenerate
embedded sources. `codex/frontend/package.json` only preserves the ESM boundary
and delegates build/test commands; it has no separate lockfile or installation.
Run `node codex/test.mjs` for all maintained implementation unit tests. Native
tests remain opt-in and must never target a user's daily instance.

[`scripts/README.md`](scripts/README.md) describes Core-owned Native research
drivers. [`tests/fixtures/workspace-acceptance`](tests/fixtures/workspace-acceptance)
retains the original owned probes, including probes that were untracked in the
preserved pre-import workspace. The full functional consumer is maintained once
in `codlet-plugins/tests/fixtures/runtime-compatibility/consumer`; this tree keeps
only its historical explicit Native driver and read-only sampler.

`context.codex` is defined in [`../types/codex.d.ts`](../types/codex.d.ts). Its standard facade uses Core
capability admission and generation-scoped cleanup; callback and DOM handles
stay local. Capability probing reports each supported feature independently.
Profile declarations and verified client/platform evidence remain separate from
runtime availability. Windows fixture results do not establish macOS acceptance.
