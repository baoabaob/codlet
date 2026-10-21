[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$BaselineMsi,
  [Parameter(Mandatory=$true)][string]$CandidateMsi,
  [Parameter(Mandatory=$true)][string]$OutputPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$output=[IO.Path]::GetFullPath($OutputPath)
if(Test-Path -LiteralPath $output){throw 'Choose a fresh MSI audit output'}
$installer=New-Object -ComObject WindowsInstaller.Installer
function Read-Table($database,[string]$table,[string[]]$columns){
  $query='SELECT '+(($columns|ForEach-Object {'`'+$_+'`'}) -join ',')+' FROM `'+$table+'`'
  $view=$database.OpenView($query)
  try{
    [void]$view.Execute();$rows=@()
    while($record=$view.Fetch()){
      try{$row=[ordered]@{};for($index=0;$index -lt $columns.Count;$index++){$row[$columns[$index]]=$record.StringData($index+1)};$rows+=([pscustomobject]$row)}finally{[void][Runtime.InteropServices.Marshal]::ReleaseComObject($record)}
    }
    return ,$rows
  }finally{[void]$view.Close();[void][Runtime.InteropServices.Marshal]::ReleaseComObject($view)}
}
function Read-Package([string]$path){
  $full=[IO.Path]::GetFullPath($path)
  $database=$installer.OpenDatabase($full,0)
  try{
    [pscustomobject]@{path=$full;sha256=(Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant();
      properties=(Read-Table $database 'Property' @('Property','Value'));
      components=(Read-Table $database 'Component' @('Component','ComponentId','Directory_','Attributes','Condition','KeyPath'));
      files=(Read-Table $database 'File' @('File','Component_','FileName','FileSize','Version','Language','Attributes'));
      hashes=(Read-Table $database 'MsiFileHash' @('File_','HashPart1','HashPart2','HashPart3','HashPart4'));
      sequence=(Read-Table $database 'InstallExecuteSequence' @('Action','Condition','Sequence'))}
  }finally{[void][Runtime.InteropServices.Marshal]::ReleaseComObject($database)}
}
try{
  $old=Read-Package $BaselineMsi;$new=Read-Package $CandidateMsi
  $oldComponents=@{};foreach($component in $old.components){$oldComponents[$component.Component]=$component}
  $oldHashes=@{};foreach($hash in $old.hashes){$oldHashes[$hash.File_]=(($hash.HashPart1,$hash.HashPart2,$hash.HashPart3,$hash.HashPart4)-join ',')}
  $newHashes=@{};foreach($hash in $new.hashes){$newHashes[$hash.File_]=(($hash.HashPart1,$hash.HashPart2,$hash.HashPart3,$hash.HashPart4)-join ',')}
  $changes=@();$stable=0
  foreach($component in $new.components){
    if(-not $oldComponents.ContainsKey($component.Component)){continue}
    $prior=$oldComponents[$component.Component]
    if($prior.ComponentId -eq $component.ComponentId -and $prior.Directory_ -eq $component.Directory_ -and $prior.KeyPath -eq $component.KeyPath -and $prior.Attributes -eq $component.Attributes){$stable++}
    else{$changes+=@{component=$component.Component;before=$prior;after=$component}}
  }
  $unchanged=@($new.files|Where-Object {$newHashes.ContainsKey($_.File) -and $oldHashes.ContainsKey($_.File) -and $newHashes[$_.File] -eq $oldHashes[$_.File]})
  $unversioned=@($new.files|Where-Object {-not $_.Version})
  $result=[ordered]@{schema=1;baseline=$old;candidate=$new;stableCommonComponents=$stable;changedCommonComponents=$changes;unchangedHashedFiles=$unchanged.Count;unchangedHashedBytes=($unchanged|Measure-Object -Property FileSize -Sum).Sum;unversionedFiles=$unversioned.Count;unversionedExecutables=@($unversioned|Where-Object {$_.FileName -match '\.exe$'}|Select-Object File,FileName,Component_);lateRemovalEligible=($changes.Count -eq 0 -and $unversioned.Count -eq 0);decision='Keep afterInstallInitialize until changed unversioned files have a tested replacement policy, including modified destination timestamps.'}
  [IO.File]::WriteAllText($output,($result|ConvertTo-Json -Depth 12)+"`n",[Text.UTF8Encoding]::new($false))
  [pscustomobject]$result|Select-Object stableCommonComponents,unchangedHashedFiles,unchangedHashedBytes,unversionedFiles,lateRemovalEligible,decision|ConvertTo-Json
}finally{[void][Runtime.InteropServices.Marshal]::ReleaseComObject($installer)}
