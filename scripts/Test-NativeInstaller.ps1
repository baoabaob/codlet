[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ArtifactsDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$output=[IO.Path]::GetFullPath($ArtifactsDirectory)
if(Test-Path -LiteralPath $output){throw 'Choose a new native-installer test directory'}
[IO.Directory]::CreateDirectory($output)|Out-Null
$fixture=Join-Path $output 'fixture.msi'
[IO.File]::WriteAllText($fixture,'Native UI test payload. This is not an installable MSI.')
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version=[regex]::Match([IO.File]::ReadAllText((Join-Path $root 'Cargo.toml')),'(?m)^version = "([^"]+)"').Groups[1].Value
$program=Join-Path $output 'Codlet-Setup-Fixture.exe'
& (Join-Path $PSScriptRoot 'Build-WindowsInstaller.ps1') -MsiPath $fixture -OutputPath $program -Version $version -FixturePayload | Out-Null
foreach($language in @('system','english')){
  $resultDirectory=Join-Path $output $language
  $arguments=@('--self-test',('"'+$resultDirectory+'"'))
  if($language -eq 'english'){$arguments+='--english'}
  $process=Start-Process -FilePath $program -ArgumentList $arguments -WindowStyle Hidden -PassThru
  $null=$process.Handle
  try{
    if(-not $process.WaitForExit(20000)){throw 'Native installer self-test timed out'}
    if($process.ExitCode -ne 0){throw ('Native installer failed: '+[IO.File]::ReadAllText((Join-Path $resultDirectory 'failure.txt')))}
    $result=[IO.File]::ReadAllText((Join-Path $resultDirectory 'report.json'))|ConvertFrom-Json
    if(-not $result.passed -or $result.installationPerformed){throw 'Native installer validation failed or unexpectedly installed software'}
  }finally{$process.Dispose()}
}
Write-Output 'Native installer passed: both languages, light/dark layouts, scope/path/features, embedded payload checksum, MSI progress/cancellation; no installation performed.'
