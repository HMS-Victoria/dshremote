# 查看 dshremote daemon 的最近诊断事件（WS 握手/关闭、API 请求）
# 用法：.\tools\diag.ps1 [-Ip 192.168.1.10] [-Limit 40]
param(
    [string]$Ip = '',
    [int]$Limit = 40
)

$ErrorActionPreference = 'Stop'
try {
    $diag = Invoke-RestMethod 'http://127.0.0.1:7801/__dshremote/diag' -TimeoutSec 5
} catch {
    Write-Host '无法连接 daemon（可能未启动）' -ForegroundColor Yellow
    exit 1
}

$events = @($diag.events)
if ($Ip) { $events = @($events | Where-Object { $_.ip -eq $Ip }) }

Write-Host ''
Write-Host (' 事件总数: ' + @($diag.events).Count + '  当前过滤: ' + $(if ($Ip) { $Ip } else { '全部' })) -ForegroundColor DarkGray
$events | Select-Object -Last $Limit | ForEach-Object {
    $when = ([datetime]$_.at).ToLocalTime().ToString('HH:mm:ss')
    switch ($_.kind) {
        'ws-upgrade' { Write-Host (" {0}  WS升级  ip={1} auth={2} cookie={3} origin={4}" -f $when, $_.ip, $_.authenticated, $_.cookiePresent, $_.origin) -ForegroundColor Cyan }
        'ws-upstream' { Write-Host (" {0}  上游响应 {1}" -f $when, $_.statusLine) -ForegroundColor Green }
        'ws-close' { Write-Host (" {0}  WS关闭  ip={1} 存活={2}ms" -f $when, $_.ip, $_.ms) -ForegroundColor DarkGray }
        'ws-error' { Write-Host (" {0}  WS错误  {1}" -f $when, $_.error) -ForegroundColor Red }
        'unauthorized' { Write-Host (" {0}  未授权  ip={1} path={2}" -f $when, $_.ip, $_.path) -ForegroundColor Yellow }
        'api' { Write-Host (" {0}  API {1,-4} {2} -> {3}" -f $when, $_.method, $_.path, $_.status) }
        default { Write-Host (" {0}  {1}" -f $when, ($_ | ConvertTo-Json -Compress)) }
    }
}
Write-Host ''
