[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $PluginDirectory,
    [Parameter(Mandatory = $true)][string] $OutputPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path -LiteralPath $PluginDirectory).ProviderPath.TrimEnd('\', '/')
function FileSha256([string] $Path) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) { throw 'PluginDirectory must be a prepared plugin directory.' }
$destination = [IO.Path]::GetFullPath($OutputPath)
if (-not $destination.EndsWith('.zip', [StringComparison]::OrdinalIgnoreCase)) { throw 'OutputPath must end in .zip.' }
if ($destination.StartsWith($sourceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Place the ZIP outside the plugin directory.' }
if (Test-Path -LiteralPath $destination) { throw 'OutputPath already exists; choose a new package filename.' }
if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'codlet.json') -PathType Leaf)) { throw 'The ZIP root must contain codlet.json.' }
$directories = [Collections.Generic.Stack[object]]::new()
$directories.Push([pscustomobject]@{ FullName = $sourceRoot; EntryName = '' })
$files = [Collections.Generic.List[object]]::new()
$names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
[long] $totalBytes = 0
[int] $entryCount = 0
while ($directories.Count -gt 0) {
    $directory = $directories.Pop()
    $directoryInfo = Get-Item -LiteralPath $directory.FullName -Force
    if (($directoryInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Links and junctions are not package inputs: $($directory.FullName)" }
    foreach ($item in (Get-ChildItem -LiteralPath $directory.FullName -Force)) {
        $entryCount++
        if ($entryCount -gt 2048) { throw 'Prepared package exceeds 2048 entries.' }
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Links and junctions are not package inputs: $($item.FullName)" }
        $relative = if ([string]::IsNullOrEmpty($directory.EntryName)) { $item.Name } else { $directory.EntryName + '/' + $item.Name }
        if ($relative -eq '.codlet-source.json' -or $relative -match '(^|/)(\.git|node_modules)(/|$)') { throw "Use a dedicated prepared release directory; excluded input: $relative" }
        if (-not $names.Add($relative)) { throw "Duplicate package path: $relative" }
        if ($item.PSIsContainer) { $directories.Push([pscustomobject]@{ FullName = $item.FullName; EntryName = $relative }); continue }
        $totalBytes += $item.Length
        if ($totalBytes -gt 64MB) { throw 'Prepared package exceeds 64 MiB.' }
        $files.Add([pscustomobject]@{ FullName = $item.FullName; EntryName = $relative })
    }
}
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
Add-Type -AssemblyName System.IO.Compression
$stream = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
$archive = $null
$complete = $false
try {
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
    foreach ($file in ($files | Sort-Object EntryName)) {
        $entry = $archive.CreateEntry($file.EntryName, [IO.Compression.CompressionLevel]::Optimal)
        $inputStream = [IO.File]::OpenRead($file.FullName)
        $outputStream = $entry.Open()
        try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
    }
    $archive.Dispose(); $archive = $null
    $stream.Dispose()
    if ((Get-Item -LiteralPath $destination).Length -gt 32MB) { throw 'Compressed package exceeds 32 MiB.' }
    $complete = $true
} finally {
    if ($null -ne $archive) { $archive.Dispose() }
    $stream.Dispose()
    if (-not $complete) { Remove-Item -LiteralPath $destination -Force }
}
[pscustomobject]@{ Package = $destination; Files = $files.Count; SourceBytes = $totalBytes; Sha256 = (FileSha256 $destination) } | ConvertTo-Json
