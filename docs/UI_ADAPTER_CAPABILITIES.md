# Native navigation pages

The bundled `codex.ui.adapter` provides `codex.ui.navigation.page@1` in target scope. It runs in the main world with `ui.dom` and `ui.mainWorld` to access the reviewed native router, sidebar and new-task composer. Codlet's manager runs in the isolated world and uses public capabilities. The retired `codex.ui.appearance` and `codex.ui.titlebar.afterMenu` contracts are removed. [Client version information](OFFICIAL_CLIENT_UPDATES.md) is local only; Codlet does not invoke the official updater.

## Registration

`register({ label, icon, token, toolbar? })` is a JSON RPC endpoint. The Core-authenticated invocation supplies the caller plugin ID and generation. `icon` is `Cube` or `CodeSquareSlash`. `toolbar`, when supplied, must be boolean and defaults to false. `token` must identify a connected lifetime marker whose plugin ID and generation match that caller. The runtime helper creates the marker; plugins should call `ui.page()` instead of constructing it.

The result is `{ api: 1, token, path }`, with one stable `/codlet/<encoded-plugin-id>` route per owner. Registering the same marker again is idempotent. A later generation retires the previous registration. Markers are removed by synchronous UI disposal, so cleanup does not rely on sending RPC after a caller's authority has already been revoked.

The reviewed `/avatar-overlay` auxiliary window has no navigation page surface. It returns `{ api: 1, token, path: null, available: false }` after checking the caller and marker. The helper releases the pending marker/container without rendering or reporting an error. No route, sidebar root, or navigation observer is added there.

## Native ownership

`newTaskDraft({prompt})` opens Native's editable local-task composer and returns `{opened:true,submitted:false}`. The prompt must be nonempty and no more than 16384 characters. Only the live caller generation with an active registered page may invoke it; it does not submit a turn. Codlet's Create plugin menu supplies a localized prompt and a short Codlet authoring guide. Native's `rN` initializer and `oN` hook are used inside the existing route providers; no second task store or backend connection is created.

The adapter recognizes only Codex `26.908.40834`, build `8881`, package `26.908.4834.0`, with its exact entry module. It validates a unique native memory router and authenticated route collection. The registered route is appended with a stable explicit ID; existing descriptors and their generated IDs remain unchanged. The audited React Router implementation reparses descriptors on navigation.

For the optional toolbar, the same reviewed `app-initial-d9bed9d614d8.js` module exports the lazy AppShell initializer as `hB` and its live value as `mB`. The adapter invokes that native idempotent initializer before validating `Header` and `HeaderToolbar` as React components (including memo components). Importing the module does not by itself initialize this group. The route places its toolbar host in the actual native Header outlet with `inset: true`; it does not create a second shell bar in the body. This mapping is limited to the exact reviewed build.

Navigation uses the existing navigator's `push` / `replace`. The adapter does not overwrite `listen`, `push`, `replace` or `go`, create a backend connection, manipulate browser history, or hide a conversation behind an overlay. Native route mounting creates the empty page host; departure unmounts it. The renderer helper synchronously unmounts its React tree, then removes its container. Pending business receipts remain in the controller and are queried on re-entry; unsubmitted work and import trust are invalidated.

The native `$R` sidebar component receives `isActive` and owns hover, pressed/focus styling, icon-leading spacing and `aria-current="page"`. The adapter adds a separate native React root after the Scheduled item (or Plugins/Library when Scheduled is hidden). It is outside native drag collections. If the main sidebar is temporarily absent, that navigation root is detached and restored when the sidebar returns. No top-bar fallback or copied control CSS is installed.

Unregistering the active page returns to the last native destination, or `/` when none survives. It removes only its own route identity. Provider teardown removes all page routes and native roots. Build/tree ambiguity fails closed and reports a diagnostic; a client update needs a reviewed profile.
