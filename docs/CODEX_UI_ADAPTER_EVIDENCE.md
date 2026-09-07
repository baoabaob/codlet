# Codex UI Adapter Evidence

Captured: 2026-09-07. Repository baseline: `master 2ecb27ee2b58271e879cfdf817605c9701425ef2`.

## Inspected Build

- Installed MSIX: `OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0`, discovered with read-only `Get-AppxPackage`.
- Electron application version: `26.901.51231` (`package.json:5`).
- Archive: `C:/Program Files/WindowsApps/OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0/app/resources/app.asar`.
- Archive SHA-256: `E75BAE2B8A02F174C7CEEED6D631AAFF355E44F8AF5C798FA3628089F11D659E`.
- Selected files were extracted read-only with the existing `@electron/asar` library into `C:/Users/cccake/Documents/ChatGPT/codlet-research/ui-adapter-26.901.6511.0/`.
- Research source, extraction scripts, and browser checks remain outside this repository. No official source or assets are shipped with this change.
- The user-provided crop shows View, Help, and a requested adjacent entry position. The crop alone does not establish whether the menu is native or DOM.

The older `26.831.2377.0` package in `RESEARCH_BASELINE.md` is historical evidence. It is not the source of the current menu selection.

## Menu Rendering

The visible Windows application menu in this build is a renderer DOM menubar.

| Local archive file | Evidence |
| --- | --- |
| `.vite/build/main-DpnWwRdP.js:1526` | Windows/Linux windows use `autoHideMenuBar`; after creation the window manager calls `removeMenu()`. The primary Windows window uses a hidden title bar with an overlay. |
| `.vite/build/main-DpnWwRdP.js:1484` | Main still constructs an Electron application menu with `Menu.buildFromTemplate` and `Menu.setApplicationMenu`. Its existence does not mean the visible Windows top row is a native menu surface. |
| `webview/assets/app-initial-f87238153a19.js:1922` and `:8306` | Electron on Windows/Linux sets the root `data-codex-window-chrome` value to `application-menu`; Mac/unknown use `native`. |
| `webview/assets/app-initial-f87238153a19.js:1908` | Application menu identifiers include `file-menu`, `edit-menu`, `view-menu`, and `help-menu`. |
| `webview/assets/app-initial-f87238153a19.js:6355` | `ApplicationMenuTopBar` renders the application mark and a Radix menubar. Its visible trigger order is File, Edit, View, Help. The Radix root renders `role="menubar"`, with button triggers having `role="menuitem"` and IDs formed as `application-menu-trigger-${menuId}`. |
| Same renderer line | The top bar is a separate child of the workspace layout. It is not the descendant `app-shell-header-context-menu-surface` used by the old adapter. The application menu includes a hidden content-anchor trigger; this is not an additional visible menu command. |
| `webview/assets/app-initial-5b0a474bff5e.css:1` | The top bar is a horizontal flex row, aligned centrally, with `height: var(--height-toolbar-sm)`. The token is `36px`. It is a draggable region; its buttons are explicitly `no-drag`. |

The host menubar also has its own focus collection, arrow-key handling, mnemonics, and private menu invocation service. Codlet does not register with that collection or invoke that service.

## Mount Selection

The preferred placement requires all of the following observed structure:

1. `document.documentElement[data-codex-window-chrome="application-menu"]`.
2. A descendant `[role="menubar"]` with direct child `[role="menuitem"]` triggers whose IDs are `application-menu-trigger-file-menu`, `application-menu-trigger-edit-menu`, `application-menu-trigger-view-menu`, and `application-menu-trigger-help-menu`.
3. Those four triggers occur in the observed order.

The adapter inserts a span as the menubar's immediately following sibling in the same parent row. The entry therefore follows Help visually while remaining outside the host's Radix collection. No localized labels or hashed CSS module class names are matched. Codlet does not change official menu labels, children, padding, or event handlers.

If the preferred structure is absent, the only fallback is the previously implemented exact renderer anchor: a `header[data-app-shell-header-layout]` containing `[data-testid="app-shell-header-context-menu-surface"]`. The span is inserted first inside that surface. Current source still contains these markers, but this is a different header row and is reported as `legacy-header`; it does not establish placement after Help. A generic header, an unrelated menubar, or an incomplete application menu does not qualify by itself.

The capability is unchanged: `{ name: 'codex.ui.titlebar.afterMenu', api: 1, scope: 'target' }`. `getMount` always returns the stable token `codex.ui.titlebar.afterMenu@1`, including when unavailable. The additive diagnostic `placement` is `application-menu`, `legacy-header`, or `null` when unavailable. Consumers locate the provided `data-codlet-capability` marker; they do not need host selectors or placement diagnostics.

The owned span also carries `data-codlet-provider="codex.ui.adapter"` and its activation generation. It is `inline-flex`, vertically centered, non-shrinking, pointer-enabled, and `-webkit-app-region: no-drag`. The mount has the 36px row height; this is not the consumer button height. The observed native trigger uses 14px text, unit line height, 4px vertical padding and a 1px transparent border, producing approximately 24px under default sizing. Native zoom, fonts and theme settings may change the rendered dimensions.

## Theme Contract

An adapter-owned stylesheet defines aliases only on the owned mount selector and `[data-codlet-ui-theme="codex.ui.titlebar.afterMenu@1"]`. A GUI portal outside the mount opts in with that attribute. GUI code consumes the aliases; host variables and selectors remain adapter knowledge.

All mappings below are CSS `var()` references. They resolve in the consumer element's native theme ancestry, so theme, font and size changes update through CSS inheritance without snapshotting colors or writing inline styles to the host root or body.

| Codlet property | Observed host property and meaning | Fallback |
| --- | --- | --- |
| `--codlet-ui-bg` | `--color-background-application-menu`, background used by application-menu content; second choice `--color-background-elevated-primary`, primary elevated surface | `Canvas` |
| `--codlet-ui-fg` | `--color-text`, normal foreground used by the host `text-default` utility | `CanvasText` |
| `--codlet-ui-muted` | `--color-text-tertiary`, tertiary foreground used by inactive application-menu triggers | `GrayText` |
| `--codlet-ui-border` | `--color-border`, theme's standard border color | `ButtonBorder` |
| `--codlet-ui-hover` | `--color-background-button-tertiary-hover`, transparent tertiary-button hover surface | `ButtonFace` |
| `--codlet-ui-active` | `--color-codex-application-menu-selection`, background used by the open top-menu trigger | `ButtonFace` |
| `--codlet-ui-focus` | `--color-border-focus`, focus-border color supplied by the theme | `Highlight` |
| `--codlet-ui-font` | `--font-sans`, UI sans font resolving through the host font-family setting | `system-ui, sans-serif` |
| `--codlet-ui-font-size` | `--text-base`, base text size used by top-menu triggers | `14px` |
| `--codlet-ui-menu-height` | `--height-toolbar-sm`, height of the application-menu row | `36px` |
| `--codlet-ui-radius` | `--radius-md`, medium radius including the host corner-radius scale | `6px` |

Variable evidence is in `app-initial-5b0a474bff5e.css:1` and the theme construction code in `app-initial-f87238153a19.js:6328`. The CSS defines `--color-text` through `--vscode-foreground`, tertiary text through `--vscode-descriptionForeground`, and application-menu selection through `--vscode-menubar-selectionBackground`. These aliases belong to the desktop stylesheet; Codlet does not require a VS Code runtime. The theme generator supplies application-menu/elevated backgrounds, border/focus colors and tertiary-button states. Top-menu rendering on line 6355 confirms the selected-trigger background usage. Line 8224 applies theme styles to the document element and UI font/size settings to both the document element and body.

The default palette definitions include light/dark application-menu backgrounds `#ffffff` / `#1b1b1b`, foregrounds `#0d0d0d` / `#ededed`, tertiary foregrounds `#8f8f8f` / `#afafaf`, and accent `#3a83f7`. These are source defaults, not measurements of the user's current theme; custom themes are generated at runtime. The top row can use a separate transparent or tinted title-bar background. The alias `bg` describes the elevated menu/panel surface, so an entry that should blend into the title row uses a transparent default background.

The neutral active fallback deliberately avoids pairing the system Highlight background with CanvasText. Focus outlines use Highlight; the additional accent/on-accent aliases below pair Highlight with HighlightText. System fallback appearance still follows the document's color-scheme settings.

## Native Component Mapping

This follow-up was researched from the same installed archive on 2026-09-07, on repository baseline `master 42bed1b8540c70b0c808d1f4bc418c3a3a4e7ee4`. Selected settings and dialog consumption modules were extracted into the same external research directory. No browser was used for this follow-up. The measurements below are source-defined CSS values, not screenshots or measurements of a live Codex window. Pixel conversions assume the source spacing unit `.25rem` equals 4px and the default UI font setting; native zoom/font/radius settings can change them.

### Settings Rows And Groups

`plugins-settings-row-b5019e66889f.js:1` imports the row through the `Ku` export; `app-initial-f87238153a19.js:9050` maps that export to the `T5` row component. Its structure and the `iis` label and `lis` group components are on line 8233.

| Component | Source-defined layout and typography |
| --- | --- |
| Default settings row (`T5`) | Horizontal flex, centered controls, space-between; 16px horizontal and 12px vertical padding, 24px gap between label content and controls. There is no default minimum row height. |
| Compact settings row | Same structure with 8px vertical padding and 16px label/control gap. The distinct nested-row variant has a 40px minimum and responsive stacking; these are not default-row properties. |
| Label group (`iis`) | Flexible minimum-width-zero area; optional icon, 12px icon/text gap; title/description stack has 2px gap. Title uses `text-sm` (default 13px), normal foreground, medium weight 500. Description uses `text-xs` (default 12px), 16px line height and secondary foreground. |
| Control group | Non-shrinking flex, maximum width 100%, centered vertically, 8px between multiple controls. A render-function control receives generated `aria-labelledby` and `aria-describedby` IDs for the associated row text. |
| Group (`lis`, `sis`) | Vertical group with 1px border, `--radius-2xl` corners, hidden overflow by default. Background is `--color-background-panel`, falling back to `--color-background-primary-soft-alpha`. Dividers between adjacent children are 0.5px, inset 16px from both sides, and do not intercept pointer input. |

`--height-token-settings-row: 4rem` (64px at this baseline) exists in the stylesheet and is used by an optional empty/loading-row layout. It must not be mistaken for the height of `T5`: plugin rows size from their contents plus padding. Wrapped descriptions must be allowed to increase row height.

The actual settings page is a routed page with its own navigation. A 600px dialog containing a settings group is a Codlet composition using the observed public-facing dialog and row shapes; it is not a claim that the host settings route itself is a 600px dialog. Empty navigation sections are not supplied by the adapter.

### Switch And Buttons

The switch (`sq`/`h6i`) is on `app-initial-f87238153a19.js:2862`. It uses a real button with `role="switch"`, boolean `aria-checked`, a disabled property and a checked/unchecked state. The visual track and thumb are presentation-only spans. The click callback respects `preventDefault()` and disabled state before requesting the new checked value.

| Switch part/state | Source-defined value |
| --- | --- |
| Default track and thumb | 32px by 20px track; 16px by 16px thumb; circular corners. |
| Small variant | 28px by 16px track; 12px by 12px thumb. |
| Thumb travel | 2px unchecked offset, 14px checked offset; direction reverses under RTL. |
| Unchecked | Foreground mixed at 10% with transparency. |
| Checked, default accent tone | `--color-chart-blue` track and `--gray-0` thumb/border; `--gray-0` is white in this stylesheet. |
| Checked, neutral tone | Normal foreground track and normal surface thumb, with a transparent thumb border. |
| Interaction | 2px focus ring; disabled opacity 60%; color and thumb-transform transition uses `--transition-duration-basic` (150ms), ease-out. |

The shared `KN` button and its variants are on line 2068. This is the general desktop button consumed by dialogs; the separately named `button-2d99bf47e427.js` is a different full-width feature button and is not the settings-button baseline.

| Button variant | Source-defined size and shape |
| --- | --- |
| `default` | 8px horizontal / 2px vertical padding, `text-sm`, 18px line height, 1px border: approximately 24px high; full/pill radius. |
| `medium` | 16px horizontal / 6px vertical padding, `text-base` (default 14px), 18px line height, 1px border: approximately 32px high; `--radius-lg`. |
| `dialog` | At least 36px high, 12px horizontal padding, `text-sm`, medium weight; pill radius. |
| `dialogAction` | At least 36px high, 16px horizontal padding, `text-sm`, medium weight, non-shrinking; pill radius. |
| `secondary` color | Normal foreground, transparent border, 5% foreground background; enabled hover/open uses 10%. |
| `danger` color | `--color-chart-red` foreground, transparent border, 10% chart-red background; enabled hover uses 20%. This is the subtle danger variant, distinct from solid danger. |
| Shared behavior | 2px focus ring with zero offset, no-drag, selection disabled. Disabled opacity is 40%; loading adds a spinner and disables the button. |

Dimensions and corner rules belong to their named variant. In particular, a 32px medium button with pill corners is not the exact source medium variant.

### Dialog Composition

The Radix-based dialog wrapper (`cH`/`bui`), header (`gH`), body (`_H`), section (`yH`) and footer (`vH`) are on line 2800. The corresponding CSS tokens and utility implementations are in `app-initial-5b0a474bff5e.css:1`.

| Dialog part | Source-defined value |
| --- | --- |
| Width variants | `default`: 520px; `narrow`: 380px; `compact`: 420px; `wide`: 600px. These use the same default surface treatment. |
| Placement/height | Centered by default, fixed unless given a portal container; maximum width 92vw. Default/compact/wide do not have a hard maximum height. A ResizeObserver tracks natural content height for animation. Tall/editor variants have separate height constraints. A GUI viewport-height clamp/scroll region is an additional Codlet adaptation. |
| Surface | Elevated-secondary surface at 90% opacity, background blur, 0.5px standard-border ring, `--radius-3xl`, shadow `--shadow-lg` (0px 4px 8px -2px, black at 10%). The radius base is 20px before the native corner-radius scale. |
| Overlay | Electron's default overlay is fixed across the viewport with black `#00000022`. It is separate from the content's translucent surface. |
| Close control | Default control is at top/right 16px with 4px padding around the small icon, a hover background and a 2px focus ring. An accessible close label is supplied. |
| Body | Default padding is 20px on all sides; normal 14px base text with 1.5 line height. |
| Header | Vertical stack with 12px gaps; title uses `--text-heading-md`, medium weight and 28px line height; subtitle defaults to base-size tertiary text. Source title typography includes -0.36px tracking; this is a recorded host value, not a requirement to override Codlet's zero-tracking design constraint. |
| Sections and footer | Non-first sections have 12px top padding. Footer is right-aligned with 12px gaps; it assigns `medium` size to buttons without an explicit size and expands a single button across the width by default. |

A real confirmation consumer is also present on line 8300: the logout dialog composes the shared dialog, form body, title/subtitle and ghost-cancel/danger-submit buttons. Its narrow variant additionally overrides body padding to 24px, content gap to 20px and footer gap to 8px. These consumer overrides are not the generic dialog defaults.

### Implemented Semantic Aliases

The follow-up adds exactly the 16 aliases requested by the GUI consumer. They are additive to the original 11 and use the same owned mount/opt-in theme selectors. The CSS is scoped to those selectors; no host root or body styles are set.

| New property | Native source and meaning | Fallback |
| --- | --- | --- |
| `--codlet-ui-surface` | `--color-surface`, normal page surface, resolving through `--color-background-surface` | `Canvas` |
| `--codlet-ui-surface-raised` | `--color-surface-elevated-secondary`, opaque elevated/control surface, resolving through the dropdown/control-opaque background | `Canvas` |
| `--codlet-ui-surface-group` | Settings group `--color-background-panel`, then `--color-background-primary-soft-alpha` | `Canvas` |
| `--codlet-ui-secondary` | `--color-text-secondary`, description foreground, distinct from tertiary/muted text | `GrayText` |
| `--codlet-ui-accent` | `--color-chart-blue`, the default checked-switch tone | `Highlight` |
| `--codlet-ui-on-accent` | `--gray-0`, the default accent-switch thumb/border (white) | `HighlightText` |
| `--codlet-ui-font-small` | `--text-sm`, settings label and small button size | `13px` |
| `--codlet-ui-font-caption` | `--text-xs`, settings description size | `12px` |
| `--codlet-ui-font-heading` | `--text-heading-md`, shared dialog title size | `20px` |
| `--codlet-ui-dialog-radius` | `--radius-3xl`, default dialog corners including native scale | `20px` |
| `--codlet-ui-group-radius` | `--radius-2xl`, settings group corners including native scale | `16px` |
| `--codlet-ui-dialog-shadow` | `--shadow-lg`, shared dialog shadow | `0px 4px 8px -2px rgb(0 0 0 / 10%)` |
| `--codlet-ui-backdrop` | Fixed Electron default dialog overlay color from the wrapper | `#00000022` (observed fixed value, not a host variable) |
| `--codlet-ui-danger-bg` | Subtle danger button: chart-red at 10%, mixed in OKLab with transparency | CanvasText at 10% with transparency |
| `--codlet-ui-danger-hover` | Subtle danger button hover: chart-red at 20%, mixed in OKLab with transparency | CanvasText at 20% with transparency |
| `--codlet-ui-danger-fg` | `--color-chart-red`, subtle danger button foreground | `CanvasText` |

The raw raised-surface alias is not pre-mixed: the GUI composes its 90% dialog background when needed. Secondary button backgrounds and unchecked switches can be derived from the existing foreground alias using the observed 5%/10% mixes. Padding, control geometry and variant widths are GUI-owned constants; no unused spacing, primary-button, or row-height APIs were added. The backdrop alias is also declared directly on `[data-codlet-ui-theme="codex.ui.titlebar.afterMenu@1"]::backdrop`, so a native dialog's backdrop need not depend on inherited custom properties. The adapter does not style the pseudo-element's background itself.

### Interaction Boundary And Verification

Surface, typography, geometry and visual state semantics are candidates for a future adapter-owned styling layer. The 16 aliases above are implemented; a component library or new control RPC is not. The native controls' hashed classes and React functions are not exported or copied into Codlet.

Radix dialog code on line 2796 implements focus scope/looping, modal focus trapping, trigger-focus restoration, outside-pointer dismissal, generated accessibility IDs and cleanup. The wrapper also accounts for host zoom and portal containers. Copying classes cannot reproduce those behaviors. Menubar arrow navigation/mnemonics/private invocation and popover collision positioning similarly need separate behavior contracts. A GUI using the browser's native `dialog.showModal()` owns its interaction and teardown; it does not thereby become the host's Radix dialog.

The extended stylesheet contract is covered by the existing adapter VM test: exactly 27 declared aliases, scope restricted to owned mounts/opt-in portals, a separate opt-in backdrop rule, native references/system fallbacks, no host style writes and cleanup. The 11 adapter tests and all 52 Node tests at the follow-up baseline pass after this change. No follow-up browser, headless process, screenshot or live Codex validation was attempted; the earlier independent 11-alias browser check does not validate these 16 new aliases or the revised GUI layout.

## Lifecycle And Checks

- A mount is moved and reused across menu, toolbar and header reconstruction, preserving consumer nodes and listeners. When no qualifying anchor exists it is detached until a matching anchor returns.
- Reconciliation removes only duplicate artifacts with this provider's exact capability/stylesheet markers. It does not replace unrelated DOM.
- Child-list and relevant structural-attribute changes are coalesced through one pending microtask. Mutations inside owned mount content or its stylesheet are ignored. A stable reconciliation performs no DOM writes.
- Theme changes need no mutation subscriptions for style/class changes. The stylesheet is reattached if its node is removed.
- Deactivation disconnects the observer, cancels readiness listeners, retires queued work through a session identity check, and removes the owned mount and stylesheet. A superseded `getMount` handler reports unavailable.
- `node --test tests/codex_ui_adapter.test.mjs`: 11 passing behavior tests covering selection, malformed menus, fallback upgrade, rebuilding, duplicates, observer stability, cancellation, superseded generations, cleanup and stylesheet scope.
- `node --test tests/*.test.mjs`: 35 passing tests including the existing runtime, GUI and local-plugin example suites at the initial `2ecb27e` baseline. The follow-up result is recorded above.
- An external Playwright check used an independent headless Edge `152.0.4191.66` with synthetic host DOM and this actual adapter file. All 11 aliases resolved consistently for the mount consumer and a portal. Light-to-dark colors and custom font, size and radius changes updated without adapter reactivation. The browser's real MutationObserver preserved the same mount and consumer across removal/recreation; deactivation left zero adapter artifacts, with zero page errors. No running Codex process or profile was accessed by that check.

The external adapter check was completed before the coordinator reported that the in-app browser had denied the GUI fixture URL. It used Playwright `page.setContent` and did not open that fixture, produce screenshots, or use raw CDP. No further browser work followed that report. This existing isolated check does not satisfy the blocked GUI preview/screenshot gate.

## Support And Limits

This is compatibility support based on the exact installed `26.901.6511.0` package and independent synthetic DOM/browser tests. It is not an official extension point or a completed acceptance test inside the live Codex app. No official package, live Codex process, private bridge, or real user configuration was modified, started, injected, attached, restarted, closed, or otherwise exercised for this task.

The adapter does not read a runtime build version; it gates on the inspected structural markers. Changed menu IDs, nesting, layout, private CSS variables, or host reconciliation behavior require another compatibility review. Other versions and native macOS menus are not claimed as verified. The precise legacy-header fallback is a renderer location only.

Codlet's entry is adjacent to the official menus; it is not a registered native Electron menu item or a member of Radix's arrow-key/mnemonic collection. Ordinary focus and the GUI's own interaction handlers apply. No private invocation or execution authority is exposed by this adapter.

Portals must live under the same host theme ancestry and must opt into the documented theme attribute. An iframe or a differently themed subtree does not inherit another element's computed custom properties. Very narrow windows, unusual zoom/font settings, host drag hit-testing and interaction with real React updates still require explicitly authorized live acceptance testing. The adapter does not resize or restyle the official top bar to manufacture space.
