# Windows release delivery

Build from a committed checkout with the pinned toolchain and a verified GUI bundle:

```powershell
./scripts/Build-WindowsRelease.ps1 `
  -OutputDirectory <fresh-output> `
  -ToolchainRoot <toolchain-root> `
  -WixDirectory <wix-3-directory> `
  -GuiBundleDirectory <signed-gui-bundle> `
  -GuiSourceCommit <full-gui-commit> `
  -Channel preview `
  -OnlineBaseDirectories <recorded-prior-distribution> `
  -OnlineModuleIds core-ui-provider
```

The command compiles Core once, packages the MSI and native setup, and prepares a local release plan. `build-result.json` records the source revision and executable digest. The release directory includes the setup, complete runtime ZIP, each statically compatible base-specific online ZIP, schema 1 and schema 2 catalogs, and checksums. Incompatible bases appear with their reason in `release-plan.json`; they produce no online asset. Online packages currently preserve resident files for validation, so their ZIP size is not a binary delta.

`Publish-Release.ps1 -Action PrepareDraft -PlanPath <plan>` and `-Action Publish` validate locally by default. External writes require `-Apply`. Preview versions retain their prerelease flag. A schema 1 client continues to receive complete packages; installing the new Core once enables schema 2 selection. An MSI-owned installation can activate compatible JavaScript online, but complete file replacement remains owned by Windows Installer.

## Installer behavior

The native setup queries Windows Installer registrations and feature states. An upgrade shows the installed and target versions and keeps the registered directory, user/machine scope and feature selections. Existing installations cannot silently move directories or scopes. Registration remains authoritative when the executable is missing. Multiple registrations block installation with a repair instruction.

The same ProductCode/version enters maintenance and repairs selected features with `REINSTALLMODE=vamus`; removed features remain removed. Older same-version packages with a different ProductCode use the MSI major-upgrade path. A lower MSI numeric version is blocked. Product codes are deterministic for each package version. User data and downloaded plugins remain outside the application MSI components.

## Timing and component audit

Setup writes `<MSI-log>.timing.jsonl` beside its normal log under `%LOCALAPPDATA%/Codlet/installer-logs`. It records monotonic payload extraction/checksum, MSI transaction and action-start timestamps, cancellation and exit status. Analyze a file with:

```text
node scripts/analyze-install-timing.mjs TIMING.jsonl FRESH_REPORT.json
powershell -File scripts/Inspect-MsiUpgrade.ps1 -BaselineMsi OLD.msi -CandidateMsi NEW.msi -OutputPath FRESH_AUDIT.json
```

Action intervals extend until the next action starts. Nested old-product removal is included; intervals are not exclusive CPU or file-copy time. Compare the actual File, MsiFileHash and Component tables before changing upgrade sequencing.

The 2026-10-21 QEMU TCG baseline measured rc.8 installation at 43.802 seconds and rc.8 → rc.10 upgrade at 71.601 seconds. The upgrade's observed InstallFiles interval was 4.426 seconds and RemoveFiles interval 4.083 seconds; InstallValidate was 12.198 seconds. Both operations preserved user data and the chosen directory/scope/features. Software emulation makes these unsuitable as desktop performance estimates.

The baseline packages share 46 stable component definitions and 27 identical hashed files totaling 986,730 bytes. The candidate has 39 unversioned files, including Core. This release keeps `MajorUpgrade Schedule="afterInstallInitialize"`: unchanged components have stable identities, but they are still removed and reinstalled during a major upgrade. Late removal and cross-version component reuse are deferred until the replacement policy handles changed unversioned files, modified destination timestamps and missing components. Managed Node caches already survive MSI upgrades and are reused.

Windows Installer can preserve an unversioned destination whose modification time indicates user changes. Moving removal after InstallExecute also requires consistent component reference counts. See [Microsoft file versioning rules](https://learn.microsoft.com/en-us/windows/win32/msi/file-versioning-rules), [file hash reuse](https://learn.microsoft.com/en-us/windows/win32/msi/default-file-versioning), and [WiX major upgrade scheduling](https://docs.firegiant.com/wix/schema/wxs/majorupgrade/).

## Verification

Run `Test-Release.ps1`, `Test-NativeInstaller.ps1`, `node --test tests/online_release.test.mjs tests/runtime_online_package.test.mjs`, and the Rust `runtime_update::` tests. The installer self-test covers upgrade choices, maintenance, downgrade, duplicate registrations, Chinese/English rendering and actual-window layout without installing software.

`Build-InstallerAcceptance.ps1` builds an MSI driver using the production session and registration code. Its mutation mode is restricted to the disposable VM model `CodletNativeAcceptanceVM` and `C:\CodletLab` paths. It records real cancellation and rollback without killing Windows Installer. Verify installed product/feature state, application hashes and user data after every case; retain MSI logs and timing files separately from temporary runtime copies.

Static compatibility, IPC/component handoff tests, actual Native hot activation and actual MSI upgrade are separate evidence. The current resident rc.8 passes the static bridge/bootstrap and file checks for this Native JS change; its old published schema 1 channel has not activated the local candidate. The delivery report records the actual execution results.
