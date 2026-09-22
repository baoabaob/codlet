[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$fixture=Join-Path $repo ('.codlet-artifacts/installer-refresh-2026-09-22/windows-initialization-tests/'+[Guid]::NewGuid().ToString('N'))
$app=Join-Path $fixture 'app';$data=Join-Path $fixture 'data'
[IO.Directory]::CreateDirectory($app)|Out-Null
[IO.Directory]::CreateDirectory($data)|Out-Null
$utf8=[Text.UTF8Encoding]::new($false)
function Write-Json([string]$Path,$Value){[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 12),$utf8)}
function Assert($Condition,[string]$Message){if(-not $Condition){throw $Message}}
Copy-Item -LiteralPath (Join-Path $repo 'scripts/distribution/Initialize-Codlet.ps1') -Destination $app
$fake=@'
using System;
using System.IO;
using System.Web.Script.Serialization;
class FixtureCli {
  static void Main(string[] args) {
    Console.OutputEncoding=new System.Text.UTF8Encoding(false);
    string home=Environment.GetEnvironmentVariable("CODLET_HOME");
    if(args[1]=="list") Console.WriteLine(File.Exists(Path.Combine(home,"existing.json"))?File.ReadAllText(Path.Combine(home,"existing.json")):"{\"plugins\":[]}");
    else { File.AppendAllText(Path.Combine(home,"added.jsonl"),new JavaScriptSerializer().Serialize(args)+"\n");Console.WriteLine("{}"); }
  }
}
'@
Add-Type -TypeDefinition $fake -Language CSharp -ReferencedAssemblies System.Web.Extensions.dll -OutputAssembly (Join-Path $app 'codlet.exe') -OutputType ConsoleApplication
$id='codex.ui.adapter'
$payload=Join-Path $app ('optional-plugins/packages/'+$id)
[IO.Directory]::CreateDirectory($payload)|Out-Null
function Set-Payload([string]$Version){
  Write-Json (Join-Path $payload 'codlet.json') @{schema=1;id=$id;version=$Version;permissions=@('ui.dom');renderer=@{entry='renderer.js';world='isolated'}}
  [IO.File]::WriteAllText((Join-Path $payload 'renderer.js'),'throw new Error("must never execute");',$utf8)
  $files=@('codlet.json','renderer.js')|ForEach-Object{$file=Join-Path $payload $_;@{path=$_;bytes=([IO.FileInfo]$file).Length;sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}}
  Write-Json (Join-Path $app 'optional-plugins/catalog.json') @{schema=1;kind='codlet-official-plugin-bundle';packages=@(@{id=$id;version=$Version;permissions=@('ui.dom');files=@($files)})}
}
function Initialize([switch]$Ordinary){
  $arguments=@('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $app 'Initialize-Codlet.ps1'),'-NoLaunch','-DataDirectory',$data)
  if(-not $Ordinary){$arguments+=@('-Plugins',$id)}
  $previousPreference=$ErrorActionPreference
  try{$ErrorActionPreference='Continue';$messages=& powershell.exe @arguments 2>&1;$code=$LASTEXITCODE}
  finally{$ErrorActionPreference=$previousPreference}
  [pscustomobject]@{code=$code;text=($messages|Out-String)}
}
Set-Payload '1.0.0'
Write-Json (Join-Path $data 'config.json') @{schema=2;plugins=@{$id=@{enabled=$false}}}
$result=Initialize
Assert ($result.code -eq 0) $result.text
$state=[IO.File]::ReadAllText((Join-Path $data 'plugin-setup.json'))|ConvertFrom-Json
$receipt=$state.decided.PSObject.Properties[$id].Value
Assert ($receipt.source -eq 'official-installer') 'Missing installer provenance'
Assert ($receipt.files.Count -eq 2) 'Missing full file hash receipt'
Assert ($receipt.catalogSha256.Length -eq 64) 'Missing catalog digest'
$added=[IO.File]::ReadAllText((Join-Path $data 'added.jsonl'))|ConvertFrom-Json
Assert ('--enable' -notin $added) 'Disabled preference was overridden'
$destination=Join-Path $data ('packages/'+$id)
Write-Json (Join-Path $data 'existing.json') @{plugins=@(@{id=$id;source='local';path=$destination;enabled=$false})}
$configBefore=[IO.File]::ReadAllText((Join-Path $data 'config.json'))
$callsBefore=[IO.File]::ReadAllText((Join-Path $data 'added.jsonl'))
$result=Initialize
Assert ($result.code -eq 0) $result.text
Assert ($result.text.Contains('payload already matches')) 'Matching registration was not explicitly verified'
Assert ([IO.File]::ReadAllText((Join-Path $data 'added.jsonl')) -eq $callsBefore) 'Matching registration was imported again'
$oldManifest=[IO.File]::ReadAllText((Join-Path $destination 'codlet.json'))
Set-Payload '2.0.0'
$result=Initialize
Assert ($result.code -eq 20) 'An old plugin was not reported as requiring manual migration'
Assert ($result.text.Contains('官方插件未更新')) 'Missing actionable migration explanation'
Assert ([IO.File]::ReadAllText((Join-Path $destination 'codlet.json')) -eq $oldManifest) 'Old payload was overwritten'
Assert ([IO.File]::ReadAllText((Join-Path $data 'config.json')) -eq $configBefore) 'Existing preferences or grants changed'
Assert ([IO.File]::ReadAllText((Join-Path $data 'added.jsonl')) -eq $callsBefore) 'Existing registration was imported again'
Write-Json (Join-Path $data 'existing.json') @{plugins=@()}
$result=Initialize -Ordinary
Assert ($result.code -eq 0) $result.text
Assert ([IO.File]::ReadAllText((Join-Path $data 'added.jsonl')) -eq $callsBefore) 'Ordinary launch revived a removed plugin'
Write-Output 'Windows installer fixture passed: receipt, preserved disabled/settings, explicit migration refusal, and no automatic revival.'
