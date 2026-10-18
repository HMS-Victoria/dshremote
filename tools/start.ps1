# 启动 dshremote daemon
# 用法：
#   .\tools\start.ps1              # 前台运行（Ctrl+C 退出）
#   .\tools\start.ps1 -Background  # 后台隐藏运行（日志写 .data\daemon.log）
param(
    [switch]$Background
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$serverDir = Join-Path $root 'server'
$logFile = Join-Path $root '.data\daemon.log'

if (-not $Background) {
    Push-Location $serverDir
    try {
        node src/index.js
    }
    finally {
        Pop-Location
    }
    exit 0
}

# 后台模式：已有 daemon 在跑就不重复启动
$runtimeFile = Join-Path $root '.data\runtime.json'
if (Test-Path $runtimeFile) {
    $runtime = Get-Content $runtimeFile -Raw | ConvertFrom-Json -ErrorAction SilentlyContinue
    if ($runtime -and $runtime.pid -and (Get-Process -Id $runtime.pid -ErrorAction SilentlyContinue)) {
        Write-Host ("daemon 已在运行（pid " + $runtime.pid + "）") -ForegroundColor Yellow
        exit 0
    }
}

New-Item -ItemType Directory -Force -Path (Join-Path $root '.data') | Out-Null
$node = (Get-Command node -ErrorAction Stop).Source
Start-Process -FilePath $node -ArgumentList 'src/index.js' -WorkingDirectory $serverDir -WindowStyle Hidden `
    -RedirectStandardOutput $logFile -RedirectStandardError ($logFile + '.err')
Write-Host 'daemon 已在后台启动，日志: .data\daemon.log' -ForegroundColor Green
Write-Host '查看配对码: .\tools\pair-info.ps1' -ForegroundColor DarkGray
