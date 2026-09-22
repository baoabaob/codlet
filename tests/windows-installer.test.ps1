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
using System.Linq;
using System.Collections.Generic;
using System.Web.Script.Serialization;
class FixtureCli {
  static void Main(string[] args) {
    Console.OutputEncoding=new System.Text.UTF8Encoding(false);
    string home=Environment.GetEnvironmentVariable("CODLET_HOME");
    if(args[1]=="list") Console.WriteLine(File.Exists(Path.Combine(home,"existing.json"))?File.ReadAllText(Path.Combine(home,"existing.json")):"{\"plugins\":[]}");
    else if(args[1]=="seed") {
      var json=new JavaScriptSerializer(); var catalog=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(args[3]));
      var package=(Dictionary<string,object>)((System.Collections.ArrayList)catalog["packages"])[0];
      string id=args[4],destination=Path.Combine(home,"packages",id),source=Path.Combine(Path.GetDirectoryName(args[3]),"packages",id);
      bool existing=File.Exists(Path.Combine(home,"existing.json")) && File.ReadAllText(Path.Combine(home,"existing.json")).Contains(id);
      if(File.Exists(Path.Combine(destination,"author.txt"))) {Console.Error.WriteLine("官方插件未更新：作者文件已修改");Environment.Exit(1);}
      if(args[2]=="preview") {
        string[] grants=existing?(File.Exists(Path.Combine(home,"new-permission"))?new[]{"core.events"}:new string[0]):new[]{"ui.dom"};
        Console.WriteLine(json.Serialize(new {preview="fixture-preview",existing=existing,addedPermissions=grants}));
      } else {
        Directory.CreateDirectory(destination);foreach(string file in Directory.GetFiles(source))File.Copy(file,Path.Combine(destination,Path.GetFileName(file)),true);
        File.AppendAllText(Path.Combine(home,"added.jsonl"),json.Serialize(args)+"\n");Console.WriteLine("{}");
      }
    } else { throw new Exception("Unexpected fixture command"); }
  }
}
'@
Add-Type -TypeDefinition $fake -Language CSharp -ReferencedAssemblies System.Web.Extensions.dll,System.Core.dll -OutputAssembly (Join-Path $app 'codlet.exe') -OutputType ConsoleApplication
$id='codex.ui.adapter'
$payload=Join-Path $app ('optional-plugins/packages/'+$id)
[IO.Directory]::CreateDirectory($payload)|Out-Null
function Set-Payload([string]$Version){
  Write-Json (Join-Path $payload 'codlet.json') @{schema=1;id=$id;version=$Version;permissions=@('ui.dom');renderer=@{entry='renderer.js';world='isolated'}}
  [IO.File]::WriteAllText((Join-Path $payload 'renderer.js'),'throw new Error("must never execute");',$utf8)
  $files=@('codlet.json','renderer.js')|ForEach-Object{$file=Join-Path $payload $_;@{path=$_;bytes=([IO.FileInfo]$file).Length;sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}}
  Write-Json (Join-Path $app 'optional-plugins/catalog.json') @{schema=1;kind='codlet-official-plugin-bundle';packages=@(@{id=$id;version=$Version;permissions=@('ui.dom');files=@($files)})}
}
function Initialize([switch]$Ordinary,[string]$Approve){
  $arguments=@('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $app 'Initialize-Codlet.ps1'),'-NoLaunch','-DataDirectory',$data)
  if(-not $Ordinary){$arguments+=@('-Plugins',$id)}
  if($Approve){$arguments+=@('-ApproveNewPermissions',$Approve)}
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
$oldManifest=[IO.File]::ReadAllText((Join-Path $destination 'codlet.json'))
Set-Payload '2.0.0'
$result=Initialize
Assert ($result.code -eq 0) $result.text
Assert ([IO.File]::ReadAllText((Join-Path $destination 'codlet.json')) -ne $oldManifest) 'Selected official update was not applied'
Assert ([IO.File]::ReadAllText((Join-Path $data 'config.json')) -eq $configBefore) 'Existing preferences or grants changed'
$callsBefore=[IO.File]::ReadAllText((Join-Path $data 'added.jsonl'))
[IO.File]::WriteAllText((Join-Path $data 'new-permission'),'required',$utf8)
$result=Initialize
Assert ($result.code -ne 0) 'New permission was silently approved'
Assert ([IO.File]::ReadAllText((Join-Path $data 'added.jsonl')) -eq $callsBefore) 'Import ran before permission approval'
$result=Initialize -Approve 'core.events'
Assert ($result.code -eq 0) $result.text
Assert ([IO.File]::ReadAllText((Join-Path $data 'added.jsonl')).Contains('core.events')) 'Explicit permission approval was not forwarded'
[IO.File]::WriteAllText((Join-Path $destination 'author.txt'),'keep me',$utf8)
$result=Initialize
Assert ($result.code -eq 20) 'Modified author source was not reported'
Assert ([IO.File]::ReadAllText((Join-Path $destination 'author.txt')) -eq 'keep me') 'Author file was removed'
$callsBefore=[IO.File]::ReadAllText((Join-Path $data 'added.jsonl'))
Write-Json (Join-Path $data 'existing.json') @{plugins=@()}
$result=Initialize -Ordinary
Assert ($result.code -eq 0) $result.text
Assert ([IO.File]::ReadAllText((Join-Path $data 'added.jsonl')) -eq $callsBefore) 'Ordinary launch revived a removed plugin'
Write-Output 'Windows installer fixture passed: transaction routing, receipt, permission consent, author protection, and no automatic revival.'
