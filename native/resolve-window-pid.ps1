param([long]$Hwnd)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W32Resolve {
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@

$procId = 0
[W32Resolve]::GetWindowThreadProcessId([IntPtr]$Hwnd, [ref]$procId) | Out-Null
Write-Output $procId
