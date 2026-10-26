# Core-owned Native launch source

Core imports the full former Desktop launch implementation, including Electron
entry/bootstrap hooks, owned backend process configuration, plaintext routing,
source diagnostics and semantic Codex traffic helpers. Modular source and
upstream licensing live in [codex/](../../codex/README.md); Core's frontend build
generates the embedded Host bundle and
`runtime/core-modules/client-source.cjs`.

The internal provider is trusted only when its complete manifest and immutable
renderer/Host sources match the embedded Core snapshots and have no external
authorization record. Matching a historical provider ID alone is insufficient.
External providers retain their explicit raw Host/CDP launch admission. Standard
consumers never receive these implementation grants.

Installed Core uses its executable directory as the existing Host cwd and a
synthetic module filename. Its embedded snapshot contains all non-builtin
dependencies; the original source checkout and separate adapter directory are
not runtime dependencies. Core returns its Native source directly for the private
launch handshake. No external adapter Host is spawned merely to retrieve it.

For subsequent compatible updates, the fixed
`runtime/core-modules/activation.json` pin must validate before adjacent source
can override the embedded default. The pin binds the fixed source path and bytes
to SHA-256, the current embedded bridge/bootstrap hashes and protocol, and the
actual retained runtime file identities. Unpinned source is ignored. Malformed
pins or source mismatches fail before executing candidate code. A changed
resident Core makes the previous pin inapplicable and falls back to its new
embedded source. [Management](management.md) describes the
takeover and persistence receipts.

The Native source explicitly transfers JSON state and references live
Core-owned resources logically. Desktop routes, backend state and stream
forwarding remain resident. Compatible handoff snapshots explicit state, stops
old hook authority, installs the candidate, restores its snapshot and obtains
takeover acknowledgment before closing the old owner. Failure resumes the old
hooks; arbitrary JavaScript objects or processes are not serialized. Initial
legacy migration differs from a subsequent compatible handoff.

The imported profiles and probes retain their original platform evidence. A
Windows fixture or retained Native PID is not proof of macOS compatibility or
session continuity. Claims of continuity require the owned Native connection,
backend route and running stream to remain functional across takeover.
