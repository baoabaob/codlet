# Windows owned-client startup bootstrap

The Windows 26.924.2738.0 package (frontend 26.924.22138/build 11645,
backend 0.158.0-alpha.2.1) disables the Node CLI inspector in its signed
`chrome.dll`. Both `--inspect-brk` and the native inspector toggle were tested:
the argument is ignored and the toggle reports unavailable. The existing
plaintext sources still work once installed before main entry.

## Current client bridge

Core Preview 27 establishes the generic bridge before entry independently of
adapters, including an initially unavailable or disabled source. It reads
Electron's public versioned fuse schema; Native still verifies the exact owned
package/image, whole-file digest, mapped non-executable data and restoration.
The temporary inspector closes after the bridge handshake. Desktop Adapter
0.2.10 then supplies its ordinary `clientSource` entry, with private application
and backend hashes retained in the plugin. Source replacement/revocation joins
the normal package receipt and can recover the same client after an unsupported
private-source startup. The signed-client acceptance of this integrated bridge
remains separate from the older evidence below.

## Legacy implementation

Core offers a negotiated before-resume phase on the existing
`codlet.client.launch@1/runtime` Host lifecycle. An enabled provider still needs
its own explicit `host.process` and `cdp.raw` grants. A separate authorized
traffic consumer triggers the lifecycle; ordinary startup never invokes it.

The Adapter streams the image hash and fuse wire, recognizes an already enabled
inspector without editing it, and otherwise accepts only the reviewed image:

- `chrome.dll` SHA-256:
  `b6f5c2323c642c3ad3dfdc3501aa94482970f88b4c12db0875ce593aece75c16`
- Fuse v1, nine entries, wire `010011001`, sentinel file offset 281415264.
- Temporary edit: file offset 281415301, ASCII 0 → 1.

The Adapter returns this declarative plan. Core knows neither the DLL/fuse nor
an official plugin identity. Core verifies the retained file and PE data mapping,
attaches a debugger to its exact new suspended child, and applies the data edit
during module load. Executable memory edits are rejected. Disk bytes, signatures,
ASAR contents, TLS validation, system proxies and OS security settings are unchanged.

The original Adapter then installs the Desktop and local backend sources,
confirms their coverage and closes its loopback Node inspector. Closure is
verified at the exact announced port. Equivalent Windows executable spellings
are compared by actual file identity, including verbatim DOS paths.

Core restores original data and page protection at a native breakpoint, detaches
and joins its worker before publishing activation. The debugger remains owned
until restoration: partial edits, image unload, timeout or failed attach
terminate only this newly created client. The debugger's kill-on-exit policy
also applies during this short startup transaction. Core crashes after bootstrap
retain the existing documented limitations.

The shared Windows budget is 15 seconds, including planning/hash checks,
attachment and restoration. Every provider phase is also bounded at ten seconds.
The temporary Node executor and native worker exit after startup; there is no
separate native helper binary to package or keep resident. The research-only C#
helper and environment-variable startup hook have been removed.

## Evidence and limits

The original non-administrator experiment established the entry without changing
the signed file; the final Core implementation also passed real Desktop ordinary
fetch and upload-progress request/response rewrites, plus two completed model
turns over HTTP/SSE. The HTTP fixture preserved a 426 WebSocket rejection and
fallback. Native tests independently verify the data edit, restoration, debugger
detach, image/hash rejection, cancellation, deadline and early process exit.
The integrated WebSocket run completed two modified turns, with three client
frames (prewarm plus two requests), fifteen server frames, and continuation on
the second turn. Both native runs exited with status 0 and confirmed restoration.

These are isolated synthetic-credential tests. The fixture blocks unrelated
Windows sandbox installation; full GUI/onboarding, native sandbox setup, installer
updates and real OAuth still require acceptance. A previous fixture copied only
`codex.exe`, producing a missing sandbox-helper dialog; the harness now stages
and verifies all signed backend companions.

Existing source limits remain: Desktop redirect interception sees initial
requests and final responses, not intermediate 3xx bodies. Browser, remote backend,
Realtime/WebRTC and arbitrary provider protocols are not added by this startup
entry. Unknown disabled-inspector images fail with an explicit compatibility
error, rather than silently claiming interception.

The reviewed bootstrap image is Windows x64. Windows ARM64 needs its own reviewed
image and acceptance. New macOS builds require separate research; Windows process
debugging is not a Mac solution. Existing accepted Mac builds keep their previous
launch path. No disabling of SIP or security policy is part of this design.
Application control on managed Windows devices may still reject process debugging;
do not treat local acceptance as a guarantee on every device.

[Reproduce the integrated fixture](../../../../codex/tests/fixtures/traffic/windows-startup-bootstrap/README.md).

## Windows 26.930

Package `26.930.2377.0` retains fuse v1 / `010011001` in signed `chrome.dll`
SHA-256 `fc42df77197b9357672cc80baa1e6c9894b207756636a2ff6e44e666d4ba9a94`.
Its sentinel moved to 281458144 and its temporary data edit to 281458181.
Desktop Adapter 0.2.7 also pins the new main/bootstrap/Stdio module hashes and
backend `0.159.0-alpha.12.1`; the connection class now shares the bootstrap
module with ApplicationNetwork. Deferred captures read Native's initialized
bindings without invoking its factories.

The bootstrap consumes only its own `--inspect-brk=127.0.0.1:0` argument after
identity verification and before native entry. Node Worker and Electron utility
fork defaults receive the remaining native arguments when the caller omitted
an explicit `execArgv`; explicit native choices are retained. Leaving the
startup break in C++ worker defaults paused the worktree environment reader
after the main inspector closed, even though model traffic and UI readiness
already looked healthy. Ordinary startup has no such hook.

The expanded functional fixture passed 24 checks on this package over both
HTTP/SSE and Responses WebSocket, including cold task loading, actual model
transforms, submit hooks, history, steer/interrupt and scoped plugin retirement.
Restoration/detach and normal exit were confirmed. These controlled results
retain the real-account, installer and platform boundaries above.
