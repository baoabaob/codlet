[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$CodletExecutable,
  [Parameter(Mandatory=$true)][string]$NodeDirectory,
  [Parameter(Mandatory=$true)][string]$PluginDistribution,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$SourceCommit,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$PluginsCommit,
  [switch]$Zip
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$output=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath $output){throw 'Choose a new output directory'}
function Plain([string]$Path){for($current=[IO.Path]::GetFullPath($Path);$current;$current=[IO.Path]::GetDirectoryName($current)){if((Test-Path -LiteralPath $current) -and (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw "Linked distribution path: $current"}}}
function Hash([string]$Path){$algorithm=[Security.Cryptography.SHA256]::Create();$stream=[IO.File]::OpenRead($Path);try{[BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant()}finally{$stream.Dispose();$algorithm.Dispose()}}
$utf8=[Text.UTF8Encoding]::new($false)
Plain $output;Plain $CodletExecutable;Plain $NodeDirectory;Plain $PluginDistribution
$pin=[IO.File]::ReadAllText((Join-Path $root 'runtime/node-runtime.json'))|ConvertFrom-Json
$spec=$pin.platforms.'win-x64'
if((Hash (Join-Path $NodeDirectory 'node.exe')) -ne $spec.executableSha256 -or (Hash (Join-Path $NodeDirectory 'LICENSE')) -ne $spec.licenseSha256){throw 'Node does not match the pinned Windows x64 runtime'}
$exeStream=[IO.File]::OpenRead($CodletExecutable)
try{$reader=[IO.BinaryReader]::new($exeStream);if($reader.ReadUInt16() -ne 0x5a4d){throw 'Expected PE executable'};$exeStream.Position=60;$peOffset=$reader.ReadUInt32();$exeStream.Position=$peOffset;if($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664){throw 'Expected Windows x64 executable'}}finally{$exeStream.Dispose()}
$cargo=[IO.File]::ReadAllText((Join-Path $root 'Cargo.toml'))
$version=[regex]::Match($cargo,'(?m)^version = "([^"]+)"').Groups[1].Value
$catalog=[IO.File]::ReadAllText((Join-Path $PluginDistribution 'catalog.json'))|ConvertFrom-Json
if($catalog.schema -ne 1 -or $catalog.kind -ne 'codlet-official-plugin-bundle'){throw 'Invalid independent plugin catalog'}
$seedIds=if($catalog.PSObject.Properties['installerPlugins']){@($catalog.installerPlugins)}else{@($catalog.packages.id)}
if(@($seedIds|Sort-Object -Unique).Count -ne @($seedIds).Count){throw 'Duplicate installer plugin selection'}
foreach($id in $seedIds){if($id -notin @('codex.ui.adapter','codex.desktop.adapter','codlet-gui') -or @($catalog.packages|Where-Object{$_.id -eq $id}).Count -ne 1){throw 'Invalid installer plugin selection'}}
if('codlet-gui' -in $seedIds -and 'codex.ui.adapter' -notin $seedIds){throw 'The GUI installer preset requires UI Adapter'}
$catalog.packages=@($catalog.packages|Where-Object{$_.id -in $seedIds})
$pluginOrigins=@();$repositories=@{}
foreach($package in $catalog.packages){
  # Older local-preview catalogs remain readable. New catalogs preserve each
  # independent release channel without fabricating a GitHub install receipt.
  if($package.PSObject.Properties['repository']){
    if($package.repository -notmatch '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $repositories.ContainsKey($package.repository) -or $package.tag -ne ('v'+$package.version)){throw 'Invalid independent plugin release channel'}
    $repositories[$package.repository]=$true
    $pluginOrigins+=@{id=$package.id;version=$package.version;repository=$package.repository;tag=$package.tag;packageSha256=$package.sha256;registration='local-seed'}
  }
}
$stage=$output+'.stage-'+[Guid]::NewGuid().ToString('N')
[IO.Directory]::CreateDirectory($stage)|Out-Null
function Copy-Payload([string]$Source,[string]$Relative){
  Plain $Source
  $target=[IO.Path]::GetFullPath((Join-Path $stage $Relative))
  if(-not $target.StartsWith($stage+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Payload escaped staging'}
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))|Out-Null
  if($Relative -eq 'Initialize-Codlet.ps1'){[IO.File]::WriteAllText($target,[IO.File]::ReadAllText($Source),[Text.UTF8Encoding]::new($true))}
  else{[IO.File]::Copy($Source,$target,$false)}
}
Copy-Payload $CodletExecutable 'codlet.exe'
& (Join-Path $PSScriptRoot 'Build-WindowsLauncher.ps1') -OutputDirectory $stage | Out-Null
Copy-Payload (Join-Path $root 'runtime/node-runtime.json') 'runtime/node-runtime.json'
Copy-Payload (Join-Path $root 'runtime/update-channel.json') 'runtime/update-channel.json'
$nodeRelative='runtime/node-v'+$pin.version+'-win-x64'
Copy-Payload (Join-Path $NodeDirectory 'node.exe') ($nodeRelative+'/node.exe')
Copy-Payload (Join-Path $NodeDirectory 'LICENSE') ($nodeRelative+'/LICENSE')
foreach($name in @('Start-Codlet.cmd','Choose-Plugins.cmd','Codlet-CLI.cmd','Initialize-Codlet.ps1')){Copy-Payload (Join-Path $root ('scripts/distribution/'+$name)) $name}
Copy-Payload (Join-Path $root 'scripts/Restart-Codlet.ps1') 'Restart-Codlet.ps1'
Copy-Payload (Join-Path $root 'scripts/Export-Diagnostics.ps1') 'Export-Diagnostics.ps1'
Copy-Payload (Join-Path $root 'assets/codlet/ico/codlet.ico') 'codlet.ico'
[IO.Directory]::CreateDirectory((Join-Path $stage 'optional-plugins'))|Out-Null
[IO.File]::WriteAllText((Join-Path $stage 'optional-plugins/catalog.json'),($catalog|ConvertTo-Json -Depth 20),$utf8)
foreach($package in $catalog.packages){
  if($package.id -notin @('codex.ui.adapter','codex.desktop.adapter','codlet-gui')){throw 'Unexpected package in first-party catalog'}
  foreach($file in $package.files){
    if($file.path -notmatch '^[a-zA-Z0-9._/-]+$' -or $file.path.Split('/') -contains '..'){throw 'Invalid package payload path'}
    $relative='packages/'+$package.id+'/'+$file.path
    $source=Join-Path $PluginDistribution $relative
    if((Hash $source) -ne $file.sha256){throw ('Plugin payload mismatch: '+$relative)}
    Copy-Payload $source ('optional-plugins/'+$relative)
  }
}
Get-ChildItem -LiteralPath (Join-Path $root 'types') -Filter '*.d.ts' -File | ForEach-Object{Copy-Payload $_.FullName ('sdk/types/'+$_.Name)}
Copy-Payload (Join-Path $root 'docs/THIRD_PARTY_UI_LICENSES.txt') 'THIRD_PARTY_NOTICES.txt'
foreach($name in @('LICENSE','NOTICE')){Copy-Payload (Join-Path $root $name) $name}
[IO.File]::WriteAllText((Join-Path $stage 'portable.mode'),"Codlet-only data lives in ./data; official Codex data is unchanged.`n",$utf8)
$readme=@'
# Codlet Windows x64 Preview

1. Extract the complete directory to a writable location
2. Run Codlet-Launcher.exe; it lists running applications before launch
3. On first portable launch, choose the official plugins you want

GUI automatically includes UI Adapter. Desktop Adapter is independently optional.
Codlet-Launcher.exe --configure can install an omitted plugin later. Existing registrations,
disabled states and grants are preserved. To remove a plugin, use GUI or:

    Codlet-CLI.cmd plugin remove PLUGIN_ID --cascade --json

Codlet-CLI.cmd scopes CLI commands to this portable directory's data/. The MSI
edition uses the current user's LocalAppData/Codlet data instead. Neither changes
the official client's account, configuration or conversation database location.

The MSI installs for the current user and provides a feature selection page.
Uninstall removes application files and shortcuts; plugin/config/data are retained.
MSI repair does not overwrite plugins copied into the user data directory.

This unsigned package targets Windows x64. Install the official Codex client
separately. Check the compatibility evidence and known issues at the Core revision
recorded in distribution-manifest.json; a package version does not certify every
official client build. Use Codlet-CLI.cmd doctor --json for local diagnostics.
macOS packages are distributed separately; Windows ARM64 is not included here.
Official launches may reuse an already extended instance; a Core crash does not
guarantee the official client closes. Real cross-version official update acceptance
is still pending. The update source is not yet published.

Source (private during preview): https://github.com/baoabaob/codlet
Official plugin development: https://github.com/baoabaob/codlet-plugins
Independent plugin release channels are recorded in optional-plugins/catalog.json.
Offline presets remain local installations; this does not enable GitHub updates
for existing local registrations or grant access to private/draft releases.

No real account information, registry files or dev-client data is included.
The manifest records the full Core and plugin source commits, each distributed
file and its SHA-256. License and attribution terms are included in LICENSE,
NOTICE, THIRD_PARTY_NOTICES.txt and the bundled Node and plugin license files.
'@
[IO.File]::WriteAllText((Join-Path $stage 'README.md'),$readme.Replace("`r`n","`n")+"`n",$utf8)
$records=@(Get-ChildItem -LiteralPath $stage -Recurse -File | Sort-Object FullName | ForEach-Object{[ordered]@{path=$_.FullName.Substring($stage.Length+1).Replace('\','/');bytes=$_.Length;sha256=Hash $_.FullName}})
$manifest=[ordered]@{schema=1;kind='codlet-portable-distribution';version=$version;platform='win-x64';sourceCommit=$SourceCommit.ToLowerInvariant();pluginsCommit=$PluginsCommit.ToLowerInvariant();officialPlugins=$pluginOrigins;files=$records}
[IO.File]::WriteAllText((Join-Path $stage 'distribution-manifest.json'),($manifest|ConvertTo-Json -Depth 8),$utf8)
[IO.Directory]::Move($stage,$output)
$zipPath=$null
if($Zip){$zipPath=$output+'.zip';if(Test-Path -LiteralPath $zipPath){throw 'ZIP already exists'};Add-Type -AssemblyName System.IO.Compression.FileSystem;[IO.Compression.ZipFile]::CreateFromDirectory($output,$zipPath,[IO.Compression.CompressionLevel]::Optimal,$false)}
[pscustomobject]@{directory=$output;version=$version;zip=$zipPath;zipSha256=$(if($zipPath){Hash $zipPath})}|ConvertTo-Json -Compress
