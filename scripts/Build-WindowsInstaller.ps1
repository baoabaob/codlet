[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$MsiPath,[Parameter(Mandatory=$true)][string]$OutputPath,[Parameter(Mandatory=$true)][string]$Version,[switch]$FixturePayload)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$versionJson=& node (Join-Path $PSScriptRoot 'windows-version.mjs') $Version
if($LASTEXITCODE -ne 0){throw 'Invalid Windows package version'}
$windowsVersion=$versionJson|ConvertFrom-Json
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$msi=[IO.Path]::GetFullPath($MsiPath);$output=[IO.Path]::GetFullPath($OutputPath)
if(-not [IO.File]::Exists($msi)){throw 'Build the MSI payload first'}
if(-not $FixturePayload){
  $installer=New-Object -ComObject WindowsInstaller.Installer
  $database=$null
  try{
    $database=$installer.OpenDatabase($msi,0)
    $query=$database.OpenView("SELECT ``Value`` FROM ``Property`` WHERE ``Property``='ProductVersion'");$query.Execute()
    $msiVersion=$query.Fetch().StringData(1);$query.Close()
    if($msiVersion -ne $windowsVersion.msiVersion){throw 'MSI version differs from the native installer'}
    $query=$database.OpenView("SELECT ``Value`` FROM ``Property`` WHERE ``Property``='UpgradeCode'");$query.Execute()
    $upgradeCode=$query.Fetch().StringData(1);$query.Close()
    if($upgradeCode -ne '{941C0F18-D41F-46E9-A3D1-A9562D75BF76}'){throw 'Expected the Codlet MSI product family'}
  }finally{if($database){[Runtime.InteropServices.Marshal]::ReleaseComObject($database)|Out-Null};[Runtime.InteropServices.Marshal]::ReleaseComObject($installer)|Out-Null}
}
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($output))|Out-Null
$framework=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$compiler=Join-Path $framework 'csc.exe'
$source=Join-Path $PSScriptRoot 'installer'
$buildDirectory=$output+'.build'
[IO.Directory]::CreateDirectory($buildDirectory)|Out-Null
$versionSource=Join-Path $buildDirectory 'Version.cs'
$digest=(Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash.ToLowerInvariant()
$numeric=$windowsVersion.fileVersion
$versionText='using System.Reflection; [assembly: AssemblyTitle("Codlet Setup")] [assembly: AssemblyProduct("Codlet")] [assembly: AssemblyVersion("'+$numeric+'")] [assembly: AssemblyFileVersion("'+$numeric+'")] namespace Codlet.Setup { static class SetupBuild { public const string Version="'+$Version+'"; public const string PayloadHash="'+$digest+'"; } }'
[IO.File]::WriteAllText($versionSource,$versionText,[Text.UTF8Encoding]::new($false))
$refs=@('System.dll','System.Core.dll','System.Xaml.dll','System.Windows.Forms.dll','System.Drawing.dll')
$argsList=@('/nologo','/optimize+','/platform:x64','/target:winexe','/main:Codlet.Setup.SetupProgram',('/out:'+$output),('/win32manifest:'+(Join-Path $source 'launcher.manifest')),('/win32icon:'+(Join-Path $repo 'assets/codlet/ico/codlet.ico')))
$argsList+=@($refs|ForEach-Object{'/reference:'+$_})
if($FixturePayload){$argsList+='/define:SETUP_FIXTURE'}
$argsList+=@('WindowsBase.dll','PresentationCore.dll','PresentationFramework.dll'|ForEach-Object{'/reference:'+(Join-Path $framework ('WPF/'+$_))})
$argsList+=@(('/resource:'+$msi+',Codlet.Payload.msi'),('/resource:'+(Join-Path $source 'Setup.xaml')+',Codlet.Setup.xaml'),('/resource:'+(Join-Path $repo 'assets/codlet/png/black/codlet-128.png')+',Codlet.Logo.Black'),('/resource:'+(Join-Path $repo 'assets/codlet/png/white/codlet-128.png')+',Codlet.Logo.White'))
$argsList+=@($versionSource,(Join-Path $source 'Setup.cs'),(Join-Path $source 'MsiSession.cs'),(Join-Path $source 'FolderPicker.cs'),(Join-Path $source 'ProcessGate.cs'))
& $compiler @argsList
if($LASTEXITCODE -ne 0){throw 'Native installer compilation failed'}
$result=[ordered]@{path=$output;version=$Version;bytes=([IO.FileInfo]$output).Length;sha256=(Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant();payloadSha256=$digest;ui='native-wpf';runtime='Windows .NET Framework';fixture=[bool]$FixturePayload;signed=$false}
[IO.File]::WriteAllText(($output+'.json'),($result|ConvertTo-Json)+"`n",[Text.UTF8Encoding]::new($false))
$result|ConvertTo-Json -Compress
