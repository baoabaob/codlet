# Renderer UI API 2

Updated 2026-09-13. The former API 1 DOM helpers and appearance recipes have been removed. This API exposes the actual pinned Apps SDK UI components and React instance, plus ownership and native-page integration.

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

`page({ label, icon, render, onActivate?, onDeactivate? })` waits for the document, registers a caller-owned route, and renders only while that native route is mounted. Departure unmounts React synchronously; re-entry calls `render` again. Keep long-lived RPC receipt state outside the component tree, invalidate page-local asynchronous callbacks, and check `ui.signal` for owner retirement.

`container(parent?)` / `mount(container, content)` are available for existing extension-owned surfaces. The returned mount has `render(next)` and synchronous `unmount()`. The same container can be mounted again after unmounting. `dispose()` is idempotent and is automatically registered with the renderer lifecycle: pages, roots, shared styles, theme/locale observers and media listeners retire together. It restores prior focus only if the retiring owner still held focus.

Use upstream `Button`, `Input`, `Textarea`, `Switch`, `Checkbox`, `Popover`, `Tooltip`, `Select`, `SegmentedControl`, `TextLink`, `ButtonLink` and `LoadingIndicator` from `ui.components`. Use hooks and JSX normally. The `PortalContainer` and scoped `useEscCloseStack` exist for composition of custom plugin content. Escape does not close a whole navigation page. A confirmation may register its own Escape handler; upstream popovers close before that confirmation.

Build: `cd frontend && npm ci --ignore-scripts --no-audit --no-fund && npm run build`. Tests: `node --test tests/*.test.mjs` from the repository root. Start `node scripts/serve-ui-preview.mjs` and open its printed loopback URL for actual Chromium layout verification. The preview simulates host/RPC data and has no real file or network mutations.
