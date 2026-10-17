# 启动 dshremote daemon（开发用）
# 用法：在项目根目录执行  .\tools\start.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location (Join-Path $root 'server')
try {
    node src/index.js
}
finally {
    Pop-Location
}
