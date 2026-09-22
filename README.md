# Codlet

Codlet is an extension runtime for Codex Desktop. It launches a managed desktop session and loads trusted JavaScript plugins with shared lifecycle, permissions, RPC, and management APIs.

Core, CLI, the public SDK, the runtime `/codlet` skill, and distribution tools live here. The management GUI and the Desktop/UI adapters are optional plugins maintained in [codlet-plugins](https://github.com/baoabaob/codlet-plugins). They are not compiled into Core.

This is a development Preview. Source repositories are private during the trial; no public release channel is available. Windows x64 is the primary tested platform. macOS Apple Silicon has a native build and installer path; see [platform evidence](docs/compatibility.md) and [known limitations](docs/known-issues.md) before testing. Linux is outside the current scope.

## Use Codlet

Windows packages provide `Codlet-Launcher.exe`. The MSI offers optional official plugins and shortcuts; the portable package keeps Codlet data beside the executable. On macOS, open `Codlet.app` from Applications. The official Codex client must already be installed separately. See [installation and distribution](docs/distribution.md).

The optional GUI provides plugin import, search and tag filtering, permission review, enable/disable/reload/removal, and individual or bulk GitHub updates. Successful updates retain one current package. The CLI works independently of the GUI:

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
- Host code runs in Codlet's pinned Node runtime and can use managed storage, process, network, and traffic services.
- Capabilities let plugins depend on adapters instead of duplicating private client integration.

Start with the [plugin format](docs/spec/plugin-format.md), [Host contract](docs/spec/host.md), and [examples](examples). Public declarations are in [types](types). Trusted Host code has the user's OS privileges: broker permissions do not make ordinary Node code an OS sandbox.

## Develop

```sh
npm ci --prefix frontend
node frontend/build.mjs
cargo build --locked --bin codlet
```

Stage the pinned Node runtime before launch or Host tests. Follow the [development guide](docs/development.md) for Windows/macOS commands, targeted tests, and the independent test client. Release builds reject the synthetic `test-fixtures` catalog.

The [documentation index](docs/README.md) covers architecture, maintained contracts, diagnostics, and delivery. [CONTRIBUTING.md](CONTRIBUTING.md) explains contribution and validation expectations; [SECURITY.md](SECURITY.md) explains the trust boundary and reporting route.

## License

Codlet is licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) and [third-party UI licenses](docs/THIRD_PARTY_UI_LICENSES.txt) for attribution. Dependency licenses remain unchanged. Codlet is an independent project; the official Codex client and OpenAI services are not included in this license or distributed in these packages.
