[CmdletBinding()]
param(
    [switch]$RecoverInterrupted,
    [ValidateRange(20, 60)][int]$StartupTimeoutSeconds = 60
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Read-CodletSharedText([string]$Path, [int]$MaximumBytes = 262144, [switch]$Tail) {
    if (-not [IO.File]::Exists($Path)) { return $null }
    $stream = $null
    $reader = $null
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        if ($stream.Length -gt $MaximumBytes) {
            if (-not $Tail) { return $null }
            $null = $stream.Seek(-$MaximumBytes, [IO.SeekOrigin]::End)
        }
        $reader = New-Object IO.StreamReader($stream, (New-Object Text.UTF8Encoding($false)))
        return $reader.ReadToEnd()
    } catch { return $null }
    finally {
        if ($null -ne $reader) { $reader.Dispose() }
        elseif ($null -ne $stream) { $stream.Dispose() }
    }
}

function Read-CodletState([string]$Path) {
    $text = Read-CodletSharedText $Path
    if (-not $text) { return $null }
    try { return ($text | ConvertFrom-Json) } catch { return $null }
}

function Test-CodletStateOwner($State, [int]$ManagerId, [DateTime]$Created, [string]$LabRoot) {
    try {
        if ($null -eq $State -or $State.schema -ne 1 -or [int]$State.managerPid -ne $ManagerId) { return $false }
        $stateCreated = [DateTime]::Parse($State.managerCreated, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
        if ($stateCreated.Ticks -ne $Created.ToUniversalTime().Ticks) { return $false }
        if (-not [string]::Equals([IO.Path]::GetFullPath($State.labRoot), $LabRoot, [StringComparison]::OrdinalIgnoreCase)) { return $false }
        if ($State.runId -notmatch ('^\d+-' + $ManagerId + '$')) { return $false }
        $expectedLogs = Join-Path (Join-Path $LabRoot 'logs') ('coordinator-' + $State.runId)
        return [string]::Equals([IO.Path]::GetFullPath($State.logs), [IO.Path]::GetFullPath($expectedLogs), [StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}

function Find-CodletOwnedState([string]$LabRoot, [int]$ManagerId, [DateTime]$Created, [string]$KnownPath) {
    if ($KnownPath) {
        $state = Read-CodletState $KnownPath
        if (Test-CodletStateOwner $state $ManagerId $Created $LabRoot) { return $state }
        return $null
    }
    $logRoot = Join-Path $LabRoot 'logs'
    $state = Read-CodletState (Join-Path $logRoot 'manual-client.json')
    if (Test-CodletStateOwner $state $ManagerId $Created $LabRoot) { return $state }
    if (-not [IO.Directory]::Exists($logRoot)) { return $null }
    # Preparing and early failures are recorded here before manual-client.json is published.
    $recent = Get-ChildItem -LiteralPath $logRoot -Directory -Filter 'coordinator-*' -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTimeUtc -ge $Created.ToUniversalTime().AddSeconds(-2) } |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 16
    foreach ($entry in $recent) {
        $state = Read-CodletState (Join-Path $entry.FullName 'state.json')
        if (Test-CodletStateOwner $state $ManagerId $Created $LabRoot) { return $state }
    }
    return $null
}

function Show-CodletFailure([string]$Message, [string]$OutputLog, [string]$ErrorLog, $State, [string]$LabRoot) {
    [Console]::Error.WriteLine('Test client startup was not confirmed: ' + $Message)
    $errorTail = Read-CodletSharedText $ErrorLog 8192 -Tail
    if ($errorTail) { [Console]::Error.WriteLine($errorTail.Trim()) }
    if (($Message + ' ' + $errorTail) -match '(?i)ENOENT|official.?CLI|hash.*mismatch|package.?version|reviewed.*package|expected.*package') {
        [Console]::Error.WriteLine('Codex may have been updated. This bundle keeps its reviewed CLI and package pins; use a reviewed bundle for the installed version. RecoverInterrupted does not approve an upgrade or repair a missing CLI.')
    }
    [Console]::Error.WriteLine('Startup log: ' + $OutputLog)
    [Console]::Error.WriteLine('Error log: ' + $ErrorLog)
    if ($null -ne $State) {
        [Console]::Error.WriteLine('Coordinator state: ' + (Join-Path $State.logs 'state.json'))
        [Console]::Error.WriteLine('Coordinator logs: ' + $State.logs)
        if ($State.PSObject.Properties['report'] -and $State.report) { [Console]::Error.WriteLine('Detailed report: ' + $State.report) }
    } elseif ($LabRoot) {
        [Console]::Error.WriteLine('Coordinator reports, if created: ' + (Join-Path $LabRoot 'logs'))
    }
}

$codletStamp = [DateTime]::UtcNow.Ticks.ToString() + '-' + [Guid]::NewGuid().ToString('N')
$codletOutputLog = Join-Path $PSScriptRoot ('launch-' + $codletStamp + '.stdout.log')
$codletErrorLog = Join-Path $PSScriptRoot ('launch-' + $codletStamp + '.stderr.log')
$codletProcess = $null
$codletState = $null
$codletLabRoot = $null
$codletStatePath = $null
try {
    $codletConfigPath = Join-Path $PSScriptRoot 'lab-config.json'
    $codletConfig = [IO.File]::ReadAllText($codletConfigPath) | ConvertFrom-Json
    $codletLabRoot = [IO.Path]::GetFullPath($codletConfig.labRoot)
    $codletNode = Join-Path $PSScriptRoot $codletConfig.nodeRelative
    $codletScript = Join-Path $PSScriptRoot 'isolated-client.mjs'
    if (-not [IO.File]::Exists($codletConfig.officialCli)) { throw ('The configured official CLI no longer exists: ' + $codletConfig.officialCli) }
    if (-not [IO.File]::Exists($codletNode)) { throw ('The bundled Node runtime is missing: ' + $codletNode) }
    if (-not [IO.File]::Exists($codletScript)) { throw ('The test coordinator is missing: ' + $codletScript) }
    $codletAction = if ($RecoverInterrupted) { 'recover' } else { 'start' }
    $codletArguments = '"' + $codletScript + '" ' + $codletAction + ' "' + $codletConfigPath + '"'
    $codletProcess = Start-Process -FilePath $codletNode -ArgumentList $codletArguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $codletOutputLog -RedirectStandardError $codletErrorLog
    $codletCreated = $codletProcess.StartTime.ToUniversalTime()
    Write-Output ('Waiting for test client startup; manager PID: ' + $codletProcess.Id)
    Write-Output ('Startup log: ' + $codletOutputLog)
    Write-Output ('Error log: ' + $codletErrorLog)
    $codletDeadline = [Diagnostics.Stopwatch]::StartNew()
    while ($codletDeadline.Elapsed.TotalSeconds -lt $StartupTimeoutSeconds) {
        $codletProcess.Refresh()
        $codletObserved = Find-CodletOwnedState $codletLabRoot $codletProcess.Id $codletCreated $codletStatePath
        if ($null -ne $codletObserved) {
            $codletState = $codletObserved
            $codletStatePath = Join-Path $codletState.logs 'state.json'
        }
        if ($codletProcess.HasExited) { throw ('The startup manager exited before confirming readiness (exit code ' + $codletProcess.ExitCode + ').') }
        if ($null -ne $codletState -and $codletState.state -eq 'ready') {
            if ($codletProcess.StartTime.ToUniversalTime().Ticks -ne $codletCreated.Ticks) { throw 'The startup manager process identity changed; readiness was not accepted.' }
            Write-Output ('Test client is ready. Background manager PID: ' + $codletProcess.Id)
            Write-Output ('Coordinator state: ' + $codletStatePath)
            exit 0
        }
        if ($null -ne $codletState -and $codletState.state -in @('failed', 'needs_attention', 'closed')) {
            $codletFailure = if ($codletState.PSObject.Properties['error'] -and $codletState.error) { $codletState.error } else { 'Coordinator state: ' + $codletState.state }
            throw $codletFailure
        }
        Start-Sleep -Milliseconds 200
    }
    throw ('No matching ready state arrived within ' + $StartupTimeoutSeconds + ' seconds. The result is still unknown; the background manager was retained and may finish later. Do not start another copy. Inspect these logs; once ready or starting, use Stop-TestClient to request a normal shutdown. No restart or recovery was attempted.')
} catch {
    $codletMessage = $_.Exception.Message
    if (-not [IO.File]::Exists($codletOutputLog)) { [IO.File]::WriteAllText($codletOutputLog, '', (New-Object Text.UTF8Encoding($false))) }
    if (-not [IO.File]::Exists($codletErrorLog)) { [IO.File]::WriteAllText($codletErrorLog, $codletMessage + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false))) }
    Show-CodletFailure $codletMessage $codletOutputLog $codletErrorLog $codletState $codletLabRoot
    if ($null -ne $codletProcess) {
        $codletProcess.Refresh()
        if (-not $codletProcess.HasExited) { [Console]::Error.WriteLine('The owned manager is still running (PID ' + $codletProcess.Id + '). No process was terminated by this launcher.') }
    }
    exit 1
} finally {
    if ($null -ne $codletProcess) { $codletProcess.Dispose() }
}
