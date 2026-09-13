# Official UI dependencies

Codlet directly bundles **@openai/apps-sdk-ui 0.2.2**, **React / React DOM 19.2.0** and **Tailwind CSS 4.1.13**, pinned in `frontend/package-lock.json`. Buttons, links, inputs, switches, checkboxes, select menus, segmented controls, popovers, tooltips, indicators and icons are the upstream implementations. There are no replacement renderer controls or adapter appearance recipes.

- Upstream: https://github.com/openai/apps-sdk-ui (MIT).
- Official integration documentation: https://developers.openai.com/plugins/build/chatgpt-ui
- Full dependency notices: [THIRD_PARTY_UI_LICENSES.txt](THIRD_PARTY_UI_LICENSES.txt).

`frontend/src/runtime.jsx` owns React roots, shared styles, theme/language synchronization and disposal. `frontend/src/codlet/layout.css` contains page composition only. Build output goes to `bundled/runtime/ui.js` and the renderer bundles; edit source files and regenerate them together.

Two integration boundaries are deliberately adapted at build time, with source guards that fail when the pinned upstream code changes:

1. Radix's public `Portal.container` is supplied through context so popovers/tooltips stay under the owning plugin's theme and lifetime. Select uses the same upstream popover. The upstream Escape stack and Radix capture listener are restricted to that owner, ignore composition/modifiers and host-handled events, and preserve the upstream Popover's own prevention of Radix's default dismissal. This avoids consuming Escape in the host or closing two layers with one key.
2. All upstream CSS selectors are scoped to `[data-codlet-official-ui]`; Tailwind properties and animation names are namespaced. The upstream layer order is established before esbuild's dependency CSS and placed under `codlet-sdk`. Unused KaTeX font-face declarations are removed. Colors, dimensions and control interaction recipes are upstream CSS, not Codlet approximations.

The navigation boundary is separate from this public component library. The reviewed desktop profile reuses the installed client's actual `$R` sidebar component, React and React DOM; proprietary client code is never copied into distribution bundles. Only the native boundary adapter has `ui.mainWorld`; the manager remains isolated. See [native integration evidence](UI_COMPONENTS_2026-09-13.md).
