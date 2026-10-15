# Known issues and acceptance boundaries

## Unified Core v1 candidate

GUI and the complete functional test consumer use Core's `context.codex` SDK and explicit state hooks. Core embeds the former UI/Desktop implementation; this repository no longer packages those two legacy providers. Historical Adapter/client observations below are retained with their original identities and do not certify the 1.0.0-rc.1 candidate. Current isolated Native results must name the actual client, source commits, fixture and scope. The candidate is local; it has not been installed into the daily client or publicly released.

SDK declarations are separate from runtime availability and automated/Native verification. Narrow raw permissions expose the author's relevant compatibility responsibility; shared Native DOM and full Node execution are not hostile-code sandboxes. Whole-Core state restoration uses bounded explicit JSON and rejects an active functional test instead of replaying its effects.

## Renderer environment retention

The existing Host/Renderer architecture is retained. Repeated creation of isolated worlds in a long-lived Chromium page can retain those native environments after plugin deactivation. Releasing React roots, timers, listeners, callbacks and SDK references reduces avoidable retention but does not destroy those browser worlds. This is a known limitation, not a claim that every plugin reload is leak-free.

The GUI uses lazy page registration when available and releases its view on departure. The UI Adapter avoids scanning the whole document for ordinary streaming-text changes. Offline Node/jsdom lifecycle and scan tests continue to protect these improvements, but they cannot establish browser-world or process-memory bounds.

Ordinary `Page.reload` or document recreation is not a demonstrated remedy: the prior native pressure experiment observed context counts of 1514 before and 1516 after such reload attempts. A hard recovery requires destroying and recreating the affected WebContents/window, or restarting the client. Preserve work before recovery; a window hidden or closed to the tray may not destroy its WebContents.

Core owns the consolidated evidence and recovery boundary in its [known issues](https://github.com/baoabaob/codlet/blob/main/docs/known-issues.md). Worker and iframe experiments do not establish a production replacement ABI. No Worker execution mode, restricted UI language or automatic migration is introduced by this documentation cleanup.

## Distribution and native acceptance

Reviewed client profiles, package `platforms` metadata and actual device acceptance are different facts. A platform declaration is not a test result. Native Windows ARM64/macOS acceptance must be recorded when performed; a Windows x64 preview or loopback AppServer test does not establish those results.

The Windows x64 package `OpenAI.Codex_26.917.8451.0` reports frontend `26.917.62051` (build `10789`) but loads different renderer assets from the Apple Silicon build with those same identifiers. Its Desktop and UI profile is selected by the actual `index-897000035213.js` entry and retains the Apple Silicon profile separately. Module export identities were reviewed against the Windows archive. UI Adapter/GUI 0.1.3 have been verified in the running Windows client: the visible sidebar entry opens the management page and plugin list after a live update, with the original grants preserved. This UI acceptance does not establish backend or transport acceptance for this client package.

The initial independent distribution rehearsal used private repositories and draft releases. It verified reproducible per-plugin source closures, archive digests, remote ownership checks and idempotent synchronization. That evidence does not establish current public release visibility or public-import acceptance. Git retains the historical receipt details; current release administration uses `dist/release-lock.json` and verified remote state.

The unauthenticated GitHub importer cannot install private repositories or draft releases. Verified installer presets with a bound update channel participate in the normal GitHub update checks. Their first remote replacement requires the existing adoption review; unrelated local author folders are not enrolled automatically.

## Traffic activation boundaries

Desktop Adapter 0.2.15 reviews Windows `26.1002.7124.0` / frontend
`26.1002.52244` / build `13536`. Its new module bindings retain network policy,
native authentication and principal checks, final fetch/upload progress, stdio
framing and account notifications. App Server `0.162.0-alpha.2` passed the same
eight controlled Windows cases in [disposable CI](https://github.com/baoabaob/codlet-plugins/actions/runs/37747179353),
with thirty completed synthetic turns and cleanup. The signed client backend
and official release share the same executable image; admission pins both
complete hashes. An adapter update can restore the Desktop branch in a running
client. If a native backend has pending requests or active turns, recovery leaves
it running and reports `client_source_backend_busy`; its model traffic source
is deferred until an idle reload or the next Codlet launch. Controlled fixtures
do not establish real OAuth or complete desktop/installer acceptance.

Desktop Adapter 0.2.14 reviews the Windows `26.930.7945.0` / frontend
`26.930.61225` / build `13232` main, bootstrap and Stdio modules. It retains the
native final-fetch, network-policy, stdio-send and notification contracts. Its
App Server `0.160.1` profile is backed by [disposable Windows CI](https://github.com/baoabaob/codlet-plugins/actions/runs/37463145066): eight controlled HTTP/SSE/WS cases cover custom/built-in/synthetic ChatGPT auth, cancellation, two-thread routing, cold resume and provider reconfiguration.
The signed desktop binary and the official public release have identical PE
content after excluding only checksum and Authenticode fields; runtime admission
still pins each complete file hash. This evidence does not certify real OAuth,
the full desktop/installer acceptance, or unreviewed client packages.

Desktop Adapter 0.2.13 retries temporarily unavailable reviewed lexical bindings
and performs one final probe after a busy event loop exhausts the wait budget.
It records a bounded readiness snapshot in the system temporary directory
(`codlet-client-source-<pid>-<startedUnixMs>.json`), excluding requests, URLs,
credentials and conversation content. Logging failure cannot reject activation.
Cold startup in the installed client still requires separate verification.

Desktop Adapter 0.2.12 arms the bounded startup readiness budget after the
paused entry frame resumes. An already settled backend route is not rejected
because that budget expired, and a backend route timeout leaves an independently
verified Desktop path active. Regression tests cover these failures and repeat
the packaged source's cold bootstrap in three owned Node children. These
fixtures do not establish signed-client or real model-request acceptance.

Desktop Adapter 0.2.11 fixes the distinction between pre-entry installation and
late recovery. The original phase is captured before awaiting source readiness;
app readiness changing during startup no longer triggers a backend reconnect.
Late recovery still refuses active turns and pending requests, but a busy or
unreviewed backend does not reject an independently reviewed Desktop HTTP path.
Backend coverage stays unavailable until that path is actually attached.

Desktop Adapter 0.2.10 and GUI 0.1.9 support Core Preview 27's client-source
lifecycle. Source-specific startup suspension is recoverable by update/reload
in the same client, including its enabled dependent closure. Core Preview 26
needs one upgrade and new client launch to establish that bridge. First late
recovery may reconnect an idle verified local backend; active turns and pending
requests reject that operation. Owned Node/Host fixtures cover replacement,
rollback, disable, permission revocation and cleanup. Final signed-client/native
acceptance of this integrated release remains pending; the older dated evidence
below does not certify the new bridge.

Windows x64 `26.930.2377.0` requires Desktop Adapter 0.2.7 for granted traffic
consumers. Its Chromium image and main/Stdio module identities changed. The
Adapter also prevents its startup-only inspector break from propagating into
native worker defaults; otherwise worktree environment reads and task resumes
could wait indefinitely. Both source activations and 24 functional checks passed
over HTTP/SSE and WebSocket with owned profiles and synthetic credentials.
Scoped reload/disable/enable confirmed generation cleanup. This establishes the
named local paths, not real OAuth, arbitrary providers or a new MSIX install.

Windows x64 `26.924.2738.0` disables its private Node inspector by default.
The new [owned-client startup bootstrap](spec/windows-startup-bootstrap.md)
restores the existing Desktop and backend sources through the negotiated Core
before-resume phase. The Adapter requires the exact reviewed DLL hash; Core
temporarily changes and then restores one mapped data byte. Signed disk files
remain unchanged. An older Core without this phase still cannot attach traffic
to this build; the integrated source must be packaged together for acceptance.

The production lifecycle passed isolated Desktop fetch/upload rewrites and two
model turns over both HTTP/SSE and WebSocket, including 426 fallback, WS prewarm
and continuation. Core confirmed restoration/debugger detach and normal child
exit. The backend `0.158.0-alpha.2.1` also has standalone error repair,
cancellation and two-thread routing/resume fixtures. These tests used synthetic
credentials in an existing registered Windows package context and blocked
unrelated OS sandbox setup. Full new-MSIX installation, real account sessions,
managed-device protections, Windows ARM64 and the new macOS build remain untested.

Windows package `26.917.8451.0` (frontend 10789, backend `0.155.0-alpha.16.3`) passed isolated exact-child Desktop fetch/upload/redirect and model HTTP/SSE/WS acceptance. Both model protocol runs completed two turns; the HTTP run preserved WebSocket 426 and then fell back to HTTP. The runs used synthetic credentials and loopback endpoints, left the original client identities unchanged and cleaned their owned children. This does not establish live OAuth or arbitrary external provider compatibility.

Composer actions and loaded-thread provider reconfiguration have a reviewed Windows 10789 profile. Provider configuration changes a real conversation; controlled fixtures do not replace device acceptance. Desktop Adapter 0.2.14 adds opt-in ownership-aware restoration through `registerThreadConfiguration({restoreOnDeactivate:true})` and its `handle.reconfigure/restore` methods on Core 0.2.0. Normal Core retirement awaits the original provider/model receipt before Host teardown. Restore each selected idle task before explicitly closing its route or switching away. Active/background tasks, unknown originals, conflicting model changes, lost ownership and forced retirement remain unconfirmed and visible in `configurations.list.restorations`. A different provider chosen later by the user is preserved. Legacy RPC writes and unrelated native resumes are not automatically enrolled; closing their route still does not prove restoration. See [the adapter contract](spec/adapters.md#task-configuration-and-explicit-channels).

The Desktop Adapter's plaintext source is scoped to a newly owned, exact-version Owl main process. Its Desktop branch covers final `performDesktopFetch` HTTP/SSE calls and the upload-progress request path. Its model branch covers a verified local `codex app-server` child routed through provider base URLs for HTTP/SSE and Responses WebSocket. Native reports these as separate `activatedSources`; a working Desktop hook alone does not make model interception available.

Electron's native manual redirect mode cancels a 302 before returning a response. The Desktop source therefore follows redirects in the original Chromium session, checks each destination against the Desktop policy, and authorizes response callbacks at the tracked final origin. Intermediate 3xx bodies and redirected request hops are not plugin interception points. The local app-server provider source has its separate full HTTP/SSE/WS route and is not subject to this Desktop limit.

| Launch state | Result |
| --- | --- |
| No enabled source provider on Preview 27 | Generic Core bridge; no application-specific source hook |
| Verified Desktop JS and local backend | Separate Desktop and model source activation |
| Verified Desktop JS, unsupported backend | Desktop source only; model source reported unavailable |
| All requested private sources unavailable on Preview 27 | Affected closure temporarily suspended; generic bridge retained for update/reload |
| Reviewed Apple Silicon `26.917.62051` local Desktop and app-server | HTTP/SSE and Responses WebSocket paths passed controlled native acceptance |
| Remote/cloud backend, browser networking, attachments, Realtime/WebRTC | Coverage not established |

The old proxy/certificate route was removed. Legitimate user provider CA settings remain scoped to the private provider route. Native Apple Silicon acceptance used a signed versioned `26.917.62051` client with synthetic credentials and local endpoints; it verified both source activations and HTTP/WS model turns, but does not prove live OAuth refresh, enterprise workspace routing, arbitrary provider protocols or native GUI/installer behavior. [The traffic contract](spec/traffic.md) records what each source intercepts and the permissions required for task correlation.

## Pending product work

- The production marketplace uses public GitHub repository search and Core package review. Search covers repository names, descriptions and topics; publisher manifest tags that lack a matching topic are not globally searchable. Missing or incomplete release declarations leave compatibility or cumulative download statistics unknown. The local GUI preview uses synthetic management responses.
- Task-local model/provider configuration is available through `codex.backend.write@1` at thread start/resume; a hook that opts into `turn.start` can also select the model for each turn. Provider changes remain limited to thread start/resume. Live OAuth and uncovered network paths need separate owned-device acceptance. See the [adapter contract](spec/adapters.md).
- Full native UI behavior and installer acceptance must be checked on the final integrated source, not inferred from this repository's offline suite.
