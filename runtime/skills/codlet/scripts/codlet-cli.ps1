param([Parameter(Mandatory=$true,ValueFromRemainingArguments=$true)][string[]]$Command)
$ErrorActionPreference='Stop'
$codletRuntime=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '../runtime.json'))|ConvertFrom-Json
if([string]$codletRuntime.cliExecutable -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))'){throw 'Core CLI executable must be an absolute path'}
if([string]$codletRuntime.registry -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))'){throw 'Core registry must be an absolute path'}
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
