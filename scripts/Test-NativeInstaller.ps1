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
$framework=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$layoutProgram=Join-Path $output 'SetupLayoutTests.exe'
$refs=@('/reference:System.dll','/reference:System.Core.dll','/reference:System.Xaml.dll','/reference:System.Web.Extensions.dll')
$refs+=@('WindowsBase.dll','PresentationCore.dll','PresentationFramework.dll'|ForEach-Object{'/reference:'+(Join-Path $framework ('WPF/'+$_))})
& (Join-Path $framework 'csc.exe') /nologo /target:winexe /platform:x64 @refs ('/out:'+$layoutProgram) (Join-Path $PSScriptRoot 'installer/SetupLayoutTests.cs')
if($LASTEXITCODE -ne 0){throw 'Native layout test compilation failed'}
foreach($language in @('chinese','english')){
  $resultDirectory=Join-Path $output $language
  $arguments=@('--self-test',('"'+$resultDirectory+'"'))
  $arguments+=('--'+$language)
  $process=Start-Process -FilePath $program -ArgumentList $arguments -WindowStyle Hidden -PassThru
  $null=$process.Handle
  try{
    if(-not $process.WaitForExit(20000)){throw 'Native installer self-test timed out'}
    if($process.ExitCode -ne 0){throw ('Native installer failed: '+[IO.File]::ReadAllText((Join-Path $resultDirectory 'failure.txt')))}
    $result=[IO.File]::ReadAllText((Join-Path $resultDirectory 'report.json'))|ConvertFrom-Json
    if(-not $result.passed -or $result.installationPerformed){throw 'Native installer validation failed or unexpectedly installed software'}
  }finally{$process.Dispose()}
}
foreach($locale in @('zh-CN','en-US','de-DE')){
  $resultDirectory=Join-Path $output ('layout-'+$locale)
  $process=Start-Process -FilePath $layoutProgram -ArgumentList @(('"'+$program+'"'),('"'+$resultDirectory+'"'),$locale) -WindowStyle Hidden -PassThru
  $null=$process.Handle
  try{
    if(-not $process.WaitForExit(20000)){throw 'Native window layout test timed out'}
    if($process.ExitCode -ne 0){throw ('Native window layout failed: '+[IO.File]::ReadAllText((Join-Path $resultDirectory 'layout-failure.txt')))}
  }finally{$process.Dispose()}
}
Write-Output 'Native installer passed: Chinese/English and automatic language fallback; actual-window overflow, expansion, footer and keyboard-focus contracts; light/dark rendering, scope/path/features, payload checksum and MSI cancellation. No installation performed.'
