[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)
$coreRoot = Split-Path -Parent $PSScriptRoot
$releaseScript = Join-Path $PSScriptRoot 'Publish-PreviewRelease.ps1'
$versionMatch = [regex]::Match([IO.File]::ReadAllText((Join-Path $coreRoot 'Cargo.toml')), '(?m)^version\s*=\s*"([^"]+)"')
if (-not $versionMatch.Success -or $versionMatch.Groups[1].Value -notmatch '-preview\.') { throw 'Test fixture expects a preview package version.' }
$version = $versionMatch.Groups[1].Value
. $releaseScript
$root = Join-Path ($env:SystemDrive.TrimEnd('\') + '\') ('cpr-' + [Guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $root) { throw 'Generated fixture directory already exists.' }
[IO.Directory]::CreateDirectory($root) | Out-Null

function Hash-File([string]$Path) {
    $hash = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $hash.Dispose() }
}

function Write-Json([string]$Path, $Object) {
    [IO.File]::WriteAllText($Path, (($Object | ConvertTo-Json -Depth 20) + "`n"), $utf8)
}

function File-Record([string]$Path, [string]$Relative, [int]$Mode = 420) {
    [ordered]@{ path = $Relative; bytes = [long](Get-Item -LiteralPath $Path).Length; sha256 = Hash-File $Path; mode = $Mode }
}

function Make-Pe([string]$Path, [string]$Label) {
    $bytes = New-Object byte[] 256
    $bytes[0] = 0x4d; $bytes[1] = 0x5a
    [BitConverter]::GetBytes([uint32]128).CopyTo($bytes, 60)
    $bytes[128] = 0x50; $bytes[129] = 0x45; $bytes[130] = 0; $bytes[131] = 0
    [BitConverter]::GetBytes([uint16]0x8664).CopyTo($bytes, 132)
    $labelBytes = $utf8.GetBytes($Label)
    [Array]::Copy($labelBytes, 0, $bytes, 160, $labelBytes.Length)
    [IO.File]::WriteAllBytes($Path, $bytes)
}

function Set-ZipMode($Entry, [int]$Mode) {
    $high = $Mode -bor 0x8000
    $attributeBytes = [byte[]]@(0, 0, ($high -band 255), (($high -shr 8) -band 255))
    $Entry.ExternalAttributes = [BitConverter]::ToInt32($attributeBytes, 0)
}

function Add-ZipFile($Archive, [string]$Name, [string]$Source, [int]$Mode) {
    $entry = $Archive.CreateEntry($Name, [IO.Compression.CompressionLevel]::Optimal)
    $entry.LastWriteTime = [DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
    Set-ZipMode $entry $Mode
    $input = [IO.File]::OpenRead($Source)
    $output = $entry.Open()
    try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
}

$script:mockTagState = $null
$script:mockTagCreateCount = 0
$script:mockTagCreateMode = 'normal'
$script:mockRelease = $null
$script:mockReleaseCreateMode = 'normal'
function Invoke-ReleaseApi([string]$Method, [string]$Path, $Body = $null, [switch]$Missing, [string]$UploadFile) {
    if ($Method -eq 'GET' -and $Path -match '^/repos/owner/repo$') {
        return [pscustomobject]@{ archived = $false; fork = $false }
    }
    if ($Method -eq 'GET' -and $Path -match '/git/ref/tags/') {
        if ($null -eq $script:mockTagState) { return $null }
        return [pscustomobject]@{ object = [pscustomobject]@{ type = 'commit'; sha = $script:mockTagState } }
    }
    if ($Method -eq 'POST' -and $Path -match '/git/refs$') {
        $script:mockTagCreateCount++
        if ($Body.ref -ne 'refs/tags/v0.0.0-preview-fixture' -or $Body.sha -notmatch '^[0-9a-f]{40}$') { throw 'Tag creation request did not contain the exact expected ref and source commit.' }
        if ($script:mockTagCreateMode -eq 'exact-conflict') {
            $script:mockTagState = $Body.sha
            throw 'Synthetic already-created ref response.'
        }
        if ($script:mockTagCreateMode -eq 'wrong-conflict') {
            $script:mockTagState = 'd' * 40
            throw 'Synthetic competing ref response.'
        }
        if ($script:mockTagCreateMode -eq 'fail-without-ref') { throw 'Synthetic failed ref creation.' }
        $script:mockTagState = $Body.sha
        return [pscustomobject]@{ ref = $Body.ref; object = [pscustomobject]@{ type = 'commit'; sha = $Body.sha } }
    }
    if ($Method -eq 'GET' -and $Path -match '/releases\?per_page=') {
        if ($null -eq $script:mockRelease) { return @() }
        return @($script:mockRelease)
    }
    if ($Method -eq 'GET' -and $Path -match '/releases/42/assets\?') { return @() }
    if ($Method -eq 'POST' -and $Path -match '/releases$') {
        $script:mockRelease = [pscustomobject]@{
            id = 42; tag_name = $Body.tag_name; name = $Body.name; body = $Body.body
            draft = [bool]$Body.draft; prerelease = [bool]$Body.prerelease; html_url = 'https://example.invalid/release'
        }
        if ($script:mockReleaseCreateMode -eq 'lost-response-once') {
            $script:mockReleaseCreateMode = 'normal'
            throw 'Synthetic interrupted response after draft creation.'
        }
        return $script:mockRelease
    }
    if ($Method -eq 'PATCH' -and $Path -match '/releases/42$') {
        $script:mockRelease.draft = [bool]$Body.draft
        $script:mockRelease.prerelease = [bool]$Body.prerelease
        return $script:mockRelease
    }
    throw 'Unexpected API call in offline tag test.'
}

function Initialize-GitHubCredential {}

function Assert-OfflineTagCreation {
    $commit = 'c' * 40
    $script:mockTagState = $null
    $script:mockTagCreateCount = 0
    $script:mockTagCreateMode = 'normal'
    $created = Ensure-PreviewTag 'owner/repo' 'v0.0.0-preview-fixture' $commit
    if ($created -ne $commit -or $script:mockTagCreateCount -ne 1) { throw 'Missing release tag was not created at the planned commit.' }

    $repeated = Ensure-PreviewTag 'owner/repo' 'v0.0.0-preview-fixture' $commit
    if ($repeated -ne $commit -or $script:mockTagCreateCount -ne 1) { throw 'Exact existing release tag was not idempotent.' }

    $script:mockTagState = 'd' * 40
    $rejected = $false
    try { $null = Ensure-PreviewTag 'owner/repo' 'v0.0.0-preview-fixture' $commit } catch { $rejected = $true }
    if (-not $rejected -or $script:mockTagCreateCount -ne 1) { throw 'A tag pointing to another commit was not refused without replacement.' }

    $script:mockTagState = $null
    $script:mockTagCreateMode = 'exact-conflict'
    $recovered = Ensure-PreviewTag 'owner/repo' 'v0.0.0-preview-fixture' $commit
    if ($recovered -ne $commit -or $script:mockTagCreateCount -ne 2) { throw 'Interrupted tag creation retry did not accept the exact ref created by the prior attempt.' }

    $script:mockTagState = $null
    $script:mockTagCreateMode = 'wrong-conflict'
    $rejected = $false
    try { $null = Ensure-PreviewTag 'owner/repo' 'v0.0.0-preview-fixture' $commit } catch { $rejected = $true }
    if (-not $rejected) { throw 'A concurrent different-commit tag was not rejected.' }

    $script:mockTagState = $null
    $script:mockTagCreateMode = 'fail-without-ref'
    $rejected = $false
    try { $null = Ensure-PreviewTag 'owner/repo' 'v0.0.0-preview-fixture' $commit } catch { $rejected = $true }
    if (-not $rejected) { throw 'A failed tag creation with no resulting ref was not rejected.' }
}

function Assert-OfflineDraftPublishRecovery {
    $commit = 'c' * 40
    $script:mockTagState = $null
    $script:mockTagCreateCount = 0
    $script:mockTagCreateMode = 'normal'
    $script:mockRelease = $null
    $script:mockReleaseCreateMode = 'lost-response-once'
    $loaded = [pscustomobject]@{
        Plan = [pscustomobject]@{
            repository = 'owner/repo'; tag = 'v0.0.0-preview-fixture'; sourceCommit = $commit
            releaseName = 'Codlet Preview Fixture'; assets = @()
        }
        Notes = 'synthetic immutable notes'
        Root = 'unused'
    }

    $interrupted = $false
    try { $null = Invoke-DraftAction $loaded $true } catch { $interrupted = $true }
    if (-not $interrupted -or $null -eq $script:mockRelease -or $script:mockTagState -ne $commit -or $script:mockTagCreateCount -ne 1) {
        throw 'Synthetic interruption did not leave the exact tag and draft in a recoverable state.'
    }

    $draft = Invoke-DraftAction $loaded $true
    if (-not $draft.draft -or $draft.tag -ne $loaded.Plan.tag -or $script:mockTagCreateCount -ne 1) {
        throw 'PrepareDraft retry did not resume the exact draft without recreating its tag.'
    }
    $published = Invoke-PublishAction $loaded $true
    if ($published.draft -or -not $published.prerelease -or $script:mockRelease.draft -or $script:mockTagState -ne $commit) {
        throw 'The prepared exact-tag draft could not transition to a prerelease publish.'
    }
}

try {
    Assert-OfflineTagCreation
    Assert-OfflineDraftPublishRecovery
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $win = Join-Path $root 'windows'
    $portable = Join-Path $win 'portable'
    $msiBuild = Join-Path $win 'msi-build'
    $mac = Join-Path $root 'macos'
    $outputDirectory = Join-Path $root 'preview-release'
    foreach ($directory in @($portable, $msiBuild, $mac)) { [IO.Directory]::CreateDirectory($directory) | Out-Null }

    Make-Pe (Join-Path $portable 'codlet.exe') 'portable core fixture'
    $nodeDirectory = Join-Path $portable 'runtime/node-v24.21.0-win-x64'
    [IO.Directory]::CreateDirectory($nodeDirectory) | Out-Null
    Make-Pe (Join-Path $nodeDirectory 'node.exe') 'pinned win node fixture'
    [IO.File]::WriteAllText((Join-Path $nodeDirectory 'LICENSE'), 'fixture Node license' + "`n", $utf8)
    $winPin = [ordered]@{
        schema = 1; version = '24.21.0'; platforms = [ordered]@{
            'win-x64' = [ordered]@{
                executableSha256 = Hash-File (Join-Path $nodeDirectory 'node.exe')
                licenseSha256 = Hash-File (Join-Path $nodeDirectory 'LICENSE')
            }
        }
    }
    [IO.Directory]::CreateDirectory((Join-Path $portable 'runtime')) | Out-Null
    Write-Json (Join-Path $portable 'runtime/node-runtime.json') $winPin
    $portablePaths = @('codlet.exe', 'runtime/node-runtime.json', 'runtime/node-v24.21.0-win-x64/node.exe', 'runtime/node-v24.21.0-win-x64/LICENSE')
    $portableRecords = @($portablePaths | ForEach-Object { File-Record (Join-Path $portable $_) $_ })
    $coreCommit = 'a' * 40
    $pluginCommit = 'b' * 40
    $portableManifest = [ordered]@{
        schema = 1; kind = 'codlet-portable-distribution'; version = $version; platform = 'win-x64'
        sourceCommit = $coreCommit; pluginsCommit = $pluginCommit; officialPlugins = @(); files = $portableRecords
    }
    Write-Json (Join-Path $portable 'distribution-manifest.json') $portableManifest
    $portableZip = Join-Path $win ("Codlet-$version-windows-x64-portable.zip")
    [IO.Compression.ZipFile]::CreateFromDirectory($portable, $portableZip, [IO.Compression.CompressionLevel]::Optimal, $false)

    $msiInstallPath = Join-Path $msiBuild 'msi-install.json'
    Write-Json $msiInstallPath ([ordered]@{ schema = 1; kind = 'codlet-msi-install'; version = $version; coreUpgrade = 'Use the next MSI' })
    $msiRecords = @($portableRecords) + @((File-Record $msiInstallPath 'msi-install.json'))
    $msiManifest = [ordered]@{
        schema = 1; kind = 'codlet-msi-distribution'; version = $version; platform = 'win-x64'
        sourceCommit = $coreCommit; pluginsCommit = $pluginCommit; officialPlugins = @(); files = $msiRecords
    }
    $msiManifestPath = Join-Path $msiBuild 'distribution-manifest.json'
    Write-Json $msiManifestPath $msiManifest
    $msiPath = Join-Path $win ("Codlet-$version-windows-x64.msi")
    [IO.File]::WriteAllBytes($msiPath, $utf8.GetBytes('synthetic MSI package fixture' + "`n"))
    Write-Json ($msiPath + '.json') ([ordered]@{ path = $msiPath; version = $version; bytes = [long](Get-Item -LiteralPath $msiPath).Length; sha256 = Hash-File $msiPath })

    $app = Join-Path $mac 'Codlet.app'
    $macNodeVersion = '22.23.2'
    $macNodeRoot = Join-Path $app "Contents/Resources/runtime/node-v$macNodeVersion-darwin-arm64"
    [IO.Directory]::CreateDirectory((Join-Path $app 'Contents/MacOS')) | Out-Null
    [IO.Directory]::CreateDirectory((Join-Path $app 'Contents/Resources/runtime')) | Out-Null
    [IO.Directory]::CreateDirectory((Join-Path $macNodeRoot 'bin')) | Out-Null
    $macNode = Join-Path $macNodeRoot 'bin/node'
    $macLicense = Join-Path $macNodeRoot 'LICENSE'
    [IO.File]::WriteAllBytes($macNode, $utf8.GetBytes('synthetic pinned arm64 node fixture'))
    [IO.File]::WriteAllText($macLicense, 'fixture macOS Node license' + "`n", $utf8)
    $macPin = [ordered]@{
        schema = 1; version = '24.21.0'; platforms = [ordered]@{
            'darwin-arm64' = [ordered]@{
                version = $macNodeVersion
                executableSha256 = Hash-File $macNode
                licenseSha256 = Hash-File $macLicense
            }
        }
    }
    $macPinPath = Join-Path $app 'Contents/Resources/runtime/node-runtime.json'
    Write-Json $macPinPath $macPin
    $codlet = Join-Path $app 'Contents/Resources/codlet'
    $launcher = Join-Path $app 'Contents/MacOS/Codlet'
    [IO.File]::WriteAllBytes($codlet, $utf8.GetBytes('synthetic signed Core executable fixture'))
    [IO.File]::WriteAllBytes($launcher, $utf8.GetBytes('synthetic signed launcher fixture'))

    $fileSpecs = @(
        @{ source = $launcher; relative = 'Contents/MacOS/Codlet'; mode = 493 },
        @{ source = $codlet; relative = 'Contents/Resources/codlet'; mode = 493 },
        @{ source = $macPinPath; relative = 'Contents/Resources/runtime/node-runtime.json'; mode = 420 },
        @{ source = $macLicense; relative = "Contents/Resources/runtime/node-v$macNodeVersion-darwin-arm64/LICENSE"; mode = 420 },
        @{ source = $macNode; relative = "Contents/Resources/runtime/node-v$macNodeVersion-darwin-arm64/bin/node"; mode = 493 }
    )
    $sorter = [Collections.Generic.List[string]]::new()
    foreach ($spec in $fileSpecs) { $sorter.Add($spec.relative) }
    $sorter.Sort([StringComparer]::Ordinal)
    $macRecords = [Collections.Generic.List[object]]::new()
    $updateRecords = [Collections.Generic.List[object]]::new()
    foreach ($relative in $sorter) {
        $spec = $fileSpecs | Where-Object { $_.relative -ceq $relative } | Select-Object -First 1
        $record = File-Record $spec.source $relative $spec.mode
        $macRecords.Add([ordered]@{ path = $record.path; bytes = $record.bytes; sha256 = $record.sha256 })
        $updateRecords.Add([ordered]@{ path = 'Codlet.app/' + $record.path; bytes = $record.bytes; sha256 = $record.sha256; mode = $record.mode })
    }
    $update = [ordered]@{
        schema = 1; kind = 'codlet-runtime-update'; version = $version; platform = 'darwin-arm64'; profile = 'macApp'
        runtime = [ordered]@{ version = $macNodeVersion; executableSha256 = $macPin.platforms.'darwin-arm64'.executableSha256; licenseSha256 = $macPin.platforms.'darwin-arm64'.licenseSha256 }
        files = @($updateRecords.ToArray())
    }
    $updateZipName = "Codlet-$version-darwin-arm64-update.zip"
    $updateZipPath = Join-Path $mac $updateZipName
    $zipFile = [IO.File]::Create($updateZipPath)
    $archive = [IO.Compression.ZipArchive]::new($zipFile, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        foreach ($relative in $sorter) {
            $spec = $fileSpecs | Where-Object { $_.relative -ceq $relative } | Select-Object -First 1
            Add-ZipFile $archive ('Codlet.app/' + $relative) $spec.source $spec.mode
        }
        $updateManifestPath = Join-Path $mac 'runtime-update-manifest.json'
        Write-Json $updateManifestPath $update
        Add-ZipFile $archive 'runtime-update-manifest.json' $updateManifestPath 420
    }
    finally { $archive.Dispose() }

    $dmgName = "Codlet-$version-macos-arm64.dmg"
    $dmgPath = Join-Path $mac $dmgName
    [IO.File]::WriteAllBytes($dmgPath, $utf8.GetBytes('synthetic unsigned DMG fixture' + "`n"))
    $macManifest = [ordered]@{
        schema = 1; kind = 'codlet-macos-preview'; version = $version; platform = 'darwin-arm64'
        sourceCommit = $coreCommit; pluginsSourceCommit = $pluginCommit; appleDeveloperSigned = $false; notarized = $false
        files = @($macRecords.ToArray())
        dmg = [ordered]@{ file = $dmgName; bytes = [long](Get-Item -LiteralPath $dmgPath).Length; sha256 = Hash-File $dmgPath }
        updateZip = [ordered]@{ file = $updateZipName; bytes = [long](Get-Item -LiteralPath $updateZipPath).Length; sha256 = Hash-File $updateZipPath }
    }
    $macManifestPath = Join-Path $mac 'distribution-manifest.json'
    Write-Json $macManifestPath $macManifest

    $arguments = @(
        '-Action', 'Preview', '-Repository', 'baoabaob/codlet',
        '-WindowsPortableDirectory', $portable, '-WindowsPortableZip', $portableZip,
        '-WindowsMsi', $msiPath, '-WindowsMsiManifest', $msiManifestPath,
        '-MacDmg', $dmgPath, '-MacDistributionManifest', $macManifestPath, '-MacUpdateZip', $updateZipPath,
        '-OutputDirectory', $outputDirectory
    )
    $resultText = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $releaseScript @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Preview release fixture was rejected by the publisher.' }
    $report = ($resultText -join "`n") | ConvertFrom-Json
    if ($report.externalWrites -ne $false -or $report.tag -ne ('v' + $version) -or $report.updaterPlatforms.Count -ne 2) { throw 'Preview report has the wrong channel or publication behavior.' }
    $planPath = Join-Path $outputDirectory 'release-plan.json'
    $plan = [IO.File]::ReadAllText($planPath) | ConvertFrom-Json
    $releaseNotes = [IO.File]::ReadAllText((Join-Path $outputDirectory 'release-notes.md'))
    foreach ($expectedText in @('Windows x64 portable ZIP', 'Windows x64 MSI', 'Apple Silicon DMG', 'marketplace', 'traffic hooks', 'runtime updater', 'SHA256SUMS.txt', 'ad-hoc signed', 'not Developer ID signed or notarized', 'known issues')) {
        if ($releaseNotes -notmatch [regex]::Escape($expectedText)) { throw "Release notes omitted expected reader-facing detail: $expectedText" }
    }
    if ($releaseNotes -match '(?m)^\| Asset \|' -or $releaseNotes -match '(?m)^\| ``[^|]+`` \|') { throw 'Release notes duplicate the per-asset hash table instead of directing readers to SHA256SUMS.txt.' }
    $channel = [IO.File]::ReadAllText((Join-Path $outputDirectory 'codlet-update.json')) | ConvertFrom-Json
    if ($plan.version -ne $version -or $plan.prerelease -ne $true -or $channel.channel -ne 'preview' -or $channel.version -ne $version -or $channel.artifacts.Count -ne 2) { throw 'Versioned Preview channel contract is incorrect.' }
    foreach ($artifact in $channel.artifacts) {
        $asset = @($plan.assets | Where-Object { $_.name -eq $artifact.assetName })
        if ($asset.Count -ne 1 -or $asset[0].bytes -ne $artifact.bytes -or $asset[0].sha256 -ne $artifact.sha256) { throw 'Updater manifest does not match the release asset inventory.' }
    }
    $portableChannel = @($channel.artifacts | Where-Object { $_.platform -eq 'win-x64' -and $_.profile -eq 'portable' })
    $macChannel = @($channel.artifacts | Where-Object { $_.platform -eq 'darwin-arm64' -and $_.profile -eq 'macApp' })
    if ($portableChannel.Count -ne 1 -or $macChannel.Count -ne 1) { throw 'Updater platforms/profiles are not the expected Core contract.' }
    foreach ($action in @('PrepareDraft', 'Publish')) {
        $dryResult = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $releaseScript -Action $action -PlanPath $planPath
        if ($LASTEXITCODE -ne 0) { throw "$action dry-run rejected its local plan." }
        $dry = ($dryResult -join "`n") | ConvertFrom-Json
        if ($dry.externalWrites -ne $false -or $dry.applyRequired -ne $true) { throw "$action preview would write externally without -Apply." }
    }
    $tamper = Join-Path $outputDirectory $plan.assets[0].name
    [IO.File]::AppendAllText($tamper, 'tamper')
    $priorErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $null = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $releaseScript -Action PrepareDraft -PlanPath $planPath 2>$null
        $tamperExitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $priorErrorAction }
    if ($tamperExitCode -eq 0) { throw 'Publisher accepted a changed same-version local asset.' }
    [pscustomobject]@{
        schema = 1
        passed = $true
        version = $version
        checks = @(
            'portable package, MSI, Mac DMG, and both updater packages verify against their distribution/build metadata',
            'codlet-update.json contains the updater-supported version/channel/platform/profile and exact asset digests',
            'draft preparation tag creation is exact-commit, idempotent, retryable after interruption, and refuses conflicting refs',
            'synthetic draft creation interruption recovers through PrepareDraft and Publish without remote network access',
            'release notes explain package choices, preview improvements, checksums, and the precise macOS signing status',
            'preview plan remains a prerelease and plan-only draft/publish actions make no external writes',
            'changed same-version local asset is refused'
        )
        externalWrites = $false
    } | ConvertTo-Json -Depth 8
}
finally {
    $resolvedRoot = [IO.Path]::GetFullPath($root)
    $tempPrefix = $env:SystemDrive.TrimEnd('\') + '\cpr-'
    if ($resolvedRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedRoot)) {
        for ($path = $resolvedRoot; $path.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase); $path = [IO.Path]::GetDirectoryName($path)) {
            if (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Test fixture cleanup refused a reparse point.' }
        }
        [IO.Directory]::Delete($resolvedRoot, $true)
    }
}
