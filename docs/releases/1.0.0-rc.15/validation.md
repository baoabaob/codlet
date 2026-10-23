# Core rc.15 validation

Core `2970d1b5fa8bd47356d0cf8db0cbe04998be5d7d` and Split Workbench rc.5 passed the
targeted Windows Native `26.1016.8622.0` interaction run on 2026-10-23. The
[machine-readable receipt](desktop-receipts.json) records source identities,
artifact hashes, baseline failures and candidate results.

Core now hides the original transcript's navigation rail and its open preview
with the body, including portals mounted beside the scroller. Mounted transcripts
contain fixed-position descendants and reset inherited window drag declarations.
The workspace action uses its own neutral color. The offline and public
compatibility catalogs include the verified rc.14 / Native `26.1016.8622.0` pair.

Split rc.5 retains pane DOM order while changing visual geometry, keeps Native's
original permission picker, and resizes pane geometry for zoom without scaling
the Native virtual list. It is a separate consumer package.

## Interaction evidence

The disposable VM used three synthetic conversations, with twelve turns in the
first conversation and one pasted synthetic PNG. Reorders used DOM PointerEvents.

| Check | Core rc.14 + Split rc.4 | Core rc.15 + Split rc.5 |
| --- | --- | --- |
| Scroll at 100% / 105% / 80% | stable / rebound / rebound | stable at all three settings |
| Pane DOM removals over eight reorders | 8 | 0 |
| Native body, input, draft and image node retention | retained in this fixture | retained in every reorder |
| Original Native permission picker | hidden | visible; menu opened and closed; same control retained |
| Original rail and open preview in an empty workspace | outside the narrow baseline's coverage | both hidden |
| Normal exit / plugin errors / remaining owned processes | yes / 0 / 0 | yes / 0 / 0 |

The candidate's renderer viewport was 1804 × 1153 using
`Emulation.setDeviceMetricsOverride`; its physical window remained 1088 × 602.
Three blank topbar points returned `HTCAPTION` in all sampled phases, including
the empty workspace, zoom and reorder phases. The reported daily-window drag
failure was not reproduced in the old narrow fixture, and physical mouse window
dragging remains outside this run.

The old blank-body and attachment-loss symptoms were not independently reproduced.
The baseline did reproduce subtree removal and zoom-dependent scroll rebound;
the candidate checks establish retention and stable scrolling in the exercised
scenario. An earlier attempt timed out while seeding, before the workspace checks;
an intermediate viewport attempt used an unsupported Browser-window query. Those
failed reports remain alongside the final successful run.

## Automated and package checks

- 445 embedded adapter regressions passed, with two optional skips. After the
  final navigation-rail change, all 58 workspace regressions passed.
- 15 compatibility catalog Rust tests passed, including offline recognition and
  minimum-version enforcement for Native `26.1016.8622.0`.
- Desktop acceptance harness and compatibility coverage catalog checks passed.
- Split Workbench rc.5: 147 consumer regressions and the production build passed.
- The final setup EXE passed its self-test, including embedded payload hashing.
  No installation was performed by that check.
- The rc.14 resident fingerprint is eligible for the generated online package;
  this run did not perform a live Core update with an active draft.

The installer and runtime packages use the source commit above. Later documentation
commits do not change those binaries. The existing rc.14 installer and startup
evidence remains in its [own record](../1.0.0-rc.14/validation.md). This release has
no new physical IME, performance, long-soak or macOS acceptance. Windows packages
remain unsigned.
