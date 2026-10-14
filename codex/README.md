# Core-owned Codex implementation

UI, Desktop, Native launch hooks and their discovery/probe modules are maintained
here as part of Core. They are compiled into the executable; no adapter package
installation is required. Historical capability API 1 names and provider IDs are
compatibility aliases. Core catalog ownership prevents legacy installed adapters
from competing with these implementations while preserving their user records.

`PROVENANCE.json` records the source commit and SHA-256 of imported files from
`baoabaob/codlet-plugins`. The complete upstream Apache-2.0 license, compatibility
profiles, modular sources, tests and acceptance probes are preserved. Core-owned
changes may subsequently differ from the recorded import hashes. Build-generated
bundles include third-party notices. The prior external source remains untouched.

Run `node frontend/build-codex.mjs` from Core, or the standard frontend build, to
regenerate all embedded sources using Core's existing build dependencies. Run
`node codex/test.mjs` for the preserved adapter/launch unit suite. Probe fixtures
describe evidence and are never run against a user's daily Native instance.

`context.codex` is defined in `types/codex.d.ts`. Its standard facade uses Core
capability admission and generation-scoped cleanup; callback and DOM handles
stay local. Capability probing reports each supported feature independently.
Profile declarations and verified client/platform evidence remain separate from
runtime availability. Windows fixture results do not establish macOS acceptance.
