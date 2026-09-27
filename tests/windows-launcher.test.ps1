[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$root=Join-Path $repo ('.codlet-artifacts/launcher-fixtures/'+[Guid]::NewGuid().ToString('N'))
$app=Join-Path $root 'app'
$data=Join-Path $app 'data'
[IO.Directory]::CreateDirectory($data)|Out-Null
# The real process gate has separate native tests. Here only bypass that gate
# for the fake Core, so the developer's running official client stays untouched.
$gate=Join-Path $root 'ProcessGateFixture.cs'
[IO.File]::WriteAllText($gate,'namespace Codlet.Setup { static class ProcessGate { public static int Check(string root,bool interactive,bool official,System.Action<string> log){return 0;} } }')
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $compiler /nologo /platform:x64 /target:winexe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Core.dll /reference:System.Web.Extensions.dll ('/out:'+(Join-Path $app 'Codlet-Launcher.exe')) $gate (Join-Path $repo 'scripts/installer/Launcher.cs') (Join-Path $repo 'scripts/installer/DetachedHost.cs')
if($LASTEXITCODE -ne 0){throw 'Production launcher compilation failed'}
[IO.File]::WriteAllText((Join-Path $app 'portable.mode'),'fixture')
[IO.File]::WriteAllText((Join-Path $data 'plugin-setup.json'),'{}')
[IO.File]::WriteAllText((Join-Path $app 'Initialize-Codlet.ps1'),'param([switch]$NoLaunch) exit 0')
$source=@'
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
class CoreFixture {
 static int Main(string[] args) {
  string data=Environment.GetEnvironmentVariable("CODLET_HOME");
  if(args[0]=="status") {
   string ready=Path.Combine(data,"ready.json");
   Console.WriteLine(File.Exists(ready)?File.ReadAllText(ready):"{\"status\":\"stopped\"}");return 0;
  }
  bool degraded=File.Exists(Path.Combine(data,"degraded"));
  if(!args.SequenceEqual(new[]{"launch","--safe-mode"})&&!degraded) {Console.Error.WriteLine("fixture: CDP pipe reached EOF");return 23;}
  string renderer=degraded?",\"renderer\":{\"recent_events\":[{\"code\":\"renderer_executor_unavailable\"}]}":"";
  File.WriteAllText(Path.Combine(data,"ready.json"),"{\"status\":\"running\",\"snapshot\":{\"state\":\"ready\",\"host_pid\":"+Process.GetCurrentProcess().Id+renderer+"}}");
  Thread.Sleep(2500);Console.WriteLine("safe-fixture-finished");return 0;
 }
}
'@
$fixture=Join-Path $root 'CoreFixture.cs'
[IO.File]::WriteAllText($fixture,$source)
& (Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe') /nologo /platform:x64 /target:exe /reference:System.Core.dll ('/out:'+(Join-Path $app 'codlet.exe')) $fixture
if($LASTEXITCODE -ne 0){throw 'Fixture compilation failed'}
function Run-Launcher([string]$Arguments) {
 $process=Start-Process -FilePath (Join-Path $app 'Codlet-Launcher.exe') -ArgumentList $Arguments -WindowStyle Hidden -PassThru
 try {
  $null=$process.Handle
  if(-not $process.WaitForExit(15000)){throw 'Launcher did not finish within its test deadline'}
  return $process.ExitCode
 } finally {$process.Dispose()}
}
function Assert($Condition,[string]$Message){if(-not $Condition){throw $Message}}
function Read-Shared([string]$Path){
 $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
 $reader=[IO.StreamReader]::new($stream)
 try{return $reader.ReadToEnd()}finally{$reader.Dispose()}
}
Assert ((Run-Launcher '--quiet') -eq 42) 'Early Core exit must return launch failure without throwing or retrying'
$logs=@(Get-ChildItem -LiteralPath (Join-Path $data 'launcher-logs') -Filter '*.log' -File)
$text=($logs|ForEach-Object{[IO.File]::ReadAllText($_.FullName)}) -join "`n"
Assert ($text -match 'Core exited before readiness: 23' -and $text -match 'CDP pipe reached EOF' -and $text -notmatch 'InvalidOperationException') 'Original Core failure or exit code was lost'
# Safe mode must remain usable even if initialization/configuration is broken.
[IO.File]::WriteAllText((Join-Path $app 'Initialize-Codlet.ps1'),'throw "Safe mode must skip this initializer"')
[IO.File]::Delete((Join-Path $data 'plugin-setup.json'))
Assert ((Run-Launcher '--quiet --safe-mode') -eq 0) 'Safe mode did not bypass configuration and launch the exact owned Core'
$deadline=[DateTime]::UtcNow.AddSeconds(5)
do {
 Start-Sleep -Milliseconds 100
 $safe=@(Get-ChildItem -LiteralPath (Join-Path $data 'launcher-logs') -Filter '*.safe.core.log' -File)
 $text=if($safe.Count){Read-Shared $safe[0].FullName}else{''}
}while($text -notmatch 'safe-fixture-finished' -and [DateTime]::UtcNow -lt $deadline)
Assert ($text -match 'safe-fixture-finished') 'Launcher exit interrupted the detached Core or its log'
[IO.File]::WriteAllText((Join-Path $app 'Initialize-Codlet.ps1'),'param([switch]$NoLaunch) exit 0')
[IO.File]::WriteAllText((Join-Path $data 'plugin-setup.json'),'{}')
[IO.File]::WriteAllText((Join-Path $data 'degraded'),'fixture')
Assert ((Run-Launcher '--quiet') -eq 0) 'Renderer failure incorrectly blocked an otherwise ready Core'
$logs=@(Get-ChildItem -LiteralPath (Join-Path $data 'launcher-logs') -Filter '*.log' -File)
$text=($logs|ForEach-Object{Read-Shared $_.FullName}) -join "`n"
Assert ($text -match 'mode: normal; renderer unavailable: True') 'Degraded renderer readiness was not recorded'
Assert ((Run-Launcher '--safe-mode --configure') -eq 87) 'Conflicting recovery/configuration options were accepted'
[pscustomobject]@{passed=$true;earlyExitCode=23;originalFailurePreserved=$true;safeModeSkippedInitialization=$true;detachedOutputSurvived=$true;degradedCoreRemainsReady=$true;userClientTouched=$false}|ConvertTo-Json -Compress
