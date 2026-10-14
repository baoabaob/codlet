# Pure selection/identity checks; importing this file never queries or controls processes.
function Test-CodletSnapshotCreation {
  param([long]$SnapshotCreated, [long]$HandleCreated)
  # Win32_Process timestamps have microsecond precision; keep integer arithmetic.
  return $SnapshotCreated -eq ($HandleCreated - ($HandleCreated % [long]10))
}

function Select-CodletProcessTree {
  param([object[]]$Rows, [object[]]$Roots)
  if($Roots.Count -eq 0){throw 'No pinned roots'}
  $byId=@{}; $selected=@{}; $ordered=[Collections.Generic.List[object]]::new()
  foreach($row in $Rows){
    $idValue=[int]$row.pid
    if($byId.ContainsKey($idValue)){throw 'Duplicate snapshot PID'}
    $byId[$idValue]=$row
  }
  foreach($root in $Roots){
    $idValue=[int]$root.pid; $row=$byId[$idValue]
    if($selected.ContainsKey($idValue)){throw 'Duplicate pinned root'}
    if($null -eq $row -or -not (Test-CodletSnapshotCreation $row.created $root.filetime)){
      throw "Pinned root missing or reused in snapshot: $idValue"
    }
    $node=[pscustomobject]@{pid=$idValue;parentPid=[int]$row.parentPid;created=[string]$row.created;name=$row.name;kind='root';rootPid=$idValue;rootCreated=[string]$root.filetime;image=$root.image}
    $selected[$idValue]=$node; $ordered.Add($node)
  }
  do {
    $changed=$false
    foreach($row in $Rows){
      $idValue=[int]$row.pid; $parentId=[int]$row.parentPid
      if($selected.ContainsKey($idValue) -or -not $selected.ContainsKey($parentId)){continue}
      $parent=$selected[$parentId]
      if([long]$row.created -lt [long]$parent.created){continue}
      $node=[pscustomobject]@{pid=$idValue;parentPid=$parentId;created=[string]$row.created;name=$row.name;kind='descendant';rootPid=$parent.rootPid;rootCreated=$parent.rootCreated;image=$null}
      $selected[$idValue]=$node; $ordered.Add($node); $changed=$true
    }
  }while($changed)
  return $ordered.ToArray()
}

function Assert-CodletOpenedProcess {
  param($Candidate, [int]$ActualPid, [long]$ActualCreated, [string]$ActualImage, [Nullable[long]]$ParentCreated)
  if($ActualPid -ne $Candidate.pid -or -not (Test-CodletSnapshotCreation $Candidate.created $ActualCreated)){
    throw 'Process identity changed between snapshot and handle acquisition'
  }
  if($Candidate.kind -eq 'root'){
    if($ActualCreated -ne [long]$Candidate.rootCreated -or $ActualImage -ne $Candidate.image){throw 'Pinned root handle identity changed'}
  }elseif($null -eq $ParentCreated -or $ActualCreated -lt $ParentCreated){
    throw 'Child handle predates its retained parent identity'
  }
}
