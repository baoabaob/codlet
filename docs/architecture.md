# Architecture

Codlet starts and owns an explicitly selected desktop session and loads trusted
JS/TS extension packages. It does not redistribute or patch the official app
package. Core, CLI, generic SDK, runtime skill and delivery tools live here;
official feature plugins live in [codlet-plugins](https://github.com/baoabaob/codlet-plugins).

## Responsibilities

| Component | Owns | Does not own |
| --- | --- | --- |
| Core | Session transport, target/session identity, registry, permissions, capability graph, operation receipts and bounded resources | Codex DOM selectors, private React objects, conversation semantics |
| Host | A pinned, supervised Node process per plugin generation; background/OS work | Automatic rollback of arbitrary OS/network/page side effects |
| Renderer | Plugin code in an isolated or explicitly permitted main world, SDK and target-scoped lifecycle | A separate OS process or a universal security sandbox |
| Official adapters | Reviewed client-build mappings, navigation, native objects and backend semantics | Exclusive access to Core primitives |
| GUI | An optional consumer of public management APIs | A privileged built-in management path unavailable to other plugins |

The Core-provided `/codlet` skill is the deliberate small exception to the
client-agnostic boundary: it owns a reviewed skill-registration bridge and its
generated resources. It is present without the GUI, never submits a model task
by itself, and does not modify permanent personal/project skill directories.

## One plugin system

A package can declare Host, renderer, or both. Entries share a plugin ID,
generation, registered source, grants and enabled preference. Dependencies are
exact capability descriptors rather than a whitelist of official providers.
CLI, GUI and other authorized managers use the same prepare/submit/operation
transactions and observe the same ownership state.

The Core controls admission, provider dispatch and delivery against current
authorization. Calls pin their provider and document generation; a late result
does not attach itself to a newer instance. Timeouts and cancellation do not
prove that an external side effect never occurred. Query the original receipt
after an uncertain submit rather than submitting again.

Host replacements use existing OS process ownership. Renderer replacement first
cleans affected renderers, then retires old Host owners, then starts candidate
Hosts before their dependent renderers. Failed replacement may restore immutable
old source snapshots at fresh generations under current trust. That temporary
transaction recovery is distinct from keeping historical installed packages.

## Capability and trust boundary

First-party adapters and third-party plugins use the same public primitives.
Explicit `ui.mainWorld`, `cdp.raw` and Host permissions remain available to trusted
plugins. A pure renderer can use approved Core services without acquiring Node
or raw CDP privileges. Prefer an adapter when it provides the required semantic
operation; authors can implement their own compatibility layer when it does not.

Isolation separates JavaScript globals in isolated worlds, but all such worlds
share the page DOM. Main-world code shares the page's JavaScript state. Host
Node executes as the current user. Permissions are a managed routing boundary,
not proof that arbitrary plugin code is harmless.

## Renderer lifetime decision

The current renderer architecture is retained. The known Chromium world
accumulation on repeated plugin replacement is accepted for Preview; see
[the measurements and mitigation](known-issues.md#renderer-environments-after-repeated-reloads).
The real SDK listener leak has been fixed. No public Worker execution mode or
remote-widget-only UI contract is being introduced.

Any later experiment with a disposable full UI document must preserve custom
React/components/CSS/DOM behavior and the native toolbar, overlay, focus, input,
theme and language experience. It must not require extra Host/raw CDP permission
from a UI-only plugin. Such research does not block current delivery, and existing
page injection capabilities are not removed to make a memory measurement pass.

## Source layout

- `src/`: Rust Core, CLI, platform integration and lifecycle.
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
current documentation is organized by contract rather than development date.
