# Explicit isolated-client rehearsal. This does not invoke the official installer.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$codletConfigPath = Join-Path $PSScriptRoot 'lab-config.json'
$codletConfiguration = [IO.File]::ReadAllText($codletConfigPath) | ConvertFrom-Json
$codletNode = Join-Path $PSScriptRoot $codletConfiguration.nodeRelative
Write-Host 'Rehearsing update restart of the TEST client only. No official package will be installed.'
& $codletNode (Join-Path $PSScriptRoot 'isolated-client.mjs') rehearse-update $codletConfigPath
exit $LASTEXITCODE
