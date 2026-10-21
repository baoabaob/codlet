[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference='Stop'
$output=[IO.Path]::GetFullPath($OutputPath)
if(Test-Path -LiteralPath $output){throw 'Fresh acceptance executable required'}
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($output))|Out-Null
$source=Join-Path $PSScriptRoot 'installer'
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $compiler /nologo /optimize+ /platform:x64 /target:exe /reference:System.Core.dll /reference:System.Management.dll /reference:System.Web.Extensions.dll ('/out:'+$output) (Join-Path $source 'Acceptance.cs') (Join-Path $source 'MsiSession.cs') (Join-Path $source 'InstallTiming.cs') (Join-Path $source 'InstalledProduct.cs')
if($LASTEXITCODE -ne 0){throw 'Installer acceptance driver failed to compile'}
[pscustomobject]@{path=$output;sha256=(Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant();installationRequires='CodletNativeAcceptanceVM'}|ConvertTo-Json
