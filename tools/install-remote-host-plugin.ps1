# 把 dsh-remote-host 桥接插件安装/更新到指定 DSH profile（默认 desktop）。
#
# 作用：让 DSH 宿主进程把 { origin, authenticatedUrl } 写到
#   %USERPROFILE%\.dsh\remote\host-<profile>.json
# daemon 读取后即可用“接管模式”连接这个宿主（桌面 App 自己的 Host），
# 从而避免两个宿主争抢同一份会话写句柄。
#
# 用法：在解压后的目录里执行
#   .\tools\install-remote-host-plugin.ps1                 # 安装到 desktop profile
#   .\tools\install-remote-host-plugin.ps1 -DshDir "C:\Program Files\DeepSeek Harness"
#   .\tools\install-remote-host-plugin.ps1 -Profile web -SkipPnpm
param(
    [string]$Profile = 'desktop',
    [string]$DshDir = '',
    [switch]$SkipPnpm
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pluginPath = Join-Path $root 'plugin\dsh-remote-host'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome ("profiles\" + $Profile)
$profilePkg = Join-Path $profileDir 'package.json'

# 自动查找 DSH 桌面版安装目录（包含 "DeepSeek Harness.exe"）
function Find-DshDir {
    param([string]$Override)
    if ($Override) {
        if (-not (Test-Path (Join-Path $Override 'DeepSeek Harness.exe'))) {
            throw "指定的 DSH 目录里没有 DeepSeek Harness.exe：$Override"
        }
        return (Resolve-Path $Override).Path
    }
    if ($env:DSHREMOTE_DSH_DIR) {
        if (Test-Path (Join-Path $env:DSHREMOTE_DSH_DIR 'DeepSeek Harness.exe')) { return $env:DSHREMOTE_DSH_DIR }
    }
    $candidates = @()
    foreach ($hive in @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )) {
        $candidates += @(Get-ItemProperty $hive -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -match 'DeepSeek Harness' } |
            ForEach-Object { $_.InstallLocation })
    }
    $candidates += @(
        (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'),
        (Join-Path $env:ProgramFiles 'DeepSeek Harness'),
        (Join-Path ${env:ProgramFiles(x86)} 'DeepSeek Harness'),
        'D:\新建文件夹'
    )
    foreach ($dir in $candidates) {
        if ($dir -and (Test-Path (Join-Path $dir 'DeepSeek Harness.exe'))) {
            return (Resolve-Path $dir).Path
        }
    }
    throw '找不到 DSH 安装目录，请用 -DshDir 指定（该目录里应有 "DeepSeek Harness.exe"）'
}

if (-not (Test-Path $pluginPath)) { throw "找不到插件目录：$pluginPath（请确认在解压后的 dshremote-pc 目录里执行）" }
if (-not (Test-Path $profilePkg)) { throw "找不到 profile 配置：$profilePkg（请先启动一次 DSH 桌面版，让 profile 初始化）" }

$dshDir = Find-DshDir -Override $DshDir
$exe = Join-Path $dshDir 'DeepSeek Harness.exe'
$cli = Join-Path $dshDir 'resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
Write-Host ("DSH 安装目录: " + $dshDir)

# 1) 备份 profile 配置
$backupDir = Join-Path $root '.data\backup'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
Copy-Item $profilePkg (Join-Path $backupDir ("profile-" + $Profile + "-package.json")) -Force
Write-Host ("已备份 profile 配置 → " + (Join-Path $backupDir ("profile-" + $Profile + "-package.json")))

# 2) 用 pnpm（通过 dsh plugin 转发）链接本地插件包
if (-not $SkipPnpm) {
    if (-not (Test-Path $cli)) { throw "找不到 DSH CLI：$cli（DSH 版本可能不同，请把 DSH 安装目录发给开发者）" }
    $env:ELECTRON_RUN_AS_NODE = '1'
    Write-Host "执行: dsh plugin --profile $Profile add link:$pluginPath"
    & $exe --expose-internals $cli plugin --profile $Profile add ("link:" + $pluginPath)
    if ($LASTEXITCODE -ne 0) { throw "插件安装失败（exit=$LASTEXITCODE），请把上面的报错发给开发者" }
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
Write-Host ' 1. 完全退出并重新打开 DSH 桌面 App（让插件加载）；'
Write-Host ' 2. 启动 dshremote daemon：.\tools\start.ps1 -Background；'
Write-Host ' 3. 查看配对信息与二维码：.\tools\pair-info.ps1 / .\tools\show-qr.ps1。'
Write-Host ''
