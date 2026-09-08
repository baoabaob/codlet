# Native UI Adapter Capabilities

Status: proposal, 2026-09-07. This is the follow-on design requested after the
first GUI revision exposed the limits of matching only menu placement and colors.
Except where explicitly marked current, the APIs below are not implemented.

## Objective

A codlet should be able to present controls and settings that belong in Codex
without inspecting private host DOM, importing host React modules, or reconstructing
the same styles in each plugin. The first-party management GUI is the initial
consumer and acceptance case. Its visual agreement with the client must be
established before its controls become a reusable public interface.

The installed application's compiled frontend is sufficient reference material.
The adapter evidence document records the build, archive hash, source locations,
theme variables, and observed structures. Research copies stay outside the
repository. Implement small owned components from the observed behavior and
dimensions; do not distribute the proprietary application bundle or its assets.

## Responsibilities

| Layer | Owns | Does not own |
| --- | --- | --- |
| Core | Capability declarations, grants, target/generation identity, lifecycle and RPC routing | Codex selectors, theme tokens, React or component geometry |
| Codex UI adapter | Verified host locations, native theme mapping, semantic style recipes and availability | Plugin business data or registry decisions |
| Generic renderer UI helpers | Owned DOM controls, keyboard/focus behavior, cleanup and local event handling | Host private modules, hashed classes or undocumented bridges |
| Consumer plugin | Content, domain state and commands | Private host selectors or duplicated native styling |

Renderer worlds share the DOM, but functions and DOM object references are not
serialized through the current RPC bridge. Keep per-keystroke interactions local
to the consumer. Use RPC for capability negotiation and substantive commands,
not every hover, focus or switch animation.

## Capability Shape

| Area | Current | Proposed next contract |
| --- | --- | --- |
| Slots | `codex.ui.titlebar.afterMenu@1` returns a stable mount token, availability and placement | Named target-scoped slots with explicit availability and reversible ownership |
| Appearance | Adapter-owned stylesheet supplies `--codlet-ui-*` aliases to its mount and opted-in portal | Versioned semantic roles and variants, including geometry, typography, state colors and surface layout |
| Controls | Management GUI constructs its own buttons, switch, rows and confirmation UI | Small renderer helpers consuming the appearance contract; ordinary DOM events and explicit dispose |
| Surfaces | GUI owns its management panel | A settings surface/dialog contract only after actual host settings behavior is verified |
| Diagnostics | Mount RPC reports current availability and placement | Report supported roles, missing structure/tokens and matched build evidence independently of Host readiness |

`codex.ui.appearance@1` is a proposed capability name. Before freezing it, use the
first-party GUI and one small local UI plugin to prove the required roles and
failure behavior. Do not add a separate raw-CSS or arbitrary-selector RPC escape
route to this interface.

An appearance response should describe the supported contract version, theme
marker and finite role/variant set. A consumer applies its own data attributes to
owned elements; adapter CSS interprets those attributes. Private class names and
native token spellings remain in the adapter implementation. This fits the existing
stable-marker contract without passing React elements or closures across worlds.

## Initial Roles

Start with controls already needed by management. Record each role's actual source
component and all states before extracting it.

| Role | Evidence and behavior required |
| --- | --- |
| Menu entry | Actual trigger spacing, type size, row height, hover/open/focus appearance and drag exclusion |
| Button and icon button | Variants, icon dimensions, hit area, border, disabled/loading states and focus ring |
| Switch | Track/thumb geometry, on/off/disabled/focus states, accessible name and keyboard activation |
| Settings section and row | Label/description typography, alignment, separators, padding and narrow-window behavior |
| Settings surface | Native navigation/content proportions, maximum width, scroll ownership, heading hierarchy and close behavior |
| Confirmation | Native action order, button variants, layout, focus entry/return, Escape and pending/error behavior |

A color alias alone does not satisfy a role. Spacing, geometry, density and state
behavior are part of the contract. Conversely, copying a Radix-generated class or
`data-state` does not reproduce focus management, dismissal or accessibility.
Those behaviors need owned controls or a suitable existing library; they must not
depend on undocumented registration in the host's React/Radix tree.

The current correction uses the public wide-dialog variant (600px) for one settings
section and the compact variant (420px) for confirmation. The native settings-row
composition uses 16px horizontal / 12px vertical padding, a 24px control gap,
13px labels, and 12px descriptions with 16px line height. Do not apply the separate
64px settings-row token to every row: the observed plugin row does not use it.
The default switch is 32x20px with a 16px thumb. The dialog radius resolves through
the host corner scale, with a 20px base. Variant-specific evidence belongs in the
adapter document; these are not global hardcoded dimensions for every control.

The GUI uses the browser's `dialog` primitive for the modal boundary, with owned
close/confirmation handlers and lifecycle cleanup. Modal state must follow
`dialog.open`; background inertness, tab scope and focus return need real browser
verification in addition to tests of the plugin's handlers.

The current appearance increment adds 16 aliases used by that GUI, for 27 total.
It remains a scoped stylesheet contract; it does not yet expose component factories
or a general settings-surface API. Keep this distinction when documenting support
for third-party codlets.

The [2026-09-08 follow-up](APPEARANCE_FOLLOWUP_2026-09-08.md) extends that baseline to
35 aliases for menu states, font weights, control cursor and reduced-motion
preferences. These references resolve from the current host settings. The GUI's
menu trigger grows with its effective font size instead of fixing its height to
the 14px baseline. No new capability, global theme writer or control factory is added.

## Ownership And Compatibility

- Scope recipes to adapter-owned mounts and explicitly opted-in plugin surfaces.
  Never apply broad resets to the host document.
- Match live theme and typography settings through native CSS variables. Keep
  geometry tokens semantic so a host update is contained in the adapter.
- Keep the current menu entry adjacent to the official menubar. It is not part of
  the host's arrow-key or mnemonic collection; do not advertise those bindings.
- Capability versions describe the plugin-facing contract. Build evidence describes
  the private host implementation. Update one without silently changing the other.
- An unavailable slot must be observable and recover when its exact anchor returns.
  Reuse owned DOM where practical, clean it on unload, and retire queued work by
  generation. Do not silently choose unrelated host containers.
- Unknown style roles fail explicitly. A verified system-color fallback can preserve
  basic usability, but it is not a claim of native visual compatibility.
- `runtime.manage` remains a separate grant. Rendering a switch or confirmation
  must not confer authority to change plugin state.
- Host status and plugin activation do not prove that a surface mounted or looks
  correct. Keep renderer availability and visual acceptance separate.

## Delivery Sequence

1. Correct the current GUI against the installed settings components. Record a
   component-to-owned-implementation comparison, including measurements and
   interaction differences. Preserve existing lifecycle and RPC regressions.
2. Extract the proven appearance roles and local control helpers. Exercise them in
   the management GUI and a small trusted local UI example, then freeze the first
   versioned contract. Avoid a framework migration or complete design-system clone.
3. Add a settings surface/slot API only after its navigation, scrolling, focus,
   teardown and missing-host behavior are established. A separate window remains
   an optional host capability, not a requirement to introduce another GUI runtime.
4. Add build compatibility reporting and fixtures for changed host structures.
   A future style mapping update must run the same consumer tests.

## Acceptance

Compare with the installed client at the same theme, font, zoom and window size.
Verify desktop and narrow layouts, longer labels, disabled/loading/error states,
keyboard-only operation, focus return, theme changes, toolbar rebuild and unload.
Screenshots and manual comparison are required for visual acceptance; VM behavior
tests do not establish visual agreement.

The current in-app browser policy rejected the local GUI preview URL. That check
remains incomplete and must not be bypassed or replaced with a claimed pass. The
static preview is still deliverable for direct user inspection. Testing the live
client belongs to the existing explicit real-Codex gate.

Related: [adapter evidence](CODEX_UI_ADAPTER_EVIDENCE.md),
[product plan](PRODUCT_TECHNICAL_PLAN.md), and
[execution record](REVIEW_AND_EXECUTION_2026-09-07.md).
