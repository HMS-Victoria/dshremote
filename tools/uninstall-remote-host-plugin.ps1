# 从指定 DSH profile 卸载 dsh-remote-host 桥接插件（默认 desktop）。
#
# 用法：在解压后的目录里执行
#   .\tools\uninstall-remote-host-plugin.ps1
#   .\tools\uninstall-remote-host-plugin.ps1 -DshDir "C:\Program Files\DeepSeek Harness"
param(
    [string]$Profile = 'desktop',
    [string]$DshDir = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome ("profiles\" + $Profile)
$profilePkg = Join-Path $profileDir 'package.json'

function Find-DshDir {
    param([string]$Override)
    if ($Override) {
        if (-not (Test-Path (Join-Path $Override 'DeepSeek Harness.exe'))) {
            throw "指定的 DSH 目录里没有 DeepSeek Harness.exe：$Override"
        }
        return (Resolve-Path $Override).Path
    }
    if ($env:DSHREMOTE_DSH_DIR -and (Test-Path (Join-Path $env:DSHREMOTE_DSH_DIR 'DeepSeek Harness.exe'))) {
        return $env:DSHREMOTE_DSH_DIR
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
    return $null
}

if (-not (Test-Path $profilePkg)) { throw "找不到 profile 配置：$profilePkg" }

# 1) 备份
$backupDir = Join-Path $root '.data\backup'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
Copy-Item $profilePkg (Join-Path $backupDir ("profile-" + $Profile + "-package-before-uninstall.json")) -Force

# 2) pnpm 移除依赖（找不到 DSH 时只改配置）
$dshDir = Find-DshDir -Override $DshDir
if ($dshDir) {
    $exe = Join-Path $dshDir 'DeepSeek Harness.exe'
    $cli = Join-Path $dshDir 'resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
    if (Test-Path $cli) {
        $env:ELECTRON_RUN_AS_NODE = '1'
        & $exe --expose-internals $cli plugin --profile $Profile remove dsh-remote-host
    }
} else {
    Write-Host '未找到 DSH 安装目录，只从 profile 配置中移除插件（-DshDir 可指定）' -ForegroundColor Yellow
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
