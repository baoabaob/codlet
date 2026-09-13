# Official components and native sidebar page migration

This replaces the earlier managed-DOM / floating-window implementation. The manager now uses Apps SDK UI 0.2.2 directly and occupies the native content page. A Cube icon identifies Codlet in the main sidebar; title, version and compatibility popover share the page header. Plugin names lead each row, versions sit beside them and descriptions appear below.

## Audited installed client

Read-only extraction of `OpenAI.Codex_26.908.4834.0_x64__2p2nqsd0c76g0/app/resources/app.asar`, application `26.908.40834` / `8881`. No extracted native module was executed during this audit. References below are TypeScript-printer formatted line numbers in `.codlet-artifacts/official-ui-audit-2026-09-13` of the original repository.

| Source | Evidence |
| --- | --- |
| `app-primary-17b54400f32a`, 31012–31087, 31134 | `$R` uses native `isActive`, background and emphasis tokens; hover is independent. `aria-current=page`; focus uses an inset ring. Export `ov`. |
| Same file, 38344–38357 | Scheduled invokes `She` and selects by the pathname prefix from `nc()`; it is a destination, not a popup. |
| Same file, 39822–39863 | The destination renderer passes selection, icon and label to `$R`. Context menus and interactive trailing controls are separate. |
| Same file, 80956–81085 | `AuthedRoute` owns the main app shell; `Ozn` supplies sidebar and content outlets. |
| `app-initial-d9bed9d614d8`, 79307–79319 | MemoryRouter owns one history listener and React state; installing another listener would replace the native subscription. |
| Same file, 79358–79376 | Routes rebuilds descriptors through `Gen(children)` on render. This permits the reviewed appended descriptor to participate in ordinary navigation. |
| Same file, 207492, 207611–207624 | Authenticated route collection contains Scheduled and the `/inbox` redirect. The adapter appends only its own stable-ID descriptor here. |
| Same file, 183633–183664 | The app shell supplies the main surface and focus area. Codlet never overlays or marks those native descendants inert. |
| Same file, 180708–180716 | Retired top-menu selection used an explicit `outline-none`; its difference from the former generic focus ring is not a reason to restyle the new sidebar. |

Additional read-only extraction in the worktree's `.codlet-artifacts/sidebar-audit`: `app-main-328bbc8378ff` imports native React and `client-d8dffccad60c.t().createRoot`; `react-dom-2c70d35283e7.t()` supplies synchronous unmount. The native sidebar is rendered with this exact native React pair, while the isolated manager uses the shared bundled official runtime.

## Preserved behavior

- Search includes ID, name and localized descriptions, keeps IME drafts, and clears before processing another Escape action.
- No row tooltip, normal-running label or persistent successful-operation banner. Actionable failures remain visible.
- Local paths preview automatically; native folder choice is followed by manifest validation. Each import/update/rollback starts with fresh trust, grants and broker policy.
- Details show actual grants, hide the source path and open folders by plugin ID. Optional deletion is unchecked by default and submits only verified registration/source identities. Missing sources remain unregisterable.
- Community discovery is a visible link only on Import. Compatibility sits beside the version. Updates retain explicit check/download/install steps and no fabricated release source.
- Prepare and completion receipts must match plugin/action identity. Submit occurs once; lost responses query that receipt. Closing before submit invalidates it. Late lists, previews, histories, selection results and generations are ignored. Lost update command responses require status reconciliation before another command.

## Verification

Use the current tests and recorded evidence from this migration. Prior managed-DOM test counts do not validate API 2. `codlet_controller.test.mjs` covers transactional and stale-response boundaries, the GUI/jsdom tests exercise the actual bundled React components, and `codex_ui_adapter.test.mjs` exercises native-style route lifecycle with an independent host React root. Chromium preview and the named isolated client provide layout and installed-profile verification. Results are recorded in the final validation note after those runs finish.
