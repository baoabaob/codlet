# Trusted local renderer plugins

Codlet loads explicitly registered local directories when a new Codlet session
starts. Installation, inspection, enablement changes, and removal do not launch,
attach to, or restart Codex. Live CLI control and file watching are separate work.

## Register a directory

Inspect a plugin before recording trust:

```powershell
codlet plugin add "C:\my-plugins\example"
```

This reads its manifest and renderer entry, displays the directory and requested
permissions, and exits nonzero without creating registry state. It does not execute
the source. After reviewing the plugin, explicitly authorize the directory and
every requested permission:

```powershell
codlet plugin add "C:\my-plugins\example" --trust --grant ui.dom
```

Repeat `--grant` for multiple permissions. Currently only isolated renderers and
the `ui.dom` and `runtime.manage` permissions are supported for local plugins.
Unsupported worlds, permissions, or missing grants are rejected. Extra grants are
recorded only when explicitly supplied; the runtime uses permissions declared by
the manifest that also pass the grant check. Trust is not an OS sandbox: these are
user-trusted renderer programs with access to a shared document.

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
codlet doctor --json
codlet plugin remove dev.example.plugin
```

Changes apply to the next `codlet launch`. Removal forgets the local registration
and preserves both the source directory and the ID's enablement preference.
Bundled plugins can be disabled but cannot be removed.

Each launch re-reads and validates enabled plugin code, manifest identity, declared
permissions, and dependencies before discovering or starting Codex. Source edits
are allowed within the trusted directory; newly requested permissions require
matching explicit grants. Re-register with the intended full grant list to change
that authorization. There is no automatic grant expansion.

`list` and `doctor` retain invalid local entries so they can be repaired. An invalid
enabled entry prevents launch; an invalid disabled entry remains visible in
diagnostics without blocking other plugins. Disable or remove still works when its
directory or entry has disappeared. `enable` validates it before persisting success.
Enabling also checks that the validated registration did not change concurrently;
retry the command from fresh state if its authorization changed or was removed.

The GUI management list uses the launch catalog and the calling target's actual
active state. A plugin with an explicitly granted `runtime.manage` permission may
use the existing authenticated `disableSelf` transaction; this persists disablement
before unloading it from every attached target. It does not remove its registration.
`doctor` keeps runtime observations unprobed; use `codlet status` for sampled Host
state through the read-only IPC. Live CLI enable/disable/reload remain future work. The
current renderer RPC transport supports target-scoped requirements; the generic
kernel's other scope declarations do not imply a working renderer route.

## Plugin format

```text
example/
  plugin.json
  renderer.js
```

The existing manifest schema and CommonJS renderer ABI are unchanged. The entry
assigns `module.exports` with `activate(context)` and `deactivate()` methods; both
may return promises. Renderer code is not a Node process and has no general Node
`require` API. There is no package installation, dependency bundling, or remote
source loading in this slice.

The loader limits manifests to 128 KiB and renderer source to 1 MiB, requires
regular UTF-8 files, and rejects root network/device paths, entry traversal, Windows
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

In a deliberately started Codlet session, another trusted plugin that declares
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
