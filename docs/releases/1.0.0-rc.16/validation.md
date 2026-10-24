# Core rc.16 validation

Core source `118c41dac157c9fcf6967873b0c6a2ada3ffe903` exposes Native task ancestry
through thread reads and loaded summaries. Workspace input navigation rejects
child agent tasks before changing the Native route. Split Workbench rc.6 filters
those tasks and migrates saved membership, including inactive workspace state.

On 2026-10-24, the Core adapter suite passed 450 tests with two optional skips.
Split rc.6 passed 153 consumer tests and its production build. The checks cover
ordinary untitled/forked tasks, automatic membership, history filtering, late
identity changes, retained root body/input state and saved child selections.

A temporary read-only probe used the actual Native `26.1016.8622.0` cache involved
in the report. Two root tasks classified as ordinary tasks; the child had a direct
parent, a subagent source and `threadSource: subagent`. The candidate opener
returned `workspace_thread_not_selectable` without calling its route or request
hooks. The diagnostic was uninstalled after preserving its local report. No
conversation titles, content or task identifiers are included in this record.

This probe did not execute Native navigation. The earlier full workspace
interaction checks remain in [rc.15's record](../1.0.0-rc.15/validation.md).
There is no new physical IME, performance, long-soak or macOS acceptance.

The final Windows setup self-test passed with payload hashing and no installation.
Setup SHA-256: `7666718cb0009a800b97e7a6a03ec38a15b68e76df64314460430a0f0bfd3c02`.
The release executable SHA-256 is
`cb702974c2329d3b99dbff1ba6d7ac3ec917e9cab859491f2d81677ef6bb01db`.

The published rc.14 and rc.15 resident distributions pass online package eligibility
for `core-ui-provider` and `core-desktop-provider`. A live activation is a separate
runtime preflight and receipt. Windows packages remain unsigned.
