# 允许 dshremote daemon 的端口被局域网 / WireGuard 访问（需要以管理员身份运行 PowerShell）
# 用法：右键 PowerShell「以管理员身份运行」→  .\tools\firewall-allow.ps1
#      .\tools\firewall-allow.ps1 -Port 7801
param(
    [int]$Port = 7801
)

$ErrorActionPreference = 'Stop'
$ruleName = "dshremote daemon TCP $Port"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
    Write-Host '需要管理员权限：请以“管理员身份”重新打开 PowerShell 再执行本脚本。' -ForegroundColor Yellow
    exit 1
}

$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "防火墙规则已存在: $ruleName" -ForegroundColor Green
    exit 0
}

# WireGuard 网卡在 Windows 里可能被识别为“公用网络”，所以 Private/Public 都放行；
# 端口后面还有设备令牌鉴权，不是裸奔。
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP `
    -LocalPort $Port -Profile Private, Public | Out-Null

Write-Host "已放行 TCP 端口 $Port（专用/公用网络）" -ForegroundColor Green
Write-Host '现在手机（同一局域网或 WireGuard）可以访问 daemon 了。'
