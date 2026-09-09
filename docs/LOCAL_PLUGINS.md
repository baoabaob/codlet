# Registered local plugins

Host JS plugins are supported by the first M2a slice. They use
`host.process` and optionally `cdp.raw`, use Codlet's managed Node executor, and do not
require a renderer entry. Both use `codlet.json` and built `.js`/`.cjs` entrypoints;
TS is compiled before loading. Executable entries and Node native addons are
unsupported. See the [host contract](JS_PLUGIN_RUNTIME_2026-09-09.md)
and [raw host example](../examples/raw-host/README.md). M2b adds online host
enable/disable/reload through the same CLI receipts; see [host lifecycle](M2B_HOST_CONTROL_2026-09-10.md).
File watching still applies only to renderer plugins. Status-v1 and doctor Inspect still observe
the managed renderer only; host execution is reported in the launch log and GUI.

Codlet loads explicitly registered local directories at session startup or through
the running Host's enable/reload commands. Registration, inspection, and removal
do not launch or attach to Codex. Live management and opt-in file watching share
the [runtime control contract](RUNTIME_CONTROL.md).

## Register a directory

Inspect a plugin before recording its registration:

```powershell
codlet plugin add "C:\my-plugins\example"
```

This inspects its manifest and selected entry, displays the directory and requested
permissions, and exits nonzero without creating registry state. It does not execute
the plugin source. After reviewing the plugin, explicitly authorize the directory and
every requested permission:

```powershell
codlet plugin add "C:\my-plugins\example" --trust --grant ui.dom
```

Repeat `--grant` for multiple permissions. Isolated renderer entries support
`ui.dom` and `runtime.manage`; host JS entries support `host.process` and `cdp.raw`.
Unsupported worlds, permissions, or missing grants are rejected. Extra grants are
recorded only when explicitly supplied; the runtime uses permissions declared by
the manifest that also pass the grant check. The `--trust` flag is user consent, not an OS sandbox: these are
user-authorized programs. Renderer JS shares the document; host JS has ordinary
Node filesystem/network/process access as the current user.

The canonical local directory, expected plugin ID, and granted permissions are
persisted in `%LOCALAPPDATA%\Codlet\config.json`. A new registration uses the saved
enablement preference for that ID, defaulting to enabled. Re-adding the same ID and
directory can replace grants, but never resets an existing disabled preference.
A different directory cannot silently replace an existing registration.

## Manage and diagnose

```powershell
codlet plugin list
codlet plugin disable dev.example.plugin
codlet plugin enable dev.example.plugin
codlet plugin reload dev.example.plugin
codlet doctor --json
codlet plugin remove dev.example.plugin
```

With a matching Host, enable/disable/reload execute in that Host. Enable/disable
may save a preference for the next `codlet launch` only after proving this registry
has no Host; reload requires a Host. Removal forgets the local registration and
preserves both the source directory and the ID's enablement preference. Disable a
running plugin before removing its registration to unload it immediately. Bundled
plugins can be disabled but cannot be removed.

A JS host registered after launch can be enabled without restarting Codex. Its
process is retired before a replacement generation starts; startup failure can
restore the prior JS entry snapshot under fresh generations only while its
original registration, current grants and enabled preference still allow it.
`disable` can clean up a loaded host even after removal or source corruption.
Reloading a disabled host is rejected before execution; use `enable` first.
An ID that has already been assigned an executor cannot switch between host and
renderer until Codlet restarts. Host lifecycle manages process/RPC resources;
arbitrary injected page effects are still the plugin's responsibility.

Each launch re-reads and validates enabled plugin code, manifest identity, declared
permissions, and dependencies before discovering or starting Codex. Source edits
are allowed within the registered directory; newly requested permissions require
matching explicit grants. Re-register with the intended full grant list to change
that authorization. There is no automatic grant expansion.

`list` and `doctor` retain invalid local entries so they can be repaired. An invalid
enabled entry prevents launch; an invalid disabled entry remains visible in
diagnostics without blocking other plugins. Disable or remove still works when its
directory or entry has disappeared. `enable` validates it before persisting success.
Enabling also checks that the validated registration did not change concurrently;
retry the command from fresh state if its authorization changed or was removed.

The GUI management list reads the latest registry and the current loaded plugin set
on each refresh. A registered loaded plugin uses its actual target active state. A
plugin that is no longer registered but remains loaded stays visible until the
runtime unloads it and shows `Registration removed; still loaded`. Once the plugin is both unloaded and
unregistered, the row disappears. Removal alone does not unload running code. A newly registered `not_loaded`
plugin contributes metadata only; the GUI does not read its source to invent runtime
state. A registry read failure is shown as an explicit error and never falls back to
stale cached registry data. A plugin with an explicitly granted `runtime.manage`
permission may use the existing authenticated `disableSelf` transaction; this
persists disablement before unloading it from every attached target. It does not
remove its registration.
`doctor` may add a read-only authenticated scoped `Inspect` sample from the
matching Host; it uses actual kernel registrations and the same owner target,
generation, and activation publication, never disk declarations as proof of
loaded state. No Host, another registry, and an unsupported legacy Host remain
unavailable without adding a failure solely for that reason. Transport or
identity failures become an explicit runtime issue. Use `codlet status` for the
unchanged status-v1 sampled snapshot. See [the doctor runtime inspection contract](DOCTOR_RUNTIME.md).
The current renderer RPC transport supports target-scoped requirements; the
generic kernel's other scope declarations do not imply a working renderer route.

Use `codlet launch --watch` to observe the manifest and renderer entry of local
plugins already loaded by that Host. The watcher waits for the affected dependency
closure to stabilize, then uses the same reload transaction. A failed version is
attempted once until its contents or relevant grants change. Changed registrations
cannot automatically select a new directory; see the control contract for path
guards and receipt-based recovery after a CLI timeout.

## Plugin format

```text
example/
  codlet.json
  renderer.js
```

Manifest schema 1 uses the canonical filename `codlet.json`; rename older
`plugin.json` files explicitly. There is no legacy filename fallback or native
`host.command` compatibility mode. The CommonJS lifecycle ABI is shared: the entry
assigns `module.exports` with `activate(context)` and `deactivate()` methods; both
may return promises. Renderer code is not a Node process and has no general Node
`require` API. There is no package installation, dependency bundling, or remote
source loading in this slice.

The loader limits manifests to 128 KiB and renderer source to 1 MiB, requires
regular UTF-8 files for both host and renderer, and rejects root network/device paths, entry traversal, Windows
device names, alternate data streams, and linked/reparse entry paths. The selected
root may be canonicalized from a local alias, but linked files below it are refused.
These checks do not claim isolation from a malicious process running as the same
Windows user.

## Runnable example

`examples/local-echo` provides the target-scoped `example.echo@1` capability after
an awaited Host ping. It requests no extra permission and owns no UI, timer, file,
or process resources:

```powershell
codlet plugin add .\examples\local-echo
codlet plugin add .\examples\local-echo --trust
codlet doctor --json
```

In a deliberately started Codlet session, another registered plugin that declares
`example.echo@1` in its requirements can call:

```javascript
const reply = await context.rpc.request(
    { name: 'example.echo', api: 1, scope: 'target' },
    'echo',
    { text: 'hello' }
);
```

Its source is exercised with the actual bootstrap in the Node tests. A passing
offline test does not establish compatibility with the installed Codex build.

## Registry transactions

Registry reads and writes are limited to 1 MiB, including JSON formatting. An
oversized file or candidate save is rejected without replacing the current file.
Registry schema 2 adds an explicit `localPlugins` map. Schema 1 enablement files
remain readable without modification; an explicit successful save migrates them
atomically. Older Codlet versions that only understand schema 1 cannot read the
new format.

Writes share the existing cross-process lock. Enablement edits merge independently.
Registration and grant edits compare the original complete registration with the
latest record under the lock before applying any changes. Conflicts fail without
partially committing preferences or authorizations. Reload the current registry
and explicitly restage the intended operation after a conflict. Unrelated enable
or disable commands never replay an old registration or grant snapshot.

## Bundled GUI identity

The bundled GUI's canonical plugin ID is `codlet-gui`. Its menu, window, and
product display name remains `Codlet`, and its capability names remain
`codlet.runtime.*`. The legacy ID `codlet` is reserved as a CLI compatibility
alias for `enable`, `disable`, and `reload`; it is normalized to `codlet-gui`
before control. Both `codlet` and `codlet-gui` are reserved local IDs and cannot
be claimed by a local plugin.

The explicit `plugins.codlet-gui` preference wins. If it is absent, the legacy
`plugins.codlet` preference is read as a read-only fallback. `list` and `doctor`
do not migrate or write either key. An explicit GUI preference update writes the
new key and removes the old key within the existing registry save lock. A running
Host's plugin identity and existing receipts are not rewritten in place; the new
identity applies on the next launch with the updated binary.
