# Janelas minimizadas (o Chromium não lista essas pra compartilhar, porque o
# Windows não deixa capturar janela minimizada). Sem parâmetro: devolve as
# janelas minimizadas em JSON. Com -Restore <hwnd>: restaura essa janela.
param([long]$Restore = 0)

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class W32Min {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);

    public static List<string> Minimized() {
        var list = new List<string>();
        EnumWindows((h, l) => {
            if (!IsWindowVisible(h) || !IsIconic(h)) return true;
            if (GetWindow(h, 4) != IntPtr.Zero) return true;            // GW_OWNER: janela "filha" (diálogo)
            if ((GetWindowLong(h, -20) & 0x80) != 0) return true;        // WS_EX_TOOLWINDOW
            var sb = new StringBuilder(512);
            GetWindowText(h, sb, sb.Capacity);
            if (sb.Length == 0) return true;
            list.Add(h.ToInt64() + "\t" + sb.ToString());
            return true;
        }, IntPtr.Zero);
        return list;
    }
}
"@

if ($Restore -ne 0) {
    [W32Min]::ShowWindow([IntPtr]$Restore, 9) | Out-Null   # SW_RESTORE
    Write-Output "ok"
    exit 0
}

# Uma janela por linha: "<hwnd>\t<título>" (mais simples de ler no Node que JSON
# do PowerShell, que muda de formato quando só tem 1 item)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[W32Min]::Minimized() | ForEach-Object { Write-Output $_ }
