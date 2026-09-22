# Distribution

Preview artifacts contain Codlet, the pinned Node runtime, license/attribution files, SDK types, and explicitly selected optional official-plugin packages. The official Codex application, user accounts, conversation databases, developer profiles, and credentials are not bundled. Install the official client separately.

Repositories remain private during the development trial. Building a local Preview does not create a public release or enable a public update channel.

## Windows x64

The MSI installs per user. Its feature page offers the GUI, UI Adapter, Desktop Adapter, and shortcut options. The GUI requires UI Adapter; Desktop Adapter is independently optional. The completion page can launch Codlet. The native `Codlet-Launcher.exe` is the normal entrypoint; internal PowerShell helpers remain implementation details.

The portable ZIP must be extracted completely to a writable location. Its first run offers the same plugin choices and stores Codlet data in `data/`. Installed MSI builds use `%LOCALAPPDATA%/Codlet`. Neither redirects official Codex data. `Codlet-Launcher.exe --configure` can add omitted plugins later; ordinary launches do not reinstall removed plugins, and existing disabled states/grants are preserved.

The shared native process gate runs before MSI validates or changes installation files. It identifies relevant installed clients, shows their identity, requests normal close with a bounded wait, and offers retry/cancel. Restart Manager automatic shutdown is disabled; no client is force-killed. An unattended busy install fails explicitly. Uninstall removes program files/shortcuts and preserves plugin/config/data.

Build the official plugin repository's `dist/` independently, then assemble from reviewed inputs:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Build-PreviewDistribution.ps1 `
  -CodletExecutable C:\build\codlet.exe `
  -NodeDirectory C:\build\runtime\node-v24.21.0-win-x64 `
  -PluginDistribution C:\src\codlet-plugins\dist `
  -SourceCommit FULL_CORE_SHA -PluginsCommit FULL_PLUGIN_SHA `
  -OutputDirectory C:\output\codlet-preview -Zip
node scripts/build-msi.mjs C:\output\codlet-preview C:\tools\wix-3.14.1 C:\output\Codlet-Preview.msi
```

WiX 3.14.1 builds the MSI; the system .NET Framework compiler builds the launcher. Node hashes and plugin catalog files are verified before assembly. The manifest records distributed files and SHA-256 values. Offline plugin presets are local registrations; their independent GitHub release channels are recorded without inventing remote installation receipts.

Use `Test-DistributionEncoding.ps1` for Windows PowerShell/encoding checks and `Test-WindowsInstaller.ps1` for controlled process and MSI preflight scenarios. `Test-MsiDistribution.ps1 -StructureOnly` inspects tables/features without changing the user's installation. Never deliver fixture or stale-Core packages used by these tests.

## macOS Apple Silicon

Open the DMG and drag `Codlet.app` to Applications. The native Swift launcher offers optional official plugins and a Desktop shortcut on first use. Later explicit configuration starts with no plugin selected, so removed plugins stay removed. Existing registrations, grants, and disabled states are preserved.

The launcher requests normal quit of a recognized running Codex client, waits at most 15 seconds, and permits cancellation. It does not force-kill the client. Normal startup does not repeatedly run initialization.

```sh
sh scripts/build-macos.sh release
python3 scripts/build-preview-macos.py \
  --executable target/aarch64-apple-darwin/release/codlet \
  --node-directory target/aarch64-apple-darwin/release/runtime/node-v22.23.2-darwin-arm64 \
  --plugin-distribution ../codlet-plugins/dist \
  --source-commit FULL_CORE_SHA --plugins-commit FULL_PLUGIN_SHA \
  --output /absolute/new/output
```

The private `Build macOS preview` workflow accepts full Core/plugin commit SHAs, verifies an actual ARM64 runner, builds native Core/Swift, tests initialization in an isolated Codlet home, mounts the DMG, and uploads artifacts with provenance. A read-only deploy key grants access only to the independent plugin repository.

Current Preview signing is ad-hoc integrity signing. Developer ID signing, notarization, and real Mac desktop acceptance are separate release gates. A successful mount/build alone does not satisfy them.

## Licensing and release checks

Ship root `LICENSE` (Apache-2.0), `NOTICE`, third-party UI and Rust notices, pinned Node's license, and each optional plugin's license/notice. Third-party plugins keep their author's actual licenses and are not automatically relicensed to Apache-2.0.

Before delivery, verify the source revisions, package version, architecture, file hashes, installed/portable data scope, cancellation, existing data, optional components, and shortcuts. Record remaining limitations honestly in [known issues](known-issues.md). Public release, signing credentials, publication policy, and multi-platform real-client acceptance are outside a local test build.
