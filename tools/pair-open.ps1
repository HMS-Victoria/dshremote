# 临时开启「公网配对窗口」（默认 5 分钟）
#
# 说明：配置了 publicUrl（公网地址）后，通过公网访问配对页/配对接口
# 默认是被拒绝的。需要给新设备配对时，先在电脑上运行本脚本，窗口期内手机扫码即可配对；
# 窗口结束或配对成功后自动关闭。
#
# 用法：
#   .\tools\pair-open.ps1            # 打开 5 分钟窗口并显示二维码
#   .\tools\pair-open.ps1 -Minutes 10 -NoBrowser
param(
    [int]$Minutes = 5,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runtimeFile = Join-Path $root '.data\runtime.json'
$port = 7801
if (Test-Path $runtimeFile) {
    $runtime = Get-Content $runtimeFile -Raw | ConvertFrom-Json -ErrorAction SilentlyContinue
    if ($runtime -and $runtime.listen -and $runtime.listen.port) { $port = [int]$runtime.listen.port }
}

$body = @{ minutes = $Minutes } | ConvertTo-Json
try {
    $result = Invoke-RestMethod ("http://127.0.0.1:" + $port + "/__dshremote/pairing/open-window") -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 8
} catch {
    Write-Host '无法连接 daemon（是否已启动？）' -ForegroundColor Yellow
    exit 1
}

Write-Host ''
Write-Host ('公网配对已开启，窗口 ' + $result.minutes + ' 分钟（到 ' + ([datetime]$result.windowUntil).ToLocalTime().ToString('HH:mm:ss') + '）') -ForegroundColor Green
Write-Host ('新配对码: ' + $result.code) -ForegroundColor Green
if ($result.publicUrl) {
    Write-Host ('公网配对地址: ' + $result.publicUrl + '/pair?code=' + $result.code)
}
Write-Host ''
Write-Host '用手机扫码或输入上面配对码即可；配对成功后窗口自动关闭。'

if (-not $NoBrowser) {
    Start-Process ("http://127.0.0.1:" + $port + '/pair')
}
