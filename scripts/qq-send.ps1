# QQ NT message sender (UI automation; QQ has no local API).
# Usage:  .\qq-send.ps1 -TextFile .\msg.txt [-DryRun]
#         .\qq-send.ps1 -TextB64 "5L2g5aW9..."   (UTF-8 text, base64)
# It uses the currently open chat; it never switches chats or reads messages.

param(
  [string]$TextFile,
  [string]$TextB64,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class QqWin32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint data, int extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

if ($TextB64) {
  $Text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TextB64))
} elseif ($TextFile) {
  $Text = [System.IO.File]::ReadAllText((Resolve-Path $TextFile), [System.Text.Encoding]::UTF8)
} else {
  throw 'Provide -TextFile or -TextB64'
}
if ([string]::IsNullOrWhiteSpace($Text)) { throw 'Message text is empty' }

$qq = Get-Process QQ -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'QQ' } | Select-Object -First 1
if (-not $qq) { throw 'QQ main window not found (title should be QQ)' }

[QqWin32]::SetForegroundWindow($qq.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 500
$fg = [QqWin32]::GetForegroundWindow()
if ($fg -ne $qq.MainWindowHandle -and -not $DryRun) { throw 'QQ is not foreground; aborting to avoid typing into another window' }

$r = New-Object QqWin32+RECT
[QqWin32]::GetWindowRect($qq.MainWindowHandle, [ref]$r) | Out-Null
$x = [int](($r.Left + $r.Right) / 2)
$y = [int]($r.Bottom - 30)   # input box sits just above the bottom toolbar

Write-Host ("QQ window: {0},{1} .. {2},{3}" -f $r.Left, $r.Top, $r.Right, $r.Bottom)
Write-Host ("click input at: {0},{1}  text: {2} chars" -f $x, $y, $Text.Length)

if ($DryRun) { Write-Host 'DryRun: nothing sent.'; exit 0 }

[QqWin32]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 150
[QqWin32]::mouse_event(0x0002, 0, 0, 0, 0)
[QqWin32]::mouse_event(0x0004, 0, 0, 0, 0)
Start-Sleep -Milliseconds 350

Set-Clipboard -Value $Text
Start-Sleep -Milliseconds 200
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 400

# Verify the paste really landed in the input (select-all + copy back).
[System.Windows.Forms.SendKeys]::SendWait('^a')
[System.Windows.Forms.SendKeys]::SendWait('^c')
Start-Sleep -Milliseconds 300
$echo = Get-Clipboard -Raw
if ($echo -and $echo.Contains(($Text -replace "`r?`n", ''))) {
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Start-Sleep -Milliseconds 300
  Write-Host 'Sent (paste verified).'
} else {
  Write-Host 'WARN: paste not verified in input; message NOT sent.'
  exit 2
}
