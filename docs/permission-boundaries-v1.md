# Permission boundaries in v1

These are trusted-plugin admission and SDK broker boundaries. They are not a
security sandbox for hostile plugin code. Standard file, network, UI, clipboard
and task services do not grant their Core implementation's raw authority.

## Host execution

New packages choose `host.mode` explicitly:

```json
{"host":{"entry":"dist/host.cjs","mode":"sdk"},"permissions":[]}
```

The SDK compute path executes the immutable entry in a separate managed Host
process and a JavaScript compute realm. The entry must be bundled CommonJS.
`process`, `Buffer`, the Node module loader, disk imports, dynamic imports,
ambient HTTP clients and foreign Node object/function prototypes are not part
of its exposed API. Acorn 8.15.0 admits the source before evaluation and rejects
loader syntax. `require` rejects with `sdk_import_denied`. SDK methods,
callbacks, errors, bytes, streams and opaque target handles cross a JSON
membrane. Ordinary computation and timers need no `host.raw` or `host.process`
grant. Each SDK call still uses the consumer's own grants and generation.

The underlying implementation is Node `vm`, which Node explicitly does not
describe as a security mechanism. This reduces ambient API authority for
trusted plugins; it does not establish an OS sandbox or a malicious-code
containment guarantee. The current pinned Node permission models also do not
supply the required full network boundary, so no claim relies on their flags.
See [Node vm documentation](https://nodejs.org/api/vm.html) and
[the pinned Windows runtime permission documentation](https://nodejs.org/download/release/v24.21.0/docs/api/permissions.html).

Packages that need Node modules, direct files, fixture servers or other raw
Host facilities use `host.mode: "node"` and explicitly request `host.raw`.
Execution admission requires that grant. Full Node code can bypass SDK brokers,
so its file/network/process access cannot be described as broker-enforced.

## Exceptional direct access

The GUI groups these as direct system or Native capabilities and uses this
compatibility text:

> 该权限允许插件直接使用未经 Codlet 统一适配的系统或客户端能力。相关功能的跨平台及客户端版本兼容由插件作者维护。

| Permission | Actual boundary |
| --- | --- |
| `host.process.spawn` | Core broker checks the exact selected executable; cwd and environment keys remain explicit |
| `ui.nativeDom` | Author declaration and source review for direct private Native DOM use |
| `ui.mainWorld` | Core checks entry admission to the Native main JavaScript world |
| `cdp.raw` | Core checks raw CDP requests/subscriptions and their owning generation |
| `host.raw` | Core checks admission to an explicit full Node Host |
| `host.process` | Preserved legacy admission alias for old full Node Host packages |

`ui.dom` remains the standard UI-component compatibility permission. Ordinary
SDK rendering does not inherit `ui.nativeDom`, `ui.mainWorld` or `cdp.raw` from
Core. A renderer's isolated world shares Native DOM, and a main-world renderer
can access its surrounding JavaScript world. The `ui.nativeDom` declaration
does not prevent an undeclared DOM operation. Source review remains required
for trusted renderer code; no permission label claims DOM isolation.

Broad `brokerPolicy.clientPermissions` consent applies to standard broker
categories. It never selects an executable, supplies arbitrary cwd/env keys,
or grants raw Node. It can combine with explicit `executables`, `cwdRoots` and
`envKeys`; it cannot combine with the old standard file/network/shortcut scope
lists. Process brokers always check exact executables, use only a minimal base
environment and explicit environment keys, and allow only the plugin cwd or
explicit cwd roots. A selected executable may itself be a shell or interpreter
with OS-user authority: that is the visible exceptional access being approved.
The GUI preserves old explicit process selections on a reviewed update and
directs new executable selections to the CLI `--executable` option.

## Legacy migration

Omitted `host.mode` preserves the old full Node execution path and its existing
`host.process` grant. Stored grants and storage are not rewritten to
`host.raw`; changing an old package to explicit `node` requires a reviewable
manifest change and a fresh `host.raw` grant. Changing to `sdk` removes the
ambient Node API even when unrelated old grants are retained. Broad standard
consent without an executable selection is denied by process brokers. Existing
file/network/UI/task grants never imply new exceptional permissions.

## Explicit state transfer

Host exports `saveState(context)` and `restoreState(snapshot, context)` use
`{schema: positive uint32, value: JSON}` with a 256 KiB limit. Functions, DOM,
Promises, accessors, cycles, nonfinite values and external processes are not
serializable plugin state. `HostRuntime.begin_snapshot` is pollable and leaves
the old generation owned on refusal or timeout. It pauses new SDK/capability
admission with `core_updating`, drains accepted invocation descendants and
pending requests, then snapshots. `saveState` cannot introduce SDK writes.
`begin_resume` explicitly reopens the old generation after failed preflight;
the caller must wait for its `{resumed:true}` acknowledgment. Stateless legacy
entries return `null` rather than claiming state support, and remain reloadable.

retiring renderer cleanup is the narrow exception while paused. Core derives
that admission from its authenticated `Stopping` record and carries it only
through the same bounded invocation lineage; plugin parameters cannot request
it. The separate Host deactivate cleanup phase retains its current CDP grant
and total deadline checks.
`begin_start_restored` runs
activate, then restore, then reports ready. `context.restoringState` is true
during those two phases and false after successful restoration, so consumers
can suppress automatic side effects. These primitives do not by themselves
establish an all-plugin transaction or transfer arbitrary external resources.

GUI state includes only safe navigation/search/filter/scroll preferences. It
does not transfer consent, receipts, pending commands, credentials or selected
sources. The complete capability test consumer uses explicit raw Node for its
owned fixture servers, declares its direct Native DOM assertions, retains its
model-fixture ownership guard, and transfers only settled observations.

## Validation evidence

Focused Node tests cover compute without Node globals/loaders, constructor and
dynamic-import denial, local error prototypes, callbacks, byte streams, opaque
targets and state transfer. Focused Windows Rust tests cover manifest admission,
legacy records, process denial despite broad service consent, and actual SDK
Host JSONL state restore while the same fake CDP peer remains responsive. These
checks do not establish real Native acceptance or macOS verification. GUI tests
exercise current source in memory without publishing or changing installed
Native clients. Package `verification` records remain author-supplied evidence,
separate from SDK declarations and current capability probes.
