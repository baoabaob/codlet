[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InputDirectory,
    [Parameter(Mandatory = $true)][Alias('Profile')][ValidateSet('portable', 'isolatedClient')][string]$PayloadProfile,
    [Parameter(Mandatory = $true)][ValidatePattern('^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$')][string]$Version,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [ValidateSet('stable', 'preview')][string]$Channel = 'stable',
    [string]$ArtifactBaseUrl,
    [string]$MergeChannelManifest,
    [switch]$IncludeOtherExecutable
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = New-Object Text.UTF8Encoding($false)
$platform = 'win-x64'
if ($Channel -eq 'stable' -and ($Version -split '\+', 2)[0].Contains('-')) { throw 'Stable channels cannot publish prereleases.' }
function Absolute([string]$Value) { [IO.Path]::GetFullPath($Value).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) }
function Plain([string]$Value, [bool]$Directory = $false) {
    $selected = Absolute $Value
    $item = Get-Item -LiteralPath $selected -Force
    if ($Directory -ne [bool]$item.PSIsContainer) { throw "Expected an ordinary file/directory: $selected" }
    for ($current = $selected; $current; $current = [IO.Path]::GetDirectoryName($current)) {
        if (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse paths are forbidden: $current" }
    }
    if (-not $Directory -and $item.Length -gt 512MB) { throw 'Runtime file exceeds 512 MiB.' }
    $selected
}
function Hash([string]$Value) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Value)
    try { [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
function X64([string]$Value) {
    $file = [IO.File]::OpenRead((Plain $Value))
    try {
        $head = New-Object byte[] 64
        if ($file.Read($head, 0, 64) -ne 64 -or $head[0] -ne 77 -or $head[1] -ne 90) { throw 'Runtime input is not a PE executable.' }
        $offset = [BitConverter]::ToUInt32($head, 60)
        if ($offset -lt 64 -or $offset -gt 1MB -or $offset + 6 -gt $file.Length) { throw 'Invalid runtime PE header.' }
        $file.Position = $offset; $pe = New-Object byte[] 6
        if ($file.Read($pe, 0, 6) -ne 6 -or $pe[0] -ne 80 -or $pe[1] -ne 69 -or $pe[2] -ne 0 -or $pe[3] -ne 0 -or [BitConverter]::ToUInt16($pe, 4) -ne 34404) { throw 'Runtime updater supports Windows x64 executables.' }
    } finally { $file.Dispose() }
}
$inputRoot = Plain $InputDirectory $true
$outputRoot = Absolute $OutputDirectory
if (Test-Path -LiteralPath $outputRoot) { throw 'OutputDirectory must be a fresh directory; nothing was replaced.' }
$parent = [IO.Path]::GetDirectoryName($outputRoot)
if (-not $parent) { throw 'OutputDirectory must not be a drive root.' }
$null = [IO.Directory]::CreateDirectory($parent)
$null = Plain $parent $true
$pinPath = Plain (Join-Path $inputRoot 'runtime/node-runtime.json')
if ((Get-Item -LiteralPath $pinPath).Length -gt 64KB) { throw 'Node pin metadata is too large.' }
$pin = [IO.File]::ReadAllText($pinPath) | ConvertFrom-Json
if ($pin.schema -ne 1 -or $pin.version -notmatch '^[0-9A-Za-z.-]{1,64}$' -or $pin.version.Contains('..')) { throw 'Invalid Node runtime pin.' }
$node = $pin.platforms.$platform
if ($node.executableSha256 -notmatch '^[0-9a-f]{64}$' -or $node.licenseSha256 -notmatch '^[0-9a-f]{64}$') { throw 'Node executable/license must be pinned.' }
$nodeDirectory = 'runtime/node-v' + $pin.version + '-' + $platform
$executable = if ($PayloadProfile -eq 'portable') { 'codlet.exe' } else { 'codlet-lab.exe' }
$otherExecutable = if ($PayloadProfile -eq 'portable') { 'codlet-lab.exe' } else { 'codlet.exe' }
$files = @($executable, 'runtime/node-runtime.json', ($nodeDirectory + '/node.exe'), ($nodeDirectory + '/LICENSE'))
if ($IncludeOtherExecutable) { $files += $otherExecutable }
$files = @($files | Sort-Object)
$records = @()
$total = [long]0
foreach ($relative in $files) {
    $source = Plain (Join-Path $inputRoot $relative)
    if ($relative.EndsWith('.exe')) { X64 $source }
    $bytes = (Get-Item -LiteralPath $source).Length; $total += $bytes
    $records += [ordered]@{ path = $relative; bytes = $bytes; sha256 = Hash $source }
}
if ($total -gt 1GB) { throw 'Expanded runtime update exceeds 1 GiB.' }
if ((Hash (Join-Path $inputRoot ($nodeDirectory + '/node.exe'))) -ne $node.executableSha256 -or (Hash (Join-Path $inputRoot ($nodeDirectory + '/LICENSE'))) -ne $node.licenseSha256) { throw 'Node files differ from their pins.' }
if ($ArtifactBaseUrl) {
    $origin = New-Object Uri($ArtifactBaseUrl)
    if ($origin.Scheme -ne 'https' -or $origin.UserInfo -or $origin.Query -or $origin.Fragment) { throw 'ArtifactBaseUrl must be HTTPS without credentials/query/fragment.' }
}
$manifest = [ordered]@{
    schema = 1; kind = 'codlet-runtime-update'; version = $Version; platform = $platform; profile = $PayloadProfile
    runtime = [ordered]@{ version = $pin.version; executableSha256 = $node.executableSha256; licenseSha256 = $node.licenseSha256 }
    files = $records
}
$temporary = Join-Path $parent ('.codlet-runtime-publish-' + [Guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($temporary)
$zipName = 'codlet-' + $Version + '-' + $platform + '-' + $PayloadProfile + '.zip'
$zipPath = Join-Path $temporary $zipName
$manifestBytes = $utf8.GetBytes(($manifest | ConvertTo-Json -Depth 12) + "`n")
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($relative in $files) {
        $entry = $archive.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = New-Object DateTimeOffset(2000, 1, 1, 0, 0, 0, ([TimeSpan]::Zero))
        $source = [IO.File]::OpenRead((Join-Path $inputRoot $relative)); $target = $entry.Open()
        try { $source.CopyTo($target) } finally { $source.Dispose(); $target.Dispose() }
    }
    $entry = $archive.CreateEntry('runtime-update-manifest.json', [IO.Compression.CompressionLevel]::Optimal)
    $entry.LastWriteTime = New-Object DateTimeOffset(2000, 1, 1, 0, 0, 0, ([TimeSpan]::Zero))
    $target = $entry.Open(); try { $target.Write($manifestBytes, 0, $manifestBytes.Length) } finally { $target.Dispose() }
} finally { $archive.Dispose() }
$zipBytes = (Get-Item -LiteralPath $zipPath).Length
if ($zipBytes -gt 512MB) { throw 'Runtime update ZIP exceeds 512 MiB.' }
$zipHash = Hash $zipPath
$asset = [ordered]@{ platform = $platform; profile = $PayloadProfile; bytes = $zipBytes; sha256 = $zipHash; assetName = $zipName; url = $(if ($ArtifactBaseUrl) { $ArtifactBaseUrl.TrimEnd('/') + '/' + $zipName } else { $null }) }
$artifacts = @($asset)
if ($MergeChannelManifest) {
    $priorPath = Plain $MergeChannelManifest
    if ((Get-Item -LiteralPath $priorPath).Length -gt 256KB) { throw 'Previous channel manifest is too large.' }
    $prior = [IO.File]::ReadAllText($priorPath) | ConvertFrom-Json
    if ($prior.schema -ne 1 -or $prior.kind -ne 'codlet-runtime-channel' -or $prior.channel -ne $Channel -or $prior.version -ne $Version -or @($prior.artifacts).Count -gt 7) { throw 'Merge manifest must describe the same release version and channel.' }
    foreach ($existing in @($prior.artifacts)) {
        if ($existing.platform -ne $platform -or $existing.profile -notin @('portable', 'isolatedClient') -or $existing.profile -eq $PayloadProfile -or $existing.bytes -le 0 -or $existing.bytes -gt 512MB -or $existing.sha256 -notmatch '^[0-9a-f]{64}$' -or $existing.assetName -notmatch '^[0-9A-Za-z._-]+\.zip$') { throw 'Merge manifest has an invalid or duplicate profile artifact.' }
    }
    $artifacts = @($prior.artifacts) + @($asset)
}
$release = [ordered]@{ schema = 1; kind = 'codlet-runtime-channel'; channel = $Channel; version = $Version; artifacts = $artifacts }
[IO.File]::WriteAllText((Join-Path $temporary ('codlet-update-' + $Channel + '.json')), ($release | ConvertTo-Json -Depth 12) + "`n", $utf8)
[IO.File]::WriteAllText((Join-Path $temporary ($zipName + '.sha256')), $zipHash + '  ' + $zipName + "`n", $utf8)
[IO.File]::WriteAllBytes((Join-Path $temporary 'runtime-update-manifest.json'), $manifestBytes)
[IO.Directory]::Move($temporary, $outputRoot)
[pscustomobject]@{ outputDirectory = $outputRoot; archive = (Join-Path $outputRoot $zipName); bytes = $zipBytes; sha256 = $zipHash; channelManifest = (Join-Path $outputRoot ('codlet-update-' + $Channel + '.json')); published = $false }
