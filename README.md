# Codlet

Codlet is a lightweight extension runtime for Codex Desktop. It launches an explicitly selected desktop session, loads trusted JS/TS plugins, and provides shared lifecycle, capability, permission, and management APIs.

The current milestone is a local Windows x64 Preview with portable ZIP and per-user MSI delivery. The source repositories remain private and no public release has been published. Windows ARM64 and macOS Apple Silicon still need real-client acceptance; Linux is deferred. See the [distribution work and evidence](docs/WINDOWS_PREVIEW_DISTRIBUTION_2026-09-21.md).

This repository owns Core, CLI, SDK, runtime skill and distribution tools. The UI Adapter, Desktop Adapter and management GUI are ordinary optional plugins maintained in the separate [codlet-plugins repository](https://github.com/baoabaob/codlet-plugins). Their source and bundles are not compiled into normal Core builds. The generic `context.ui` library remains part of the public Core SDK.

## Current functionality

- An optional management plugin with official UI components, light/dark themes, Chinese/English labels, search, tags and enabled-state filters
- Local folder import and GitHub release import with source inspection, permission confirmation, and dependency checks
- One-click plugin updates and Update all, using the existing Core transaction queue; permissions or dependency changes require review
- Stable GitHub installation directories at `packages/github/<plugin-id>`, one installed version, and removal of old packages after successful updates
- Enable, disable, reload, revoke, and remove operations shared by GUI and CLI, with dependency-aware retirement and recovery after failed activation
- Opt-in local source watching, settings, safe mode, local error logs, and diagnostic export
- A Core-provided `/codlet` authoring skill, available independently of the management GUI and cleaned up when Core exits
- Managed HTTP(S)/SSE and WS/WSS plugin channels, with an optional Desktop Adapter attachment API; see [scope and contract](docs/TRAFFIC_CHANNELS.md)

Creating a plugin opens an editable new-task draft containing `/codlet 帮我创建一个插件：`. The skill clarifies requirements, the plugin name and location, optional official UI usage, dependencies, execution layers, and permissions. It uses the current Core's actual plugin inventory and does not install itself into user or project skill folders.

## Runtime and plugin model

A plugin is a directory with `codlet.json`, built JavaScript entrypoints, and optional resources. Both entrypoints export CommonJS `activate(context)` and `deactivate()` functions:

- `renderer.entry` executes in an isolated page world, or in the main world when explicitly granted
- `host.entry` executes in Codlet's pinned Node runtime; native Node addons and runtime TypeScript compilation are unsupported
- A package may provide either entrypoint or both. Combined entries share one generation and lifecycle receipt

Declared capabilities use Runtime or Target scope. RPC calls pin provider generations and document identity, inherit deadlines, and retire when their owners stop. Host processes are managed separately from renderer contexts. The optional Desktop and UI adapters provide the reviewed private client mappings; third-party plugins can also use public raw CDP APIs.

The generic registry, lifecycle, RPC, and permission layers remain separate from client-specific integration. The built-in runtime skill has its own resource owner and native connection bridge. Its failure does not authorize a second backend connection or submission of a model task.

Trusted Host JavaScript runs with the user's OS privileges. Broker scopes constrain broker calls; they do not turn ordinary Node code into an OS sandbox. See [the plugin runtime contract](docs/JS_PLUGIN_RUNTIME_2026-09-09.md), [Core RPC](docs/CORE_RPC_2026-09-10.md), and [OS brokers](docs/OS_BROKER_2026-09-10.md).

## Start and manage

Use the same executable and registry scope as the running Core:

~~~powershell
codlet launch
codlet launch --watch
codlet launch --safe-mode
codlet status --json
codlet doctor --json
codlet plugin list --json
codlet plugin permissions dev.my-plugin --json
codlet plugin enable dev.my-plugin --json
codlet plugin disable dev.my-plugin --json
codlet plugin reload dev.my-plugin --json
codlet plugin revoke dev.my-plugin ui.dom --json
codlet plugin operation <receipt> --json
~~~

Submitted operations are checked through their receipt when a response is lost; a timeout does not authorize another submission. Registry writes merge explicit edits under a process lock and protect concurrent permission changes. The CLI remains available when the GUI is disabled.

The Windows registry is `%LOCALAPPDATA%/Codlet/config.json`; macOS uses `~/Library/Application Support/Codlet/config.json`. An absolute `CODLET_HOME` scopes only Codlet data and takes precedence on either platform. The portable launchers set it to their own `data/`; they do not redirect the official client's data. GitHub packages use `packages/github/<plugin-id>` below that registry directory; new plugins and first-party offline packages use `packages/<plugin-id>`. Author-owned local directories are registered in place. Plugin data is separate from package code. The runtime skill uses `runtime-skills/codlet` while Core is running.

The generated independent test client provides `Start-TestClient.cmd`, `Stop-TestClient.cmd`, and `Test-Plugins.ps1`. After an interrupted run, close the leftover Dev client and use `Start-TestClient.cmd -RecoverInterrupted`; the recovery path verifies that previous owners have exited. See [test-client recovery and current evidence](docs/DEVELOPMENT_REVIEW_2026-09-16.md).

## Development

Build the generic SDK bundles before compiling Rust. Official plugins are built independently and are not needed to compile or run Core:

~~~powershell
npm ci --prefix frontend
node frontend/build.mjs
cargo build --bin codlet --no-default-features
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Install-JsRuntime.ps1 -Destination target/debug
~~~

On an Apple Silicon Mac, use `sh scripts/build-macos.sh` to build and stage the pinned native Node runtime, then `sh scripts/test-macos.sh` for native Core checks. The build prints the actual executable path; run it with `launch`. Ctrl+C stops the owned session through Core cleanup. See the [Mac guide](docs/MACOS_DEVELOPMENT_2026-09-16.md) for client selection, safe mode, and the remaining real-client checks.

Run checks appropriate to the affected feature. Wider regression commands include:

~~~powershell
cargo fmt --all -- --check
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked --all-targets --all-features
node --test tests/*.test.mjs
~~~

`--all-features` enables the synthetic `test-fixtures` catalog used by legacy protocol/lifecycle integration tests. That feature is rejected in release builds. Fake-client fixtures are distinct from real desktop acceptance; use a normal release build for the latter. The separate official-plugin repository runs the actual adapter/GUI tests against an explicitly prepared Core SDK snapshot.

Build local delivery with `scripts/Build-PreviewDistribution.ps1`, passing the Core binary, pinned Node directory and the independent plugin repository's `dist/`. Then use `node scripts/build-msi.mjs PORTABLE_DIRECTORY WIX_DIRECTORY OUTPUT.msi`. Details and acceptance commands are in [the Windows Preview guide](docs/WINDOWS_PREVIEW_DISTRIBUTION_2026-09-21.md).

## Contracts and evidence

- [Current architecture review and platform scope](docs/DEVELOPMENT_REVIEW_2026-09-16.md)
- [Official desktop platform targets and current acceptance status](docs/PLATFORM_SUPPORT.md)
- [Architecture decisions and Mac frontend profiles](docs/ARCHITECTURE_REVIEW_2026-09-16.md)
- [Technical plan and remaining production gates](docs/PRODUCT_TECHNICAL_PLAN.md)
- [Local plugin development](docs/LOCAL_PLUGINS.md), [Host workflow](docs/HOST_DEVELOPMENT_2026-09-10.md), [Desktop Adapter](docs/DESKTOP_ADAPTER_DEVELOPMENT_2026-09-10.md)
- [Automatic plugin updates](docs/PLUGIN_AUTOMATIC_UPDATE_2026-09-15.md), [runtime skill](docs/RUNTIME_SKILL_PLAN_2026-09-15.md), [public management API](docs/RUNTIME_MANAGE_2026-09-10.md)
- [Safe mode](docs/SAFE_MODE.md), [diagnostics](docs/DIAGNOSTIC_BUNDLES.md), [doctor inspection](docs/DOCTOR_RUNTIME.md)
- [Host types](types/host.d.ts), [renderer types](types/renderer.d.ts), [UI types](types/renderer-ui.d.ts), [management types](types/runtime-manage.d.ts)

Codlet does not patch the official application package, replace official shortcuts, or monitor later official launches. Two production limitations remain documented: official launches can reuse an already extended main instance, and a Core crash does not guarantee the owned desktop process exits. These gates remain open during development trial.
