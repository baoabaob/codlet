[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$builder = Join-Path $PSScriptRoot '../scripts/Build-PluginPackage.ps1'
$root = Join-Path ([IO.Path]::GetTempPath()) ('codlet-package-tests-' + [Guid]::NewGuid().ToString('N'))
$source = Join-Path $root 'source'
$link = Join-Path $root 'linked-source'
[IO.Directory]::CreateDirectory($source) | Out-Null
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }
try {
    [IO.File]::WriteAllText((Join-Path $source 'codlet.json'), '{"id":"fixture.package","version":"1.0.0"}')
    [IO.File]::WriteAllText((Join-Path $source 'host.cjs'), 'module.exports={};')
    $output = Join-Path $root 'success.zip'
    $receipt = (& $builder -PluginDirectory $source -OutputPath $output) | ConvertFrom-Json
    Assert ($receipt.Files -eq 2) 'Expected exactly two prepared source files'
    Assert ($receipt.SourceBytes -eq ((Get-Item -LiteralPath (Join-Path $source 'codlet.json')).Length + (Get-Item -LiteralPath (Join-Path $source 'host.cjs')).Length)) 'Receipt must describe actual copied bytes'
    $archive = [IO.Compression.ZipArchive]::new([IO.File]::OpenRead($output), [IO.Compression.ZipArchiveMode]::Read)
    try { Assert ((@($archive.Entries.FullName) -join '|') -eq 'codlet.json|host.cjs') 'Prepared files must be at ZIP root' }
    finally { $archive.Dispose() }

    $failedOutput = Join-Path $root 'failed.zip'
    $held = [IO.File]::Open((Join-Path $source 'host.cjs'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try {
        $rejected = $false
        try { & $builder -PluginDirectory $source -OutputPath $failedOutput | Out-Null } catch { $rejected = $true }
        Assert $rejected 'An unreadable payload must fail packaging'
        Assert (-not (Test-Path -LiteralPath $failedOutput)) 'A partial ZIP must be removed after stream failure'
    } finally { $held.Dispose() }

    New-Item -ItemType Junction -Path $link -Target $source | Out-Null
    $rejected = $false
    try { & $builder -PluginDirectory $link -OutputPath (Join-Path $root 'linked.zip') | Out-Null } catch { $rejected = $true }
    Assert $rejected 'A linked prepared source root must be rejected'
    Assert (-not (Test-Path -LiteralPath (Join-Path $root 'linked.zip'))) 'Linked source rejection must not create an archive'
} finally {
    if (Test-Path -LiteralPath $link) { [IO.Directory]::Delete($link) }
    $resolved = [IO.Path]::GetFullPath($root)
    $temporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($temporary, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected package test cleanup root' }
    for ($ancestor = $resolved; $ancestor; $ancestor = [IO.Path]::GetDirectoryName($ancestor)) {
        if ((Get-Item -LiteralPath $ancestor).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked package test cleanup ancestor' }
    }
    if (@(Get-ChildItem -LiteralPath $resolved -Recurse | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Linked package test cleanup entry' }
    Remove-Item -LiteralPath $resolved -Recurse
}
Write-Output 'Plugin package tests passed: ZIP contents, streamed byte receipt, failed read cleanup, linked root rejection.'
