# Captures the main window of a process into a PNG, for
# screenshot-desktop.sh on Windows.
#
#   screenshot-window.ps1 -ProcessId <pid> -Path <file.png>
param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$Path
)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win {
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(
        IntPtr hwnd, int attribute, out Rect rect, int size);
}
"@
[void][Win]::SetProcessDPIAware()

$handle = [IntPtr]::Zero
for ($i = 0; $i -lt 30 -and $handle -eq [IntPtr]::Zero; $i++) {
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($process) { $handle = $process.MainWindowHandle }
    if ($handle -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 500 }
}
if ($handle -eq [IntPtr]::Zero) { throw "process $ProcessId has no window" }

[void][Win]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds 500
# DWMWA_EXTENDED_FRAME_BOUNDS: the visible frame, without the resize border.
$rect = New-Object Win+Rect
[void][Win]::DwmGetWindowAttribute($handle, 9, [ref]$rect, 16)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
$bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
