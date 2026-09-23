# Distribution

Preview artifacts contain Codlet, the pinned Node runtime, license/attribution files, SDK types, and explicitly selected optional official-plugin packages. The official Codex application, user accounts, conversation databases, developer profiles, and credentials are not bundled. Install the official client separately.

The source and independent official-plugin repositories are public. Preview binaries are published as versioned test assets after validation. Building a local Preview does not publish its files; the installed preview channel discovers published prereleases from the Core repository.

## Windows x64

The MSI installs per user. Its feature page offers the GUI, UI Adapter, Desktop Adapter, and shortcut options. The GUI requires UI Adapter; Desktop Adapter is independently optional. The completion page can launch Codlet. The native `Codlet-Launcher.exe` is the normal entrypoint; internal PowerShell helpers remain implementation details.

The portable ZIP must be extracted completely to a writable location. Its first run offers the same plugin choices and stores Codlet data in `data/`. Installed MSI builds use `%LOCALAPPDATA%/Codlet`. Neither redirects official Codex data. `Codlet-Launcher.exe --configure` can add omitted plugins later; ordinary launches do not reinstall removed plugins, and existing disabled states/grants are preserved.

Windows in-app runtime updates replace Core and its pinned Node runtime. Install a newer MSI or extract a new portable package when upgrading the native launcher or installer components. Official plugins have their own GitHub update channels.

The shared native process gate runs before MSI validates or changes installation files. It identifies relevant installed clients, shows their identity, requests normal close with a bounded wait, and offers retry/cancel. Restart Manager automatic shutdown is disabled; no client is force-killed. An unattended busy install fails explicitly. Uninstall removes program files/shortcuts and preserves plugin/config/data.

An updated installer offers explicit official-plugin updates. The Core verifies the complete old file set against its installer receipt or embedded hashes from the previously distributed Preview 1–4 packages, then updates the fixed `packages/<plugin-id>` directory while holding the offline registry and launch leases. Added, changed, linked, or custom-source files are preserved and reported as unverified (20). Existing disabled states, revoked permissions, and all broker scopes are retained; genuinely new permissions require a separate approval. Ordinary startup never reinstalls a removed plugin.

One local journal coordinates staged bytes, the registry, and the receipt. Startup and offline CLI recover interrupted operations before loading packages. Temporary ready/backup directories are removed after commit; no historical package store remains. Sources remain local registrations, never synthetic GitHub installations. A running Host must first finish and exit normally before this offline transaction can run.

The installer uses `codlet plugin seed preview <catalog.json> <id> --json` and binds `seed install` to its returned `--preview` digest plus one `--grant` per approved new permission. Direct PowerShell callers can pass `-ApproveNewPermissions`; macOS command-line callers use `--approve-new-permission=<permission>`. Missing approval fails before writes. `scripts/record-legacy-seeds.mjs` regenerates the embedded historical hash list only from prior distributions whose catalog and payload hashes match their distribution manifests; it copies no plugin payloads.

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

The `Build macOS preview` workflow accepts full Core/plugin commit SHAs, verifies an actual ARM64 runner, builds native Core/Swift, prepares the matching Core SDK for the independent plugins, tests initialization in an isolated Codlet home, mounts the DMG, and uploads artifacts with provenance. Both source repositories are checked out publicly without deployment credentials.

Current Preview signing is ad-hoc integrity signing. Developer ID signing, notarization, and real Mac desktop acceptance are separate release gates. A successful mount/build alone does not satisfy them.

## Licensing and release checks

Ship root `LICENSE` (Apache-2.0), `NOTICE`, third-party UI and Rust notices, pinned Node's license, and each optional plugin's license/notice. Third-party plugins keep their author's actual licenses and are not automatically relicensed to Apache-2.0.

Before delivery, verify the source revisions, package version, architecture, file hashes, installed/portable data scope, cancellation, existing data, optional components, and shortcuts. Record remaining limitations honestly in [known issues](known-issues.md). Publishing a Preview does not establish signed stable-release readiness or replace real-client installation acceptance on each platform.

## Preparing a Preview release

`scripts/Publish-PreviewRelease.ps1` consumes the already-built Windows portable directory and ZIP, MSI plus its `.msi.json` build receipt and MSI distribution manifest, and the macOS DMG, distribution manifest, and updater ZIP. It checks that all package versions and Core/plugin source commits agree, verifies Windows payload/ZIP hashes, MSI receipt, macOS DMG metadata, and the complete macOS updater ZIP inventory/modes/Node pins, then writes a fresh versioned release directory with assets, SHA-256 summary, release notes, and `release-plan.json`. It creates no remote state in its default `Preview` action.

The generated `codlet-update.json` uses the in-client GitHub manifest asset name and schema: `schema: 1`, `kind: "codlet-runtime-channel"`, `channel: "preview"`, `version`, and an artifact per supported platform/profile. Each artifact pins its versioned update ZIP using `platform`, `profile`, `bytes`, `sha256`, and `assetName`. The updater ZIPs retain `runtime-update-manifest.json` at their root. The current release plan includes Windows `win-x64`/`portable` and Apple Silicon `darwin-arm64`/`macApp`; the ordinary portable ZIP, MSI, DMG, and distribution manifests are also attached as versioned release assets.

Use a new output directory and pass the explicit package paths from the build artifacts:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Publish-PreviewRelease.ps1 `
  -Action Preview `
  -WindowsPortableDirectory C:\build\windows\package\portable `
  -WindowsPortableZip C:\build\windows\package\Codlet-0.2.0-preview.5-windows-x64-portable.zip `
  -WindowsMsi C:\build\windows\package\Codlet-0.2.0-preview.5-windows-x64.msi `
  -WindowsMsiManifest C:\build\windows\package\msi.build\distribution-manifest.json `
  -MacDmg C:\build\macos\package\Codlet-0.2.0-preview.5-macos-arm64.dmg `
  -MacDistributionManifest C:\build\macos\package\distribution-manifest.json `
  -MacUpdateZip C:\build\macos\package\Codlet-0.2.0-preview.5-darwin-arm64-update.zip `
  -OutputDirectory C:\build\preview-release
```

Inspect `release-plan.json`, `release-notes.md`, and the asset hashes before preparing a draft. `PrepareDraft` and `Publish` without `-Apply` only validate the local plan and print the intended action. Draft upload is explicit and separate from publication:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Publish-PreviewRelease.ps1 `
  -Action PrepareDraft -PlanPath C:\build\preview-release\release-plan.json -Apply

# Publish only after reviewing the complete GitHub draft and its uploaded assets.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Publish-PreviewRelease.ps1 `
  -Action Publish -PlanPath C:\build\preview-release\release-plan.json -Apply
```

The publisher accepts `CODLET_CORE_RELEASE_TOKEN`, `GH_TOKEN`, or a Git Credential Manager credential without printing it. It never changes repository visibility. A version tag or same-version release with different notes, metadata, or assets is rejected; existing assets are never overwritten. Run `scripts/Test-PreviewRelease.ps1` for an isolated packaging/manifest contract test with synthetic inputs and no GitHub writes.
