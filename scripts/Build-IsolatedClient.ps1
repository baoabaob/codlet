param(
    [Parameter(Mandatory=$true)][string]$Destination,
    [Parameter(Mandatory=$true)][string]$LabRoot,
    [Parameter(Mandatory=$true)][string]$LabExecutable,
    [Parameter(Mandatory=$true)][string]$RuntimeDirectory,
    [Parameter(Mandatory=$true)][string]$OfficialCli,
    [string]$ExpectedPackageVersion = '26.903.8094.0'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$codletSource = Split-Path -Parent $PSScriptRoot
$codletOutput = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $codletOutput) { throw 'Distribution destination must not exist.' }
$codletLabRoot = [IO.Path]::GetFullPath($LabRoot)
$codletNodePin = [IO.File]::ReadAllText((Join-Path $codletSource 'runtime/node-runtime.json')) | ConvertFrom-Json
$codletNodeRelative = 'runtime/node-v' + $codletNodePin.version + '-win-x64'
$codletNodeSource = Join-Path $RuntimeDirectory ('node-v' + $codletNodePin.version + '-win-x64')
$codletNodeHash = (Get-FileHash -LiteralPath (Join-Path $codletNodeSource 'node.exe') -Algorithm SHA256).Hash
if ($codletNodeHash -ne $codletNodePin.platforms.'win-x64'.executableSha256) { throw 'Managed Node does not match the checked-in runtime pin.' }
if ((Get-AuthenticodeSignature -LiteralPath $OfficialCli).Status -ne 'Valid') { throw 'Official CLI signature is not valid.' }
$codletMarkerFile = [IO.File]::Open((Join-Path $codletLabRoot '.codlet-lab-owner.json'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
try {
    if ($codletMarkerFile.Length -gt 4096) { throw 'Invalid experimental profile marker.' }
    $codletMarkerReader = New-Object IO.StreamReader($codletMarkerFile)
    try { $codletMarker = $codletMarkerReader.ReadToEnd() | ConvertFrom-Json } finally { $codletMarkerReader.Dispose() }
} finally { $codletMarkerFile.Dispose() }
if ($codletMarker.schema_version -ne 1 -or -not $codletMarker.experimental) { throw 'Not an existing experimental profile.' }
$null = New-Item -ItemType Directory -Path $codletOutput
$null = New-Item -ItemType Directory -Path (Join-Path $codletOutput $codletNodeRelative)
Copy-Item -LiteralPath $LabExecutable -Destination (Join-Path $codletOutput 'codlet-lab.exe')
foreach ($codletFile in @('node.exe', 'LICENSE')) {
    Copy-Item -LiteralPath (Join-Path $codletNodeSource $codletFile) -Destination (Join-Path $codletOutput $codletNodeRelative)
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'isolated-client.mjs') -Destination $codletOutput
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Test-Doctor.ps1') -Destination $codletOutput
$codletConfiguration = [ordered]@{
    schema = 1; labRoot = $codletLabRoot; labBinary = 'codlet-lab.exe'
    labBinarySha256 = (Get-FileHash -LiteralPath (Join-Path $codletOutput 'codlet-lab.exe') -Algorithm SHA256).Hash
    officialCli = [IO.Path]::GetFullPath($OfficialCli)
    officialCliSha256 = (Get-FileHash -LiteralPath $OfficialCli -Algorithm SHA256).Hash
    expectedPackageVersion = $ExpectedPackageVersion; nodeRelative = ($codletNodeRelative + '/node.exe')
}
$codletUtf8 = New-Object Text.UTF8Encoding($false)
$codletGuide = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'isolated-client-readme.md'))
[IO.File]::WriteAllText((Join-Path $codletOutput 'README.md'), $codletGuide.Replace('{{labRoot}}', $codletLabRoot).Replace('{{packageVersion}}', $ExpectedPackageVersion), $codletUtf8)
[IO.File]::WriteAllText((Join-Path $codletOutput 'lab-config.json'), ($codletConfiguration | ConvertTo-Json -Depth 10), $codletUtf8)
$codletStart = @'
$ErrorActionPreference = 'Stop'
$codletConfigPath = Join-Path $PSScriptRoot 'lab-config.json'
$codletConfig = [IO.File]::ReadAllText($codletConfigPath) | ConvertFrom-Json
$codletNode = Join-Path $PSScriptRoot $codletConfig.nodeRelative
$codletScript = Join-Path $PSScriptRoot 'isolated-client.mjs'
$codletStamp = [DateTime]::UtcNow.Ticks.ToString()
$codletOutputLog = Join-Path $PSScriptRoot ('launch-' + $codletStamp + '.stdout.log')
$codletErrorLog = Join-Path $PSScriptRoot ('launch-' + $codletStamp + '.stderr.log')
$codletArguments = '"' + $codletScript + '" start "' + $codletConfigPath + '"'
$codletProcess = Start-Process -FilePath $codletNode -ArgumentList $codletArguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $codletOutputLog -RedirectStandardError $codletErrorLog
Write-Output ('Test client launcher PID: ' + $codletProcess.Id)
Write-Output ('Startup log: ' + $codletOutputLog)
Write-Output ('Error log: ' + $codletErrorLog)
'@
$codletStop = @'
$ErrorActionPreference = 'Stop'
$codletConfigPath = Join-Path $PSScriptRoot 'lab-config.json'
$codletConfig = [IO.File]::ReadAllText($codletConfigPath) | ConvertFrom-Json
& (Join-Path $PSScriptRoot $codletConfig.nodeRelative) (Join-Path $PSScriptRoot 'isolated-client.mjs') stop $codletConfigPath
exit $LASTEXITCODE
'@
$codletPlugins = @'
$ErrorActionPreference = 'Stop'
$codletConfigPath = Join-Path $PSScriptRoot 'lab-config.json'
$codletConfig = [IO.File]::ReadAllText($codletConfigPath) | ConvertFrom-Json
& (Join-Path $PSScriptRoot $codletConfig.nodeRelative) (Join-Path $PSScriptRoot 'isolated-client.mjs') plugins $codletConfigPath @args
exit $LASTEXITCODE
'@
foreach ($codletEntry in @{ 'Start-TestClient.ps1'=$codletStart; 'Stop-TestClient.ps1'=$codletStop; 'Test-Plugins.ps1'=$codletPlugins }.GetEnumerator()) {
    [IO.File]::WriteAllText((Join-Path $codletOutput $codletEntry.Key), $codletEntry.Value, $codletUtf8)
}
foreach ($codletName in @('Start-TestClient', 'Stop-TestClient', 'Test-Plugins', 'Test-Doctor')) {
    $codletCommand = '@echo off' + [Environment]::NewLine + 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0' + $codletName + '.ps1" %*' + [Environment]::NewLine
    [IO.File]::WriteAllText((Join-Path $codletOutput ($codletName + '.cmd')), $codletCommand, [Text.Encoding]::ASCII)
}
$codletPluginOutput = Join-Path $codletOutput 'plugins/hide-usage-banner'
$null = New-Item -ItemType Directory -Path $codletPluginOutput
foreach ($codletFile in @('codlet.json', 'renderer.js', 'README.md')) {
    Copy-Item -LiteralPath (Join-Path $codletSource ('examples/hide-usage-banner/' + $codletFile)) -Destination $codletPluginOutput
}
[pscustomobject]@{ destination=$codletOutput; labRoot=$codletLabRoot; packageVersion=$ExpectedPackageVersion; executableSha256=$codletConfiguration.labBinarySha256 } | ConvertTo-Json -Compress
