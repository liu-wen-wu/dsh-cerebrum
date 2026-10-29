# 启动 NapCat（QQ 协议端，headless），用于 cerebrum 的 QQ 通道
# 用法： .\qq-napcat-start.ps1            # 若桌面 QQ 在跑会提示
#        .\qq-napcat-start.ps1 -StopQQ    # 自动结束桌面 QQ 再启动（会丢当前 QQ 窗口）
#
# 首次启动后：
#   1. 浏览器打开 http://127.0.0.1:6099 用手机 QQ 扫码登录
#   2. NapCat 会为账号生成 onebot11_<QQ号>.json（HTTP 3000 / token 可在 WebUI 改）
#   3. 之后 cerebrum 配置 qq.enabled=true, qq.friendId=<接收人QQ>, qq.token=<token>

param(
  [switch]$StopQQ
)

$ErrorActionPreference = 'Stop'
$root = 'D:\workspace\tools\napcat\shell'
$launcher = Join-Path $root 'napcat.bat'
$log = Join-Path $root 'napcat.log'
if (-not (Test-Path $launcher)) { throw "NapCat not found at $launcher" }

$qq = Get-Process QQ -ErrorAction SilentlyContinue
if ($qq) {
  if (-not $StopQQ) {
    Write-Host 'WARN: 桌面 QQ 正在运行。同一账号只能有一个在线端；请先关闭 QQ 再运行本脚本，'
    Write-Host '      或加 -StopQQ 让脚本强制结束它。'
    exit 1
  }
  Write-Host 'Stopping desktop QQ...'
  $qq | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

Write-Host "Starting NapCat from $root ..."
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$launcher`" > `"$log`" 2>&1" -WorkingDirectory $root -WindowStyle Hidden
Start-Sleep -Seconds 6

Write-Host 'NapCat 启动中。首次登录请用浏览器打开：'
Write-Host '  http://127.0.0.1:6099   （手机 QQ 扫码）'
Write-Host ''
Write-Host "日志：$log"
Write-Host '登录后检查 OneBot HTTP：'
Write-Host '  curl -X POST http://127.0.0.1:3000/get_login_info'
