# Plugin package and execution contract

A plugin is an explicitly registered directory with `codlet.json`, prebuilt CommonJS `.js`/`.cjs` entrypoints and its resources. It can provide a Renderer, a Host, or both. TypeScript must be compiled before loading. Core does not install npm dependencies, execute installation scripts or transpile source.

## Manifest

```json
{
  "schema": 1,
  "id": "dev.notes",
  "name": "Notes",
  "description": "Keep notes beside a task",
  "version": "1.0.0",
  "tags": ["UI", "Tool"],
  "renderer": { "entry": "dist/renderer.js", "world": "isolated" },
  "permissions": ["ui.dom", "core.storage"],
  "requires": [{ "name": "codlet.core.services", "api": 1, "scope": "runtime" }]
}
```

The schema rejects unknown fields. `schema`, `id`, `version` and at least one entry are required. `permissions`, `provides` and `requires` default to empty lists. IDs are stable technical identities: 1–128 ASCII bytes, dot-separated nonempty segments containing lowercase letters, digits or hyphens. Display names do not change identity. Versions are nonempty ASCII strings of at most 64 bytes without whitespace; the manifest parser does not require semantic version ordering.

Optional `name` contains 1–256 UTF-8 bytes of readable text; `description` contains 1–2048. Optional `i18n` accepts `zh` and `en` objects containing translated `name`/`description` under the same bounds. IDs, permissions, capability names and tags are never localized. Tags are at most eight case-insensitively unique labels, each 1–32 Unicode letters/numbers, hyphens or underscores, without the display `#`; they grant no capabilities or compatibility assertions.

`renderer.world` is `isolated` or `main`. Main-world execution requires declared and granted `ui.mainWorld`. A Host entry such as `"host":{"entry":"dist/host.cjs"}` requires `host.process`. Entry paths are package-relative safe paths to built JavaScript. No arbitrary `host.command`, runtime executable, flags or protocol can be selected by the manifest. Core's managed Node disables native addons and automatic type stripping; pure-JavaScript dependencies may be included in the package.

## Entry ownership and dependencies

Both entrypoints export `activate(context)` and `deactivate(...)`; activation may be asynchronous. Host deactivation receives the bounded cleanup context described in [Host](host.md). Renderer deactivation can report `{reloadRequired: true, reason}` when a page patch cannot be safely undone. Public types are [Host](../../types/host.d.ts) and [Renderer](../../types/renderer.d.ts).

| Package | Capability declarations |
| --- | --- |
| Renderer only | Top-level `provides` / `requires` belong to Renderer |
| Host only | Top-level declarations belong to Host; nested Host declarations would be ambiguous and are rejected |
| Combined | Top-level declarations belong to Renderer; `host.provides` / `host.requires` belong to Host |

Combined entries share the logical plugin ID, registration, enabled preference and generation. Host readiness precedes that package's Renderer activation. Requirements use exact `{name, api, scope}` descriptors; duplicates/conflicts, missing providers and actual entry dependency cycles are rejected. In particular, a Host waiting on its own dependent Renderer creates a cycle. Core currently executes Runtime and Target scopes; declaring another scope does not create its lifecycle. See [RPC](rpc.md).

Host and Renderer are execution locations, not feature tiers. Renderer-only plugins can use [Core services](services.md) for approved storage/files/processes without starting Node. Plugins may use complete JavaScript, custom React and DOM; [UI](ui.md) is an optional convenience SDK. Main-world and raw CDP extensions retain their explicit high-trust boundaries. No public Worker execution mode or automatic migration is part of this contract.

## Loading, generations and watching

Manifest size is limited to 128 KiB; each main JS entry to 1 MiB. Inspection validates UTF-8, ordinary local entries, canonical identity and traversal/device/linked-entry restrictions without executing the plugin. A generation captures immutable main entry text and its complete trust record. Additional modules and resources are read when accessed; this is not an atomic snapshot of the entire package tree.

Registration, startup and replacement use the [management](management.md) and [permission](permissions.md) contracts. `enabled` is intent; loaded snapshots and actually active instances are different facts. Combined activation is healthy only when both entries are active at the matching generation. Changing a live package's Host/Renderer entry shape requires restarting its Core session.

Optional local watch observes the manifest and declared main JS entries of already loaded local packages. It waits for stable observations and a quiet interval, then issues one dependency-closure replacement. It rechecks generation, source bytes, roots and complete trust before execution. Imported modules, assets and TypeScript inputs are outside this watch set; edit/build the declared output or reload explicitly. Changed trust/root selection pauses automatic replacement rather than broadening authority. Managed GitHub installations are immutable and are not watched.

## Publishable ZIP

The ZIP root contains `codlet.json`, declared built entries, resources, documentation and applicable license/notices. Do not add an outer project directory or Core's reserved `.codlet-source.json` receipt. Core accepts Stored/Deflate, with at most 32 MiB compressed, 64 MiB expanded, 2,048 entries, 240-byte relative paths and depth 16. Paths use ordinary ASCII names and `/`; links, traversal, device aliases, duplicates, case collisions, encrypted ZIPs and ZIP64 are rejected.

Optional `codlet-package.json` is bounded to 64 KiB and has this separate schema:

```json
{"schema":1,"runtimeApi":1,"platforms":["windows-x86_64"],"author":"Example author","adapters":{"example":{"testedBuilds":[]}}}
```

`runtimeApi`, `platforms`, `author` and `adapters` are optional; unknown top-level fields are rejected. Runtime API must match when declared. A nonempty platform list must include the current target or a broader matching declaration such as `windows` or `any`; omission means unknown. Author text is bounded to 512 bytes. Adapter JSON is an author declaration, not Core verification of private client internals. Put license text in license files rather than inventing a manifest/metadata field.

Core and its official plugins use Apache-2.0. Independent third-party plugins choose their own applicable licenses; using the runtime does not impose an Apache-only marketplace policy. Keep third-party dependency notices. Platform declarations, dependency compatibility and actual device acceptance remain separate evidence.
