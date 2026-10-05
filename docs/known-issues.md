# Known issues and current limits

This page records current behavior, not a history of Preview fixes. The first
stable release is being prepared as **0.2.0**. Its outstanding acceptance and
product decisions are tracked in [release readiness](release-readiness.md).

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
- Changing a loaded thread's provider does not have an automatic ownership-aware
  restoration protocol. Restore the original provider before retiring its route.

For 0.2.0, the two original lifetime guarantees above are explicitly excluded.
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
and the [adapter request-chain contract](https://github.com/baoabaob/codlet-plugins/blob/main/docs/spec/request-chain.md).

## Platforms and distribution

Windows x64 has local desktop evidence. The final 0.2.0 source still needs a
clean-device installer/upgrade/uninstall and signed-client functional acceptance.
The native Windows harness requires a disposable VM/host: a separate profile
does not isolate Windows sandbox accounts or firewall changes.

Windows ARM64 and macOS desktop/installer acceptance are deferred by the
maintainer for this preparation round. Native builds and controlled transport
tests are narrower evidence.
Linux remains outside the current implementation scope.
See [compatibility](compatibility.md).

Windows signing and macOS Developer ID/notarization have not been established.
The maintainer has deferred obtaining a Windows signing certificate.
The current Windows builder emits unsigned installers; the Mac builder provides
ad-hoc bundle integrity only. A stable version label does not change these facts.

Old Core Preview releases have been removed. Existing installed Windows users
must use the new setup EXE when 0.2.0 is published. New Core migrates only its
known built-in Preview channel files to the stable managed-runtime channel;
custom update sources retain their configuration.

## Marketplace

Discovery uses public GitHub repositories carrying the `codlet-plugin` topic.
Results depend on indexing, connectivity and API limits. Missing or incomplete
release declarations leave compatibility and cumulative downloads unknown.
Publisher declarations and platform metadata do not constitute security reviews
or device acceptance; installation verifies the actual archive and permissions.
Private repositories and draft releases are not supported by the public importer.
