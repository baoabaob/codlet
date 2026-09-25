[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$fixture=Join-Path $repo ('.codlet-artifacts/online-bootstrap/windows-fixtures/'+[Guid]::NewGuid().ToString('N'))
$app=Join-Path $fixture 'app';[IO.Directory]::CreateDirectory($app)|Out-Null
$utf8=[Text.UTF8Encoding]::new($false)
function Write-Json([string]$Path,$Value){[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 16),$utf8)}
function Assert($Condition,[string]$Message){if(-not $Condition){throw $Message}}
Copy-Item -LiteralPath (Join-Path $repo 'scripts/distribution/Initialize-Codlet.ps1') -Destination $app
Copy-Item -LiteralPath (Join-Path $repo 'scripts/distribution/official-plugins.json') -Destination $app
$fake=@'
using System;
using System.IO;
using System.Linq;
using System.Collections;
using System.Collections.Generic;
using System.Web.Script.Serialization;
class FixtureCli {
 static JavaScriptSerializer json=new JavaScriptSerializer();
 static void Main(string[] args){
  Console.OutputEncoding=new System.Text.UTF8Encoding(false);
  string home=Environment.GetEnvironmentVariable("CODLET_HOME"), existing=Path.Combine(home,"existing.json");
  File.AppendAllText(Path.Combine(home,"calls.jsonl"),json.Serialize(args)+"\n");
  if(args[1]=="list"){Console.WriteLine(File.Exists(existing)?File.ReadAllText(existing):"{\"plugins\":[]}");return;}
  if(args[1]!="github")throw new Exception("Only normal GitHub commands allowed");
  if(args[2]=="install"){
   var rows=new List<object>();if(File.Exists(existing)){var before=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(existing));foreach(var row in (IEnumerable)before["plugins"])rows.Add(row);}
   rows.Add(new {id=Path.GetFileName(args[3]),source="github",enabled=args.Contains("--enable")});
   File.WriteAllText(existing,json.Serialize(new{plugins=rows}));
   File.AppendAllText(Path.Combine(home,"installed.jsonl"),json.Serialize(args)+"\n");
   if(File.Exists(Path.Combine(home,"result-lost"))){Console.Error.WriteLine("result lost");Environment.Exit(1);}
   Console.WriteLine("{\"outcome\":\"applied\"}");return;
  }
  if(File.Exists(Path.Combine(home,"network-failure"))){Console.Error.WriteLine("github_network: Could not connect to GitHub");Environment.Exit(1);}
  var options=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"official-plugins.json")));
  Dictionary<string,object> p=null;foreach(Dictionary<string,object> item in (IEnumerable)options["plugins"])if(args[3]==(string)item["repositoryUrl"]||args[3]==(string)item["repositoryUrl"]+"/releases/latest")p=item;
  if(p==null)throw new Exception("Untrusted URL");string id=(string)p["id"];
  if(args[2]=="releases")Console.WriteLine(json.Serialize(new{releases=new[]{new{id=11,tag="v7.8.9",prerelease=false,assets=new[]{new{id=12,name=id+"-7.8.9.zip"}}}}}));
  else if(args[2]=="preview"){
   var permissions=((IEnumerable)p["permissions"]).Cast<string>().ToList();if(File.Exists(Path.Combine(home,"extra-permission")))permissions.Add("core.events");
   Console.WriteLine(json.Serialize(new{path=Path.Combine(home,"packages",id),manifest=new{id=id,version="7.8.9",permissions=permissions},existingEnabled=!File.Exists(Path.Combine(home,"disabled")),source=new{repositoryUrl=p["repositoryUrl"],repositoryId=p["repositoryId"],ownerId=File.Exists(Path.Combine(home,"bad-owner"))?1:p["ownerId"],upstreamDigestVerified=!File.Exists(Path.Combine(home,"bad-digest"))}}));
  }else throw new Exception("Unexpected command");
 }
}
'@
Add-Type -TypeDefinition $fake -Language CSharp -ReferencedAssemblies System.Web.Extensions.dll,System.Core.dll -OutputAssembly (Join-Path $app 'codlet.exe') -OutputType ConsoleApplication
function New-Data([string]$Name){$p=Join-Path $fixture $Name;[IO.Directory]::CreateDirectory($p)|Out-Null;return $p}
function Initialize([string]$Data,[string]$Plugin,[string]$Approve){
 $arguments=@('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $app 'Initialize-Codlet.ps1'),'-NoLaunch','-DataDirectory',$Data)
 if($Plugin){$arguments+=@('-Plugins',$Plugin)};if($Approve){$arguments+=@('-ApproveNewPermissions',$Approve)}
 $info=[Diagnostics.ProcessStartInfo]::new('powershell.exe');$info.Arguments=($arguments|ForEach-Object{'"'+$_+'"'}) -join ' '
 $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.StandardOutputEncoding=$utf8;$info.StandardErrorEncoding=$utf8
 $process=[Diagnostics.Process]::Start($info)
 try{$stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync();$process.WaitForExit();[pscustomobject]@{code=$process.ExitCode;text=($stdout.Result+$stderr.Result)}}finally{$process.Dispose()}
}
$data=New-Data 'fresh GUI 用户';$result=Initialize $data 'codlet-gui';Assert ($result.code -eq 0) $result.text
$installed=@([IO.File]::ReadAllLines((Join-Path $data 'installed.jsonl'))|ForEach-Object{ConvertFrom-Json $_})
Assert ($installed.Count -eq 2) 'GUI dependency not downloaded'
Assert (-not [IO.Directory]::Exists((Join-Path $app 'optional-plugins'))) 'Fixture accidentally included plugin code'
$state=[IO.File]::ReadAllText((Join-Path $data 'plugin-setup.json'))|ConvertFrom-Json
Assert ($state.decided.'codlet-gui'.version -eq '7.8.9' -and $state.decided.'codlet-gui'.source -eq 'github') 'Latest GitHub version not recorded'
$before=[IO.File]::ReadAllText((Join-Path $data 'installed.jsonl'));$result=Initialize $data 'codlet-gui';Assert ($result.code -eq 0) $result.text
Assert ([IO.File]::ReadAllText((Join-Path $data 'installed.jsonl')) -eq $before) 'Existing install was replaced'
Write-Json (Join-Path $data 'existing.json') @{plugins=@()};$result=Initialize $data;Assert ($result.code -eq 0) $result.text
Assert ([IO.File]::ReadAllText((Join-Path $data 'installed.jsonl')) -eq $before) 'Removed plugin revived on ordinary startup'
$data=New-Data 'existing author';Write-Json (Join-Path $data 'existing.json') @{plugins=@(@{id='codex.ui.adapter';enabled=$false;source='local';version='99.0.0'})}
$before=[IO.File]::ReadAllText((Join-Path $data 'existing.json'));$result=Initialize $data 'codex.ui.adapter';Assert ($result.code -eq 0) $result.text
Assert ([IO.File]::ReadAllText((Join-Path $data 'existing.json')) -eq $before) 'Author source or preference changed'
Assert (@([IO.File]::ReadAllLines((Join-Path $data 'calls.jsonl'))).Count -eq 1) 'Existing source triggered a download'
foreach($reason in @('bad-owner','bad-digest','extra-permission')){
 $data=New-Data $reason;[IO.File]::WriteAllText((Join-Path $data $reason),'fixture');$result=Initialize $data 'codex.ui.adapter'
 Assert ($result.code -ne 0) ('Accepted '+$reason);Assert (-not [IO.File]::Exists((Join-Path $data 'installed.jsonl'))) ('Installed before validating '+$reason)
 if($reason -eq 'extra-permission'){$result=Initialize $data 'codex.ui.adapter' 'core.events';Assert ($result.code -eq 0) $result.text}
}
$data=New-Data 'network retry';$flag=Join-Path $data 'network-failure';[IO.File]::WriteAllText($flag,'fixture');$result=Initialize $data 'codex.ui.adapter';Assert ($result.code -ne 0) 'Network failure ignored'
$state=[IO.File]::ReadAllText((Join-Path $data 'plugin-setup.json'))|ConvertFrom-Json;Assert ($state.decided.'codex.ui.adapter'.result -eq 'pending') 'Failure marked complete'
Remove-Item -LiteralPath $flag;$result=Initialize $data;Assert ($result.code -eq 0) $result.text;Assert ([IO.File]::Exists((Join-Path $data 'installed.jsonl'))) 'Pending download could not resume'
$data=New-Data 'uncertain mutation';[IO.File]::WriteAllText((Join-Path $data 'result-lost'),'fixture');$result=Initialize $data 'codex.ui.adapter';Assert ($result.code -ne 0) 'Uncertain result hidden'
$result=Initialize $data 'codex.ui.adapter';Assert ($result.code -eq 0) $result.text
Assert (@([IO.File]::ReadAllLines((Join-Path $data 'installed.jsonl'))).Count -eq 1) 'Uncertain install was replayed'
$data=New-Data 'Core only';$result=Initialize $data 'none';Assert ($result.code -eq 0) $result.text;Assert (-not [IO.File]::Exists((Join-Path $data 'installed.jsonl'))) 'Core only installed plugins'
Write-Output 'Windows online installer fixtures passed: latest download, dependency, identity/digest, permissions, retry, preserved sources/preferences, no automatic revival or mutation replay.'
