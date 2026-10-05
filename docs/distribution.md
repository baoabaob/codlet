# Distribution

Installers contain Codlet, license/attribution files, SDK types, and plugin download options. They contain no plugin code or fixed plugin versions. Node is prepared automatically in Codlet's private runtime cache: Core can reuse an exactly verified Node executable from a supported official client, or download and verify the pinned fallback. A system Node installation is not required. Install the official Codex client separately; its application, accounts and conversation databases are not redistributed.

Reusing the official client means copying its verified executable and license into Codlet's own data directory. The original client can then update independently. This reduces installer and repeat-download size, not Node's memory use or the space occupied by the prepared runtime. The cache follows `CODLET_HOME`: installed builds reuse their normal data directory, while each portable installation keeps its own cache. First use needs network access when neither an approved official runtime nor a valid cached copy is available; subsequent use can reuse the verified cache offline.

Fallback downloads first try the unchanged official archive mirrored in Codlet's `node-runtimes` dependency release, then the official Node.js URL. Both sources must match the same archive, executable and license hashes. When changing a Node pin, run the **Publish pinned Node.js runtimes** workflow before publishing installers; it verifies the original archives and never overwrites a same-name asset with different bytes. These dependency archives are kept out of ordinary Codlet release downloads.

The source and independent official-plugin repositories are public. Version 0.2.0 is the first stable release candidate; publication is pending the [readiness checklist](release-readiness.md). Old Core Preview releases and tags have been removed. Building and preparing a release plan do not publish files. The stable updater selects published final releases.

`Publish-Release.ps1` requires `-WindowsSetup PATH` and validates the native EXE against its embedded MSI build receipt. The setup EXE is the only Windows installation download. Standalone MSI and portable distribution ZIPs remain internal build inputs and are rejected as public installation assets. `-WindowsOnly` prepares a Windows release without advertising unbuilt macOS artifacts; omitting it requires both Windows and macOS build evidence.

## Windows x64

The recommended Windows installer is the native `-setup.exe`: a WPF window using the .NET Framework already supplied by supported Windows versions, with an embedded MSI. It adds no browser or JavaScript runtime. The single-page installer uses Codlet branding, follows the system light/dark appearance, and provides the real Windows folder picker. It uses Simplified Chinese for Chinese system display languages and English for all other display languages. The localized installer title is at the top; the version stays in the lower-left footer. Installation paths expand environment variables and remain editable. Scrollbars appear only for actual overflow; the scroll container does not take keyboard focus, while controls retain a thin keyboard-focus indicator.

Installation defaults to the current user. Selecting all users chooses Program Files and lets Windows Installer request elevation; the setup window and post-install launcher remain unelevated. The MSI is dual-purpose (`ALLUSERS=2`, `MSIINSTALLPERUSER=1` by default). Shortcuts, installer registration, plugin download choices and optional PATH entries follow the selected scope. Uninstall removes only the PATH entry for its own installation. Open a new terminal after setup to use `codlet`.

An existing installation retains its directory and choices. Switching between user and machine scopes requires uninstalling the other-scope installation first; setup explains this instead of silently creating two conflicting installations. Plugin/config/runtime data remain per user under LocalAppData in either scope. All-users Core/launcher upgrades require the installer; an unelevated runtime cannot replace files in Program Files.

New installations use a Codlet folder and shortcuts. Upgrades retain the registered installation directory, even when its historical name contains Preview. The MSI UpgradeCode, component identities and installer registry keys are retained for upgrade compatibility. `windows-version.mjs` maps stable `major.minor.patch` to MSI `major.minor.(1000 + patch)`: 0.2.0 becomes 0.2.1000, above Preview 29's 0.2.29. Assembly/file metadata remains 0.2.0.0. The builder rejects values outside the Windows Installer field limits.

The installer offers GUI, UI Adapter, Desktop Adapter, and shortcut options. GUI requires UI Adapter; Desktop Adapter is independently optional. The completion page can launch Codlet. The native `Codlet-Launcher.exe` is the normal entrypoint; internal PowerShell helpers remain implementation details. Windows Installer continues to manage upgrade, repair, and uninstall through the embedded MSI payload.

Installed builds use `%LOCALAPPDATA%/Codlet`. Existing portable installations retain their `data/` directory and runtime update channel; new Windows installation downloads use the setup EXE. Neither redirects official Codex data. `Codlet-Launcher.exe --configure` can add omitted plugins later; ordinary launches do not reinstall removed plugins, and existing disabled states/grants are preserved.

Run a newer setup EXE to upgrade an installed Windows version, including earlier direct MSI installations. Existing portable in-app runtime updates replace Core and its runtime descriptor, reusing an already prepared compatible Node; preparing a missing runtime must succeed before replacement. Those updater ZIPs are compatibility payloads rather than installation downloads. Official plugins have their own GitHub update channels.

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
blindly replayed. Setup does not overwrite existing registrations or revive removed
plugins. Before the first normal launch of a changed Core/client version, Core refreshes
already-installed official download channels through the regular GitHub preparation and
managed-install transactions. This also runs before the Codlet-owned official-update restart.
Successful checks are cached across ordinary launches. The network budget is 30 seconds;
failed checks retain installed packages, record diagnostics and retry on a later launch
after a five-minute cooldown. Safe mode skips this maintenance.

Earlier releases installed local seeds. Startup can migrate an unmodified seed to its pinned
official GitHub channel after verifying the complete receipt/file set and repository/owner
numeric identities. Downloads must pass the upstream digest check. Existing grants, broker
scopes and enabled preferences are retained; new authority or dependency-contract changes
require review. Custom or modified directories are skipped. Legacy seed commands remain
migration support. Core has no runtime dependency on these plugins and grants them no
special capabilities.

The shared native process gate runs before MSI validates or changes installation files. It identifies relevant installed clients, shows their identity, requests normal close with a bounded wait, and offers retry/cancel. Restart Manager automatic shutdown is disabled; no client is force-killed. An unattended busy install fails explicitly. Uninstall removes program files/shortcuts and preserves plugin/config/data.

The Windows launcher retains the exact native Core process handle so early exits
preserve their actual exit code and log, even if Core exits before the first poll.
If Core exits before readiness, interactive startup offers one safe-mode attempt
after the normal process gate. `Codlet-Launcher.exe --safe-mode` also starts this
recovery path directly, skipping plugin setup and all plugins (including traffic
interceptors), without changing saved configuration. Quiet startup never silently
retries without plugins. A readiness timeout retains the running process and does
not start another instance. Logs are in the Codlet data directory's `launcher-logs`;
recovery uses a separate `.safe.core.log` so the original failure is retained.
Ordinary and safe Windows launches also supply valid standard handles to the
official child, retain at most the first 64 KiB of its startup stderr, and report
that output on an early failure. Private inspector endpoint lines are omitted.
The buffer is released at normal readiness, or after 30 seconds in safe mode;
later stderr is drained and discarded. The launcher logs also record the actual
owned process's package identity, separately from the discovered package version.

On Windows, unavailable renderer discovery is reported as
`renderer_executor_unavailable`; Core and a still-running official client remain
available even for a renderer-only plugin configuration. The launcher reports that
UI plugins did not load. An official process that itself exits is still a startup
failure. Core isolates optional launch-adapter incompatibility by suspending
its startup providers, interception consumers and dependents for the current
launch. Required interception is never reported active when its source failed;
the remaining plugins and original client can still run with preserved preferences.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Build-Distribution.ps1 `
  -CodletExecutable C:\build\codlet.exe `
  -SourceCommit FULL_CORE_SHA `
  -OutputDirectory C:\output\codlet-0.2.0
node scripts/build-msi.mjs C:\output\codlet-0.2.0 C:\tools\wix-3.14.1 C:\output\Codlet-0.2.0.msi
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Build-WindowsInstaller.ps1 `
  -MsiPath C:\output\Codlet-0.2.0.msi -OutputPath C:\output\Codlet-0.2.0-setup.exe `
  -Version 0.2.0
```

WiX 3.14.1 builds the MSI; the system .NET Framework compiler builds the launcher. The manifest records Core's source revision, distributed files and SHA-256 values. Plugin source commits and package hashes belong to the independently downloaded releases, not to Core's build.

Use `Test-DistributionEncoding.ps1` for Windows PowerShell/encoding checks and `Test-WindowsInstaller.ps1` for controlled process and MSI preflight scenarios. `Test-NativeInstaller.ps1` renders the actual native UI in both languages, validates feature/scope/path commands, and exercises real MSI record progress/cancellation without installing. Fixture builds cannot install. `Test-MsiDistribution.ps1 -StructureOnly` inspects tables, scopes, PATH components and features without changing the user's installation. Never deliver fixture or stale-Core packages used by these tests.

The native shell uses [MSI's external UI record handler](https://learn.microsoft.com/en-us/windows/win32/api/msi/nf-msi-msisetexternaluirecord) and `NONE | UACONLY` so it suppresses the old wizard while retaining the system elevation prompt. Scope handling follows [Microsoft's single-package authoring contract](https://learn.microsoft.com/en-us/windows/win32/msi/single-package-authoring). MSI log files remain under `%LOCALAPPDATA%\Codlet\installer-logs`. Cancelling requests MSI rollback, never terminates the Windows Installer process. Native normal-close requests remain bounded and do not force-kill clients.

## macOS Apple Silicon

Open the DMG and drag `Codlet.app` to Applications. The native Swift launcher offers optional official plugins and a Desktop shortcut on first use. Later explicit configuration starts with no plugin selected, so removed plugins stay removed. Existing registrations, grants, and disabled states are preserved.

The launcher requests normal quit of a recognized running Codex client, waits at most 15 seconds, and permits cancellation. It does not force-kill the client. Normal startup does not repeatedly run initialization.

```sh
sh scripts/build-macos.sh release
python3 scripts/build-macos-distribution.py \
  --executable target/aarch64-apple-darwin/release/codlet \
  --node-directory target/aarch64-apple-darwin/release/runtime/node-v22.23.2-darwin-arm64 \
  --source-commit FULL_CORE_SHA \
  --output /absolute/new/output
```

The `Build macOS distribution` workflow accepts one full Core commit SHA. It checks out only Core, verifies the ARM64 runner, builds Core/Swift, tests Core-only initialization in an isolated Codlet home, mounts the DMG and uploads artifacts with Core provenance. Building Core does not check out or build the plugin repository. Pass `--verify-online-plugins` for additional real GitHub installation acceptance; this requires public API quota and is recorded separately as `pluginDownloadsVerified`. Plugin service availability does not gate a Core-only build.

Current Mac signing is ad-hoc integrity signing. Developer ID signing, notarization, and real Mac desktop acceptance are separate release gates. A successful mount/build alone does not satisfy them.

## Licensing and release checks

Ship root `LICENSE` (Apache-2.0), `NOTICE`, third-party UI and Rust notices, and each optional plugin's license/notice. The prepared Node executable and its verified license are kept together in the runtime cache. A bundled transition update also carries that license. Third-party plugins keep their author's actual licenses and are not automatically relicensed to Apache-2.0.

Before delivery, verify source revisions, package version, architecture, file hashes, installed/portable data scope, cancellation, existing data, optional components, and shortcuts. Record remaining limitations in [known issues](known-issues.md) and complete the [release gates](release-readiness.md). A build does not establish signing or real-client installation acceptance on each platform.

## Preparing the stable release

`scripts/Publish-Release.ps1` consumes the Windows payload directory, internal MSI with its build receipt and distribution manifest, and the setup EXE with its receipt. A portable ZIP is optional validation input. Combined releases also require the macOS DMG, distribution manifest, and updater ZIP. The script verifies final versions, source revisions, payload hashes, installer receipts, and updater contents, then writes a fresh release directory with assets, checksums, release notes, and `release-plan.json`. Build-time distribution manifests and the setup receipt stay in `.verification` and are checked again when reading the plan. The default `Plan` action creates no remote state. Stable plans and GitHub releases have `prerelease: false`.

The generated `codlet-update-managed.json` uses `schema: 1`, `kind: "codlet-runtime-channel"`, `channel: "stable"`, `version`, and an artifact per selected platform/profile. Each artifact pins its update ZIP using `platform`, `profile`, `bytes`, `sha256`, and `assetName`. Update ZIPs retain `runtime-update-manifest.json` at their root. A Windows-only release has four public assets: setup EXE, runtime update ZIP for existing portable installations, channel manifest, and `SHA256SUMS.txt`. A combined release adds the Mac DMG and updater ZIP. Only setup EXE is linked as a Windows installation download.

Old Preview users should upgrade with the new installer when published. New Core promotes only its known built-in Preview channel files to the stable managed channel; it leaves custom channels alone. Historical transition payload support remains in the low-level packaging fixtures but is not the 0.2.0 delivery path.

Use a new output directory and pass the explicit package paths from the build artifacts:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Publish-Release.ps1 `
  -Action Plan -WindowsOnly `
  -WindowsPortableDirectory C:\build\windows\package\portable `
  -WindowsMsi C:\build\windows\package\Codlet-0.2.0-windows-x64.msi `
  -WindowsMsiManifest C:\build\windows\package\msi.build\distribution-manifest.json `
  -WindowsSetup C:\build\windows\package\Codlet-0.2.0-windows-x64-setup.exe `
  -OutputDirectory C:\build\release-0.2.0
```

Inspect `release-plan.json`, `release-notes.md`, and the asset hashes before preparing a draft. `PrepareDraft` and `Publish` without `-Apply` only validate the local plan and print the intended action. Draft upload is explicit and separate from publication:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Publish-Release.ps1 `
  -Action PrepareDraft -PlanPath C:\build\release-0.2.0\release-plan.json -Apply

# Publish only after reviewing the complete GitHub draft and its uploaded assets.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Publish-Release.ps1 `
  -Action Publish -PlanPath C:\build\release-0.2.0\release-plan.json -Apply
```

The publisher accepts `CODLET_CORE_RELEASE_TOKEN`, `GH_TOKEN`, or a Git Credential Manager credential without printing it. It never changes repository visibility. A version tag or same-version release with different notes, metadata, or assets is rejected; existing assets are never overwritten. Run `scripts/Test-Release.ps1` for an isolated packaging/manifest contract test with synthetic inputs and no GitHub writes.
