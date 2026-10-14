# Offline fixtures only: no process enumeration, client launch or process control.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'process-ownership.ps1')
$testCount=0
function Assert-Equal($Actual,$Expected,$Label){if($Actual -cne $Expected){throw "$Label`: expected $Expected, got $Actual"}}
function Assert-Throws([scriptblock]$Action,[string]$Label){$didThrow=$false;try{& $Action}catch{$didThrow=$true};if(-not $didThrow){throw "$Label`: expected rejection"}}
function Row([int]$IdValue,[int]$ParentValue,[long]$TimeValue,[string]$NameValue='same.exe'){
  [pscustomobject]@{pid=$IdValue;parentPid=$ParentValue;created=$TimeValue.ToString();name=$NameValue}
}
$base=[long]134361835796491290
$roots=@([pscustomobject]@{pid=10;filetime=($base+8).ToString();image='X:\owned.exe'})
$rows=@((Row 31 30 ($base+300)),(Row 10 1 $base),(Row 20 10 ($base-10) 'steam.exe'),(Row 21 20 ($base+400)),(Row 30 10 ($base+100)))
$selected=@(Select-CodletProcessTree $rows $roots)
Assert-Equal (($selected.pid)-join ',') '10,30,31' 'Older reused-parent subtree excluded; valid descendants parent first';$testCount++
foreach($row in $rows){$row.name='arbitrary-name.exe'}
Assert-Equal ((@(Select-CodletProcessTree $rows $roots).pid)-join ',') '10,30,31' 'Names never determine ownership';$testCount++
Assert-Throws {Select-CodletProcessTree @((Row 10 1 ($base+10))) $roots} 'Root PID reused in later scan';$testCount++
Assert-Throws {Select-CodletProcessTree @((Row 30 10 ($base+100))) $roots} 'Root missing';$testCount++
Assert-Throws {Select-CodletProcessTree @((Row 10 1 $base),(Row 10 1 $base)) $roots} 'Ambiguous snapshot identity';$testCount++
Assert-CodletOpenedProcess $selected[0] 10 ($base+8) 'X:\owned.exe' $null
Assert-CodletOpenedProcess $selected[1] 30 ($base+109) '' ($base+8)
Assert-Equal (Test-CodletSnapshotCreation ($base+100) ($base+109)) $true 'CIM microsecond precision accepted';$testCount++
Assert-Throws {Assert-CodletOpenedProcess $selected[1] 30 ($base+110) '' ($base+8)} 'Child reused between snapshot and handle';$testCount++
Assert-Throws {Assert-CodletOpenedProcess $selected[1] 999 ($base+109) '' ($base+8)} 'Different PID';$testCount++
Assert-Throws {Assert-CodletOpenedProcess $selected[0] 10 ($base+9) 'X:\owned.exe' $null} 'Root exact FILETIME checked within microsecond';$testCount++
Assert-Throws {Assert-CodletOpenedProcess $selected[0] 10 ($base+8) 'X:\other.exe' $null} 'Root image checked';$testCount++
$sameMicro=@(Select-CodletProcessTree @((Row 10 1 $base),(Row 11 10 $base)) $roots)
Assert-Throws {Assert-CodletOpenedProcess $sameMicro[1] 11 ($base+7) '' ($base+8)} 'Actual child older within same microsecond';$testCount++
Assert-Throws {Assert-CodletOpenedProcess $selected[1] 30 ($base+109) '' $null} 'Parent handle required';$testCount++

# Execute the real collector with all OS process calls and the wait replaced.
$fixtureDir=Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) ('.codlet-artifacts/core-process-audit-tests/'+[guid]::NewGuid().ToString())
$null=[IO.Directory]::CreateDirectory($fixtureDir)
foreach($mode in @('valid','root-reused','child-raced')){
  & {
    param($ModeValue,$DirectoryValue,$TimeValue,$RootValue)
    $fixture=@{scan=0;opens=0;sleeps=0;processes=@{}}
    foreach($idValue in @(10,30)){
      $created=$TimeValue+$(if($idValue -eq 10){8}elseif($ModeValue -eq 'child-raced'){110}else{109})
      $p=[pscustomobject]@{Id=$idValue;Handle=1;StartTime=[DateTime]::FromFileTimeUtc($created);Path='X:\owned.exe';ProcessName='same';HasExited=$false;TotalProcessorTime=[TimeSpan]::FromSeconds(2);PrivateMemorySize64=4096;WorkingSet64=2048;disposed=$false}
      $p|Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
      $p|Add-Member -MemberType ScriptMethod -Name Dispose -Value {$this.disposed=$true}
      $fixture.processes[$idValue]=$p
    }
    function Get-Process {
      param([int]$Id,[string]$ErrorAction)
      $fixture.opens++
      if(-not $fixture.processes.ContainsKey($Id)){throw 'Unexpected process lookup'}
      return $fixture.processes[$Id]
    }
    function Get-CimInstance {
      param([string]$ClassName)
      Assert-Equal $ClassName 'Win32_Process' 'Expected snapshot query'
      $fixture.scan++
      $rootTime=$TimeValue+$(if($ModeValue -eq 'root-reused' -and $fixture.scan -eq 2){10}else{0})
      foreach($row in @((Row 10 1 $rootTime),(Row 20 10 ($TimeValue-10)),(Row 30 10 ($TimeValue+100)))){
        [pscustomobject]@{ProcessId=$row.pid;ParentProcessId=$row.parentPid;CreationDate=[DateTime]::FromFileTimeUtc([long]$row.created);Name=$row.name}
      }
    }
    function Start-Sleep {param([int]$Seconds);Assert-Equal $Seconds 60 'Requested window';$fixture.sleeps++}
    $evidenceFile=Join-Path $DirectoryValue ($ModeValue+'.input.json')
    $outputFile=Join-Path $DirectoryValue ($ModeValue+'.output.json')
    [IO.File]::WriteAllText($evidenceFile,(@{fixtureOnly=$true;processes=$RootValue}|ConvertTo-Json -Depth 4))
    $collector=Join-Path $PSScriptRoot 'sample-process-group.ps1'
    if($ModeValue -eq 'valid'){
      $null=& $collector -Evidence $evidenceFile -Output $outputFile
      $result=[IO.File]::ReadAllText($outputFile)|ConvertFrom-Json
      Assert-Equal $result.schema 2 'Output provenance schema'
      Assert-Equal $result.selectionScans.Count 2 'Both endpoints recorded'
      Assert-Equal $result.before.Count 2 'Older process excluded'
      Assert-Equal $result.after.Count 2 'Valid identities retained'
      $child=@($result.after|Where-Object {$_.pid -eq 30})[0]
      Assert-Equal $child.provenance.parentCreated ($TimeValue+8).ToString() 'Exact retained parent creation'
      Assert-Equal $result.sourceDigests.ownership.Length 64 'Helper digest recorded'
      Assert-Equal $fixture.opens 2 'Existing handles reused'
      Assert-Equal $fixture.sleeps 1 'Wait mocked'
      Assert-Throws {& $collector -Evidence $evidenceFile -Output $outputFile} 'Existing evidence not overwritten'
    }else{
      Assert-Throws {& $collector -Evidence $evidenceFile -Output $outputFile} $ModeValue
      Assert-Equal (Test-Path -LiteralPath $outputFile) $false 'Rejected capture writes no sample'
    }
    Assert-Equal $fixture.processes[10].disposed $true 'Root handle disposed'
    Assert-Equal $fixture.processes[30].disposed $true 'Child handle disposed'
  } $mode $fixtureDir $base $roots
  $testCount++
}
[pscustomobject]@{passed=$testCount;scope='Offline synthetic ownership fixtures, including three mocked collector runs; no live processes';fixtureDirectory=$fixtureDir}|ConvertTo-Json -Compress
