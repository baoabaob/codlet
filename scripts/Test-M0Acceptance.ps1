[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$acceptanceScript = Join-Path $PSScriptRoot 'Invoke-M0Acceptance.ps1'
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

    $previousTestMode = $env:CODLET_M0_ACCEPTANCE_TEST_MODE
    $env:CODLET_M0_ACCEPTANCE_TEST_MODE = '1'
    try {
        $result = Invoke-ChildPowerShell -Arguments @(
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-File', $acceptanceScript,
            '-CodletPath', $CodletExecutable,
            '-ArtifactsDirectory', $ArtifactsDirectory,
            '-InternalTestFixturePath', $FixturePath
        )
    } finally {
        if ($null -eq $previousTestMode) {
            Remove-Item Env:CODLET_M0_ACCEPTANCE_TEST_MODE -ErrorAction SilentlyContinue
        } else {
            $env:CODLET_M0_ACCEPTANCE_TEST_MODE = $previousTestMode
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

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('codlet-m0-acceptance-tests-{0}' -f [Guid]::NewGuid().ToString('N'))
[void] (New-Item -ItemType Directory -Path $tempRoot)

try {
    $previousErrorActionPreference = $ErrorActionPreference
    $previousNativeExitCode = Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
    try {
        $ErrorActionPreference = 'Continue'
        $nativeStderr = @(
            & $env:ComSpec '/d' '/s' '/c' '>&2 echo runtime-state: stopped; CDP workers reaped & exit /b 7' 2>&1
        )
        $nativeStderrExitCode = $global:LASTEXITCODE
    } finally {
        if ($null -eq $previousNativeExitCode) {
            Remove-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
        } else {
            $global:LASTEXITCODE = $previousNativeExitCode.Value
        }
        $ErrorActionPreference = $previousErrorActionPreference
    }
    Assert-True -Condition ($nativeStderrExitCode -eq 7) -Message 'the current PowerShell runtime must preserve a native stderr command exit code'
    Assert-True -Condition ($nativeStderr.Count -gt 0) -Message 'the native stderr probe must emit at least one object'
    Assert-True -Condition (@($nativeStderr | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] }).Count -eq 0) -Message 'native stderr must arrive as ErrorRecord objects for the report filter contract'

    $fakeCodletPath = Join-Path $tempRoot 'codlet.exe'
    [IO.File]::WriteAllText($fakeCodletPath, 'test seam placeholder; never executed')

    $missingResult = Invoke-ChildPowerShell -Arguments @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $acceptanceScript,
        '-CodletPath', (Join-Path $tempRoot 'missing\codlet.exe'),
        '-ArtifactsDirectory', (Join-Path $tempRoot 'missing-artifacts')
    )
    Assert-True -Condition ($missingResult.exitCode -eq 64) -Message 'a missing codlet.exe path must fail validation with exit code 64'
    Assert-True -Condition (($missingResult.output -join "`n") -match 'does not exist') -Message 'missing path failure must be explicit'

    $wrongNamePath = Join-Path $tempRoot 'renamed.exe'
    [IO.File]::WriteAllText($wrongNamePath, 'not codlet.exe')
    $wrongNameResult = Invoke-ChildPowerShell -Arguments @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $acceptanceScript,
        '-CodletPath', $wrongNamePath,
        '-ArtifactsDirectory', (Join-Path $tempRoot 'wrong-name-artifacts')
    )
    Assert-True -Condition ($wrongNameResult.exitCode -eq 64) -Message 'a renamed executable must fail validation with exit code 64'
    Assert-True -Condition (($wrongNameResult.output -join "`n") -match 'must name codlet.exe') -Message 'wrong executable name failure must be explicit'

    $conflictFixturePath = Join-Path $tempRoot 'conflict-fixture.json'
    $conflictFixture = [ordered]@{
        schemaVersion = 1
        snapshots     = [ordered]@{
            before = [ordered]@{
                capturedAtUtc = '2026-08-30T00:00:00.0000000+00:00'
                processes     = @(
                    [ordered]@{
                        processId       = 4100
                        parentProcessId = 4000
                        name            = 'ChatGPT.exe'
                        executablePath  = 'C:\Program Files\WindowsApps\OpenAI.Codex\app\ChatGPT.exe'
                        startedAtUtc    = '2026-08-30T00:00:00.0000000+00:00'
                    }
                )
                tcpListeners  = @(
                    [ordered]@{
                        owningProcessId = 4100
                        localAddress    = '127.0.0.1'
                        localPort       = 49999
                    }
                )
            }
            after = [ordered]@{
                capturedAtUtc = '2026-08-30T00:00:01.0000000+00:00'
                processes     = @(
                    [ordered]@{
                        processId       = 4100
                        parentProcessId = 4000
                        name            = 'ChatGPT.exe'
                        executablePath  = 'C:\Program Files\WindowsApps\OpenAI.Codex\app\ChatGPT.exe'
                        startedAtUtc    = '2026-08-30T00:00:00.0000000+00:00'
                    }
                )
                tcpListeners  = @()
            }
        }
        command       = [ordered]@{
            exitCode = 99
            output   = @(
                [ordered]@{
                    stream = 'stderr'
                    text   = 'MUST_NOT_RUN'
                }
            )
        }
    }
    Write-JsonFile -Path $conflictFixturePath -Value $conflictFixture

    $conflictArtifacts = Join-Path $tempRoot 'conflict-artifacts'
    $conflictResult = Invoke-TestFixture -CodletExecutable $fakeCodletPath -ArtifactsDirectory $conflictArtifacts -FixturePath $conflictFixturePath
    Assert-True -Condition ($conflictResult.exitCode -eq 2) -Message "an existing ChatGPT process must refuse the run with exit code 2; got $($conflictResult.exitCode): $($conflictResult.output -join ' | ')"
    Assert-True -Condition (($conflictResult.output -join "`n") -match 'No process was modified and Codlet was not started') -Message 'conflict refusal must state the safety behavior'
    Assert-True -Condition (($conflictResult.output -join "`n") -notmatch 'MUST_NOT_RUN') -Message 'the Codlet command seam must not execute after a conflict'

    $conflictReport = Read-OnlyReport -ArtifactsDirectory $conflictArtifacts
    Assert-True -Condition ($conflictReport.preflight.conflictDetected -eq $true) -Message 'conflict report must identify the conflict'
    Assert-True -Condition ($conflictReport.codlet.invoked -eq $false) -Message 'conflict report must record that Codlet was not invoked'
    Assert-True -Condition ($null -eq $conflictReport.codlet.exitCode) -Message 'conflict report must not invent a Codlet exit code'
    Assert-True -Condition ($null -eq $conflictReport.snapshots.active) -Message 'a conflict must not invent or consume an active snapshot'
    Assert-True -Condition ($conflictReport.result.executionStatus -eq 'preflight_conflict') -Message 'conflict report must use the preflight_conflict status'

    $schemaFixturePath = Join-Path $tempRoot 'schema-fixture.json'
    $schemaFixture = [ordered]@{
        schemaVersion = 1
        snapshots     = [ordered]@{
            before = [ordered]@{
                capturedAtUtc = '2026-08-30T01:00:00.0000000+00:00'
                processes     = @()
                tcpListeners  = @()
            }
            active = [ordered]@{
                capturedAtUtc = '2026-08-30T01:00:00.5000000+00:00'
                processes     = @(
                    [ordered]@{
                        processId       = 5100
                        parentProcessId = 5000
                        name            = 'ChatGPT.exe'
                        executablePath  = 'C:\Program Files\WindowsApps\OpenAI.Codex\app\ChatGPT.exe'
                        startedAtUtc    = '2026-08-30T01:00:00.2500000+00:00'
                    }
                )
                tcpListeners  = @(
                    [ordered]@{
                        owningProcessId = 5100
                        localAddress    = '127.0.0.1'
                        localPort       = 49998
                    }
                )
            }
            after = [ordered]@{
                capturedAtUtc = '2026-08-30T01:00:01.0000000+00:00'
                processes     = @()
                tcpListeners  = @()
            }
        }
        command       = [ordered]@{
            exitCode = 0
            output   = @(
                [ordered]@{
                    stream = 'stdout'
                    text   = 'launched-process-id: 5100'
                },
                [ordered]@{
                    stream = 'stdout'
                    text   = 'runtime-state: active; holding inherited CDP pipes until the launched Codex exits'
                },
                [ordered]@{
                    stream = 'stdout'
                    text   = 'runtime-state: stopped; CDP workers reaped'
                },
                [ordered]@{
                    stream = 'stderr'
                    text   = 'untrusted page content must not persist'
                }
            )
        }
    }
    Write-JsonFile -Path $schemaFixturePath -Value $schemaFixture

    $schemaArtifacts = Join-Path $tempRoot 'schema-artifacts'
    $schemaResult = Invoke-TestFixture -CodletExecutable $fakeCodletPath -ArtifactsDirectory $schemaArtifacts -FixturePath $schemaFixturePath
    Assert-True -Condition ($schemaResult.exitCode -eq 0) -Message 'the successful command seam must return exit code 0'

    $report = Read-OnlyReport -ArtifactsDirectory $schemaArtifacts
    Assert-True -Condition ($report.schema -eq 'codlet.m0-acceptance/v1') -Message 'report schema identifier must be stable'
    Assert-True -Condition ($report.executionMode -eq 'test') -Message 'fixture reports must be unmistakably marked as test evidence'
    Assert-True -Condition (-not [string]::IsNullOrWhiteSpace($report.startedAtUtc)) -Message 'report must include startedAtUtc'
    Assert-True -Condition (-not [string]::IsNullOrWhiteSpace($report.endedAtUtc)) -Message 'report must include endedAtUtc'
    Assert-True -Condition ($report.codlet.invoked -eq $true) -Message 'successful seam report must record command invocation'
    Assert-True -Condition ($report.codlet.exitCode -eq 0) -Message 'report must preserve the Codlet exit code'
    Assert-True -Condition (@($report.codlet.output).Count -eq 3) -Message 'report must preserve allowlisted command output'
    Assert-True -Condition ($report.codlet.outputPolicy -eq 'allowlisted-m0-stdout-v1') -Message 'report must identify its output allowlist policy'
    Assert-True -Condition ($report.codlet.omittedOutputLineCount -eq 1) -Message 'unrecognized fixture output must be omitted and counted'
    Assert-True -Condition (($report | ConvertTo-Json -Depth 10 -Compress) -notmatch 'untrusted page content') -Message 'unrecognized output must not be persisted anywhere in the report'
    Assert-True -Condition ($null -ne $report.snapshots.before.processes) -Message 'report must include the before process snapshot'
    Assert-True -Condition ($null -ne $report.snapshots.before.tcpListeners) -Message 'report must include the before TCP listener snapshot'
    Assert-True -Condition (@($report.snapshots.active.processes).Count -eq 1) -Message 'the active protocol line must capture the active process snapshot'
    Assert-True -Condition (@($report.snapshots.active.tcpListeners).Count -eq 1) -Message 'the active protocol line must capture active TCP listeners'
    Assert-True -Condition ($report.snapshots.active.processes[0].processId -eq 5100) -Message 'the active process snapshot must remain phase-specific'
    Assert-True -Condition ($report.snapshots.active.tcpListeners[0].localPort -eq 49998) -Message 'the active listener snapshot must remain phase-specific'
    Assert-True -Condition ($null -ne $report.snapshots.after.processes) -Message 'report must include the after process snapshot'
    Assert-True -Condition ($null -ne $report.snapshots.after.tcpListeners) -Message 'report must include the after TCP listener snapshot'
    Assert-True -Condition (@($report.manualChecks).Count -eq 4) -Message 'report must enumerate all four required manual checks'
    Assert-True -Condition (@($report.manualChecks | Where-Object { $_.status -ne 'pending_manual_confirmation' }).Count -eq 0) -Message 'no manual check may be marked passed automatically'
    Assert-True -Condition ($report.result.m0Decision -eq 'not_determined') -Message 'the script must not declare M0 complete'
    Assert-True -Condition ($report.codlet.protocol.launchedProcessId -eq 5100) -Message 'the report must bind evidence to the launched process id'
    Assert-True -Condition ($report.codlet.protocol.activeLineSeen -eq $true) -Message 'the report must record the active protocol line'
    Assert-True -Condition ($report.codlet.protocol.stoppedLineSeen -eq $true) -Message 'the report must record the worker-reaped protocol line'

    $missingStoppedFixture = $schemaFixture | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $missingStoppedFixture.command.output = @(
        $missingStoppedFixture.command.output | Where-Object {
            $_.text -ne 'runtime-state: stopped; CDP workers reaped'
        }
    )
    $missingStoppedFixturePath = Join-Path $tempRoot 'missing-stopped-fixture.json'
    Write-JsonFile -Path $missingStoppedFixturePath -Value $missingStoppedFixture

    $missingStoppedArtifacts = Join-Path $tempRoot 'missing-stopped-artifacts'
    $missingStoppedResult = Invoke-TestFixture -CodletExecutable $fakeCodletPath -ArtifactsDirectory $missingStoppedArtifacts -FixturePath $missingStoppedFixturePath
    Assert-True -Condition ($missingStoppedResult.exitCode -eq 70) -Message 'a zero exit without the worker-reaped protocol line must fail evidence collection'
    $missingStoppedReport = Read-OnlyReport -ArtifactsDirectory $missingStoppedArtifacts
    Assert-True -Condition ($missingStoppedReport.result.executionStatus -eq 'evidence_failed') -Message 'a missing stopped protocol line must be reported as evidence_failed'
    Assert-True -Condition ($missingStoppedReport.codlet.protocol.stoppedLineSeen -eq $false) -Message 'the report must not invent the stopped protocol line'

    $pidMismatchFixture = $schemaFixture | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $pidMismatchFixture.snapshots.active.processes[0].processId = 5101
    $pidMismatchFixturePath = Join-Path $tempRoot 'pid-mismatch-fixture.json'
    Write-JsonFile -Path $pidMismatchFixturePath -Value $pidMismatchFixture

    $pidMismatchArtifacts = Join-Path $tempRoot 'pid-mismatch-artifacts'
    $pidMismatchResult = Invoke-TestFixture -CodletExecutable $fakeCodletPath -ArtifactsDirectory $pidMismatchArtifacts -FixturePath $pidMismatchFixturePath
    Assert-True -Condition ($pidMismatchResult.exitCode -eq 70) -Message 'an active snapshot without the launched PID must fail evidence collection'
    $pidMismatchReport = Read-OnlyReport -ArtifactsDirectory $pidMismatchArtifacts
    Assert-True -Condition ($pidMismatchReport.result.executionStatus -eq 'evidence_failed') -Message 'a launched PID mismatch must be reported as evidence_failed'
    Assert-True -Condition (($pidMismatchReport.result.messages -join "`n") -match 'PID 5100') -Message 'a launched PID mismatch must identify the missing PID'

    $residualFixture = $schemaFixture | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $residualFixture.snapshots.after.processes = @(
        [pscustomobject][ordered]@{
            processId       = 5300
            parentProcessId = 5000
            name            = 'ChatGPT.exe'
            executablePath  = 'C:\Program Files\WindowsApps\OpenAI.Codex\app\ChatGPT.exe'
            startedAtUtc    = '2026-08-30T01:00:00.2500000+00:00'
        }
    )
    $residualFixturePath = Join-Path $tempRoot 'residual-fixture.json'
    Write-JsonFile -Path $residualFixturePath -Value $residualFixture

    $residualArtifacts = Join-Path $tempRoot 'residual-artifacts'
    $residualResult = Invoke-TestFixture -CodletExecutable $fakeCodletPath -ArtifactsDirectory $residualArtifacts -FixturePath $residualFixturePath
    Assert-True -Condition ($residualResult.exitCode -eq 70) -Message 'a related process remaining after Codlet returns must fail evidence collection'
    $residualReport = Read-OnlyReport -ArtifactsDirectory $residualArtifacts
    Assert-True -Condition ($residualReport.result.executionStatus -eq 'evidence_failed') -Message 'a remaining related process must be reported as evidence_failed'
    Assert-True -Condition (($residualReport.result.messages -join "`n") -match 'PID 5300') -Message 'the remaining process failure must identify the residual PID'

    $malformedFixture = $schemaFixture | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $malformedFixture.snapshots.before.capturedAtUtc = $null
    $malformedFixturePath = Join-Path $tempRoot 'malformed-fixture.json'
    Write-JsonFile -Path $malformedFixturePath -Value $malformedFixture

    $malformedArtifacts = Join-Path $tempRoot 'malformed-artifacts'
    $malformedResult = Invoke-TestFixture -CodletExecutable $fakeCodletPath -ArtifactsDirectory $malformedArtifacts -FixturePath $malformedFixturePath
    Assert-True -Condition ($malformedResult.exitCode -eq 70) -Message 'a malformed fixture snapshot must fail validation before Codlet is invoked'
    $malformedReport = Read-OnlyReport -ArtifactsDirectory $malformedArtifacts
    Assert-True -Condition ($malformedReport.codlet.invoked -eq $false) -Message 'a malformed preflight snapshot must not invoke Codlet'
    Assert-True -Condition ($malformedReport.result.executionStatus -eq 'script_error') -Message 'a malformed preflight snapshot must be a script_error'

    $activeFailureFixturePath = Join-Path $tempRoot 'active-failure-fixture.json'
    $activeFailureFixture = [ordered]@{
        schemaVersion = 1
        snapshots     = [ordered]@{
            before = [ordered]@{
                capturedAtUtc = '2026-08-30T01:30:00.0000000+00:00'
                processes     = @()
                tcpListeners  = @()
            }
            after = [ordered]@{
                capturedAtUtc = '2026-08-30T01:30:01.0000000+00:00'
                processes     = @()
                tcpListeners  = @()
            }
        }
        command       = [ordered]@{
            exitCode = 0
            output   = @(
                [ordered]@{
                    stream = 'stdout'
                    text   = 'launched-process-id: 5200'
                },
                [ordered]@{
                    stream = 'stdout'
                    text   = 'runtime-state: active; holding inherited CDP pipes until the launched Codex exits'
                },
                [ordered]@{
                    stream = 'stdout'
                    text   = 'runtime-state: stopped; CDP workers reaped'
                }
            )
        }
    }
    Write-JsonFile -Path $activeFailureFixturePath -Value $activeFailureFixture

    $activeFailureArtifacts = Join-Path $tempRoot 'active-failure-artifacts'
    $activeFailureResult = Invoke-TestFixture -CodletExecutable $fakeCodletPath -ArtifactsDirectory $activeFailureArtifacts -FixturePath $activeFailureFixturePath
    Assert-True -Condition ($activeFailureResult.exitCode -eq 70) -Message 'an active snapshot failure must return the infrastructure failure code after Codlet completes'

    $activeFailureReport = Read-OnlyReport -ArtifactsDirectory $activeFailureArtifacts
    Assert-True -Condition ($activeFailureReport.codlet.exitCode -eq 0) -Message 'an active snapshot failure must still preserve the completed Codlet exit code'
    Assert-True -Condition (@($activeFailureReport.codlet.output).Count -eq 3) -Message 'active snapshot failure must not stop collection before the runtime-stopped line'
    Assert-True -Condition (-not [string]::IsNullOrWhiteSpace($activeFailureReport.snapshots.active.captureError)) -Message 'active snapshot failure must be recorded in the active phase'
    Assert-True -Condition ($activeFailureReport.result.executionStatus -eq 'snapshot_failed') -Message 'active snapshot failure must not be reported as Codlet success'

    $nativeCodletDirectory = Join-Path $tempRoot 'native-command'
    [void] (New-Item -ItemType Directory -Path $nativeCodletDirectory)
    $nativeCodletPath = Join-Path $nativeCodletDirectory 'codlet.exe'
    Copy-Item -LiteralPath $env:ComSpec -Destination $nativeCodletPath

    $nativeFixturePath = Join-Path $tempRoot 'native-fixture.json'
    $nativeFixture = [ordered]@{
        schemaVersion = 1
        snapshots     = [ordered]@{
            before = [ordered]@{
                capturedAtUtc = '2026-08-30T02:00:00.0000000+00:00'
                processes     = @()
                tcpListeners  = @()
            }
            active = [ordered]@{
                capturedAtUtc = '2026-08-30T02:00:00.5000000+00:00'
                processes     = @(
                    [ordered]@{
                        processId       = 9999
                        parentProcessId = 9998
                        name            = 'ChatGPT.exe'
                        executablePath  = 'C:\must-not-be-consumed\ChatGPT.exe'
                        startedAtUtc    = '2026-08-30T02:00:00.2500000+00:00'
                    }
                )
                tcpListeners  = @()
            }
            after = [ordered]@{
                capturedAtUtc = '2026-08-30T02:00:01.0000000+00:00'
                processes     = @()
                tcpListeners  = @()
            }
        }
        command       = $null
    }
    Write-JsonFile -Path $nativeFixturePath -Value $nativeFixture

    $nativeArtifacts = Join-Path $tempRoot 'native-artifacts'
    $nativeResult = Invoke-TestFixture -CodletExecutable $nativeCodletPath -ArtifactsDirectory $nativeArtifacts -FixturePath $nativeFixturePath
    Assert-True -Condition ($nativeResult.exitCode -eq 70) -Message "a native zero exit without the active protocol line must fail evidence collection; got $($nativeResult.exitCode): $($nativeResult.output -join ' | ')"

    $nativeReport = Read-OnlyReport -ArtifactsDirectory $nativeArtifacts
    Assert-True -Condition ($nativeReport.executionMode -eq 'test') -Message 'native seam reports must remain marked as test evidence'
    Assert-True -Condition ($nativeReport.codlet.invoked -eq $true) -Message 'native seam report must record command invocation'
    Assert-True -Condition ($nativeReport.codlet.exitCode -eq 0) -Message 'native seam report must preserve the real native exit code'
    Assert-True -Condition (@($nativeReport.codlet.output).Count -eq 0) -Message 'unrecognized native output must not be persisted'
    Assert-True -Condition ($nativeReport.codlet.omittedOutputLineCount -gt 0) -Message 'unrecognized native output must be counted as omitted'
    Assert-True -Condition ($nativeReport.result.executionStatus -eq 'snapshot_failed') -Message 'native zero exit without an active protocol line must not be reported as codlet_completed'
    Assert-True -Condition ($null -eq $nativeReport.snapshots.active) -Message 'a command without the active protocol line must not consume or report an active snapshot'

    $nativeFailureDirectory = Join-Path $tempRoot 'native-command-failure'
    [void] (New-Item -ItemType Directory -Path $nativeFailureDirectory)
    $nativeFailurePath = Join-Path $nativeFailureDirectory 'codlet.exe'
    Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\hostname.exe') -Destination $nativeFailurePath

    $nativeFailureArtifacts = Join-Path $tempRoot 'native-failure-artifacts'
    $nativeFailureResult = Invoke-TestFixture -CodletExecutable $nativeFailurePath -ArtifactsDirectory $nativeFailureArtifacts -FixturePath $nativeFixturePath
    Assert-True -Condition ($nativeFailureResult.exitCode -eq 1) -Message "the native failure path must preserve exit code 1; got $($nativeFailureResult.exitCode): $($nativeFailureResult.output -join ' | ')"

    $nativeFailureReport = Read-OnlyReport -ArtifactsDirectory $nativeFailureArtifacts
    Assert-True -Condition ($nativeFailureReport.codlet.invoked -eq $true) -Message 'native failure report must record command invocation'
    Assert-True -Condition ($nativeFailureReport.codlet.exitCode -eq 1) -Message 'native failure report must preserve the real nonzero exit code'
    Assert-True -Condition ($nativeFailureReport.result.executionStatus -eq 'codlet_failed') -Message 'native nonzero exit must be reported as codlet_failed'
} finally {
    $resolvedTempRoot = [IO.Path]::GetFullPath($tempRoot)
    $resolvedSystemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedTempRoot.StartsWith($resolvedSystemTemp, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove unexpected test directory: $resolvedTempRoot"
    }
    Remove-Item -LiteralPath $resolvedTempRoot -Recurse -Force
}

[Console]::Out.WriteLine('M0 acceptance PowerShell tests passed.')
