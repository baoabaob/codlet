[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Distribution,
    [Parameter(Mandatory = $true)][string]$ArtifactsDirectory,
    [string]$LegacyNodeDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($Distribution)
$output = [IO.Path]::GetFullPath($ArtifactsDirectory)
if (Test-Path -LiteralPath $output) { throw 'Use a fresh owned packaging fixture directory.' }
[IO.Directory]::CreateDirectory($output) | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Read-Entry([IO.Compression.ZipArchive]$Archive, [string]$Name) {
    $entry = $Archive.GetEntry($Name)
    if (-not $entry) { throw "Missing update ZIP entry: $Name" }
    $reader = [IO.StreamReader]::new($entry.Open(), [Text.Encoding]::UTF8)
    try { $reader.ReadToEnd() } finally { $reader.Dispose() }
}
function Check-Update([string]$ArchivePath, [bool]$Legacy, [string]$ExpectedVersion) {
    $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        $paths = @($archive.Entries | ForEach-Object { $_.FullName } | Sort-Object)
        $nodeBase = 'runtime/node-v' + $pin.version + '-win-x64'
        $expected = @('codlet.exe', 'runtime/node-runtime.json', 'runtime-update-manifest.json')
        if ($Legacy) { $expected += @(($nodeBase + '/node.exe'), ($nodeBase + '/LICENSE')) }
        Assert (($paths -join '|') -eq ((@($expected | Sort-Object)) -join '|')) 'Update ZIP has unexpected files'
        $update = Read-Entry $archive 'runtime-update-manifest.json' | ConvertFrom-Json
        $zipPin = Read-Entry $archive 'runtime/node-runtime.json' | ConvertFrom-Json
        Assert ($update.version -eq $ExpectedVersion -and $update.profile -eq 'portable') 'Update metadata has the wrong target'
        Assert (@($update.files).Count -eq ($expected.Count - 1)) 'Update metadata file count is wrong'
        foreach ($file in $update.files) {
            $entry = $archive.GetEntry($file.path)
            Assert ($null -ne $entry -and $entry.Length -eq $file.bytes) "Update record missing or wrong length: $($file.path)"
            $algorithm = [Security.Cryptography.SHA256]::Create()
            $stream = $entry.Open()
            try { $hash = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
            finally { $stream.Dispose(); $algorithm.Dispose() }
            Assert ($hash -eq $file.sha256) "Update record hash mismatch: $($file.path)"
        }
        if ($Legacy) {
            Assert (-not $update.runtime.PSObject.Properties['mode'] -and -not $zipPin.PSObject.Properties['mode']) 'Legacy bridge exposed a mode unknown to Preview5'
            Assert ($update.files.path -contains ($nodeBase + '/node.exe') -and $update.files.path -contains ($nodeBase + '/LICENSE')) 'Legacy bridge omitted pinned Node files'
        } else {
            Assert ($update.runtime.mode -eq 'managed' -and $zipPin.mode -eq 'managed') 'Managed update mode is missing'
            Assert (@($update.files.path | Where-Object { $_ -match '^runtime/node-v[^/]+/' }).Count -eq 0) 'Managed update bundles Node files'
        }
    } finally { $archive.Dispose() }
}
$manifest = [IO.File]::ReadAllText((Join-Path $root 'distribution-manifest.json')) | ConvertFrom-Json
$pin = [IO.File]::ReadAllText((Join-Path $root 'runtime/node-runtime.json')) | ConvertFrom-Json
Assert ($manifest.kind -eq 'codlet-portable-distribution' -and $manifest.platform -eq 'win-x64') 'Expected Windows portable distribution'
Assert ($manifest.runtime.mode -eq 'managed' -and $pin.mode -eq 'managed') 'Expected managed runtime distribution'
Assert (@($manifest.files.path | Where-Object { $_ -match '^runtime/node-v[^/]+/' }).Count -eq 0) 'Portable distribution bundles Node files'
$version = [string]$manifest.version
$managed = & (Join-Path $PSScriptRoot 'Build-RuntimeUpdate.ps1') -InputDirectory $root -PayloadProfile portable -Version $version -OutputDirectory (Join-Path $output 'managed') -Channel preview
Check-Update $managed.archive $false $version
$checks = @('managed portable and update ZIP omit Node; all update records match ZIP bytes')
if ($LegacyNodeDirectory) {
    $legacy = & (Join-Path $PSScriptRoot 'Build-RuntimeUpdate.ps1') -InputDirectory $root -PayloadProfile portable -Version $version -OutputDirectory (Join-Path $output 'legacy') -Channel preview -LegacyBundledBridgeNodeDirectory $LegacyNodeDirectory
    Check-Update $legacy.archive $true $version
    $checks += 'Preview5 bridge uses pinned Node and old manifest schema without changing the portable directory'
}
[pscustomobject]@{ passed = $true; checks = $checks; clientStarted = $false; msiInstalled = $false } | ConvertTo-Json -Depth 5
