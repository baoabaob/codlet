param([Parameter(Mandatory = $true)][string]$Manifest)
$ErrorActionPreference = 'Stop'

# Launch only the fresh owned test plan. This independent, hidden coordinator
# retains its logs and process identity if the interactive tool session ends.
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifestPath = [IO.Path]::GetFullPath($Manifest)
$plan = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($plan.runId -notmatch '^core-[a-f0-9-]{36}$' -or $plan.launched -ne $false) {
    throw 'Expected a fresh unlaunched Core plan'
}
$runDirectory = Join-Path $repo ('.codlet-artifacts\core-native\' + $plan.runId)
if ($manifestPath -ne (Join-Path $runDirectory 'preflight.json')) { throw 'Plan escaped its owned run' }
if (-not (Test-Path -LiteralPath (Join-Path $runDirectory 'prepared-profile.json'))) { throw 'Prepare the empty owned profile first' }
$lab = [IO.Path]::GetFullPath($plan.inputs.labBinary)
$node = Join-Path ([IO.Path]::GetFullPath($plan.inputs.nodeRuntime)) 'node.exe'
$runtimePin = [IO.Path]::GetFullPath($plan.inputs.runtimePin)
if ((Get-FileHash -LiteralPath $lab -Algorithm SHA256).Hash.ToLowerInvariant() -ne $plan.hashes.labBinary -or
    (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -ne $plan.hashes.runtimeNode -or
    (Get-FileHash -LiteralPath $runtimePin -Algorithm SHA256).Hash.ToLowerInvariant() -ne $plan.hashes.runtimePin) {
    throw 'Planned immutable executable identity changed'
}
$record = Join-Path $runDirectory 'fixture-coordinator.json'
$stdout = Join-Path $runDirectory 'fixture-coordinator-stdout.log'
$stderr = Join-Path $runDirectory 'fixture-coordinator-stderr.log'
foreach ($file in @($record, $stdout, $stderr)) {
    if (Test-Path -LiteralPath $file) { throw 'This fixture launch has already been attempted; use a new plan' }
}
$script = Join-Path $repo 'scripts\core-native-fixture.mjs'
$fixture = Start-Process -FilePath $node -ArgumentList @(('"' + $script + '"'), ('"' + $manifestPath + '"')) `
    -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
$fixture.Refresh()
$birth = $fixture.StartTime.ToUniversalTime()
$identity = [ordered]@{
    schema = 1; runId = $plan.runId; pid = $fixture.Id
    created = $birth.ToString('o'); creationTime = $birth.ToFileTimeUtc().ToString()
    image = $node; executableSha256 = $plan.hashes.runtimeNode
    manifest = $manifestPath; stdout = $stdout; stderr = $stderr
    detachedInteractiveSession = $true; ownsSyntheticFixture = $true
}
$json = ($identity | ConvertTo-Json -Depth 4) + "`n"
[IO.File]::WriteAllText($record, $json, [Text.UTF8Encoding]::new($false))
$identity | ConvertTo-Json -Compress
