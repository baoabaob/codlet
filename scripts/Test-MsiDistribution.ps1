[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$MsiPath,[Parameter(Mandatory=$true)][string]$ArtifactsDirectory,[switch]$StructureOnly)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$msi=[IO.Path]::GetFullPath($MsiPath)
$artifacts=[IO.Path]::GetFullPath($ArtifactsDirectory)
if(-not $StructureOnly){
  $computer=Get-CimInstance Win32_ComputerSystem
  if($computer.Model -cne 'CodletNativeAcceptanceVM'){throw 'Disposable CodletNativeAcceptanceVM required for MSI installation acceptance; use -StructureOnly for read-only checks'}
}
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
    foreach($name in @('Core','GUI','StartMenu','DesktopShortcut','CliPath')){if($name -notin $featureNames){throw "Missing MSI option: $name"}}
    if(@($featureNames|Where-Object{$_ -in @('UiAdapter','DesktopAdapter')}).Count){throw 'MSI exposes obsolete adapter download choices'}
    $allUsers=@(Rows "SELECT ``Value`` FROM ``Property`` WHERE ``Property``='ALLUSERS'" 1)[0][0]
    $perUser=@(Rows "SELECT ``Value`` FROM ``Property`` WHERE ``Property``='MSIINSTALLPERUSER'" 1)[0][0]
    if($allUsers -ne '2' -or $perUser -ne '1'){throw 'Expected dual-purpose MSI with a per-user default'}
    $registrations=@(Rows 'SELECT `Root` FROM `Registry`' 1)
    if(@($registrations|Where-Object{$_[0] -ne '-1'}).Count){throw 'Installer registration and plugin choices must follow installation context'}
    $environment=@(Rows 'SELECT `Name`,`Value`,`Component_` FROM `Environment`' 3)
    if($environment.Count -ne 2 -or @($environment|Where-Object{$_[1] -ne '[~];[INSTALLFOLDER]' -or $_[0] -notmatch '-'}).Count){throw 'PATH must append one removable installation directory'}
    foreach($context in @(@('CliPathUser','NOT ALLUSERS',$false),@('CliPathMachine','ALLUSERS',$true))){
      $row=@($environment|Where-Object{$_[2] -eq $context[0]})
      if($row.Count -ne 1 -or $row[0][0].Contains('*') -ne $context[2]){throw 'Wrong PATH registry scope'}
      $condition=@(Rows ('SELECT `Condition` FROM `Component` WHERE `Component`='''+$context[0]+'''') 1)[0][0]
      if($condition -ne $context[1]){throw 'PATH components must be mutually exclusive by installation scope'}
    }
    $installedFiles=@(Rows 'SELECT `FileName` FROM `File`' 1|ForEach-Object{$_[0]})
    if(@($installedFiles|Where-Object{$_ -match '(^|\|)node\.exe$'}).Count){throw 'Managed MSI contains a bundled Node executable'}
    if(@($installedFiles|Where-Object{$_ -match '(^|\|)codlet\.json$'}).Count -ne 1 -or @($installedFiles|Where-Object{$_ -match '(^|\|)renderer\.js$'}).Count -ne 1 -or @($installedFiles|Where-Object{$_ -match '(^|\|)host\.cjs$'}).Count){throw 'MSI must contain exactly one renderer GUI package'}
    $guiComponents=@(Rows "SELECT ``Component_`` FROM ``FeatureComponents`` WHERE ``Feature_``='GUI'" 1|ForEach-Object{$_[0]})
    $coreComponents=@(Rows "SELECT ``Component_`` FROM ``FeatureComponents`` WHERE ``Feature_``='Core'" 1|ForEach-Object{$_[0]})
    $pluginFiles=@(Rows 'SELECT `FileName`,`Component_` FROM `File`' 2|Where-Object{$_[0] -match '(^|\|)(codlet\.json|renderer\.js|catalog\.json)$'})
    if($pluginFiles.Count -ne 3 -or @($pluginFiles|Where-Object{$_[1] -notin $guiComponents -or $_[1] -in $coreComponents}).Count){throw 'GUI files must belong exclusively to the optional GUI feature'}
    $choices=@(Rows 'SELECT `Name` FROM `Registry` WHERE `Key` = ''Software\Codlet\Preview\Installer\Plugins''' 1|ForEach-Object{$_[0]})
    if(($choices|Sort-Object)-join ',' -ne 'codlet-gui'){throw 'MSI must persist only the GUI consumer download choice'}
    $shortcuts=@(Rows 'SELECT `Shortcut`,`Target`,`Arguments` FROM `Shortcut`' 3)
    if($shortcuts.Count -ne 2 -or @($shortcuts|Where-Object{$_[1] -ne '[INSTALLFOLDER]Codlet-Launcher.exe' -or $_[2] -like '*--configure*'}).Count){throw 'Only the Start menu and desktop launch shortcuts are allowed'}
    $sequences=@(Rows 'SELECT `Action`,`Sequence` FROM `InstallExecuteSequence`' 2)
    $initialize=[int](@($sequences|Where-Object{$_[0] -eq 'InstallInitialize'})[0][1])
    $removeExisting=[int](@($sequences|Where-Object{$_[0] -eq 'RemoveExistingProducts'})[0][1])
    if($removeExisting -le $initialize){throw 'Upgrade must remove the old product inside the rollback transaction'}
    $preflight=[int](@($sequences|Where-Object{$_[0] -eq 'CheckRunningApplications'})[0][1])
    $validate=[int](@($sequences|Where-Object{$_[0] -eq 'InstallValidate'})[0][1])
    if($preflight -le 0 -or $preflight -ge $validate){throw 'Process check must precede file validation and the transaction'}
    $action=@(Rows "SELECT ``Type``,``Target`` FROM ``CustomAction`` WHERE ``Action``='CheckRunningApplications'" 2)[0]
    if([int]$action[0] -ne 2 -or $action[1] -notlike '*[[]UILevel[]]*' -or $action[1] -notlike '*Codlet-Installer-*'){throw 'MSI preflight must pass UI level and a diagnostic log path'}
    $restart=@(Rows "SELECT ``Value`` FROM ``Property`` WHERE ``Property``='MSIRESTARTMANAGERCONTROL'" 1)[0][0]
    if($restart -ne 'DisableShutdown'){throw 'MSI may automatically close user applications'}
    $cleanup=@(Rows "SELECT ``Sequence``,``Condition`` FROM ``InstallExecuteSequence`` WHERE ``Action``='OfferUserDataCleanup'" 2)[0]
    $finalize=[int](@($sequences|Where-Object{$_[0] -eq 'InstallFinalize'})[0][1])
    if([int]$cleanup[0] -le $finalize -or $cleanup[1] -ne 'Installed AND REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE AND UILevel >= 4'){throw 'Optional cleanup must follow a successful interactive full uninstall, excluding upgrades'}
    $cleanupAction=@(Rows "SELECT ``Type``,``Target`` FROM ``CustomAction`` WHERE ``Action``='OfferUserDataCleanup'" 2)[0]
    if([int]$cleanupAction[0] -ne 66 -or $cleanupAction[1] -ne '--offer-user-cleanup'){throw 'Cleanup must be an impersonated, optional EXE action with no caller-selected data path'}
    $launch=@(Rows "SELECT ``Condition`` FROM ``ControlEvent`` WHERE ``Event``='DoAction' AND ``Argument``='LaunchCodletAfterInstall'" 1)[0][0]
    if($launch -notlike '*WIXUI_EXITDIALOGOPTIONALCHECKBOX*'){throw 'Post-install launch is not opt-in'}
    $report=[ordered]@{schema=1;passed=$true;scope='read-only-msi-structure';features=$featureNames;bundledNode=$false;bundledPlugins=@('codlet-gui');pluginChoices=$choices;guiFeatureOwnsPayload=$true;nativeShortcuts=$shortcuts.Count;preflightBeforeFileValidation=$true;automaticShutdown=$false;optionalLaunch=$true;installationPerformed=$false}
    $report|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $artifacts 'report.json') -Encoding UTF8
    $report|ConvertTo-Json -Compress
  }finally{[Runtime.InteropServices.Marshal]::ReleaseComObject($database)|Out-Null;[Runtime.InteropServices.Marshal]::ReleaseComObject($installer)|Out-Null}
  return
}
$related=@($installer.RelatedProducts('{941C0F18-D41F-46E9-A3D1-A9562D75BF76}'))
if($related.Count -gt 0){throw 'A Codlet MSI is already installed; refuse to replace it during testing'}
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
  Assert (@((Inventory).coreProviders).Count -eq 2) 'Core MSI omitted its internal Codex providers'
  $checks.Add('Core-only MSI runs with no optional plugins')
  Run-Msi -Arguments @('/i',('"'+$msi+'"'),('INSTALLFOLDER="'+$install+'"'),'ADDLOCAL=Core,GUI') -Name 'add-gui'
  Assert ([IO.File]::Exists((Join-Path $install 'optional-plugins/catalog.json'))) 'MSI GUI feature omitted its package'
  $choices=Get-ItemProperty -LiteralPath 'HKCU:/Software/Codlet/Preview/Installer/Plugins'
  Assert ($choices.'codlet-gui' -eq 1) 'GUI consumer download choice was not persisted'
  & (Join-Path $install 'Initialize-Codlet.ps1') -NoLaunch -DataDirectory $data
  Assert (@((Inventory).plugins).Count -eq 1) 'MSI first-launch downloaded an obsolete adapter'
  $checks.Add('GUI MSI feature installs its bundled GUI and uses Core-owned SDK providers')
  & (Join-Path $install 'codlet.exe') plugin disable codlet-gui --json | Out-Null
  Assert ($LASTEXITCODE -eq 0) 'Could not set a user preference'
  Run-Msi -Arguments @('/i',('"'+$msi+'"'),('INSTALLFOLDER="'+$install+'"'),'ADDLOCAL=Core,GUI') -Name 'maintain-gui'
  & (Join-Path $install 'Initialize-Codlet.ps1') -NoLaunch -DataDirectory $data
  $inventory=Inventory
  Assert (@($inventory.plugins).Count -eq 1) 'MSI maintenance changed the GUI-only consumer inventory'
  Assert (@($inventory.plugins|Where-Object{$_.id -eq 'codlet-gui' -and -not $_.enabled}).Count -eq 1) 'MSI modification changed user enablement'
  $checks.Add('MSI maintenance preserves the one consumer and its existing plugin settings')
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
