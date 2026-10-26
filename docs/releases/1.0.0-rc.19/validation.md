# 1.0.0-rc.19 validation

Windows x64, Native package `26.1021.3705.0`. Includes UI implementation `0.1.17`; Desktop `0.2.20` and GUI `1.0.0-rc.6` are unchanged.

## Runtime skill registration

The running rc.18 client generated the skill files but rejected Native discovery because an AppScope contained 981 cached bindings, above the bridge's separate 512-entry cutoff. This bridge had not been included in the preceding UI/Desktop discovery fix.

The skill bridge now walks finite Native structures with identity-based cycle detection and checks the actual local connection. It no longer uses tree/scope counts as compatibility conditions. Extra Native skill roots no longer inherit a Core count/path-length quota, and root registration retains Native request options instead of imposing a shorter timeout. Pending registration still retires with its owner.

The corrected bridge recovered the existing runtime without restarting Native. The subsequent Native `skills/list` result included enabled skill `codlet`. This current-process recovery does not replace rc.18's embedded startup code; installing rc.19 makes the correction persistent.

## Transcript positioning

`TranscriptHandle.scrollToLatest()` explicitly positions its ready, owned Native scroller using measured content and viewport dimensions. It preserves horizontal position, other transcripts and later Native/user scroll behavior. Split Workbench rc.7 calls it for new panes, while existing and restored panes retain their captured positions. Explicitly adding a removed conversation clears the old pane's cached position; undo retains it.

## Evidence

- 9 skill bridge tests, including more than 20,000 fibers, 600 bindings and cycle detection, passed.
- 5 Rust skill tests and 16 compatibility tests passed, including 64 Native extra roots.
- 58 Workspace tests and SDK type checking passed.
- Split Workbench: 154 consumer tests and production build passed.
- The live skill probe observed 18,898 fibers, 38 scopes, a largest scope of 981 bindings, and successful Native skill listing. Temporary probe registration was removed.
- An isolated read-only transcript in the current Native client exposed a 10,462-pixel history and 400-pixel viewport. The explicit latest-content position was 10,062, with zero bottom gap and no change after the measured layout steps. The client was hidden; this does not establish visible drag/late-content behavior.

No real user message or official-client update was submitted during these checks.
