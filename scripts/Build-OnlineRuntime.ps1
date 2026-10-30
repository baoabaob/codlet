[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$BaseDirectory,
  [Parameter(Mandatory=$true)][string]$Version,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [ValidateSet('stable','preview')][string]$Channel='preview',
  [string]$BuildRoot=(Split-Path -Parent $PSScriptRoot),
  [string[]]$ModuleIds,
  [switch]$SourceOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if($SourceOnly -and $ModuleIds){throw 'SourceOnly cannot be combined with ModuleIds'}
$root=[IO.Path]::GetFullPath($BuildRoot);$base=[IO.Path]::GetFullPath($BaseDirectory);$output=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath $output){throw 'Fresh online output required'}
$parent=[IO.Path]::GetDirectoryName($output);[IO.Directory]::CreateDirectory($parent)|Out-Null
function Plain([string]$file){for($cursor=[IO.Path]::GetFullPath($file);$cursor;$cursor=[IO.Path]::GetDirectoryName($cursor)){if((Test-Path -LiteralPath $cursor) -and ([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint)){throw 'Linked online build path'}}}
Plain $parent;Plain $base;Plain $root
$scratch=Join-Path $parent ('.online-input-'+[Guid]::NewGuid().ToString('N'));[IO.Directory]::CreateDirectory($scratch)|Out-Null
$utf8=[Text.UTF8Encoding]::new($false)
try{
  $reportPath=Join-Path $scratch 'base-inspection.json'
  & node (Join-Path $PSScriptRoot 'inspect-online-base.mjs') $base $root $reportPath|Out-Null
  if($LASTEXITCODE -ne 0){throw 'Resident distribution verification failed'}
  $inspection=[IO.File]::ReadAllText($reportPath)|ConvertFrom-Json
  if(-not $inspection.staticCompatible){
    [IO.Directory]::CreateDirectory($output)|Out-Null
    [IO.File]::Copy($reportPath,(Join-Path $output 'base-inspection.json'),$false)
    return [pscustomobject]@{eligible=$false;baseVersion=$inspection.baseVersion;residentSha256=$inspection.residentSha256;reason=$inspection.reason;inspection=(Join-Path $output 'base-inspection.json')}
  }
  $payloadRoot=Join-Path $scratch 'payload';[IO.Directory]::CreateDirectory($payloadRoot)|Out-Null
  foreach($file in $inspection.residentFiles){
    $target=Join-Path $payloadRoot $file.path;[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))|Out-Null
    [IO.File]::Copy((Join-Path $base $file.path),$target,$false)
    if((Get-Item -LiteralPath $target).Length -ne $file.bytes -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256){throw 'Resident input changed during copy'}
  }
  $metadataPath=Join-Path $scratch 'online-metadata.json'
  $selection=@(if(-not $SourceOnly){if($ModuleIds){'--modules='+($ModuleIds -join ',')}else{'--all-modules'}})
  & node (Join-Path $PSScriptRoot 'prepare-online-core.mjs') $metadataPath $root @selection|Out-Null
  if($LASTEXITCODE -ne 0){throw 'Online contract preparation failed'}
  $metadata=[IO.File]::ReadAllText($metadataPath)|ConvertFrom-Json
  $components=@($metadata.clientSourcePath)
  if($metadata.PSObject.Properties['modules']){$components+=@($metadata.modules|ForEach-Object {$_.path})}
  foreach($relative in $components){$source=Join-Path $root $relative;Plain $source;$target=Join-Path $payloadRoot $relative;[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))|Out-Null;[IO.File]::Copy($source,$target,$false)}
  $built=& (Join-Path $PSScriptRoot 'Build-RuntimeUpdate.ps1') -InputDirectory $payloadRoot -PayloadProfile portable -Version $Version -OutputDirectory $output -Channel $Channel -OnlineCoreMetadata $metadataPath
  $name='codlet-online-'+$Version+'-win-x64-'+$inspection.residentSha256.Substring(0,16)+'.zip'
  $archive=Join-Path $output $name
  [IO.File]::Move($built.archive,$archive)
  # A targeted payload is only advertised by the v2 catalog. Never emit a
  # generic v1 channel that could select it for a different resident build.
  foreach($file in @($built.channelManifest,($built.archive+'.sha256'))){$full=[IO.Path]::GetFullPath($file);if(-not $full.StartsWith($output.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Cleanup escaped online output'};Plain $full;Remove-Item -LiteralPath $full}
  [IO.File]::Copy($reportPath,(Join-Path $output 'base-inspection.json'),$false)
  [IO.File]::Copy($metadataPath,(Join-Path $output 'online-metadata.json'),$false)
  $receipt=[ordered]@{schema=1;kind='codlet-online-build';version=$Version;baseVersion=$inspection.baseVersion;residentSha256=$inspection.residentSha256;installerOwned=$inspection.installerOwned;archive=$name;bytes=$built.bytes;sha256=$built.sha256;components=$components;runtimePreflightRequired=$true;published=$false}
  [IO.File]::WriteAllText((Join-Path $output 'online-build.json'),($receipt|ConvertTo-Json -Depth 8)+"`n",$utf8)
  [pscustomobject]@{eligible=$true;baseVersion=$inspection.baseVersion;residentSha256=$inspection.residentSha256;archive=$archive;bytes=$built.bytes;sha256=$built.sha256;receipt=(Join-Path $output 'online-build.json')}
}finally{
  $resolved=[IO.Path]::GetFullPath($scratch)
  if(-not $resolved.StartsWith($parent.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Online cleanup escaped output parent'}
  Plain $resolved
  foreach($item in Get-ChildItem -LiteralPath $resolved -Recurse){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked online cleanup target'}}
  [IO.Directory]::Delete($resolved,$true)
}
