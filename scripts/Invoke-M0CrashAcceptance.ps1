[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $CodletPath,

    [switch] $ConfirmRuntimeCrash,

    [string] $ArtifactsDirectory,

    [string] $InternalTestFixturePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $PSBoundParameters.ContainsKey('ArtifactsDirectory')) {
    $ArtifactsDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) '.codlet-artifacts\m0-crash-acceptance'
}

$validationExitCode = 64
$infrastructureExitCode = 70
$contractFailureExitCode = 1
$startupDeadline = [TimeSpan]::FromSeconds(45)
$processExitDeadline = [TimeSpan]::FromSeconds(15)
$outputDrainDeadline = [TimeSpan]::FromSeconds(5)

function Get-UtcTimestamp {
    [DateTimeOffset]::UtcNow.ToString('o')
}

function ConvertTo-UtcTimestamp {
    param(
        [object] $Value,
        [string] $ErrorMessage
    )

    if ($Value -is [DateTimeOffset]) {
        return ([DateTimeOffset] $Value).ToUniversalTime().ToString('o')
    }
    if ($Value -is [DateTime]) {
        return ([DateTimeOffset] ([DateTime] $Value)).ToUniversalTime().ToString('o')
    }
    $parsed = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse([string] $Value, [ref] $parsed)) {
        throw $ErrorMessage
    }
    $parsed.ToUniversalTime().ToString('o')
}

function ConvertTo-NormalizedPath {
    param([string] $Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw 'A process executable path is unavailable.'
    }

    $candidate = $Path
    if ($candidate.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) {
        $candidate = '\\' + $candidate.Substring(8)
    } elseif ($candidate.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) {
        $candidate = $candidate.Substring(4)
    }
    [IO.Path]::GetFullPath($candidate)
}

function Test-PathEqual {
    param(
        [string] $Left,
        [string] $Right
    )

    $normalizedLeft = ConvertTo-NormalizedPath -Path $Left
    $normalizedRight = ConvertTo-NormalizedPath -Path $Right
    $normalizedLeft.Equals($normalizedRight, [StringComparison]::OrdinalIgnoreCase)
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
    if ($env:CODLET_M0_CRASH_ACCEPTANCE_TEST_MODE -ne '1') {
        throw 'InternalTestFixturePath is available only when CODLET_M0_CRASH_ACCEPTANCE_TEST_MODE=1.'
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Internal test fixture does not exist: $Path"
    }

    $fixture = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ([int] $fixture.schemaVersion -ne 1) {
        throw 'Internal test fixture schemaVersion must be 1.'
    }
    foreach ($property in @('snapshots', 'output', 'runtimeHostIdentity', 'codexChildIdentity', 'outcome')) {
        if ($fixture.PSObject.Properties.Name -notcontains $property) {
            throw "Internal test fixture must contain $property."
        }
    }
    foreach ($phase in @('before', 'active', 'after')) {
        if ($fixture.snapshots.PSObject.Properties.Name -notcontains $phase) {
            throw "Internal test fixture must contain a $phase snapshot."
        }
    }
    if (-not ($fixture.output -is [Array])) {
        throw 'Internal test fixture output must be an array.'
    }
    $fixture
}

function ConvertTo-ProcessRecord {
    param([object] $Process)

    if ([string]::IsNullOrWhiteSpace([string] $Process.name)) {
        throw 'A process record must contain a name.'
    }
    [void] (ConvertTo-NormalizedPath -Path ([string] $Process.executablePath))
    [pscustomobject][ordered]@{
        processId       = [int] $Process.processId
        parentProcessId = [int] $Process.parentProcessId
        name            = [string] $Process.name
        executablePath  = [string] $Process.executablePath
        startedAtUtc    = ConvertTo-UtcTimestamp -Value $Process.startedAtUtc -ErrorMessage 'A process record must contain an ISO-8601 startedAtUtc value.'
    }
}

function ConvertTo-ValidatedSnapshot {
    param([object] $Snapshot)

    if (-not ($Snapshot.processes -is [Array])) {
        throw 'Each crash acceptance snapshot must contain a processes array.'
    }
    [pscustomobject][ordered]@{
        capturedAtUtc = ConvertTo-UtcTimestamp -Value $Snapshot.capturedAtUtc -ErrorMessage 'Each crash acceptance snapshot must contain an ISO-8601 capturedAtUtc value.'
        processes     = @($Snapshot.processes | ForEach-Object { ConvertTo-ProcessRecord -Process $_ } | Sort-Object processId)
        captureError  = $null
    }
}

function Get-RelatedProcessSnapshot {
    param([string] $CodletExecutable)

    $codletName = [IO.Path]::GetFileName($CodletExecutable).ToLowerInvariant()
    $relatedNames = @('chatgpt.exe', 'codex.exe', $codletName) | Select-Object -Unique
    $processes = @(
        Get-CimInstance -ClassName Win32_Process -ErrorAction Stop |
            Where-Object { $relatedNames -contains ([string] $_.Name).ToLowerInvariant() } |
            ForEach-Object {
                if ($null -eq $_.CreationDate -or [string]::IsNullOrWhiteSpace([string] $_.ExecutablePath)) {
                    throw "Could not establish the identity of process $($_.ProcessId)."
                }
                [pscustomobject][ordered]@{
                    processId       = [int] $_.ProcessId
                    parentProcessId = [int] $_.ParentProcessId
                    name            = [string] $_.Name
                    executablePath  = [string] $_.ExecutablePath
                    startedAtUtc    = ([DateTime] $_.CreationDate).ToUniversalTime().ToString('o')
                }
            } |
            Sort-Object processId
    )

    [pscustomobject][ordered]@{
        capturedAtUtc = Get-UtcTimestamp
        processes     = $processes
        captureError  = $null
    }
}

function Get-ProcessIdentity {
    param([int] $ProcessId)

    $matches = @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop)
    if ($matches.Count -ne 1) {
        throw "Process $ProcessId is not running."
    }
    $process = $matches[0]
    if ($null -eq $process.CreationDate -or [string]::IsNullOrWhiteSpace([string] $process.ExecutablePath)) {
        throw "Could not establish the identity of process $ProcessId."
    }
    [pscustomobject][ordered]@{
        processId       = [int] $process.ProcessId
        parentProcessId = [int] $process.ParentProcessId
        name            = [string] $process.Name
        executablePath  = [string] $process.ExecutablePath
        startedAtUtc    = ([DateTime] $process.CreationDate).ToUniversalTime().ToString('o')
    }
}

function Get-SnapshotProcess {
    param(
        [object] $Snapshot,
        [int] $ProcessId,
        [string] $Label
    )

    $matches = @($Snapshot.processes | Where-Object { [int] $_.processId -eq $ProcessId })
    if ($matches.Count -ne 1) {
        throw "$Label PID $ProcessId is not represented exactly once in the active snapshot."
    }
    $matches[0]
}

function Assert-SameProcessIdentity {
    param(
        [object] $Expected,
        [object] $Actual,
        [string] $Label
    )

    if ([int] $Expected.processId -ne [int] $Actual.processId -or
        [int] $Expected.parentProcessId -ne [int] $Actual.parentProcessId -or
        -not ([string] $Expected.name).Equals([string] $Actual.name, [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-PathEqual -Left ([string] $Expected.executablePath) -Right ([string] $Actual.executablePath)) -or
        -not ([string] $Expected.startedAtUtc).Equals([string] $Actual.startedAtUtc, [StringComparison]::Ordinal)) {
        throw "$Label process identity changed; refusing to act on PID $($Expected.processId)."
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

function New-OutputCapture {
    [pscustomobject]@{
        reportableOutput       = [Collections.Generic.List[object]]::new()
        omittedOutputLineCount = 0
        launchedProcessId      = $null
        codexExecutablePath    = $null
        activeLineSeen         = $false
        stoppedLineSeen        = $false
    }
}

function Add-CapturedOutput {
    param(
        [object] $Capture,
        [object] $Entry
    )

    if ($Entry.stream -eq 'stderr') {
        [Console]::Error.WriteLine($Entry.text)
    } else {
        [Console]::Out.WriteLine($Entry.text)
    }
    if (Test-ReportableCodletOutput -Stream $Entry.stream -Text $Entry.text) {
        $Capture.reportableOutput.Add($Entry)
    } else {
        $Capture.omittedOutputLineCount += 1
    }
    if ($Entry.stream -eq 'stdout') {
        if ($Entry.text -cmatch '^launched-process-id: ([1-9][0-9]*)$') {
            $Capture.launchedProcessId = [int] $Matches[1]
        }
        if ($Entry.text -cmatch '^executable: (.+)$') {
            $Capture.codexExecutablePath = [string] $Matches[1]
        }
        if ($Entry.text -ceq 'runtime-state: active; holding inherited CDP pipes until the launched Codex exits') {
            $Capture.activeLineSeen = $true
        }
        if ($Entry.text -ceq 'runtime-state: stopped; CDP workers reaped') {
            $Capture.stoppedLineSeen = $true
        }
    }
}

function Start-CodletRuntime {
    param([string] $Executable)

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Executable
    $startInfo.Arguments = 'm0-runtime --launch-codex'
    $startInfo.WorkingDirectory = Split-Path -Parent $Executable
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw 'The Runtime Host process did not start.'
    }
    [void] $process.Handle

    [pscustomobject]@{
        process = $process
        output  = [pscustomobject]@{
            stdoutReader = $process.StandardOutput
            stderrReader = $process.StandardError
            stdoutTask   = $process.StandardOutput.ReadLineAsync()
            stderrTask   = $process.StandardError.ReadLineAsync()
            stdoutClosed = $false
            stderrClosed = $false
        }
    }
}

function Read-ReadyProcessOutput {
    param([object] $State)

    $entries = [Collections.Generic.List[object]]::new()
    foreach ($stream in @('stdout', 'stderr')) {
        $linesRead = 0
        $taskProperty = "${stream}Task"
        $readerProperty = "${stream}Reader"
        $closedProperty = "${stream}Closed"
        while (-not $State.$closedProperty -and $State.$taskProperty.IsCompleted -and $linesRead -lt 128) {
            $line = $State.$taskProperty.Result
            if ($null -eq $line) {
                $State.$closedProperty = $true
            } else {
                $entries.Add([pscustomobject][ordered]@{
                    capturedAtUtc = Get-UtcTimestamp
                    stream        = $stream
                    text          = [string] $line
                })
                $State.$taskProperty = $State.$readerProperty.ReadLineAsync()
            }
            $linesRead += 1
        }
    }
    @($entries)
}

function Drain-ReadyProcessOutput {
    param(
        [object] $State,
        [object] $Capture
    )

    foreach ($entry in @(Read-ReadyProcessOutput -State $State)) {
        Add-CapturedOutput -Capture $Capture -Entry $entry
    }
}

function Wait-ForOutputClosure {
    param(
        [object] $State,
        [object] $Capture,
        [TimeSpan] $Timeout
    )

    $deadline = [DateTimeOffset]::UtcNow + $Timeout
    while (-not $State.stdoutClosed -or -not $State.stderrClosed) {
        Drain-ReadyProcessOutput -State $State -Capture $Capture
        if ([DateTimeOffset]::UtcNow -ge $deadline) {
            return $false
        }
        Start-Sleep -Milliseconds 25
    }
    $true
}

function Wait-ForNoRelatedProcesses {
    param(
        [string] $CodletExecutable,
        [DateTimeOffset] $Deadline
    )

    do {
        $snapshot = Get-RelatedProcessSnapshot -CodletExecutable $CodletExecutable
        if ($snapshot.processes.Count -eq 0 -or [DateTimeOffset]::UtcNow -ge $Deadline) {
            return $snapshot
        }
        Start-Sleep -Milliseconds 100
    } while ($true)
}

if (-not $ConfirmRuntimeCrash.IsPresent) {
    [Console]::Error.WriteLine('M0 crash acceptance validation failed: -ConfirmRuntimeCrash is required because this test force-terminates only the Runtime Host that it starts.')
    exit $validationExitCode
}

try {
    $resolvedCodletPath = Resolve-CodletExecutable -Path $CodletPath
    $resolvedArtifactsDirectory = Resolve-ArtifactsDirectory -Path $ArtifactsDirectory
    $testFixture = Read-TestFixture -Path $InternalTestFixturePath
} catch {
    [Console]::Error.WriteLine("M0 crash acceptance validation failed: $($_.Exception.Message)")
    exit $validationExitCode
}

try {
    [void] (New-Item -ItemType Directory -Path $resolvedArtifactsDirectory -Force)
} catch {
    [Console]::Error.WriteLine("M0 crash acceptance could not create the report directory: $($_.Exception.Message)")
    exit $infrastructureExitCode
}

$startedAt = [DateTimeOffset]::UtcNow
$reportName = 'm0-crash-acceptance-{0}-{1}.json' -f $startedAt.ToString('yyyyMMddTHHmmssfffZ'), $PID
$reportPath = Join-Path $resolvedArtifactsDirectory $reportName
$executionMode = if ($null -eq $testFixture) { 'real' } else { 'test' }
$capture = New-OutputCapture
$beforeSnapshot = $null
$activeSnapshot = $null
$afterSnapshot = $null
$conflictingProcesses = @()
$runtimeProcess = $null
$runtimeOutputState = $null
$codexProcess = $null
$runtimeIdentity = $null
$codexIdentity = $null
$runtimeTerminationRequested = $false
$runtimeAliveAtCrashRequest = $false
$codexAliveAtCrashRequest = $false
$crashRequestedAtUtc = $null
$runtimeExitObserved = $false
$runtimeExitCode = $null
$runtimeExitedAtUtc = $null
$codexExitObserved = $false
$codexExitCode = $null
$codexExitedAtUtc = $null
$executionStatus = 'running'
$scriptExitCode = $infrastructureExitCode
$crashContractDecision = 'not_tested'
$failureMessages = [Collections.Generic.List[string]]::new()

try {
    if ($null -eq $testFixture) {
        $beforeSnapshot = Get-RelatedProcessSnapshot -CodletExecutable $resolvedCodletPath
    } else {
        $beforeSnapshot = ConvertTo-ValidatedSnapshot -Snapshot $testFixture.snapshots.before
    }
    $conflictingProcesses = @($beforeSnapshot.processes)
    if ($conflictingProcesses.Count -gt 0) {
        $summary = ($conflictingProcesses | ForEach-Object { '{0} (PID {1})' -f $_.name, $_.processId }) -join ', '
        $message = "Preflight refused: existing related process(es): $summary. No process was modified and Codlet was not started."
        [Console]::Error.WriteLine($message)
        $failureMessages.Add($message)
        $executionStatus = 'preflight_conflict'
        $scriptExitCode = 2
    } elseif ($null -ne $testFixture) {
        foreach ($source in @($testFixture.output)) {
            $stream = [string] $source.stream
            if ($stream -ne 'stdout' -and $stream -ne 'stderr') {
                throw "Internal test fixture output has an invalid stream: $stream"
            }
            Add-CapturedOutput -Capture $capture -Entry ([pscustomobject][ordered]@{
                capturedAtUtc = Get-UtcTimestamp
                stream        = $stream
                text          = [string] $source.text
            })
        }
        $activeSnapshot = ConvertTo-ValidatedSnapshot -Snapshot $testFixture.snapshots.active
        $afterSnapshot = ConvertTo-ValidatedSnapshot -Snapshot $testFixture.snapshots.after
        $runtimeIdentity = ConvertTo-ProcessRecord -Process $testFixture.runtimeHostIdentity
        $codexIdentity = ConvertTo-ProcessRecord -Process $testFixture.codexChildIdentity
        $activeRuntime = Get-SnapshotProcess -Snapshot $activeSnapshot -ProcessId $runtimeIdentity.processId -Label 'Runtime Host'
        Assert-SameProcessIdentity -Expected $runtimeIdentity -Actual $activeRuntime -Label 'Runtime Host'
        $activeCodex = Get-SnapshotProcess -Snapshot $activeSnapshot -ProcessId $codexIdentity.processId -Label 'Codex child'
        Assert-SameProcessIdentity -Expected $codexIdentity -Actual $activeCodex -Label 'Codex child'
        if ([int] $codexIdentity.parentProcessId -ne [int] $runtimeIdentity.processId) {
            throw 'The fixture Codex process is not a direct child of the Runtime Host.'
        }
        if ($null -eq $capture.launchedProcessId -or [int] $capture.launchedProcessId -ne [int] $codexIdentity.processId) {
            throw 'The fixture protocol does not identify the captured Codex process.'
        }
        if ([string]::IsNullOrWhiteSpace([string] $capture.codexExecutablePath) -or
            -not (Test-PathEqual -Left $codexIdentity.executablePath -Right $capture.codexExecutablePath)) {
            throw 'The fixture protocol executable does not identify the captured Codex process.'
        }
        $runtimeTerminationRequested = [bool] $testFixture.outcome.runtimeTerminationRequested
        $crashRequestedAtUtc = ConvertTo-UtcTimestamp -Value $testFixture.outcome.crashRequestedAtUtc -ErrorMessage 'The fixture outcome must contain an ISO-8601 crashRequestedAtUtc value.'
        $runtimeAliveAtCrashRequest = [bool] $testFixture.outcome.runtimeAliveAtCrashRequest
        $codexAliveAtCrashRequest = [bool] $testFixture.outcome.codexAliveAtCrashRequest
        $runtimeExitObserved = [bool] $testFixture.outcome.runtimeExitObserved
        $runtimeExitCode = [int] $testFixture.outcome.runtimeExitCode
        $runtimeExitedAtUtc = ConvertTo-UtcTimestamp -Value $testFixture.outcome.runtimeExitedAtUtc -ErrorMessage 'The fixture outcome must contain an ISO-8601 runtimeExitedAtUtc value.'
        $codexExitObserved = [bool] $testFixture.outcome.codexExitObserved
        $codexExitCode = [int] $testFixture.outcome.codexExitCode
        $codexExitedAtUtc = ConvertTo-UtcTimestamp -Value $testFixture.outcome.codexExitedAtUtc -ErrorMessage 'The fixture outcome must contain an ISO-8601 codexExitedAtUtc value.'
    } else {
        $runtime = Start-CodletRuntime -Executable $resolvedCodletPath
        $runtimeProcess = $runtime.process
        $runtimeOutputState = $runtime.output
        $runtimeIdentity = Get-ProcessIdentity -ProcessId $runtimeProcess.Id
        if (-not (Test-PathEqual -Left $runtimeIdentity.executablePath -Right $resolvedCodletPath)) {
            throw 'The started Runtime Host executable path does not match CodletPath.'
        }

        $deadline = [DateTimeOffset]::UtcNow + $startupDeadline
        while (-not $capture.activeLineSeen) {
            Drain-ReadyProcessOutput -State $runtimeOutputState -Capture $capture
            if ($runtimeProcess.HasExited) {
                [void] (Wait-ForOutputClosure -State $runtimeOutputState -Capture $capture -Timeout $outputDrainDeadline)
                throw "The Runtime Host exited before entering the active state with code $($runtimeProcess.ExitCode)."
            }
            if ([DateTimeOffset]::UtcNow -ge $deadline) {
                throw 'The Runtime Host did not enter the active state within 45 seconds.'
            }
            Start-Sleep -Milliseconds 25
        }
        if ($null -eq $capture.launchedProcessId -or [string]::IsNullOrWhiteSpace([string] $capture.codexExecutablePath)) {
            throw 'The active protocol did not identify the launched Codex process and executable.'
        }

        $activeSnapshot = Get-RelatedProcessSnapshot -CodletExecutable $resolvedCodletPath
        $activeRuntime = Get-SnapshotProcess -Snapshot $activeSnapshot -ProcessId $runtimeIdentity.processId -Label 'Runtime Host'
        Assert-SameProcessIdentity -Expected $runtimeIdentity -Actual $activeRuntime -Label 'Runtime Host'
        $codexIdentity = Get-SnapshotProcess -Snapshot $activeSnapshot -ProcessId $capture.launchedProcessId -Label 'Codex child'
        if ([int] $codexIdentity.parentProcessId -ne [int] $runtimeIdentity.processId) {
            throw "The launched Codex PID $($codexIdentity.processId) is not a direct child of Runtime Host PID $($runtimeIdentity.processId)."
        }
        if (-not (Test-PathEqual -Left $codexIdentity.executablePath -Right $capture.codexExecutablePath)) {
            throw 'The launched Codex executable does not match the runtime protocol.'
        }

        $codexProcess = Get-Process -Id $codexIdentity.processId -ErrorAction Stop
        [void] $codexProcess.Handle
        Assert-SameProcessIdentity -Expected $runtimeIdentity -Actual (Get-ProcessIdentity -ProcessId $runtimeIdentity.processId) -Label 'Runtime Host'
        Assert-SameProcessIdentity -Expected $codexIdentity -Actual (Get-ProcessIdentity -ProcessId $codexIdentity.processId) -Label 'Codex child'

        $crashRequestedAt = [DateTimeOffset]::UtcNow
        $crashRequestedAtUtc = $crashRequestedAt.ToString('o')
        if ($runtimeProcess.HasExited) {
            throw 'The Runtime Host exited before the force-termination action.'
        }
        if ($codexProcess.HasExited) {
            throw 'The Codex child exited before the force-termination action.'
        }
        $runtimeAliveAtCrashRequest = $true
        $codexAliveAtCrashRequest = $true
        $runtimeTerminationRequested = $true
        $runtimeProcess.Kill()
        $runtimeExitObserved = $runtimeProcess.WaitForExit([int] $outputDrainDeadline.TotalMilliseconds)
        if (-not $runtimeExitObserved) {
            throw 'The force-terminated Runtime Host did not exit within 5 seconds.'
        }
        $runtimeExitCode = $runtimeProcess.ExitCode
        $runtimeExitedAtUtc = ([DateTimeOffset] $runtimeProcess.ExitTime).ToUniversalTime().ToString('o')
        if (-not (Wait-ForOutputClosure -State $runtimeOutputState -Capture $capture -Timeout $outputDrainDeadline)) {
            throw 'Runtime Host output streams did not close within 5 seconds.'
        }

        $postCrashDeadline = $crashRequestedAt + $processExitDeadline
        $remainingMilliseconds = [Math]::Max(0, [Math]::Ceiling(($postCrashDeadline - [DateTimeOffset]::UtcNow).TotalMilliseconds))
        $codexExitObserved = $codexProcess.WaitForExit([int] $remainingMilliseconds)
        if ($codexExitObserved) {
            $codexExitCode = $codexProcess.ExitCode
            $codexExitedAtUtc = ([DateTimeOffset] $codexProcess.ExitTime).ToUniversalTime().ToString('o')
        }
        $afterSnapshot = Wait-ForNoRelatedProcesses -CodletExecutable $resolvedCodletPath -Deadline $postCrashDeadline
    }
} catch {
    $failureMessages.Add($_.Exception.Message)
    [Console]::Error.WriteLine("M0 crash acceptance failed: $($_.Exception.Message)")
    $executionStatus = 'script_error'
    $scriptExitCode = $infrastructureExitCode
} finally {
    if ($null -ne $runtimeProcess -and -not $runtimeProcess.HasExited) {
        try {
            if ($null -eq $crashRequestedAtUtc) {
                $crashRequestedAtUtc = Get-UtcTimestamp
            }
            $runtimeAliveAtCrashRequest = $true
            $runtimeTerminationRequested = $true
            $runtimeProcess.Kill()
            $runtimeExitObserved = $runtimeProcess.WaitForExit([int] $outputDrainDeadline.TotalMilliseconds)
            if ($runtimeExitObserved) {
                $runtimeExitCode = $runtimeProcess.ExitCode
                $runtimeExitedAtUtc = ([DateTimeOffset] $runtimeProcess.ExitTime).ToUniversalTime().ToString('o')
            }
        } catch {
            $failureMessages.Add("Runtime Host cleanup failed: $($_.Exception.Message)")
        }
    }
    if ($null -ne $runtimeOutputState) {
        try {
            [void] (Wait-ForOutputClosure -State $runtimeOutputState -Capture $capture -Timeout $outputDrainDeadline)
        } catch {
            $failureMessages.Add("Runtime Host output cleanup failed: $($_.Exception.Message)")
        }
    }
    if ($null -eq $afterSnapshot -and $null -ne $beforeSnapshot) {
        try {
            if ($null -eq $testFixture) {
                $afterSnapshot = Wait-ForNoRelatedProcesses -CodletExecutable $resolvedCodletPath -Deadline ([DateTimeOffset]::UtcNow + $processExitDeadline)
            } else {
                $afterSnapshot = ConvertTo-ValidatedSnapshot -Snapshot $testFixture.snapshots.after
            }
        } catch {
            $failureMessages.Add("Post-crash snapshot failed: $($_.Exception.Message)")
        }
    }
    if ($null -ne $codexProcess) {
        $codexProcess.Dispose()
    }
    if ($null -ne $runtimeProcess) {
        $runtimeProcess.Dispose()
    }
}

if ($executionStatus -eq 'running') {
    $evidenceFailures = [Collections.Generic.List[string]]::new()
    if (-not $capture.activeLineSeen) {
        $evidenceFailures.Add('The Runtime Host did not emit the active protocol line.')
    }
    if ($null -eq $capture.launchedProcessId) {
        $evidenceFailures.Add('The Runtime Host did not report a launched Codex PID.')
    }
    if ($null -eq $runtimeIdentity -or $null -eq $codexIdentity -or $null -eq $activeSnapshot) {
        $evidenceFailures.Add('The Runtime Host and Codex child identities were not captured before termination.')
    } else {
        try {
            $activeRuntime = Get-SnapshotProcess -Snapshot $activeSnapshot -ProcessId $runtimeIdentity.processId -Label 'Runtime Host'
            Assert-SameProcessIdentity -Expected $runtimeIdentity -Actual $activeRuntime -Label 'Runtime Host'
            $activeCodex = Get-SnapshotProcess -Snapshot $activeSnapshot -ProcessId $codexIdentity.processId -Label 'Codex child'
            Assert-SameProcessIdentity -Expected $codexIdentity -Actual $activeCodex -Label 'Codex child'
            if ([int] $codexIdentity.parentProcessId -ne [int] $runtimeIdentity.processId) {
                $evidenceFailures.Add('The captured Codex process was not a direct child of the Runtime Host.')
            }
            if ($null -ne $capture.codexExecutablePath -and -not (Test-PathEqual -Left $codexIdentity.executablePath -Right $capture.codexExecutablePath)) {
                $evidenceFailures.Add('The captured Codex process path did not match the runtime protocol.')
            }
        } catch {
            $evidenceFailures.Add($_.Exception.Message)
        }
    }
    if (-not $runtimeTerminationRequested -or [string]::IsNullOrWhiteSpace([string] $crashRequestedAtUtc)) {
        $evidenceFailures.Add('The Runtime Host force-termination action was not recorded.')
    }
    if (-not $runtimeAliveAtCrashRequest) {
        $evidenceFailures.Add('The Runtime Host was not observed alive at the force-termination action.')
    }
    if (-not $codexAliveAtCrashRequest) {
        $evidenceFailures.Add('The exact Codex child was not observed alive at the force-termination action.')
    }
    if (-not $runtimeExitObserved) {
        $evidenceFailures.Add('The Runtime Host exit was not observed after force termination.')
    }
    if (-not $codexExitObserved) {
        $evidenceFailures.Add('The exact launched Codex process did not exit within 15 seconds of Runtime Host termination.')
    }
    if ($capture.stoppedLineSeen) {
        $evidenceFailures.Add('The Runtime Host emitted the normal stopped protocol line; this was not a forced-crash path.')
    }
    if ($runtimeExitObserved -and $codexExitObserved) {
        if ([string]::IsNullOrWhiteSpace([string] $runtimeExitedAtUtc) -or [string]::IsNullOrWhiteSpace([string] $codexExitedAtUtc)) {
            $evidenceFailures.Add('The Runtime Host and Codex exit timestamps were not both captured.')
        } else {
            $crashTime = [DateTimeOffset]::Parse($crashRequestedAtUtc)
            $runtimeExitTime = [DateTimeOffset]::Parse($runtimeExitedAtUtc)
            $codexExitTime = [DateTimeOffset]::Parse($codexExitedAtUtc)
            if ($runtimeExitTime -lt $crashTime) {
                $evidenceFailures.Add('The Runtime Host exited before the recorded force-termination action.')
            }
            if ($codexExitTime -lt $runtimeExitTime) {
                $evidenceFailures.Add('The Codex child exited before the Runtime Host; pipe-disconnect causality was not established.')
            }
        }
    }
    if ($null -eq $afterSnapshot) {
        $evidenceFailures.Add('No post-crash process snapshot was captured.')
    } elseif ($afterSnapshot.processes.Count -gt 0) {
        $summary = ($afterSnapshot.processes | ForEach-Object { '{0} (PID {1})' -f $_.name, $_.processId }) -join ', '
        $evidenceFailures.Add("Related process(es) remained after the crash deadline: $summary. No Codex process was terminated by the harness.")
    }

    if ($evidenceFailures.Count -eq 0) {
        $executionStatus = 'crash_contract_passed'
        $scriptExitCode = 0
        $crashContractDecision = 'passed'
    } else {
        foreach ($message in $evidenceFailures) {
            $failureMessages.Add($message)
            [Console]::Error.WriteLine("M0 crash acceptance evidence failed: $message")
        }
        $executionStatus = 'crash_contract_failed'
        $scriptExitCode = $contractFailureExitCode
        $crashContractDecision = 'failed'
    }
}

$endedAt = [DateTimeOffset]::UtcNow
$report = [pscustomobject][ordered]@{
    schema        = 'codlet.m0-crash-acceptance/v1'
    executionMode = $executionMode
    startedAtUtc  = $startedAt.ToString('o')
    endedAtUtc    = $endedAt.ToString('o')
    runtimeHost   = [pscustomobject][ordered]@{
        executablePath      = $resolvedCodletPath
        arguments           = @('m0-runtime', '--launch-codex')
        identity            = $runtimeIdentity
        terminationMethod   = 'System.Diagnostics.Process.Kill (Runtime Host only)'
        terminationRequested = $runtimeTerminationRequested
        aliveAtCrashRequest = $runtimeAliveAtCrashRequest
        crashRequestedAtUtc = $crashRequestedAtUtc
        exitObserved        = $runtimeExitObserved
        exitCode            = $runtimeExitCode
        exitedAtUtc         = $runtimeExitedAtUtc
    }
    codexChild    = [pscustomobject][ordered]@{
        identity             = $codexIdentity
        terminationRequested = $false
        aliveAtCrashRequest  = $codexAliveAtCrashRequest
        exitObserved         = $codexExitObserved
        exitCode             = $codexExitCode
        exitedAtUtc          = $codexExitedAtUtc
    }
    protocol      = [pscustomobject][ordered]@{
        launchedProcessId      = $capture.launchedProcessId
        codexExecutablePath    = $capture.codexExecutablePath
        activeLineSeen         = $capture.activeLineSeen
        normalStoppedLineSeen  = $capture.stoppedLineSeen
        outputPolicy           = 'allowlisted-m0-stdout-v1'
        output                 = @($capture.reportableOutput)
        omittedOutputLineCount = $capture.omittedOutputLineCount
    }
    preflight     = [pscustomobject][ordered]@{
        conflictDetected     = $conflictingProcesses.Count -gt 0
        conflictingProcesses = @($conflictingProcesses)
    }
    snapshots     = [pscustomobject][ordered]@{
        before = $beforeSnapshot
        active = $activeSnapshot
        after  = $afterSnapshot
    }
    result        = [pscustomobject][ordered]@{
        executionStatus      = $executionStatus
        scriptExitCode       = $scriptExitCode
        crashContractDecision = $crashContractDecision
        m0Decision           = 'not_determined'
        messages             = @($failureMessages)
    }
}

try {
    $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding UTF8
} catch {
    [Console]::Error.WriteLine("M0 crash acceptance could not write its report: $($_.Exception.Message)")
    exit $infrastructureExitCode
}

[Console]::Out.WriteLine("M0 crash acceptance report: $reportPath")
if ($crashContractDecision -eq 'passed') {
    [Console]::Out.WriteLine('Crash contract passed: only the Runtime Host was force-terminated; the exact Codex child exited and no related process remained.')
} else {
    [Console]::Out.WriteLine('M0 remains not determined; inspect the crash acceptance report before continuing.')
}
exit $scriptExitCode
