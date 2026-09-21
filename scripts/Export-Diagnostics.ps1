[CmdletBinding()]
param([string]$OutputPath)
$ErrorActionPreference = 'Stop'
if (-not $env:CODLET_HOME -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'portable.mode') -PathType Leaf)) {
    $env:CODLET_HOME = Join-Path $PSScriptRoot 'data'
}
if (-not $OutputPath) {
    $codletExportName = 'Codlet-diagnostics-' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.zip'
    $OutputPath = Join-Path $PSScriptRoot $codletExportName
}
$codletExportPath = [IO.Path]::GetFullPath($OutputPath)
$codletLabConfig = Join-Path $PSScriptRoot 'lab-config.json'
if (Test-Path -LiteralPath $codletLabConfig -PathType Leaf) {
    $codletConfiguration = [IO.File]::ReadAllText($codletLabConfig) | ConvertFrom-Json
    & (Join-Path $PSScriptRoot $codletConfiguration.nodeRelative) (Join-Path $PSScriptRoot 'isolated-client.mjs') diagnostics $codletLabConfig --output $codletExportPath
} else {
    & (Join-Path $PSScriptRoot 'codlet.exe') diagnostics --output $codletExportPath
}
exit $LASTEXITCODE
