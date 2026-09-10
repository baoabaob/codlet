[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$CodletExecutable,
    [Parameter(Mandatory = $true)][string]$NodeDirectory,
    [string]$OutputRoot
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
    foreach ($required in @('examples/raw-host/codlet.json', 'examples/cleanup-host/codlet.json', 'types/host.d.ts', 'examples/local-host-renderer-capability/codlet.json', 'examples/local-host-renderer-capability/host.js', 'examples/local-host-renderer-capability/renderer.js', 'docs/COMBINED_PACKAGES_2026-09-10.md', 'docs/HOST_CAPABILITY_2026-09-10.md')) {
        Assert-Condition ($listed.Contains($required)) ("Missing required development payload: " + $required)
    }
    Assert-Condition (-not $listed.Contains('config.json') -and -not $listed.Contains('settings.json')) 'User configuration entered the distribution.'
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

function Test-Candidate([string]$Directory, [string]$Example, [string]$Id) {
    $privateData = Join-Path $OutputRoot ('private-config-' + $Example)
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = Join-Path $Directory 'codlet.exe'
    $start.Arguments = 'plugin add "' + (Join-Path $Directory ('examples/' + $Example)) + '"'
    $start.WorkingDirectory = $Directory
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables['LOCALAPPDATA'] = $privateData
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    try {
        $null = $process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(5000)) { $process.Kill(); $process.WaitForExit(); throw 'Read-only CLI candidate inspection did not finish.' }
        $text = $stdout.GetAwaiter().GetResult(); $errorText = $stderr.GetAwaiter().GetResult()
        Assert-Condition ($process.ExitCode -ne 0 -and $text.Contains('plugin-candidate: id=' + $Id)) ("Candidate inspection failed: $text $errorText")
        Assert-Condition (-not (Test-Path -LiteralPath $privateData)) 'Candidate inspection created a registry/config directory without consent.'
        [IO.File]::WriteAllText((Join-Path $OutputRoot ($Example + '-candidate.txt')), $text + $errorText, $utf8)
    } finally { $process.Dispose() }
}

$first = & $builder -CodletExecutable $CodletExecutable -NodeDirectory $NodeDirectory -OutputDirectory $firstPath -Zip
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
$second = & $portableBuilder -CodletExecutable (Join-Path $firstPath 'codlet.exe') -NodeDirectory (Join-Path $firstPath $nodeRelative) -OutputDirectory $secondPath -Zip
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

Test-Candidate $firstPath 'raw-host' 'example.raw-host'
Test-Candidate $firstPath 'cleanup-host' 'example.cleanup-host'
Test-Candidate $firstPath 'local-host-renderer-capability' 'example.combined'
$checks.Add('all three packaged examples inspect without trust or private registry creation')
Assert-Condition (@(Get-ChildItem -LiteralPath $OutputRoot -Directory -Force | Where-Object { $_.Name.StartsWith('.codlet-package-') }).Count -eq 0) 'An unsuccessful packaging attempt left staging directories.'
$report = [ordered]@{ schema = 1; status = 'passed'; executableSha256 = Get-Sha256 $CodletExecutable; checks = $checks.ToArray(); first = $first; repeated = $second }
$reportPath = Join-Path $OutputRoot 'packaging-acceptance.json'
[IO.File]::WriteAllText($reportPath, (($report | ConvertTo-Json -Depth 8) + "`n"), $utf8)
[pscustomobject]@{ Status = 'passed'; Checks = $checks.Count; Report = $reportPath; Directory = $first.Directory; Zip = $first.Zip }
