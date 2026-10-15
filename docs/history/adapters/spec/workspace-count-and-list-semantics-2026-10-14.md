# Unlimited transcript/count contract and read-only list semantics

This change removes Adapter transcript and cached-summary total-count gates. It does not modify Core, the split consumer, the permission implementation or the open Native preview. The historical untracked probe files are preserved.

## Removed count gates and verification

`WorkspaceSession.mountTranscript` now registers an unbounded owned transcript set (`own('transcript',null,...)`), and the transcript provider no longer refuses a mount at 32 records. There is no replacement magic number, silent truncation or eviction. Connected-empty-container, owner/generation, identity, Native provider, cancellation and disposal checks remain. History work still starts at most two jobs concurrently; queued views are eventually handled rather than discarded by count. The Shadow DOM/style isolation path has no transcript count gate. Other resource classes' existing limits do not bound the number of transcripts in an accepted session.

`threads.loaded` no longer rejects initialization above 4096 cached conversations or a subsequent summary addition at that size. It still validates the Native collection and each identity, serves 1..100 entries per page, and uses single-use snapshot cursors with a 15-second lifetime and at most 32 simultaneous pagination snapshots. These are page/lifecycle controls, not a total-entry limit. The Native manager determines which conversations are currently cached; the full persistent catalog is a separate query.

Regression coverage in `tests/workspace.test.mjs` renders 48 transcripts for one owner and 40 for another (88 in one Target), checks each requested body, preserves existing roots/body/scroll on flag changes, rejects an occupied container, reuses a released container, and retires one owner while the other stays live. Another test retires 40 pending cold mounts and confirms only the two already dispatched reads finish, with no late roots or further hydration. Summary coverage pages all 4205 initial entries, adds and updates beyond the former boundary, pages the new collection completely, and retains page/cursor validation.

The workspace suite passed 52/52; the related UI/Desktop/navigation/history/permissions suite passed 248/248 with zero failures or skips. Frontend build and diff whitespace checks passed. These are synthetic/source checks; no Native preview operation or new Native acceptance was performed.

## Current running summary is not the Native spinner contract

Current implementation: `frontend/src/desktop/loaded-threads.js`, `loadedThreadSummary` (lines 4–17). Any unfinished `requests`/`externalRequests`, `waitingOnApproval` or `waitingOnUserInput` flag gives `attention` first. Otherwise a present `threadRuntimeStatus.type` gives `running` only when it is `active`; if no runtime type exists, only the last `turns` entry being `inProgress` gives running. A non-running resumed thread is idle; other resume states are loading. `thread.summary.changed` uses this same projection and fires only when its public fields change.

That is a coarse runtime projection and **does not exactly equal the Native sidebar's spinning indicator**. Static evidence was read from the already-saved Native 26.1007.2314 assets without executing them:

- `app-initial-b8e1c8014bb4.js`: `d9n` at byte 2794583 and `f9n` at 2794912 derive loading from owned in-progress work, runtime state, response progress, resume state and system error. `c9n` at 2794331 additionally checks child work. A loading response/child work can therefore coexist with a runtime value that the Adapter does not project as running.
- The actual local row `oqo` at byte 7544359 reads `k9n` and `f9n`, suppresses loading for blocking input or attention-only presentation, and lets publication (`lGo`, 7484585) force loading. Asynchronous nonblocking input can keep its own loading indicator. The Adapter instead treats all pending requests as attention, without these distinctions.
- `_zo` at byte 7338314 applies input/override/hidden-row presentation. `Q1` at 7325764 gives unread count priority over loading; loading renders `LRo` at 7327207, which invokes the spinner export. Shared `Vbi` at byte 5903217 renders `motion-safe:animate-spin`. Thus unread count and row presentation also affect whether that spinner is displayed. Motion preferences can stop animation while retaining the semantic Working indicator.

Extracted, formatted read-only evidence is saved under `.artifacts/workspace-context-source/symbols-db3b7517-9e6d-499b-9465-18081864d196`, `symbols-9d292ea5-9e92-4805-a9cc-6a9ce9f97eb6`, `symbols-62301613-b6b8-437b-90ef-89130aa495b3`, and `symbols-91473dfc-98e2-4ba2-9272-df77c5de28f4`. These are build-specific observations, not stable private export names for consumers.

Smallest proposed generic extension, not implemented here: an optional normalized `sidebarWorkingIndicator:boolean|null` on the loaded summary and its existing change event. Derive it from the supported Native sidebar selectors and normal row presentation; null means that profile/row mapping is not proved. This permits a spinner-only activity filter while preserving the current broader runtimeStatus meaning. It must cover blocking/nonblocking input, child work, publication, unread count and overrides; it should not guess from activeFlags, poll the whole UI or expose Native scopes. Additional acceptance would be needed before publishing that field.

Subsequent interface decision: that proposal is superseded by implemented `working:boolean|null`, which expresses ongoing Native work and deliberately excludes unread/folded/virtualized presentation overrides. See [the current Working contract](workspace-working-contract-2026-10-14.md). The audit above continues to explain why the older runtimeStatus is not that contract.

## Public list pagination and search

Current implementation: `frontend/src/desktop/entry.js`, read switch lines 527 and 541–545. The authenticated `codex.backend.read@1` method is:

```ts
threads.list({cursor?:string,limit?:number,archived?:boolean})
  -> {threads:ThreadDto[],cursor:string|null}
```

Limit defaults to 20 and must be 1..100 per request. Archived defaults false and must be boolean. The adapter forwards cursor to existing Native `thread/list`, fixes `sortKey:'updated_at'`, maps every returned `data` entry to a DTO, and exposes backend `nextCursor` as public **cursor**, not nextCursor. Null ends pagination. Cursor input/output strings are bounded to 4096 characters. No Adapter total-result cap or automatic page collection exists. There is no public search/query/searchTerm argument; strict unknown-field validation rejects them before sending a request. `threads.loaded` also has no search argument and exposes only its current cache.

Native Shared has a separate `searchThreads` method at byte 2707722. It calls **thread/search** with searchTerm, cursor and remaining limit, follows nextCursor, and returns title/cwd plus a content-match snippet. That wrapper defaults to a total limit of 50, so it cannot itself be advertised as unlimited public search. It does not establish that thread/list accepts searchTerm.

Smallest proposed generic search extension, not implemented here: `threads.search({query,cursor?,limit?,archived?}) -> {threads,cursor}` on the existing authenticated read capability, following the actual supported thread/search protocol one page per call. No automatic total cap, bulk collection or added connection is required. Unsupported profiles should return a capability diagnostic. Search should not be silently injected into thread/list, and currently loaded-title filtering should not be described as complete persistent-history search.
