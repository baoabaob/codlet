[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $CodletPath,

    [string] $ArtifactsDirectory,

    [string] $InternalTestFixturePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $PSBoundParameters.ContainsKey('ArtifactsDirectory')) {
    $ArtifactsDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) '.codlet-artifacts\m0-acceptance'
}

$validationExitCode = 64
$infrastructureExitCode = 70

function Get-UtcTimestamp {
    [DateTimeOffset]::UtcNow.ToString('o')
}

function Resolve-CodletExecutable {
    param([string] $Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw 'CodletPath must name an existing codlet.exe.'
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "CodletPath does not exist or is not a file: $Path"
    }

    $resolved = (Resolve-Path -LiteralPath $Path).ProviderPath
    if (-not [IO.Path]::GetFileName($resolved).Equals('codlet.exe', [StringComparison]::OrdinalIgnoreCase)) {
        throw "CodletPath must name codlet.exe: $resolved"
    }

    $resolved
}

function Resolve-ArtifactsDirectory {
    param([string] $Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw 'ArtifactsDirectory must not be empty.'
    }

    if ([IO.Path]::IsPathRooted($Path)) {
        return [IO.Path]::GetFullPath($Path)
    }

    [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Path))
}

function Read-TestFixture {
    param([string] $Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }
    if ($env:CODLET_M0_ACCEPTANCE_TEST_MODE -ne '1') {
        throw 'InternalTestFixturePath is available only when CODLET_M0_ACCEPTANCE_TEST_MODE=1.'
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Internal test fixture does not exist: $Path"
    }

    $fixture = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ([int] $fixture.schemaVersion -ne 1) {
        throw 'Internal test fixture schemaVersion must be 1.'
    }
    if ($null -eq $fixture.snapshots) {
        throw 'Internal test fixture must contain named snapshots.'
    }
    foreach ($phase in @('before', 'after')) {
        if ($fixture.snapshots.PSObject.Properties.Name -notcontains $phase) {
            throw "Internal test fixture must contain a $phase snapshot."
        }
    }
    if ($fixture.PSObject.Properties.Name -notcontains 'command') {
        throw 'Internal test fixture must contain a command property.'
    }

    $fixture
}

function Get-LiveSnapshot {
    param([string] $CodletExecutable)

    $codletName = [IO.Path]::GetFileName($CodletExecutable).ToLowerInvariant()
    $relatedNames = @('chatgpt.exe', 'codex.exe', $codletName) | Select-Object -Unique
    $processes = @(
        Get-CimInstance -ClassName Win32_Process -ErrorAction Stop |
            Where-Object {
                $name = [string] $_.Name
                $relatedNames -contains $name.ToLowerInvariant()
            } |
            ForEach-Object {
                $startedAtUtc = $null
                if ($null -ne $_.CreationDate) {
                    $startedAtUtc = ([DateTime] $_.CreationDate).ToUniversalTime().ToString('o')
                }

                [pscustomobject][ordered]@{
                    processId       = [int] $_.ProcessId
                    parentProcessId = [int] $_.ParentProcessId
                    name            = [string] $_.Name
                    executablePath  = if ($null -eq $_.ExecutablePath) { $null } else { [string] $_.ExecutablePath }
                    startedAtUtc    = $startedAtUtc
                }
            } |
            Sort-Object processId
    )

    $tcpListeners = @()
    if ($processes.Count -gt 0) {
        $processIds = @($processes | ForEach-Object { $_.processId })
        $tcpListeners = @(
            Get-NetTCPConnection -State Listen -ErrorAction Stop |
                Where-Object { $processIds -contains [int] $_.OwningProcess } |
                ForEach-Object {
                    [pscustomobject][ordered]@{
                        owningProcessId = [int] $_.OwningProcess
                        localAddress    = [string] $_.LocalAddress
                        localPort       = [int] $_.LocalPort
                    }
                } |
                Sort-Object owningProcessId, localAddress, localPort
        )
    }

    [pscustomobject][ordered]@{
        capturedAtUtc = Get-UtcTimestamp
        processes     = $processes
        tcpListeners  = $tcpListeners
        captureError  = $null
    }
}

function Get-AcceptanceSnapshot {
    param(
        [string] $CodletExecutable,
        [object] $Fixture,
        [ValidateSet('before', 'active', 'after')]
        [string] $Phase
    )

    if ($null -eq $Fixture) {
        return Get-LiveSnapshot -CodletExecutable $CodletExecutable
    }

    $snapshotProperty = $Fixture.snapshots.PSObject.Properties[$Phase]
    if ($null -eq $snapshotProperty) {
        throw "Internal test fixture has no $Phase process snapshot."
    }

    $source = $snapshotProperty.Value
    if ($null -eq $source.processes -or $null -eq $source.tcpListeners) {
        throw 'Each internal test snapshot must contain processes and tcpListeners.'
    }
    if (-not ($source.processes -is [Array]) -or -not ($source.tcpListeners -is [Array])) {
        throw 'Internal test snapshot processes and tcpListeners must be arrays.'
    }
    $parsedTimestamp = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse([string] $source.capturedAtUtc, [ref] $parsedTimestamp)) {
        throw 'Internal test snapshot capturedAtUtc must be an ISO-8601 timestamp.'
    }

    [pscustomobject][ordered]@{
        capturedAtUtc = [string] $source.capturedAtUtc
        processes     = @($source.processes)
        tcpListeners  = @($source.tcpListeners)
        captureError  = $null
    }
}

function New-FailedSnapshot {
    param([string] $Message)

    [pscustomobject][ordered]@{
        capturedAtUtc = Get-UtcTimestamp
        processes     = $null
        tcpListeners  = $null
        captureError  = $Message
    }
}

function Get-ActiveSnapshot {
    param(
        [string] $CodletExecutable,
        [object] $Fixture
    )

    try {
        Get-AcceptanceSnapshot -CodletExecutable $CodletExecutable -Fixture $Fixture -Phase active
    } catch {
        New-FailedSnapshot -Message $_.Exception.Message
    }
}

function Get-ConflictingProcesses {
    param([object] $Snapshot)

    @(
        $Snapshot.processes | Where-Object {
            $name = ([string] $_.name).ToLowerInvariant()
            $name -eq 'chatgpt.exe' -or $name -eq 'codex.exe'
        }
    )
}

function Write-CapturedLine {
    param(
        [string] $Stream,
        [string] $Text
    )

    if ($Stream -eq 'stderr') {
        [Console]::Error.WriteLine($Text)
    } else {
        [Console]::Out.WriteLine($Text)
    }
}

function Test-ReportableCodletOutput {
    param(
        [string] $Stream,
        [string] $Text
    )

    if ($Stream -ne 'stdout') {
        return $false
    }

    $patterns = @(
        '^package: [A-Za-z0-9._-]+$',
        '^version: [0-9]+(?:\.[0-9]+){3}$',
        '^executable: (?:[A-Za-z]:\\|\\\\\?\\[A-Za-z]:\\)[^\r\n]+$',
        '^launched-process-id: [1-9][0-9]*$',
        '^marker-inserted: (?:true|false)$',
        '^marker-removed: (?:true|false)$',
        '^runtime-state: active; holding inherited CDP pipes until the launched Codex exits$',
        '^action: use Codex normally, then close Codex to stop this foreground runtime$',
        '^codex-exit-code: [0-9]+$',
        '^runtime-state: stopped; CDP workers reaped$'
    )

    foreach ($pattern in $patterns) {
        if ($Text -cmatch $pattern) {
            return $true
        }
    }

    $false
}

function Invoke-CodletRuntime {
    param(
        [string] $CodletExecutable,
        [object] $Fixture
    )

    $reportableOutput = [Collections.Generic.List[object]]::new()
    $omittedOutputLineCount = 0
    $launchedProcessId = $null
    $activeLineSeen = $false
    $stoppedLineSeen = $false
    $activeSnapshot = $null
    if ($null -ne $Fixture -and $null -ne $Fixture.command) {
        foreach ($source in @($Fixture.command.output)) {
            $stream = [string] $source.stream
            if ($stream -ne 'stdout' -and $stream -ne 'stderr') {
                throw "Internal test command output has invalid stream: $stream"
            }

            $entry = [pscustomobject][ordered]@{
                capturedAtUtc = Get-UtcTimestamp
                stream        = $stream
                text          = [string] $source.text
            }
            Write-CapturedLine -Stream $entry.stream -Text $entry.text
            if (Test-ReportableCodletOutput -Stream $entry.stream -Text $entry.text) {
                $reportableOutput.Add($entry)
            } else {
                $omittedOutputLineCount += 1
            }
            if ($entry.stream -eq 'stdout') {
                if ($entry.text -cmatch '^launched-process-id: ([1-9][0-9]*)$') {
                    $launchedProcessId = [int] $Matches[1]
                }
                if ($entry.text -ceq 'runtime-state: active; holding inherited CDP pipes until the launched Codex exits') {
                    $activeLineSeen = $true
                    if ($null -eq $activeSnapshot) {
                        $activeSnapshot = Get-ActiveSnapshot -CodletExecutable $CodletExecutable -Fixture $Fixture
                    }
                }
                if ($entry.text -ceq 'runtime-state: stopped; CDP workers reaped') {
                    $stoppedLineSeen = $true
                }
            }
        }

        return [pscustomobject][ordered]@{
            exitCode              = [int] $Fixture.command.exitCode
            output                = @($reportableOutput)
            omittedOutputLineCount = $omittedOutputLineCount
            activeSnapshot        = $activeSnapshot
            launchedProcessId      = $launchedProcessId
            activeLineSeen         = $activeLineSeen
            stoppedLineSeen        = $stoppedLineSeen
        }
    }

    $previousErrorActionPreference = $ErrorActionPreference
    $previousNativeExitCode = Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
    $global:LASTEXITCODE = $null
    $nativeExitCode = $null
    try {
        $ErrorActionPreference = 'Continue'
        & $CodletExecutable 'm0-runtime' '--launch-codex' 2>&1 |
            ForEach-Object {
                $stream = if ($_ -is [Management.Automation.ErrorRecord]) { 'stderr' } else { 'stdout' }
                $entry = [pscustomobject][ordered]@{
                    capturedAtUtc = Get-UtcTimestamp
                    stream        = $stream
                    text          = [string] $_
                }
                Write-CapturedLine -Stream $entry.stream -Text $entry.text
                if (Test-ReportableCodletOutput -Stream $entry.stream -Text $entry.text) {
                    $reportableOutput.Add($entry)
                } else {
                    $omittedOutputLineCount += 1
                }
                if ($entry.stream -eq 'stdout') {
                    if ($entry.text -cmatch '^launched-process-id: ([1-9][0-9]*)$') {
                        $launchedProcessId = [int] $Matches[1]
                    }
                    if ($entry.text -ceq 'runtime-state: active; holding inherited CDP pipes until the launched Codex exits') {
                        $activeLineSeen = $true
                        if ($null -eq $activeSnapshot) {
                            $activeSnapshot = Get-ActiveSnapshot -CodletExecutable $CodletExecutable -Fixture $Fixture
                        }
                    }
                    if ($entry.text -ceq 'runtime-state: stopped; CDP workers reaped') {
                        $stoppedLineSeen = $true
                    }
                }
            }
    } finally {
        $nativeExitCode = $global:LASTEXITCODE
        if ($null -eq $previousNativeExitCode) {
            Remove-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
        } else {
            $global:LASTEXITCODE = $previousNativeExitCode.Value
        }
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($null -eq $nativeExitCode) {
        throw 'Codlet did not start or did not return a native exit code.'
    }

    [pscustomobject][ordered]@{
        exitCode              = [int] $nativeExitCode
        output                = @($reportableOutput)
        omittedOutputLineCount = $omittedOutputLineCount
        activeSnapshot        = $activeSnapshot
        launchedProcessId      = $launchedProcessId
        activeLineSeen         = $activeLineSeen
        stoppedLineSeen        = $stoppedLineSeen
    }
}

try {
    $resolvedCodletPath = Resolve-CodletExecutable -Path $CodletPath
    $testFixture = Read-TestFixture -Path $InternalTestFixturePath
    $resolvedArtifactsDirectory = Resolve-ArtifactsDirectory -Path $ArtifactsDirectory
} catch {
    [Console]::Error.WriteLine("M0 acceptance validation failed: $($_.Exception.Message)")
    exit $validationExitCode
}

try {
    [void] (New-Item -ItemType Directory -Path $resolvedArtifactsDirectory -Force)
} catch {
    [Console]::Error.WriteLine("M0 acceptance could not create the report directory: $($_.Exception.Message)")
    exit $infrastructureExitCode
}

$startedAt = [DateTimeOffset]::UtcNow
$reportName = 'm0-acceptance-{0}-{1}.json' -f $startedAt.ToString('yyyyMMddTHHmmssfffZ'), $PID
$reportPath = Join-Path $resolvedArtifactsDirectory $reportName
$executionMode = if ($null -eq $testFixture) { 'real' } else { 'test' }
$beforeSnapshot = $null
$activeSnapshot = $null
$afterSnapshot = $null
$conflictingProcesses = @()
$codletInvoked = $false
$codletExitCode = $null
$launchedProcessId = $null
$activeLineSeen = $false
$stoppedLineSeen = $false
$commandOutput = @()
$omittedOutputLineCount = 0
$executionStatus = 'script_error'
$scriptExitCode = $infrastructureExitCode
$failureMessages = [Collections.Generic.List[string]]::new()

try {
    try {
        $beforeSnapshot = Get-AcceptanceSnapshot -CodletExecutable $resolvedCodletPath -Fixture $testFixture -Phase before
    } catch {
        $beforeSnapshot = New-FailedSnapshot -Message $_.Exception.Message
        throw "Preflight snapshot failed; Codlet was not started: $($_.Exception.Message)"
    }

    $conflictingProcesses = @(Get-ConflictingProcesses -Snapshot $beforeSnapshot)
    if ($conflictingProcesses.Count -gt 0) {
        $summary = ($conflictingProcesses | ForEach-Object { '{0} (PID {1})' -f $_.name, $_.processId }) -join ', '
        $message = "Preflight refused: existing ChatGPT/Codex process(es): $summary. No process was modified and Codlet was not started."
        [Console]::Error.WriteLine($message)
        $failureMessages.Add($message)
        $executionStatus = 'preflight_conflict'
        $scriptExitCode = 2
    } else {
        $codletInvoked = $true
        $commandResult = Invoke-CodletRuntime -CodletExecutable $resolvedCodletPath -Fixture $testFixture
        $codletExitCode = $commandResult.exitCode
        $commandOutput = @($commandResult.output)
        $omittedOutputLineCount = $commandResult.omittedOutputLineCount
        $activeSnapshot = $commandResult.activeSnapshot
        $launchedProcessId = $commandResult.launchedProcessId
        $activeLineSeen = $commandResult.activeLineSeen
        $stoppedLineSeen = $commandResult.stoppedLineSeen

        if ($null -ne $activeSnapshot -and -not [string]::IsNullOrWhiteSpace([string] $activeSnapshot.captureError)) {
            $message = "Active snapshot failed while Codlet remained attached: $($activeSnapshot.captureError)"
            $failureMessages.Add($message)
            $executionStatus = 'snapshot_failed'
            $scriptExitCode = $infrastructureExitCode
        } elseif ($codletExitCode -eq 0 -and $null -eq $activeSnapshot) {
            $message = 'Codlet returned success without emitting the active runtime protocol line; no active snapshot was captured.'
            $failureMessages.Add($message)
            $executionStatus = 'snapshot_failed'
            $scriptExitCode = $infrastructureExitCode
        } elseif ($codletExitCode -eq 0) {
            $executionStatus = 'codlet_completed'
            $scriptExitCode = 0
        } else {
            $message = "Codlet exited with code $codletExitCode."
            $failureMessages.Add($message)
            $executionStatus = 'codlet_failed'
            if ($codletExitCode -gt 0 -and $codletExitCode -le 255) {
                $scriptExitCode = $codletExitCode
            } else {
                $scriptExitCode = 1
            }
        }
    }
} catch {
    $failureMessages.Add($_.Exception.Message)
    [Console]::Error.WriteLine("M0 acceptance failed: $($_.Exception.Message)")
    $executionStatus = 'script_error'
    $scriptExitCode = $infrastructureExitCode
} finally {
    try {
        $afterSnapshot = Get-AcceptanceSnapshot -CodletExecutable $resolvedCodletPath -Fixture $testFixture -Phase after
    } catch {
        $afterSnapshot = New-FailedSnapshot -Message $_.Exception.Message
        $failureMessages.Add("Post-run snapshot failed: $($_.Exception.Message)")
        [Console]::Error.WriteLine("M0 acceptance post-run snapshot failed: $($_.Exception.Message)")
        $executionStatus = 'snapshot_failed'
        $scriptExitCode = $infrastructureExitCode
    }
}

if ($executionStatus -eq 'codlet_completed') {
    $evidenceFailures = [Collections.Generic.List[string]]::new()
    if ($null -eq $launchedProcessId) {
        $evidenceFailures.Add('Codlet returned success without a launched-process-id protocol line.')
    }
    if (-not $activeLineSeen) {
        $evidenceFailures.Add('Codlet returned success without the active runtime protocol line.')
    }
    if (-not $stoppedLineSeen) {
        $evidenceFailures.Add('Codlet returned success without the stopped/worker-reaped protocol line.')
    }

    if ($null -ne $launchedProcessId -and $null -ne $activeSnapshot) {
        $matchingActiveProcesses = @(
            $activeSnapshot.processes | Where-Object {
                [int] $_.processId -eq $launchedProcessId -and
                @('chatgpt.exe', 'codex.exe') -contains ([string] $_.name).ToLowerInvariant()
            }
        )
        if ($matchingActiveProcesses.Count -ne 1) {
            $evidenceFailures.Add("Active snapshot does not contain exactly one launched Codex process with PID $launchedProcessId.")
        }
    }

    if ($null -ne $afterSnapshot -and $null -eq $afterSnapshot.captureError) {
        $beforeProcessIds = @($beforeSnapshot.processes | ForEach-Object { [int] $_.processId })
        $codletName = [IO.Path]::GetFileName($resolvedCodletPath).ToLowerInvariant()
        $unexpectedAfterProcesses = @(
            $afterSnapshot.processes | Where-Object {
                $name = ([string] $_.name).ToLowerInvariant()
                $name -eq 'chatgpt.exe' -or
                $name -eq 'codex.exe' -or
                ($name -eq $codletName -and $beforeProcessIds -notcontains [int] $_.processId)
            }
        )
        if ($unexpectedAfterProcesses.Count -gt 0) {
            $summary = ($unexpectedAfterProcesses | ForEach-Object { '{0} (PID {1})' -f $_.name, $_.processId }) -join ', '
            $evidenceFailures.Add("Related process(es) remained after Codlet returned: $summary. No process was modified.")
        }
    }

    if ($evidenceFailures.Count -gt 0) {
        foreach ($message in $evidenceFailures) {
            $failureMessages.Add($message)
            [Console]::Error.WriteLine("M0 acceptance evidence failed: $message")
        }
        $executionStatus = 'evidence_failed'
        $scriptExitCode = $infrastructureExitCode
    }
}

$endedAt = [DateTimeOffset]::UtcNow
$manualChecks = @(
    [pscustomobject][ordered]@{
        id          = 'runtime_visible_and_usable'
        status      = 'pending_manual_confirmation'
        description = 'While Runtime Host was alive, the Codex window remained visible and usable.'
    },
    [pscustomobject][ordered]@{
        id          = 'user_closed_codex_normally'
        status      = 'pending_manual_confirmation'
        description = 'The user closed Codex normally before Runtime Host returned.'
    },
    [pscustomobject][ordered]@{
        id          = 'official_entry_zero_behavior'
        status      = 'pending_manual_confirmation'
        description = 'Launching Codex from the official entry produced no Codlet process, log, prompt, or UI change.'
    },
    [pscustomobject][ordered]@{
        id          = 'runtime_crash_contract'
        status      = 'pending_manual_confirmation'
        description = 'A forced Runtime Host crash caused its Codex child to exit via the pipe-disconnect contract without an orphan.'
    }
)

$report = [pscustomobject][ordered]@{
    schema           = 'codlet.m0-acceptance/v1'
    executionMode    = $executionMode
    startedAtUtc     = $startedAt.ToString('o')
    endedAtUtc       = $endedAt.ToString('o')
    codlet           = [pscustomobject][ordered]@{
        executablePath = $resolvedCodletPath
        arguments      = @('m0-runtime', '--launch-codex')
        invoked        = $codletInvoked
        exitCode       = $codletExitCode
        outputPolicy   = 'allowlisted-m0-stdout-v1'
        output         = @($commandOutput)
        omittedOutputLineCount = $omittedOutputLineCount
        protocol       = [pscustomobject][ordered]@{
            launchedProcessId = $launchedProcessId
            activeLineSeen    = $activeLineSeen
            stoppedLineSeen   = $stoppedLineSeen
        }
    }
    preflight        = [pscustomobject][ordered]@{
        conflictDetected    = $conflictingProcesses.Count -gt 0
        conflictingProcesses = @($conflictingProcesses)
    }
    snapshots        = [pscustomobject][ordered]@{
        before = $beforeSnapshot
        active = $activeSnapshot
        after  = $afterSnapshot
    }
    manualChecks     = $manualChecks
    result           = [pscustomobject][ordered]@{
        executionStatus = $executionStatus
        scriptExitCode  = $scriptExitCode
        m0Decision      = 'not_determined'
        messages        = @($failureMessages)
    }
}

try {
    $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding UTF8
} catch {
    [Console]::Error.WriteLine("M0 acceptance could not write its report: $($_.Exception.Message)")
    exit $infrastructureExitCode
}

[Console]::Out.WriteLine("M0 acceptance report: $reportPath")
[Console]::Out.WriteLine('M0 decision remains not determined; all manual checks are still pending confirmation.')
exit $scriptExitCode
