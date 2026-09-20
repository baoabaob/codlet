param([Parameter(Mandatory=$true,ValueFromRemainingArguments=$true)][string[]]$Command)
$ErrorActionPreference='Stop'
$codletRuntime=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '../runtime.json'))|ConvertFrom-Json
$codletPreviousLocalAppData=$env:LOCALAPPDATA
try {
  if($codletRuntime.cliLocalAppData){$env:LOCALAPPDATA=$codletRuntime.cliLocalAppData}
  $codletArguments=@($codletRuntime.cliPrefix)+@($Command)
  & $codletRuntime.cliExecutable @codletArguments
  $codletExit=$LASTEXITCODE
} finally {$env:LOCALAPPDATA=$codletPreviousLocalAppData}
exit $codletExit
