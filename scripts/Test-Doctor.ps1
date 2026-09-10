$ErrorActionPreference = 'Stop'
$codletConfigPath = Join-Path $PSScriptRoot 'lab-config.json'
$codletConfig = [IO.File]::ReadAllText($codletConfigPath) | ConvertFrom-Json
& (Join-Path $PSScriptRoot $codletConfig.nodeRelative) (Join-Path $PSScriptRoot 'isolated-client.mjs') doctor $codletConfigPath @args
exit $LASTEXITCODE
