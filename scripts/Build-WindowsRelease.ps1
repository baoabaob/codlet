[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [Parameter(Mandatory=$true)][string]$WixDirectory,
  [Parameter(Mandatory=$true)][string]$GuiBundleDirectory,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$GuiSourceCommit,
  [string]$ToolchainRoot,
  [ValidateSet('stable','preview')][string]$Channel='preview',
  [string[]]$OnlineBaseDirectories=@(),
  [string[]]$OnlineModuleIds,
  [switch]$OnlineSourceOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if($OnlineSourceOnly -and $OnlineModuleIds){throw 'OnlineSourceOnly cannot be combined with OnlineModuleIds'}
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$output=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath $output){throw 'A fresh Windows release directory is required'}
for($cursor=[IO.Path]::GetDirectoryName($output);$cursor;$cursor=[IO.Path]::GetDirectoryName($cursor)){if((Test-Path -LiteralPath $cursor) -and ([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint)){throw 'Linked release output path'}}
$sourceCommit=(& git -C $root rev-parse HEAD).Trim()
if($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[0-9a-f]{40}$'){throw 'A committed Core checkout is required'}
& git -C $root diff --quiet HEAD -- .
if($LASTEXITCODE -ne 0){throw 'Commit the build sources before creating release artifacts'}
$version=[regex]::Match([IO.File]::ReadAllText((Join-Path $root 'Cargo.toml')),'(?m)^version = "([^"]+)"').Groups[1].Value
if($Channel -eq 'stable' -and $version.Contains('-')){throw 'Stable builds require a final version'}
[IO.Directory]::CreateDirectory($output)|Out-Null
$arguments=@{Release=$true};if($ToolchainRoot){$arguments.ToolchainRoot=$ToolchainRoot}
& (Join-Path $PSScriptRoot 'Build-Core.ps1') @arguments
if($LASTEXITCODE -ne 0){throw 'Core build failed'}
$metadata=& cargo metadata --locked --format-version 1 --no-deps --manifest-path (Join-Path $root 'Cargo.toml')
if($LASTEXITCODE -ne 0){throw 'Cannot resolve the compiled Core directory'}
$CodletExecutable=Join-Path (($metadata|ConvertFrom-Json).target_directory) 'release/codlet.exe'
$built=$true
$portable=Join-Path $output 'portable'
& (Join-Path $PSScriptRoot 'Build-Distribution.ps1') -CodletExecutable $CodletExecutable -OutputDirectory $portable -SourceCommit $sourceCommit -GuiBundleDirectory $GuiBundleDirectory -GuiSourceCommit $GuiSourceCommit -UpdateChannel $Channel|Out-Null
$msi=Join-Path $output ('Codlet-'+$version+'-windows-x64.msi')
& node (Join-Path $PSScriptRoot 'build-msi.mjs') $portable $WixDirectory $msi
if($LASTEXITCODE -ne 0){throw 'MSI build failed'}
$setup=Join-Path $output ('Codlet-'+$version+'-windows-x64-setup.exe')
& (Join-Path $PSScriptRoot 'Build-WindowsInstaller.ps1') -MsiPath $msi -OutputPath $setup -Version $version|Out-Null
$planArguments=@{Action='Plan';WindowsPortableDirectory=$portable;WindowsMsi=$msi;WindowsMsiManifest=(Join-Path ($msi+'.build') 'distribution-manifest.json');WindowsSetup=$setup;WindowsOnly=$true;OutputDirectory=(Join-Path $output 'release');Channel=$Channel;WindowsOnlineBaseDirectories=$OnlineBaseDirectories}
if($OnlineModuleIds){$planArguments.OnlineModuleIds=$OnlineModuleIds}
if($OnlineSourceOnly){$planArguments.OnlineSourceOnly=$true}
$plan=& (Join-Path $PSScriptRoot 'Publish-Release.ps1') @planArguments
$plan|Out-String|Set-Content -LiteralPath (Join-Path $output 'release-plan-output.json') -Encoding UTF8
$receipt=[ordered]@{schema=1;kind='codlet-windows-release-build';version=$version;sourceCommit=$sourceCommit;builtCore=$built;coreSha256=(Get-FileHash -LiteralPath $CodletExecutable -Algorithm SHA256).Hash.ToLowerInvariant();msi=$msi;setup=$setup;releasePlan=(Join-Path $output 'release/release-plan.json');published=$false}
[IO.File]::WriteAllText((Join-Path $output 'build-result.json'),($receipt|ConvertTo-Json -Depth 6)+"`n",[Text.UTF8Encoding]::new($false))
$receipt|ConvertTo-Json
