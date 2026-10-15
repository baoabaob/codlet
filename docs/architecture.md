# Architecture

Codlet starts and owns an explicitly selected desktop session and loads trusted
JS/TS extension packages. It does not redistribute or patch the official app
package. Core, CLI, Codex SDK, runtime skill and delivery tools live here;
the optional GUI lives in [codlet-plugins](https://github.com/baoabaob/codlet-plugins).

## Responsibilities

| Component | Owns | Does not own |
| --- | --- | --- |
| Core | Session transport, Codex compatibility modules, semantic SDK, registry, permissions, capability graph, operation receipts and bounded resources | Business layouts or arbitrary plugin state |
| Host | A pinned, supervised Node process per ordinary plugin generation; background/OS work | Automatic rollback of arbitrary OS/network/page side effects |
| Renderer | Plugin code in an isolated or explicitly permitted main world, SDK and target-scoped lifecycle | A separate OS process or a universal security sandbox |
| Internal Codex modules | Reviewed client-build mappings, navigation, native objects and backend semantics behind `context.codex` | Separate user installation or consumer inheritance of internal grants |
| GUI | An optional consumer of public management APIs | A privileged built-in management path unavailable to other plugins |

The generic HTTP/SSE/WebSocket engine lives in Rust Core. It owns bounded native
streams, forwarding, trust/proxy handling and ordinary plugin authority. JavaScript
Hosts keep only plugin callbacks and stream bindings. There is no permanent Node
traffic process or legacy forwarding fallback; client-specific integration lives
in Core's replaceable source module. See the [traffic contract](spec/traffic.md).

The Core-provided `/codlet` skill owns a reviewed skill-registration bridge and its
generated resources. It is present without the GUI, never submits a model task
by itself, and does not modify permanent personal/project skill directories.

## One plugin system

A package can declare Host, renderer, or both. Entries share a plugin ID,
generation, registered source, grants and enabled preference. Dependencies are
exact capability descriptors rather than a whitelist of official providers.
CLI, GUI and other authorized managers use the same prepare/submit/operation
transactions and observe the same ownership state.

Core establishes a generic authenticated client bridge before application entry,
including a launch with no enabled client-source provider. The temporary Node
bootstrap closes the inspector and exits. The in-process bridge remains tied to
Core's live connection; it records original module fingerprints and scoped
bindings so a later granted plugin can attach or replace its source. Host,
renderer and client-source entries share the package lifecycle and receipt.
See the [Host contract](spec/host.md).

On Windows Core reads Electron's public versioned fuse schema and, when needed,
plans a one-byte temporary inspector edit in the exact owned image. Native still
verifies the whole file, mapped non-executable data and restoration. This public
platform bootstrap has no application source hashes or private application
symbols. Internal Codex modules use recorded mappings and live interface checks;
unknown builds enter capability discovery. See [client compatibility](spec/client-compatibility.md).
The temporary native debugger worker retires before activation; no additional
distributed helper executable or permanent Node service is introduced.

The Core controls admission, provider dispatch and delivery against current
authorization. Calls pin their provider and document generation; a late result
does not attach itself to a newer instance. Timeouts and cancellation do not
prove that an external side effect never occurred. Query the original receipt
after an uncertain submit rather than submitting again.

Host replacements use existing OS process ownership. Replacement first pauses admission,
drains accepted calls and captures explicit JSON state, then cleans affected renderers,
retires old Host owners and starts candidate
client source and Hosts before their dependent renderers. Failed replacement may restore immutable
old source snapshots at fresh generations under current trust. That temporary
transaction recovery is distinct from keeping historical installed packages.

Compatible Core updates reload the declared JavaScript modules and ordinary plugins,
restore state, then hand off Native source hooks while retaining the existing Native,
backend connections and forwarding streams. Missing state hooks defer a whole-Core
update. Rust, Node, bridge/bootstrap or ABI changes take effect after natural exit and
the next start. The resident component versions remain visible; see
[online update ownership and evidence](core-online-update.md).

## Capability and trust boundary

Ordinary plugins use `context.codex` and Core services. The internal providers preserve
historical capability names while their IDs are Core-owned. Existing adapter registrations,
grants and data remain saved but do not load a duplicate provider. A pure renderer and
an SDK Host can use approved Core services without raw Node or CDP privileges.
`ui.nativeDom`, `ui.mainWorld`, `cdp.raw`, `host.raw` and scoped process execution identify
specific unadapted boundaries; see [permissions](spec/permissions.md).

Isolation separates JavaScript globals in isolated worlds, but all such worlds
share the page DOM. Main-world code shares the page's JavaScript state. Host
in `mode: "sdk"` receives a JSON service membrane without ambient Node imports or process
globals; raw Node executes as the current user. DOM declarations are review boundaries,
while SDK dispatch, main-world admission and raw Host admission are enforced. This is
a trusted-plugin system, not proof that arbitrary plugin code is harmless.

## Renderer lifetime decision

The current renderer architecture is retained. The known Chromium world
accumulation on repeated plugin replacement remains a documented limitation; see
[the measurements and mitigation](known-issues.md#renderer-environments-after-repeated-reloads).
Core now budgets explicit isolated generations and reserves replacement/rollback
capacity before retiring current plugins. Independent document startup cannot
consume a transaction's reservations. Ordinary renderer cleanup can await
ownership-aware restoration before Host teardown; forced cleanup remains bounded
and reports unfinished work. See the [renderer lifecycle contract](spec/ui.md).
The real SDK listener leak has been fixed. No public Worker execution mode or
remote-widget-only UI contract is being introduced.

Any later experiment with a disposable full UI document must preserve custom
React/components/CSS/DOM behavior and the native toolbar, overlay, focus, input,
theme and language experience. It must not require extra Host/raw CDP permission
from a UI-only plugin. Such research does not block current delivery, and existing
page injection capabilities are not removed to make a memory measurement pass.

## Source layout

- `src/`: Rust Core, CLI, platform integration and lifecycle.
- `codex/`: internal UI/Desktop sources, reviewed client profiles and contract tests.
- `src/renderer/bootstrap.rs`: CDP context/binding/script operations with explicit
  inputs; it does not own or mutate the runtime coordinator's state.
- `src/renderer/observation.rs`: bounded status and inspection sampled together;
  no transport, plugin writes or management execution.
- `src/renderer/world_budget.rs`: isolated-generation admission and transaction
  reservations; renderer unit tests live separately in `src/renderer/tests.rs`.
- `runtime/`: managed Host runtime and runtime skill sources.
- `frontend/src/`: generic UI SDK sources; `frontend/build.mjs` builds the bundles.
- `bundled/runtime/`: generated SDK artifacts required by Rust's embedded runtime.
- `types/`: public TypeScript contracts.
- `compatibility/`: reviewed client identity and runtime-skill profiles.
- `examples/`: runnable examples and deliberately synthetic protocol fixtures.
- `tests/`, `scripts/`: regression fixtures, development and distribution tooling.

Generated bundles remain tracked because a normal Rust build embeds them. Local
profiles, binary packages, heaps, account data and temporary experiments are
ignored and never form a clean build prerequisite. Git keeps earlier designs;
current documentation is organized by contract. Dated research is indexed in
[history](history/README.md), release evidence in [releases](releases/README.md),
and repository responsibilities in [repository-layout](repository-layout.md).
