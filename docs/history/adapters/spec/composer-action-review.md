# Composer action review for Windows build 10789

Scope: installed Windows package `OpenAI.Codex_26.917.8451.0_x64`, whose reviewed Renderer entry is `app://-/assets/index-897000035213.js` and Desktop profile reports app version `26.917.62051`, build `10789`. This is a source/fixture review, not a live-client acceptance record.

This is the historical initial review. Current runtime discovery checks these
structural landmarks independently of version numbers and page navigation;
see [the current adapter contract](adapters.md).

The installed ASAR was read directly with `.artifacts/current-client-check/check.mjs` and `composer-scan.mjs`; no source map or translated label was used. Its `webview/index.html` loads the exact entry above. `app-initial-8f0e46979798.js` names `app-primary-b25c952dc388.js` in its dependency map. In that primary module:

- `zht` begins around byte 2,067,753. Its rendered composer root at byte 2,127,304 carries `data-codex-composer-root` and `data-composer-placement` around the complete composer tree. A home composer root at byte 867,213 uses the same marker.
- `tqe` begins around byte 837,634. At byte 840,513 it emits `data-composer-utility-bar-scroll-area` with `role="group"`, a single inner `<div>` containing the native controls.
- `NJ` begins around byte 852,684, wraps `tqe` in the native action bar rail, and appears in the home/action bar paths around bytes 860,808, 865,266 and 868,148.

`codex.ui.composer.action@1` is gated by the exact profile entry and these structural attributes. It does not identify a composer by translated text, inferred class names or a thread-id URL pattern. It requires exactly one reviewed utility bar under each composer root and inserts a separately owned button into the native controls row. If the structure disappears or becomes ambiguous, the button is removed. A click only dispatches an event to the owner's Core-authenticated DOM lease; the consumer must separately read and revalidate its selected thread before any stateful action.

The jsdom fixture covers two composers, route reuse, home/thread placement changes, cold startup, auxiliary/unreviewed windows, drift removal, owner-generation replacement and unrelated message streaming. It does not prove Chromium isolated-world event delivery, exact visual alignment, focus behavior in the live client or macOS support. Those require a later isolated-client acceptance run; `client-versions.json` is unchanged.
