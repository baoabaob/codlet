# Known issues and current limits

This page records current behavior for **1.0.0-rc.19**. Candidate evidence and
remaining desktop acceptance are listed in [release readiness](release-readiness.md).

## Client capability discovery

An installed rc.1 session rejected the current backend's unlisted file digest and
missed the already compiled entry module. Its startup recovery also suspended the
independent Desktop provider and dependent plugins. rc.2 adds protocol/configuration
probes, structural source discovery, entry-frame capture and per-capability recovery.
See the [compatibility contract](spec/client-compatibility.md).

Bootstrap corrections change resident code and take effect after a new start.
The [current candidate record](releases/1.0.0-rc.19/validation.md) distinguishes
fresh checks from earlier desktop evidence.

## Unified Core and compatible online updates

Core owns the Codex UI/Desktop implementation; ordinary consumers use
`context.codex`. Existing legacy Adapter registrations and data are preserved,
but those sources do not run alongside the Core providers. The GUI remains an
optional plugin. Capability declarations and automated evidence do not certify
every Native build or platform.

Compatible online updates replace the declared JavaScript modules and Native
source while retaining resident Rust, Node, transport and fixed injection/forwarder
code. Updates to those resident components take effect on the next natural start.
The initial upgrade from the former architecture also needs a new start. Plugins
without explicit transferable state defer a whole-Core update instead of losing
memory state. Unknown operations retain their original receipts and admission
ownership; callers must not replay them. See [the update contract](core-online-update.md).

The standard Host SDK has no ambient Node `require` or `process`. Explicit raw
Host, raw CDP and Native access have separate permission boundaries. Shared DOM
and raw Node execution remain trusted-code boundaries, not hostile-code sandboxes.

## Client lifetime and official entrypoints

- An official launch can reuse an already extended Electron main instance.
  Codlet cannot promise a separate clean instance while that instance is running.
  This remains the original `DEFECT-001` design gap.
- A Core crash does not universally guarantee that its official desktop child
  exits. The original `DEFECT-002` remains open; pipe EOF requests cooperative
  shutdown and is not a process-termination guarantee.
- macOS process groups cannot contain a descendant that deliberately detaches.
- Cancellation cannot undo a disk write, remote request or arbitrary page patch.
  Query the original operation after an uncertain result instead of repeating it.
- Core's Desktop implementation provides opt-in owned restoration for loaded-thread changes
  made through a configuration handle with `restoreOnDeactivate: true` on Core
  API 1. Normal cleanup waits for the original provider/model receipt before
  Host teardown. Unknown originals, active/background tasks, a conflicting model
  choice, forced retirement or lost native ownership still require inspection;
  these cannot be called successful restoration. Legacy unleased writes continue
  to require explicit restoration before route closure.

The two original lifetime guarantees above remain explicitly excluded.
Separating Electron's singleton would require a distinct profile or changes to
official launch behavior. A blanket Windows kill-on-close job could terminate
official updater descendants; a reliable narrower supervisor needs crash/update
handoff acceptance. These changes are deferred. To open an unextended client,
fully quit the extended client first, then use the official launcher. After a
Core crash, save and quit any remaining client before restarting Codlet.

Installation and startup only prompt the user to close running applications.
They offer check again/cancel and never send close requests. Windows interactive
uninstall optionally cleans an explicitly listed Codlet-only data scope; see
[distribution](distribution.md).

## Renderer environments after repeated reloads

A new isolated renderer generation creates a new Chromium world. Core revokes
its capabilities and clears managed resources, but CDP cannot individually
destroy that old parent-page world. Repeated reloads can retain memory until
the owning client exits. Reusing an old world would weaken generation isolation.

Core now limits explicit isolated-generation creation attempts to 256 across
targets for its lifetime. Reload admission accounts for both replacement and
rollback before retiring current plugins. Failed attempts count too; navigation
does not reset the counter. `status --json` reports `renderer.isolated_worlds`;
at 75% Core emits a diagnostic, and exhausted admission asks for a complete
client restart. This is a generation budget, not a Chromium memory measurement.

The separate SDK selection listener leak was fixed. Historical Windows x64
measurements on Core `3acf85c`, Codex `26.915.4065.0` found:

| Workload | Observation |
| --- | --- |
| 30 minutes idle | Collected JS heap 262.52 → 252.23 MiB; no clear continuing leak |
| 20 GUI reloads with the page opened each time | +13.52 MiB collected heap; no per-cycle DOM/listener accumulation |
| 100 empty browser worlds | About 16 MiB retained |
| Core with GUI open | About 5 MiB private resident memory |

These are historical bounded observations, not acceptance of the final release.
A full client exit/restart reclaims the worlds. Ordinary page reload is not a
demonstrated remedy. Disposable UI-container research remains deferred.

## Client source and traffic coverage

Core establishes a generic authenticated bridge before application entry.
Unsupported optional sources suspend their affected dependency closure without
changing grants or enabled preferences. Updating/reloading a reviewed source can
recover that closure in the same client. Safe mode skips all plugins and the bridge.

The temporary inspector closes and the native debugger detaches before source
readiness is queried through the live connection. Controlled lifecycle tests
cover startup, replacement, rollback, disable and revocation. A passing fixture
does not certify the signed client's final integrated startup or a real account.

Desktop HTTP hooks and the owned local AppServer provider route report separate
`activatedSources` and `unsupportedSources`. Browser WebSockets, remote/cloud
model sockets, Realtime/WebRTC, attachments, live OAuth refresh and arbitrary
provider protocols do not have complete acceptance. See [traffic](spec/traffic.md)
and the [adapter request-chain contract](https://github.com/baoabaob/codlet/blob/main/docs/history/adapters/spec/request-chain.md).

## Platforms and distribution

Windows x64 has bounded local desktop evidence. The current candidate still needs a
clean-device installer/upgrade/uninstall and signed-client functional acceptance.
The native Windows harness requires a disposable VM/host: a separate profile
does not isolate Windows sandbox accounts or firewall changes.

Windows ARM64 has no device acceptance. macOS has native build, DMG mount,
initializer and controlled update checks; manual desktop/account/IME acceptance
remains separate from those tests.
Linux remains outside the current implementation scope.
See [compatibility](compatibility.md).

Windows signing and macOS Developer ID/notarization have not been established.
The maintainer has deferred obtaining a Windows signing certificate.
The current Windows builder emits unsigned installers; the Mac builder provides
ad-hoc bundle integrity only. A stable version label does not change these facts.

Old Core Preview releases have been removed. Existing installed Windows users
must use the new setup EXE to install the current candidate. New Core migrates only its
known built-in Preview channel files to the stable managed-runtime channel;
custom update sources retain their configuration.

## Marketplace

Discovery uses public GitHub repositories carrying the `codlet-plugin` topic.
Results depend on indexing, connectivity and API limits. Missing or incomplete
release declarations leave compatibility and cumulative downloads unknown.
Publisher declarations and platform metadata do not constitute security reviews
or device acceptance; installation verifies the actual archive and permissions.
Private repositories and draft releases are not supported by the public importer.
