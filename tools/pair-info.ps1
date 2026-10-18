# 显示当前 daemon 的配对码与手机访问地址
# 用法：在项目根目录执行  .\tools\pair-info.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pairingFile = Join-Path $root '.data\pairing.json'
$runtimeFile = Join-Path $root '.data\runtime.json'

if (-not (Test-Path $pairingFile)) {
    Write-Host '还没有 pairing.json —— 请先启动 daemon：.\tools\start.ps1' -ForegroundColor Yellow
    exit 1
}

$pairing = Get-Content $pairingFile -Raw | ConvertFrom-Json
$runtime = if (Test-Path $runtimeFile) { Get-Content $runtimeFile -Raw | ConvertFrom-Json } else { $null }

Write-Host ''
Write-Host (' 配对码: ' + $pairing.code) -ForegroundColor Green
Write-Host (' 更新时间: ' + $pairing.updatedAt)
Write-Host ''
Write-Host ' 手机打开（同一 Wi-Fi）:'
foreach ($url in @($pairing.urls)) { Write-Host ('   ' + $url) }
Write-Host ('   本机调试: ' + $pairing.localUrl)
Write-Host ''

$alive = $false
if ($runtime -and $runtime.pid) {
    $alive = $null -ne (Get-Process -Id $runtime.pid -ErrorAction SilentlyContinue)
}
if ($alive) {
    Write-Host (' daemon 运行中（pid ' + $runtime.pid + '，端口 ' + $runtime.listen.port + '）') -ForegroundColor DarkGray
    if ($runtime.hostMode -eq 'plugin') {
        Write-Host (' 宿主模式: 接管模式（' + $runtime.upstream + '，profile=' + $runtime.upstreamProfile + '）') -ForegroundColor DarkGray
    } elseif ($runtime.hostMode) {
        Write-Host (' 宿主模式: 自启模式（' + $runtime.upstream + '）') -ForegroundColor DarkGray
    }
} else {
    Write-Host ' 注意：daemon 可能未运行，配对码可能已过期' -ForegroundColor Yellow
}
Write-Host ''
