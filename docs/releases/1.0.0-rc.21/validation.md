# 1.0.0-rc.21 validation

**Windows x64 preview published.** This release fixes an rc.20
regression in the Native Desktop HTTP source. UI implementation `0.1.18`, Desktop
renderer `0.2.21` and the optional GUI `1.0.0-rc.6` are unchanged.

## Reported failure and correction

The 2026-10-30 local rc.20 run with Native package `26.1023.6621.0` failed account,
workspace settings and Statsig bootstrap requests with `desktop_request_closed`.
The Native AppServer remained connected. Failed feature configuration requests
explain the unavailable feature gates and classic sidebar observed in that run;
the official package had not been downgraded.

Electron's `ClientRequest` is a Writable upload stream with automatic destruction.
Its `finish` and `close` events can precede the HTTP `response`. rc.20 incorrectly
used upload `close` as a terminal HTTP failure. The corrected bridge waits for
the response, its actual error, or its abort event. It preserves Native errors
and never replays an already dispatched request.

The correction is contained in the Native client source component. A targeted
package for an exact portable rc.20 resident fingerprint can use the existing
source handoff and persistence protocol without reloading renderer plugins.
The rc.20 updater deliberately clears the online selector for MSI installations;
these use the complete Windows installer after the client exits.

## Validation

- The new regression uses a real Node Writable with `autoDestroy: true`. It
  reproduces `desktop_request_closed` before the fix and passes afterward.
- All **30** Desktop plaintext tests pass. The new case covers both fetch and
  upload-progress paths, response after upload close, error after close, abort
  after close, original error identity and exactly one dispatch per request.
- An independent probe extracted the exact `ClientRequest` implementation from
  the installed `.6621` engine. With a local HTTP URLLoader bridge, all six
  success/error/abort cases pass; restoring the old listener reproduces the
  failure. This checks the actual JavaScript method, not a complete Native app.
- A second extracted-method probe reproduces an uncaught
  `net::ERR_HTTP2_PING_FAILED` after rc.20 abandons a late response. rc.21 delivers
  the error to the caller with zero uncaught exceptions in both fetch paths.
- All **11** source/bridge handoff tests pass, including original backend and
  route retention, stream continuity, rollback and uncertain receipts.
- All **7** focused online package tests and the offline release plan/draft/
  publish checks pass. Source-only packages retain the resident fingerprint and
  reject contradictory module selection, unsupported ABI and changed residents.
- The earlier startup-disconnect observation regression also passes and is
  retained in this source revision; it is separate from the HTTP correction.

The extracted browser-init source SHA-256 is
`33356e43c996507698ed11629bbb4d1a989f34e850f06da098465487c00bd9c0`.
The six-case probe and its negative control are retained in the 2026-10-30 HTTP
lifecycle review report. Private engine copies and profiles were removed after
all owned processes exited.

## Published package identities

[v1.0.0-rc.21](https://github.com/baoabaob/codlet/releases/tag/v1.0.0-rc.21)
was published on **2026-10-30 at 07:54:34 UTC**, release ID `428769152`, with
`draft: false` and `prerelease: true`. Its source commit is
`459329fb0b0346a155024053790c1069ce5c2fdc`.

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `Codlet-1.0.0-rc.21-windows-x64-setup.exe` | 8,878,592 | `2bf1eaab8b5276c7c8206a88047f08bd0aec26c379d9224f98f8e819fc18dabc` |
| `codlet-runtime-1.0.0-rc.21-win-x64-portable.zip` | 9,843,259 | `df4bb110bf238acaf6e1ff8871370c34837fb600212e1cf00d98e93f7366a893` |
| `codlet-online-1.0.0-rc.21-win-x64-18bd6bfba413d37c.zip` | 9,923,889 | `d1407745bbcdee3a624ebd66466aca06309bf666f54efc90bb15caddc2133920` |

All six canonical public asset URLs, including both catalogs and checksums,
were fetched without authentication and matched their recorded size, SHA-256
and GitHub asset digest. The targeted package matches rc.20 resident fingerprint
`18bd6bfba413d37cf50aac0d7220628b94c866c327fa853c5906bb64ed4c0331`
and updates only Native source
`838e012a43d892f62938c080a6c24eebca053a231c601efd89ea37faf511eea2`.

Core embedding, installer payloads, MSI structure and GUI publisher signature
were verified locally. The setup remains unsigned. Current-process activation
and MSI upgrade are separate checks; the previous rc.20 synthetic conversation/
navigation runs do not establish authenticated account, settings or Statsig
network acceptance.

## Actual MSI update selection

The running rc.20 MSI installation selected the complete rc.21 archive
(`df4bb110…`), despite matching the targeted package's resident files. The
temporary public-API helper rejected that candidate before downloading or
installing because it was pinned to the source-only artifact. Its receipt records
one check and zero download/install dispatches. That helper was removed.

This confirms the existing updater's MSI selection rule; static package
compatibility alone does not make an MSI owner eligible for online activation.

The subsequent helper was pinned to the actually selected complete candidate
`2e03988b8c0ecb073cd6839c6fc319d5c9d02cd685bede879545982439c14a78`.
It called the public download and install methods once each. The running owner
confirmed all **18,721,851 bytes** (runtime plus setup), `phase: deferred`,
`activation.mode: nextStart`, version rc.21, component `core-runtime`, and
`persistencePending: false`. The matching next-start intent is persisted. Both
temporary helpers were removed after their receipts were retained.

This is confirmed staging for natural exit, not completed MSI installation or
post-upgrade UI recovery. The user-controlled client has not been closed by the
repair workflow.
