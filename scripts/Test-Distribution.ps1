[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Distribution,[Parameter(Mandatory=$true)][string]$ArtifactsDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($Distribution)
$artifacts=[IO.Path]::GetFullPath($ArtifactsDirectory)
if(Test-Path -LiteralPath $artifacts){throw 'Use a new owned test output directory'}
[IO.Directory]::CreateDirectory($artifacts)|Out-Null
$checks=[Collections.Generic.List[string]]::new()
$exe=Join-Path $root 'codlet.exe'
function Assert([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
$manifest=[IO.File]::ReadAllText((Join-Path $root 'distribution-manifest.json'))|ConvertFrom-Json
$runtime=[IO.File]::ReadAllText((Join-Path $root 'runtime/node-runtime.json'))|ConvertFrom-Json
Assert ($runtime.mode -eq 'managed' -and $manifest.runtime.mode -eq 'managed') 'Distribution must declare a managed runtime'
Assert (@($manifest.files|Where-Object{$_.path -match '^runtime/node-v[^/]+/'}).Count -eq 0) 'Distribution manifest includes bundled Node files'
Assert (@(Get-ChildItem -LiteralPath (Join-Path $root 'runtime') -Recurse -File | Where-Object{$_.Name -in @('node.exe','LICENSE')}).Count -eq 0) 'Distribution includes bundled Node files'
$checks.Add('portable distribution declares managed runtime and contains no bundled Node executable or license')
function Invoke-CodletTestCli([string[]]$Arguments){
  $before=[Console]::OutputEncoding
  try{[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$output=& $exe @Arguments;if($LASTEXITCODE -ne 0){throw "CLI failed: $output"};($output|Out-String)|ConvertFrom-Json}
  finally{[Console]::OutputEncoding=$before}
}
function Setup([string]$Data,[string[]]$Selection){
  $parameters=@{NoLaunch=$true;DataDirectory=$Data}
  if($null -ne $Selection){$parameters.Plugins=$Selection}
  & (Join-Path $root 'Initialize-Codlet.ps1') @parameters
}
$env:CODLET_HOME=Join-Path $artifacts 'core-only'
$empty=Invoke-CodletTestCli -Arguments @('plugin','list','--json')
Assert (@($empty.plugins).Count -eq 0) 'Release Core unexpectedly contains plugins'
Setup $env:CODLET_HOME @('none')
Assert (@((Invoke-CodletTestCli -Arguments @('plugin','list','--json')).plugins).Count -eq 0) 'Core-only choice installed a plugin'
Assert (-not (Test-Path -LiteralPath (Join-Path $root 'optional-plugins'))) 'Distribution still contains offline plugin payloads'
$checks.Add('Core-only package has no plugin payloads or plugin source revision')
$env:CODLET_HOME=Join-Path $artifacts 'GUI with spaces'
Setup $env:CODLET_HOME @('codlet-gui')
$listed=Invoke-CodletTestCli -Arguments @('plugin','list','--json')
Assert ((@($listed.plugins.id|Sort-Object)-join ',') -eq 'codex.ui.adapter,codlet-gui') 'GUI dependency selection is wrong'
Assert (@($listed.plugins|Where-Object{-not $_.enabled -or $_.validationError -or $_.source -ne 'github'}).Count -eq 0) 'External official plugin registration did not validate'
$config=Join-Path $env:CODLET_HOME 'config.json'
$before=[IO.File]::ReadAllText($config)
Setup $env:CODLET_HOME $null
Assert ([IO.File]::ReadAllText($config) -eq $before) 'Repeated setup changed registrations'
$checks.Add('GUI installs UI Adapter as an ordinary plugin; repeated setup leaves registry bytes unchanged')
$null=Invoke-CodletTestCli -Arguments @('plugin','disable','codlet-gui','--json')
$null=Invoke-CodletTestCli -Arguments @('plugin','revoke','codex.ui.adapter','ui.mainWorld','--json')
$before=[IO.File]::ReadAllText($config)
Setup $env:CODLET_HOME $null
Assert ([IO.File]::ReadAllText($config) -eq $before) 'Setup restored user enablement or grants'
$null=Invoke-CodletTestCli -Arguments @('plugin','remove','codlet-gui','--json')
Setup $env:CODLET_HOME $null
Assert (@((Invoke-CodletTestCli -Arguments @('plugin','list','--json')).plugins|Where-Object{$_.id -eq 'codlet-gui'}).Count -eq 0) 'Removed GUI was silently reinstalled'
$checks.Add('disabled/revoked/removed choices survive later startup')
$env:CODLET_HOME=Join-Path $artifacts 'all-plugins'
Setup $env:CODLET_HOME @('codex.ui.adapter','codex.desktop.adapter','codlet-gui')
$listed=Invoke-CodletTestCli -Arguments @('plugin','list','--json')
Assert (@($listed.plugins).Count -eq 3) 'Full selection missed a plugin'
$null=Invoke-CodletTestCli -Arguments @('plugin','remove','codex.ui.adapter','--cascade','--json')
$after=(Invoke-CodletTestCli -Arguments @('plugin','list','--json')).plugins
Assert (@($after|Where-Object{$_.id -eq 'codex.ui.adapter'}).Count -eq 0) 'Provider registration was not removed'
Assert (@($after|Where-Object{$_.id -eq 'codlet-gui' -and -not $_.enabled}).Count -eq 1) 'Cascade did not safely disable the dependent GUI'
$null=Invoke-CodletTestCli -Arguments @('plugin','remove','codlet-gui','--json')
$checks.Add('all three external packages validate; provider removal retires dependents; CLI can remove GUI itself')
$env:CODLET_HOME=Join-Path $artifacts 'legacy-preferences'
[IO.Directory]::CreateDirectory($env:CODLET_HOME)|Out-Null
[IO.File]::WriteAllText((Join-Path $env:CODLET_HOME 'config.json'),'{"schema":1,"plugins":{"codlet":{"enabled":false},"codex.ui.adapter":{"enabled":false}}}')
Setup $env:CODLET_HOME @('codlet-gui')
Assert (@((Invoke-CodletTestCli -Arguments @('plugin','list','--json')).plugins|Where-Object{$_.enabled}).Count -eq 0) 'Legacy GUI preference was reenabled'
$env:CODLET_HOME=Join-Path $artifacts 'minimal-registry'
[IO.Directory]::CreateDirectory($env:CODLET_HOME)|Out-Null
[IO.File]::WriteAllText((Join-Path $env:CODLET_HOME 'config.json'),'{"schema":2,"localPlugins":{}}')
Setup $env:CODLET_HOME @('codex.desktop.adapter')
Assert (@((Invoke-CodletTestCli -Arguments @('plugin','list','--json')).plugins).Count -eq 1) 'Valid registry with omitted preference map was rejected'
$checks.Add('legacy disabled GUI preference and minimal valid registry survive first-party package setup')
$report=[ordered]@{schema=1;scope='release-binary-and-github-plugin-setup';passed=$true;checks=$checks.ToArray();clientStarted=$false;userDataUntouched=$true}
$report|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $artifacts 'report.json') -Encoding UTF8
$report|ConvertTo-Json -Depth 8
