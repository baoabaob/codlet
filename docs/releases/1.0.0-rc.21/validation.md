# 1.0.0-rc.21 validation

**Local Windows x64 correction in preparation.** This release fixes an rc.20
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
package for an exact rc.20 resident fingerprint can use the existing source
handoff and persistence protocol without reloading renderer plugins. A complete
Windows installer remains available for other resident builds.

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

Current-process recovery, package identities and public publication will be
recorded after they complete. The previous rc.20 synthetic
conversation/navigation runs do not establish authenticated account, settings
or Statsig network acceptance.
