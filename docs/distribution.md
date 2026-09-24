# Distribution

Preview installers contain Codlet, license/attribution files, SDK types, and explicitly selected optional official-plugin packages. Node is prepared automatically in Codlet's private runtime cache: Core can reuse an exactly verified Node executable from a supported official client, or download and verify the pinned fallback. A system Node installation is not required. Install the official Codex client separately; its application, accounts and conversation databases are not redistributed.

Reusing the official client means copying its verified executable and license into Codlet's own data directory. The original client can then update independently. This reduces installer and repeat-download size, not Node's memory use or the space occupied by the prepared runtime. The cache follows `CODLET_HOME`: installed builds reuse their normal data directory, while each portable installation keeps its own cache. First use needs network access when neither an approved official runtime nor a valid cached copy is available; subsequent use can reuse the verified cache offline.

Fallback downloads first try the unchanged official archive mirrored in Codlet's `node-runtimes` dependency release, then the official Node.js URL. Both sources must match the same archive, executable and license hashes. When changing a Node pin, run the **Publish pinned Node.js runtimes** workflow before publishing installers; it verifies the original archives and never overwrites a same-name asset with different bytes. These dependency archives are kept out of ordinary Codlet release downloads.

The source and independent official-plugin repositories are public. Preview binaries are published as versioned test assets after validation. Building a local Preview does not publish its files; the installed preview channel discovers published prereleases from the Core repository.

## Windows x64

The MSI installs per user. Its feature page offers the GUI, UI Adapter, Desktop Adapter, and shortcut options. The GUI requires UI Adapter; Desktop Adapter is independently optional. The completion page can launch Codlet. The native `Codlet-Launcher.exe` is the normal entrypoint; internal PowerShell helpers remain implementation details.

The portable ZIP must be extracted completely to a writable location. Its first run offers the same plugin choices and stores Codlet data in `data/`. Installed MSI builds use `%LOCALAPPDATA%/Codlet`. Neither redirects official Codex data. `Codlet-Launcher.exe --configure` can add omitted plugins later; ordinary launches do not reinstall removed plugins, and existing disabled states/grants are preserved.

Windows in-app runtime updates replace Core and its runtime descriptor. An already prepared compatible Node is reused; preparing a missing runtime must succeed before the installation is replaced. Install a newer MSI or extract a new portable package when upgrading the native launcher or installer components. Official plugins have their own GitHub update channels.

An installer's `catalog.json` may bind each package to an `updateSource` containing its GitHub repository URL, numeric repository/owner identities, and ZIP asset name template. Seed receipts retain this channel separately from download provenance. Verified seeds participate in normal check, individual update, and update-all flows while remaining `source=local`, `ownership=installer-seed`. Their first downloaded update is an explicit managed **adopt** review; only a real checked GitHub download creates managed GitHub provenance. Core does not maintain an official repository allowlist or infer channels from names/authors.

Old receipts remain valid. If they lack a channel, Core can read the catalog beside its executable only after verifying the old seed's complete receipt/historical file set and the catalog's current payload. Check operations do not rewrite registration or receipts. A changed file, channel identity, registration, or grant invalidates cached findings and prepared adoption reviews. New permissions/dependency contracts require review; entry-shape changes require stopping and restarting instead of an automatic hot update. Existing disabled states, grants and all broker scopes are preserved.

The shared native process gate runs before MSI validates or changes installation files. It identifies relevant installed clients, shows their identity, requests normal close with a bounded wait, and offers retry/cancel. Restart Manager automatic shutdown is disabled; no client is force-killed. An unattended busy install fails explicitly. Uninstall removes program files/shortcuts and preserves plugin/config/data.

An updated installer offers explicit official-plugin updates. The Core verifies the complete old file set against its installer receipt or embedded hashes from the previously distributed Preview 1–4 packages, then updates the fixed `packages/<plugin-id>` directory while holding the offline registry and launch leases. Added, changed, linked, or custom-source files are preserved and reported as unverified (20). Existing disabled states, revoked permissions, and all broker scopes are retained; genuinely new permissions require a separate approval. Ordinary startup never reinstalls a removed plugin.

One local journal coordinates staged bytes, the registry, and the receipt. Startup and offline CLI recover interrupted operations before loading packages. Temporary ready/backup directories are removed after commit; no historical package store remains. Sources remain local registrations, never synthetic GitHub installations. A running Host must first finish and exit normally before this offline transaction can run.

The catalog completion marker is saved only after a successful explicit setup (or the first Windows setup). Accepting the update prompt, a failed update, or an ordinary launch does not dismiss a pending update. Older markers written before completion are rechecked. If an update fails, an older UI Adapter can remain incompatible with the current client and the GUI may be unavailable; the launcher explains this instead of treating a Core-only launch as a successful plugin upgrade.

`legacy-official-transitions.json` lists two complete historical UI/GUI file sets: official 0.1.1 runtime files with the retained official 0.1.0 README. Both catalog origins are recorded and checked against the original legacy records. This does not allow arbitrary combinations of versions or skip README/extra-file validation.

The installer uses `codlet plugin seed preview <catalog.json> <id> --json` and binds `seed install` to its returned `--preview` digest plus one `--grant` per approved new permission. Direct PowerShell callers can pass `-ApproveNewPermissions`; macOS command-line callers use `--approve-new-permission=<permission>`. Missing approval fails before writes. `scripts/record-legacy-seeds.mjs` regenerates the embedded historical hash list only from prior distributions whose catalog and payload hashes match their distribution manifests; it copies no plugin payloads.

Build the official plugin repository's `dist/` independently, then assemble from reviewed inputs:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Build-PreviewDistribution.ps1 `
  -CodletExecutable C:\build\codlet.exe `
  -PluginDistribution C:\src\codlet-plugins\dist `
  -SourceCommit FULL_CORE_SHA -PluginsCommit FULL_PLUGIN_SHA `
  -OutputDirectory C:\output\codlet-preview -Zip
node scripts/build-msi.mjs C:\output\codlet-preview C:\tools\wix-3.14.1 C:\output\Codlet-Preview.msi
```

WiX 3.14.1 builds the MSI; the system .NET Framework compiler builds the launcher. The runtime descriptor and plugin catalog files are verified before assembly. The manifest records distributed files and SHA-256 values. Offline plugin presets are local registrations; their independent GitHub release channels are recorded without inventing remote installation receipts.

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
