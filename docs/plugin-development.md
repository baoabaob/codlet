# Create and iterate on a plugin

With Codlet running, ask `/codlet` for the behavior you want. Core supplies a scoped CLI, public types and documentation to the skill. A name, source directory and simple UI implementation can use defaults; access beyond the requested feature needs a clear permission choice.

Source projects default to `projects/<name>` under Codlet's data directory. Installation copies the project into `packages/<id>`. Keep the source project for editing, version control and sharing. Runtime skill files are temporary Core resources.

When using a compiler or package manager, generate a clean package directory
containing `codlet.json`, built entrypoints and necessary resources. Pass that
directory to the commands below; do not import the repository with `node_modules`,
Git metadata, credentials or user data. A plain JavaScript plugin can use its
small source directory directly.

For an existing source project:

```sh
codlet plugin preview /absolute/source-directory --json
codlet plugin add /absolute/source-directory --trust --grant ui.dom --enable --json
```

After changing and building its JavaScript entrypoint:

```sh
codlet plugin add /absolute/source-directory --update --trust --grant ui.dom --enable --json
```

These commands illustrate an enabled UI-only plugin. Use the exact CLI and `CODLET_HOME` of the running instance, the actual declared permissions, and the existing enable preference. Updates retain configuration, data and credentials. `--replace` deliberately resets them. `reload` restarts the installed copy; it does not compile or synchronize the source project.

Check the actual behavior, disable cleanup and another enable/update cycle. For UI, also check theme and window sizes. `enabled` in a list is a preference, not runtime health. Shared Renderer and Node environments execute trusted code; they do not sandbox malicious plugins.

Share a package containing `codlet.json`, built entrypoints, required resources, documentation and licenses. Leave out credentials, user data, logs and dependency caches. Declare the SDK and capabilities used; record only tests actually performed. Uploading or publishing is a separate user choice.

Public releases also require `codlet-update.json` inside the ZIP and a signed
`codlet-updates.json` Release asset. Use the shared
[plugin publisher](spec/plugin-updates.md) to generate the source configuration,
archive hashes and signature from the actual package. Retain the publisher key
across versions.

Start with [plugin format](spec/plugin-format.md), [Core services](spec/services.md), [Codex SDK](spec/codex.md), and [examples](../examples). Ordinary background computation uses `host.mode: "sdk"`; a UI-only plugin does not need an empty Host process. Core maintains Native adaptation behind the SDK. Private DOM, main-world, raw CDP and full Node access carry additional compatibility work.
