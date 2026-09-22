[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OutputDirectory,[switch]$InstallerAssets)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$output=[IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($output)|Out-Null
$source=Join-Path $PSScriptRoot 'installer'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if(-not [IO.File]::Exists($compiler)){throw '.NET Framework 4.x x64 compiler is required'}
$common=@('/nologo','/optimize+','/platform:x64','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Core.dll')
& $compiler @common /target:winexe /reference:System.Web.Extensions.dll ('/win32icon:'+(Join-Path $root 'assets/codlet/ico/codlet.ico')) ('/win32manifest:'+(Join-Path $source 'launcher.manifest')) ('/out:'+(Join-Path $output 'Codlet-Launcher.exe')) (Join-Path $source 'ProcessGate.cs') (Join-Path $source 'DetachedHost.cs') (Join-Path $source 'Launcher.cs')
if($LASTEXITCODE -ne 0){throw 'Launcher compilation failed'}
if($InstallerAssets){
  & $compiler @common /target:winexe ('/win32manifest:'+(Join-Path $source 'launcher.manifest')) ('/out:'+(Join-Path $output 'Codlet-Installer-Preflight.exe')) (Join-Path $source 'ProcessGate.cs') (Join-Path $source 'InstallerPreflight.cs')
  if($LASTEXITCODE -ne 0){throw 'Installer preflight compilation failed'}
  Add-Type -AssemblyName System.Drawing
  foreach($spec in @(@('banner.bmp',493,58),@('dialog.bmp',493,312))){
    $bitmap=[Drawing.Bitmap]::new([int]$spec[1],[int]$spec[2]);$graphics=[Drawing.Graphics]::FromImage($bitmap)
    try{
      $graphics.Clear([Drawing.Color]::White)
      $width=if($spec[0] -eq 'banner.bmp'){115}else{164}
      $left=if($spec[0] -eq 'banner.bmp'){378}else{0}
      $rectangle=[Drawing.Rectangle]::new($left,0,$width,[int]$spec[2])
      $brush=[Drawing.Drawing2D.LinearGradientBrush]::new($rectangle,[Drawing.Color]::FromArgb(22,33,50),[Drawing.Color]::FromArgb(39,76,84),[single]75)
      try{$graphics.FillRectangle($brush,$rectangle)}finally{$brush.Dispose()}
      $font=[Drawing.Font]::new('Segoe UI',$(if($spec[0] -eq 'banner.bmp'){16}else{22}),[Drawing.FontStyle]::Bold)
      try{$graphics.DrawString('Codlet',$font,[Drawing.Brushes]::White,[single]$(if($spec[0] -eq 'banner.bmp'){388}else{20}),[single]$(if($spec[0] -eq 'banner.bmp'){14}else{35}))}finally{$font.Dispose()}
      $bitmap.Save((Join-Path $output $spec[0]),[Drawing.Imaging.ImageFormat]::Bmp)
    }finally{$graphics.Dispose();$bitmap.Dispose()}
  }
}
[pscustomobject]@{launcher=(Join-Path $output 'Codlet-Launcher.exe');customAction=$(if($InstallerAssets){Join-Path $output 'Codlet-Installer-Preflight.exe'})}|ConvertTo-Json -Compress
