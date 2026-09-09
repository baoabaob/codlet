[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$CodletExecutable,
    [string]$OutputDirectory,
    [string]$NodeDirectory,
    [string]$NodeArchivePath,
    [ValidatePattern('^[0-9a-fA-F]{7,64}$')][string]$SourceCommit,
    [switch]$Zip
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This distribution script currently supports Windows x64.'
}
if ($NodeDirectory -and $NodeArchivePath) { throw 'Choose NodeDirectory or NodeArchivePath, not both.' }

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$utf8 = New-Object Text.UTF8Encoding($false)
$platform = 'win-x64'
$stage = $null
$stageFiles = New-Object 'Collections.Generic.List[string]'
$stageDirectories = New-Object 'Collections.Generic.List[string]'
$temporaryZip = $null

function Get-AbsolutePath([string]$Path) {
    [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Assert-NoReparseAncestor([string]$Path) {
    $selected = Get-AbsolutePath $Path
    while ($selected) {
        if (Test-Path -LiteralPath $selected) {
            if (([IO.File]::GetAttributes($selected) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Reparse points are not accepted in distribution paths: $selected"
            }
        }
        $selected = [IO.Path]::GetDirectoryName($selected)
    }
}

function Assert-OrdinaryFile([string]$Path) {
    Assert-NoReparseAncestor $Path
    if (-not [IO.File]::Exists($Path)) { throw "Missing ordinary file: $Path" }
}

function Assert-Within([string]$Path, [string]$Root) {
    $candidate = Get-AbsolutePath $Path
    $container = Get-AbsolutePath $Root
    if (-not $candidate.StartsWith($container + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the owned distribution directory: $candidate"
    }
}

function Get-Sha256([string]$Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-PackageVersion {
    $cargo = Join-Path $repositoryRoot 'Cargo.toml'
    $prior = Join-Path $repositoryRoot 'distribution-manifest.json'
    if ([IO.File]::Exists($cargo)) {
        Assert-OrdinaryFile $cargo
        $package = [regex]::Match([IO.File]::ReadAllText($cargo), '(?ms)^\[package\]\s*(.*?)(?=^\[|\z)').Groups[1].Value
        $version = [regex]::Match($package, '(?m)^\s*version\s*=\s*"([^"]+)"\s*$').Groups[1].Value
    } elseif ([IO.File]::Exists($prior)) {
        Assert-OrdinaryFile $prior
        $manifest = [IO.File]::ReadAllText($prior) | ConvertFrom-Json
        if ($manifest.schema -ne 1 -or $manifest.kind -ne 'codlet-portable-distribution') { throw 'Unrecognized distribution manifest.' }
        $version = [string]$manifest.version
    } else { throw 'Cannot determine package version from Cargo.toml or distribution-manifest.json.' }
    if ($version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$') { throw 'Invalid Codlet package version.' }
    $version
}

function Assert-X64Executable([string]$Path) {
    Assert-OrdinaryFile $Path
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $header = New-Object byte[] 64
        if ($stream.Read($header, 0, 64) -ne 64 -or $header[0] -ne 77 -or $header[1] -ne 90) { throw 'Codlet input is not a PE executable.' }
        $offset = [BitConverter]::ToUInt32($header, 60)
        if ($offset -lt 64 -or $offset -gt 1048576 -or $offset + 6 -gt $stream.Length) { throw 'Invalid PE header offset.' }
        $stream.Position = $offset
        $pe = New-Object byte[] 6
        if ($stream.Read($pe, 0, 6) -ne 6 -or $pe[0] -ne 80 -or $pe[1] -ne 69 -or $pe[2] -ne 0 -or $pe[3] -ne 0 -or [BitConverter]::ToUInt16($pe, 4) -ne 34404) {
            throw 'The portable bundle requires a Windows x64 Codlet executable.'
        }
    } finally { $stream.Dispose() }
}

function New-StageParent([string]$Path) {
    Assert-Within $Path $stage
    $parent = [IO.Path]::GetDirectoryName($Path)
    while ($parent -ne $stage -and $parent) {
        Assert-Within $parent $stage
        if (-not $stageDirectories.Contains($parent)) { $stageDirectories.Add($parent) }
        $parent = [IO.Path]::GetDirectoryName($parent)
    }
    $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path))
}

function Copy-StageFile([string]$Source, [string]$Relative) {
    Assert-OrdinaryFile $Source
    $target = Join-Path $stage $Relative
    New-StageParent $target
    $inputStream = [IO.File]::Open($Source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $outputStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $stageFiles.Add($target)
        try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
    } finally { $inputStream.Dispose() }
}

function Write-StageText([string]$Relative, [string]$Text) {
    $target = Join-Path $stage $Relative
    New-StageParent $target
    $stream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $stageFiles.Add($target)
    try {
        $bytes = $utf8.GetBytes($Text)
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
}

function Assert-Runtime([string]$Directory) {
    foreach ($entry in @(@('node.exe', $runtimeSpec.executableSha256), @('LICENSE', $runtimeSpec.licenseSha256))) {
        $path = Join-Path $Directory $entry[0]
        Assert-OrdinaryFile $path
        if ((Get-Sha256 $path) -ne $entry[1]) { throw "Managed runtime $($entry[0]) differs from its checked-in SHA256 pin: $path" }
    }
}

function Assert-DocumentLinks([string[]]$RelativePaths) {
    foreach ($relative in $RelativePaths) {
        if (-not $relative.EndsWith('.md', [StringComparison]::OrdinalIgnoreCase)) { continue }
        $file = Join-Path $stage $relative
        foreach ($match in [regex]::Matches([IO.File]::ReadAllText($file), '\]\(([^)]+)\)')) {
            $link = $match.Groups[1].Value.Trim('<', '>')
            if ($link -match '^[A-Za-z][A-Za-z0-9+.-]*:' -or $link.StartsWith('#')) { continue }
            $link = [Uri]::UnescapeDataString(($link -split '#', 2)[0])
            if (-not $link) { continue }
            $target = Get-AbsolutePath (Join-Path ([IO.Path]::GetDirectoryName($file)) $link)
            Assert-Within $target $stage
            if (-not (Test-Path -LiteralPath $target)) { throw "Unpackaged relative documentation link in ${relative}: $link" }
        }
    }
}

function New-PortableZip([string]$Path, [string[]]$RelativePaths) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::Open($Path, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($relative in $RelativePaths) {
            $entry = $archive.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
            $entry.LastWriteTime = New-Object DateTimeOffset(2000, 1, 1, 0, 0, 0, ([TimeSpan]::Zero))
            $inputStream = [IO.File]::OpenRead((Join-Path $stage $relative))
            $outputStream = $entry.Open()
            try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
        }
    } finally { $archive.Dispose() }
}

$version = Get-PackageVersion
$pinPath = Join-Path $repositoryRoot 'runtime/node-runtime.json'
Assert-OrdinaryFile $pinPath
$runtimePin = [IO.File]::ReadAllText($pinPath) | ConvertFrom-Json
$runtimeSpec = $runtimePin.platforms.$platform
if ($runtimePin.schema -ne 1 -or $runtimeSpec.executableSha256 -notmatch '^[0-9a-f]{64}$' -or $runtimeSpec.licenseSha256 -notmatch '^[0-9a-f]{64}$') {
    throw 'The Windows x64 runtime pin must include valid executable and LICENSE SHA256 values.'
}
$CodletExecutable = Get-AbsolutePath $CodletExecutable
Assert-X64Executable $CodletExecutable
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repositoryRoot ('.codlet-artifacts/distributions/codlet-' + $version + '-' + $platform) }
$distributionRoot = Get-AbsolutePath $OutputDirectory
$distributionParent = [IO.Path]::GetDirectoryName($distributionRoot)
if (-not $distributionParent -or -not [IO.Path]::GetFileName($distributionRoot)) { throw 'OutputDirectory must name a new directory, not a drive root.' }
Assert-NoReparseAncestor $distributionRoot
if (Test-Path -LiteralPath $distributionRoot) { throw "Output already exists; use a fresh directory. Nothing was replaced: $distributionRoot" }
$zipPath = if ($Zip) { $distributionRoot + '.zip' } else { $null }
if ($zipPath -and (Test-Path -LiteralPath $zipPath)) { throw "ZIP output already exists; nothing was replaced: $zipPath" }
$null = [IO.Directory]::CreateDirectory($distributionParent)
Assert-NoReparseAncestor $distributionParent
$stage = Join-Path $distributionParent ('.codlet-package-' + [Guid]::NewGuid().ToString('N'))
Assert-Within $stage $distributionParent
if (Test-Path -LiteralPath $stage) { throw 'The generated staging directory already exists.' }
$null = [IO.Directory]::CreateDirectory($stage)

# This is the complete source-file allowlist. No recursive source/cache/config copy.
$sourceFiles = @(
    'scripts/Build-Distribution.ps1', 'scripts/Install-JsRuntime.ps1',
    'runtime/node-runtime.json', 'types/host.d.ts',
    'examples/raw-host/codlet.json', 'examples/raw-host/dist/host.js', 'examples/raw-host/README.md',
    'examples/cleanup-host/codlet.json', 'examples/cleanup-host/dist/host.js', 'examples/cleanup-host/README.md',
    'docs/DISTRIBUTION.md', 'docs/JS_PLUGIN_RUNTIME_2026-09-09.md',
    'docs/M2A_HOST_RUNTIME_2026-09-09.md', 'docs/M2B_HOST_CONTROL_2026-09-10.md',
    'docs/GUI_REGISTRY_REPAIR_2026-09-09.md',
    'docs/HOST_CLEANUP_2026-09-10.md', 'docs/HOST_WATCH_2026-09-10.md',
    'docs/HOST_INSPECTION_2026-09-10.md', 'docs/HOST_DEVELOPMENT_2026-09-10.md'
)
$payload = New-Object 'Collections.Generic.List[string]'
try {
    Copy-StageFile $CodletExecutable 'codlet.exe'
    $payload.Add('codlet.exe')
    foreach ($relative in $sourceFiles) {
        Copy-StageFile (Join-Path $repositoryRoot $relative) $relative
        $payload.Add($relative)
    }
    $runtimeRelative = 'runtime/node-v' + $runtimePin.version + '-' + $platform
    $stagedRuntime = Join-Path $stage $runtimeRelative
    if ($NodeDirectory) {
        $NodeDirectory = Get-AbsolutePath $NodeDirectory
        Assert-Runtime $NodeDirectory
        foreach ($name in @('node.exe', 'LICENSE')) { Copy-StageFile (Join-Path $NodeDirectory $name) ($runtimeRelative + '/' + $name) }
    } else {
        # The installer extracts only the two members from the pinned official
        # archive. Its own finally removes download/extraction temporary files.
        foreach ($name in @('node.exe', 'LICENSE')) {
            $target = Join-Path $stagedRuntime $name
            New-StageParent $target
            $stageFiles.Add($target)
        }
        $arguments = @{ Destination = $stage; Platform = $platform }
        if ($NodeArchivePath) { $arguments.ArchivePath = Get-AbsolutePath $NodeArchivePath }
        $null = & (Join-Path $repositoryRoot 'scripts/Install-JsRuntime.ps1') @arguments
    }
    Assert-Runtime $stagedRuntime
    foreach ($name in @('node.exe', 'LICENSE')) { $payload.Add($runtimeRelative + '/' + $name) }
    $readme = @'
# Codlet portable directory

Keep codlet.exe and runtime/ together. From this directory in PowerShell:

```powershell
.\codlet.exe plugin add .\examples\cleanup-host
```

This command only inspects the candidate because no trust/grants are supplied.
Use [the development quickstart](docs/HOST_DEVELOPMENT_2026-09-10.md) for explicit
registration, launch/watch, inspection and disable steps. Packaging alone registers
no plugin and starts neither Codex nor Node. See [distribution details](docs/DISTRIBUTION.md).

The payload list and SHA256 values are in distribution-manifest.json. The packaging
script performs no signing or publication. Node's license is beside node.exe.
'@
    Write-StageText 'README.md' ($readme.Replace("`r`n", "`n") + "`n")
    $payload.Add('README.md')
    $payload.Sort([StringComparer]::Ordinal)
    Assert-DocumentLinks $payload.ToArray()
    $records = foreach ($relative in $payload) {
        $path = Join-Path $stage $relative
        [ordered]@{ path = $relative; bytes = (Get-Item -LiteralPath $path).Length; sha256 = Get-Sha256 $path }
    }
    $manifest = [ordered]@{
        schema = 1; kind = 'codlet-portable-distribution'; version = $version; platform = $platform
        sourceCommit = $(if ($SourceCommit) { $SourceCommit.ToLowerInvariant() } else { $null })
        runtime = [ordered]@{ name = 'node'; version = $runtimePin.version; executableSha256 = $runtimeSpec.executableSha256; licenseSha256 = $runtimeSpec.licenseSha256 }
        files = @($records)
    }
    Write-StageText 'distribution-manifest.json' (($manifest | ConvertTo-Json -Depth 8).Replace("`r`n", "`n") + "`n")
    $manifestHash = Get-Sha256 (Join-Path $stage 'distribution-manifest.json')
    if ($Zip) {
        $entries = New-Object 'Collections.Generic.List[string]'
        $entries.AddRange($payload.ToArray()); $entries.Add('distribution-manifest.json'); $entries.Sort([StringComparer]::Ordinal)
        $temporaryZip = Join-Path $distributionParent ('.codlet-package-' + [Guid]::NewGuid().ToString('N') + '.zip.tmp')
        Assert-Within $temporaryZip $distributionParent
        New-PortableZip $temporaryZip $entries.ToArray()
    }
    # Directory.Move cannot overwrite a concurrently created destination. ZIP is
    # prepared first; if its final move fails the complete directory remains usable.
    Assert-NoReparseAncestor $stage
    Assert-NoReparseAncestor $distributionParent
    Assert-Within $stage $distributionParent
    [IO.Directory]::Move($stage, $distributionRoot)
    if ($Zip) { [IO.File]::Move($temporaryZip, $zipPath) }
    [pscustomobject]@{
        Directory = $distributionRoot; Version = $version; Platform = $platform
        Manifest = Join-Path $distributionRoot 'distribution-manifest.json'; ManifestSha256 = $manifestHash
        Zip = $zipPath; ZipSha256 = $(if ($Zip) { Get-Sha256 $zipPath } else { $null })
    }
} finally {
    # Only remove exact files created under this invocation's verified staging
    # path, then empty directories. Never recursively delete or replace a target.
    if ($stage -and [IO.Directory]::Exists($stage)) {
        try {
            Assert-Within $stage $distributionParent
            Assert-NoReparseAncestor $stage
            foreach ($file in $stageFiles) {
                Assert-Within $file $stage
                Assert-NoReparseAncestor $file
                if ([IO.File]::Exists($file)) { Remove-Item -LiteralPath $file -Force }
            }
            foreach ($directory in @($stageDirectories | Sort-Object Length -Descending)) {
                if ([IO.Directory]::Exists($directory)) { [IO.Directory]::Delete($directory, $false) }
            }
            [IO.Directory]::Delete($stage, $false)
        } catch { Write-Warning "Owned staging directory retained for recovery: $stage. $($_.Exception.Message)" }
    }
    if ($temporaryZip -and [IO.File]::Exists($temporaryZip)) {
        Assert-Within $temporaryZip $distributionParent
        Assert-NoReparseAncestor $temporaryZip
        Remove-Item -LiteralPath $temporaryZip -Force
    }
}
