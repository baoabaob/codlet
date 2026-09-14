# UI API 2 migration validation

Updated 2026-09-14. The parent acceptance task has verified the native sidebar, full Codlet page, back/forward navigation, host accent color, keyboard focus, real folder picker, both example panels and the UI controls disable/enable/reload lifecycle in the isolated Desktop client. Final search appearance acceptance remains coordinated by that task. Startup readiness and Doctor alone are not GUI compatibility evidence.

## Worktree

- Branch: `codex/sidebar-official-ui`
- Base: `7de6585a32ed2bf19ed51039fe39598e31bc06ff`
- Applied handoff patch SHA256: `ae47669b37267c1bc16bb26430da5f1469688900e35ef56a4d7cf355db8c3944`
- Worktree: `C:/Users/cccake/.codex/worktrees/4f90/codex轻量扩展插件`
- No remote publication. The original repository's source files were not edited.

## Initial migration checks

| Check | Result |
| --- | --- |
| `frontend/build.mjs` | All bundles built together from the lockfile; upstream notices generated and embedded in the runtime. |
| `node --test tests/*.test.mjs` | 141 passed, 0 failed. |
| `cargo test --all-targets --no-fail-fast` plus `cargo test --lib -- --test-threads=1` | 539 distinct tests passed; 1 ignored. In the final parallel run, the existing blocked-pipe worker-count assertion failed and poisoned its sibling test's lock. All 306 library tests passed serially; all 233 non-library tests passed in the full run. No pipe implementation was changed. |
| TypeScript 5.9.3, `frontend/tsconfig.check.json` | Passed, including upstream Button/Switch/Checkbox contracts and rejection of removed helpers. |
| Packaging script syntax and `git diff --check` | Passed. |
| Chromium preview | Light/dark, Chinese/English, native-page simulation, automatic local preview, fresh permissions/trust, popover Escape, GitHub release/ZIP selection (including ArrowDown/Enter), 45-row scrolling and 600/400 px viewports passed. No horizontal document overflow. |

Evidence is in this worktree's ignored `.codlet-artifacts/sidebar-audit/`: `rust-final.log`, `rust-lib-serial.log`, `doctor-model-tests.log`, `preview-light.png`, `preview-dark.png`, `preview-import.png`. The final Node run is `C:/Users/cccake/.fastctx/jobs/j-3cx6ip/output.log`. The preview simulates host and RPC data, and does not install files or contact GitHub.

## Initial registration conflict (resolved 2026-09-14)

The explicitly named isolated client was stopped through its own `Stop-TestClient.ps1`. The exact old binary, lab config and plugin registry were backed up. The new binary was copied and only its configured hash changed. Startup correctly failed preflight because these existing test registrations point to the original repository's API 1 consumers:

| Test plugin | Current source | Prepared source in this task | Existing grants |
| --- | --- | --- | --- |
| `example.desktop.m3m4` | Original repository `examples/desktop-m3-m4` | Worktree `examples/desktop-m3-m4` | `ui.dom`, `ui.mainWorld` |
| `example.ui.controls` | Original repository `examples/ui-controls` | Worktree `examples/ui-controls` | `ui.dom` |

Both are enabled. Their prepared manifests use `codex.ui.navigation.page@1`. On 2026-09-14 the parent explicitly authorized these two registration migrations, preserving grants and enablement. Public `Test-Plugins.ps1 remove`, `preview`, and `add --trust --grant … --enable` operations completed them. No source directory was deleted. This authorization supersedes the earlier pending-approval note.

The test client was restored while awaiting that choice:

- Original binary SHA256: `DB0A99ADF900FBB2E1CABB5C93015443A83B9BAFFBD173AACDA50CD50A278C54`.
- Registry remains byte-identical: `70D5534A39D93884B84A24E79C6226FB0A8275AE2FAD7EAAE6EF2592EBD5072F`.
- Original launcher confirmed ready run `1789312335364-32828`; manager PID `32828`, Desktop PID `60988`. Re-read the state before any further action.
- Restored running Doctor passed (`restored-running-doctor.json`). Daily-client identities remained unchanged. Authentication files were not inspected or edited.

## Acceptance fixes and current checks

- Mutation results and list-read failures are separate. Stale list values remain visibly marked and disabled until a successful refresh; the submitted receipt is never repeated.
- Page and whole-owner teardown complete all cleanup steps despite callback or React cleanup errors, then report the collected failures. Repeated disposal is safe.
- The import entry is an official icon with tooltip and accessible name. The source selector uses its content width; details group name/version/folder, ID and description. Version popover typography is scoped to its owned portal. Confirmation cancellation restores the trigger, with a page fallback when it disappeared.
- Search has one clear action, retains IME/Escape behavior, and uses the official outline Input with only its background supplied by the host's `--color-page-search`. Official borders, hover, focus and geometry are unchanged; path/URL fields remain ordinary outline inputs. Version discovery and confirmation regions have concise translated labels.
- Windows extended drive and UNC prefixes are hidden only in displayed folder paths. Manager state, RPC preview paths and receipt identities retain the original values; editing an ordinary path still triggers automatic preview.
- Host semantic tokens supply owned SDK text/surface/border/focus and Switch accent/thumb colors. No fixed accent color or replacement control CSS is used.
- The install-helper fixture samples its clock once; the production 30-minute maximum remains unchanged. Expired, future and overlong plans are still rejected before readiness or installation.
- The reviewed `/avatar-overlay` auxiliary window declines page registration normally, leaving no pending page DOM or navigation observer. Other build/router drift remains an error.
- Core accepts the optional failure `code` already emitted by the bootstrap and preserves it as provider diagnostic text. Unknown fields and invalid types remain rejected; provider codes do not impersonate Core authorization errors.

| Check | Result |
| --- | --- |
| Final complete Node run | 157 passed, 0 failed (`node-final.log`), including auxiliary-window and Windows path regressions. |
| Follow-up regressions | All 6 native-adapter tests passed, including the new auxiliary-window case. Bootstrap and UI ownership/cleanup suites passed; final search/theme and Windows path checks passed. Total distinct Node tests: 157. |
| Complete Rust run | 539 passed, 0 failed, 1 ignored; all targets with serial test execution (`rust-full-serial.log`). |
| Provider-envelope follow-up | All 15 renderer unit tests (including the new error-envelope case) and 5 renderer/Host integration tests passed. Total distinct Rust tests: 540, with 1 ignored. |
| TypeScript 5.9.3 | Passed, including the nullable auxiliary page path. |
| Final outline-search follow-up | Search interaction and host semantic token tests passed (`search-outline.log`); only the host background is added to the official outline control. |
| Parent preview acceptance | Original failure reproductions fixed; narrow/light/dark layouts, 45-row scrolling, import, update controls, cancellation focus and version popover typography independently verified. |

Current evidence is in `.codlet-artifacts/parent-acceptance-2026-09-14/`. The parent owns screenshots and `ACCEPTANCE.md`. Preview evidence uses simulated RPC and is separate from actual Desktop evidence.

## Authorized isolated deployment

Before changes, the closed state and exact binary, launcher config and registry were hash-verified into `deployment-backup/`. `migration-verification.json` confirms that only the two authorized source paths changed in the complete registry: grants, enablement, and all other registrations are unchanged. Both original source directories remain present. Only the binary hash changed in `lab-config.json`.

The original `Start-TestClient.cmd` confirmed ready run `1789356467189-34856`: manager `34856`, Host `6124`, backend `34660`, Desktop `16504`. Binary SHA256: `D71F27A94E9A7A066B8E04F2C0BF84D594AC5BCFD0BA0CC9C8763715698896E7`. `ready-state.json` and `ready-processes.json` preserve creation identities; check fresh state before acting on any PID. Daily Desktop/backend identities `8496`, `48548`, and `66516` were unchanged at startup.

After the parent completed the first real-client round and restored the original System theme, the same client was stopped through `Stop-TestClient.ps1` and its owned processes were verified gone. The final auxiliary-window, provider-envelope, search-theme and path-display fixes were deployed through the original launcher.

The auxiliary-window/path-fix run `1789357625911-17296` used manager `17296`, Host `49156`, backend `21764`, Desktop `61076`. Binary SHA256: `C8B31E3F3126AECD13A18C6E01531942D8D60987FD5CF7B522EC9094FADE38BE`. Evidence: `final-ready-state.json`, `final-ready-processes.json`, and `doctor-final.json`. Doctor passed with no failed checks; both targets reported only adapter-ready informational events, and earlier auxiliary-window activation/invalid-envelope errors were absent.

The parent then verified both example pages and UI controls disable → enable → reload: the entry disappeared on disable, returned exactly once on enable, remained unique after reload, and the example counter reset from 1 to 0. The plugin was restored to enabled; grants and sources were unchanged. Its independent post-lifecycle Doctor also passed. A light-theme comparison required retaining the official search outline around the host search background; that final appearance adjustment was deployed after the parent released the client.

**Final ready run:** `1789358434356-38904`; manager `38904` (2026-09-14T04:00:33.1908328Z), Host `19396`, backend `58312`, Desktop `11432` (FILETIME `134338320412959747`). Binary SHA256: `7BCDA215F8E7EE5017A2E6BAA07192128A70FDC0FE677E510FB0CC4111D378A7`. Evidence: `search-ready-state.json`, `search-ready-processes.json`, and `doctor-search-final.json`. Doctor passed with no failed checks or renderer error diagnostics. `pre-final-registry-verification.json` and `migration-verification.json` confirm original grants, UI controls enabled=true, and all other registrations both before and after this restart. Daily identities remained unchanged. The parent owns the last search appearance check; this task has not operated the mouse or browser.
