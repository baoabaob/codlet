# Distribution

Preview installers contain Codlet, license/attribution files, SDK types, and plugin download options. They contain no plugin code or fixed plugin versions. Node is prepared automatically in Codlet's private runtime cache: Core can reuse an exactly verified Node executable from a supported official client, or download and verify the pinned fallback. A system Node installation is not required. Install the official Codex client separately; its application, accounts and conversation databases are not redistributed.

Reusing the official client means copying its verified executable and license into Codlet's own data directory. The original client can then update independently. This reduces installer and repeat-download size, not Node's memory use or the space occupied by the prepared runtime. The cache follows `CODLET_HOME`: installed builds reuse their normal data directory, while each portable installation keeps its own cache. First use needs network access when neither an approved official runtime nor a valid cached copy is available; subsequent use can reuse the verified cache offline.

Fallback downloads first try the unchanged official archive mirrored in Codlet's `node-runtimes` dependency release, then the official Node.js URL. Both sources must match the same archive, executable and license hashes. When changing a Node pin, run the **Publish pinned Node.js runtimes** workflow before publishing installers; it verifies the original archives and never overwrites a same-name asset with different bytes. These dependency archives are kept out of ordinary Codlet release downloads.

The source and independent official-plugin repositories are public. Preview binaries are published as versioned test assets after validation. Building a local Preview does not publish its files; the installed preview channel discovers published prereleases from the Core repository.

## Windows x64

The MSI installs per user. Its feature page offers the GUI, UI Adapter, Desktop Adapter, and shortcut options. The GUI requires UI Adapter; Desktop Adapter is independently optional. The completion page can launch Codlet. The native `Codlet-Launcher.exe` is the normal entrypoint; internal PowerShell helpers remain implementation details.

The portable ZIP must be extracted completely to a writable location. Its first run offers the same plugin choices and stores Codlet data in `data/`. Installed MSI builds use `%LOCALAPPDATA%/Codlet`. Neither redirects official Codex data. `Codlet-Launcher.exe --configure` can add omitted plugins later; ordinary launches do not reinstall removed plugins, and existing disabled states/grants are preserved.

Windows in-app runtime updates replace Core and its runtime descriptor. An already prepared compatible Node is reused; preparing a missing runtime must succeed before the installation is replaced. Install a newer MSI or extract a new portable package when upgrading the native launcher or installer components. Official plugins have their own GitHub update channels.

`official-plugins.json` contains only the selectable IDs, repository URLs/numeric identities,
dependencies and initial permission expectations. MSI features persist download choices in
HKCU; portable and Mac setup ask on first use. Selection fetches the latest published stable
Release, finds its exact ID/version ZIP and calls the same `plugin github preview/install`
commands available to users. Core checks the archive; setup checks manifest ID/version,
repository/owner identity and the upstream SHA-256 before granting the selected permissions.
Additional permissions require separate approval. The resulting source is `github` from
the first installation, with no seed/adoption step for new users.

Only read/download failures are retried once automatically. Failed choices remain pending;
Windows offers retry/cancel and Mac restores pending choices on the next launch. Previously
completed plugin registrations are reused without download. An uncertain mutation is never
blindly replayed. Core upgrades/repair do not update, downgrade, adopt, re-enable or overwrite
existing plugins, including custom sources. Removed plugins are not revived by ordinary
startup. Use the GUI/CLI's normal update flow for installed plugins.

Earlier releases installed local seeds. Those existing receipts, file validation and explicit
GitHub adoption remain supported; installing a new Core does not silently change their source.
Legacy seed commands are migration support, not the current installer path. Core has no runtime
dependency on these official plugins and does not assign them special permissions.

The shared native process gate runs before MSI validates or changes installation files. It identifies relevant installed clients, shows their identity, requests normal close with a bounded wait, and offers retry/cancel. Restart Manager automatic shutdown is disabled; no client is force-killed. An unattended busy install fails explicitly. Uninstall removes program files/shortcuts and preserves plugin/config/data.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Build-PreviewDistribution.ps1 `
  -CodletExecutable C:\build\codlet.exe `
  -SourceCommit FULL_CORE_SHA `
  -OutputDirectory C:\output\codlet-preview -Zip
node scripts/build-msi.mjs C:\output\codlet-preview C:\tools\wix-3.14.1 C:\output\Codlet-Preview.msi
```

WiX 3.14.1 builds the MSI; the system .NET Framework compiler builds the launcher. The manifest records Core's source revision, distributed files and SHA-256 values. Plugin source commits and package hashes belong to the independently downloaded releases, not to Core's build.

Use `Test-DistributionEncoding.ps1` for Windows PowerShell/encoding checks and `Test-WindowsInstaller.ps1` for controlled process and MSI preflight scenarios. `Test-MsiDistribution.ps1 -StructureOnly` inspects tables/features without changing the user's installation. Never deliver fixture or stale-Core packages used by these tests.

## macOS Apple Silicon

Open the DMG and drag `Codlet.app` to Applications. The native Swift launcher offers optional official plugins and a Desktop shortcut on first use. Later explicit configuration starts with no plugin selected, so removed plugins stay removed. Existing registrations, grants, and disabled states are preserved.

The launcher requests normal quit of a recognized running Codex client, waits at most 15 seconds, and permits cancellation. It does not force-kill the client. Normal startup does not repeatedly run initialization.

```sh
sh scripts/build-macos.sh release
python3 scripts/build-preview-macos.py \
  --executable target/aarch64-apple-darwin/release/codlet \
  --node-directory target/aarch64-apple-darwin/release/runtime/node-v22.23.2-darwin-arm64 \
  --source-commit FULL_CORE_SHA \
  --output /absolute/new/output
```

The `Build macOS preview` workflow accepts one full Core commit SHA. It checks out only Core, verifies the ARM64 runner, builds Core/Swift, tests downloads in an isolated Codlet home, mounts the DMG and uploads artifacts with Core provenance. Building Core no longer checks out or builds the plugin repository.

Current Preview signing is ad-hoc integrity signing. Developer ID signing, notarization, and real Mac desktop acceptance are separate release gates. A successful mount/build alone does not satisfy them.

## Licensing and release checks

Ship root `LICENSE` (Apache-2.0), `NOTICE`, third-party UI and Rust notices, and each optional plugin's license/notice. The prepared Node executable and its verified license are kept together in the runtime cache. A bundled transition update also carries that license. Third-party plugins keep their author's actual licenses and are not automatically relicensed to Apache-2.0.

Before delivery, verify the source revisions, package version, architecture, file hashes, installed/portable data scope, cancellation, existing data, optional components, and shortcuts. Record remaining limitations honestly in [known issues](known-issues.md). Publishing a Preview does not establish signed stable-release readiness or replace real-client installation acceptance on each platform.

## Preparing a Preview release

`scripts/Publish-PreviewRelease.ps1` consumes the already-built Windows portable directory and ZIP, MSI plus its `.msi.json` build receipt and MSI distribution manifest, and the macOS DMG, distribution manifest, and updater ZIP. It checks that all package versions and Core/plugin source commits agree, verifies Windows payload/ZIP hashes, MSI receipt, macOS DMG metadata, and the complete macOS updater ZIP inventory/modes/Node pins, then writes a fresh versioned release directory with assets, SHA-256 summary, release notes, and `release-plan.json`. The three build-time distribution manifests remain in the local `.verification` directory and are checked again when reading the plan; they are not GitHub Release assets. The default `Preview` action creates no remote state.

The generated `codlet-update-managed.json` uses the in-client GitHub manifest asset name and schema: `schema: 1`, `kind: "codlet-runtime-channel"`, `channel: "preview"`, `version`, and an artifact per supported platform/profile. Each artifact pins its versioned update ZIP using `platform`, `profile`, `bytes`, `sha256`, and `assetName`. The updater ZIPs retain `runtime-update-manifest.json` at their root. The seven normal public assets are the Windows portable ZIP, MSI, Mac DMG, both updater ZIPs, `codlet-update-managed.json`, and `SHA256SUMS.txt`.

Preview 5 cannot read managed-runtime update packages. The Preview 6 transition therefore uses `-LegacyUpdateBridge -WindowsBridgeNodeDirectory <pinned-node-directory>` and the Mac builder's separate legacy updater ZIP. It publishes complete old-format updater payloads plus the additional `codlet-update.json` channel that Preview 5 understands; the ordinary MSI, portable ZIP and DMG remain small. Both channels name the same transition payloads. Core 6 reads the managed channel after that update. Later releases omit the legacy channel so older clients find the compatible transition release instead of attempting an unsupported small ZIP.

Use a new output directory and pass the explicit package paths from the build artifacts:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Publish-PreviewRelease.ps1 `
  -Action Preview `
  -WindowsPortableDirectory C:\build\windows\package\portable `
  -WindowsPortableZip C:\build\windows\package\Codlet-0.2.0-preview.6-windows-x64-portable.zip `
  -WindowsMsi C:\build\windows\package\Codlet-0.2.0-preview.6-windows-x64.msi `
  -WindowsMsiManifest C:\build\windows\package\msi.build\distribution-manifest.json `
  -MacDmg C:\build\macos\package\Codlet-0.2.0-preview.6-macos-arm64.dmg `
  -MacDistributionManifest C:\build\macos\package\distribution-manifest.json `
  -MacUpdateZip C:\build\macos\package\Codlet-0.2.0-preview.6-darwin-arm64-legacy-update.zip `
  -LegacyUpdateBridge -WindowsBridgeNodeDirectory C:\build\node-v24.21.0-win-x64 `
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
