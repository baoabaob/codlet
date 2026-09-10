# Registered local JS/TS plugins

Codlet loads explicitly registered directory packages containing `codlet.json`,
built CommonJS `.js`/`.cjs` entries and resources. A package may have a Host entry,
an isolated renderer entry, or both. Host-only plugins need no renderer stub,
official GUI or adapter. TypeScript is compiled before loading; the portable
runtime does not install npm dependencies or transpile source.

The optional top-level `name` in `codlet.json` is the human-readable display name
(for example, `"name": "Usage Banner Hider"`). It does not change the stable `id`,
capability ownership or CLI identity. Names must contain readable, nonempty text
within 256 UTF-8 bytes. Older manifests fall back to their ID.

The [JS runtime contract](JS_PLUGIN_RUNTIME_2026-09-09.md),
[Core RPC contract](CORE_RPC_2026-09-10.md) and
[development walkthrough](HOST_DEVELOPMENT_2026-09-10.md) cover the public SDK.
Execution evidence belongs to the [M2 acceptance record](M2_ACCEPTANCE_2026-09-10.md).

## Inspect, then grant explicitly

```powershell
codlet plugin add C:\Plugins\my-tools
```

Without `--trust`, this reads the manifest and declared JS entry snapshots,
prints the candidate and requested permissions, and exits without registration
or code execution. After reviewing them, supply every intended grant and scope:

```powershell
codlet plugin add C:\Plugins\my-tools --trust --grant host.process --grant host.fs --grant host.network --grant host.system --read-root C:\Fixture\approved-data --network-origin https://example.com
codlet plugin permissions dev.my-tools --json
```

`--grant`, `--read-root`, `--network-origin` and `--executable` are repeatable.
The CLI displays the complete normalized policy before saving it. Supported
permissions are:

| Entry/API | Declared and explicitly granted permission | Additional scope |
| --- | --- | --- |
| Managed Node Host | `host.process` | None for Node activation |
| Raw Core CDP | `cdp.raw` | Core tracks its managed sessions and resources |
| Filesystem broker | `host.fs` | `--read-root` directories |
| HTTP(S) broker | `host.network` | Exact `--network-origin` values |
| Child-process broker | `host.process` | Explicit `--executable` files |
| Bounded system query | `host.system` | None |
| Public lifecycle management | `runtime.manage` | Declared `codlet.runtime.manage@1` requirement |
| Isolated renderer DOM | `ui.dom` | Its renderer world |

Combined packages may declare permissions used by either entry. Main-world
renderer execution and `ui.mainWorld` are outside this implementation. Extra
grants are stored only when explicitly provided, and do not become manifest
declarations. Empty broker policy grants no directory, origin or child program.
See [OS broker limits and authorization](OS_BROKER_2026-09-10.md).

Host Node is ordinary current-user code, not an OS sandbox. These grants constrain
managed endpoints; they cannot guarantee code safety or reverse completed
external effects.

## One complete trust record

The canonical directory, expected logical ID, grants and optional `brokerPolicy`
are stored together in `%LOCALAPPDATA%\Codlet\config.json`. A new registration
retains the ID's saved enabled preference, defaulting to enabled. Re-adding the
same ID/directory explicitly replaces its complete grant and policy selection;
it does not reset disabled state or silently add permissions.

Each registry save compares the original complete `path + grants + brokerPolicy`
record under the existing process lock. A concurrent change conflicts instead of
overwriting another writer. Unrelated enablement edits merge without restoring
old registrations or grants. Registry documents and candidate saves are limited
to 1 MiB. Schema 1 reads remain compatible; explicit saves migrate to schema 2.
Schema 2 records that omit `brokerPolicy` retain the empty-policy behavior.

## Lifecycle, revoke and receipts

```powershell
codlet plugin enable dev.my-tools --json
codlet plugin reload dev.my-tools --json
codlet plugin disable dev.my-tools --json
codlet plugin revoke dev.my-tools host.fs --json
codlet plugin operation '<receipt>' --json
codlet doctor --json
```

With a matching runtime, commands use one prepare/submit/operation receipt in
that runtime. After a lost submit response or timeout, query the same operation;
do not create a second mutation or switch to an offline write. Without a runtime,
enable/disable/revoke may save the next-launch intent only after proving that
this registry has no Host; reload requires a running runtime.

Ordinary CLI disable rejects enabled or running dependents. The GUI first shows
the affected plugin names, then submits an explicit `cascade: true` disable when
the user confirms. Core persists the whole closure as disabled in one save before
retiring its entries, so disabling an adapter and its GUI does not restart them.
Reload replaces the selected
provider and its transitive dependent closure, including both entries of a
combined package. Sources and current trust are validated before retirement;
renderer cleanup precedes Host stop, and replacement Host readiness precedes
dependent renderer activation. Partial failure cleans both candidate entries and
can restore prior immutable snapshots at fresh shared generations under current
trust. See [combined lifecycle](COMBINED_PACKAGES_2026-09-10.md).

Revoke removes a permission and its associated broker scopes atomically, then
invalidates the old managed authorization and retires that provider/dependent
closure. It preserves enabled preferences and performs no automatic compensation.
Explicitly grant the intended authority again before enabling code that still
declares it. Public Host/renderer callers and the optional GUI use the same
[runtime.manage@1 receipt contract](RUNTIME_MANAGE_2026-09-10.md).

New registrations can be enabled online without restarting Codex. Disable can
retire an actual owner even if its source is broken, missing or no longer
registered. Removing a registration preserves source files and the ID's saved
preference; disable first when immediate unloading is intended. An ID's owned
entry shape cannot change during the same Codlet run; restart Codlet to add,
remove or switch its Host/renderer entry kinds.

## Declarations, snapshots and watch

For combined packages, top-level `provides` / `requires` belong to the renderer;
`host.provides` / `host.requires` belong to the Host. Host-only packages use the
top-level declarations. Host providers support Runtime and Target; renderer
providers support Target and may consume Runtime or Target. Unsupported adapter
scopes do not acquire fabricated instances. Exact descriptors, duplicate
providers, missing requirements and actual cycles are checked before activation.

Manifests are bounded to 128 KiB and each JS entry to 1 MiB. The loader checks
UTF-8, ordinary local files, canonical identity, traversal/device/ADS and linked
entry restrictions. Both main JS entries and the complete trust record are
captured for a generation. Other resources and imported JS modules are read when
the plugin accesses them; they are not an atomic snapshot of the entire package.

`codlet launch --watch` observes already loaded local packages. It watches the
manifest and all declared main JS entries, with a four-source scan budget, two
matching observations and a quiet interval. One stable edit produces one closure
receipt. The execution guard checks the original generation, selected bytes,
loaded roots and complete Host trust records again. Another save after stable
selection returns to observation instead of executing unsettled bytes. Failed
content is not retried merely because rollback used a new generation.

Changing a loaded root or full Host trust record pauses that automatic source
selection; use explicit CLI grant/enable/reload to choose current authority.
Resources, imported modules and TS inputs are outside the watch set. Details are
in [host watching](HOST_WATCH_2026-09-10.md).

## Examples and diagnostics

The portable package includes [raw CDP with owned navigation recovery](../examples/raw-m2/README.md),
[granted filesystem/network access](../examples/host-os-broker/README.md),
[Runtime/Target Core RPC packages](../examples/core-rpc/README.md),
[combined Host/renderer](../examples/local-host-renderer-capability/README.md),
and [bounded cleanup](../examples/cleanup-host/README.md).
`examples/local-echo` remains a small renderer provider of `example.echo@1`.

Listing does not re-execute source to guess metadata. One logical package produces
one row; enabled intent, loaded snapshots and actual active state remain distinct.
Host process/cleanup facts and renderer target facts retain their actual executor
origins. Use [Host inspection](HOST_INSPECTION_2026-09-10.md) and the receipt's
failure stages when a change is degraded.

Bundled GUI identity remains `codlet-gui`; legacy `codlet` is a compatibility
control alias. Bundled/core IDs are reserved for local registrations. Optional
official plugins can be disabled without granting a third-party package any
hidden privilege.
