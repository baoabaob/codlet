# Compatibility entry point for the independent-plugin Preview distribution.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$CodletExecutable,
  [string]$NodeDirectory,
  [Parameter(Mandatory=$true)][string]$PluginDistribution,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$SourceCommit,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$PluginsCommit,
  [switch]$Zip,
  [switch]$BundleNodeForTests
)
$ErrorActionPreference='Stop'
& (Join-Path $PSScriptRoot 'Build-PreviewDistribution.ps1') @PSBoundParameters
