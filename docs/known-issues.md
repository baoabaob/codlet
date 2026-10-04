# Known issues and current limits

This page describes limitations of the current implementation. They are not
implemented features or reasons to weaken authorization boundaries.

## Core service lifetime during first enable

Preview 24 can report a plugin as active while its Core service calls fail with
`stale_generation`. When enabling a plugin with `traffic.intercept`, activation
starts before the enabled preference is committed. The resource monitor treated
that temporary disabled preference as retirement of the entire service owner.
Storage, tasks, events, files, processes and network calls then lose their shared
generation even though the renderer and Host process remain active.

Preview 25 preserves Core service authority during that activation window while
continuing to deny and close disabled traffic operations. Permission revocation,
trust-record changes and explicit package cleanup still retire the owner. Two
regression tests exercise the actual lifetime monitor, staged enable, traffic
cleanup and permission revocation. Reloading an already enabled plugin restores
its current instance on Preview 24; re-enabling after disable can trigger the
defect again, so the permanent fix requires the newer Core.

## Startup compatibility recovery

Preview 29 finishes the generic transport/inspector transaction before checking
application-specific source readiness. The owned client pipe reader starts
before that readiness operation runs over the authenticated bridge. A source
that waits for native initialization no longer blocks the connection needed
by that initialization. Readiness uses a queried receipt, retains the initial
generation and rechecks source authority before publishing coverage. Controlled
Node fixtures cover initialization after debugger detach and native connection;
these are not full signed-client or model-request acceptance.

Preview 28 gives the authenticated client lease its own bounded ten-second
handshake after the temporary inspector closes. Preview 27's fixed two-second
read wait can fail while the resumed native main loop is still busy and report
`client_bridge_disconnected`. The new deadline applies to the entire reply,
including fragmented reads. Malformed replies and wrong identities remain
failures. A confirmed lease timeout permits one owned startup retry without
the optional bridge, suspending only affected plugins while preserving grants
and enablement. Other transport or process failures are not retried. Source
readiness codes and bounded owned-child startup stderr are retained for diagnosis.

Preview 26 recovers optional launch-adapter compatibility failures by temporarily
suspending that launch's providers, interception consumers and their dependency
closure, then starting the original client with the remaining plugins. The
failed owned child, adapter and IPC owners unwind before one ordinary retry.
Enablement and grants are preserved. Preview 26 needs a restart after updating
that adapter because its temporary startup executor has already exited.

Preview 27 establishes a generic client bridge independently of adapters and
keeps it through an authenticated Core connection. A plugin-specific unsupported
source leaves the client and bridge running. Updating or reloading the adapter
replaces its client entry and restores the affected dependent closure in the
same client. The management list identifies these suspensions as reloadable.
The old Core must be upgraded and started once to establish the bridge; it
cannot be added retroactively to an already running Preview 26 client.

First-time source recovery may reconnect a verified idle local app-server;
pending requests and active turns reject that operation. Replacements retain
client-owned forwarding routes until their backend child exits. Source hooks,
subscriptions and plugin callback authority retire with the generation. These
paths passed owned Node/Host lifecycle fixtures, including rollback, disable and
revocation. Final signed-client Windows/macOS acceptance remains separate.
Unrelated process, authorization and protocol failures still fail. Safe mode
suspends every plugin and does not establish the client bridge.

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

Windows package 26.924.2738.0 / frontend 26.924.22138 build 11645 opens its
login UI under the full isolated Core startup path, but the current Desktop/UI
adapters lack a reviewed profile for that frontend. They report build drift and
the Codlet GUI is unavailable. This does not establish signed-in behavior or a
new-MSIX upgrade: the test uses signed unpacked program files with the existing
registered package. Preview 16 includes corrections for missing child package
identity, rejected hidden shell metadata (`=ExitCode`), and Owl rejecting the
canonical `\\?\` executable path while constructing its application resource URL.
The last defect reproduces the reported Owl error and exit 13 locally by changing
only the executable path representation; ordinary paths render successfully.
The startup harness now exercises production package path resolution as well as
real shell inheritance. These fixes do not add a frontend adapter profile or
establish acceptance of the other machine's registered-MSIX update.
See the [startup acceptance harness](desktop-startup-acceptance.md).

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
