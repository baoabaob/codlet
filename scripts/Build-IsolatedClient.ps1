param(
    [Parameter(Mandatory=$true)][string]$Destination,
    [Parameter(Mandatory=$true)][string]$LabRoot,
    [Parameter(Mandatory=$true)][string]$LabExecutable,
    [Parameter(Mandatory=$true)][string]$RuntimeDirectory,
    [Parameter(Mandatory=$true)][string]$OfficialCli,
    [string]$ExpectedPackageVersion = '26.908.4834.0'
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
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Start-TestClient.ps1') -Destination $codletOutput
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Start-TestClient.cmd') -Destination $codletOutput
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Restart-TestClient.ps1') -Destination $codletOutput
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Test-UpdateRestart.ps1') -Destination $codletOutput
Copy-Item -LiteralPath (Join-Path $codletSource 'runtime/node-runtime.json') -Destination (Join-Path $codletOutput 'runtime/node-runtime.json')
Copy-Item -LiteralPath (Join-Path $codletSource 'runtime/update-channel.json') -Destination (Join-Path $codletOutput 'runtime/update-channel.json')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Test-Doctor.ps1') -Destination $codletOutput
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Export-Diagnostics.ps1') -Destination $codletOutput
$codletDocsOutput = Join-Path $codletOutput 'docs'
$null = New-Item -ItemType Directory -Path $codletDocsOutput
foreach ($codletDocument in (Get-ChildItem -LiteralPath (Join-Path $codletSource 'docs') -Filter '*.md' -File)) {
    Copy-Item -LiteralPath $codletDocument.FullName -Destination $codletDocsOutput
}
Copy-Item -LiteralPath (Join-Path $codletSource 'docs/THIRD_PARTY_UI_LICENSES.txt') -Destination $codletDocsOutput
[IO.File]::WriteAllText((Join-Path $codletOutput 'M5-ManualTest.md'), '[Open the M5a manual test guide](docs/LOCAL_PLUGIN_MANUAL_TEST_2026-09-11.md)', (New-Object Text.UTF8Encoding($false)))
[IO.File]::WriteAllText((Join-Path $codletOutput 'M5-GitHubManualTest.md'), '[Open the M5b GitHub manual test guide](docs/GITHUB_PLUGIN_MANUAL_TEST_2026-09-12.md)', (New-Object Text.UTF8Encoding($false)))
[IO.File]::WriteAllText((Join-Path $codletOutput 'Remaining-Acceptance.md'), '[Open the remaining approval and release acceptance guide](docs/REMAINING_ACCEPTANCE_MANUAL_2026-09-12.md)', (New-Object Text.UTF8Encoding($false)))
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
foreach ($codletEntry in @{ 'Stop-TestClient.ps1'=$codletStop; 'Test-Plugins.ps1'=$codletPlugins }.GetEnumerator()) {
    [IO.File]::WriteAllText((Join-Path $codletOutput $codletEntry.Key), $codletEntry.Value, $codletUtf8)
}
foreach ($codletName in @('Stop-TestClient', 'Test-Plugins', 'Test-Doctor', 'Export-Diagnostics', 'Test-UpdateRestart')) {
    $codletCommand = '@echo off' + [Environment]::NewLine + 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0' + $codletName + '.ps1" %*' + [Environment]::NewLine
    if ($codletName -eq 'Export-Diagnostics') {
        $codletCommand += 'set "codletExportExit=%errorlevel%"' + [Environment]::NewLine + 'pause' + [Environment]::NewLine + 'exit /b %codletExportExit%' + [Environment]::NewLine
    }
    [IO.File]::WriteAllText((Join-Path $codletOutput ($codletName + '.cmd')), $codletCommand, [Text.Encoding]::ASCII)
}
$codletPluginOutput = Join-Path $codletOutput 'plugins/hide-usage-banner'
$null = New-Item -ItemType Directory -Path $codletPluginOutput
foreach ($codletFile in @('codlet.json', 'renderer.js', 'README.md')) {
    Copy-Item -LiteralPath (Join-Path $codletSource ('examples/hide-usage-banner/' + $codletFile)) -Destination $codletPluginOutput
}
$codletCheckOutput = Join-Path $codletOutput 'plugins/local-management-check'
$null = New-Item -ItemType Directory -Path $codletCheckOutput
foreach ($codletFile in @('codlet.json', 'renderer.js', 'README.md')) {
    Copy-Item -LiteralPath (Join-Path $codletSource ('examples/local-management-check/' + $codletFile)) -Destination $codletCheckOutput
}
$codletGitHubOutput = Join-Path $codletOutput 'plugins/github-release-check'
$null = New-Item -ItemType Directory -Path $codletGitHubOutput
Copy-Item -LiteralPath (Join-Path $codletSource 'examples/github-release-check/README.md') -Destination $codletGitHubOutput
foreach ($codletVersion in @('v1', 'v2')) {
    $codletVersionOutput = Join-Path $codletGitHubOutput $codletVersion
    $null = New-Item -ItemType Directory -Path $codletVersionOutput
    foreach ($codletFile in @('codlet.json', 'codlet-package.json', 'renderer.js', 'README.md', 'LICENSE.txt')) {
        Copy-Item -LiteralPath (Join-Path $codletSource ('examples/github-release-check/' + $codletVersion + '/' + $codletFile)) -Destination $codletVersionOutput
    }
}
[pscustomobject]@{ destination=$codletOutput; labRoot=$codletLabRoot; packageVersion=$ExpectedPackageVersion; executableSha256=$codletConfiguration.labBinarySha256 } | ConvertTo-Json -Compress
