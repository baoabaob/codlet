[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$acceptanceScript = Join-Path $PSScriptRoot 'Invoke-M0CrashAcceptance.ps1'
$powershellExecutable = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName

function Assert-True {
    param(
        [bool] $Condition,
        [string] $Message
    )

    if (-not $Condition) {
        throw "Assertion failed: $Message"
    }
}

function Write-JsonFile {
    param(
        [string] $Path,
        [object] $Value
    )

    $Value | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Invoke-ChildPowerShell {
    param([string[]] $Arguments)

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(
            & $powershellExecutable @Arguments 2>&1 |
                ForEach-Object { [string] $_ }
        )
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    [pscustomobject]@{
        exitCode = $exitCode
        output   = $output
    }
}

function Invoke-TestFixture {
    param(
        [string] $CodletExecutable,
        [string] $ArtifactsDirectory,
        [string] $FixturePath
    )

    $previousTestMode = $env:CODLET_M0_CRASH_ACCEPTANCE_TEST_MODE
    $env:CODLET_M0_CRASH_ACCEPTANCE_TEST_MODE = '1'
    try {
        $result = Invoke-ChildPowerShell -Arguments @(
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-File', $acceptanceScript,
            '-CodletPath', $CodletExecutable,
            '-ConfirmRuntimeCrash',
            '-ArtifactsDirectory', $ArtifactsDirectory,
            '-InternalTestFixturePath', $FixturePath
        )
    } finally {
        if ($null -eq $previousTestMode) {
            Remove-Item Env:CODLET_M0_CRASH_ACCEPTANCE_TEST_MODE -ErrorAction SilentlyContinue
        } else {
            $env:CODLET_M0_CRASH_ACCEPTANCE_TEST_MODE = $previousTestMode
        }
    }
    $result
}

function Read-OnlyReport {
    param([string] $ArtifactsDirectory)

    $reports = @(Get-ChildItem -LiteralPath $ArtifactsDirectory -Filter '*.json' -File)
    Assert-True -Condition ($reports.Count -eq 1) -Message "expected exactly one report in $ArtifactsDirectory"
    Get-Content -LiteralPath $reports[0].FullName -Raw | ConvertFrom-Json
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('codlet-m0-crash-acceptance-tests-{0}' -f [Guid]::NewGuid().ToString('N'))
[void] (New-Item -ItemType Directory -Path $tempRoot)

try {
    $fakeCodletPath = Join-Path $tempRoot 'codlet.exe'
    [IO.File]::WriteAllText($fakeCodletPath, 'test seam placeholder; never executed or terminated')

    $missingConfirmationResult = Invoke-ChildPowerShell -Arguments @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $acceptanceScript,
        '-CodletPath', $fakeCodletPath,
        '-ArtifactsDirectory', (Join-Path $tempRoot 'missing-confirmation-artifacts')
    )
    Assert-True -Condition ($missingConfirmationResult.exitCode -eq 64) -Message 'the destructive confirmation switch must be required'
    Assert-True -Condition (($missingConfirmationResult.output -join "`n") -match 'ConfirmRuntimeCrash') -Message 'the missing confirmation failure must be explicit'

    $defaultArtifactsResult = Invoke-ChildPowerShell -Arguments @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $acceptanceScript,
        '-CodletPath', (Join-Path $tempRoot 'missing-default\codlet.exe'),
        '-ConfirmRuntimeCrash'
    )
    Assert-True -Condition ($defaultArtifactsResult.exitCode -eq 64) -Message 'omitting ArtifactsDirectory must reach normal validation under Windows PowerShell'
    Assert-True -Condition (($defaultArtifactsResult.output -join "`n") -match 'does not exist') -Message 'the default crash artifacts path must initialize before validation'

    $fixtureWithoutTestModePath = Join-Path $tempRoot 'fixture-without-test-mode.json'
    [IO.File]::WriteAllText($fixtureWithoutTestModePath, '{}')
    $fixtureWithoutTestModeResult = Invoke-ChildPowerShell -Arguments @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $acceptanceScript,
        '-CodletPath', $fakeCodletPath,
        '-ConfirmRuntimeCrash',
        '-ArtifactsDirectory', (Join-Path $tempRoot 'fixture-without-test-mode-artifacts'),
        '-InternalTestFixturePath', $fixtureWithoutTestModePath
    )
    Assert-True -Condition ($fixtureWithoutTestModeResult.exitCode -eq 64) -Message 'the fixture seam must be unavailable without explicit test mode'
    Assert-True -Condition (($fixtureWithoutTestModeResult.output -join "`n") -match 'TEST_MODE') -Message 'the fixture seam refusal must identify its test-only boundary'

    $codexPath = 'C:\Program Files\WindowsApps\OpenAI.Codex_26.825.6671.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe'
    $runtimeIdentity = [ordered]@{
        processId       = 6100
        parentProcessId = 6000
        name            = 'codlet.exe'
        executablePath  = $fakeCodletPath
        startedAtUtc    = '2026-08-30T01:00:00.1000000+00:00'
    }
    $codexIdentity = [ordered]@{
        processId       = 6200
        parentProcessId = 6100
        name            = 'ChatGPT.exe'
        executablePath  = $codexPath
        startedAtUtc    = '2026-08-30T01:00:00.2000000+00:00'
    }
    $successFixture = [ordered]@{
        schemaVersion       = 1
        snapshots           = [ordered]@{
            before = [ordered]@{
                capturedAtUtc = '2026-08-30T01:00:00.0000000+00:00'
                processes     = @()
            }
            active = [ordered]@{
                capturedAtUtc = '2026-08-30T01:00:01.0000000+00:00'
                processes     = @($runtimeIdentity, $codexIdentity)
            }
            after  = [ordered]@{
                capturedAtUtc = '2026-08-30T01:00:02.0000000+00:00'
                processes     = @()
            }
        }
        output              = @(
            [ordered]@{
                stream = 'stdout'
                text   = "executable: $codexPath"
            },
            [ordered]@{
                stream = 'stdout'
                text   = 'launched-process-id: 6200'
            },
            [ordered]@{
                stream = 'stdout'
                text   = 'marker-inserted: true'
            },
            [ordered]@{
                stream = 'stdout'
                text   = 'marker-removed: true'
            },
            [ordered]@{
                stream = 'stdout'
                text   = 'runtime-state: active; holding inherited CDP pipes until the launched Codex exits'
            },
            [ordered]@{
                stream = 'stderr'
                text   = 'untrusted runtime detail must not persist'
            }
        )
        runtimeHostIdentity = $runtimeIdentity
        codexChildIdentity  = $codexIdentity
        outcome              = [ordered]@{
            runtimeTerminationRequested = $true
            crashRequestedAtUtc          = '2026-08-30T01:00:01.1000000+00:00'
            runtimeAliveAtCrashRequest   = $true
            codexAliveAtCrashRequest     = $true
            runtimeExitObserved          = $true
            runtimeExitCode              = -1
            runtimeExitedAtUtc            = '2026-08-30T01:00:01.1100000+00:00'
            codexExitObserved            = $true
            codexExitCode                = 0
            codexExitedAtUtc              = '2026-08-30T01:00:01.2000000+00:00'
        }
    }
    $successFixturePath = Join-Path $tempRoot 'success-fixture.json'
    Write-JsonFile -Path $successFixturePath -Value $successFixture

    $successArtifacts = Join-Path $tempRoot 'success-artifacts'
    $successResult = Invoke-TestFixture -CodletExecutable $fakeCodletPath -ArtifactsDirectory $successArtifacts -FixturePath $successFixturePath
    Assert-True -Condition ($successResult.exitCode -eq 0) -Message "a complete crash fixture must pass; got $($successResult.exitCode): $($successResult.output -join ' | ')"
    $report = Read-OnlyReport -ArtifactsDirectory $successArtifacts
    Assert-True -Condition ($report.schema -eq 'codlet.m0-crash-acceptance/v1') -Message 'the crash report schema identifier must be stable'
    Assert-True -Condition ($report.executionMode -eq 'test') -Message 'fixture reports must be unmistakably marked as test evidence'
    Assert-True -Condition ($report.runtimeHost.identity.processId -eq 6100) -Message 'the report must preserve the exact Runtime Host identity'
    Assert-True -Condition ($report.runtimeHost.terminationRequested -eq $true) -Message 'the report must record Runtime Host termination'
    Assert-True -Condition ($report.runtimeHost.aliveAtCrashRequest -eq $true) -Message 'the report must prove the Runtime Host was alive at the action'
    Assert-True -Condition ($report.runtimeHost.exitObserved -eq $true) -Message 'the report must record the Runtime Host exit'
    Assert-True -Condition ($report.codexChild.identity.processId -eq 6200) -Message 'the report must preserve the exact Codex child identity'
    Assert-True -Condition ($report.codexChild.terminationRequested -eq $false) -Message 'the harness must never claim to terminate Codex'
    Assert-True -Condition ($report.codexChild.aliveAtCrashRequest -eq $true) -Message 'the report must prove the Codex child was alive at the action'
    Assert-True -Condition ($report.codexChild.exitObserved -eq $true) -Message 'the report must record the observed Codex exit'
    Assert-True -Condition ($report.protocol.activeLineSeen -eq $true) -Message 'the report must record the active protocol line'
    Assert-True -Condition ($report.protocol.normalStoppedLineSeen -eq $false) -Message 'a forced crash must not invent the normal stopped line'
    Assert-True -Condition (@($report.protocol.output).Count -eq 5) -Message 'the report must preserve only allowlisted stdout'
    Assert-True -Condition ($report.protocol.omittedOutputLineCount -eq 1) -Message 'unrecognized output must be omitted and counted'
    Assert-True -Condition (($report | ConvertTo-Json -Depth 10 -Compress) -notmatch 'untrusted runtime detail') -Message 'unrecognized output must not persist in the report'
    Assert-True -Condition (@($report.snapshots.after.processes).Count -eq 0) -Message 'the passing report must contain an empty after snapshot'
    Assert-True -Condition ($report.result.executionStatus -eq 'crash_contract_passed') -Message 'the passing fixture must use crash_contract_passed'
    Assert-True -Condition ($report.result.crashContractDecision -eq 'passed') -Message 'the passing fixture must make only the crash-contract decision'
    Assert-True -Condition ($report.result.m0Decision -eq 'not_determined') -Message 'the crash harness must not declare all of M0 complete'

    $conflictFixture = $successFixture | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $conflictFixture.snapshots.before.processes = @($runtimeIdentity)
    $conflictFixturePath = Join-Path $tempRoot 'conflict-fixture.json'
    Write-JsonFile -Path $conflictFixturePath -Value $conflictFixture
    $conflictArtifacts = Join-Path $tempRoot 'conflict-artifacts'
    $conflictResult = Invoke-TestFixture -CodletExecutable $fakeCodletPath -ArtifactsDirectory $conflictArtifacts -FixturePath $conflictFixturePath
    Assert-True -Condition ($conflictResult.exitCode -eq 2) -Message 'an existing codlet.exe must refuse the crash test before any action'
    Assert-True -Condition (($conflictResult.output -join "`n") -match 'No process was modified and Codlet was not started') -Message 'the conflict refusal must state the safety behavior'
    $conflictReport = Read-OnlyReport -ArtifactsDirectory $conflictArtifacts
    Assert-True -Condition ($conflictReport.preflight.conflictDetected -eq $true) -Message 'the conflict report must preserve the preflight evidence'
    Assert-True -Condition ($conflictReport.runtimeHost.terminationRequested -eq $false) -Message 'a preflight conflict must not claim a termination action'
    Assert-True -Condition ($conflictReport.result.crashContractDecision -eq 'not_tested') -Message 'a conflict must not make a crash-contract decision'

    $identityMismatchFixture = $successFixture | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $identityMismatchFixture.snapshots.active.processes[0].startedAtUtc = '2026-08-30T01:00:00.9990000+00:00'
    $identityMismatchFixturePath = Join-Path $tempRoot 'identity-mismatch-fixture.json'
    Write-JsonFile -Path $identityMismatchFixturePath -Value $identityMismatchFixture
    $identityMismatchArtifacts = Join-Path $tempRoot 'identity-mismatch-artifacts'
    $identityMismatchResult = Invoke-TestFixture -CodletExecutable $fakeCodletPath -ArtifactsDirectory $identityMismatchArtifacts -FixturePath $identityMismatchFixturePath
    Assert-True -Condition ($identityMismatchResult.exitCode -eq 70) -Message "a PID with a different start time must be an infrastructure-safe refusal; got $($identityMismatchResult.exitCode): $($identityMismatchResult.output -join ' | ')"
    $identityMismatchReport = Read-OnlyReport -ArtifactsDirectory $identityMismatchArtifacts
    Assert-True -Condition ($identityMismatchReport.result.executionStatus -eq 'script_error') -Message 'an identity mismatch must not be evaluated as a crash-contract run'
    Assert-True -Condition (($identityMismatchReport.result.messages -join "`n") -match 'identity changed') -Message 'an identity mismatch must be explicit'

    $orphanFixture = $successFixture | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $orphanFixture.snapshots.after.processes = @($codexIdentity)
    $orphanFixturePath = Join-Path $tempRoot 'orphan-fixture.json'
    Write-JsonFile -Path $orphanFixturePath -Value $orphanFixture
    $orphanArtifacts = Join-Path $tempRoot 'orphan-artifacts'
    $orphanResult = Invoke-TestFixture -CodletExecutable $fakeCodletPath -ArtifactsDirectory $orphanArtifacts -FixturePath $orphanFixturePath
    Assert-True -Condition ($orphanResult.exitCode -eq 1) -Message 'a remaining related process must fail the crash contract'
    $orphanReport = Read-OnlyReport -ArtifactsDirectory $orphanArtifacts
    Assert-True -Condition ($orphanReport.result.executionStatus -eq 'crash_contract_failed') -Message 'a residual process must be a contract failure'
    Assert-True -Condition (($orphanReport.result.messages -join "`n") -match 'PID 6200') -Message 'the residual failure must identify the process'
    Assert-True -Condition ($orphanReport.codexChild.terminationRequested -eq $false) -Message 'the failure path must still never claim Codex termination'

    $normalStopFixture = $successFixture | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $normalStopFixture.output += [pscustomobject][ordered]@{
        stream = 'stdout'
        text   = 'runtime-state: stopped; CDP workers reaped'
    }
    $normalStopFixturePath = Join-Path $tempRoot 'normal-stop-fixture.json'
    Write-JsonFile -Path $normalStopFixturePath -Value $normalStopFixture
    $normalStopArtifacts = Join-Path $tempRoot 'normal-stop-artifacts'
    $normalStopResult = Invoke-TestFixture -CodletExecutable $fakeCodletPath -ArtifactsDirectory $normalStopArtifacts -FixturePath $normalStopFixturePath
    Assert-True -Condition ($normalStopResult.exitCode -eq 1) -Message 'a normal stopped line must not masquerade as forced-crash evidence'
    $normalStopReport = Read-OnlyReport -ArtifactsDirectory $normalStopArtifacts
    Assert-True -Condition ($normalStopReport.protocol.normalStoppedLineSeen -eq $true) -Message 'the report must preserve the unexpected normal-stop evidence'
    Assert-True -Condition (($normalStopReport.result.messages -join "`n") -match 'not a forced-crash path') -Message 'the normal-stop rejection must be explicit'

    $missingCodexExitFixture = $successFixture | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $missingCodexExitFixture.outcome.codexExitObserved = $false
    $missingCodexExitFixturePath = Join-Path $tempRoot 'missing-codex-exit-fixture.json'
    Write-JsonFile -Path $missingCodexExitFixturePath -Value $missingCodexExitFixture
    $missingCodexExitArtifacts = Join-Path $tempRoot 'missing-codex-exit-artifacts'
    $missingCodexExitResult = Invoke-TestFixture -CodletExecutable $fakeCodletPath -ArtifactsDirectory $missingCodexExitArtifacts -FixturePath $missingCodexExitFixturePath
    Assert-True -Condition ($missingCodexExitResult.exitCode -eq 1) -Message 'an unobserved Codex exit must fail the crash contract'
    $missingCodexExitReport = Read-OnlyReport -ArtifactsDirectory $missingCodexExitArtifacts
    Assert-True -Condition (($missingCodexExitReport.result.messages -join "`n") -match 'did not exit within 15 seconds') -Message 'the child timeout failure must be explicit'

    $earlyCodexExitFixture = $successFixture | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $earlyCodexExitFixture.outcome.codexExitedAtUtc = '2026-08-30T01:00:01.1050000+00:00'
    $earlyCodexExitFixturePath = Join-Path $tempRoot 'early-codex-exit-fixture.json'
    Write-JsonFile -Path $earlyCodexExitFixturePath -Value $earlyCodexExitFixture
    $earlyCodexExitArtifacts = Join-Path $tempRoot 'early-codex-exit-artifacts'
    $earlyCodexExitResult = Invoke-TestFixture -CodletExecutable $fakeCodletPath -ArtifactsDirectory $earlyCodexExitArtifacts -FixturePath $earlyCodexExitFixturePath
    Assert-True -Condition ($earlyCodexExitResult.exitCode -eq 1) -Message 'a Codex exit preceding the Runtime Host exit must fail causal evidence'
    $earlyCodexExitReport = Read-OnlyReport -ArtifactsDirectory $earlyCodexExitArtifacts
    Assert-True -Condition (($earlyCodexExitReport.result.messages -join "`n") -match 'pipe-disconnect causality was not established') -Message 'the causal-order rejection must be explicit'
} finally {
    $resolvedTempRoot = [IO.Path]::GetFullPath($tempRoot)
    $resolvedSystemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedTempRoot.StartsWith($resolvedSystemTemp, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove unexpected test directory: $resolvedTempRoot"
    }
    Remove-Item -LiteralPath $resolvedTempRoot -Recurse -Force
}

[Console]::Out.WriteLine('M0 crash acceptance PowerShell tests passed.')
