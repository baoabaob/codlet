# Node reuse and startup progress: 1.0.0-rc.6

Core reuses compatible Node from the installed official client without an exact client-version or pre-recorded Node-hash requirement. It verifies the official package or bundle identity, probes Node's supported version, platform, architecture, required APIs and Host flags, and keeps the checked files in its private cache. The pinned download remains the fallback when local Node is unavailable or incompatible.

The Windows launcher shows Node preparation stages, download source, bytes and actual percentage. Unknown download sizes use an indeterminate indicator. The window stays responsive during Core status polling and supports continuing in the background. It follows the log for its own Core process and closes when the client starts. Startup plugin checks now respect the user's setting.

## Validation

- Runtime regression suite: 12 passed, including version/architecture/API checks, cache tamper rejection, concurrent preparation, interrupted preparation, cleanup, extraction and mirror fallback.
- Startup plugin update suite: 5 passed, including a disabled-setting check that bypasses the entire prelaunch update path.
- A real installed Native `26.1013.4894.0` supplied Node `24.21.0`. The opt-in runtime test copied it into a fresh private cache, reused that copy, and completed the actual plugin Host initialize/shutdown protocol. The Native application was not launched by this test.
- The pinned fallback test downloaded the actual 37,618,919-byte archive, reported incremental received bytes through completion, verified its digest, extracted Node and reused the resulting cache.
- Windows progress tests passed for Chinese/English and light/dark themes. They check real byte percentages, unknown-size behavior, retry counters, partial UTF-8 log records and process identity. All four rendered window images were reviewed.
- Existing launcher regressions passed: early Core failures preserve diagnostics, safe mode bypasses setup, detached Core output survives launcher exit, and renderer degradation remains a ready Core result.
- Strict Clippy passed for all targets and all features with warnings denied.

The macOS runtime resolver uses the same Node compatibility checks and emits the same progress log events. Native macOS execution and AppKit UI are not covered by this Windows validation.
