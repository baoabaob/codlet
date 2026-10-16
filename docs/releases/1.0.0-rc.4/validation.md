# Windows startup repair: 1.0.0-rc.4

This release repairs startup with the installed `OpenAI.Codex_26.1013.3656.0_x64` package (frontend `26.1013.31256`, backend `0.163.0-alpha.10.2`).

Core recovery now continues when a traffic source is unavailable and no external launch provider needs suspension. A Responses provider that omits `base_url` uses its authentication-dependent default; explicit endpoints remain unchanged. Account changes update every route that follows that default. Module readiness starts after Electron readiness and stays within the bridge activation budget.

## Validation

- Rust: `cargo test --locked --all-features` — 811 passed, 9 ignored.
- JavaScript: 732 passed, 5 skipped across `tests/*.test.mjs` and `codex/tests/*.test.mjs`. `thread_restoration.test.mjs` requires `CODLET_CORE_ROOT` in this checkout; its nine tests passed after setting that existing test input.
- Strict Clippy: all targets and all features, with warnings denied.
- The current user's backend configuration was probed read-only through `initialize`, `config/read`, `account/read`, and route override readback. Its selected `custom` provider has no explicit endpoint; both effective default routes were accepted. No model request was made.
- The exact installed package passed the Dev/WS isolation review in `docs/native-isolation-26.1013.3656.0.json`.
- A fresh independent Native instance launched in normal mode with a dedicated loopback WebSocket backend and synthetic account. PID, creation time, executable, data paths, backend listener and renderer target were verified. The existing daily processes stayed unchanged.
- The final source reported all four bridge roles available: network, desktop fetch, stdio and connection. Core UI, Core Desktop and GUI `1.0.0-rc.2` each reported `activation_confirmed: true` and `active: true` on the owned renderer.
- The test instance exited normally, its CDP workers were reaped, and redundant runtime/executable copies were removed. Reports, source diagnostics and databases remain under `.codlet-artifacts/core-native/core-1189e3b0-1d79-4519-8324-d683a7c84c0b`.

The independent Native run uses the reviewed development WebSocket path. It verifies startup and renderer activation; the normal stdio provider path is covered by backend probing and routing tests. It does not establish an authenticated model-stream result or a restart of the user's daily instance. The fresh profile reaches Native's first-use onboarding, so GUI activation is verified from the live runtime rather than a completed first-use screen flow.
