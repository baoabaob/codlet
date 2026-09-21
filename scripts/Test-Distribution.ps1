[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Distribution,[Parameter(Mandatory=$true)][string]$ArtifactsDirectory)
$ErrorActionPreference='Stop'
& (Join-Path $PSScriptRoot 'Test-PreviewDistribution.ps1') @PSBoundParameters
