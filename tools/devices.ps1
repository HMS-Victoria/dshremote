# 查看已配对设备 / 吊销设备 / 清理旧设备（仅本机可调用 daemon 的 loopback 管理接口）
# 用法：
#   .\tools\devices.ps1                  # 列出所有设备
#   .\tools\devices.ps1 -Revoke <id>     # 吊销指定设备（丢手机时用）
#   .\tools\devices.ps1 -Rotate          # 轮换配对码（作废旧码并打印新码）
#   .\tools\devices.ps1 -Prune           # 清理超过 1 天未使用的设备
#   .\tools\devices.ps1 -Prune -Days 7   # 清理超过 7 天未使用的设备
param(
    [string]$Revoke = '',
    [switch]$Rotate,
    [switch]$Prune,
    [int]$Days = 1
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runtimeFile = Join-Path $root '.data\runtime.json'
$port = 7801
if (Test-Path $runtimeFile) {
    $runtime = Get-Content $runtimeFile -Raw | ConvertFrom-Json
    if ($runtime.listen -and $runtime.listen.port) { $port = [int]$runtime.listen.port }
}
$base = 'http://127.0.0.1:' + $port

try {
    if ($Revoke -ne '') {
        $body = @{ id = $Revoke } | ConvertTo-Json
        $result = Invoke-RestMethod ($base + '/__dshremote/devices/revoke') -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 5
        if ($result.removed) {
            Write-Host ('已吊销设备: ' + $Revoke) -ForegroundColor Green
        } else {
            Write-Host ('未找到设备: ' + $Revoke) -ForegroundColor Yellow
        }
        exit 0
    }

    if ($Rotate) {
        $result = Invoke-RestMethod ($base + '/__dshremote/pairing/rotate') -Method Post -TimeoutSec 5
        Write-Host ('新配对码: ' + $result.code) -ForegroundColor Green
        exit 0
    }

    $devices = @((Invoke-RestMethod ($base + '/__dshremote/devices') -TimeoutSec 5).devices)

    if ($Prune) {
        $cutoff = (Get-Date).AddDays(-$Days)
        $stale = @($devices | Where-Object {
            $seen = $_.lastSeenAt
            if (-not $seen) { return $true }
            return ([datetime]$seen) -lt $cutoff
        })
        if ($stale.Count -eq 0) {
            Write-Host ('没有超过 ' + $Days + ' 天未使用的设备') -ForegroundColor Green
            exit 0
        }
        foreach ($device in $stale) {
            $body = @{ id = $device.id } | ConvertTo-Json
            Invoke-RestMethod ($base + '/__dshremote/devices/revoke') -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 5 | Out-Null
            Write-Host ('  已清理 ' + $device.id + ' (' + $device.name + ')')
        }
        Write-Host ('共清理 ' + $stale.Count + ' 台超过 ' + $Days + ' 天未使用的设备') -ForegroundColor Green
        exit 0
    }

    Write-Host ''
    Write-Host (' 已配对设备（daemon 端口 ' + $port + '）') -ForegroundColor DarkGray
    if ($devices.Count -eq 0) {
        Write-Host '  （暂无）'
    } else {
        foreach ($device in $devices) {
            $seen = if ($device.lastSeenAt) { ([datetime]$device.lastSeenAt).ToString('yyyy-MM-dd HH:mm') } else { '从未' }
            Write-Host ('  ' + $device.id + '  ' + $device.name + '   最近使用: ' + $seen)
        }
    }
    Write-Host ''
    Write-Host ' 吊销: .\tools\devices.ps1 -Revoke <id>' -ForegroundColor DarkGray
    Write-Host ' 清理旧设备: .\tools\devices.ps1 -Prune' -ForegroundColor DarkGray
    Write-Host ''
} catch {
    Write-Host '无法连接 daemon（是否已启动？）' -ForegroundColor Yellow
    exit 1
}
