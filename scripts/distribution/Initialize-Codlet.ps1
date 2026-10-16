[CmdletBinding()]
param([switch]$Configure,[switch]$NoLaunch,[string[]]$Plugins,[string]$DataDirectory,[string[]]$ApproveNewPermissions)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$utf8=[Text.UTF8Encoding]::new($false)
if($MyInvocation.InvocationName -ne '.'){
  # The native launcher decodes both redirected PowerShell streams as UTF-8.
  # Dot-sourced diagnostic callers retain their own console encoding.
  [Console]::OutputEncoding=$utf8
  $OutputEncoding=$utf8
}
$root=[IO.Path]::GetFullPath($PSScriptRoot)
$exe=Join-Path $root 'codlet.exe'
function Full([string]$Path){[IO.Path]::GetFullPath($Path).TrimEnd('\','/')}
function Plain([string]$Path){
  for($part=(Full $Path);$part;$part=[IO.Path]::GetDirectoryName($part)){
    if((Test-Path -LiteralPath $part) -and (([IO.File]::GetAttributes($part) -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw "Linked paths are not accepted: $part"}
  }
}
function Save-State {
  Plain $statePath
  $temporary=Join-Path $dataRoot ('plugin-setup-'+[Guid]::NewGuid().ToString('N')+'.tmp')
  [IO.File]::WriteAllText($temporary,($state|ConvertTo-Json -Depth 8),$utf8)
  if([IO.File]::Exists($statePath)){[IO.File]::Replace($temporary,$statePath,[NullString]::Value)}else{[IO.File]::Move($temporary,$statePath)}
}
function Decision-Result([string]$Id){
  $decision=$state.decided[$Id]
  if($decision -is [Collections.IDictionary]){return [string]$decision['result']}
  if($decision -and $decision.PSObject.Properties['result']){return [string]$decision.result}
  return ''
}
function Invoke-Cli([string[]]$Arguments){
  # Decode the pipe explicitly, independently of the console's OEM/ANSI page.
  # Only this short-lived CLI child is terminated on timeout, never the runtime.
  $info=[Diagnostics.ProcessStartInfo]::new($exe)
  $quoted=@($Arguments|ForEach-Object{'"'+[regex]::Replace([regex]::Replace($_,'(\\*)"','$1$1\"'),'(\\+)$','$1$1')+'"'})
  $info.Arguments=$quoted -join ' ';$info.UseShellExecute=$false;$info.CreateNoWindow=$true
  $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  $info.StandardOutputEncoding=$utf8;$info.StandardErrorEncoding=$utf8
  $process=[Diagnostics.Process]::Start($info)
  try{
    $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
    if(-not $process.WaitForExit(120000)){try{$process.Kill()}catch{};throw 'Codlet CLI timed out. No existing client was closed; inspect the operation before retrying a mutation.'}
    if(-not $stdout.Wait(1000) -or -not $stderr.Wait(1000)){throw 'Codlet CLI output did not close'}
    $text=$stdout.Result
    if($process.ExitCode -ne 0){throw "Codlet CLI failed ($($process.ExitCode)): $text $($stderr.Result)"}
    $text|ConvertFrom-Json
  }finally{$process.Dispose()}
}
function Select-Plugins($Available){
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [Windows.Forms.Application]::EnableVisualStyles()
  $form=[Windows.Forms.Form]::new();$form.Text='Codlet · 安装选项';$form.ClientSize=[Drawing.Size]::new(570,220);$form.StartPosition='CenterScreen';$form.FormBorderStyle='FixedDialog';$form.MaximizeBox=$false;$form.MinimizeBox=$false
  $form.Font=[Drawing.Font]::new('Microsoft YaHei UI',10)
  if([IO.File]::Exists((Join-Path $root 'codlet.ico'))){$form.Icon=[Drawing.Icon]::new((Join-Path $root 'codlet.ico'))}
  $label=[Windows.Forms.Label]::new();$label.Text='选择需要安装的组件';$label.SetBounds(22,18,525,36);$form.Controls.Add($label)
  $boxes=@{};$y=65
  foreach($package in $Available){
    $box=[Windows.Forms.CheckBox]::new();$box.Text=switch($package.id){'codlet-gui'{'Codlet 管理界面'}}
    $box.SetBounds(24,$y,520,32);$box.Checked=$true;$boxes[$package.id]=$box;$form.Controls.Add($box);$y+=38
  }
  $ok=[Windows.Forms.Button]::new();$ok.Text='确认';$ok.SetBounds(354,173,90,30);$ok.DialogResult=[Windows.Forms.DialogResult]::OK;$form.Controls.Add($ok);$form.AcceptButton=$ok
  $cancel=[Windows.Forms.Button]::new();$cancel.Text='取消';$cancel.SetBounds(455,173,90,30);$cancel.DialogResult=[Windows.Forms.DialogResult]::Cancel;$form.Controls.Add($cancel);$form.CancelButton=$cancel
  try{if($form.ShowDialog() -ne [Windows.Forms.DialogResult]::OK){throw 'Plugin selection cancelled'};@($Available|Where-Object{$boxes[$_.id].Checked}|ForEach-Object{$_.id})}finally{$form.Dispose()}
}
function Invoke-DownloadCli([string[]]$Arguments){
  for($attempt=0;;$attempt++){
    try{return Invoke-Cli -Arguments $Arguments}
    catch{if($attempt -ge 1 -or $_.Exception.Message -notmatch 'github_network|github_timeout|Could not connect to GitHub|GitHub request timed out'){throw};Start-Sleep -Seconds 1}
  }
}

try{
  if($DataDirectory){if(-not [IO.Path]::IsPathRooted($DataDirectory)){throw 'DataDirectory must be absolute'};$dataRoot=Full $DataDirectory}
  elseif($env:CODLET_HOME){if(-not [IO.Path]::IsPathRooted($env:CODLET_HOME)){throw 'CODLET_HOME must be absolute'};$dataRoot=Full $env:CODLET_HOME}
  elseif([IO.File]::Exists((Join-Path $root 'portable.mode'))){$dataRoot=Join-Path $root 'data'}
  else{$dataRoot=Join-Path $env:LOCALAPPDATA 'Codlet'}
  Plain $root;Plain $dataRoot
  if(-not [IO.Path]::IsPathRooted($dataRoot)){throw 'Choose a data subdirectory, not a drive root'}
  $env:CODLET_HOME=$dataRoot
  [IO.Directory]::CreateDirectory($dataRoot)|Out-Null
  $setupLock=[IO.File]::Open((Join-Path $dataRoot 'plugin-setup.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{
    $statePath=Join-Path $dataRoot 'plugin-setup.json'
    $firstSetup=-not [IO.File]::Exists($statePath)
    $state=@{schema=1;decided=@{}}
    if([IO.File]::Exists($statePath)){
      Plain $statePath
      $saved=[IO.File]::ReadAllText($statePath)|ConvertFrom-Json
      if($saved.schema -ne 1){throw 'Unsupported setup state'}
      foreach($property in $saved.decided.PSObject.Properties){$state.decided[$property.Name]=$property.Value}
    }
    $catalogPath=Join-Path $root 'official-plugins.json';Plain $catalogPath
    $catalog=[IO.File]::ReadAllText($catalogPath)|ConvertFrom-Json
    if($catalog.schema -ne 1 -or $catalog.kind -ne 'codlet-plugin-download-options'){throw 'Invalid plugin download options'}
    $bundledCatalog=$null
    if($catalog.PSObject.Properties['bundledCatalog']){
      if($catalog.bundledCatalog -cne 'optional-plugins/catalog.json'){throw 'Invalid bundled plugin catalog path'}
      $bundledCatalog=Join-Path $root $catalog.bundledCatalog
      Plain $bundledCatalog
    }
    $allowed=@('codlet-gui')
    $available=@($catalog.plugins)
    if(@($available|ForEach-Object{$_.id}|Sort-Object -Unique).Count -ne $available.Count){throw 'Duplicate download option'}
    foreach($package in $available){if($package.id -notin $allowed -or $package.repositoryUrl -notmatch '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $package.repositoryId -le 0 -or $package.ownerId -le 0 -or @($package.dependencies|Where-Object{$_ -notin $allowed}).Count){throw 'Invalid plugin download option'}}
    $explicit=$PSBoundParameters.ContainsKey('Plugins') -or $Configure
    if($PSBoundParameters.ContainsKey('Plugins')){$selected=@($Plugins|Where-Object{$_ -and $_ -ne 'none'})}
    elseif($Configure -or ([IO.File]::Exists((Join-Path $root 'portable.mode')) -and $firstSetup)){$selected=@(Select-Plugins $available);$explicit=$true}
    elseif([IO.File]::Exists((Join-Path $root 'msi-install.json'))){
      $choices=$null
      foreach($hive in @('HKCU:','HKLM:')){
        $registration=Get-ItemProperty -LiteralPath ($hive+'\Software\Codlet\Preview\Installer') -ErrorAction SilentlyContinue
        if($registration -and $registration.PSObject.Properties['InstallFolder'] -and (Full $registration.InstallFolder) -ieq (Full $root)){
          $choices=Get-ItemProperty -LiteralPath ($hive+'\Software\Codlet\Preview\Installer\Plugins') -ErrorAction SilentlyContinue
          break
        }
      }
      $selected=@($available|Where-Object{$choices -and $choices.PSObject.Properties[$_.id] -and $choices.($_.id) -eq 1}|ForEach-Object{$_.id})
    }else{$selected=@($available|Where-Object{$state.decided.ContainsKey($_.id) -and ($bundledCatalog -and $state.decided[$_.id].selected -or (Decision-Result $_.id) -eq 'pending')}|ForEach-Object{$_.id})}
    # Old setup selections may still name the adapters. Core now supplies those
    # capabilities; retain old decisions on disk but never download duplicates.
    $selected=@($selected|Where-Object{$_ -notin @('codex.ui.adapter','codex.desktop.adapter')})
    foreach($id in $selected){if($id -notin @($available.id)){throw "Selected plugin is unavailable: $id"}}
    if($bundledCatalog -and $selected.Count -gt 0 -and -not [IO.File]::Exists($bundledCatalog)){throw '安装目录中缺少管理界面组件。请重新运行 Codlet 安装程序并勾选“安装 Codlet 管理界面”。'}
    $listing=Invoke-Cli -Arguments @('plugin','list','--json')
    # Persist the entire selection before the first network operation. Otherwise
    # a failure in a dependency could forget plugins later in the same selection.
    foreach($id in $selected){
      $present=@($listing.plugins|Where-Object{$_.id -eq $id}).Count -gt 0
      if(-not $present -and ($explicit -or -not $state.decided.ContainsKey($id) -or -not $state.decided[$id].selected -or (Decision-Result $id) -eq 'pending')){
        $state.decided[$id]=@{selected=$true;result='pending'}
      }
    }
    Save-State
    foreach($package in $available){
      $id=[string]$package.id
      if($id -notin $selected){if(-not $state.decided.ContainsKey($id) -or ($explicit -and (Decision-Result $id) -eq 'pending')){$state.decided[$id]=@{selected=$false;result='declined'}};continue}
      $existing=@($listing.plugins|Where-Object{$_.id -eq $id})
      # A removed plugin stays removed unless the user selects it again explicitly.
      if($existing.Count -eq 0 -and -not $explicit -and $state.decided.ContainsKey($id) -and $state.decided[$id].selected -and (Decision-Result $id) -ne 'pending'){continue}
      if($bundledCatalog){
        try{$preview=Invoke-Cli -Arguments @('plugin','seed','preview',$bundledCatalog,$id,'--json')}
        catch{
          if($existing.Count -gt 0 -and $_.Exception.Message -match 'official_seed_source_changed'){
            $state.decided[$id]=@{selected=$true;result='existing';source='custom'}
            Write-Warning '现有 Codlet 管理界面使用自定义来源；可在插件管理中更新。'
            Save-State;continue
          }
          throw
        }
        if($preview.outcome -eq 'current'){
          $state.decided[$id]=@{selected=$true;result='existing';version=$preview.version;source=$preview.source;path=$preview.path}
          Save-State;continue
        }
        $permissions=@($preview.addedPermissions)
        $unapproved=@($permissions|Where-Object{$_ -notin $package.permissions -and $_ -notin $ApproveNewPermissions})
        if($unapproved.Count){throw "安装 $id 需要明确批准新增权限：$($unapproved -join ', ')。请使用 -ApproveNewPermissions 指定这些权限。"}
        $argsList=@('plugin','seed','install',$bundledCatalog,$id,'--preview',[string]$preview.preview,'--json')
        foreach($permission in $permissions){$argsList+=@('--grant',[string]$permission)}
        $result=Invoke-Cli -Arguments $argsList
        $state.decided[$id]=@{selected=$true;result='installed';version=$result.version;source='official-installer';path=$result.path}
        Save-State;continue
      }
      if($existing.Count -gt 0){if(-not $state.decided.ContainsKey($id) -or (Decision-Result $id) -eq 'pending'){$state.decided[$id]=@{selected=$true;result='existing'}};continue}
      if(-not $explicit -and $state.decided.ContainsKey($id) -and $state.decided[$id].selected -and (Decision-Result $id) -ne 'pending'){continue}
      $state.decided[$id]=@{selected=$true;result='pending'};Save-State
      $releases=Invoke-DownloadCli -Arguments @('plugin','github','releases',($package.repositoryUrl+'/releases/latest'),'--json')
      if(@($releases.releases).Count -ne 1){throw "No unique published release for $id"}
      $release=$releases.releases[0]
      if($release.prerelease -or $release.tag -notmatch '^v(\d+\.\d+\.\d+)$'){throw 'Expected a published stable plugin release'}
      $version=$Matches[1]
      $assets=@($release.assets|Where-Object{$_.name -ceq ($id+'-'+$version+'.zip')})
      if($assets.Count -ne 1){throw "No unique plugin ZIP in $($release.tag)"}
      $preview=Invoke-DownloadCli -Arguments @('plugin','github','preview',$package.repositoryUrl,'--release',[string]$release.id,'--asset',[string]$assets[0].id,'--json')
      if($preview.manifest.id -cne $id -or $preview.manifest.version -cne $version -or $preview.source.repositoryUrl -cne $package.repositoryUrl -or $preview.source.repositoryId -ne $package.repositoryId -or $preview.source.ownerId -ne $package.ownerId -or -not $preview.source.upstreamDigestVerified){throw "Plugin identity or download digest mismatch: $id"}
      $permissions=@($preview.manifest.permissions)
      $unapproved=@($permissions|Where-Object{$_ -notin $package.permissions -and $_ -notin $ApproveNewPermissions})
      if($unapproved.Count -gt 0){
        if($PSBoundParameters.ContainsKey('Plugins')){throw "安装 $id 需要明确批准新增权限：$($unapproved -join ', ')。请使用 -ApproveNewPermissions 指定这些权限。"}
        Add-Type -AssemblyName System.Windows.Forms
        if([Windows.Forms.MessageBox]::Show("$id 的最新版本还需要以下权限：`n`n$($unapproved -join "`n")`n`n是否批准？",'Codlet · 新增插件权限',[Windows.Forms.MessageBoxButtons]::YesNo,[Windows.Forms.MessageBoxIcon]::Question) -ne [Windows.Forms.DialogResult]::Yes){throw "未批准 $id 的新增权限；该插件未安装。"}
      }
      $argsList=@('plugin','github','install',[string]$preview.path,'--trust','--json')
      foreach($permission in $permissions){$argsList+=@('--grant',[string]$permission)}
      if($preview.existingEnabled){$argsList+='--enable'}
      $result=Invoke-Cli -Arguments $argsList
      $state.decided[$id]=@{selected=$true;result='installed';version=$version;source='github';repositoryUrl=$package.repositoryUrl}
      Save-State
    }
    Save-State
    Write-Host ('Codlet plugin setup ready: '+$dataRoot)
  }finally{if($setupLock){$setupLock.Dispose()}}
  if(-not $NoLaunch){& $exe launch;exit $LASTEXITCODE}
}catch{if($_.Exception.Message -eq 'Plugin selection cancelled'){exit 1223};Write-Error $_ -ErrorAction Continue;exit 1}
