[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$CodletExecutable,
    [Parameter(Mandatory = $true)][string]$NodeDirectory,
    [string]$OutputRoot,
    [ValidatePattern('^[0-9a-fA-F]{7,64}$')][string]$SourceCommit
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$utf8 = New-Object Text.UTF8Encoding($false)
if (-not $OutputRoot) {
    $OutputRoot = Join-Path $repositoryRoot ('.codlet-artifacts/distribution-acceptance-' + [Guid]::NewGuid().ToString('N'))
}
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
if (Test-Path -LiteralPath $OutputRoot) { throw 'Packaging acceptance requires a new private output directory.' }
$null = [IO.Directory]::CreateDirectory($OutputRoot)
$label = [string][char]0x6D4B + [string][char]0x8BD5
$firstPath = Join-Path $OutputRoot ('portable ' + $label + ' one')
$secondPath = Join-Path $OutputRoot ('portable ' + $label + ' two')
$builder = Join-Path $PSScriptRoot 'Build-Distribution.ps1'
$checks = New-Object 'Collections.Generic.List[string]'
$sourceArguments = @{}
if ($SourceCommit) { $sourceArguments.SourceCommit = $SourceCommit }
$exampleCandidates = @(
    @{ Directory = 'raw-host'; Id = 'example.raw-host' },
    @{ Directory = 'cleanup-host'; Id = 'example.cleanup-host' },
    @{ Directory = 'local-host-renderer-capability'; Id = 'example.combined' },
    @{ Directory = 'local-echo'; Id = 'dev.example.local-echo' },
    @{ Directory = 'host-os-broker'; Id = 'example.os-broker' },
    @{ Directory = 'raw-m2'; Id = 'example.raw-m2' },
    @{ Directory = 'hide-usage-banner'; Id = 'dev.local.hide-usage-banner' },
    @{ Directory = 'desktop-m3-m4'; Id = 'example.desktop.m3m4' },
    @{ Directory = 'core-rpc/service'; Id = 'example.rpc.service' },
    @{ Directory = 'core-rpc/view'; Id = 'example.rpc.view' },
    @{ Directory = 'core-rpc/coordinator'; Id = 'example.rpc.coordinator' },
    @{ Directory = 'core-rpc/consumer'; Id = 'example.rpc.consumer' }
)

function Assert-Condition([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Get-Sha256([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

function Assert-Rejected([scriptblock]$Action, [string]$Expected) {
    $failure = $null
    try { $null = & $Action } catch { $failure = $_.Exception.Message }
    Assert-Condition ($null -ne $failure -and $failure.Contains($Expected)) ("Expected rejection containing '$Expected'; got '$failure'")
}

function Test-Manifest([string]$Directory) {
    $manifestPath = Join-Path $Directory 'distribution-manifest.json'
    $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
    Assert-Condition ($manifest.schema -eq 1 -and $manifest.kind -eq 'codlet-portable-distribution' -and $manifest.platform -eq 'win-x64') 'Unexpected manifest identity.'
    $listed = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach ($file in $manifest.files) {
        Assert-Condition ($file.path -notmatch '(^/|\\|(^|/)\.\.(/|$))') 'Manifest path must be a normalized relative path.'
        Assert-Condition ($listed.Add([string]$file.path)) 'Duplicate manifest entry.'
        $path = [IO.Path]::GetFullPath((Join-Path $Directory $file.path))
        Assert-Condition ($path.StartsWith($Directory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) 'Manifest escaped package root.'
        Assert-Condition ((Get-Sha256 $path) -eq $file.sha256) ("Hash mismatch: " + $file.path)
        Assert-Condition ((Get-Item -LiteralPath $path).Length -eq $file.bytes) ("Size mismatch: " + $file.path)
    }
    $actual = @(Get-ChildItem -LiteralPath $Directory -File -Recurse)
    Assert-Condition ($actual.Count -eq $manifest.files.Count + 1) 'Package contains unlisted files.'
    foreach ($required in @(
        'examples/raw-host/codlet.json', 'examples/cleanup-host/codlet.json', 'examples/local-echo/codlet.json',
        'examples/local-host-renderer-capability/codlet.json', 'examples/local-host-renderer-capability/host.js', 'examples/local-host-renderer-capability/renderer.js',
        'examples/raw-m2/codlet.json', 'examples/raw-m2/host.js', 'examples/raw-m2/README.md',
        'examples/hide-usage-banner/codlet.json', 'examples/hide-usage-banner/renderer.js', 'examples/hide-usage-banner/README.md',
        'scripts/preview-hide-usage-banner.html',
        'examples/host-os-broker/codlet.json', 'examples/host-os-broker/host.js', 'examples/host-os-broker/approved-data/settings.json',
        'examples/host-os-broker/approved-data/message.txt', 'examples/host-os-broker/serve-fixture.cjs',
        'examples/core-rpc/README.md',
        'examples/core-rpc/service/codlet.json', 'examples/core-rpc/service/host.js',
        'examples/core-rpc/view/codlet.json', 'examples/core-rpc/view/renderer.js',
        'examples/core-rpc/coordinator/codlet.json', 'examples/core-rpc/coordinator/host.js',
        'examples/core-rpc/consumer/codlet.json', 'examples/core-rpc/consumer/renderer.js',
        'types/host.d.ts', 'types/renderer.d.ts', 'types/runtime-manage.d.ts',
        'types/codex-desktop.d.ts',
        'bundled/codex-desktop-adapter/codlet.json', 'bundled/codex-desktop-adapter/renderer.js',
        'examples/desktop-m3-m4/codlet.json', 'examples/desktop-m3-m4/renderer.js', 'examples/desktop-m3-m4/README.md',
        'docs/DESKTOP_ADAPTER_DEVELOPMENT_2026-09-10.md', 'docs/M3_M4_ACCEPTANCE_2026-09-10.md',
        'docs/COMBINED_PACKAGES_2026-09-10.md', 'docs/HOST_CAPABILITY_2026-09-10.md', 'docs/LOCAL_PLUGINS.md',
        'docs/CORE_RPC_2026-09-10.md', 'docs/OS_BROKER_2026-09-10.md', 'docs/RUNTIME_MANAGE_2026-09-10.md',
        'docs/M2_ACCEPTANCE_2026-09-10.md', 'scripts/Test-Distribution.ps1'
    )) {
        Assert-Condition ($listed.Contains($required)) ("Missing required development payload: " + $required)
    }
    Assert-Condition (-not $listed.Contains('config.json') -and -not $listed.Contains('settings.json')) 'User configuration entered the distribution.'
    foreach ($entry in $listed) {
        Assert-Condition ($entry -notmatch '(^|/)(broker-report\.json|events\.jsonl|report\.json|development\..*\.json)$') 'Generated plugin observations entered the distribution.'
        if ($entry -match '(^|/)settings(?:\.[^/]*)?\.json$') {
            Assert-Condition ($entry -eq 'examples/host-os-broker/approved-data/settings.json') 'Only the checked-in localhost fixture configuration may be packaged.'
        }
    }
    $manifest
}

function Test-Zip([string]$Directory, [string]$ZipPath, $Manifest) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $expected = @{}
    foreach ($file in $Manifest.files) { $expected[$file.path] = $file.sha256 }
    $expected['distribution-manifest.json'] = Get-Sha256 (Join-Path $Directory 'distribution-manifest.json')
    $archive = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        Assert-Condition ($archive.Entries.Count -eq $expected.Count) 'Unexpected ZIP structure or extra entries.'
        $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
        foreach ($entry in $archive.Entries) {
            Assert-Condition ($expected.ContainsKey($entry.FullName) -and $seen.Add($entry.FullName)) ("Unexpected ZIP entry: " + $entry.FullName)
            Assert-Condition ($entry.LastWriteTime.Year -eq 2000) 'ZIP timestamps must be deterministic.'
            $stream = $entry.Open(); $sha = [Security.Cryptography.SHA256]::Create()
            try { $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
            finally { $sha.Dispose(); $stream.Dispose() }
            Assert-Condition ($actual -eq $expected[$entry.FullName]) ("ZIP payload hash mismatch: " + $entry.FullName)
        }
    } finally { $archive.Dispose() }
}

function Invoke-ReadOnlyCli([string]$Directory, [string]$Arguments, [string]$PrivateData) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = Join-Path $Directory 'codlet.exe'
    $start.Arguments = $Arguments
    $start.WorkingDirectory = $Directory
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables['LOCALAPPDATA'] = $PrivateData
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    try {
        $null = $process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(5000)) {
            $process.Kill()
            Assert-Condition ($process.WaitForExit(1000)) 'The private read-only CLI process did not retire after cancellation.'
            throw 'Read-only CLI candidate inspection did not finish.'
        }
        Assert-Condition ($stdout.Wait(1000) -and $stderr.Wait(1000)) 'Read-only CLI output did not close after process exit.'
        $text = $stdout.GetAwaiter().GetResult(); $errorText = $stderr.GetAwaiter().GetResult()
        [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $text; Stderr = $errorText }
    } finally { $process.Dispose() }
}

function Test-Candidate([string]$Directory, [string]$Example, [string]$Id) {
        $label = $Example.Replace('/', '-')
        $privateData = Join-Path $OutputRoot ('private-config-' + $label)
        $result = Invoke-ReadOnlyCli $Directory ('plugin add "' + (Join-Path $Directory ('examples/' + $Example)) + '"') $privateData
        Assert-Condition ($result.ExitCode -ne 0 -and $result.Stdout.Contains('plugin-candidate: id=' + $Id)) ("Candidate inspection failed: " + $result.Stdout + $result.Stderr)
        Assert-Condition (-not (Test-Path -LiteralPath $privateData)) 'Candidate inspection created a registry/config directory without consent.'
        [IO.File]::WriteAllText((Join-Path $OutputRoot ($label + '-candidate.txt')), $result.Stdout + $result.Stderr, $utf8)
}

function Test-Permissions([string]$Directory) {
    $privateData = Join-Path $OutputRoot 'private-permission-query'
    $configuration = Join-Path $privateData 'Codlet/config.json'
    $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($configuration))
    $pluginRoot = Join-Path $Directory 'examples/host-os-broker'
    $record = [ordered]@{
        schema = 2; plugins = @{}
        localPlugins = @{ 'example.os-broker' = [ordered]@{
            path = $pluginRoot
            grants = @('host.process', 'host.fs', 'host.network', 'host.system')
            brokerPolicy = [ordered]@{ readRoots = @((Join-Path $pluginRoot 'approved-data')); networkOrigins = @('http://127.0.0.1:8765') }
        } }
    }
    [IO.File]::WriteAllText($configuration, ($record | ConvertTo-Json -Depth 8), $utf8)
    $before = Get-Sha256 $configuration
    $result = Invoke-ReadOnlyCli $Directory 'plugin permissions example.os-broker --json' $privateData
    Assert-Condition ($result.ExitCode -eq 0) ('Permissions query failed: ' + $result.Stdout + $result.Stderr)
    $reply = $result.Stdout | ConvertFrom-Json
    Assert-Condition ($reply.schema -eq 1 -and $reply.kind -eq 'codlet.plugin-permissions' -and $reply.pluginId -eq 'example.os-broker') 'Unexpected permissions response identity.'
    Assert-Condition ($reply.registration.grants -contains 'host.fs' -and $reply.registration.brokerPolicy.networkOrigins[0] -eq 'http://127.0.0.1:8765') 'Permissions query lost recorded scopes.'
    Assert-Condition ((Get-Sha256 $configuration) -eq $before) 'Read-only permissions query changed its private input record.'
    [IO.File]::WriteAllText((Join-Path $OutputRoot 'permissions-query.json'), $result.Stdout, $utf8)
}

$first = & $builder -CodletExecutable $CodletExecutable -NodeDirectory $NodeDirectory -OutputDirectory $firstPath -Zip @sourceArguments
$manifest = Test-Manifest $firstPath
Test-Zip $firstPath $first.Zip $manifest
$checks.Add('normal packaging, Chinese/space paths, manifest hashes and ZIP entries')

$sentinel = Join-Path $firstPath 'user-kept.txt'
[IO.File]::WriteAllText($sentinel, 'keep existing target intact', $utf8)
Assert-Rejected { & $builder -CodletExecutable $CodletExecutable -NodeDirectory $NodeDirectory -OutputDirectory $firstPath -Zip } 'Output already exists'
Assert-Condition ([IO.File]::ReadAllText($sentinel) -eq 'keep existing target intact' -and (Get-Sha256 $first.Manifest) -eq $first.ManifestSha256) 'Repeated output changed the existing directory.'
Assert-Condition ((Get-Sha256 $first.Zip) -eq $first.ZipSha256) 'Repeated output changed the existing ZIP.'
Remove-Item -LiteralPath $sentinel -Force
$checks.Add('repeat destination rejected without modifying existing files')

$portableBuilder = Join-Path $firstPath 'scripts/Build-Distribution.ps1'
$nodeRelative = 'runtime/node-v' + $manifest.runtime.version + '-win-x64'
$second = & $portableBuilder -CodletExecutable (Join-Path $firstPath 'codlet.exe') -NodeDirectory (Join-Path $firstPath $nodeRelative) -OutputDirectory $secondPath -Zip @sourceArguments
$null = Test-Manifest $secondPath
Assert-Condition ($first.ManifestSha256 -eq $second.ManifestSha256 -and $first.ZipSha256 -eq $second.ZipSha256) 'Identical portable inputs did not reproduce the same manifest/ZIP.'
$checks.Add('portable-to-portable repack reproduces identical manifest and ZIP hashes')

$badRuntime = Join-Path $OutputRoot 'bad-runtime'
$null = [IO.Directory]::CreateDirectory($badRuntime)
[IO.File]::WriteAllBytes((Join-Path $badRuntime 'node.exe'), [byte[]]@(77, 90))
[IO.File]::Copy((Join-Path $NodeDirectory 'LICENSE'), (Join-Path $badRuntime 'LICENSE'))
$badOutput = Join-Path $OutputRoot 'rejected-node'
Assert-Rejected { & $builder -CodletExecutable $CodletExecutable -NodeDirectory $badRuntime -OutputDirectory $badOutput -Zip } 'node.exe differs'
Assert-Condition (-not (Test-Path -LiteralPath $badOutput) -and -not (Test-Path -LiteralPath ($badOutput + '.zip'))) 'A bad Node digest published a distribution.'
[IO.File]::Copy((Join-Path $NodeDirectory 'node.exe'), (Join-Path $badRuntime 'node.exe'), $true)
[IO.File]::WriteAllText((Join-Path $badRuntime 'LICENSE'), 'wrong license content', $utf8)
Assert-Rejected { & $builder -CodletExecutable $CodletExecutable -NodeDirectory $badRuntime -OutputDirectory (Join-Path $OutputRoot 'rejected-license') } 'LICENSE differs'
Assert-Condition (-not (Test-Path -LiteralPath (Join-Path $OutputRoot 'rejected-license'))) 'A bad LICENSE digest published a distribution.'
$checks.Add('incorrect Node and LICENSE digests rejected before publication')

foreach ($case in @(
    @{ File = 'docs/RUNTIME_MANAGE_2026-09-10.md'; Text = "`n[missing portable document](missing-m2-document.md)`n"; Expected = 'Unpackaged relative documentation link'; Output = 'rejected-document-link' },
    @{ File = 'types/runtime-manage.d.ts'; Text = "`nimport type { Missing } from './missing-m2-type';`n"; Expected = 'Unpackaged declaration import'; Output = 'rejected-type-link' }
)) {
    $file = Join-Path $firstPath $case.File
    $original = [IO.File]::ReadAllBytes($file)
    try {
        [IO.File]::AppendAllText($file, $case.Text, $utf8)
        $rejected = Join-Path $OutputRoot $case.Output
        Assert-Rejected { & $portableBuilder -CodletExecutable (Join-Path $firstPath 'codlet.exe') -NodeDirectory (Join-Path $firstPath $nodeRelative) -OutputDirectory $rejected @sourceArguments } $case.Expected
        Assert-Condition (-not (Test-Path -LiteralPath $rejected)) 'Broken portable links published a directory.'
    } finally { [IO.File]::WriteAllBytes($file, $original) }
}
$checks.Add('missing relative Markdown destinations and declaration imports rejected before publication')

foreach ($example in $exampleCandidates) { Test-Candidate $firstPath $example.Directory $example.Id }
$checks.Add("all $($exampleCandidates.Count) packaged examples inspect without trust, code execution or private registry creation")
Test-Permissions $firstPath
$checks.Add('M2 permissions query reads explicit scopes from one private fixture record without modifying it')
$null = Test-Manifest $firstPath
Assert-Condition (@(Get-ChildItem -LiteralPath $OutputRoot -Directory -Force | Where-Object { $_.Name.StartsWith('.codlet-package-') }).Count -eq 0) 'An unsuccessful packaging attempt left staging directories.'
$report = [ordered]@{ schema = 1; status = 'passed'; verificationScope = 'distribution-layout-and-read-only-cli'; runtimeFunctionalAcceptance = 'not_run'; executableSha256 = Get-Sha256 $CodletExecutable; candidateExamples = @($exampleCandidates | ForEach-Object { $_.Directory }); checks = $checks.ToArray(); first = $first; repeated = $second }
$reportPath = Join-Path $OutputRoot 'packaging-acceptance.json'
[IO.File]::WriteAllText($reportPath, (($report | ConvertTo-Json -Depth 8) + "`n"), $utf8)
[pscustomobject]@{ Status = 'passed'; Checks = $checks.Count; Report = $reportPath; Directory = $first.Directory; Zip = $first.Zip }
