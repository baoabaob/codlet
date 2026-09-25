[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$CodletExecutable,
  [string]$NodeDirectory,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$SourceCommit,
  [switch]$Zip,
  [switch]$BundleNodeForTests
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$output=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath $output){throw 'Choose a new output directory'}
function Plain([string]$Path){for($current=[IO.Path]::GetFullPath($Path);$current;$current=[IO.Path]::GetDirectoryName($current)){if((Test-Path -LiteralPath $current) -and (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw "Linked distribution path: $current"}}}
function Hash([string]$Path){$algorithm=[Security.Cryptography.SHA256]::Create();$stream=[IO.File]::OpenRead($Path);try{[BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant()}finally{$stream.Dispose();$algorithm.Dispose()}}
$utf8=[Text.UTF8Encoding]::new($false)
Plain $output;Plain $CodletExecutable
$pin=[IO.File]::ReadAllText((Join-Path $root 'runtime/node-runtime.json'))|ConvertFrom-Json
$pinMode=if($BundleNodeForTests){'bundled'}else{'managed'}
if($BundleNodeForTests -and -not $NodeDirectory){throw 'BundleNodeForTests requires NodeDirectory'}
$spec=$pin.platforms.'win-x64'
if($spec.executableSha256 -notmatch '^[0-9a-f]{64}$' -or $spec.licenseSha256 -notmatch '^[0-9a-f]{64}$'){throw 'Invalid pinned Windows x64 runtime'}
if($BundleNodeForTests){
  Plain $NodeDirectory
  if((Hash (Join-Path $NodeDirectory 'node.exe')) -ne $spec.executableSha256 -or (Hash (Join-Path $NodeDirectory 'LICENSE')) -ne $spec.licenseSha256){throw 'Node does not match the pinned Windows x64 runtime'}
}
$exeStream=[IO.File]::OpenRead($CodletExecutable)
try{$reader=[IO.BinaryReader]::new($exeStream);if($reader.ReadUInt16() -ne 0x5a4d){throw 'Expected PE executable'};$exeStream.Position=60;$peOffset=$reader.ReadUInt32();$exeStream.Position=$peOffset;if($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664){throw 'Expected Windows x64 executable'}}finally{$exeStream.Dispose()}
$cargo=[IO.File]::ReadAllText((Join-Path $root 'Cargo.toml'))
$version=[regex]::Match($cargo,'(?m)^version = "([^"]+)"').Groups[1].Value
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
[IO.Directory]::CreateDirectory((Join-Path $stage 'runtime'))|Out-Null
$pin|Add-Member -NotePropertyName mode -NotePropertyValue $pinMode -Force
[IO.File]::WriteAllText((Join-Path $stage 'runtime/node-runtime.json'),($pin|ConvertTo-Json -Depth 12)+"`n",$utf8)
Copy-Payload (Join-Path $root 'runtime/update-channel.json') 'runtime/update-channel.json'
if($BundleNodeForTests){
  $nodeRelative='runtime/node-v'+$pin.version+'-win-x64'
  Copy-Payload (Join-Path $NodeDirectory 'node.exe') ($nodeRelative+'/node.exe')
  Copy-Payload (Join-Path $NodeDirectory 'LICENSE') ($nodeRelative+'/LICENSE')
}
foreach($name in @('Start-Codlet.cmd','Codlet-CLI.cmd','Initialize-Codlet.ps1')){Copy-Payload (Join-Path $root ('scripts/distribution/'+$name)) $name}
Copy-Payload (Join-Path $root 'scripts/Restart-Codlet.ps1') 'Restart-Codlet.ps1'
Copy-Payload (Join-Path $root 'scripts/Export-Diagnostics.ps1') 'Export-Diagnostics.ps1'
Copy-Payload (Join-Path $root 'assets/codlet/ico/codlet.ico') 'codlet.ico'
Copy-Payload (Join-Path $root 'scripts/distribution/official-plugins.json') 'official-plugins.json'
Get-ChildItem -LiteralPath (Join-Path $root 'types') -Filter '*.d.ts' -File | ForEach-Object{Copy-Payload $_.FullName ('sdk/types/'+$_.Name)}
Copy-Payload (Join-Path $root 'docs/THIRD_PARTY_UI_LICENSES.txt') 'THIRD_PARTY_NOTICES.txt'
Copy-Payload (Join-Path $root 'docs/THIRD_PARTY_RUST_LICENSES.txt') 'THIRD_PARTY_RUST_LICENSES.txt'
foreach($name in @('LICENSE','NOTICE')){Copy-Payload (Join-Path $root $name) $name}
[IO.File]::WriteAllText((Join-Path $stage 'portable.mode'),"Codlet-only data lives in ./data; official Codex data is unchanged.`n",$utf8)
$readme=@'
# Codlet Windows x64 Preview

1. Extract the complete directory to a writable location
2. Run Codlet-Launcher.exe; it lists running applications before launch
3. On first portable launch, choose official plugins to download from GitHub

Codlet prepares its private JavaScript runtime from a verified official Codex
installation when available. Otherwise it downloads the pinned official Node
archive into its private cache. A system Node installation is not required.

The package contains Core only, with no plugin code or fixed plugin versions.
GUI includes UI Adapter in the download selection. Desktop Adapter is optional.
Setup uses the latest published GitHub Release through the regular CLI importer.
Existing plugins are never replaced, downgraded or re-enabled by Core setup.
Network failure leaves an unfinished selection retryable; there is no bundled fallback.
Use the GUI marketplace or CLI to add other plugins later. Existing registrations,
disabled states and grants are preserved. To remove a plugin, use GUI or:

    Codlet-CLI.cmd plugin remove PLUGIN_ID --cascade --json

Codlet-CLI.cmd scopes CLI commands to this portable directory's data/. The MSI
edition uses the current user's LocalAppData/Codlet data instead. Neither changes
the official client's account, configuration or conversation database location.

The MSI installs for the current user and provides a feature selection page.
Uninstall removes application files and shortcuts; plugin/config/data are retained.
MSI repair does not overwrite downloaded plugins in the user data directory.

This unsigned package targets Windows x64. Install the official Codex client
separately. Check the compatibility evidence and known issues at the Core revision
recorded in distribution-manifest.json; a package version does not certify every
official client build. Use Codlet-CLI.cmd doctor --json for local diagnostics.
macOS packages are distributed separately; Windows ARM64 is not included here.
Official launches may reuse an already extended instance; a Core crash does not
guarantee the official client closes. Real cross-version official update acceptance
is still pending. The Preview update channel uses published test releases.

Source and test releases: https://github.com/baoabaob/codlet
Official plugin development: https://github.com/baoabaob/codlet-plugins
Plugin download choices, source identities and initial permission expectations
are recorded in official-plugins.json; no local plugin build is needed for Core.
Downloads are registered as ordinary GitHub plugins from their first install.
Private repositories and draft releases are not supported by this importer.

No real account information, registry files or dev-client data is included.
The manifest records the full Core source commit, each distributed
file and its SHA-256. License and attribution terms are included in LICENSE,
NOTICE and THIRD_PARTY_NOTICES.txt. The JavaScript runtime's LICENSE is stored
with the prepared runtime in Codlet's private cache.
'@
[IO.File]::WriteAllText((Join-Path $stage 'README.md'),$readme.Replace("`r`n","`n")+"`n",$utf8)
$records=@(Get-ChildItem -LiteralPath $stage -Recurse -File | Sort-Object FullName | ForEach-Object{[ordered]@{path=$_.FullName.Substring($stage.Length+1).Replace('\','/');bytes=$_.Length;sha256=Hash $_.FullName}})
$manifest=[ordered]@{schema=1;kind='codlet-portable-distribution';version=$version;platform='win-x64';runtime=[ordered]@{mode=$pinMode;version=$pin.version;executableSha256=$spec.executableSha256;licenseSha256=$spec.licenseSha256};sourceCommit=$SourceCommit.ToLowerInvariant();pluginDelivery='github-latest';files=$records}
[IO.File]::WriteAllText((Join-Path $stage 'distribution-manifest.json'),($manifest|ConvertTo-Json -Depth 8),$utf8)
[IO.Directory]::Move($stage,$output)
$zipPath=$null
if($Zip){$zipPath=$output+'.zip';if(Test-Path -LiteralPath $zipPath){throw 'ZIP already exists'};Add-Type -AssemblyName System.IO.Compression.FileSystem;[IO.Compression.ZipFile]::CreateFromDirectory($output,$zipPath,[IO.Compression.CompressionLevel]::Optimal,$false)}
[pscustomobject]@{directory=$output;version=$version;zip=$zipPath;zipSha256=$(if($zipPath){Hash $zipPath})}|ConvertTo-Json -Compress
