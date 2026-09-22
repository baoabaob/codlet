# Renderer and UI SDK

Renderer plugins execute complete JavaScript in the declared `isolated` or `main` page world. They may use ordinary DOM, custom CSS, React components and third-party browser libraries. Core's optional `context.ui` API 2 supplies React, upstream components and ownership helpers; it does not reduce UI to a fixed component protocol or JSON language. [renderer.d.ts](../../types/renderer.d.ts) and [renderer-ui.d.ts](../../types/renderer-ui.d.ts) describe the public ABI.

## Execution, permissions and lifetime

Renderer instances belong to a target document and a plugin generation. `ui.dom` covers page DOM access; main-world execution additionally requires `ui.mainWorld`. Isolated JavaScript globals still operate on the shared underlying page DOM. Main-world access is explicitly high trust; neither UI ownership helpers nor DOM attributes create a hostile-code sandbox.

`activate(context)` receives ID/version/generation/world, capability RPC, services, diagnostics, cleanup registration and optional UI support. `onDeactivate` admits at most 64 synchronous callbacks; Core runs them once before deactivation or forced retirement. Do not return a Promise from these callbacks. Use the plugin's asynchronous `deactivate()` only where supported by its lifecycle, remove owned listeners/observers/timers and report an unremovable page patch as `{reloadRequired:true,reason}`.

RPC handlers use the [RPC invocation](rpc.md) contract for nested calls/cancellation. Renderer-only plugins can call [Core services](services.md); no Node permission is required merely for settings, dialogs or approved process operations.

## Complete React integration

```js
let ui;
module.exports = {
  activate(context) {
    ui = context.ui.create();
    const h = ui.React.createElement;
    function CustomView() {
      const [count, setCount] = ui.React.useState(0);
      return h('section', null,
        h('p', null, `Count: ${count}`),
        h(ui.components.Button, { onClick: () => setCount(count + 1) }, 'Increment'));
    }
    ui.mount(ui.container(), h(CustomView));
  },
  deactivate() { ui?.dispose(); ui = undefined; }
};
```

Use the owner's `ui.React` with its components; do not mix another bundled React instance into those roots. `container(parent?)` creates an owned HTMLDivElement (default parent: document body). `mount(container, ReactNode)` returns synchronous `render` and `unmount`. Roots must mount in that UI owner's containers. A container may be reused after unmount; disposal aborts the owner's signal and releases every root, page, style/observer/listener and owned container.

The API also exposes `createPortal`, `flushSync`, `PortalContainer` and `useEscCloseStack`; arbitrary React nodes, DOM refs, layout effects and custom elements remain valid. Third-party code is responsible for its own cleanup. Core cannot automatically undo arbitrary mutations outside its owned resources.

The pinned library supplies Button/ButtonLink, Input/Textarea, Switch/Checkbox, Popover/Menu/Tooltip/Select, SegmentedControl, EmptyMessage, TextLink, LoadingIndicator, icons and Dialog. Current Core bundles Apps SDK UI 0.2.2, React/ReactDOM 19.2.0 and Tailwind 4.1.13. Type definitions enumerate exact exports; dependency licenses and bundled notices remain applicable.

## Native page integration

To request a native full page, declare `codex.ui.navigation.page@1` with Target scope and use `ui.page(options)` or feature-detect the lighter `context.ui.page(options)`. The latter registers navigation without loading the UI SDK until entry and gives `render` a page-scoped UI owner:

```js
const page = await context.ui.page({
  label: 'Example', icon: 'Cube', toolbar: true,
  render({ ui, toolbar }) {
    const h = ui.React.createElement;
    return h(ui.React.Fragment, null,
      toolbar && ui.createPortal(h('span', null, 'Example actions'), toolbar),
      h('main', null, 'Complete custom page content'));
  }
});
// page.dispose() unregisters this page; page.path can be null in an auxiliary window.
```

`render` returns a complete ReactNode. Its optional toolbar is an owned DOM outlet, not a serializable control schema. Native route exit synchronously unmounts the React tree and disposes the page owner; callbacks describe activation/deactivation, not an independent floating overlay. On older API 2 runtimes without the factory helper, create an owner and call `ui.page` with the same options. Ordinary DOM mounting does not require a navigation provider.

Core defines the generic helper contract. Native sidebar/router/header/composer discovery and private client exports belong to the independently distributed [official UI Adapter](https://github.com/baoabaob/codlet-plugins/blob/main/docs/spec/adapters.md), not to this Core specification.

## Styling, locale and input

The SDK scopes upstream CSS and animation/property names to owned roots and uses an owner portal context for overlays. It synchronizes host semantic colors, fonts, theme, direction and locale. Use official control behavior when choosing the SDK; custom layout and complete custom UI remain possible. Avoid global appearance overrides that leak into native page content.

Owner-scoped Escape handling respects composition/modifiers and host-handled events. Preserve normal focus, Tab order, menu/dialog behavior, text selection, IME and reduced motion. Native toolbar and overlay behavior must be verified in an actual client, not inferred from jsdom or a screenshot.

The runtime i18n helper maps Chinese locales to `zh`, other locales to `en`; `t(messages,key,values?)` falls back from Chinese to English and then the key, returning plain text. Change listeners retire with the generation. Translate user-facing labels/errors while retaining technical identifiers. Official components do not translate a plugin's own copy automatically.

## Known reclamation limit

Disposing React roots and SDK objects does not guarantee Chromium destroys an isolated world in a long-lived page. Repeated reloads can retain native environments; ordinary document reload is not a proven hard-recovery boundary. See [Core known issues](https://github.com/baoabaob/codlet/blob/main/docs/known-issues.md). The current architecture is retained; experiments with frames/Workers do not establish a replacement ABI or justify reducing custom UI capability.
