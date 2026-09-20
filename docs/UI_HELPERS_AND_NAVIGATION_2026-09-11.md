# Renderer UI API 2

Updated 2026-09-14. The former API 1 DOM helpers and appearance recipes have been removed. This API exposes the actual pinned Apps SDK UI components and React instance, plus ownership and native-page integration.

```jsx
export async function activate(context) {
  const ui = context.ui.create();
  const React = ui.React;
  const { Button, Input, Switch } = ui.components;
  await ui.page({
    label: 'My tools',
    icon: 'Cube',
    render: () => React.createElement(Button, {
      color: 'primary', variant: 'solid', size: 'md',
      onClick: () => doWork(ui.signal), children: 'Run'
    })
  });
}
export function deactivate() {}
```

Declare `ui.dom` and `requires: [{ "name": "codex.ui.navigation.page", "api": 1, "scope": "target" }]`. A normal page consumer stays in the isolated world. API 2 `create()` takes no appearance object. Component props and icons follow upstream types; use the supplied React instance to avoid duplicate hook dispatchers. [Type declarations](../types/renderer-ui.d.ts) use type-only imports from the official package.

`page({ label, icon, toolbar?, render, onActivate?, onDeactivate? })` waits for the document, registers a caller-owned route, and renders only while that native route is mounted. Departure unmounts React synchronously; re-entry calls `render` again. Keep long-lived RPC receipt state outside the component tree, invalidate page-local asynchronous callbacks, and check `ui.signal` for owner retirement.

With `toolbar: true`, `render({ toolbar })` receives an owned container inside the actual native `AppShell.Header` / `HeaderToolbar` outlet. Render controls with `ui.createPortal(controls, toolbar)` from the same page React tree so the toolbar and body share state. The default is `false`, with `toolbar: null`. Do not add another header-height row inside the page. Navigation and owner disposal unmount the page and toolbar together, including exceptional React/callback cleanup.

Page overlays use a separate theme-scoped owned container directly under `document.body`, avoiding native toolbar/scroll-region clipping. Keep the inherited portal destination when placing toolbar controls: do not wrap them in `PortalContainer value={toolbar}`. Escape ownership includes the body, toolbar and overlays, while other pages retain their own scope. Route departure retires all three surfaces, including open menus and tooltips.

In the reviewed Desktop pet window, `page()` resolves with `path: null`, releases its pending DOM, and never invokes `render` or activation callbacks. Unsupported builds and ambiguous routers still report errors.

`container(parent?)` / `mount(container, content)` are available for existing extension-owned surfaces. The returned mount has `render(next)` and synchronous `unmount()`. The same container can be mounted again after unmounting. `dispose()` is idempotent and is automatically registered with the renderer lifecycle: pages, roots, shared styles, theme/locale observers and media listeners retire together. It restores prior focus only if the retiring owner still held focus.

Teardown completes all cleanup steps even if a React effect or page callback throws. Explicit disposal reports the collected error afterward; navigation cleanup reports it through the plugin diagnostic channel after retiring the failed page. Repeated disposal is safe. Theme synchronization copies the host's resolved semantic text/surface/border/focus/warning colors into owned roots and maps its accent Switch track/thumb colors to the official component variables, without changing the host. The reviewed page-search background and outline, thread content width, and panel padding are also bridged into private Codlet variables; see [layout and settings](LAYOUT_AND_SETTINGS_2026-09-14.md).

Use upstream `Button`, `Input`, `Textarea`, `Switch`, `Checkbox`, `Popover`, `Menu`, `Tooltip`, `Select`, `SegmentedControl`, `TextLink`, `ButtonLink` and `LoadingIndicator` from `ui.components`. Use hooks and JSX normally. The `PortalContainer` and scoped `useEscCloseStack` exist for composition of custom plugin content. Escape does not close a whole navigation page. A confirmation may register its own Escape handler; upstream popovers close before that confirmation.

Build: `cd frontend && npm ci --ignore-scripts --no-audit --no-fund && npm run build`. Tests: `node --test tests/*.test.mjs` from the repository root. Start `node scripts/serve-ui-preview.mjs` and open its printed loopback URL for actual Chromium layout verification. The preview simulates host/RPC data and has no real file or network mutations.
