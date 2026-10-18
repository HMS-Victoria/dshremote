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
if ($livePairing -and $livePairing.expiresAt) {
    $expires = ([datetimeoffset]::Parse($livePairing.expiresAt)).LocalDateTime
    if ($expires -lt (Get-Date)) {
        Write-Host (' （配对码已过期：' + $expires.ToString('HH:mm:ss') + '，重新生成可运行 .\tools\pair-open.ps1 或打开 .\tools\show-qr.ps1 页面）') -ForegroundColor Yellow
    } else {
        Write-Host (' （有效期到 ' + $expires.ToString('HH:mm:ss') + '）') -ForegroundColor DarkGray
    }
}
if ($livePairing -and $livePairing.publicUrl) {
    $publicHost = ''
    try { $publicHost = ([System.Uri]$livePairing.publicUrl).Host } catch { $publicHost = '' }
    $privatePattern = '^(10\.|127\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|172\.(1[6-9]|2\d|3[01])\.)'
    if ($publicHost -match $privatePattern -or $publicHost -eq 'localhost') {
        Write-Host (' 配对地址: ' + $livePairing.publicUrl + '（虚拟网/局域网，无需公网配对窗口）') -ForegroundColor Cyan
    } elseif ($livePairing.publicPairAllowed) {
        $until = ([datetime]$livePairing.publicPairWindowUntil).ToLocalTime().ToString('HH:mm:ss')
        Write-Host (' 公网配对: 已开启（到 ' + $until + '）') -ForegroundColor Green
    } else {
        Write-Host ' 公网配对: 关闭（配对新设备前运行 .\tools\pair-open.ps1）' -ForegroundColor DarkGray
    }
}
Write-Host ''

$urls = @()
if ($localPairing -and $localPairing.urls) { $urls = @($localPairing.urls) }
if ($localPairing -and $localPairing.publicPairUrl) {
    $publicShown = $localPairing.publicPairUrl -replace 'code=[^&]+', ('code=' + $code)
    Write-Host ' 二维码/外网地址（优先使用）:' -ForegroundColor Green
    Write-Host ('   ' + $publicShown)
    Write-Host ''
}
if ($localPairing -and $localPairing.tailscaleUrls) {
    foreach ($url in @($localPairing.tailscaleUrls)) {
        $shown = $url -replace 'code=[^&]+', ('code=' + $code)
        Write-Host (' Tailscale: ' + $shown) -ForegroundColor Cyan
    }
    Write-Host ''
}
if ($urls.Count -gt 0) {
    Write-Host ' 手机打开（局域网地址，需防火墙放行；当前仅 Tailscale 网段放行）:'
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
        $maxDevices = if ($livePairing -and $livePairing.maxDevices) { $livePairing.maxDevices } else { 5 }
        Write-Host (' 已配对设备: ' + $deviceCount + ' / ' + $maxDevices + ' 台（.\tools\devices.ps1 查看/吊销）') -ForegroundColor DarkGray
    } catch {
        # 设备数量查询失败不影响配对码显示
    }
} else {
    Write-Host ' 注意：daemon 可能未运行，配对码可能已过期' -ForegroundColor Yellow
}
Write-Host ''

