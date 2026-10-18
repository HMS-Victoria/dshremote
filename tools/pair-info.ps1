# 显示当前 daemon 的配对码、手机访问地址与设备数量
# 用法：在项目根目录执行  .\tools\pair-info.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pairingFile = Join-Path $root '.data\pairing.json'
$runtimeFile = Join-Path $root '.data\runtime.json'

$runtime = if (Test-Path $runtimeFile) { Get-Content $runtimeFile -Raw | ConvertFrom-Json -ErrorAction SilentlyContinue } else { $null }
$port = 7801
if ($runtime -and $runtime.listen -and $runtime.listen.port) { $port = [int]$runtime.listen.port }

# 优先从 daemon 的 loopback 接口取“当前”配对码（一次性码轮换后文件可能稍旧）
$livePairing = $null
try {
    $livePairing = Invoke-RestMethod ('http://127.0.0.1:' + $port + '/__dshremote/pairing') -TimeoutSec 3
} catch {
    $livePairing = $null
}

$localPairing = if (Test-Path $pairingFile) { Get-Content $pairingFile -Raw | ConvertFrom-Json } else { $null }
if (-not $livePairing -and -not $localPairing) {
    Write-Host '还没有配对信息 —— 请先启动 daemon：.\tools\start.ps1' -ForegroundColor Yellow
    exit 1
}

$code = if ($livePairing -and $livePairing.code) { $livePairing.code } else { $localPairing.code }
$oneTime = if ($livePairing) { [bool]$livePairing.oneTime } else { $false }

Write-Host ''
Write-Host (' 配对码: ' + $code) -ForegroundColor Green
if ($livePairing -and $livePairing.used) {
    Write-Host ' （当前码已使用，一次性模式下会自动轮换）' -ForegroundColor Yellow
}
Write-Host ''

$urls = @()
if ($localPairing -and $localPairing.urls) { $urls = @($localPairing.urls) }
if ($urls.Count -gt 0) {
    Write-Host ' 手机打开（同一 Wi-Fi）:'
    foreach ($url in $urls) {
        $shown = $url -replace 'code=[^&]+', ('code=' + $code)
        Write-Host ('   ' + $shown)
    }
    $localShown = ($localPairing.localUrl -replace 'code=[^&]+', ('code=' + $code))
    Write-Host ('   本机调试: ' + $localShown)
    Write-Host ''
}

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
    if ($oneTime) { Write-Host ' 配对码一次性：配对成功后自动作废并轮换' -ForegroundColor DarkGray }
    try {
        $deviceCount = @((Invoke-RestMethod ('http://127.0.0.1:' + $port + '/__dshremote/devices') -TimeoutSec 3).devices).Count
        Write-Host (' 已配对设备: ' + $deviceCount + ' 台（.\tools\devices.ps1 查看/吊销）') -ForegroundColor DarkGray
    } catch {
        # 设备数量查询失败不影响配对码显示
    }
} else {
    Write-Host ' 注意：daemon 可能未运行，配对码可能已过期' -ForegroundColor Yellow
}
Write-Host ''
