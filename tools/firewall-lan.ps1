# 局域网直连开关：允许/禁止同一局域网（LocalSubnet）访问 7801 端口
#
# 用法（需要管理员权限）：
#   .\tools\firewall-lan.ps1 -Enable     # 允许局域网直连
#   .\tools\firewall-lan.ps1 -Disable    # 禁止局域网直连（只保留 Tailscale 等规则）
#   .\tools\firewall-lan.ps1 -Status     # 查看状态
param(
    [switch]$Enable,
    [switch]$Disable,
    [switch]$Status
)

$ErrorActionPreference = 'Stop'
$ruleName = 'dshremote LAN TCP 7801'

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue

if ($Status -or (-not $Enable -and -not $Disable)) {
    if ($existing -and $existing.Enabled -eq 'True') {
        Write-Host '局域网直连：已允许（LocalSubnet -> 7801）' -ForegroundColor Green
    } else {
        Write-Host '局域网直连：未允许' -ForegroundColor Yellow
    }
    exit 0
}

if (-not (Test-Admin)) {
    Write-Host '需要管理员权限：请右键「以管理员身份运行」PowerShell 后重试。' -ForegroundColor Red
    exit 1
}

if ($Enable) {
    if ($existing) {
        Enable-NetFirewallRule -DisplayName $ruleName | Out-Null
    } else {
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP `
            -LocalPort 7801 -RemoteAddress 'LocalSubnet' -Profile Any | Out-Null
    }
    Write-Host '已允许局域网访问 7801。' -ForegroundColor Green
} else {
    if ($existing) {
        Remove-NetFirewallRule -DisplayName $ruleName
        Write-Host '已禁止局域网直连 7801（Tailscale 访问不受影响）。' -ForegroundColor Green
    } else {
        Write-Host '本来就是禁止状态。' -ForegroundColor DarkGray
    }
}
