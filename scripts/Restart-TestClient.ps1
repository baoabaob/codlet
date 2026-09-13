# Update-helper contract: 0 = fresh ready owner, 1 = failed but all fresh owned
# processes stopped, 42 = ownership/cleanup uncertain; preserve files for review.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$codletPowerShell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$codletAttempt = [DateTime]::UtcNow

function Read-CodletRestartState([string]$Path) {
    try {
        $file = Get-Item -LiteralPath $Path -ErrorAction Stop
        if ($file.Length -gt 262144 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $null }
        return ([IO.File]::ReadAllText($file.FullName) | ConvertFrom-Json)
    } catch { return $null }
}
function Test-CodletRestartProcess([int]$ProcessId, [string]$Created, [switch]$FileTime) {
    try {
        $item = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
        if ($null -eq $item) { return $false }
        if ($FileTime) { return $item.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -eq $Created }
        $expected = [DateTime]::Parse($Created, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
        return $item.StartTime.ToUniversalTime().Ticks -eq $expected.Ticks
    } catch { return $true }
}
try {
    $codletConfiguration = Read-CodletRestartState (Join-Path $PSScriptRoot 'lab-config.json')
    if ($null -eq $codletConfiguration -or $codletConfiguration.schema -ne 1) { exit 42 }
    $codletRestartRoot = [IO.Path]::GetFullPath($codletConfiguration.labRoot)
    & $codletPowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Start-TestClient.ps1')
    if ($LASTEXITCODE -eq 0) { exit 0 }
    $codletCandidates = @()
    $codletLogs = Join-Path $codletRestartRoot 'logs'
    foreach ($folder in (Get-ChildItem -LiteralPath $codletLogs -Directory -Filter 'coordinator-*' | Where-Object { $_.CreationTimeUtc -ge $codletAttempt.AddSeconds(-1) })) {
        if ($folder.Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 42 }
        $candidate = Read-CodletRestartState (Join-Path $folder.FullName 'state.json')
        if ($null -eq $candidate) { continue }
        if ([IO.Path]::GetFullPath($candidate.labRoot) -ne $codletRestartRoot -or $candidate.runId -notmatch ('^\d+-' + [int]$candidate.managerPid + '$')) { exit 42 }
        $expectedLogs = Join-Path $codletLogs ('coordinator-' + $candidate.runId)
        if ([IO.Path]::GetFullPath($candidate.logs) -ne $expectedLogs -or [IO.Path]::GetFullPath($folder.FullName) -ne $expectedLogs) { exit 42 }
        $codletCandidates += $candidate
    }
    if ($codletCandidates.Count -ne 1) { exit 42 }
    $codletState = $codletCandidates[0]
    $codletStatePath = Join-Path $codletState.logs 'state.json'
    # Request quit only through this newly started coordinator's fixed mailbox.
    if (Test-CodletRestartProcess $codletState.managerPid $codletState.managerCreated) {
        [IO.File]::WriteAllText((Join-Path $codletState.logs 'quit.request'), "quit`n")
    }
    $codletDeadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        $codletCurrent = Read-CodletRestartState $codletStatePath
        if ($null -ne $codletCurrent -and $codletCurrent.runId -eq $codletState.runId) { $codletState = $codletCurrent }
        $codletManagerAlive = Test-CodletRestartProcess $codletState.managerPid $codletState.managerCreated
        if (-not $codletManagerAlive) { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $codletDeadline)
    if ($codletManagerAlive -or -not $codletState.PSObject.Properties['hostExit'] -or $codletState.hostExit.code -ne 0) { exit 42 }
    if ($codletState.PSObject.Properties['desktopPid'] -and (Test-CodletRestartProcess $codletState.desktopPid $codletState.desktopCreated -FileTime)) { exit 42 }
    if ($codletState.PSObject.Properties['backendPid']) {
        if (-not $codletState.PSObject.Properties['backendIdentity'] -or (Test-CodletRestartProcess $codletState.backendPid $codletState.backendIdentity.created)) { exit 42 }
    }
    exit 1
} catch {
    [Console]::Error.WriteLine('Update restart could not confirm clean ownership: ' + $_.Exception.Message)
    exit 42
}
