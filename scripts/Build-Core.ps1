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
  & node frontend/build.mjs
  if($LASTEXITCODE -ne 0){throw 'Core SDK build failed'}
  $buildArgs=@('build','--locked','--bin','codlet','--no-default-features')
  if($Release){$buildArgs+='--release'}
  & cargo @buildArgs
  if($LASTEXITCODE -ne 0){throw 'Core build failed'}
}finally{Pop-Location}
