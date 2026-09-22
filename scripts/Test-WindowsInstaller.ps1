[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ArtifactsDirectory,[string]$WixDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$output=[IO.Path]::GetFullPath($ArtifactsDirectory)
if(Test-Path -LiteralPath $output){throw 'Use a new installer test output directory'}
$owned=Join-Path $output 'owned';$other=Join-Path $output 'unrelated'
[IO.Directory]::CreateDirectory($owned)|Out-Null;[IO.Directory]::CreateDirectory($other)|Out-Null
$source=Join-Path $PSScriptRoot 'installer'
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$references=@('/nologo','/platform:x64','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Core.dll')
& $compiler @references /target:winexe ('/out:'+(Join-Path $owned 'codlet.exe')) (Join-Path $source 'ProcessFixture.cs')
if($LASTEXITCODE -ne 0){throw 'Fixture compilation failed'}
[IO.File]::Copy((Join-Path $owned 'codlet.exe'),(Join-Path $other 'codlet.exe'))
& $compiler @references /target:exe ('/out:'+(Join-Path $output 'tests.exe')) (Join-Path $source 'ProcessGate.cs') (Join-Path $source 'DetachedHost.cs') (Join-Path $source 'ProcessGateTests.cs')
if($LASTEXITCODE -ne 0){throw 'Test compilation failed'}
$test=Start-Process -FilePath (Join-Path $output 'tests.exe') -ArgumentList @(('"'+$owned+'"'),('"'+$other+'"')) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $output 'stdout.log') -RedirectStandardError (Join-Path $output 'stderr.log')
$null=$test.Handle
if(-not $test.WaitForExit(20000)){throw 'Installer process test timed out'}
if($test.ExitCode -ne 0){throw ('Installer process tests failed: '+[IO.File]::ReadAllText((Join-Path $output 'stderr.log')))}
$deadline=[DateTime]::UtcNow.AddSeconds(6)
do{Start-Sleep -Milliseconds 100;$stream=[IO.File]::Open((Join-Path $owned 'detached.core.log'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);$reader=[IO.StreamReader]::new($stream);try{$log=$reader.ReadToEnd()}finally{$reader.Dispose()}}while($log -notmatch 'detached-output-19' -and [DateTime]::UtcNow -lt $deadline)
if($log -notmatch 'detached-output-19'){throw 'Core log stopped when its launcher exited'}
$msiExit=$null
if($WixDirectory){
  $helper=Join-Path $output 'helper'
  & (Join-Path $PSScriptRoot 'Build-WindowsLauncher.ps1') -OutputDirectory $helper -InstallerAssets | Out-Null
  $probe=Join-Path $output 'preflight-only.wxs';$probeMsi=Join-Path $output 'preflight-only.msi'
  $binary=[Security.SecurityElement]::Escape((Join-Path $helper 'Codlet-Installer-Preflight.exe'))
  $preflightLog=Join-Path $output 'preflight-processes.log'
  $escapedLog=[Security.SecurityElement]::Escape($preflightLog)
  $folder=[Security.SecurityElement]::Escape($owned+'\')
  $product='{'+[Guid]::NewGuid().ToString()+'}'
  $xml=@"
<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi"><Product Id="$product" Name="Codlet isolated preflight probe" Manufacturer="Codlet Test" Language="1033" Codepage="936" Version="1.0.0" UpgradeCode="$(New-Guid)">
<Package InstallerVersion="500" InstallScope="perUser" InstallPrivileges="limited" Platform="x64"/>
<Property Id="INSTALLFOLDER" Value="$folder"/>
<Binary Id="Actions" SourceFile="$binary"/>
<CustomAction Id="CheckRunningApplications" BinaryKey="Actions" ExeCommand="&quot;[INSTALLFOLDER].&quot; [UILevel] &quot;$escapedLog&quot;" Execute="immediate" Return="check"/>
<CustomAction Id="NeverInstallProbe" Error="This test cannot enter an installation transaction."/>
<InstallExecuteSequence><Custom Action="CheckRunningApplications" Before="InstallValidate">1</Custom><Custom Action="NeverInstallProbe" Before="InstallInitialize">1</Custom></InstallExecuteSequence>
<Directory Id="TARGETDIR" Name="SourceDir"/><Feature Id="Core" Title="Test" Level="1"/>
</Product></Wix>
"@
  [IO.File]::WriteAllText($probe,$xml,[Text.UTF8Encoding]::new($false))
  & (Join-Path $WixDirectory 'candle.exe') -nologo -arch x64 -out (Join-Path $output 'preflight-only.wixobj') $probe | Out-Null
  if($LASTEXITCODE -ne 0){throw 'MSI probe compilation failed'}
  & (Join-Path $WixDirectory 'light.exe') -nologo -out $probeMsi (Join-Path $output 'preflight-only.wixobj') | Out-Null
  if($LASTEXITCODE -ne 0){throw 'MSI probe linking failed'}
  $fixture=Start-Process -FilePath (Join-Path $owned 'codlet.exe') -ArgumentList 'stubborn' -WindowStyle Hidden -PassThru
  $null=$fixture.Handle
  try{
    $msiLog=Join-Path $output 'preflight-only.log'
    $run=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/msiexec.exe') -ArgumentList @('/i',('"'+$probeMsi+'"'),'/qn','/norestart','/l*v',('"'+$msiLog+'"')) -WindowStyle Hidden -PassThru
    $null=$run.Handle
    if(-not $run.WaitForExit(20000)){throw 'Quiet MSI preflight exceeded its deadline'}
    $msiExit=$run.ExitCode
    $text=[IO.File]::ReadAllText($msiLog)
    if($msiExit -ne 1603 -or [IO.File]::ReadAllText($preflightLog) -notmatch 'gate result=1618'){throw 'Quiet MSI did not refuse the running applications clearly'}
    if($text -match 'Doing action: InstallInitialize'){throw 'MSI probe entered a transaction'}
    if($fixture.HasExited){throw 'Quiet MSI closed the test application'}
    $installer=New-Object -ComObject WindowsInstaller.Installer
    try{if($installer.ProductState($product) -ne -1){throw 'Probe registered an installed product'}}finally{[Runtime.InteropServices.Marshal]::ReleaseComObject($installer)|Out-Null}
  }finally{if(-not $fixture.HasExited){$fixture.Kill();$null=$fixture.WaitForExit(3000)};$fixture.Dispose()}
}
$report=[ordered]@{passed=$true;scope='owned-fake-processes-only';userClientTouched=$false;checks=@('scoped-process-list','quiet-failure','pid-identity','normal-close','no-force-on-refusal','unrelated-process-preserved','durable-detached-output')}
if($null -ne $msiExit){$report.msiQuietExitCode=$msiExit;$report.checks+='real-msi-quiet-preflight-before-transaction'}
$report|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $output 'report.json') -Encoding UTF8
$report|ConvertTo-Json -Compress
