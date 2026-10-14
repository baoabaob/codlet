param(
  [Parameter(Mandatory=$true)][string]$Evidence,
  [Parameter(Mandatory=$true)][string]$CoordinatorState,
  [Parameter(Mandatory=$true)][string]$Hwnd
)
# Read-only metadata for an explicitly handed-off live window. Never finds a
# window by title/name, sends input, changes the target DPI context, or moves it.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$proof=[IO.File]::ReadAllText($Evidence)|ConvertFrom-Json
$state=[IO.File]::ReadAllText($CoordinatorState)|ConvertFrom-Json
if($state.state -ne 'ready' -or $state.runId -ne $proof.coordinatorRunId -or $proof.phase -ne 'ready'){throw 'Fresh matching ready evidence required'}
$roots=@($proof.processes|Where-Object {$_.pid -eq $state.desktopPid})
if($roots.Count -ne 1 -or $roots[0].filetime -ne $state.desktopCreated){throw 'Unambiguous Desktop creation identity required'}
if($Hwnd -notmatch '^[1-9][0-9]{0,18}$'){throw 'Explicit decimal HWND required'}
$window=[IntPtr]([long]$Hwnd)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CodletForegroundGeometry {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref Point p);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h,int attr,out Rect r,int size);
}
'@
function RectValue($r){[ordered]@{left=$r.Left;top=$r.Top;right=$r.Right;bottom=$r.Bottom;width=$r.Right-$r.Left;height=$r.Bottom-$r.Top}}
$p=Get-Process -Id $state.desktopPid -ErrorAction Stop
$prior=[IntPtr]::Zero
try {
  $null=$p.Handle
  if($p.HasExited -or $p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne $state.desktopCreated -or $p.Path -ne $roots[0].image){throw 'Desktop handle identity differs'}
  [uint32]$ownerId=0
  $null=[CodletForegroundGeometry]::GetWindowThreadProcessId($window,[ref]$ownerId)
  if(-not [CodletForegroundGeometry]::IsWindow($window) -or $ownerId -ne $p.Id){throw 'HWND does not belong to the retained Desktop identity'}
  # Only this collector thread changes awareness; restore it in finally.
  $prior=[CodletForegroundGeometry]::SetThreadDpiAwarenessContext([IntPtr](-4))
  if($prior -eq [IntPtr]::Zero){throw 'Cannot establish per-monitor-v2 collector coordinate space'}
  $outer=New-Object CodletForegroundGeometry+Rect
  $client=New-Object CodletForegroundGeometry+Rect
  $frame=New-Object CodletForegroundGeometry+Rect
  $origin=New-Object CodletForegroundGeometry+Point
  if(-not [CodletForegroundGeometry]::GetWindowRect($window,[ref]$outer) -or -not [CodletForegroundGeometry]::GetClientRect($window,[ref]$client) -or -not [CodletForegroundGeometry]::ClientToScreen($window,[ref]$origin)){throw 'Window geometry query failed'}
  $dwmResult=[CodletForegroundGeometry]::DwmGetWindowAttribute($window,9,[ref]$frame,16)
  if($p.HasExited){throw 'Desktop exited during geometry capture'}
  [ordered]@{schema=1;capturedAt=[DateTime]::UtcNow.ToString('o');coordinatorRunId=$state.runId;targetId=$proof.targetId;desktopPid=$p.Id;desktopCreated=$state.desktopCreated;hwnd=$Hwnd;
    collectorCoordinates='physical screen pixels, collector thread per-monitor-v2';dpi=[CodletForegroundGeometry]::GetDpiForWindow($window);
    targetDpiAwareness=[CodletForegroundGeometry]::GetAwarenessFromDpiAwarenessContext([CodletForegroundGeometry]::GetWindowDpiAwarenessContext($window));
    visible=[CodletForegroundGeometry]::IsWindowVisible($window);minimized=[CodletForegroundGeometry]::IsIconic($window);maximized=[CodletForegroundGeometry]::IsZoomed($window);foreground=([CodletForegroundGeometry]::GetForegroundWindow() -eq $window);
    windowRect=(RectValue $outer);clientRect=(RectValue $client);clientOrigin=@{x=$origin.X;y=$origin.Y};dwmFrameResult=$dwmResult;dwmFrame=$(if($dwmResult -eq 0){RectValue $frame}else{$null});
    readOnly=$true;windowInputPerformed=$false;mappingVerified=$false;mappingLimit='Client/outer/DWM bounds do not by themselves locate the Owl CSS viewport or a screenshot crop; correlate observed landmarks'}|ConvertTo-Json -Depth 6
} finally {
  if($prior -ne [IntPtr]::Zero){$null=[CodletForegroundGeometry]::SetThreadDpiAwarenessContext($prior)}
  $p.Dispose()
}
