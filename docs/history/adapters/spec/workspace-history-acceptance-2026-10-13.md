# Fixed history and controlled streaming acceptance

This is Adapter-layer tooling for the agreed 20/200/2000-item history and 1/4-thread streaming matrix. It does not select the split plugin's rendering architecture. Native navigation/surface readiness evidence is separate and is not rerun here.

## Executable tools

From `X:/codlet-plugins`, with Node 24 and the existing reviewed Desktop bundle:

```powershell
node tests/fixtures/workspace-acceptance/generate-history.mjs
node tests/fixtures/workspace-acceptance/replay-desktop-history.mjs
node tests/fixtures/workspace-acceptance/replay-desktop-history.mjs --realtime
node --test tests/synthetic_history.test.mjs tests/codex_desktop_adapter.test.mjs
```

Each CLI creates a new directory in ignored `.artifacts/workspace-history/`. The generator optionally accepts a new output directory and refuses to overwrite it. The replay runs production `createAdapter` from `bundled/codex-desktop-adapter/renderer.js` in a Node VM; only the manager and transport are synthetic. It does not instantiate Native components, open a backend connection, register a plugin, mutate DOM or send model turns.

| Fixture | Fixed content / assertions |
| --- | --- |
| History | 20/200/2000 **items**, 5 items per completed turn: user, Markdown answer, fenced code answer, recorded command output, file change. Item count is not message/turn count. |
| Paging | 100-item pages; exactly 20 item requests for the 2000-item case. IDs and ordering survive page boundaries; turns do not implicitly hydrate items. |
| Streaming | 1/4 distinct synthetic threads; **20 deltas per second per thread**, **64 ASCII characters per delta**, **60 seconds**, 1200/4800 deltas. Completed-item hashes verify ordering and accumulated content. |
| Routing | Production event projection and subscription; each simulated consumer updates only its selected thread. The public subscription is global: all callbacks still see every event. Reports count this fan-out explicitly. |
| Lifecycle | No streaming history reads or writes; bounded event cursor overflow is reported; all manager/consumer callbacks retire, transport/API ownership restores, post-retirement notification produces no consumer update. |

`--realtime` waits against a monotonic schedule for two successive 60-second cases. Without it the same schedule replays immediately and is a correctness check only. The report records the schedule and actual elapsed time separately. Dispatch timing retains the latest 1024 samples; total dispatch count and maximum cover every dispatch. Node process CPU includes the synthetic harness and assertions. These timings do not measure Native renderer CPU, layout, paint, input delay, or the split plugin's costs. Reports contain hashes, counts and durations, not message/draft text.

The data generator writes `history-{20,200,2000}.json`, `stream-{1,4}.jsonl` and a SHA-256 manifest using seed `codlet-adapter-history-v1`. The JSONL rows are `{atMs, notification}` with actual app-server notification envelopes. Another test consumer can use the same fixed files; they are **test input**, not instructions to the Native client.

Manifest hashes cover file bytes, including their final newline; replay history hashes cover the JSON value. Compare like-for-like hashes when validating an input file.

## Exact Native protocol and capability gate

Export the schemas from the exact executable used by the owned profile:

```powershell
node tests/fixtures/workspace-acceptance/inspect-history-protocol.mjs 'C:/Program Files/WindowsApps/OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0/app/resources/codex.exe'
```

This runs `--version` and the two schema generators only. It never launches app-server. The output pins the executable bytes and the relevant public/experimental declarations. The inspected 26.1007 binary is `codex-cli 0.162.0-alpha.17.2`.

The exact declarations distinguish three different things:

- Public `thread/inject_items` takes raw Responses API items and appends **model-visible history**. Its empty acknowledgement does not certify UI-visible turn/item history, rendering or incremental notifications.
- Public `ThreadResumeParams` has no `history` or `path` field. Its explanatory comments mention them; the inspection excludes comments when checking declarations. The experimental `history` field is explicitly Cloud-only and is not selected as a Desktop test import path.
- The exported client-request set has no identified request for replaying paced `item/agentMessage/delta` notifications, importing completed `ThreadItem` timelines, or appending fabricated `turn/completed` events. This is a statement about the inspected public schema, not proof that no private test seam could exist.

The [official injection tests](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/suite/v2/thread_inject_items.rs) also distinguish raw context persistence from a later model turn. Upstream `main` is supporting context only; the installed executable's declarations and owned runtime read-back gate are the version-specific evidence.

For the runtime gate, the split chat must first start the already-authorized independent profile and keep startup/shutdown ownership. Do not run this against daily Core/Native state:

```powershell
node tests/fixtures/workspace-acceptance/probe-native-history.mjs '<owned Adapter run directory>' '<new protocol-export directory>' --probe
```

The gate performs the existing `verify-native-run.mjs <run> --synthetic` check immediately before connecting. That verifies roots/creation identities, listener, registry, Target, effective backend data routing/configuration, authentication/readiness and the eight protected synthetic IDs. The new socket also checks `initialize.codexHome`, and every request checks the same coordinator/backend identity. The binary and schema hashes must match the protocol export.

The gate creates **one new disposable thread**, with read-only sandbox and no model turn. It journals the acknowledged thread identity before injection. It then names that new thread, injects two generated marker messages once, and reads `thread/read`, `thread/turns/list`, and `thread/items/list`. It records only item/turn/matching-marker counts and error codes. A positive result requires both markers in canonical history with a turn present. It still does not claim that Native rendered those messages or that file/tool cards or streaming are supported.

Cleanup freshly verifies the same new ID, cwd and rollout path, then unsubscribes and deletes **only that newly acknowledged disposable thread**. Fixture 0/1 drafts and the other protected synthetic threads are never used as mutation targets. No credentials, real messages or authentication files are copied. Unknown creation/injection outcomes are not retried. A lost creation response or failed cleanup leaves a journal marked `failed_or_uncertain` / `cleanup_required`; preserve it and reconcile ownership before a new run. The gate does not bulk-import 2000 raw context items merely because injection acknowledges them.

If marker injection does not populate canonical turns/items, Native long-history restoration remains unverified. The missing capability is a supported import of a **UI-visible completed turn/item timeline** into a disposable thread. Native 20-Hz streaming additionally needs a supported backend/manager notification fixture source with the normal Native update pipeline. Neither a DOM rewrite nor a success from `inject_items` closes those gates. The production Adapter VM replay is the executable alternative, with Native evidence flags explicitly false.

## Generic interface gap discovered by the fixture

The current Desktop `itemDto` preserves `fileChange` as a kind but drops the changes' paths, kinds and diffs. Consequently the replay reports `fileCardMetadataPreserved:false`: independent transcript rendering cannot reconstruct full file cards from this DTO alone. Native component reuse may render from its own manager and is unaffected by that observation.

This is a candidate generic Adapter data-contract improvement for several consumers. Agree the bounded public shape and file/diff size/privacy limits first; do not add split layout, panel selection, caching, composer exclusivity or benchmark policy to Adapter. This tooling commit deliberately leaves that production contract unchanged.

## Execution record

On 2026-10-13, fixture generation, exact protocol export, offline regression tests and the production Adapter replay were executed without starting the closed independent profile. Native capability/foreground/input/attachment acceptance remains with the split chat's execution owner. The records under `.artifacts/workspace-history/` distinguish offline tests from actual Native backend/UI evidence; do not merge them into an overall Native acceptance claim.

- Fixed data: `.artifacts/workspace-history/data-44f24ba7-efb8-476c-9387-3314db1961a4/manifest.json`.
- Exact corrected protocol inspection: `.artifacts/workspace-history/protocol-f8ce913c-b2ca-4b7d-9132-b73667772937/report.json`. The first inspection `protocol-8703fb26-e972-4d8d-bfaf-16ac8ebd8626` incorrectly counted a comment mentioning `history:` as a declaration; it is superseded, preserved as-is and excluded from capability evidence. A regression covers that case.
- Real-time VM replay: `.artifacts/workspace-history/replay-d61abfb0-0497-4290-ac47-0a16a3fe0940/report.json`. Both cases received all 1200/4800 deltas; actual elapsed times were 60.009/60.015 seconds, backend requests were zero, and callback/cleanup counts were zero after retirement. Dispatch quantiles and process CPU remain scoped to this Node harness; they are not Native performance limits or a cross-case scaling conclusion.
- 8 new fixture/probe regressions and 37 existing Desktop Adapter regressions passed (45 total). The runtime Native gate has not been executed by the Adapter chat; only its synthetic request/identity/lifecycle tests passed.

## Native backend gate executed by the split chat

The split chat subsequently executed the prepared public probe in coordinator `1791857416908-16000`. Source reports are under `.artifacts/adapter-native/adapter-44f7b16a-5596-4bf0-b079-f70095b71696/history-probe-66c50233-dc70-4376-af5f-31dad76db160/`:

- `report.json` records `nativeBackendTested:true`, two acknowledged injected model-context items, and successful `thread/read`, `thread/turns/list`, and `thread/items/list` calls that all return **0 turns / 0 items / 0 matching markers**.
- `ledger.json` records one `thread/start`, one `thread/inject_items`, one `thread/delete`, no model turn, and state `closed`; fresh identity cleanup deleted only the new disposable thread `01a1332f-34ff-7c40-b94d-454edf22f2f6`.
- The exact CLI hash remains `d13914ced6c7af174d8d638db938284231227312104b06a25e9608c632a7daec`.

This is actual Native backend negative evidence for using `inject_items` to seed canonical UI-visible history on this version. It closes the probe's read-back uncertainty and leaves the Native 20/200/2000 completed-timeline and paced streaming gates unmet. It does not certify Native frontend history/streaming performance. The Adapter chat read and archived this result without operating the profile.

The derived archive is `.artifacts/workspace-history/native-backend-negative-66c50233-dc70-4376-af5f-31dad76db160.json`. It pins `report.json` SHA-256 `cc9559737378b3186c8201fc6385b3dbed2a666991f2b702c0ef37f8519a2a47` and `ledger.json` SHA-256 `a8cb2ec78dc347223e3038173442a79c81492e156d023c52dc44faa067af9704`; both original files remain intact.
