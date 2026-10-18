# 在默认浏览器里打开配对二维码页面（手机扫码配对用）
# 用法：.\tools\show-qr.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runtimeFile = Join-Path $root '.data\runtime.json'
if (-not (Test-Path $runtimeFile)) {
    Write-Host 'daemon 未启动 —— 先运行 .\tools\start.ps1' -ForegroundColor Yellow
    exit 1
}
$runtime = Get-Content $runtimeFile -Raw | ConvertFrom-Json
$port = if ($runtime.listen -and $runtime.listen.port) { $runtime.listen.port } else { 7801 }
$url = 'http://127.0.0.1:' + $port + '/pair'
Write-Host ('打开配对二维码页面: ' + $url) -ForegroundColor Green
Write-Host '（页面里的二维码已编码局域网地址，手机 App 扫码即可配对）'
Start-Process $url
