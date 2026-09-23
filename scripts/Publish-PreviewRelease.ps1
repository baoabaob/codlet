[CmdletBinding()]
param(
    [ValidateSet('Preview', 'PrepareDraft', 'Publish')][string]$Action = 'Preview',
    [string]$WindowsPortableDirectory,
    [string]$WindowsPortableZip,
    [string]$WindowsMsi,
    [string]$WindowsMsiManifest,
    [string]$MacDmg,
    [string]$MacDistributionManifest,
    [string]$MacUpdateZip,
    [string]$OutputDirectory,
    [string]$PlanPath,
    [string]$Repository = 'baoabaob/codlet',
    [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:utf8 = [Text.UTF8Encoding]::new($false)
$script:token = $null
$script:assetLimit = [long]2147483647

function Fail([string]$Message) { throw $Message }

function Get-Absolute([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { Fail 'A required path is empty.' }
    [IO.Path]::GetFullPath($Value).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Assert-NoReparseAncestor([string]$Value) {
    $path = Get-Absolute $Value
    for ($current = $path; $current; $current = [IO.Path]::GetDirectoryName($current)) {
        if (Test-Path -LiteralPath $current) {
            if (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                Fail "Reparse paths are not accepted: $current"
            }
        }
    }
    $path
}

function Assert-PlainPath([string]$Value, [bool]$Directory = $false) {
    $path = Assert-NoReparseAncestor $Value
    if (-not (Test-Path -LiteralPath $path)) { Fail "Required path does not exist: $path" }
    $item = Get-Item -LiteralPath $path -Force
    if ($Directory -ne [bool]$item.PSIsContainer) { Fail "Expected an ordinary $(if ($Directory) { 'directory' } else { 'file' }): $path" }
    if (-not $Directory -and $item.Length -le 0) { Fail "Empty release input: $path" }
    $path
}

function Get-Sha256([string]$Path) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}

function Get-StreamSha256([IO.Stream]$Stream) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { [BitConverter]::ToString($algorithm.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

function Read-JsonFile([string]$Path, [long]$Maximum = 8MB) {
    $resolved = Assert-PlainPath $Path
    if ((Get-Item -LiteralPath $resolved).Length -gt $Maximum) { Fail "JSON input exceeds its size limit: $resolved" }
    try { [IO.File]::ReadAllText($resolved) | ConvertFrom-Json }
    catch { Fail "Invalid JSON input: $resolved" }
}

function Assert-Version([string]$Version) {
    if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$' -or $Version.Length -gt 96) {
        Fail 'Release version is not valid SemVer.'
    }
    $Version
}

function Get-CoreVersion {
    $cargo = Join-Path (Split-Path -Parent $PSScriptRoot) 'Cargo.toml'
    $text = [IO.File]::ReadAllText((Assert-PlainPath $cargo))
    $match = [regex]::Match($text, '(?m)^version\s*=\s*"([^"]+)"')
    if (-not $match.Success) { Fail 'Cargo.toml has no package version.' }
    Assert-Version $match.Groups[1].Value
}

function Assert-DistributionEnvelope($Manifest, [string]$Kind, [string]$Platform, [string]$Version) {
    if ($Manifest.schema -ne 1 -or $Manifest.kind -ne $Kind -or $Manifest.platform -ne $Platform -or $Manifest.version -ne $Version) {
        Fail "Distribution manifest must be schema 1, kind $Kind, platform $Platform, version $Version."
    }
    if ($Manifest.sourceCommit -notmatch '^[0-9a-fA-F]{40}$') { Fail 'Distribution manifest must record a complete Core source commit.' }
    if ($Manifest.files -isnot [System.Array] -or $Manifest.files.Count -lt 1 -or $Manifest.files.Count -gt 8192) { Fail 'Distribution manifest file inventory is empty or too large.' }
    $Manifest.sourceCommit = $Manifest.sourceCommit.ToLowerInvariant()
}

function Get-SafeManifestRelative([string]$Relative) {
    if (-not $Relative -or $Relative.Contains('\') -or $Relative.Contains(':') -or $Relative.StartsWith('/') -or
        @($Relative.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count -gt 0 -or
        $Relative -notmatch '^[A-Za-z0-9._/-]+$') {
        Fail "Unsafe path in distribution manifest: $Relative"
    }
    $Relative
}

function Assert-FileRecord($Record) {
    if ($null -eq $Record -or $Record.path -isnot [string] -or $Record.bytes -isnot [long] -and $Record.bytes -isnot [int] -or
        [long]$Record.bytes -le 0 -or $Record.sha256 -notmatch '^[0-9a-f]{64}$') {
        Fail 'Distribution manifest contains an invalid file record.'
    }
    Get-SafeManifestRelative $Record.path | Out-Null
}

function Assert-DirectoryManifestPayload([string]$Directory, $Manifest, [string]$FallbackDirectory) {
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($record in $Manifest.files) {
        Assert-FileRecord $record
        if (-not $seen.Add($record.path)) { Fail "Duplicate distribution manifest path: $($record.path)" }
        $candidates = @($Directory)
        if ($FallbackDirectory) { $candidates += $FallbackDirectory }
        $matched = $false
        foreach ($candidateRoot in $candidates) {
            $candidate = [IO.Path]::GetFullPath((Join-Path $candidateRoot ($record.path.Replace('/', [IO.Path]::DirectorySeparatorChar))))
            $prefix = (Get-Absolute $candidateRoot) + [IO.Path]::DirectorySeparatorChar
            if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { continue }
            if (-not (Test-Path -LiteralPath $candidate)) { continue }
            $candidate = Assert-PlainPath $candidate
            if ((Get-Item -LiteralPath $candidate).Length -eq [long]$record.bytes -and (Get-Sha256 $candidate) -eq $record.sha256) {
                $matched = $true
                break
            }
        }
        if (-not $matched) { Fail "Distribution payload does not match its manifest: $($record.path)" }
    }
}

function Assert-PortableZip([string]$ZipPath, [string]$PortableRoot, $Manifest) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $entries = @{}
        $files = 0
        foreach ($entry in $archive.Entries) {
            # Build-PreviewDistribution uses the Windows ZipFile helper, whose
            # archive entry separator is a backslash on Windows.
            $name = $entry.FullName.Replace('\', '/')
            $isDirectory = $name.EndsWith('/')
            $relative = if ($isDirectory) { $name.TrimEnd('/') } else { $name }
            if (-not $relative -or $relative.Contains('\') -or $relative.Contains(':') -or $relative.StartsWith('/') -or
                @($relative.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count -gt 0 -or
                $relative -notmatch '^[A-Za-z0-9._/-]+$') { Fail "Portable ZIP contains an unsafe path: $name" }
            if ($isDirectory) { continue }
            $key = $relative.ToLowerInvariant()
            if ($entries.ContainsKey($key)) { Fail 'Portable ZIP contains duplicate paths.' }
            $unixType = ([long]$entry.ExternalAttributes -shr 16) -band 0xF000
            if ($unixType -eq 0xA000) { Fail 'Portable ZIP contains a symbolic link.' }
            $entries[$key] = $entry
            $files++
        }
        if ($files -ne ($Manifest.files.Count + 1)) { Fail 'Portable ZIP file inventory differs from its distribution manifest.' }
        foreach ($record in $Manifest.files) {
            $entry = $entries[$record.path.ToLowerInvariant()]
            if ($null -eq $entry -or $entry.Length -ne [long]$record.bytes) { Fail "Portable ZIP is missing or changes $($record.path)." }
            $stream = $entry.Open()
            try { if ((Get-StreamSha256 $stream) -ne $record.sha256) { Fail "Portable ZIP hash differs for $($record.path)." } }
            finally { $stream.Dispose() }
        }
        $manifestEntry = $entries['distribution-manifest.json']
        if ($null -eq $manifestEntry) { Fail 'Portable ZIP does not contain distribution-manifest.json.' }
        $manifestPath = Join-Path $PortableRoot 'distribution-manifest.json'
        $manifestHash = Get-Sha256 (Assert-PlainPath $manifestPath)
        if ($manifestEntry.Length -ne (Get-Item -LiteralPath $manifestPath).Length) { Fail 'Portable ZIP contains a different distribution manifest.' }
        $stream = $manifestEntry.Open()
        try { if ((Get-StreamSha256 $stream) -ne $manifestHash) { Fail 'Portable ZIP distribution manifest hash differs.' } }
        finally { $stream.Dispose() }
    }
    finally { $archive.Dispose() }
}

function Read-ZipEntryBytes($Entry, [long]$Maximum = 1MB) {
    if ($Entry.Length -gt $Maximum) { Fail 'A ZIP metadata entry exceeds its size limit.' }
    $stream = $Entry.Open()
    $memory = New-Object IO.MemoryStream
    try {
        $stream.CopyTo($memory, 32768)
        if ($memory.Length -gt $Maximum) { Fail 'A ZIP metadata entry exceeds its size limit.' }
        Write-Output -NoEnumerate $memory.ToArray()
    }
    finally { $memory.Dispose(); $stream.Dispose() }
}

function Assert-MacUpdateZip([string]$ZipPath, $MacManifest, [string]$Version) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $expectedName = "Codlet-$Version-darwin-arm64-update.zip"
    if ([IO.Path]::GetFileName($ZipPath) -ne $expectedName -or $null -eq $MacManifest.updateZip -or
        $MacManifest.updateZip.file -ne $expectedName -or [long]$MacManifest.updateZip.bytes -ne (Get-Item -LiteralPath $ZipPath).Length -or
        $MacManifest.updateZip.sha256 -notmatch '^[0-9a-f]{64}$' -or (Get-Sha256 $ZipPath) -ne $MacManifest.updateZip.sha256) {
        Fail 'macOS updater ZIP does not match its distribution manifest or versioned filename.'
    }
    $archive = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $entries = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName
            if ($name.Contains('\') -or $name.Contains(':') -or $name.StartsWith('/') -or @($name.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count -gt 0 -or $name -notmatch '^[A-Za-z0-9._/-]+$') {
                Fail 'macOS updater ZIP contains an unsafe entry path.'
            }
            if ($entries.ContainsKey($name)) { Fail 'macOS updater ZIP contains duplicate entries.' }
            $unixMode = ([long]$entry.ExternalAttributes -shr 16) -band 0xFFFF
            if (($unixMode -band 0xF000) -ne 0x8000) { Fail 'macOS updater ZIP entries must be regular files without links.' }
            $entries.Add($name, $entry)
        }
        if (-not $entries.ContainsKey('runtime-update-manifest.json')) { Fail 'macOS updater ZIP has no root runtime-update-manifest.json.' }
        $manifestEntry = $entries['runtime-update-manifest.json']
        if ($manifestEntry.Length -gt 256KB -or (([long]$manifestEntry.ExternalAttributes -shr 16) -band 0x1FF) -ne 420) { Fail 'macOS updater manifest must be bounded and have mode 0644.' }
        $updateBytes = Read-ZipEntryBytes $manifestEntry 256KB
        $update = $script:utf8.GetString($updateBytes) | ConvertFrom-Json
        if ($update.schema -ne 1 -or $update.kind -ne 'codlet-runtime-update' -or $update.version -ne $Version -or $update.platform -ne 'darwin-arm64' -or $update.profile -ne 'macApp') {
            Fail 'macOS updater manifest is not compatible with the Core runtime updater.'
        }
        $files = @($update.files)
        $distributionFiles = @($MacManifest.files)
        if ($files.Count -lt 1 -or $files.Count -gt 8192 -or $files.Count -ne $distributionFiles.Count -or $entries.Count -ne ($files.Count + 1)) {
            Fail 'macOS updater ZIP has missing or undeclared files or a mismatched distribution inventory.'
        }
        $previous = $null
        for ($index = 0; $index -lt $files.Count; $index++) {
            $updateRecord = $files[$index]
            $distributionRecord = $distributionFiles[$index]
            Assert-FileRecord $updateRecord
            if ($updateRecord.path -notlike 'Codlet.app/*' -or $updateRecord.mode -notin @(420, 493)) { Fail 'macOS updater manifest path/mode is invalid.' }
            if ($null -ne $previous -and [StringComparer]::Ordinal.Compare([string]$previous, [string]$updateRecord.path) -ge 0) { Fail 'macOS updater files must be sorted and unique.' }
            $previous = [string]$updateRecord.path
            if ($updateRecord.path -ne ('Codlet.app/' + $distributionRecord.path) -or [long]$updateRecord.bytes -ne [long]$distributionRecord.bytes -or
                $updateRecord.sha256 -ne $distributionRecord.sha256) {
                Fail 'macOS updater manifest does not exactly match the signed app distribution inventory.'
            }
            if (-not $entries.ContainsKey($updateRecord.path)) { Fail "macOS updater ZIP is missing $($updateRecord.path)." }
            $entry = $entries[$updateRecord.path]
            $unixMode = ([long]$entry.ExternalAttributes -shr 16) -band 0x1FF
            if ($entry.Length -ne [long]$updateRecord.bytes -or $unixMode -ne [int]$updateRecord.mode) { Fail "macOS updater ZIP size/mode differs for $($updateRecord.path)." }
            $stream = $entry.Open()
            try { if ((Get-StreamSha256 $stream) -ne $updateRecord.sha256) { Fail "macOS updater ZIP hash differs for $($updateRecord.path)." } }
            finally { $stream.Dispose() }
        }
        $pinPath = 'Codlet.app/Contents/Resources/runtime/node-runtime.json'
        if (-not $entries.ContainsKey($pinPath)) { Fail 'macOS updater ZIP has no bundled Node runtime pin.' }
        $pinBytes = Read-ZipEntryBytes $entries[$pinPath] 64KB
        $pin = $script:utf8.GetString($pinBytes) | ConvertFrom-Json
        $macPin = $pin.platforms.'darwin-arm64'
        if ($pin.schema -ne 1 -or -not $macPin -or $update.runtime.version -ne $macPin.version -or
            $update.runtime.executableSha256 -ne $macPin.executableSha256 -or $update.runtime.licenseSha256 -ne $macPin.licenseSha256) {
            Fail 'macOS updater runtime record does not match the bundled pinned Node runtime.'
        }
        $nodeBase = "Codlet.app/Contents/Resources/runtime/node-v$($macPin.version)-darwin-arm64"
        $nodePath = $nodeBase + '/bin/node'
        $licensePath = $nodeBase + '/LICENSE'
        if (-not $entries.ContainsKey($nodePath) -or -not $entries.ContainsKey($licensePath)) { Fail 'macOS updater ZIP is missing the pinned Node files.' }
        if ((Get-StreamHash $entries[$nodePath]) -ne $macPin.executableSha256 -or (Get-StreamHash $entries[$licensePath]) -ne $macPin.licenseSha256) {
            Fail 'macOS updater ZIP does not contain the pinned Node executable and license.'
        }
    }
    finally { $archive.Dispose() }
}

function Get-StreamHash($Entry) {
    $stream = $Entry.Open()
    try { Get-StreamSha256 $stream } finally { $stream.Dispose() }
}

function Assert-WindowsUpdateZip([string]$ZipPath, [string]$Version) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $entries = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName
            if (-not $name -or $name.Contains('\') -or $name.Contains(':') -or $name.StartsWith('/') -or
                @($name.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count -gt 0 -or $name -notmatch '^[A-Za-z0-9._/-]+$') {
                Fail 'Windows updater ZIP contains an unsafe entry path.'
            }
            if ($entries.ContainsKey($name)) { Fail 'Windows updater ZIP contains duplicate entries.' }
            $unixMode = ([long]$entry.ExternalAttributes -shr 16) -band 0xF000
            if ($unixMode -eq 0xA000) { Fail 'Windows updater ZIP may not contain symbolic links.' }
            $entries.Add($name, $entry)
        }
        if (-not $entries.ContainsKey('runtime-update-manifest.json')) { Fail 'Windows updater ZIP has no root runtime-update-manifest.json.' }
        $manifestEntry = $entries['runtime-update-manifest.json']
        if ($manifestEntry.Length -gt 256KB) { Fail 'Windows updater manifest exceeds its size limit.' }
        $manifestBytes = Read-ZipEntryBytes $manifestEntry 256KB
        $manifest = $script:utf8.GetString($manifestBytes) | ConvertFrom-Json
        if ($manifest.schema -ne 1 -or $manifest.kind -ne 'codlet-runtime-update' -or $manifest.version -ne $Version -or
            $manifest.platform -ne 'win-x64' -or $manifest.profile -ne 'portable') { Fail 'Windows updater manifest is not compatible with the Core runtime updater.' }
        $files = @($manifest.files)
        if ($files.Count -lt 1 -or $files.Count -gt 4096 -or $entries.Count -ne ($files.Count + 1)) { Fail 'Windows updater ZIP has missing or undeclared files.' }
        $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        foreach ($record in $files) {
            Assert-FileRecord $record
            if (-not $seen.Add($record.path)) { Fail 'Windows updater manifest contains duplicate paths.' }
            if (-not $entries.ContainsKey($record.path)) { Fail "Windows updater ZIP is missing $($record.path)." }
            $entry = $entries[$record.path]
            if ($entry.Length -ne [long]$record.bytes) { Fail "Windows updater ZIP size differs for $($record.path)." }
            $stream = $entry.Open()
            try { if ((Get-StreamSha256 $stream) -ne $record.sha256) { Fail "Windows updater ZIP hash differs for $($record.path)." } }
            finally { $stream.Dispose() }
        }
        if (-not $entries.ContainsKey('codlet.exe') -or $entries.ContainsKey('codlet-lab.exe') -or -not $entries.ContainsKey('runtime/node-runtime.json')) {
            Fail 'Windows updater ZIP does not match the portable profile.'
        }
        $pinBytes = Read-ZipEntryBytes $entries['runtime/node-runtime.json'] 64KB
        $pin = $script:utf8.GetString($pinBytes) | ConvertFrom-Json
        $nodePin = $pin.platforms.'win-x64'
        if ($pin.schema -ne 1 -or -not $nodePin -or $manifest.runtime.version -ne $pin.version -or
            $manifest.runtime.executableSha256 -ne $nodePin.executableSha256 -or $manifest.runtime.licenseSha256 -ne $nodePin.licenseSha256) {
            Fail 'Windows updater runtime record does not match the bundled pinned Node runtime.'
        }
        $nodeBase = "runtime/node-v$($pin.version)-win-x64"
        $nodePath = $nodeBase + '/node.exe'
        $licensePath = $nodeBase + '/LICENSE'
        if (-not $entries.ContainsKey($nodePath) -or -not $entries.ContainsKey($licensePath) -or
            (Get-StreamHash $entries[$nodePath]) -ne $nodePin.executableSha256 -or (Get-StreamHash $entries[$licensePath]) -ne $nodePin.licenseSha256) {
            Fail 'Windows updater ZIP does not contain its pinned Node executable and license.'
        }
    }
    finally { $archive.Dispose() }
}

function Add-CopiedAsset([string]$Stage, [string]$Name, [string]$Source, [string]$Kind) {
    if ($Name -notmatch '^[A-Za-z0-9._+-]+$') { Fail "Invalid generated asset name: $Name" }
    $sourcePath = Assert-PlainPath $Source
    $sourceHash = Get-Sha256 $sourcePath
    $sourceBytes = (Get-Item -LiteralPath $sourcePath).Length
    if ($sourceBytes -gt $script:assetLimit) { Fail "Release asset exceeds the GitHub upload limit: $Name" }
    $destination = Join-Path $Stage $Name
    if (Test-Path -LiteralPath $destination) { Fail "Duplicate release asset: $Name" }
    [IO.File]::Copy($sourcePath, $destination, $false)
    if ((Get-Item -LiteralPath $destination).Length -ne $sourceBytes -or (Get-Sha256 $destination) -ne $sourceHash) { Fail "Copied release asset changed: $Name" }
    [pscustomobject]@{ name = $Name; file = $Name; kind = $Kind; bytes = [long]$sourceBytes; sha256 = $sourceHash }
}

function Add-GeneratedAsset([string]$Stage, [string]$Name, [string]$Kind) {
    $path = Join-Path $Stage $Name
    $path = Assert-PlainPath $path
    $bytes = (Get-Item -LiteralPath $path).Length
    if ($bytes -gt $script:assetLimit) { Fail "Release asset exceeds the GitHub upload limit: $Name" }
    [pscustomobject]@{ name = $Name; file = $Name; kind = $Kind; bytes = [long]$bytes; sha256 = Get-Sha256 $path }
}

function Write-Utf8([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, $script:utf8)
}

function Assert-OutputStage([string]$Path, [string]$Parent) {
    $resolved = Get-Absolute $Path
    $prefix = (Get-Absolute $Parent) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { Fail 'Temporary release path escaped its parent directory.' }
    if (Test-Path -LiteralPath $resolved) {
        for ($current = $resolved; $current.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase); $current = [IO.Path]::GetDirectoryName($current)) {
            if (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail 'Temporary release path contains a reparse point.' }
            if ($current -eq (Get-Absolute $Parent)) { break }
        }
    }
    $resolved
}

function New-PreviewPlan {
    foreach ($required in @('WindowsPortableDirectory', 'WindowsPortableZip', 'WindowsMsi', 'WindowsMsiManifest', 'MacDmg', 'MacDistributionManifest', 'MacUpdateZip', 'OutputDirectory')) {
        if ([string]::IsNullOrWhiteSpace((Get-Variable -Name $required -ValueOnly))) { Fail "Preview action requires -$($required)." }
    }
    $version = Get-CoreVersion
    if (-not $version.Contains('-')) { Fail 'Preview publication requires a prerelease version in Cargo.toml.' }
    $portableRoot = Assert-PlainPath $WindowsPortableDirectory $true
    $portableZip = Assert-PlainPath $WindowsPortableZip
    $msiPath = Assert-PlainPath $WindowsMsi
    $msiManifestPath = Assert-PlainPath $WindowsMsiManifest
    $dmgPath = Assert-PlainPath $MacDmg
    $macManifestPath = Assert-PlainPath $MacDistributionManifest
    $macUpdateZipPath = Assert-PlainPath $MacUpdateZip
    $portableManifestPath = Assert-PlainPath (Join-Path $portableRoot 'distribution-manifest.json')
    $portableManifest = Read-JsonFile $portableManifestPath
    Assert-DistributionEnvelope $portableManifest 'codlet-portable-distribution' 'win-x64' $version
    if ($portableManifest.pluginsCommit -notmatch '^[0-9a-fA-F]{40}$') { Fail 'Windows portable manifest must record a complete plugin source commit.' }
    $portableManifest.pluginsCommit = $portableManifest.pluginsCommit.ToLowerInvariant()
    Assert-DirectoryManifestPayload $portableRoot $portableManifest
    Assert-PortableZip $portableZip $portableRoot $portableManifest

    $msiManifest = Read-JsonFile $msiManifestPath
    Assert-DistributionEnvelope $msiManifest 'codlet-msi-distribution' 'win-x64' $version
    if ($msiManifest.sourceCommit -ne $portableManifest.sourceCommit) { Fail 'Windows MSI and portable builds come from different Core commits.' }
    if ($msiManifest.pluginsCommit -and $msiManifest.pluginsCommit -notmatch '^[0-9a-fA-F]{40}$') { Fail 'Windows MSI manifest contains an invalid plugin commit.' }
    if ($msiManifest.pluginsCommit -and $msiManifest.pluginsCommit.ToLowerInvariant() -ne $portableManifest.pluginsCommit) { Fail 'Windows MSI and portable builds come from different plugin commits.' }
    $msiRoot = Split-Path -Parent $msiManifestPath
    Assert-DirectoryManifestPayload $msiRoot $msiManifest -FallbackDirectory $portableRoot
    $msiMetadataPath = Assert-PlainPath ($msiPath + '.json')
    $msiMetadata = Read-JsonFile $msiMetadataPath 128KB
    if ($msiMetadata.version -ne $version -or [long]$msiMetadata.bytes -ne (Get-Item -LiteralPath $msiPath).Length -or $msiMetadata.sha256 -ne (Get-Sha256 $msiPath)) {
        Fail 'MSI bytes do not match the build receipt or package version.'
    }

    $macManifest = Read-JsonFile $macManifestPath
    Assert-DistributionEnvelope $macManifest 'codlet-macos-preview' 'darwin-arm64' $version
    if ($macManifest.pluginsSourceCommit -notmatch '^[0-9a-fA-F]{40}$' -or $macManifest.pluginsSourceCommit.ToLowerInvariant() -ne $portableManifest.pluginsCommit) { Fail 'macOS and Windows builds come from different plugin commits.' }
    if ($macManifest.sourceCommit.ToLowerInvariant() -ne $portableManifest.sourceCommit) { Fail 'macOS and Windows builds come from different Core commits.' }
    if ($null -eq $macManifest.dmg -or $macManifest.dmg.file -ne [IO.Path]::GetFileName($dmgPath) -or
        [long]$macManifest.dmg.bytes -ne (Get-Item -LiteralPath $dmgPath).Length -or $macManifest.dmg.sha256 -notmatch '^[0-9a-f]{64}$' -or
        (Get-Sha256 $dmgPath) -ne $macManifest.dmg.sha256) {
        Fail 'macOS DMG does not match its distribution manifest.'
    }
    Assert-MacUpdateZip $macUpdateZipPath $macManifest $version

    $output = Get-Absolute $OutputDirectory
    if (Test-Path -LiteralPath $output) { Fail 'OutputDirectory must be fresh; existing content is never replaced.' }
    $parent = Split-Path -Parent $output
    if (-not $parent) { Fail 'OutputDirectory must not be a drive root.' }
    $null = Assert-NoReparseAncestor $parent
    $null = [IO.Directory]::CreateDirectory($parent)
    $null = Assert-PlainPath $parent $true
    $stage = Join-Path $parent ('.codlet-preview-release-' + [Guid]::NewGuid().ToString('N'))
    $null = [IO.Directory]::CreateDirectory($stage)
    $stage = Assert-OutputStage $stage $parent
    try {
        $assets = [Collections.Generic.List[object]]::new()
        $assets.Add((Add-CopiedAsset $stage ("Codlet-$version-windows-x64-portable.zip") $portableZip 'windows-portable'))
        $assets.Add((Add-CopiedAsset $stage ("Codlet-$version-windows-x64.msi") $msiPath 'windows-msi'))
        $assets.Add((Add-CopiedAsset $stage ("Codlet-$version-macos-arm64.dmg") $dmgPath 'macos-dmg'))
        $assets.Add((Add-CopiedAsset $stage ("Codlet-$version-windows-x64-portable-distribution-manifest.json") $portableManifestPath 'windows-portable-manifest'))
        $assets.Add((Add-CopiedAsset $stage ("Codlet-$version-windows-x64-msi-distribution-manifest.json") $msiManifestPath 'windows-msi-manifest'))
        $assets.Add((Add-CopiedAsset $stage ("Codlet-$version-macos-arm64-distribution-manifest.json") $macManifestPath 'macos-manifest'))
        $assets.Add((Add-CopiedAsset $stage ("Codlet-$version-darwin-arm64-update.zip") $macUpdateZipPath 'runtime-update-macos-app'))

        $runtimeBuild = Join-Path $stage '.runtime-update-build'
        $builder = Join-Path $PSScriptRoot 'Build-RuntimeUpdate.ps1'
        if (-not (Test-Path -LiteralPath $builder)) { Fail 'Build-RuntimeUpdate.ps1 is missing.' }
        $buildResult = & $builder -InputDirectory $portableRoot -PayloadProfile portable -Version $version -Channel preview -OutputDirectory $runtimeBuild
        if ($null -eq $buildResult -or -not $buildResult.archive) { Fail 'Runtime update packager did not return an archive.' }
        Assert-WindowsUpdateZip $buildResult.archive $version
        $runtimeAssetName = "codlet-runtime-$version-win-x64-portable.zip"
        $assets.Add((Add-CopiedAsset $stage $runtimeAssetName $buildResult.archive 'runtime-update-windows-portable'))
        [IO.Directory]::Delete((Assert-OutputStage $runtimeBuild $stage), $true)

        $runtimeAsset = $assets | Where-Object { $_.name -eq $runtimeAssetName }
        $channelManifest = [ordered]@{
            schema = 1
            kind = 'codlet-runtime-channel'
            channel = 'preview'
            version = $version
            artifacts = @([ordered]@{
                platform = 'win-x64'
                profile = 'portable'
                bytes = [long]$runtimeAsset.bytes
                sha256 = $runtimeAsset.sha256
                assetName = $runtimeAssetName
            }, [ordered]@{
                platform = 'darwin-arm64'
                profile = 'macApp'
                bytes = [long](@($assets | Where-Object { $_.name -eq "Codlet-$version-darwin-arm64-update.zip" })[0].bytes)
                sha256 = [string](@($assets | Where-Object { $_.name -eq "Codlet-$version-darwin-arm64-update.zip" })[0].sha256)
                assetName = "Codlet-$version-darwin-arm64-update.zip"
            })
        }
        # The shipped runtime/update-channel.json pins this stable asset name;
        # only the manifest's channel/version vary across Preview releases.
        $channelName = 'codlet-update.json'
        Write-Utf8 (Join-Path $stage $channelName) (($channelManifest | ConvertTo-Json -Depth 12) + "`n")
        $assets.Add((Add-GeneratedAsset $stage $channelName 'runtime-channel-manifest'))

        $sumLines = @($assets | Sort-Object name | ForEach-Object { "$($_.sha256)  $($_.name)" })
        $sumName = 'SHA256SUMS.txt'
        Write-Utf8 (Join-Path $stage $sumName) (($sumLines -join "`n") + "`n")
        $assets.Add((Add-GeneratedAsset $stage $sumName 'sha256-summary'))

        $notesLines = @(
            "# Codlet Core $version Preview",
            '',
            "This prerelease was built from Core commit ``$($portableManifest.sourceCommit)`` and official-plugin source commit ``$($portableManifest.pluginsCommit)``.",
            '',
            '## Downloads',
            '',
            '- **Windows x64 portable ZIP** - extract and run Codlet; portable data stays alongside the extracted app.',
            '- **Windows x64 MSI** - per-user installation under LocalAppData, with selectable features.',
            '- **Apple Silicon DMG** - drag `Codlet.app` to Applications. The separate updater ZIP is used by the in-app runtime updater.',
            '',
            'The release includes `codlet-update.json` and platform-specific Windows portable and macOS app update packages. `SHA256SUMS.txt` lists asset digests; the distribution manifests record package contents and source commits.',
            '',
            '## Preview changes',
            '',
            '- Marketplace releases now carry a compact publisher declaration so listings can show the plugin version, supported platforms, and ZIP download count. Core still verifies package contents before installation.',
            '- Desktop and provider traffic hooks route supported HTTP, SSE, and Responses WebSocket requests through authorized local plugin routes.',
            '- The in-app runtime updater now has versioned Windows portable and Apple Silicon app packages on the preview channel.',
            '',
            '## Signing and verification',
            '',
            'The macOS app is ad-hoc signed for bundle integrity. It is not Developer ID signed or notarized. Review `SHA256SUMS.txt` and the distribution manifests before use.',
            '',
            'This is preview software; see [known issues](https://github.com/baoabaob/codlet/blob/main/docs/known-issues.md) for current platform and acceptance limits.'
        )
        $notes = ($notesLines -join "`n") + "`n"
        Write-Utf8 (Join-Path $stage 'release-notes.md') $notes
        $notesPath = Join-Path $stage 'release-notes.md'

        $plan = [ordered]@{
            schema = 1
            kind = 'codlet-core-preview-release-plan'
            repository = $Repository
            version = $version
            tag = 'v' + $version
            channel = 'preview'
            prerelease = $true
            sourceCommit = $portableManifest.sourceCommit
            pluginsCommit = $portableManifest.pluginsCommit
            releaseName = "Codlet $version Preview"
            releaseNotesFile = 'release-notes.md'
            releaseNotesBytes = [long](Get-Item -LiteralPath $notesPath).Length
            releaseNotesSha256 = Get-Sha256 $notesPath
            assets = @($assets | Sort-Object name)
        }
        Write-Utf8 (Join-Path $stage 'release-plan.json') (($plan | ConvertTo-Json -Depth 20) + "`n")
        [IO.Directory]::Move($stage, $output)
        $report = [ordered]@{
            action = 'Preview'
            outputDirectory = $output
            version = $version
            tag = $plan.tag
            prerelease = $true
            updaterPlatforms = @('win-x64', 'darwin-arm64')
            assets = @($plan.assets | ForEach-Object { [ordered]@{ name = $_.name; bytes = $_.bytes; sha256 = $_.sha256; kind = $_.kind } })
            releasePlan = (Join-Path $output 'release-plan.json')
            releaseNotes = (Join-Path $output 'release-notes.md')
            externalWrites = $false
        }
        $report | ConvertTo-Json -Depth 12
    }
    catch {
        if (Test-Path -LiteralPath $stage) {
            $ownedStage = Assert-OutputStage $stage $parent
            [IO.Directory]::Delete($ownedStage, $true)
        }
        throw
    }
}

function Resolve-PlanAsset([string]$Root, [string]$Name) {
    if ($Name -notmatch '^[A-Za-z0-9._+-]+$' -or $Name -in @('.', '..')) { Fail 'Release plan contains an unsafe asset name.' }
    $candidate = [IO.Path]::GetFullPath((Join-Path $Root $Name))
    $prefix = (Get-Absolute $Root) + [IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { Fail 'Release asset escaped the plan directory.' }
    Assert-PlainPath $candidate
}

function Read-ReleasePlan([string]$Path) {
    $planPath = Assert-PlainPath $Path
    $plan = Read-JsonFile $planPath 2MB
    if ($plan.schema -ne 1 -or $plan.kind -ne 'codlet-core-preview-release-plan' -or $plan.channel -ne 'preview' -or $plan.prerelease -ne $true) { Fail 'Expected a Codlet Core preview release plan.' }
    Assert-Version ([string]$plan.version) | Out-Null
    if ($plan.tag -ne ('v' + $plan.version) -or $plan.repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or
        $plan.sourceCommit -notmatch '^[0-9a-f]{40}$' -or $plan.pluginsCommit -notmatch '^[0-9a-f]{40}$') { Fail 'Release plan version, repository or provenance is invalid.' }
    if ($plan.assets -isnot [System.Array] -or $plan.assets.Count -lt 4 -or $plan.assets.Count -gt 128) { Fail 'Release plan asset list is empty or too large.' }
    $root = Split-Path -Parent $planPath
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($asset in $plan.assets) {
        if ($asset.name -ne $asset.file -or -not $seen.Add([string]$asset.name) -or [long]$asset.bytes -le 0 -or
            $asset.bytes -gt $script:assetLimit -or $asset.sha256 -notmatch '^[0-9a-f]{64}$') { Fail 'Release plan contains a duplicate or invalid asset record.' }
        $file = Resolve-PlanAsset $root ([string]$asset.file)
        if ((Get-Item -LiteralPath $file).Length -ne [long]$asset.bytes -or (Get-Sha256 $file) -ne $asset.sha256) { Fail "Release asset differs from the saved plan: $($asset.name)" }
    }
    $channelAsset = @($plan.assets | Where-Object { $_.name -eq 'codlet-update.json' })
    if ($channelAsset.Count -ne 1) { Fail 'Release plan must contain codlet-update.json.' }
    $channel = Read-JsonFile (Resolve-PlanAsset $root 'codlet-update.json') 256KB
    if ($channel.schema -ne 1 -or $channel.kind -ne 'codlet-runtime-channel' -or $channel.channel -ne 'preview' -or $channel.version -ne $plan.version -or $channel.artifacts.Count -ne 2) { Fail 'Preview channel manifest is not compatible with the runtime updater.' }
    foreach ($supported in @(@{ platform = 'win-x64'; profile = 'portable' }, @{ platform = 'darwin-arm64'; profile = 'macApp' })) {
        $matches = @($channel.artifacts | Where-Object { $_.platform -eq $supported.platform -and $_.profile -eq $supported.profile })
        if ($matches.Count -ne 1) { Fail "Preview channel manifest must contain one $($supported.platform)/$($supported.profile) updater artifact." }
        $artifact = $matches[0]
        $zipRecords = @($plan.assets | Where-Object { $_.name -eq $artifact.assetName })
        if ($zipRecords.Count -ne 1 -or [long]$zipRecords[0].bytes -ne [long]$artifact.bytes -or $zipRecords[0].sha256 -ne $artifact.sha256 -or
            $artifact.bytes -le 0 -or $artifact.bytes -gt 512MB -or $artifact.sha256 -notmatch '^[0-9a-f]{64}$') {
            Fail "Preview channel manifest does not pin the exact $($supported.platform) updater ZIP asset."
        }
        $zipPath = Resolve-PlanAsset $root ([string]$artifact.assetName)
        if ($supported.platform -eq 'win-x64') {
            Assert-WindowsUpdateZip $zipPath ([string]$plan.version)
        }
        else {
            $macManifestAsset = @($plan.assets | Where-Object { $_.kind -eq 'macos-manifest' })
            if ($macManifestAsset.Count -ne 1) { Fail 'Release plan must contain one macOS distribution manifest.' }
            $macManifest = Read-JsonFile (Resolve-PlanAsset $root ([string]$macManifestAsset[0].file))
            if ($macManifest.schema -ne 1 -or $macManifest.kind -ne 'codlet-macos-preview' -or $macManifest.version -ne $plan.version -or
                $macManifest.platform -ne 'darwin-arm64' -or $macManifest.sourceCommit -ne $plan.sourceCommit -or $macManifest.pluginsSourceCommit -ne $plan.pluginsCommit) {
                Fail 'Saved macOS distribution manifest has different release provenance.'
            }
            Assert-MacUpdateZip $zipPath $macManifest ([string]$plan.version)
        }
    }
    if ($plan.releaseNotesFile -ne 'release-notes.md') { Fail 'Release notes path is not supported.' }
    $notes = Resolve-PlanAsset $root ([string]$plan.releaseNotesFile)
    if ((Get-Item -LiteralPath $notes).Length -ne [long]$plan.releaseNotesBytes -or [long]$plan.releaseNotesBytes -gt 256KB -or
        $plan.releaseNotesSha256 -notmatch '^[0-9a-f]{64}$' -or (Get-Sha256 $notes) -ne $plan.releaseNotesSha256) {
        Fail 'Release notes differ from the saved versioned release plan.'
    }
    [pscustomobject]@{ Plan = $plan; Root = $root; NotesPath = $notes; Notes = [IO.File]::ReadAllText($notes) }
}

function Initialize-GitHubCredential {
    if ($env:CODLET_CORE_RELEASE_TOKEN) { $script:token = $env:CODLET_CORE_RELEASE_TOKEN }
    elseif ($env:GH_TOKEN) { $script:token = $env:GH_TOKEN }
    else {
        $oldPrompt = $env:GIT_TERMINAL_PROMPT
        $oldInteractive = $env:GCM_INTERACTIVE
        try {
            $env:GIT_TERMINAL_PROMPT = '0'
            $env:GCM_INTERACTIVE = 'Never'
            $credentialText = "protocol=https`nhost=github.com`n`n" | git credential fill 2>$null
            if ($LASTEXITCODE -ne 0) { Fail 'Git Credential Manager did not provide a GitHub credential.' }
            foreach ($line in $credentialText) { if ($line.StartsWith('password=')) { $script:token = $line.Substring(9) } }
        }
        finally {
            if ($null -eq $oldPrompt) { Remove-Item Env:GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue } else { $env:GIT_TERMINAL_PROMPT = $oldPrompt }
            if ($null -eq $oldInteractive) { Remove-Item Env:GCM_INTERACTIVE -ErrorAction SilentlyContinue } else { $env:GCM_INTERACTIVE = $oldInteractive }
        }
    }
    if ([string]::IsNullOrWhiteSpace($script:token)) { Fail 'Use Git Credential Manager, CODLET_CORE_RELEASE_TOKEN, or GH_TOKEN with Core release access.' }
}

function Invoke-ReleaseApi([string]$Method, [string]$Path, $Body = $null, [switch]$Missing, [string]$UploadFile) {
    if (-not $Path.StartsWith('/') -or $Path.StartsWith('//') -or $Path.Contains("`r") -or $Path.Contains("`n")) { Fail 'Invalid GitHub API path.' }
    $isUpload = $PSBoundParameters.ContainsKey('UploadFile') -and $UploadFile
    $hostName = if ($isUpload) { 'uploads.github.com' } else { 'api.github.com' }
    $request = [Net.HttpWebRequest]::Create('https://' + $hostName + $Path)
    $request.Method = $Method
    $request.Proxy = [Net.WebRequest]::GetSystemWebProxy()
    $request.Timeout = if ($isUpload) { 600000 } else { 60000 }
    $request.ReadWriteTimeout = if ($isUpload) { 600000 } else { 60000 }
    $request.AllowAutoRedirect = $false
    $request.UserAgent = 'Codlet-Core-preview-release'
    $request.Accept = 'application/vnd.github+json'
    $request.Headers['Authorization'] = 'Bearer ' + $script:token
    $request.Headers['X-GitHub-Api-Version'] = '2022-11-28'
    if ($isUpload) {
        $file = Assert-PlainPath $UploadFile
        $request.ContentType = 'application/octet-stream'
        $request.ContentLength = (Get-Item -LiteralPath $file).Length
        $input = [IO.File]::OpenRead($file)
        $output = $request.GetRequestStream()
        try { $input.CopyTo($output, 65536) }
        finally { $output.Dispose(); $input.Dispose() }
    }
    elseif ($null -ne $Body) {
        $bytes = $script:utf8.GetBytes(($Body | ConvertTo-Json -Depth 24 -Compress))
        $request.ContentType = 'application/json; charset=utf-8'
        $request.ContentLength = $bytes.Length
        $stream = $request.GetRequestStream()
        try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    }
    try { $response = $request.GetResponse() }
    catch [Net.WebException] {
        $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        if ($_.Exception.Response) { $_.Exception.Response.Dispose() }
        if ($Missing -and $status -eq 404) { return $null }
        Fail "GitHub $Method request failed (HTTP $status); no response body or credential was emitted."
    }
    try {
        if ([int]$response.StatusCode -ge 300) { Fail 'GitHub returned a redirect; credentials were not forwarded.' }
        $stream = $response.GetResponseStream()
        if ($null -eq $stream) { return $null }
        $buffer = New-Object byte[] 32768
        $memory = New-Object IO.MemoryStream
        try {
            while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                if ($memory.Length + $read -gt 4MB) { Fail 'GitHub response exceeded the JSON size limit.' }
                $memory.Write($buffer, 0, $read)
            }
            if ($memory.Length -eq 0) { return $null }
            try {
                $decoded = $script:utf8.GetString($memory.ToArray()) | ConvertFrom-Json
                return $decoded
            }
            catch { Fail 'GitHub returned invalid JSON.' }
        }
        finally { $memory.Dispose(); $stream.Dispose() }
    }
    finally { $response.Dispose() }
}

function Get-RemoteTagCommit([string]$RepositoryName, [string]$Tag) {
    $encoded = [Uri]::EscapeDataString($Tag)
    $ref = Invoke-ReleaseApi GET ("/repos/$RepositoryName/git/ref/tags/$encoded") -Missing
    if ($null -eq $ref) { return $null }
    $object = $ref.object
    for ($depth = 0; $depth -lt 4; $depth++) {
        if ($object.type -eq 'commit' -and $object.sha -match '^[0-9a-f]{40}$') { return $object.sha }
        if ($object.type -ne 'tag' -or $object.sha -notmatch '^[0-9a-f]{40}$') { Fail 'Release tag does not resolve to a Git commit.' }
        $tagObject = Invoke-ReleaseApi GET ("/repos/$RepositoryName/git/tags/$($object.sha)")
        $object = $tagObject.object
    }
    Fail 'Release tag has too many nested annotated tags.'
}

function Ensure-PreviewTag([string]$RepositoryName, [string]$Tag, [string]$SourceCommit) {
    if ($SourceCommit -notmatch '^[0-9a-f]{40}$') { Fail 'Release plan source commit is not a full lowercase Git object ID.' }
    $tagCommit = Get-RemoteTagCommit $RepositoryName $Tag
    if ($tagCommit) {
        if ($tagCommit -ne $SourceCommit) { Fail 'The release tag already points to another Core commit.' }
        return $tagCommit
    }

    try {
        $null = Invoke-ReleaseApi POST ("/repos/$RepositoryName/git/refs") @{
            ref = "refs/tags/$Tag"
            sha = $SourceCommit
        }
    }
    catch {
        # A concurrent retry may have created the same ref. Accept only that
        # exact result; never move or replace an existing version tag.
        $tagCommit = Get-RemoteTagCommit $RepositoryName $Tag
        if ($tagCommit -eq $SourceCommit) { return $tagCommit }
        Fail 'Could not create the preview tag at the exact plan commit.'
    }

    $tagCommit = Get-RemoteTagCommit $RepositoryName $Tag
    if ($tagCommit -ne $SourceCommit) { Fail 'Created preview tag does not resolve to the exact plan commit.' }
    $tagCommit
}

function Find-RemoteRelease([string]$RepositoryName, [string]$Tag) {
    for ($page = 1; $page -le 10; $page++) {
        $releases = @(Invoke-ReleaseApi GET ("/repos/$RepositoryName/releases?per_page=20&page=$page"))
        $match = @($releases | Where-Object { $_.tag_name -eq $Tag })
        if ($match.Count -gt 1) { Fail 'GitHub returned duplicate release tags.' }
        if ($match.Count -eq 1) { return $match[0] }
        if ($releases.Count -lt 20) { return $null }
    }
    Fail 'Release listing exceeded the bounded search limit.'
}

function Get-RemoteAssets([string]$RepositoryName, [long]$ReleaseId) {
    $all = [Collections.Generic.List[object]]::new()
    for ($page = 1; $page -le 2; $page++) {
        $assets = @(Invoke-ReleaseApi GET ("/repos/$RepositoryName/releases/$ReleaseId/assets?per_page=100&page=$page"))
        foreach ($asset in $assets) { $all.Add($asset) }
        if ($assets.Count -lt 100) { return @($all) }
    }
    Fail 'Release has more than 200 assets; refusing an unbounded publication.'
}

function Assert-ReleaseIdentity($Release, $Plan, [string]$Notes) {
    if ($Release.tag_name -ne $Plan.tag -or $Release.name -ne $Plan.releaseName -or $Release.body -cne $Notes -or $Release.prerelease -ne $true) {
        Fail 'This tag already has different release content or is not marked as a prerelease; refusing to overwrite it.'
    }
}

function Assert-RemoteAsset($Remote, $Expected) {
    if ($Remote.state -ne 'uploaded' -or [long]$Remote.size -ne [long]$Expected.bytes -or $Remote.digest -ne ('sha256:' + $Expected.sha256)) {
        Fail "Existing same-version asset differs from this release plan: $($Expected.name)"
    }
}

function Assert-RemoteAssetSet($RepositoryName, $Release, $Plan, [switch]$AllowMissing) {
    $remote = @(Get-RemoteAssets $RepositoryName ([long]$Release.id))
    $expectedByName = @{}
    foreach ($item in $Plan.assets) { $expectedByName[$item.name] = $item }
    $remoteByName = @{}
    foreach ($item in $remote) {
        if ($remoteByName.ContainsKey($item.name)) { Fail 'GitHub returned duplicate asset names.' }
        if (-not $expectedByName.ContainsKey($item.name)) { Fail "Existing same-version release has an unexpected asset: $($item.name)" }
        $remoteByName[$item.name] = $item
        Assert-RemoteAsset $item $expectedByName[$item.name]
    }
    foreach ($expected in $Plan.assets) {
        if (-not $remoteByName.ContainsKey($expected.name) -and -not $AllowMissing) { Fail "Release is missing an expected asset: $($expected.name)" }
    }
    $remoteByName
}

function Invoke-DraftAction($Loaded, [bool]$DoApply) {
    $plan = $Loaded.Plan
    if (-not $DoApply) {
        return [ordered]@{ action = 'PrepareDraft'; tag = $plan.tag; repository = $plan.repository; prerelease = $true; assets = $plan.assets.Count; externalWrites = $false; applyRequired = $true }
    }
    Initialize-GitHubCredential
    $repository = Invoke-ReleaseApi GET ("/repos/$($plan.repository)")
    if ($repository.archived -or $repository.fork) { Fail 'Refusing an archived repository or fork.' }
    $release = Find-RemoteRelease $plan.repository $plan.tag
    if ($release) {
        Assert-ReleaseIdentity $release $plan $Loaded.Notes
        $tagCommit = Ensure-PreviewTag $plan.repository $plan.tag $plan.sourceCommit
        $remoteByName = Assert-RemoteAssetSet $plan.repository $release $plan -AllowMissing
        if (-not $release.draft) {
            if ($remoteByName.Count -ne $plan.assets.Count) { Fail 'Published release is missing an expected asset; it will not be modified.' }
            return [ordered]@{ action = 'PrepareDraft'; tag = $plan.tag; releaseUrl = $release.html_url; draft = $false; prerelease = $true; alreadyComplete = $true; assets = $remoteByName.Count; externalWrites = $false }
        }
    }
    else {
        $tagCommit = Ensure-PreviewTag $plan.repository $plan.tag $plan.sourceCommit
        $release = Invoke-ReleaseApi POST ("/repos/$($plan.repository)/releases") @{
            tag_name = $plan.tag; target_commitish = $plan.sourceCommit; name = $plan.releaseName; body = $Loaded.Notes; draft = $true; prerelease = $true
        }
        if (-not $release.id -or -not $release.draft -or -not $release.prerelease) { Fail 'GitHub did not create the expected prerelease draft.' }
        $remoteByName = @{}
    }
    foreach ($expected in $plan.assets) {
        if ($remoteByName.ContainsKey($expected.name)) { continue }
        $file = Resolve-PlanAsset $Loaded.Root $expected.file
        $query = [Uri]::EscapeDataString($expected.name)
        $uploaded = Invoke-ReleaseApi POST ("/repos/$($plan.repository)/releases/$($release.id)/assets?name=$query") -UploadFile $file
        Assert-RemoteAsset $uploaded $expected
    }
    $verified = Find-RemoteRelease $plan.repository $plan.tag
    Assert-ReleaseIdentity $verified $plan $Loaded.Notes
    $verifiedTagCommit = Get-RemoteTagCommit $plan.repository $plan.tag
    if ($verifiedTagCommit -ne $plan.sourceCommit) { Fail 'Release tag changed away from the exact plan commit during draft preparation.' }
    $verifiedSet = Assert-RemoteAssetSet $plan.repository $verified $plan
    [ordered]@{ action = 'PrepareDraft'; tag = $plan.tag; releaseUrl = $verified.html_url; draft = $verified.draft; prerelease = $verified.prerelease; assets = $verifiedSet.Count; externalWrites = $true }
}

function Invoke-PublishAction($Loaded, [bool]$DoApply) {
    $plan = $Loaded.Plan
    if (-not $DoApply) {
        return [ordered]@{ action = 'Publish'; tag = $plan.tag; repository = $plan.repository; prerelease = $true; assets = $plan.assets.Count; externalWrites = $false; applyRequired = $true }
    }
    Initialize-GitHubCredential
    $release = Find-RemoteRelease $plan.repository $plan.tag
    if (-not $release) { Fail 'Publish requires an already prepared draft release; no release was created.' }
    Assert-ReleaseIdentity $release $plan $Loaded.Notes
    $tagCommit = Get-RemoteTagCommit $plan.repository $plan.tag
    if ($tagCommit -ne $plan.sourceCommit) { Fail 'Release tag does not point to the exact Core source commit in the plan.' }
    $remoteByName = Assert-RemoteAssetSet $plan.repository $release $plan
    if ($release.draft) {
        $release = Invoke-ReleaseApi PATCH ("/repos/$($plan.repository)/releases/$($release.id)") @{ draft = $false; prerelease = $true }
    }
    if ($release.draft -or -not $release.prerelease) { Fail 'GitHub did not publish the expected prerelease.' }
    [ordered]@{ action = 'Publish'; tag = $plan.tag; releaseUrl = $release.html_url; draft = $false; prerelease = $true; assets = $remoteByName.Count; externalWrites = $true }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { Fail 'Repository must use owner/name form.' }
        if ($Action -eq 'Preview') {
            if ($Apply) { Fail '-Apply is only valid with PrepareDraft or Publish.' }
            New-PreviewPlan | Write-Output
        }
        else {
            if ([string]::IsNullOrWhiteSpace($PlanPath)) { Fail "-$Action requires -PlanPath." }
            $loaded = Read-ReleasePlan $PlanPath
            if ($loaded.Plan.repository -ne $Repository) { Fail 'Repository argument does not match the immutable release plan.' }
            $result = if ($Action -eq 'PrepareDraft') { Invoke-DraftAction $loaded ([bool]$Apply) } else { Invoke-PublishAction $loaded ([bool]$Apply) }
            $result | ConvertTo-Json -Depth 12
        }
    }
    finally { $script:token = $null }
}
