# Known issues and current limits

This page describes limitations of the current implementation. They are not
implemented features or reasons to weaken authorization boundaries.

## Renderer environments after repeated reloads

**Accepted Preview limitation.** A new isolated renderer generation creates a new
Chromium world. Core can revoke its capabilities, clear managed resources and
release SDK references, but the current CDP interface does not individually
destroy the old parent-page world. Repeated updates/reloads can therefore retain
memory until the owning client exits. Reusing the same world would weaken the
old/new-instance boundary and is not used as a workaround.

The separate UI SDK `selectionchange` listener leak has been fixed. Windows x64
measurements on Core `3acf85c`, Codex `26.915.4065.0` found:

| Workload | Observation |
| --- | --- |
| 30 minutes idle | No clear continuing leak; collected JS heap 262.52 → 252.23 MiB |
| 20 actual GUI reloads, opening the UI each time | +13.52 MiB collected JS heap; no per-cycle DOM/listener accumulation |
| 100 empty browser worlds | About 16 MiB retained in controlled measurements |
| Core while GUI is open | About 5 MiB private resident memory; distinct from the desktop's renderer memory |

These are bounded Windows observations, not multi-day or macOS acceptance.
Normal UI interaction is not a plugin-generation replacement. Occasional reloads
are expected to have modest impact; sustained development hot reloads can
accumulate enough memory to matter. Close the owned client completely and restart
it when needed. Ordinary `Page.reload` did not reclaim the worlds in the prior
stress experiment and is not a guaranteed remedy.

Disposable Worker/UI-container experiments are deferred research. The runtime
and full plugin capabilities are retained; no hidden automatic restart or
restricted replacement UI is introduced. Detailed historical measurements are
available in Git at `3acf85c` and `fdd31cd`, rather than copied as permanent reports.

## Client and platform compatibility

Adapters depend on reviewed official-client builds. A compatible OS and a passing
Rust test do not prove that a new private frontend export or backend build is
supported. Capability probes fail explicitly on unknown/mismatched builds.
See [compatibility](compatibility.md) for the current platform and evidence rules.

Windows x64 has local desktop evidence. Windows ARM64 and macOS desktop behavior
still need acceptance on their corresponding devices. CI/native packaging tests
and a generated Mac disk image are not a substitute for a Mac user's full desktop
session. Linux is not in the current implementation scope.

## Processes, updates and external effects

- A Core crash does not universally guarantee that the official desktop exits.
- An official launch can reuse an already extended main instance; Codlet does not
  claim to control every launch through the official shortcut.
- macOS process groups cannot guarantee cleanup of an arbitrary descendant that
  deliberately detaches itself. They are not an OS security sandbox.
- Native requests, disk writes and remote network effects cannot generally be
  undone by cancelling a local callback. Treat uncertain outcomes as uncertain.
- Arbitrary main-world/DOM patches may require complete window/client recreation
  for strong cleanup, even when managed permissions have already been revoked.

## Traffic scope and remaining acceptance

Core includes the plaintext traffic gateway and Windows/macOS Native launch
owner. Client-specific hooks remain subject to the Adapter's build and capability
checks. Generic channel tests do not mean every official-client request is
intercepted. The
[traffic contract](spec/traffic.md) records the actual attached paths and
protocols; traffic fixtures and complete desktop acceptance are reported separately.

The former CONNECT/proxy-authentication/temporary-certificate launch path has
been removed. The Adapter uses separate Desktop HTTP hooks and owned AppServer
provider routes. Reviewed Windows x64 and Apple Silicon builds have native,
controlled traffic evidence. Their protocol and lifecycle evidence is in
the [Adapter request-chain specification](https://github.com/baoabaob/codlet-plugins/blob/main/docs/spec/request-chain.md).
Inspect `activatedSources` and `unsupportedSources`; generic attachment does not
imply browser WebSockets, remote/cloud model sockets, Realtime/WebRTC, attachments,
live OAuth refresh or full GUI/installer behavior are accepted. If traffic interception is explicitly
requested and no source can attach, launch fails rather than silently sending
traffic past the interceptors. Ordinary launches without traffic consumers are
unaffected. Changing real providers still requires plugin policy for server-owned
continuation IDs and already-executed tool operations.

The GUI marketplace searches public GitHub repositories with the `codlet-plugin`
topic. Search and availability depend on GitHub indexing, network access and API
limits; it is not an exhaustive index of every plugin manifest. Missing release
declarations leave package details and download totals unknown. Matching
declarations are publisher-provided metadata, not a security review. Installation
still validates the actual archive and asks for its permissions. Older local installer seeds
can switch to a verified GitHub release through an explicit adoption review;
merely publishing a repository never silently changes an installed plugin's source.
See the [marketplace specification](https://github.com/baoabaob/codlet-plugins/blob/main/docs/spec/marketplace.md).

## Next Preview: Windows CLI discovery

Preview 6 installs `codlet.exe` but does not add its directory to the user's
`PATH`. Until this is implemented, invoke it by its full installation path.

- [ ] Add a default-selected MSI option to add Codlet to the current user's
  `PATH`, without administrator privileges or changes to the system `PATH`.
- [ ] Preserve existing entries, avoid duplicates on upgrades, and remove only
  the installer's own entry on uninstall.
- [ ] Notify Windows about the environment change and explain that existing
  terminals must be reopened before the `codlet` command becomes available.

## Preview signing

Local Preview installers are not presented as signed, notarized stable releases.
Windows may show an unsigned-publisher prompt. The Mac app may use an ad-hoc
integrity signature; that is not a Developer ID signature or Apple notarization.
See the package metadata and [installation guide](distribution.md).
