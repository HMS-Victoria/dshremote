# 安装「登录 Windows 后自动在后台启动 dshremote daemon」的计划任务。
# 用法：.\tools\install-autostart.ps1
#      .\tools\install-autostart.ps1 -Uninstall   # 卸载
param(
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$taskName = 'DshRemoteDaemon'
$startScript = Join-Path $root 'tools\start.ps1'

if ($Uninstall) {
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host '已移除开机自启任务' -ForegroundColor Green
    } else {
        Write-Host '没有找到开机自启任务' -ForegroundColor Yellow
    }
    exit 0
}

$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path $powerShell)) { throw "找不到 powershell.exe: $powerShell" }

$action = New-ScheduledTaskAction -Execute $powerShell `
    -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $startScript + '" -Background') `
    -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host ('已安装开机自启任务: ' + $taskName) -ForegroundColor Green
Write-Host '下次登录 Windows 后 daemon 会自动在后台启动（接管模式会等桌面 DSH 起来后自动切换）。'
Write-Host '卸载: .\tools\install-autostart.ps1 -Uninstall'
