# UI API 2 migration validation

Implementation and automated/browser verification are complete. **Installed-client UI verification is still pending approval to migrate two test registrations.** Do not describe the new native sidebar profile as verified in the real client yet.

## Worktree

- Branch: `codex/sidebar-official-ui`
- Base: `7de6585a32ed2bf19ed51039fe39598e31bc06ff`
- Applied handoff patch SHA256: `ae47669b37267c1bc16bb26430da5f1469688900e35ef56a4d7cf355db8c3944`
- Worktree: `C:/Users/cccake/.codex/worktrees/4f90/codex轻量扩展插件`
- No remote publication. The original repository's source files were not edited.

## Completed checks

| Check | Result |
| --- | --- |
| `frontend/build.mjs` | All bundles built together from the lockfile; upstream notices generated and embedded in the runtime. |
| `node --test tests/*.test.mjs` | 141 passed, 0 failed. |
| `cargo test --all-targets --no-fail-fast` plus `cargo test --lib -- --test-threads=1` | 539 distinct tests passed; 1 ignored. In the final parallel run, the existing blocked-pipe worker-count assertion failed and poisoned its sibling test's lock. All 306 library tests passed serially; all 233 non-library tests passed in the full run. No pipe implementation was changed. |
| TypeScript 5.9.3, `frontend/tsconfig.check.json` | Passed, including upstream Button/Switch/Checkbox contracts and rejection of removed helpers. |
| Packaging script syntax and `git diff --check` | Passed. |
| Chromium preview | Light/dark, Chinese/English, native-page simulation, automatic local preview, fresh permissions/trust, popover Escape, GitHub release/ZIP selection (including ArrowDown/Enter), 45-row scrolling and 600/400 px viewports passed. No horizontal document overflow. |

Evidence is in this worktree's ignored `.codlet-artifacts/sidebar-audit/`: `rust-final.log`, `rust-lib-serial.log`, `doctor-model-tests.log`, `preview-light.png`, `preview-dark.png`, `preview-import.png`. The final Node run is `C:/Users/cccake/.fastctx/jobs/j-3cx6ip/output.log`. The preview simulates host and RPC data, and does not install files or contact GitHub.

## Remaining installed-client check

The explicitly named isolated client was stopped through its own `Stop-TestClient.ps1`. The exact old binary, lab config and plugin registry were backed up. The new binary was copied and only its configured hash changed. Startup correctly failed preflight because these existing test registrations point to the original repository's API 1 consumers:

| Test plugin | Current source | Prepared source in this task | Existing grants |
| --- | --- | --- | --- |
| `example.desktop.m3m4` | Original repository `examples/desktop-m3-m4` | Worktree `examples/desktop-m3-m4` | `ui.dom`, `ui.mainWorld` |
| `example.ui.controls` | Original repository `examples/ui-controls` | Worktree `examples/ui-controls` | `ui.dom` |

Both are enabled. Their prepared manifests use `codex.ui.navigation.page@1`. The handoff explicitly prohibited overwriting the original working directory or existing registry/grants, so the user was asked to authorize only these two registration migrations, preserving their existing permissions. No answer had arrived when this note was written. Do not migrate them until that permission is supplied; use normal validated import/registration operations, never delete their source folders.

The test client was restored while awaiting that choice:

- Original binary SHA256: `DB0A99ADF900FBB2E1CABB5C93015443A83B9BAFFBD173AACDA50CD50A278C54`.
- Registry remains byte-identical: `70D5534A39D93884B84A24E79C6226FB0A8275AE2FAD7EAAE6EF2592EBD5072F`.
- Original launcher confirmed ready run `1789312335364-32828`; manager PID `32828`, Desktop PID `60988`. Re-read the state before any further action.
- Restored running Doctor passed (`restored-running-doctor.json`). Daily-client identities remained unchanged. Authentication files were not inspected or edited.

After approval: rebuild the latest `codlet-lab.exe` (the final source includes later accessibility/receipt fixes), stop this same owned test client, migrate the two registrations, deploy the new binary/hash, start with the existing launcher, then verify the actual sidebar `$R` rendering, full-page mount, navigation away/back, focus, reload/unload, folder picker and Doctor. Preserve all other registrations and grants. Do not use the old managed-DOM screenshots or tests as evidence for the new real-client UI.
