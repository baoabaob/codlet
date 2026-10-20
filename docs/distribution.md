# Distribution

Installers contain Codlet with its internal Codex compatibility modules, license/attribution files and SDK types. Windows setup and macOS DMG can include an optional matching GUI package. Node is prepared automatically in Codlet's private runtime cache: Core verifies the official client identity, checks Node's version, platform, APIs and Host flags, then copies and hashes that runtime; otherwise it downloads the pinned fallback. Client build numbers do not gate Node reuse. A system Node installation is not required. Install the official Codex client separately; its application, accounts and conversation databases are not redistributed.

Reusing the official client means copying its verified executable and license into Codlet's own data directory. The original client can then update independently. This reduces installer and repeat-download size, not Node's memory use or the space occupied by the prepared runtime. The cache follows `CODLET_HOME`: installed builds reuse their normal data directory, while each portable installation keeps its own cache. First use needs network access when neither an approved official runtime nor a valid cached copy is available; subsequent use can reuse the verified cache offline.

Fallback downloads first try the unchanged official archive mirrored in Codlet's `node-runtimes` dependency release, then the official Node.js URL. Both sources must match the same archive, executable and license hashes. When changing a Node pin, run the **Publish pinned Node.js runtimes** workflow before publishing installers; it verifies the original archives and never overwrites a same-name asset with different bytes. These dependency archives are kept out of ordinary Codlet release downloads.

The current Windows x64 candidate is [**1.0.0-rc.9**](releases/1.0.0-rc.9/validation.md).
The latest macOS Apple Silicon package remains [**1.0.0-rc.7**](releases/1.0.0-rc.7/validation.md).
The stable updater continues to select published final releases; candidate packages must not replace existing release assets.

`Publish-Release.ps1` requires `-WindowsSetup PATH` and validates the native EXE against its embedded MSI build receipt. The setup EXE is the only Windows installation download. Standalone MSI and portable distribution ZIPs remain internal build inputs and are rejected as public installation assets. `-WindowsOnly` prepares a Windows release without advertising unbuilt macOS artifacts; omitting it requires both Windows and macOS build evidence.

## Windows x64

The recommended Windows installer is the native `-setup.exe`: a WPF window using the .NET Framework already supplied by supported Windows versions, with an embedded MSI. It adds no browser or JavaScript runtime. The single-page installer uses Codlet branding, follows the system light/dark appearance, and provides the real Windows folder picker. It uses Simplified Chinese for Chinese system display languages and English for all other display languages. The localized installer title is at the top; the version stays in the lower-left footer. Installation paths expand environment variables and remain editable. Scrollbars appear only for actual overflow; the scroll container does not take keyboard focus, while controls retain a thin keyboard-focus indicator.

Installation defaults to the current user. Selecting all users chooses Program Files and lets Windows Installer request elevation; the setup window and post-install launcher remain unelevated. The MSI is dual-purpose (`ALLUSERS=2`, `MSIINSTALLPERUSER=1` by default). Shortcuts, installer registration, plugin download choices and optional PATH entries follow the selected scope. Uninstall removes only the PATH entry for its own installation. Open a new terminal after setup to use `codlet`.

An existing installation retains its directory and choices. Switching between user and machine scopes requires uninstalling the other-scope installation first; setup explains this instead of silently creating two conflicting installations. Plugin/config/runtime data remain per user under LocalAppData in either scope. All-users Core/launcher upgrades require the installer; an unelevated runtime cannot replace files in Program Files.

New installations use a Codlet folder and shortcuts. Upgrades retain the registered installation directory, even when its historical name contains Preview. The MSI UpgradeCode, component identities and installer registry keys are retained for upgrade compatibility. `windows-version.mjs` maps stable `major.minor.patch` to MSI `major.minor.(1000 + patch)`: 0.2.0 becomes 0.2.1000, above Preview 29's 0.2.29. Assembly/file metadata remains 0.2.0.0. The builder rejects values outside the Windows Installer field limits.

For major versions from 1, `-rc.N` uses MSI build `500 + N`, below stable build 1000 and above previews 0–499. Stable file metadata uses fourth field 1000, so 1.0.0-rc.1 (`1.0.0.501`) upgrades to 1.0.0 (`1.0.0.1000`). Historical 0.x mappings remain unchanged.

The installer offers the optional GUI and shortcut choices. UI/Desktop capabilities ship inside Core and have no separate download or feature selection. Historical adapter choices and registrations remain saved for migration but cannot load duplicate providers; removing an old registration preserves Core's capabilities and user data. The completion page can launch Codlet. The native `Codlet-Launcher.exe` is the normal entrypoint; internal PowerShell helpers remain implementation details. Windows Installer continues to manage upgrade, repair, and uninstall through the embedded MSI payload.

Installed builds use `%LOCALAPPDATA%/Codlet`. Existing portable installations retain their `data/` directory and runtime update channel; new Windows installation downloads use the setup EXE. Neither redirects official Codex data. Run setup again to add an omitted GUI component. `Codlet-Launcher.exe --configure` revisits first-launch choices for available components; ordinary launches do not reinstall removed plugins, and existing disabled states/grants are preserved.

The first migration from the previous executable requires a new start. After migration, verified compatible JavaScript module updates can preserve the Native process, backend connections and streams while reloading plugins with explicit state. Incompatible resident changes are staged for natural exit and the next start. See [online update](core-online-update.md) for the precise component boundary and evidence; an installed MSI still retains Windows Installer's ownership of executable replacement.

Run a newer setup EXE to upgrade an installed Windows version, including earlier direct MSI installations. Existing portable in-app runtime updates replace Core and its runtime descriptor, reusing an already prepared compatible Node; preparing a missing runtime must succeed before replacement. Those updater ZIPs are compatibility payloads rather than installation downloads. Official plugins have their own GitHub update channels.

`official-plugins.json` records selectable IDs, pinned repository identities and initial
permission expectations. Windows MSI's GUI feature owns `optional-plugins/` and its selection
registry value. With GUI selected, first launch uses `plugin seed preview/install` against
the bundled catalog. Every file is verified before replacement. A receipt and transaction
journal protect the installed copy and record its GitHub update channel.

Setup upgrades an older GUI only when its complete installer receipt or Core-managed GitHub
receipt still verifies, including repository/owner identities. Equal or newer versions are
kept. Custom and modified sources are preserved. Enabled state, revoked permissions and
broker scopes survive the transition; only previewed new permissions can be granted.
Interrupted replacement rolls back before commit or finishes cleanup after commit. Ordinary
launches do not reinstall a plugin the user removed. The GUI remains an ordinary plugin.

Packages built without a GUI bundle use `plugin github preview/install` to download the
latest stable GUI. They verify the manifest, repository identity and upstream archive digest.
Read/download failures retry once; unfinished choices remain pending for the next launch.

Normal launch uses verified local plugin packages immediately. Once the runtime is ready,
`checkPluginUpdatesOnStartup` starts one background check of registered static update
manifests. Successful results persist for six hours across restarts; manual refresh still
honors the minimum interval and server retry times. A failed refresh retains the last
verified result and its timestamp. A failed check retains the local packages.
Installing a discovered update uses the regular managed-install transaction, including
permission and source checks. Safe mode skips background checks. Windows shows runtime
preparation stages and actual download progress while Core is preparing the session.

All newly published plugins follow the [signed update manifest contract](spec/plugin-updates.md).
The ZIP carries `codlet-update.json`; each Release carries `codlet-updates.json`.
The shared publisher tool generates the signature and archive identity. Installer bundles
preserve the same per-plugin public key and feed address in their file-verified receipts.
Fixture signing keys cannot enter a shipping distribution.

The shared native process gate runs before MSI validates or changes installation files. It identifies relevant installed clients, shows their identity, and asks the user to save and quit them. Its only actions are check again and cancel. Neither the installer nor the launcher's gate sends a close request. Restart Manager automatic shutdown is disabled. An unattended busy install fails explicitly.

After a successful full interactive uninstall, a separate optional dialog offers to keep or remove the current user's default Codlet data. Keeping data is the default; deletion needs a checked consent box and a separate click. Upgrade, repair, cancellation, failed uninstall, quiet/basic-UI uninstall and SYSTEM execution cannot run cleanup. This option is Windows-only.

The dialog lists the exact whitelist under the invoking user's `%LOCALAPPDATA%/Codlet`: configuration/preferences/compatibility metadata, `.plugin-update-cache`, downloaded `packages`, `config.json.plugin-services` (plugin storage), `js-runtimes`, `runtime-skills`, setup state and logs. When the original `config.json` is present, cleanup also removes only generic Windows credentials under the matching `Codlet/<canonical-registry-hash>/` namespace. Missing configuration leaves unidentifiable credentials untouched. No credential values are displayed. Active runtime locks prevent cleanup before any deletion; busy or read-only entries are retained and reported.

Official Codex accounts, chats and settings, other Windows users, portable or custom `CODLET_HOME` directories, external plugin source projects, unknown files and directory links are retained. Cleanup never follows plugin registrations into source directories. Directory handles pin ordinary ancestors during traversal; junctions/reparse points are refused or left in place. This deliberately limited cleanup is not a general filesystem cleaner. MSI removes its own application files, shortcuts and PATH registration independently.

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
  -GuiBundleDirectory C:\build\gui-bundle -GuiSourceCommit FULL_GUI_SHA `
  -OutputDirectory C:\output\codlet-0.2.0
node scripts/build-msi.mjs C:\output\codlet-0.2.0 C:\tools\wix-3.14.1 C:\output\Codlet-0.2.0.msi
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Build-WindowsInstaller.ps1 `
  -MsiPath C:\output\Codlet-0.2.0.msi -OutputPath C:\output\Codlet-0.2.0-setup.exe `
  -Version 0.2.0
```

Prepare `gui-bundle` with `node scripts/package.mjs --output C:\build\gui-bundle` in the GUI source repository. WiX 3.14.1 builds the MSI; the system .NET Framework compiler builds the launcher. The distribution manifest records both source revisions, the GUI version and every payload file's SHA-256. MSI creation rejects a distribution without its GUI package.

Use `Test-DistributionEncoding.ps1` for Windows PowerShell/encoding checks and `Test-WindowsInstaller.ps1` for controlled process and MSI preflight scenarios. `Test-NativeInstaller.ps1` renders the actual native UI in both languages, validates feature/scope/path commands, and exercises real MSI record progress/cancellation without installing. Fixture builds cannot install. `Test-MsiDistribution.ps1 -StructureOnly` inspects tables, scopes, PATH components and features without changing the user's installation. Never deliver fixture or stale-Core packages used by these tests.

The native shell uses [MSI's external UI record handler](https://learn.microsoft.com/en-us/windows/win32/api/msi/nf-msi-msisetexternaluirecord) and `NONE | UACONLY` so it suppresses the old wizard while retaining the system elevation prompt. Scope handling follows [Microsoft's single-package authoring contract](https://learn.microsoft.com/en-us/windows/win32/msi/single-package-authoring). MSI log files remain under `%LOCALAPPDATA%\Codlet\installer-logs`. Cancelling requests MSI rollback, never terminates the Windows Installer process. `Test-UserDataCleanup.ps1` exercises consent, active-scope refusal, exact credential scoping, unknown files and junction boundaries using disposable fixture data.

## macOS Apple Silicon

Open the DMG and drag `Codlet.app` to Applications. The native Swift launcher offers optional official plugins and a Desktop shortcut on first use. Later explicit configuration starts with no plugin selected, so removed plugins stay removed. Existing registrations, grants, and disabled states are preserved.

The launcher asks the user to save and quit a recognized running Codex client, then offers check again or cancel. It does not request or force client closure during startup. Normal startup does not repeatedly run initialization.

```sh
sh scripts/build-macos.sh release
python3 scripts/build-macos-distribution.py \
  --executable target/aarch64-apple-darwin/release/codlet \
  --node-directory target/aarch64-apple-darwin/release/runtime/node-v22.23.2-darwin-arm64 \
  --source-commit FULL_CORE_SHA \
  --output /absolute/new/output
```

The `Build macOS distribution` workflow accepts a full Core commit SHA and an optional `gui_commit` from `codlet-plugins`. With the GUI selected it builds that independent revision and includes a hash-checked bundle; Core-only builds need no plugin checkout. The native ARM64 runner checks Swift, Rust, the current reviewed Native Node, signed update/rollback, mounted DMG initialization and provenance. For local bundled builds pass `--gui-bundle-directory` and `--gui-source-commit`. Pass `--verify-online-plugins` only for additional live GitHub installation acceptance; this requires public API quota and is recorded as `pluginDownloadsVerified`.

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
