param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$RegistryPath,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{64}$')][string]$RegistryScope,
    [switch]$Watch
)
$ErrorActionPreference = 'Stop'

function Get-NormalLocalPath([string]$Value) {
    if ($Value.StartsWith('\\?\')) { $Value = $Value.Substring(4) }
    if ($Value -notmatch '^[a-zA-Z]:[\\/]') { throw 'Restart requires an absolute local-drive path.' }
    return [IO.Path]::GetFullPath($Value)
}

$codletOwnedHost = $null
try {
    $codletExecutable = Get-NormalLocalPath $Executable
    $codletRegistry = Get-NormalLocalPath $RegistryPath
    if ([IO.Path]::GetFileName($codletExecutable) -ine 'codlet.exe') { throw 'The restart target must be codlet.exe.' }
    $codletExecutableInfo = Get-Item -LiteralPath $codletExecutable -Force
    if ($codletExecutableInfo.PSIsContainer -or ($codletExecutableInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'The restart executable is not a plain file.' }
    $codletDefaultRegistry = if($env:CODLET_HOME){Get-NormalLocalPath (Join-Path $env:CODLET_HOME 'config.json')}else{Get-NormalLocalPath (Join-Path $env:LOCALAPPDATA 'Codlet/config.json')}
    if ($codletDefaultRegistry -ine $codletRegistry) { throw 'The restart environment selects a different registry.' }

    $codletLogs = Join-Path ([IO.Path]::GetDirectoryName($codletRegistry)) 'runtime-updates/restarts'
    [IO.Directory]::CreateDirectory($codletLogs) | Out-Null
    $codletStamp = [DateTime]::UtcNow.Ticks.ToString()
    $codletOutput = Join-Path $codletLogs ($codletStamp + '.stdout.log')
    $codletErrors = Join-Path $codletLogs ($codletStamp + '.stderr.log')
    $codletArguments = @('launch')
    if ($Watch) { $codletArguments += '--watch' }
    $codletOwnedHost = Start-Process -FilePath $codletExecutable -ArgumentList $codletArguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $codletOutput -RedirectStandardError $codletErrors
    $codletCreated = $codletOwnedHost.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
    $codletDeadline = [DateTime]::UtcNow.AddSeconds(90)
    do {
        $codletOwnedHost.Refresh()
        if ($codletOwnedHost.HasExited) {
            throw ('The new Host exited before readiness. Its Desktop exit is not confirmed; see ' + $codletErrors)
        }
        try {
            $codletStatusText = & $codletExecutable status --json 2>$null
            $codletStatus = ($codletStatusText -join [Environment]::NewLine) | ConvertFrom-Json
            $codletDoctorText = & $codletExecutable doctor --json 2>$null
            $codletDoctor = ($codletDoctorText -join [Environment]::NewLine) | ConvertFrom-Json
            $codletSample = $codletDoctor.runtime.sample
            $codletCurrent = Get-Process -Id $codletOwnedHost.Id -ErrorAction Stop
            $codletSameHost = $codletCurrent.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -eq $codletCreated -and (Get-NormalLocalPath $codletCurrent.Path) -ieq $codletExecutable
            if ($codletSameHost -and $codletStatus.status -eq 'running' -and $codletStatus.snapshot.host_pid -eq $codletOwnedHost.Id -and $codletStatus.snapshot.state -eq 'ready' -and $codletDoctor.runtime.status -eq 'inspected' -and $codletSample.hostPid -eq $codletOwnedHost.Id -and $codletSample.registryScope -ceq $RegistryScope -and $codletSample.hostState -eq 'ready' -and $codletSample.freshness -eq 'fresh' -and $codletSample.codex.pid -eq $codletStatus.snapshot.codex.pid) {
                $codletDesktop = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [uint32]$codletSample.codex.pid)
                if ($codletDesktop -and $codletDesktop.ParentProcessId -eq $codletOwnedHost.Id -and (Get-NormalLocalPath $codletDesktop.ExecutablePath) -ieq (Get-NormalLocalPath $codletSample.codex.executable)) {
                    $codletDesktopProcess = Get-Process -Id $codletDesktop.ProcessId -ErrorAction Stop
                    if (-not $codletDesktopProcess.HasExited -and $codletDesktopProcess.StartTime.ToUniversalTime() -ge $codletOwnedHost.StartTime.ToUniversalTime() -and (Get-NormalLocalPath $codletDesktopProcess.Path) -ieq (Get-NormalLocalPath $codletSample.codex.executable)) {
                        $codletOwnedHost.Refresh()
                        if (-not $codletOwnedHost.HasExited) {
                            [pscustomobject]@{status='ready';hostPid=$codletOwnedHost.Id;hostCreated=$codletCreated;registryScope=$RegistryScope;desktopPid=$codletDesktop.ProcessId;desktopCreated=$codletDesktopProcess.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();watch=[bool]$Watch;stdout=$codletOutput;stderr=$codletErrors} | ConvertTo-Json -Compress
                            exit 0
                        }
                    }
                }
            }
        } catch { }
        Start-Sleep -Milliseconds 750
    } while ([DateTime]::UtcNow -lt $codletDeadline)
    throw ('The new Host did not confirm readiness. Its processes are retained; see ' + $codletErrors)
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    # Once launch was attempted successfully, an exited Host does not prove that
    # its Desktop and descendants exited. Never kill them or start a second copy.
    if ($null -ne $codletOwnedHost) { exit 42 }
    exit 1
}
