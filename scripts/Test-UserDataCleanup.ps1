[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ArtifactsDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$output=[IO.Path]::GetFullPath($ArtifactsDirectory)
if(Test-Path -LiteralPath $output){throw 'Use a new cleanup test output directory'}
foreach($relative in @('profile/Codlet/packages/managed','outside','other-profile/Codlet')){[IO.Directory]::CreateDirectory((Join-Path $output $relative))|Out-Null}
[IO.File]::WriteAllText((Join-Path $output 'profile/Codlet/packages/managed/entry.js'),'managed fixture')
[IO.File]::WriteAllText((Join-Path $output 'other-profile/Codlet/config.json'),'other scope')
$links=@(@('profile/Codlet/packages/linked','outside'),@('linked-profile','other-profile'))
try{
  foreach($pair in $links){New-Item -ItemType Junction -Path (Join-Path $output $pair[0]) -Target (Join-Path $output $pair[1])|Out-Null}
  $source=Join-Path $PSScriptRoot 'installer'
  $compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
  & $compiler /nologo /target:exe /platform:x64 /reference:System.Core.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll ('/out:'+(Join-Path $output 'tests.exe')) (Join-Path $source 'UserDataCleanup.cs') (Join-Path $source 'CleanupDialog.cs') (Join-Path $source 'UserDataCleanupTests.cs')
  if($LASTEXITCODE -ne 0){throw 'Cleanup test compilation failed'}
  $process=Start-Process -FilePath (Join-Path $output 'tests.exe') -ArgumentList ('"'+$output+'"') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $output 'stdout.log') -RedirectStandardError (Join-Path $output 'stderr.log')
  $null=$process.Handle
  if(-not $process.WaitForExit(30000)){throw 'Cleanup test timed out'}
  if($process.ExitCode -ne 0){throw ([IO.File]::ReadAllText((Join-Path $output 'stderr.log')))}
  [IO.File]::ReadAllText((Join-Path $output 'stdout.log'))
}finally{
  # Remove only the two links created above, never their targets.
  foreach($pair in $links){$path=Join-Path $output $pair[0];if([IO.Directory]::Exists($path) -and (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0)){[IO.Directory]::Delete($path,$false)}}
}
