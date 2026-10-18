[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ArtifactsDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$output=[IO.Path]::GetFullPath($ArtifactsDirectory)
if(Test-Path -LiteralPath $output){throw 'Choose a new progress test directory'}
[IO.Directory]::CreateDirectory($output)|Out-Null
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$executable=Join-Path $output 'startup-progress-tests.exe'
& $compiler /nologo /platform:x64 /target:exe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Core.dll /reference:System.Web.Extensions.dll ('/out:'+$executable) (Join-Path $repo 'scripts/installer/StartupProgress.cs') (Join-Path $repo 'scripts/installer/StartupProgressTests.cs')
if($LASTEXITCODE -ne 0){throw 'Startup progress test compilation failed'}
$process=Start-Process -FilePath $executable -ArgumentList @('"'+$output+'"') -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $output 'stderr.log')
try{
  $null=$process.Handle
  if(-not $process.WaitForExit(15000)){throw 'Startup progress test timed out'}
  if($process.ExitCode -ne 0){throw ('Startup progress test failed; see '+(Join-Path $output 'stderr.log'))}
}finally{$process.Dispose()}
$report=[IO.File]::ReadAllText((Join-Path $output 'report.json'))|ConvertFrom-Json
if(-not $report.passed){throw 'Startup progress report did not pass'}
$report|ConvertTo-Json -Compress
