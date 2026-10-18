# 把 dsh-remote-host 桥接插件安装/更新到指定 DSH profile（默认 desktop）。
#
# 作用：让 DSH 宿主进程把 { origin, authenticatedUrl } 写到
#   %USERPROFILE%\.dsh\remote\host-<profile>.json
# daemon 读取后即可用“接管模式”连接这个宿主（桌面 App 自己的 Host），
# 从而避免两个宿主争抢同一份会话写句柄。
#
# 用法：在项目根目录执行
#   .\tools\install-remote-host-plugin.ps1                 # 安装到 desktop profile
#   .\tools\install-remote-host-plugin.ps1 -Profile web    # 安装到 web profile
#   .\tools\install-remote-host-plugin.ps1 -Profile desktop -SkipPnpm  # 仅改配置不执行 pnpm
param(
    [string]$Profile = 'desktop',
    [switch]$SkipPnpm
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pluginPath = Join-Path $root 'plugin\dsh-remote-host'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome ("profiles\" + $Profile)
$profilePkg = Join-Path $profileDir 'package.json'
$exe = 'D:\新建文件夹\DeepSeek Harness.exe'
$cli = 'D:\新建文件夹\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'

if (-not (Test-Path $pluginPath)) { throw "找不到插件目录：$pluginPath" }
if (-not (Test-Path $profilePkg)) { throw "找不到 profile 配置：$profilePkg（先启动一次该 profile）" }

# 1) 备份 profile 配置
$backupDir = Join-Path $root '.data\backup'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
Copy-Item $profilePkg (Join-Path $backupDir ("profile-" + $Profile + "-package.json")) -Force
Write-Host ("已备份 profile 配置 → " + (Join-Path $backupDir ("profile-" + $Profile + "-package.json")))

# 2) 用 pnpm（通过 dsh plugin 转发）链接本地插件包
if (-not $SkipPnpm) {
    if (-not (Test-Path $exe)) { throw "找不到 DSH 可执行文件：$exe" }
    $env:ELECTRON_RUN_AS_NODE = '1'
    Write-Host "执行: dsh plugin --profile $Profile add link:$pluginPath"
    & $exe --expose-internals $cli plugin --profile $Profile add ("link:" + $pluginPath)
    if ($LASTEXITCODE -ne 0) { throw "pnpm 安装失败（exit=$LASTEXITCODE）" }
}

# 3) 确保 bundle 已加入 dsh.profile.bundles（幂等）
$data = Get-Content $profilePkg -Raw | ConvertFrom-Json
$bundles = @($data.dsh.profile.bundles)
if ($bundles -notcontains 'dsh-remote-host') {
    $data.dsh.profile.bundles = $bundles + 'dsh-remote-host'
    ($data | ConvertTo-Json -Depth 8) + "`n" | Set-Content -Path $profilePkg -Encoding utf8 -NoNewline
    Write-Host '已把 dsh-remote-host 加入 profile 的 bundles 列表'
} else {
    Write-Host 'profile 的 bundles 列表已包含 dsh-remote-host'
}

Write-Host ''
Write-Host '完成。接下来：' -ForegroundColor Green
Write-Host ' 1. 重启 DSH 桌面 App（或对应 profile 的宿主）让插件加载；'
Write-Host ' 2. 重启 dshremote daemon（.\tools\start.ps1），它会自动切到“接管模式”；'
Write-Host ' 3. 用 .\tools\pair-info.ps1 查看宿主模式与配对码。'
Write-Host ''
