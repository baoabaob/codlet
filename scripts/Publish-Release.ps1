[CmdletBinding()]
param(
    [ValidateSet('Plan', 'PrepareDraft', 'Publish')][string]$Action = 'Plan',
    [string]$WindowsPortableDirectory,
    [string]$WindowsPortableZip,
    [string]$WindowsMsi,
    [string]$WindowsMsiManifest,
    [string]$WindowsSetup,
    [switch]$WindowsOnly,
    [string]$MacDmg,
    [string]$MacDistributionManifest,
    [string]$MacUpdateZip,
    [switch]$LegacyUpdateBridge,
    [ValidateSet('stable','preview')][string]$Channel = 'stable',
    [string[]]$WindowsOnlineBaseDirectories = @(),
    [string[]]$OnlineModuleIds,
    [string]$WindowsBridgeNodeDirectory,
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
            # Build-Distribution uses the Windows ZipFile helper, whose
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

function Get-NodeRuntimeMode($Value) {
    if (-not $Value.PSObject.Properties['mode']) { return 'bundled' }
    if ($Value.mode -notin @('managed', 'bundled')) { Fail 'Unsupported Node runtime distribution mode.' }
    [string]$Value.mode
}

function Assert-MacUpdateZip([string]$ZipPath, $MacManifest, [string]$Version, [switch]$LegacyBridge) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $publicName = "Codlet-$Version-darwin-arm64-update.zip"
    $expectedName = if ($LegacyBridge) { "Codlet-$Version-darwin-arm64-legacy-update.zip" } else { $publicName }
    $declaration = if ($LegacyBridge) { $MacManifest.legacyUpdateZip } else { $MacManifest.updateZip }
    if ([IO.Path]::GetFileName($ZipPath) -notin @($expectedName, $publicName) -or $null -eq $declaration -or
        $declaration.file -ne $expectedName -or [long]$declaration.bytes -ne (Get-Item -LiteralPath $ZipPath).Length -or
        $declaration.sha256 -notmatch '^[0-9a-f]{64}$' -or (Get-Sha256 $ZipPath) -ne $declaration.sha256) {
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
        $distributionFiles = if ($LegacyBridge) { @($declaration.files) } else { @($MacManifest.files) }
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
        if (-not $entries.ContainsKey($pinPath)) { Fail 'macOS updater ZIP has no Node runtime pin.' }
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
        if ($LegacyBridge) {
            if ($pin.PSObject.Properties['mode'] -or $update.runtime.PSObject.Properties['mode']) { Fail 'Legacy bridge must omit runtime mode for Preview 5.' }
            if (-not $entries.ContainsKey($nodePath) -or -not $entries.ContainsKey($licensePath)) { Fail 'macOS bridge ZIP is missing the pinned Node files.' }
            if ((Get-StreamHash $entries[$nodePath]) -ne $macPin.executableSha256 -or (Get-StreamHash $entries[$licensePath]) -ne $macPin.licenseSha256) {
                Fail 'macOS bridge ZIP does not contain the pinned Node executable and license.'
            }
        }
        elseif ((Get-NodeRuntimeMode $pin) -ne 'managed' -or (Get-NodeRuntimeMode $update.runtime) -ne 'managed' -or
            @($entries.Keys | Where-Object { $_ -like 'Codlet.app/Contents/Resources/runtime/node-v*/*' }).Count -ne 0) {
            Fail 'Managed macOS updater must declare managed Node without embedding its runtime files.'
        }
    }
    finally { $archive.Dispose() }
}

function Get-StreamHash($Entry) {
    $stream = $Entry.Open()
    try { Get-StreamSha256 $stream } finally { $stream.Dispose() }
}

function Assert-WindowsUpdateZip([string]$ZipPath, [string]$Version, [switch]$LegacyBridge, [string]$ResidentSha256) {
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
        $expectedFiles = @('codlet.exe', 'runtime/node-runtime.json')
        if ($LegacyBridge) {
            if ($pin.PSObject.Properties['mode'] -or $manifest.runtime.PSObject.Properties['mode']) { Fail 'Legacy bridge must omit runtime mode for Preview 5.' }
            $expectedFiles += @($nodePath, $licensePath)
            if (-not $entries.ContainsKey($nodePath) -or -not $entries.ContainsKey($licensePath) -or
                (Get-StreamHash $entries[$nodePath]) -ne $nodePin.executableSha256 -or (Get-StreamHash $entries[$licensePath]) -ne $nodePin.licenseSha256) {
                Fail 'Windows bridge ZIP does not contain its pinned Node executable and license.'
            }
        }
        elseif ($ResidentSha256 -and (Get-NodeRuntimeMode $pin) -eq 'bundled' -and (Get-NodeRuntimeMode $manifest.runtime) -eq 'bundled') {
            $expectedFiles += @($nodePath, $licensePath)
            if (-not $entries.ContainsKey($nodePath) -or -not $entries.ContainsKey($licensePath) -or (Get-StreamHash $entries[$nodePath]) -ne $nodePin.executableSha256 -or (Get-StreamHash $entries[$licensePath]) -ne $nodePin.licenseSha256) { Fail 'Online ZIP does not preserve its pinned resident Node files.' }
        }
        elseif ((Get-NodeRuntimeMode $pin) -ne 'managed' -or (Get-NodeRuntimeMode $manifest.runtime) -ne 'managed') {
            Fail 'Managed Windows updater must declare managed Node.'
        }
        if($ResidentSha256){
            if($ResidentSha256 -notmatch '^[0-9a-f]{64}$' -or -not $manifest.PSObject.Properties['online']){Fail 'Targeted updates require a resident identity and online contract.'}
            $online=$manifest.online
            if($online.schema -ne 1 -or $online.bridgeProtocol -ne 1 -or $online.bridgeSha256 -notmatch '^[0-9a-f]{64}$' -or $online.bootstrapSha256 -notmatch '^[0-9a-f]{64}$' -or $online.clientSourcePath -cne 'runtime/core-modules/client-source.cjs' -or $online.moduleAbi -ne 1){Fail 'Invalid online Core contract.'}
            $modulePaths=@{'renderer-bootstrap'='runtime/core-modules/renderer-bootstrap.js';'renderer-helpers'='runtime/core-modules/renderer-helpers.js';'renderer-ui'='runtime/core-modules/renderer-ui.js';'renderer-facade'='runtime/core-modules/renderer-facade.js';'renderer-page'='runtime/core-modules/renderer-page.js';'renderer-i18n'='runtime/core-modules/renderer-i18n.js';'renderer-codex-sdk'='runtime/core-modules/renderer-codex-sdk.js';'renderer-core-services'='runtime/core-modules/renderer-core-services.cjs';'core-ui-provider'='runtime/core-modules/core-ui-provider.cjs';'core-desktop-provider'='runtime/core-modules/core-desktop-provider.cjs';'host-bootstrap'='runtime/core-modules/host-bootstrap.cjs'}
            if(@($online.modules).Count -lt 1 -or @($online.modules).Count -gt 11 -or @($online.modules|ForEach-Object {$_.id}|Sort-Object -Unique).Count -ne @($online.modules).Count){Fail 'Invalid online module inventory.'}
            $residentPaths=[string[]]$expectedFiles;[Array]::Sort($residentPaths,[StringComparer]::Ordinal)
            $identity=''
            foreach($relative in $residentPaths){$record=@($files|Where-Object {$_.path -ceq $relative})[0];$identity+=$record.path+[char]0+[string]$record.bytes+[char]0+$record.sha256+"`n"}
            $algorithm=[Security.Cryptography.SHA256]::Create()
            try{$actual=[BitConverter]::ToString($algorithm.ComputeHash($script:utf8.GetBytes($identity))).Replace('-','').ToLowerInvariant()}finally{$algorithm.Dispose()}
            if($actual -cne $ResidentSha256){Fail 'Online payload resident files differ from the catalog selector.'}
            $expectedFiles+=@($online.clientSourcePath)
            if(-not $entries.ContainsKey($online.clientSourcePath) -or $entries[$online.clientSourcePath].Length -gt 1MB){Fail 'Invalid online Native source.'}
            foreach($module in $online.modules){
                if(-not $modulePaths.ContainsKey([string]$module.id) -or $module.path -cne $modulePaths[$module.id] -or -not $entries.ContainsKey($module.path) -or $entries[$module.path].Length -gt 8MB){Fail 'Unknown or invalid online module.'}
                $expectedFiles+=$module.path
            }
        }elseif($manifest.PSObject.Properties['online']){Fail 'A complete legacy update must not advertise targeted online components.'}
        if ($files.Count -ne $expectedFiles.Count -or @($files | Where-Object { $_.path -cnotin $expectedFiles }).Count -ne 0) {
            Fail 'Windows updater file layout differs from its runtime distribution mode.'
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

function Add-VerificationInput([string]$Stage, [string]$Name, [string]$Source) {
    if ($Name -notin @('windows-portable-distribution-manifest.json', 'windows-msi-distribution-manifest.json', 'windows-setup-build.json', 'macos-distribution-manifest.json')) {
        Fail 'Unsupported local release verification input.'
    }
    $relative = ".verification/$Name"
    $target = Join-Path $Stage $relative
    $null = [IO.Directory]::CreateDirectory((Split-Path -Parent $target))
    [IO.File]::Copy((Assert-PlainPath $Source), $target)
    $target = Assert-PlainPath $target
    [ordered]@{ file = $relative; bytes = [long](Get-Item -LiteralPath $target).Length; sha256 = Get-Sha256 $target }
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
        $pending=[Collections.Generic.Stack[string]]::new();$pending.Push($resolved)
        while($pending.Count){
            $item=$pending.Pop();$attributes=[IO.File]::GetAttributes($item)
            if($attributes -band [IO.FileAttributes]::ReparsePoint){Fail 'Temporary release contents contain a reparse point.'}
            if($attributes -band [IO.FileAttributes]::Directory){foreach($child in ([IO.DirectoryInfo]::new($item)).EnumerateFileSystemInfos()){$pending.Push($child.FullName)}}
        }
    }
    $resolved
}

function New-ReleasePlan {
    $requiredInputs=@('WindowsPortableDirectory', 'WindowsMsi', 'WindowsMsiManifest', 'WindowsSetup', 'OutputDirectory')
    if(-not $WindowsOnly){$requiredInputs+=@('MacDmg', 'MacDistributionManifest', 'MacUpdateZip')}
    foreach ($required in $requiredInputs) {
        if ([string]::IsNullOrWhiteSpace((Get-Variable -Name $required -ValueOnly))) { Fail "Plan action requires -$($required)." }
    }
    $version = Get-CoreVersion
    $isPrerelease=$version.Contains('-')
    if ($Channel -eq 'stable' -and $isPrerelease) { Fail 'Stable publication requires a final version in Cargo.toml.' }
    if(@($WindowsOnlineBaseDirectories).Count -gt 12 -or ($LegacyUpdateBridge -and @($WindowsOnlineBaseDirectories).Count)){Fail 'Invalid online base selection or legacy bridge combination.'}
    $portableRoot = Assert-PlainPath $WindowsPortableDirectory $true
    if ($WindowsPortableZip) { $portableZip = Assert-PlainPath $WindowsPortableZip }
    $msiPath = Assert-PlainPath $WindowsMsi
    $msiManifestPath = Assert-PlainPath $WindowsMsiManifest
    if(-not $WindowsOnly){
        $dmgPath = Assert-PlainPath $MacDmg
        $macManifestPath = Assert-PlainPath $MacDistributionManifest
        $macUpdateZipPath = Assert-PlainPath $MacUpdateZip
    }
    $portableManifestPath = Assert-PlainPath (Join-Path $portableRoot 'distribution-manifest.json')
    $portableManifest = Read-JsonFile $portableManifestPath
    Assert-DistributionEnvelope $portableManifest 'codlet-portable-distribution' 'win-x64' $version
    if ($portableManifest.pluginDelivery -notin @('github-latest','installer-bundle')) { Fail 'Unsupported Windows plugin delivery.' }
    if ($portableManifest.pluginDelivery -eq 'installer-bundle') {
        if ($portableManifest.gui.sourceCommit -notmatch '^[0-9a-f]{40}$' -or $portableManifest.gui.version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { Fail 'Bundled GUI provenance is missing.' }
        $guiCatalog=Read-JsonFile (Join-Path $portableRoot 'optional-plugins/catalog.json')
        if ($guiCatalog.kind -ne 'codlet-official-plugin-bundle' -or $guiCatalog.schema -ne 1 -or @($guiCatalog.packages).Count -ne 1 -or $guiCatalog.packages[0].id -ne 'codlet-gui' -or $guiCatalog.packages[0].version -ne $portableManifest.gui.version -or $guiCatalog.sourceCommit -ne $portableManifest.gui.sourceCommit) { Fail 'Bundled GUI does not match the Windows distribution.' }
    }
    Assert-DirectoryManifestPayload $portableRoot $portableManifest
    if ($WindowsPortableZip) { Assert-PortableZip $portableZip $portableRoot $portableManifest }

    $msiManifest = Read-JsonFile $msiManifestPath
    Assert-DistributionEnvelope $msiManifest 'codlet-msi-distribution' 'win-x64' $version
    if ($msiManifest.sourceCommit -ne $portableManifest.sourceCommit) { Fail 'Windows MSI and portable builds come from different Core commits.' }
    if ($msiManifest.pluginDelivery -ne $portableManifest.pluginDelivery) { Fail 'MSI and portable plugin delivery differ.' }
    if ($msiManifest.pluginDelivery -eq 'installer-bundle' -and ($msiManifest.gui.version -ne $portableManifest.gui.version -or $msiManifest.gui.sourceCommit -ne $portableManifest.gui.sourceCommit)) { Fail 'MSI and portable GUI versions differ.' }
    $msiRoot = Split-Path -Parent $msiManifestPath
    Assert-DirectoryManifestPayload $msiRoot $msiManifest -FallbackDirectory $portableRoot
    $msiMetadataPath = Assert-PlainPath ($msiPath + '.json')
    $msiMetadata = Read-JsonFile $msiMetadataPath 128KB
    if ($msiMetadata.version -ne $version -or [long]$msiMetadata.bytes -ne (Get-Item -LiteralPath $msiPath).Length -or $msiMetadata.sha256 -ne (Get-Sha256 $msiPath)) {
        Fail 'MSI bytes do not match the build receipt or package version.'
    }

    $setupPath=Assert-PlainPath $WindowsSetup
    $setupReceipt=Read-JsonFile ($setupPath+'.json') 128KB
    if($setupReceipt.fixture -ne $false -or $setupReceipt.ui -ne 'native-wpf' -or $setupReceipt.version -ne $version -or
       $setupReceipt.payloadSha256 -ne $msiMetadata.sha256 -or $setupReceipt.sha256 -ne (Get-Sha256 $setupPath) -or
       [long]$setupReceipt.bytes -ne (Get-Item -LiteralPath $setupPath).Length){Fail 'Native installer receipt or embedded MSI identity does not match.'}
    if(-not $WindowsOnly){
    $macManifest = Read-JsonFile $macManifestPath
    Assert-DistributionEnvelope $macManifest 'codlet-macos-distribution' 'darwin-arm64' $version
    if ($macManifest.pluginDelivery -ne 'github-latest') { Fail 'Expected Core-only macOS distribution.' }
    if ($macManifest.sourceCommit.ToLowerInvariant() -ne $portableManifest.sourceCommit) { Fail 'macOS and Windows builds come from different Core commits.' }
    if ($null -eq $macManifest.dmg -or $macManifest.dmg.file -ne [IO.Path]::GetFileName($dmgPath) -or
        [long]$macManifest.dmg.bytes -ne (Get-Item -LiteralPath $dmgPath).Length -or $macManifest.dmg.sha256 -notmatch '^[0-9a-f]{64}$' -or
        (Get-Sha256 $dmgPath) -ne $macManifest.dmg.sha256) {
        Fail 'macOS DMG does not match its distribution manifest.'
    }
    Assert-MacUpdateZip $macUpdateZipPath $macManifest $version -LegacyBridge:$LegacyUpdateBridge
    }
    if ($LegacyUpdateBridge) { $bridgeNode = Assert-PlainPath $WindowsBridgeNodeDirectory $true }

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
        $assets.Add((Add-CopiedAsset $stage ("Codlet-$version-windows-x64-setup.exe") $setupPath 'windows-setup'))
        $verificationInputs = [ordered]@{
            windowsPortable = Add-VerificationInput $stage 'windows-portable-distribution-manifest.json' $portableManifestPath
            windowsMsi = Add-VerificationInput $stage 'windows-msi-distribution-manifest.json' $msiManifestPath
            windowsSetup = Add-VerificationInput $stage 'windows-setup-build.json' ($setupPath + '.json')
        }
        if(-not $WindowsOnly){
            $assets.Add((Add-CopiedAsset $stage ("Codlet-$version-macos-arm64.dmg") $dmgPath 'macos-dmg'))
            $verificationInputs.macos=Add-VerificationInput $stage 'macos-distribution-manifest.json' $macManifestPath
            $assets.Add((Add-CopiedAsset $stage ("Codlet-$version-darwin-arm64-update.zip") $macUpdateZipPath 'runtime-update-macos-app'))
        }

        $runtimeBuild = Join-Path $stage '.runtime-update-build'
        $builder = Join-Path $PSScriptRoot 'Build-RuntimeUpdate.ps1'
        if (-not (Test-Path -LiteralPath $builder)) { Fail 'Build-RuntimeUpdate.ps1 is missing.' }
        $buildArguments = @{ InputDirectory = $portableRoot; PayloadProfile = 'portable'; Version = $version; Channel = $Channel; OutputDirectory = $runtimeBuild }
        if ($LegacyUpdateBridge) { $buildArguments.LegacyBundledBridgeNodeDirectory = $bridgeNode }
        $buildResult = & $builder @buildArguments
        if ($null -eq $buildResult -or -not $buildResult.archive) { Fail 'Runtime update packager did not return an archive.' }
        Assert-WindowsUpdateZip $buildResult.archive $version -LegacyBridge:$LegacyUpdateBridge
        $runtimeAssetName = "codlet-runtime-$version-win-x64-portable.zip"
        $assets.Add((Add-CopiedAsset $stage $runtimeAssetName $buildResult.archive 'runtime-update-windows-portable'))
        [IO.Directory]::Delete((Assert-OutputStage $runtimeBuild $stage), $true)

        $runtimeAsset = $assets | Where-Object { $_.name -eq $runtimeAssetName }
        $channelManifest = [ordered]@{
            schema = 1
            kind = 'codlet-runtime-channel'
            channel = $Channel
            version = $version
            artifacts = @([ordered]@{
                platform = 'win-x64'
                profile = 'portable'
                bytes = [long]$runtimeAsset.bytes
                sha256 = $runtimeAsset.sha256
                assetName = $runtimeAssetName
            })
        }
        if(-not $WindowsOnly){
            $channelManifest.artifacts+=@([ordered]@{
                platform = 'darwin-arm64'
                profile = 'macApp'
                bytes = [long](@($assets | Where-Object { $_.name -eq "Codlet-$version-darwin-arm64-update.zip" })[0].bytes)
                sha256 = [string](@($assets | Where-Object { $_.name -eq "Codlet-$version-darwin-arm64-update.zip" })[0].sha256)
                assetName = "Codlet-$version-darwin-arm64-update.zip"
            })
        }
        # The shipped runtime/update-channel.json pins this stable asset name;
        # only the manifest's channel/version vary across Preview releases.
        $channelName = 'codlet-update-managed.json'
        Write-Utf8 (Join-Path $stage $channelName) (($channelManifest | ConvertTo-Json -Depth 12) + "`n")
        $assets.Add((Add-GeneratedAsset $stage $channelName 'runtime-channel-manifest'))
        $onlineArtifacts=@();$onlineBuilds=@();$baseIdentities=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach($baseDirectory in $WindowsOnlineBaseDirectories){
            $onlineOutput=Join-Path $stage ('.online-build-'+[Guid]::NewGuid().ToString('N'))
            $onlineArguments=@{BaseDirectory=$baseDirectory;Version=$version;Channel=$Channel;OutputDirectory=$onlineOutput}
            if($OnlineModuleIds){$onlineArguments.ModuleIds=$OnlineModuleIds}
            $built=& (Join-Path $PSScriptRoot 'Build-OnlineRuntime.ps1') @onlineArguments
            if(-not $baseIdentities.Add($built.residentSha256)){Fail 'Duplicate online resident identity.'}
            if($built.eligible){
                $onlineName=[IO.Path]::GetFileName($built.archive)
                Assert-WindowsUpdateZip $built.archive $version -ResidentSha256 $built.residentSha256
                $onlineAsset=Add-CopiedAsset $stage $onlineName $built.archive 'runtime-update-windows-online'
                $assets.Add($onlineAsset)
                $onlineArtifacts+=@([ordered]@{platform='win-x64';profile='portable';residentSha256=$built.residentSha256;bytes=[long]$onlineAsset.bytes;sha256=$onlineAsset.sha256;assetName=$onlineName})
                $onlineBuilds+=@([ordered]@{baseVersion=$built.baseVersion;residentSha256=$built.residentSha256;eligible=$true;assetName=$onlineName})
            }else{$onlineBuilds+=@([ordered]@{baseVersion=$built.baseVersion;residentSha256=$built.residentSha256;eligible=$false;reason=$built.reason})}
            [IO.Directory]::Delete((Assert-OutputStage $onlineOutput $stage),$true)
        }
        $catalog=[ordered]@{schema=2;kind='codlet-runtime-channel';channel=$Channel;version=$version;artifacts=@($channelManifest.artifacts)+$onlineArtifacts}
        Write-Utf8 (Join-Path $stage 'codlet-update-managed-v2.json') (($catalog|ConvertTo-Json -Depth 12)+"`n")
        $assets.Add((Add-GeneratedAsset $stage 'codlet-update-managed-v2.json' 'runtime-channel-manifest-v2'))
        if ($LegacyUpdateBridge) {
            $legacyChannelName = 'codlet-update.json'
            Write-Utf8 (Join-Path $stage $legacyChannelName) (($channelManifest | ConvertTo-Json -Depth 12) + "`n")
            $assets.Add((Add-GeneratedAsset $stage $legacyChannelName 'legacy-runtime-channel-manifest'))
        }

        $sumLines = @($assets | Sort-Object name | ForEach-Object { "$($_.sha256)  $($_.name)" })
        $sumName = 'SHA256SUMS.txt'
        Write-Utf8 (Join-Path $stage $sumName) (($sumLines -join "`n") + "`n")
        $assets.Add((Add-GeneratedAsset $stage $sumName 'sha256-summary'))

        $notesLines = @(
            "# Codlet $version",
            '',
            "Built from Core commit ``$($portableManifest.sourceCommit)``.",
            '',
            '## Downloads',
            '',
            "- **[Windows x64 installer](https://github.com/$Repository/releases/download/v$version/Codlet-$version-windows-x64-setup.exe)** - native Codlet UI, install scope, folder picker, shortcut and PATH options.",
            $(if(-not $WindowsOnly){"- **[Apple Silicon DMG](https://github.com/$Repository/releases/download/v$version/Codlet-$version-macos-arm64.dmg)** - drag Codlet.app to Applications."}else{'This release provides Windows builds only; it does not update macOS installations.'}),
            '',
            ('Use the installer above for Windows installation and upgrades. The update ZIPs and `codlet-update-managed.json` support {0}. `SHA256SUMS.txt` lists download checksums.' -f $(if($WindowsOnly){'existing Windows portable installations'}else{'existing portable and macOS installations'})),
            $(if ($LegacyUpdateBridge) { 'This transition release also provides `codlet-update.json` and full updater payloads so Preview 5 can upgrade. New installations use the smaller packages; later updates use the managed-runtime channel.' } else { 'Node is prepared automatically from a verified official-client runtime or the pinned fallback download, then reused from the managed cache.' }),
            '',
            '## Features',
            '',
            '- A shared Host/renderer plugin lifecycle with explicit permissions, capabilities, cancellation and diagnostics.',
            '- Optional Desktop/UI adapters and a GUI for plugin discovery, installation, updates and management; CLI and runtime skill work independently.',
            '- Native installation follows system appearance and language, with user or machine scope, shortcuts and optional PATH entries.',
            '- Run the setup EXE to upgrade installed Windows versions, including earlier MSI installations. The installer shows the installed and target versions and keeps the existing folder, scope and options. Compatible online runtime updates can activate without restarting Core; updates that change resident files require the installer for MSI installations.',
            '- Installation and startup ask you to save and quit existing clients yourself, then check again or cancel. They do not send close requests.',
            '- After a successful interactive Windows uninstall, optionally remove only the listed Codlet data for the current user. Data is retained by default; official Codex data, custom homes, external sources and unknown files are preserved.',
            '',
            '## Signing and verification',
            '',
            $(if($WindowsOnly){'Windows packages are unsigned. Review `SHA256SUMS.txt` before use.'}else{'Windows packages are unsigned. The macOS app is ad-hoc signed for bundle integrity. It is not Developer ID signed or notarized. Review `SHA256SUMS.txt` before use.'}),
            'Fully quit the extended client before opening an official-only session or restarting after a Core crash.',
            '',
            'See [known issues](https://github.com/baoabaob/codlet/blob/main/docs/known-issues.md) and [release readiness](https://github.com/baoabaob/codlet/blob/main/docs/release-readiness.md) for platform evidence and remaining acceptance limits.'
        )
        $notes = ($notesLines -join "`n") + "`n"
        Write-Utf8 (Join-Path $stage 'release-notes.md') $notes
        $notesPath = Join-Path $stage 'release-notes.md'

        $plan = [ordered]@{
            schema = 1
            kind = 'codlet-core-release-plan'
            repository = $Repository
            version = $version
            tag = 'v' + $version
            channel = $Channel
            prerelease = $isPrerelease
            onlineBuilds = $onlineBuilds
            legacyUpdateBridge = [bool]$LegacyUpdateBridge
            windowsOnly = [bool]$WindowsOnly
            sourceCommit = $portableManifest.sourceCommit
            pluginDelivery = $portableManifest.pluginDelivery
            releaseName = "Codlet $version"
            releaseNotesFile = 'release-notes.md'
            releaseNotesBytes = [long](Get-Item -LiteralPath $notesPath).Length
            releaseNotesSha256 = Get-Sha256 $notesPath
            verificationInputs = $verificationInputs
            assets = @($assets | Sort-Object name)
        }
        Write-Utf8 (Join-Path $stage 'release-plan.json') (($plan | ConvertTo-Json -Depth 20) + "`n")
        [IO.Directory]::Move($stage, $output)
        $report = [ordered]@{
            action = 'Plan'
            outputDirectory = $output
            version = $version
            tag = $plan.tag
            prerelease = $isPrerelease
            updaterPlatforms = @($channelManifest.artifacts | ForEach-Object { $_.platform })
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
    if ($plan.schema -ne 1 -or $plan.kind -ne 'codlet-core-release-plan' -or $plan.channel -notin @('stable','preview') -or $plan.prerelease -isnot [bool]) { Fail 'Expected a Codlet Core release plan.' }
    Assert-Version ([string]$plan.version) | Out-Null
    if (($plan.channel -eq 'stable' -and $plan.version -notmatch '^\d+\.\d+\.\d+$') -or $plan.prerelease -ne $plan.version.Contains('-')) { Fail 'Release channel and prerelease version disagree.' }
    if ($plan.tag -ne ('v' + $plan.version) -or $plan.repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or
        $plan.sourceCommit -notmatch '^[0-9a-f]{40}$' -or $plan.pluginDelivery -notin @('github-latest','installer-bundle')) { Fail 'Release plan version, repository or provenance is invalid.' }
    if ($plan.assets -isnot [System.Array] -or $plan.assets.Count -lt 4 -or $plan.assets.Count -gt 128) { Fail 'Release plan asset list is empty or too large.' }
    $root = Split-Path -Parent $planPath
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($asset in $plan.assets) {
        if ($asset.name -ne $asset.file -or -not $seen.Add([string]$asset.name) -or [long]$asset.bytes -le 0 -or
            $asset.bytes -gt $script:assetLimit -or $asset.sha256 -notmatch '^[0-9a-f]{64}$') { Fail 'Release plan contains a duplicate or invalid asset record.' }
        $file = Resolve-PlanAsset $root ([string]$asset.file)
        if ((Get-Item -LiteralPath $file).Length -ne [long]$asset.bytes -or (Get-Sha256 $file) -ne $asset.sha256) { Fail "Release asset differs from the saved plan: $($asset.name)" }
    }
    if (@($plan.assets | Where-Object { $_.name -match '-distribution-manifest\.json$' -or $_.kind -in @('windows-portable-manifest', 'windows-msi-manifest', 'macos-manifest') }).Count -ne 0) {
        Fail 'Build-time distribution manifests must not be public release assets.'
    }
    $setupAssets = @($plan.assets | Where-Object { $_.kind -eq 'windows-setup' -and $_.name -eq "Codlet-$($plan.version)-windows-x64-setup.exe" })
    if ($setupAssets.Count -ne 1 -or @($plan.assets | Where-Object { $_.name -match '\.msi$|-windows-[^-]+-portable\.zip$' -or $_.kind -in @('windows-msi', 'windows-portable') }).Count -ne 0) {
        Fail 'Windows installation downloads must contain exactly the setup EXE, without standalone MSI or portable packages.'
    }
    $windowsOnlyPlan=$plan.PSObject.Properties['windowsOnly'] -and $plan.windowsOnly -eq $true
    $expectedInputs=if($windowsOnlyPlan){3}else{4}
    if ($null -eq $plan.verificationInputs -or @($plan.verificationInputs.PSObject.Properties).Count -ne $expectedInputs) {
        Fail 'Release plan must retain the local manifests for exactly its selected platforms.'
    }
    $macManifestPath = $null
    foreach ($spec in @(
        @{ key = 'windowsPortable'; file = '.verification/windows-portable-distribution-manifest.json' },
        @{ key = 'windowsMsi'; file = '.verification/windows-msi-distribution-manifest.json' },
        @{ key = 'windowsSetup'; file = '.verification/windows-setup-build.json' },
        @{ key = 'macos'; file = '.verification/macos-distribution-manifest.json' }
    )) {
        if($spec.key -eq 'macos' -and $windowsOnlyPlan){continue}
        $record = $plan.verificationInputs.($spec.key)
        if ($null -eq $record -or $record.file -ne $spec.file -or [long]$record.bytes -le 0 -or $record.sha256 -notmatch '^[0-9a-f]{64}$') {
            Fail "Invalid local release verification input: $($spec.key)"
        }
        $file = Assert-PlainPath (Join-Path $root $spec.file)
        if ((Get-Item -LiteralPath $file).Length -ne [long]$record.bytes -or (Get-Sha256 $file) -ne $record.sha256) {
            Fail "Local release verification input changed: $($spec.key)"
        }
        if ($spec.key -eq 'macos') { $macManifestPath = $file }
        if ($spec.key -eq 'windowsSetup') {
            $receipt = Read-JsonFile $file 128KB
            if ($receipt.fixture -ne $false -or $receipt.ui -ne 'native-wpf' -or $receipt.version -ne $plan.version -or
                $receipt.sha256 -ne $setupAssets[0].sha256 -or [long]$receipt.bytes -ne [long]$setupAssets[0].bytes -or
                $receipt.payloadSha256 -notmatch '^[0-9a-f]{64}$') { Fail 'Saved native installer receipt differs from the release asset.' }
        }
    }
    if (-not $plan.PSObject.Properties['legacyUpdateBridge'] -or $plan.legacyUpdateBridge -isnot [bool]) { Fail 'Release plan must identify whether this is a legacy update bridge.' }
    $channelAsset = @($plan.assets | Where-Object { $_.name -eq 'codlet-update-managed.json' })
    if ($channelAsset.Count -ne 1) { Fail 'Release plan must contain codlet-update-managed.json.' }
    $channel = Read-JsonFile (Resolve-PlanAsset $root 'codlet-update-managed.json') 256KB
    $legacyChannelAsset = @($plan.assets | Where-Object { $_.name -eq 'codlet-update.json' })
    if ($plan.legacyUpdateBridge) {
        if ($legacyChannelAsset.Count -ne 1 -or $legacyChannelAsset[0].sha256 -ne $channelAsset[0].sha256) {
            Fail 'The transition channels must reference the same legacy-compatible updater payloads.'
        }
    }
    elseif ($legacyChannelAsset.Count -ne 0) { Fail 'A managed-only release must not advertise its ZIPs to Preview 5.' }
    $expectedPlatforms=if($windowsOnlyPlan){1}else{2}
    if ($channel.schema -ne 1 -or $channel.kind -ne 'codlet-runtime-channel' -or $channel.channel -ne $plan.channel -or $channel.version -ne $plan.version -or $channel.artifacts.Count -ne $expectedPlatforms) { Fail 'Legacy channel manifest is not compatible with the runtime updater.' }
    foreach ($supported in @(@{ platform = 'win-x64'; profile = 'portable' }, @{ platform = 'darwin-arm64'; profile = 'macApp' })) {
        if($supported.platform -eq 'darwin-arm64' -and $windowsOnlyPlan){continue}
        $matches = @($channel.artifacts | Where-Object { $_.platform -eq $supported.platform -and $_.profile -eq $supported.profile })
        if ($matches.Count -ne 1) { Fail "Stable channel manifest must contain one $($supported.platform)/$($supported.profile) updater artifact." }
        $artifact = $matches[0]
        $zipRecords = @($plan.assets | Where-Object { $_.name -eq $artifact.assetName })
        if ($zipRecords.Count -ne 1 -or [long]$zipRecords[0].bytes -ne [long]$artifact.bytes -or $zipRecords[0].sha256 -ne $artifact.sha256 -or
            $artifact.bytes -le 0 -or $artifact.bytes -gt 512MB -or $artifact.sha256 -notmatch '^[0-9a-f]{64}$') {
            Fail "Stable channel manifest does not pin the exact $($supported.platform) updater ZIP asset."
        }
        $zipPath = Resolve-PlanAsset $root ([string]$artifact.assetName)
        if ($supported.platform -eq 'win-x64') {
            Assert-WindowsUpdateZip $zipPath ([string]$plan.version) -LegacyBridge:$plan.legacyUpdateBridge
        }
        else {
            $macManifest = Read-JsonFile $macManifestPath
            if ($macManifest.schema -ne 1 -or $macManifest.kind -ne 'codlet-macos-distribution' -or $macManifest.version -ne $plan.version -or
                $macManifest.platform -ne 'darwin-arm64' -or $macManifest.sourceCommit -ne $plan.sourceCommit -or $macManifest.pluginDelivery -ne 'github-latest') {
                Fail 'Saved macOS distribution manifest has different release provenance.'
            }
            Assert-MacUpdateZip $zipPath $macManifest ([string]$plan.version) -LegacyBridge:$plan.legacyUpdateBridge
        }
    }
    $catalogAssets=@($plan.assets|Where-Object {$_.name -eq 'codlet-update-managed-v2.json'})
    $onlineAssets=@($plan.assets|Where-Object {$_.kind -eq 'runtime-update-windows-online'})
    if($catalogAssets.Count -gt 1 -or ($onlineAssets.Count -and $catalogAssets.Count -ne 1) -or ($plan.PSObject.Properties['onlineBuilds'] -and $catalogAssets.Count -ne 1)){Fail 'Targeted online artifacts require exactly one v2 catalog.'}
    if($catalogAssets.Count -eq 1){
        $catalog=Read-JsonFile (Resolve-PlanAsset $root 'codlet-update-managed-v2.json') 256KB
        if($catalog.schema -ne 2 -or $catalog.kind -ne 'codlet-runtime-channel' -or $catalog.channel -ne $plan.channel -or $catalog.version -ne $plan.version -or @($catalog.artifacts).Count -ne ($expectedPlatforms+$onlineAssets.Count) -or @($catalog.artifacts).Count -gt 32){Fail 'Invalid targeted update catalog.'}
        $bases=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach($artifact in $catalog.artifacts){
            if($artifact.PSObject.Properties['residentSha256'] -and $artifact.residentSha256){
                if($artifact.platform -cne 'win-x64' -or $artifact.profile -cne 'portable' -or $artifact.residentSha256 -notmatch '^[0-9a-f]{64}$' -or -not $bases.Add($artifact.residentSha256)){Fail 'Invalid or duplicate targeted resident identity.'}
                $name='codlet-online-'+$plan.version+'-win-x64-'+$artifact.residentSha256.Substring(0,16)+'.zip'
                $selected=@($onlineAssets|Where-Object {$_.name -ceq $name})
                if($artifact.assetName -cne $name -or $selected.Count -ne 1 -or $selected[0].sha256 -cne $artifact.sha256 -or [long]$selected[0].bytes -ne [long]$artifact.bytes){Fail 'Targeted catalog differs from its verified ZIP.'}
                Assert-WindowsUpdateZip (Resolve-PlanAsset $root $name) $plan.version -ResidentSha256 $artifact.residentSha256
            }else{
                $full=@($channel.artifacts|Where-Object {$_.platform -ceq $artifact.platform -and $_.profile -ceq $artifact.profile})
                if($full.Count -ne 1 -or $full[0].assetName -cne $artifact.assetName -or $full[0].sha256 -cne $artifact.sha256 -or [long]$full[0].bytes -ne [long]$artifact.bytes){Fail 'The v2 catalog must retain the complete legacy packages.'}
            }
        }
        foreach($full in $channel.artifacts){if(@($catalog.artifacts|Where-Object {$_.platform -ceq $full.platform -and $_.profile -ceq $full.profile -and (-not $_.PSObject.Properties['residentSha256'] -or -not $_.residentSha256)}).Count -ne 1){Fail 'Duplicate or missing complete catalog package.'}}
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

function Ensure-ReleaseTag([string]$RepositoryName, [string]$Tag, [string]$SourceCommit) {
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
    if ($Release.tag_name -ne $Plan.tag -or $Release.name -ne $Plan.releaseName -or $Release.body -cne $Notes -or $Release.prerelease -ne $plan.prerelease) {
        Fail 'This tag already has different release content or channel; refusing to overwrite it.'
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
        return [ordered]@{ action = 'PrepareDraft'; tag = $plan.tag; repository = $plan.repository; prerelease = $plan.prerelease; assets = $plan.assets.Count; externalWrites = $false; applyRequired = $true }
    }
    Initialize-GitHubCredential
    $repository = Invoke-ReleaseApi GET ("/repos/$($plan.repository)")
    if ($repository.archived -or $repository.fork) { Fail 'Refusing an archived repository or fork.' }
    $release = Find-RemoteRelease $plan.repository $plan.tag
    if ($release) {
        Assert-ReleaseIdentity $release $plan $Loaded.Notes
        $tagCommit = Ensure-ReleaseTag $plan.repository $plan.tag $plan.sourceCommit
        $remoteByName = Assert-RemoteAssetSet $plan.repository $release $plan -AllowMissing
        if (-not $release.draft) {
            if ($remoteByName.Count -ne $plan.assets.Count) { Fail 'Published release is missing an expected asset; it will not be modified.' }
            return [ordered]@{ action = 'PrepareDraft'; tag = $plan.tag; releaseUrl = $release.html_url; draft = $false; prerelease = $plan.prerelease; alreadyComplete = $true; assets = $remoteByName.Count; externalWrites = $false }
        }
    }
    else {
        $tagCommit = Ensure-ReleaseTag $plan.repository $plan.tag $plan.sourceCommit
        $release = Invoke-ReleaseApi POST ("/repos/$($plan.repository)/releases") @{
            tag_name = $plan.tag; target_commitish = $plan.sourceCommit; name = $plan.releaseName; body = $Loaded.Notes; draft = $true; prerelease = $plan.prerelease
        }
        if (-not $release.id -or -not $release.draft -or $release.prerelease -ne $plan.prerelease) { Fail 'GitHub did not create the expected stable release draft.' }
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
        return [ordered]@{ action = 'Publish'; tag = $plan.tag; repository = $plan.repository; prerelease = $plan.prerelease; assets = $plan.assets.Count; externalWrites = $false; applyRequired = $true }
    }
    Initialize-GitHubCredential
    $release = Find-RemoteRelease $plan.repository $plan.tag
    if (-not $release) { Fail 'Publish requires an already prepared draft release; no release was created.' }
    Assert-ReleaseIdentity $release $plan $Loaded.Notes
    $tagCommit = Get-RemoteTagCommit $plan.repository $plan.tag
    if ($tagCommit -ne $plan.sourceCommit) { Fail 'Release tag does not point to the exact Core source commit in the plan.' }
    $remoteByName = Assert-RemoteAssetSet $plan.repository $release $plan
    if ($release.draft) {
        $release = Invoke-ReleaseApi PATCH ("/repos/$($plan.repository)/releases/$($release.id)") @{ draft = $false; prerelease = $plan.prerelease }
    }
    if ($release.draft -or $release.prerelease -ne $plan.prerelease) { Fail 'GitHub did not publish the expected stable release.' }
    [ordered]@{ action = 'Publish'; tag = $plan.tag; releaseUrl = $release.html_url; draft = $false; prerelease = $plan.prerelease; assets = $remoteByName.Count; externalWrites = $true }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { Fail 'Repository must use owner/name form.' }
        if ($Action -eq 'Plan') {
            if ($Apply) { Fail '-Apply is only valid with PrepareDraft or Publish.' }
            New-ReleasePlan | Write-Output
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
