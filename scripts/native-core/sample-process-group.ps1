param([Parameter(Mandatory=$true)][string]$Evidence,[Parameter(Mandatory=$true)][string]$Output,[int]$Seconds=60)
$ErrorActionPreference='Stop'
$ownershipScript=Join-Path $PSScriptRoot 'process-ownership.ps1'
. $ownershipScript
$proof=[IO.File]::ReadAllText($Evidence)|ConvertFrom-Json
if($Seconds -ne 60){throw 'Idle samples require exactly 60 seconds'}
if(Test-Path -LiteralPath $Output){throw 'Sample output already exists; preserve prior evidence'}
$sourceDigests=@{sampler=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash;ownership=(Get-FileHash -LiteralPath $ownershipScript -Algorithm SHA256).Hash;evidence=(Get-FileHash -LiteralPath $Evidence -Algorithm SHA256).Hash}
$handles=@{}; $scans=[Collections.Generic.List[object]]::new()
function Find-OwnedProcesses {
  $scanStart=[DateTime]::UtcNow
  foreach($fact in $proof.processes){if($handles[[int]$fact.pid].process.HasExited){throw 'Pinned root exited before scan'}}
  $all=@(Get-CimInstance Win32_Process | Where-Object {$null -ne $_.CreationDate} | ForEach-Object {
    [pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString();name=$_.Name}
  })
  $candidates=@(Select-CodletProcessTree -Rows $all -Roots $proof.processes)
  $members=@(); $scanNumber=$scans.Count
  # Parents come first; their handles stay open through both endpoint scans.
  foreach($candidate in $candidates){
    $idValue=[int]$candidate.pid; $isNew=-not $handles.ContainsKey($idValue); $p=$null
    try{
      if($isNew){$p=Get-Process -Id $idValue -ErrorAction Stop; $null=$p.Handle}else{$p=$handles[$idValue].process}
      if($p.HasExited){throw 'Selected process exited during scan'}
      $created=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
      $parentCreated=$null
      if($candidate.kind -eq 'descendant'){$parentCreated=[long]$handles[[int]$candidate.parentPid].created}
      Assert-CodletOpenedProcess -Candidate $candidate -ActualPid $p.Id -ActualCreated $created -ActualImage $(if($candidate.kind -eq 'root'){$p.Path}else{''}) -ParentCreated $parentCreated
      $edge=[pscustomobject]@{pid=$idValue;created=$created;kind=$candidate.kind;parentPid=$candidate.parentPid;parentCreated=$(if($null -ne $parentCreated){$parentCreated.ToString()}else{$null});snapshotCreated=$candidate.created;rootPid=$candidate.rootPid;rootCreated=$candidate.rootCreated;scan=$scanNumber}
      if($isNew){$handles[$idValue]=@{process=$p;pid=$idValue;created=$created;name=$candidate.name;provenance=$edge}}
      elseif($null -eq $handles[$idValue].provenance){$handles[$idValue].provenance=$edge}
      $members+=$edge
    }catch{
      if($isNew -and $null -ne $p -and -not $handles.ContainsKey($idValue)){$p.Dispose()}
      throw
    }
  }
  $scans.Add([pscustomobject]@{startedAt=$scanStart.ToString('o');completedAt=[DateTime]::UtcNow.ToString('o');members=$members})
}
function Snapshot {
  $items=@();foreach($entry in $handles.Values){$p=$entry.process;$p.Refresh();$cpu=$p.TotalProcessorTime.TotalSeconds
    $live=-not $p.HasExited
    $items += [pscustomobject]@{pid=$entry.pid;created=$entry.created;name=$entry.name;cpuSeconds=$cpu;live=$live;privateBytes=$(if($live){$p.PrivateMemorySize64}else{0});workingSetBytes=$(if($live){$p.WorkingSet64}else{0});provenance=$entry.provenance}
  };return $items
}
try{
  foreach($fact in $proof.processes){
    $p=Get-Process -Id $fact.pid -ErrorAction Stop
    try{
      $null=$p.Handle
      $created=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
      if($p.HasExited -or $created -ne $fact.filetime -or $p.Path -ne $fact.image){throw 'Owned root identity changed'}
      if($handles.ContainsKey([int]$p.Id)){throw 'Duplicate pinned root'}
      $handles[[int]$p.Id]=@{process=$p;pid=$p.Id;created=$created;name=$p.ProcessName;provenance=$null}
    }catch{$p.Dispose();throw}
  }
  Find-OwnedProcesses
  $start=[DateTime]::UtcNow;$watch=[Diagnostics.Stopwatch]::StartNew();$before=@(Snapshot)
  Start-Sleep -Seconds 60
  # Retained handles supply final CPU for children that exit during this interval.
  # A child born and retired between scans is not included; report this limit.
  Find-OwnedProcesses
  $after=@(Snapshot);$elapsed=$watch.Elapsed.TotalSeconds;$base=@{};foreach($p in $before){$base[$p.pid.ToString()+'-'+$p.created]=$p.cpuSeconds}
  $cpu=0;foreach($p in $after){$key=$p.pid.ToString()+'-'+$p.created;$cpu+=$p.cpuSeconds-$(if($base.ContainsKey($key)){$base[$key]}else{0})}
  $r=[ordered]@{schema=2;startedAt=$start.ToString('o');elapsedSeconds=$elapsed;cpuSeconds=$cpu;oneCorePercent=100*$cpu/$elapsed;machinePercent=100*$cpu/$elapsed/[Environment]::ProcessorCount;logicalProcessors=[Environment]::ProcessorCount;before=$before;after=$after;sourceDigests=$sourceDigests;roots=$proof.processes;selectionScans=$scans.ToArray();transientChildren='Endpoint scans omit children born and retired between scans, and newly observed children whose parent has already disappeared from the snapshot';samplerInGroup=$false}
  $bytes=(New-Object Text.UTF8Encoding($false)).GetBytes(($r|ConvertTo-Json -Depth 12))
  $stream=[IO.File]::Open($Output,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
  try{$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
  [pscustomobject]@{output=$Output;elapsedSeconds=$elapsed;cpuSeconds=$cpu;oneCorePercent=$r.oneCorePercent;processes=$after.Count}|ConvertTo-Json -Compress
}finally{foreach($entry in $handles.Values){$entry.process.Dispose()}}
