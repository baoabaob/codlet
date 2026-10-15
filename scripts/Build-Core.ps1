[CmdletBinding()]
param([switch]$Release, [string]$ToolchainRoot, [string]$TargetDirectory)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if($ToolchainRoot){
  $env:CARGO_HOME=Join-Path $ToolchainRoot 'cargo'
  $env:RUSTUP_HOME=Join-Path $ToolchainRoot 'rustup'
  $env:PATH=(Join-Path $env:CARGO_HOME 'bin')+';'+(Join-Path $ToolchainRoot 'w64devkit/bin')+';'+$env:PATH
  $env:RUSTFLAGS='-C link-self-contained=yes -C linker=rust-lld'
}
if($TargetDirectory){$env:CARGO_TARGET_DIR=$TargetDirectory}
Push-Location $root
try{
  $metadata=& cargo metadata --locked --format-version 1 --no-deps
  if($LASTEXITCODE -ne 0){throw 'Cannot resolve the Cargo output directory'}
  $resolvedTarget=($metadata | ConvertFrom-Json).target_directory
  & node scripts/check-dev-storage.mjs --target-dir $resolvedTarget
  if($LASTEXITCODE -ne 0){throw 'Development storage budget exceeded before build'}
  & node frontend/build.mjs
  if($LASTEXITCODE -ne 0){throw 'Core SDK build failed'}
  $buildArgs=@('build','--locked','--bin','codlet','--no-default-features')
  if($Release){$buildArgs+='--release'}
  & cargo @buildArgs
  if($LASTEXITCODE -ne 0){throw 'Core build failed'}
  & node scripts/check-dev-storage.mjs --target-dir $resolvedTarget
  if($LASTEXITCODE -ne 0){throw 'Core built, but development storage needs cleanup before another build'}
}finally{Pop-Location}
