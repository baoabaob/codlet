param([Parameter(Mandatory=$true,ValueFromRemainingArguments=$true)][string[]]$Command)
$ErrorActionPreference='Stop'
$codletRuntime=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '../runtime.json'))|ConvertFrom-Json
$codletPreviousLocalAppData=$env:LOCALAPPDATA
$codletPreviousHome=$env:CODLET_HOME
try {
  $env:CODLET_HOME=[IO.Path]::GetDirectoryName([string]$codletRuntime.registry)
  if($codletRuntime.cliLocalAppData){$env:LOCALAPPDATA=$codletRuntime.cliLocalAppData}
  $codletArguments=@($codletRuntime.cliPrefix)+@($Command)
  & $codletRuntime.cliExecutable @codletArguments
  $codletExit=$LASTEXITCODE
} finally {$env:LOCALAPPDATA=$codletPreviousLocalAppData;$env:CODLET_HOME=$codletPreviousHome}
exit $codletExit
