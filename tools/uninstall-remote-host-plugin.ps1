# 从指定 DSH profile 卸载 dsh-remote-host 桥接插件（默认 desktop）。
#
# 用法：在项目根目录执行
#   .\tools\uninstall-remote-host-plugin.ps1
#   .\tools\uninstall-remote-host-plugin.ps1 -Profile web
param(
    [string]$Profile = 'desktop'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome ("profiles\" + $Profile)
$profilePkg = Join-Path $profileDir 'package.json'
$exe = 'D:\新建文件夹\DeepSeek Harness.exe'
$cli = 'D:\新建文件夹\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'

if (-not (Test-Path $profilePkg)) { throw "找不到 profile 配置：$profilePkg" }

# 1) 备份
$backupDir = Join-Path $root '.data\backup'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
Copy-Item $profilePkg (Join-Path $backupDir ("profile-" + $Profile + "-package-before-uninstall.json")) -Force

# 2) pnpm 移除依赖
if (Test-Path $exe) {
    $env:ELECTRON_RUN_AS_NODE = '1'
    & $exe --expose-internals $cli plugin --profile $Profile remove dsh-remote-host
}

# 3) 从 bundles 列表移除
$data = Get-Content $profilePkg -Raw | ConvertFrom-Json
$bundles = @($data.dsh.profile.bundles) | Where-Object { $_ -ne 'dsh-remote-host' }
$data.dsh.profile.bundles = $bundles
($data | ConvertTo-Json -Depth 8) + "`n" | Set-Content -Path $profilePkg -Encoding utf8 -NoNewline

# 4) 清掉导出的 host.json
$hostFile = Join-Path $dshHome ("remote\host-" + $Profile + ".json")
Remove-Item $hostFile -Force -ErrorAction SilentlyContinue

Write-Host '已卸载 dsh-remote-host 插件。' -ForegroundColor Green
Write-Host '重启 DSH 桌面 App 后生效；dshremote daemon 会回退到自启模式。'
Write-Host ''
