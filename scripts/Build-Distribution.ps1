# Compatibility entry point for the independent-plugin Preview distribution.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$CodletExecutable,
  [Parameter(Mandatory=$true)][string]$NodeDirectory,
  [Parameter(Mandatory=$true)][string]$PluginDistribution,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [string]$SourceCommit,
  [switch]$Zip
)
$ErrorActionPreference='Stop'
& (Join-Path $PSScriptRoot 'Build-PreviewDistribution.ps1') @PSBoundParameters
