# Codlet

Codlet is a lightweight extension runtime for Codex Desktop. It launches an explicitly selected desktop session, loads trusted JS/TS plugins, and provides shared lifecycle, capability, permission, and management APIs.

Development is currently in user trial. Windows x64 has live client evidence. Windows ARM64 has cross-compilation checks; macOS Apple Silicon has a native implementation pending native client and visual acceptance. Linux is deferred. See the [current review](docs/DEVELOPMENT_REVIEW_2026-09-16.md) and [macOS build and acceptance guide](docs/MACOS_DEVELOPMENT_2026-09-16.md). Release packaging, signing, installation UX, and icon design are deferred.

## Current functionality

- A sidebar page built with official OpenAI Apps SDK UI components, including light/dark themes, Chinese/English labels, plugin search and enabled-state filters
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

The Windows registry is `%LOCALAPPDATA%/Codlet/config.json`; macOS uses `~/Library/Application Support/Codlet/config.json`. GitHub packages use `packages/github/<plugin-id>` below that registry directory; new plugins created through the authoring skill default to `packages/<plugin-id>`. Author-owned local directories are registered in place. Plugin data is separate from package code. The runtime skill uses `runtime-skills/codlet` while Core is running.

The generated independent test client provides `Start-TestClient.cmd`, `Stop-TestClient.cmd`, and `Test-Plugins.ps1`. After an interrupted run, close the leftover Dev client and use `Start-TestClient.cmd -RecoverInterrupted`; the recovery path verifies that previous owners have exited. See [test-client recovery and current evidence](docs/DEVELOPMENT_REVIEW_2026-09-16.md).

## Development

Build the frontend before compiling Rust, because its generated output is embedded in the executable:

~~~powershell
npm ci --prefix frontend
node frontend/build.mjs
cargo build --bins
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

Fake-client, protocol, and process fixtures are distinct from real desktop acceptance. The existing real-client and crash harnesses must target their own explicitly selected test processes. Passing a build or mock test is not a claim of native platform support.

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
