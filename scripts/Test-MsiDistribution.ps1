[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$MsiPath,[Parameter(Mandatory=$true)][string]$ArtifactsDirectory,[switch]$StructureOnly)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$msi=[IO.Path]::GetFullPath($MsiPath)
$artifacts=[IO.Path]::GetFullPath($ArtifactsDirectory)
if(Test-Path -LiteralPath $artifacts){throw 'Use a new MSI acceptance directory'}
[IO.Directory]::CreateDirectory($artifacts)|Out-Null
$install=Join-Path $artifacts 'installed'
$data=Join-Path $artifacts 'user-data'
foreach($path in @($install,$data)){if(-not ([IO.Path]::GetFullPath($path)).StartsWith($artifacts+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Test target escaped owned root'}}
$installer=New-Object -ComObject WindowsInstaller.Installer
if($StructureOnly){
  $database=$installer.OpenDatabase($msi,0)
  function Rows([string]$Sql,[int]$Columns){
    $query=$database.OpenView($Sql);$null=$query.Execute()
    try{while($record=$query.Fetch()){$values=@();for($column=1;$column -le $Columns;$column++){$values+=$record.StringData($column)};,$values}}finally{$null=$query.Close()}
  }
  try{
    $featureRows=@(Rows 'SELECT `Feature`,`Level` FROM `Feature`' 2)
    $featureNames=@($featureRows|ForEach-Object{$_[0]})
    foreach($name in @('Core','UiAdapter','DesktopAdapter','GUI','StartMenu','DesktopShortcut')){if($name -notin $featureNames){throw "Missing MSI option: $name"}}
    $installedFiles=@(Rows 'SELECT `FileName` FROM `File`' 1|ForEach-Object{$_[0]})
    if(@($installedFiles|Where-Object{$_ -match '(^|\|)node\.exe$'}).Count){throw 'Managed MSI contains a bundled Node executable'}
    $shortcuts=@(Rows 'SELECT `Shortcut`,`Target`,`Arguments` FROM `Shortcut`' 3)
    if($shortcuts.Count -ne 2 -or @($shortcuts|Where-Object{$_[1] -ne '[INSTALLFOLDER]Codlet-Launcher.exe' -or $_[2] -like '*--configure*'}).Count){throw 'Only the Start menu and desktop launch shortcuts are allowed'}
    $sequences=@(Rows 'SELECT `Action`,`Sequence` FROM `InstallExecuteSequence`' 2)
    $preflight=[int](@($sequences|Where-Object{$_[0] -eq 'CheckRunningApplications'})[0][1])
    $validate=[int](@($sequences|Where-Object{$_[0] -eq 'InstallValidate'})[0][1])
    if($preflight -le 0 -or $preflight -ge $validate){throw 'Process check must precede file validation and the transaction'}
    $action=@(Rows "SELECT ``Type``,``Target`` FROM ``CustomAction`` WHERE ``Action``='CheckRunningApplications'" 2)[0]
    if([int]$action[0] -ne 2 -or $action[1] -notlike '*[[]UILevel[]]*' -or $action[1] -notlike '*Codlet-Installer-*'){throw 'MSI preflight must pass UI level and a diagnostic log path'}
    $restart=@(Rows "SELECT ``Value`` FROM ``Property`` WHERE ``Property``='MSIRESTARTMANAGERCONTROL'" 1)[0][0]
    if($restart -ne 'DisableShutdown'){throw 'MSI may automatically close user applications'}
    $launch=@(Rows "SELECT ``Condition`` FROM ``ControlEvent`` WHERE ``Event``='DoAction' AND ``Argument``='LaunchCodletAfterInstall'" 1)[0][0]
    if($launch -notlike '*WIXUI_EXITDIALOGOPTIONALCHECKBOX*'){throw 'Post-install launch is not opt-in'}
    $report=[ordered]@{schema=1;passed=$true;scope='read-only-msi-structure';features=$featureNames;bundledNode=$false;nativeShortcuts=$shortcuts.Count;preflightBeforeFileValidation=$true;automaticShutdown=$false;optionalLaunch=$true;installationPerformed=$false}
    $report|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $artifacts 'report.json') -Encoding UTF8
    $report|ConvertTo-Json -Compress
  }finally{[Runtime.InteropServices.Marshal]::ReleaseComObject($database)|Out-Null;[Runtime.InteropServices.Marshal]::ReleaseComObject($installer)|Out-Null}
  return
}
$related=@($installer.RelatedProducts('{941C0F18-D41F-46E9-A3D1-A9562D75BF76}'))
if($related.Count -gt 0){throw 'A Codlet Preview MSI is already installed; refuse to replace it during testing'}
$database=$installer.OpenDatabase($msi,0)
$view=$database.OpenView("SELECT ``Value`` FROM ``Property`` WHERE ``Property``='ProductCode'")
$view.Execute();$product=$view.Fetch().StringData(1);$view.Close()
$checks=[Collections.Generic.List[string]]::new()
function Run-Msi([string[]]$Arguments,[string]$Name){
  $log=Join-Path $artifacts ($Name+'.log')
  $parameters=@($Arguments)+@('/qn','/norestart','/l*v',('"'+$log+'"'))
  $process=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/msiexec.exe') -ArgumentList $parameters -WindowStyle Hidden -Wait -PassThru
  if($process.ExitCode -notin @(0,3010)){throw "MSI $Name failed ($($process.ExitCode)); see $log"}
}
function Assert([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
function Inventory {
  $env:CODLET_HOME=$data
  $text=& (Join-Path $install 'codlet.exe') plugin list --json
  if($LASTEXITCODE -ne 0){throw 'Installed Core CLI failed'}
  ($text|Out-String)|ConvertFrom-Json
}
$installed=$false
try{
  Run-Msi -Arguments @('/i',('"'+$msi+'"'),('INSTALLFOLDER="'+$install+'"'),'ADDLOCAL=Core') -Name 'install-core'
  $installed=$true
  Assert ([IO.File]::Exists((Join-Path $install 'codlet.exe'))) 'Core executable missing'
  Assert (-not [IO.File]::Exists((Join-Path $install 'portable.mode'))) 'MSI selected the portable data scope'
  & (Join-Path $install 'Initialize-Codlet.ps1') -NoLaunch -DataDirectory $data
  Assert (@((Inventory).plugins).Count -eq 0) 'Core-only MSI unexpectedly registered plugins'
  $checks.Add('Core-only MSI runs with no optional plugins')
  Run-Msi -Arguments @('/i',('"'+$msi+'"'),('INSTALLFOLDER="'+$install+'"'),'ADDLOCAL=Core,GUI') -Name 'add-gui'
  Assert ([IO.File]::Exists((Join-Path $install 'optional-plugins/packages/codex.ui.adapter/codlet.json'))) 'GUI selection missed its UI Adapter component'
  Assert (-not [IO.Directory]::Exists((Join-Path $install 'optional-plugins/packages/codex.desktop.adapter'))) 'Unselected Desktop Adapter was installed'
  & (Join-Path $install 'Initialize-Codlet.ps1') -NoLaunch -DataDirectory $data
  Assert (@((Inventory).plugins).Count -eq 2) 'MSI first-launch package registration is wrong'
  $checks.Add('GUI-only MSI install includes UI Adapter and omits Desktop Adapter')
  & (Join-Path $install 'codlet.exe') plugin disable codlet-gui --json | Out-Null
  Assert ($LASTEXITCODE -eq 0) 'Could not set a user preference'
  Run-Msi -Arguments @('/i',('"'+$msi+'"'),('INSTALLFOLDER="'+$install+'"'),'ADDLOCAL=Core,GUI,DesktopAdapter') -Name 'add-desktop'
  & (Join-Path $install 'Initialize-Codlet.ps1') -NoLaunch -DataDirectory $data
  $inventory=Inventory
  Assert (@($inventory.plugins).Count -eq 3) 'Added MSI feature was not registered'
  Assert (@($inventory.plugins|Where-Object{$_.id -eq 'codlet-gui' -and -not $_.enabled}).Count -eq 1) 'MSI modification changed user enablement'
  $checks.Add('MSI maintenance adds Desktop Adapter without changing existing plugin settings')
  $config=[IO.File]::ReadAllText((Join-Path $data 'config.json'))
  [IO.File]::WriteAllText((Join-Path $data 'user-note.txt'),'retain user data')
  Run-Msi -Arguments @('/x',$product) -Name 'uninstall'
  $installed=$false
  Assert (-not [IO.File]::Exists((Join-Path $install 'codlet.exe'))) 'MSI left its owned Core executable'
  Assert ([IO.File]::ReadAllText((Join-Path $data 'config.json')) -eq $config) 'MSI uninstall changed user registry'
  Assert ([IO.File]::Exists((Join-Path $data 'packages/codlet-gui/codlet.json'))) 'MSI uninstall deleted a user plugin'
  Assert ([IO.File]::ReadAllText((Join-Path $data 'user-note.txt')) -eq 'retain user data') 'MSI uninstall deleted user data'
  $checks.Add('Uninstall removes owned application files and preserves plugins/configuration/user data')
  $report=[ordered]@{schema=1;passed=$true;productCode=$product;checks=$checks.ToArray();clientStarted=$false;testInstallationRemoved=$true}
  $report|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $artifacts 'report.json') -Encoding UTF8
  $report|ConvertTo-Json -Depth 8
}finally{
  if($installed){Run-Msi -Arguments @('/x',$product) -Name 'cleanup-test-installation'}
  [Runtime.InteropServices.Marshal]::ReleaseComObject($database)|Out-Null
  [Runtime.InteropServices.Marshal]::ReleaseComObject($installer)|Out-Null
}
