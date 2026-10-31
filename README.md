# Codlet

Codlet is a lightweight plugin loader for Codex Desktop. Describe a customization to AI, build it as a plugin, and share it. Codlet launches the installed official client without rewriting its application files, and gives trusted JavaScript plugins lifecycle, permissions, RPC, and management APIs.

Core, CLI, the public SDK, the runtime `/codlet` skill, and distribution tools live here. Core includes the Codex UI and Desktop compatibility modules and exposes them through `context.codex`. The management GUI remains an optional plugin maintained in [codlet-plugins](https://github.com/baoabaob/codlet-plugins). Separate Adapter installation is no longer required.

The Windows x64 **[1.0.0-rc.22 preview](https://github.com/baoabaob/codlet/releases/tag/v1.0.0-rc.22)** supports official client package `26.1027.3384.0` / app `26.1027.30824` / build `22943`, with Desktop `0.2.22` and UI `0.1.19`. It updates navigation, conversations, permission display and Split Workbench integration, fixes request cancellation errors and Windows Installer restart handoff, and retains the HTTP response correction. See the [validation](docs/releases/1.0.0-rc.22/validation.md) and [publication record](docs/releases/1.0.0-rc.22/publication.md).

The [rc.21 validation record](docs/releases/1.0.0-rc.21/validation.md) retains the earlier Desktop HTTP correction and direct-setup recovery evidence. The latest macOS package remains [1.0.0-rc.7](docs/releases/1.0.0-rc.7/validation.md). See [platform evidence](docs/compatibility.md), [online updates](docs/core-online-update.md) and [known limitations](docs/known-issues.md).

## Use Codlet

On Windows, download the **[Windows x64 setup EXE](https://github.com/baoabaob/codlet/releases/download/v1.0.0-rc.22/Codlet-1.0.0-rc.22-windows-x64-setup.exe)** for installation and upgrades, then open `Codlet-Launcher.exe`. The installer offers scope, folder, optional official plugins, shortcuts, and PATH choices. On macOS, open `Codlet.app` from Applications. The official Codex client must already be installed separately. See [installation and distribution](docs/distribution.md).

For the rc.20/rc.21 MSI upgrade to rc.22, save your work, fully quit Codex/Codlet and run the rc.22 setup EXE directly. It retains the registered folder, scope and feature choices. The handoff repair becomes active in the newly installed rc.22 Core; it cannot repair the updater inside a running older Core.

Setup updates Codlet only. Complete any official-client update through its existing update process. If that process opens the official client, fully quit it after updating, then start from the **Codlet** shortcut or installed `Codlet-Launcher.exe`.

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

For example: “Use /codlet to make a plugin that adds a focus toggle to this client.” The skill chooses a name and source directory, explains the necessary permissions, and implements the requested behavior. Source projects stay separate from installed copies; editing and rebuilding a project is followed by an explicit update. See [creating and iterating on a plugin](docs/plugin-development.md).

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
node scripts/check-dev-storage.mjs
cargo build --locked --bin codlet
```

Normal launches prepare the verified Node runtime automatically. Isolated lab and Host fixtures still stage their pinned runtime explicitly. Follow the [development guide](docs/development.md) for Windows/macOS commands, targeted tests, and the independent test client. Release builds reject the synthetic `test-fixtures` catalog.

The [documentation index](docs/README.md) covers maintained contracts, diagnostics, release evidence and historical research. The [repository map](docs/repository-layout.md) explains Core, GUI, split-workbench and retired Adapter ownership. [CONTRIBUTING.md](CONTRIBUTING.md) explains contribution and validation expectations; [SECURITY.md](SECURITY.md) explains the trust boundary and reporting route.

## License

Codlet is licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) and [third-party UI licenses](docs/THIRD_PARTY_UI_LICENSES.txt) for attribution. Dependency licenses remain unchanged. Codlet is an independent project; the official Codex client and OpenAI services are not included in this license or distributed in these packages.
