# Codlet

Codlet is a lightweight plugin loader for Codex Desktop. Describe a customization to AI, build it as a plugin, and share it. Codlet launches the installed official client without rewriting its application files, and gives trusted JavaScript plugins lifecycle, permissions, RPC, and management APIs.

Core, CLI, the public SDK, the runtime `/codlet` skill, and distribution tools live here. Core includes the Codex UI and Desktop compatibility modules and exposes them through `context.codex`. The management GUI remains an optional plugin maintained in [codlet-plugins](https://github.com/baoabaob/codlet-plugins). Separate Adapter installation is no longer required.

The current Windows preview is **1.0.0-rc.14**, integrating startup recovery, backend restart preparation and [Native builds 21421/21477 adaptation](docs/native-adaptation-20261023.md). The [release page](https://github.com/baoabaob/codlet/releases/tag/v1.0.0-rc.14) provides the installer and validation scope; the [extended acceptance record](docs/core-acceptance-20261022.md) covers the preceding repair candidate. The latest macOS package remains [1.0.0-rc.7](docs/releases/1.0.0-rc.7/validation.md). Core owns client capability probes and adaptation; plugins use the public SDK. See [platform evidence](docs/compatibility.md), [online updates](docs/core-online-update.md) and [known limitations](docs/known-issues.md).

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
