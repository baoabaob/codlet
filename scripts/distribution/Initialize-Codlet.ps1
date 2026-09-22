[CmdletBinding()]
param([switch]$Configure,[switch]$NoLaunch,[string[]]$Plugins,[string]$DataDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$utf8=[Text.UTF8Encoding]::new($false)
$root=[IO.Path]::GetFullPath($PSScriptRoot)
$exe=Join-Path $root 'codlet.exe'
function Full([string]$Path){[IO.Path]::GetFullPath($Path).TrimEnd('\','/')}
function Within([string]$Path,[string]$Parent){
  $pathFull=Full $Path; $parentFull=Full $Parent
  if(-not $pathFull.StartsWith($parentFull+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Path escaped its owned directory'}
}
function Plain([string]$Path){
  for($part=(Full $Path);$part;$part=[IO.Path]::GetDirectoryName($part)){
    if((Test-Path -LiteralPath $part) -and (([IO.File]::GetAttributes($part) -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw "Linked paths are not accepted: $part"}
  }
}
function Hash([string]$Path){
  Plain $Path
  $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  $digest=[Security.Cryptography.SHA256]::Create()
  try{[BitConverter]::ToString($digest.ComputeHash($stream)).Replace('-','').ToLowerInvariant()}finally{$stream.Dispose();$digest.Dispose()}
}
function Save-State {
  Plain $statePath
  $temporary=Join-Path $dataRoot ('plugin-setup-'+[Guid]::NewGuid().ToString('N')+'.tmp')
  [IO.File]::WriteAllText($temporary,($state|ConvertTo-Json -Depth 8),$utf8)
  if([IO.File]::Exists($statePath)){[IO.File]::Replace($temporary,$statePath,[NullString]::Value)}else{[IO.File]::Move($temporary,$statePath)}
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
    if(-not $process.WaitForExit(30000)){try{$process.Kill()}catch{};throw 'Codlet CLI timed out after 30 seconds. No existing client was closed.'}
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
  $form=[Windows.Forms.Form]::new();$form.Text='Codlet · 选择官方插件';$form.ClientSize=[Drawing.Size]::new(570,320);$form.StartPosition='CenterScreen';$form.FormBorderStyle='FixedDialog';$form.MaximizeBox=$false;$form.MinimizeBox=$false
  $form.Font=[Drawing.Font]::new('Microsoft YaHei UI',10)
  if([IO.File]::Exists((Join-Path $root 'codlet.ico'))){$form.Icon=[Drawing.Icon]::new((Join-Path $root 'codlet.ico'))}
  $label=[Windows.Forms.Label]::new();$label.Text="选择希望安装或检查版本的官方插件。GUI 包含 UI Adapter。`n已有插件不会被覆盖；版本不符时会提示手动迁移。";$label.SetBounds(22,18,525,65);$form.Controls.Add($label)
  $boxes=@{};$y=91
  foreach($package in $Available){
    $box=[Windows.Forms.CheckBox]::new();$box.Text=switch($package.id){'codex.ui.adapter'{'UI Adapter — 接入侧栏与插件页面'};'codex.desktop.adapter'{'Desktop Adapter — 提供客户端与对话接口'};'codlet-gui'{'Codlet GUI — 图形化管理插件（包含 UI Adapter）'}}
    $box.SetBounds(24,$y,520,32);$box.Checked=$true;$boxes[$package.id]=$box;$form.Controls.Add($box);$y+=38
  }
  if($boxes.ContainsKey('codlet-gui') -and $boxes.ContainsKey('codex.ui.adapter')){
    $gui=$boxes['codlet-gui'];$ui=$boxes['codex.ui.adapter'];$sync={if($gui.Checked){$ui.Checked=$true;$ui.Enabled=$false}else{$ui.Enabled=$true}}.GetNewClosure();$gui.Add_CheckedChanged($sync);&$sync
  }
  $notice=[Windows.Forms.Label]::new();$notice.Text='新安装插件获得声明的权限；已有插件的授权与禁用状态保留';$notice.SetBounds(22,223,525,32);$form.Controls.Add($notice)
  $ok=[Windows.Forms.Button]::new();$ok.Text='确认';$ok.SetBounds(354,273,90,30);$ok.DialogResult=[Windows.Forms.DialogResult]::OK;$form.Controls.Add($ok);$form.AcceptButton=$ok
  $cancel=[Windows.Forms.Button]::new();$cancel.Text='取消';$cancel.SetBounds(455,273,90,30);$cancel.DialogResult=[Windows.Forms.DialogResult]::Cancel;$form.Controls.Add($cancel);$form.CancelButton=$cancel
  try{if($form.ShowDialog() -ne [Windows.Forms.DialogResult]::OK){throw 'Plugin selection cancelled'};@($Available|Where-Object{$boxes[$_.id].Checked}|ForEach-Object{$_.id})}finally{$form.Dispose()}
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
    $state=@{schema=1;decided=@{}}
    if([IO.File]::Exists($statePath)){
      Plain $statePath
      $saved=[IO.File]::ReadAllText($statePath)|ConvertFrom-Json
      if($saved.schema -ne 1){throw 'Unsupported setup state'}
      foreach($property in $saved.decided.PSObject.Properties){$state.decided[$property.Name]=$property.Value}
    }
    $catalogPath=Join-Path $root 'optional-plugins/catalog.json';Plain $catalogPath
    $catalog=[IO.File]::ReadAllText($catalogPath)|ConvertFrom-Json
    if($catalog.schema -ne 1 -or $catalog.kind -ne 'codlet-official-plugin-bundle'){throw 'Invalid plugin catalog'}
    $allowed=@('codex.ui.adapter','codex.desktop.adapter','codlet-gui')
    $available=@($catalog.packages|Where-Object{[IO.Directory]::Exists((Join-Path $root ('optional-plugins/packages/'+$_.id)))})
    foreach($package in $available){if($package.id -notin $allowed){throw 'Unexpected first-party package'};if($package.id -notmatch '^[a-z0-9.-]+$'){throw 'Invalid package ID'}}
    $explicit=$PSBoundParameters.ContainsKey('Plugins') -or $Configure
    if($PSBoundParameters.ContainsKey('Plugins')){$selected=@($Plugins|Where-Object{$_ -and $_ -ne 'none'})}
    elseif($Configure -or ([IO.File]::Exists((Join-Path $root 'portable.mode')) -and -not [IO.File]::Exists($statePath))){$selected=@(Select-Plugins $available);$explicit=$true}
    else{$selected=@($available|Where-Object{-not $state.decided.ContainsKey($_.id)}|ForEach-Object{$_.id})}
    if('codlet-gui' -in $selected -and 'codex.ui.adapter' -notin $selected){$selected+='codex.ui.adapter'}
    foreach($id in $selected){if($id -notin @($available.id)){throw "Selected package is not installed: $id"}}
    $listing=Invoke-Cli -Arguments @('plugin','list','--json')
    foreach($package in $available){
      $id=[string]$package.id
      if($id -notin $selected){if(-not $state.decided.ContainsKey($id)){$state.decided[$id]=@{selected=$false}};continue}
      # Ordinary launches do not revive removed plugins or replace existing sources.
      $existing=@($listing.plugins|Where-Object{$_.id -eq $id})
      if($existing.Count -gt 0 -and -not $explicit){continue}
      if(-not $explicit -and $state.decided.ContainsKey($id)){continue}
      $source=Join-Path $root ('optional-plugins/packages/'+$id)
      $destination=Join-Path $dataRoot ('packages/'+$id)
      Within $source (Join-Path $root 'optional-plugins/packages');Within $destination $dataRoot;Plain $source;Plain $destination
      $manifestPath=Join-Path $source 'codlet.json';$manifest=[IO.File]::ReadAllText($manifestPath)|ConvertFrom-Json
      if($manifest.id -ne $id -or $manifest.version -ne $package.version){throw 'Plugin manifest/catalog mismatch'}
      if(@(Compare-Object @($manifest.permissions) @($package.permissions)).Count -ne 0){throw 'Plugin permission/catalog mismatch'}
      foreach($file in $package.files){
        if($file.path -notmatch '^[a-zA-Z0-9._/-]+$' -or $file.path.Split('/') -contains '..'){throw 'Invalid package file path'}
        $from=Join-Path $source $file.path;Within $from $source
        if((Hash $from) -ne $file.sha256){throw "Plugin payload changed: $id/$($file.path)"}
      }
      if($existing.Count -gt 0){
        $same=$false
        try{
          if($existing[0].source -eq 'local' -and (Full $existing[0].path) -eq (Full $destination)){
            $same=$true
            foreach($file in $package.files){if((Hash (Join-Path $destination $file.path)) -ne $file.sha256){$same=$false;break}}
          }
        }catch{$same=$false}
        if($same){Write-Host "Official plugin payload already matches; existing settings retained: $id";continue}
        throw "官方插件未更新：$id。当前注册或文件与安装包不同；本预览版不覆盖已有插件目录。请保留作者文件，并通过插件管理检查来源、权限差额后手动迁移。现有启用状态和授权未改变。"
      }
      if(-not [IO.Directory]::Exists($destination)){
        $parent=[IO.Path]::GetDirectoryName($destination);[IO.Directory]::CreateDirectory($parent)|Out-Null
        $stage=Join-Path $parent ('.setup-'+[Guid]::NewGuid().ToString('N'));Within $stage $parent
        [IO.Directory]::CreateDirectory($stage)|Out-Null
        foreach($file in $package.files){$to=Join-Path $stage $file.path;Within $to $stage;[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($to))|Out-Null;[IO.File]::Copy((Join-Path $source $file.path),$to,$false);if((Hash $to) -ne $file.sha256){throw 'Staged plugin failed verification'}}
        [IO.Directory]::Move($stage,$destination)
      }else{
        foreach($file in $package.files){if((Hash (Join-Path $destination $file.path)) -ne $file.sha256){throw "Existing plugin directory differs; inspect it before installing: $destination"}}
      }
      $argsList=@('plugin','add',$destination,'--trust','--enable','--json')
      $configPath=Join-Path $dataRoot 'config.json'
      if([IO.File]::Exists($configPath)){
        $config=[IO.File]::ReadAllText($configPath)|ConvertFrom-Json
        $preference=$null
        $preferences=$config.PSObject.Properties['plugins']
        if($preferences){
          $preference=$preferences.Value.PSObject.Properties[$id]
          if(-not $preference -and $id -eq 'codlet-gui'){$preference=$preferences.Value.PSObject.Properties['codlet']}
        }
        if($preference -and -not $preference.Value.enabled){$argsList=@($argsList|Where-Object{$_ -ne '--enable'})}
      }
      foreach($permission in $package.permissions){$argsList+=@('--grant',[string]$permission)}
      $result=Invoke-Cli $argsList
      $state.decided[$id]=@{selected=$true;result='installed';version=$package.version;source='official-installer';path=(Full $destination);files=@($package.files);catalogSha256=(Hash $catalogPath)}
      Save-State
    }
    Save-State
    $reviewedPath=Join-Path $dataRoot 'plugin-bundle-reviewed.txt';Plain $reviewedPath
    [IO.File]::WriteAllText($reviewedPath,(Hash $catalogPath).ToUpperInvariant(),$utf8)
    Write-Host ('Codlet plugin setup ready: '+$dataRoot)
  }finally{if($setupLock){$setupLock.Dispose()}}
  if(-not $NoLaunch){& $exe launch;exit $LASTEXITCODE}
}catch{Write-Error $_ -ErrorAction Continue;if($_.Exception.Message.StartsWith('官方插件未更新：')){exit 20};exit 1}
