# 把 dshremote 电脑端（插件 + daemon + 工具 + APK）打包成一个 zip，交给别人测试。
#
# 用法：在项目根目录执行
#   .\tools\package-pc.ps1                 # 打包（含 APK）
#   .\tools\package-pc.ps1 -NoApk          # 不含 APK（更小的包）
#   .\tools\package-pc.ps1 -Version 0.4.4  # 指定 APK 版本（默认 0.4.7）
param(
    [string]$Version = '0.4.7',
    [switch]$NoApk
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $root '.data\package\dshremote-pc'

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage, (Join-Path $stage 'plugin'), (Join-Path $stage 'server'), (Join-Path $stage 'tools') | Out-Null

# 插件
Copy-Item (Join-Path $root 'plugin\dsh-remote-host') (Join-Path $stage 'plugin\') -Recurse

# daemon
Copy-Item (Join-Path $root 'server\src') (Join-Path $stage 'server\') -Recurse
Copy-Item (Join-Path $root 'server\mobile') (Join-Path $stage 'server\') -Recurse
Copy-Item (Join-Path $root 'server\package.json') (Join-Path $stage 'server\')

# 工具脚本
$toolNames = @(
    'install-remote-host-plugin.ps1',
    'uninstall-remote-host-plugin.ps1',
    'start.ps1',
    'stop.ps1',
    'pair-info.ps1',
    'devices.ps1',
    'show-qr.ps1',
    'diag.ps1',
    'pair-open.ps1',
    'gui.ps1',
    'set-public-url.ps1',
    'firewall-allow.ps1',
    'firewall-lan.ps1'
)
foreach ($name in $toolNames) {
    $source = Join-Path $root "tools\$name"
    if (-not (Test-Path $source)) { throw "缺少工具脚本: $source" }
    Copy-Item $source (Join-Path $stage 'tools\')
}

# 测试说明 + 外网访问说明
Copy-Item (Join-Path $root 'dshremote-gui.cmd') $stage
Copy-Item (Join-Path $root 'docs\tester-guide.md') (Join-Path $stage 'README-测试说明.md')
Copy-Item (Join-Path $root 'docs\network.md') (Join-Path $stage '网络配置说明（WireGuard）.md')
Copy-Item (Join-Path $root 'docs\security.md') (Join-Path $stage '安全说明.md')

# APK（可选）
if (-not $NoApk) {
    $apk = Join-Path $root "dist\dshremote-$Version-debug.apk"
    if (-not (Test-Path $apk)) { throw "找不到 APK: $apk（先构建或用 -NoApk）" }
    New-Item -ItemType Directory -Force -Path (Join-Path $stage 'dist') | Out-Null
    Copy-Item $apk (Join-Path $stage 'dist\')
    $wgApk = Join-Path $root 'dist\wireguard-android.apk'
    if (Test-Path $wgApk) { Copy-Item $wgApk (Join-Path $stage 'dist\') }
}

# 版本信息
$pluginVersion = (Get-Content (Join-Path $root 'plugin\dsh-remote-host\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$daemonVersion = (Get-Content (Join-Path $root 'server\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$versionLines = @(
    'dshremote 电脑端测试包',
    ('打包时间: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm')),
    ('插件版本: ' + $pluginVersion),
    ('daemon 版本: ' + $daemonVersion),
    ('APK 版本: ' + $(if ($NoApk) { '未附带' } else { $Version }))
)
[System.IO.File]::WriteAllLines((Join-Path $stage 'VERSION.txt'), $versionLines, (New-Object System.Text.UTF8Encoding($false)))

$zip = Join-Path $root "dist\dshremote-pc-$Version.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal

Write-Host ''
Write-Host '打包完成，内容：' -ForegroundColor Green
Get-ChildItem $stage -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($stage.Length + 1)
    Write-Host ('  ' + $relative + '  (' + [math]::Round($_.Length / 1KB) + ' KB)')
}
Write-Host ''
Write-Host ('ZIP: ' + $zip + '  (' + [math]::Round((Get-Item $zip).Length / 1MB, 1) + ' MB)') -ForegroundColor Green





