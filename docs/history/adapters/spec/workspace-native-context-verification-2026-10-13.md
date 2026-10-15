# Native context verification: current boundaries

Source candidate `d938e1d949880f541a64d3e9aba1610ec9122b43`, six-file Adapter snapshot `candidate-d12d17b8-3cce-4454-8a9f-bc1db6781b34`. The split consumer owns and operates the Native instance. Adapter-side work reads the saved receipts and performs source/offline verification; it does not drive the active client.

## Verified ordinary-thread path

Consumer sample `consumer-75f4200e-b5b5-45e2-941e-96d1f591e07e`, source SHA256 `1374486504b8596eed3db77289a4679be1ff1e75c97c5255806b8fb55a277967`.

The complete saved receipts were read on the Adapter side:

| Receipt | Active bodies | Consumer errors | Input errors | Native selection | Result |
| --- | --- | --- | --- | --- | --- |
| `1791893234640-9c935178-f45b-414b-946c-dfa18cb1d4fa` | 8 | empty | empty | fixture 0; consumer unselected | entry ready |
| `1791893258178-959674bb-9045-496e-a9f9-c251897e0e5c` | 8 | empty | empty | fixture 1 | input confirmed/focused |
| `1791893281943-8e520803-a8d6-4874-a5ed-8c87f7a9de7e` | 0 | empty | empty | fixture 0 | default exit restored |

All three report `additionalEditors:0`. The first two report preserved body nodes. The current `bodyViewport` shares the full Native scroller interval, top 96/bottom 1095; the consumer independently clips its body before the footer at top 981. Independent sidebar configuration was off/null in this path. These are ordinary-route/context checks, not a new unsent draft or right-viewport acceptance result.

Saved receipt directory: `X:/codlet-split-workbench/.checks/native-comparison/consumer-75f4200e-b5b5-45e2-941e-96d1f591e07e/driver/`.

## Verified Native home and pinned summary on a50

The consumer's `consumer-c0a987a9-61d3-4ce2-ae5c-9bb05036c8da` used the complete `a50d29b` six-file snapshot. Adapter-side reads confirm:

- Initial home entry (`1791897902993-093f223f-f03f-44b5-93df-5f78b524def1`): eight bodies, no additional editors, null selected/native identity, and empty consumer/input/integration errors. Native content/body viewport is top96/bottom1095; its real home composer/footer is top935/height144, with a null thread scroller.
- Default exit (`1791897925412-a25b02cc-3fc5-4457-ae82-3646f69c851c`): zero bodies, null selected/native identity and empty errors, returning to Native home.
- The later physical owned-marker check is documented in the consumer's `location-new-draft-ui.md`: an explicitly owned 28-character unsent marker survived public entry, selecting a different existing thread and default return to home. Fresh pixels and exact owned-marker comparison confirmed it. Only the still-owned marker was removed afterwards, restoring the empty baseline. No submission, permission change, existing thread draft edit or original user text copying occurred. This does not prove attachment/nonempty-user-draft cases or physical entry/exit-button acceptance.
- The consumer's `summary-fixed-ui.md` and independently inspected `summary-after-settled.jpg` confirm actual summary visibility and restoration in selected fixture5/raw-grid. Settled public bounds reserve x1462/width308 for the visible summary, leaving bodyViewport x341/right1462/width1121. Composer x533.5/width736 centers at901.5, equal to the usable body center. Native footer translation is -154. Transient animation frames were not treated as persistent misalignment.

The same sample's first independent-sidebar enable failed with `workspace_host_pending: A unique Native viewport layout is required`. That failure remains preserved; the sample is not an overall clean pass. The discovery boundary correction is documented separately and delivered in `09d016f` for a new consumer-owned Native check.

## Remaining Native checks

Independent right-pane open/resize/content/settings release, visible disabled heading actions in a real thread scene and independent permissions remain pending. No complete release acceptance, numeric performance result or durable atom-store flush is inferred from the recorded paths. User-confirmed manual window dragging is accepted; unsuccessful Computer Use window movement is not treated as a product failure.

The earlier `ce737`/57098b2 sample remains failed for eight `Missing parent scope` body errors despite a successful ordinary route return. It is not upgraded by the corrected candidate's success. The nearest-provider ordering correction and the additional repeated-Context tests are documented separately.
