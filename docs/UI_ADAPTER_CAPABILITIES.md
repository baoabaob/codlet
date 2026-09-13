# Native navigation pages

The bundled `codex.ui.adapter` provides `codex.ui.navigation.page@1` in target scope. It runs in the main world with `ui.dom` and `ui.mainWorld` to access the reviewed native router and sidebar component. Codlet's manager runs in the isolated world and uses the public page helper. The retired `codex.ui.appearance` and `codex.ui.titlebar.afterMenu` contracts are removed.

## Registration

`register({ label, icon, token })` is a JSON RPC endpoint. The Core-authenticated invocation supplies the caller plugin ID and generation. `icon` is `Cube` or `CodeSquareSlash`. `token` must identify a connected lifetime marker whose plugin ID and generation match that caller. The runtime helper creates the marker; plugins should call `ui.page()` instead of constructing it.

The result is `{ api: 1, token, path }`, with one stable `/codlet/<encoded-plugin-id>` route per owner. Registering the same marker again is idempotent. A later generation retires the previous registration. Markers are removed by synchronous UI disposal, so cleanup does not rely on sending RPC after a caller's authority has already been revoked.

## Native ownership

The adapter recognizes only Codex `26.908.40834`, build `8881`, package `26.908.4834.0`, with its exact entry module. It validates a unique native memory router and authenticated route collection. The registered route is appended with a stable explicit ID; existing descriptors and their generated IDs remain unchanged. The audited React Router implementation reparses descriptors on navigation.

Navigation uses the existing navigator's `push` / `replace`. The adapter does not overwrite `listen`, `push`, `replace` or `go`, create a backend connection, manipulate browser history, or hide a conversation behind an overlay. Native route mounting creates the empty page host; departure unmounts it. The renderer helper synchronously unmounts its React tree, then removes its container. Pending business receipts remain in the controller and are queried on re-entry; unsubmitted work and import trust are invalidated.

The native `$R` sidebar component receives `isActive` and owns hover, pressed/focus styling, icon-leading spacing and `aria-current="page"`. The adapter adds a separate native React root after the Scheduled item (or Plugins/Library when Scheduled is hidden). It is outside native drag collections. If the main sidebar is temporarily absent, that navigation root is detached and restored when the sidebar returns. No top-bar fallback or copied control CSS is installed.

Unregistering the active page returns to the last native destination, or `/` when none survives. It removes only its own route identity. Provider teardown removes all page routes and native roots. Build/tree ambiguity fails closed and reports a diagnostic; a client update needs a reviewed profile.
