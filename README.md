# Codlet

Codlet is an extension runtime for Codex Desktop. It launches a managed desktop session and loads trusted JavaScript plugins with shared lifecycle, permissions, RPC, and management APIs.

Core, CLI, the public SDK, the runtime `/codlet` skill, and distribution tools live here. Core includes the Codex UI and Desktop compatibility modules and exposes them through `context.codex`. The management GUI remains an optional plugin maintained in [codlet-plugins](https://github.com/baoabaob/codlet-plugins). Separate Adapter installation is no longer required.

The **1.0.0-rc.1** major update is a local release candidate and has not been published. The [implementation contract](docs/unified-core-v1-contract.md) describes the SDK, permission and migration boundaries; [online updates](docs/core-online-update.md) distinguishes active modules from resident components that require the next launch. Windows x64 is the primary test platform; macOS Apple Silicon has a native build and installer path. [Platform evidence](docs/compatibility.md) and [known limitations](docs/known-issues.md) define the actual support boundaries. Linux is outside the current scope.

## Use Codlet

On Windows, use the `-setup.exe` installer for installation and upgrades, then open `Codlet-Launcher.exe`. The installer offers scope, folder, optional official plugins, shortcuts, and PATH choices. Future Windows releases provide this installer as the single installation download. On macOS, open `Codlet.app` from Applications. The official Codex client must already be installed separately. See [installation and distribution](docs/distribution.md).

The optional GUI provides a GitHub-backed plugin marketplace, local/GitHub import, search and tag filtering, permission review, enable/disable/reload/removal, and individual or bulk GitHub updates. Successful updates retain one current package. The CLI works independently of the GUI:

```sh
codlet launch
codlet launch --safe-mode
codlet status --json
codlet doctor --json
codlet plugin list --json
codlet plugin disable dev.my-plugin --json
```

Use the same executable and `CODLET_HOME` as the running Core. The default data directory is `%LOCALAPPDATA%/Codlet` on Windows and `~/Library/Application Support/Codlet` on macOS. An absolute `CODLET_HOME` overrides only Codlet data; it does not redirect the official client's account or conversations.

While Core runs, the `/codlet` skill can explain Codlet, manage plugins through the CLI, or guide plugin creation. It is provided at runtime and does not install itself into user or project skill directories.

## Write a plugin

A plugin directory contains `codlet.json`, built JavaScript entrypoints, and optional resources. Renderer and Host entrypoints export CommonJS `activate(context)` and `deactivate()` functions. Combined entries share one lifecycle generation.

- Renderer code uses the public DOM/UI SDK, or explicitly granted main-world/CDP access.
- Ordinary Host computation uses `host.mode: "sdk"` and managed services. Explicit `host.mode: "node"` requires `host.raw` for the full Node environment.
- The [Codex SDK](docs/spec/codex.md) provides navigation, workspace, tasks, permissions, events, submission hooks and configuration; Core owns Native version adaptation.

Start with the [plugin format](docs/spec/plugin-format.md), [Host contract](docs/spec/host.md), and [examples](examples). Public declarations are in [types](types). [Permission boundaries](docs/permission-boundaries-v1.md) distinguish broker/admission checks from declarations and trusted-code restrictions; neither a shared renderer realm nor a Node VM is an OS security sandbox.

## Develop

```sh
npm ci --prefix frontend
node frontend/build.mjs
cargo build --locked --bin codlet
```

Normal launches prepare the verified Node runtime automatically. Isolated lab and Host fixtures still stage their pinned runtime explicitly. Follow the [development guide](docs/development.md) for Windows/macOS commands, targeted tests, and the independent test client. Release builds reject the synthetic `test-fixtures` catalog.

The [documentation index](docs/README.md) covers architecture, maintained contracts, diagnostics, and delivery. [CONTRIBUTING.md](CONTRIBUTING.md) explains contribution and validation expectations; [SECURITY.md](SECURITY.md) explains the trust boundary and reporting route.

## License

Codlet is licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) and [third-party UI licenses](docs/THIRD_PARTY_UI_LICENSES.txt) for attribution. Dependency licenses remain unchanged. Codlet is an independent project; the official Codex client and OpenAI services are not included in this license or distributed in these packages.
