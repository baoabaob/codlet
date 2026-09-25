[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$fixtureRoot=Join-Path ([IO.Path]::GetTempPath()) ('codlet-encoding-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($fixtureRoot)|Out-Null
$fixtureApp=Join-Path $fixtureRoot ("application with spaces ' "+[char]0x6d4b+[char]0x8bd5)
[IO.Directory]::CreateDirectory($fixtureApp)|Out-Null
$fixtureExecutable=Join-Path $fixtureApp 'codlet.exe'
$fixtureSource=Join-Path $fixtureRoot 'fixture.cs'
$fixtureCode=@'
using System;
using System.Text;
public static class Utf8CliFixture {
  public static int Main(string[] args) {
    bool failed = args.Length == 1 && args[0] == "fail";
    bool echo = args.Length > 0 && args[0] == "echo";
    if (!echo && !failed && !(args.Length == 3 && args[0] == "plugin" && args[1] == "list" && args[2] == "--json")) return 8;
    string json = "{\"plugins\":[{\"id\":\"codlet-gui\",\"manifest\":{\"name\":\"\u63d2\u4ef6\u3002\"}}],\"path\":\"C:\\\\\u6d4b\u8bd5\\\\plug in\\\\\"}";
    if (echo) json = new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(new { arguments = args });
    byte[] bytes = new UTF8Encoding(false).GetBytes(json);
    var output = Console.OpenStandardOutput();
    output.Write(bytes, 0, bytes.Length);
    output.Flush();
    return failed ? 7 : 0;
  }
}
'@
[IO.File]::WriteAllText($fixtureSource,$fixtureCode,[Text.UTF8Encoding]::new($false))
$fixtureFramework=if([Environment]::Is64BitOperatingSystem){'Framework64'}else{'Framework'}
$fixtureCompiler=Join-Path ([Environment]::GetFolderPath('Windows')) "Microsoft.NET\$fixtureFramework\v4.0.30319\csc.exe"
& $fixtureCompiler /nologo /target:exe /reference:System.Web.Extensions.dll ("/out:"+$fixtureExecutable) $fixtureSource
if($LASTEXITCODE -ne 0){throw 'UTF-8 CLI fixture compilation failed'}
$fixtureInitializer=Join-Path $fixtureApp 'Initialize-Codlet.ps1'
[IO.File]::WriteAllText($fixtureInitializer,[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'distribution/Initialize-Codlet.ps1')),[Text.UTF8Encoding]::new($true))
[IO.File]::WriteAllText((Join-Path $fixtureApp 'official-plugins.json'),'{"schema":1,"kind":"codlet-plugin-download-options","plugins":[]}',[Text.UTF8Encoding]::new($false))
$fixtureExpectedName=([string][char]0x63d2)+[char]0x4ef6+[char]0x3002
$fixtureExpectedPath='C:\'+[char]0x6d4b+[char]0x8bd5+'\plug in\'
$fixturePreviousEncoding=[Console]::OutputEncoding
$fixturePreviousHome=$env:CODLET_HOME
$fixtureChecks=@()
try{
  foreach($fixtureCodePage in @(936,1252,65001)){
    [Console]::OutputEncoding=[Text.Encoding]::GetEncoding($fixtureCodePage)
    $fixtureData=Join-Path $fixtureRoot ('data-'+$fixtureCodePage)
    # Run the shipped startup path, then exercise its actual native JSON reader.
    . $fixtureInitializer -NoLaunch -Plugins @('none') -DataDirectory $fixtureData
    $fixtureReply=Invoke-Cli -Arguments @('plugin','list','--json')
    if($fixtureReply.plugins[0].manifest.name -cne $fixtureExpectedName -or $fixtureReply.path -cne $fixtureExpectedPath){throw 'UTF-8 JSON did not round-trip'}
    if([Console]::OutputEncoding.CodePage -ne $fixtureCodePage){throw 'Successful CLI read changed the caller encoding'}
    $fixtureFailed=$false
    try{$null=Invoke-Cli -Arguments @('fail')}catch{$fixtureFailed=$true}
    if(-not $fixtureFailed){throw 'A failed CLI was accepted'}
    if([Console]::OutputEncoding.CodePage -ne $fixtureCodePage){throw 'Failed CLI read changed the caller encoding'}
    $fixtureArguments=@('echo',('C:\path with spaces\'+[char]0x6d4b+'\'),'quote"inside','backslash\"quote')
    $fixtureEcho=Invoke-Cli -Arguments $fixtureArguments
    if(@(Compare-Object $fixtureArguments $fixtureEcho.arguments -SyncWindow 0).Count -ne 0){throw 'CLI argument quoting changed spaces, Unicode, quotes or trailing slashes'}
    $fixtureChecks+=@{codePage=$fixtureCodePage;unicodePreserved=$true;callerEncodingRestored=$true;failureRejected=$true}
  }
}finally{
  [Console]::OutputEncoding=$fixturePreviousEncoding
  if($null -eq $fixturePreviousHome){Remove-Item Env:CODLET_HOME -ErrorAction SilentlyContinue}else{$env:CODLET_HOME=$fixturePreviousHome}
}
[ordered]@{passed=$true;powershell=$PSVersionTable.PSVersion.ToString();checks=$fixtureChecks}|ConvertTo-Json -Depth 5 -Compress
