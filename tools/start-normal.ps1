# 恢复普通（管理员权限）方式启动 DSH + dshremote daemon
#
# 用法（独立 PowerShell 窗口执行）：
#   .\tools\start-normal.ps1
param(
    [string]$DshExe = '',
    [int]$WaitSeconds = 90
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $root '.data'
$runtimeFile = Join-Path $dataDir 'runtime.json'

function Find-DshExe {
    param([string]$Override)
    if ($Override) {
        if (-not (Test-Path (Join-Path $Override 'DeepSeek Harness.exe'))) { throw "指定目录没有 DeepSeek Harness.exe: $Override" }
        return (Join-Path $Override 'DeepSeek Harness.exe')
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
        'D:\新建文件夹',
        'D:\DeepSeek Harness'
    )
    foreach ($dir in $candidates) {
        if ($dir -and (Test-Path (Join-Path $dir 'DeepSeek Harness.exe'))) {
            return (Join-Path $dir 'DeepSeek Harness.exe')
        }
    }
    throw '找不到 DeepSeek Harness.exe，请用 -DshExe 指定安装目录'
}

function Get-HostInfo {
    param([string]$File)
    if (-not (Test-Path $File)) { return $null }
    try { return (Get-Content $File -Raw | ConvertFrom-Json) } catch { return $null }
}

Write-Host '正在切换回普通（管理员）启动…'

# 1) 停 daemon
if (Test-Path $runtimeFile) {
    $runtime = Get-Content $runtimeFile -Raw | ConvertFrom-Json -ErrorAction SilentlyContinue
    if ($runtime -and $runtime.pid) {
        Stop-Process -Id $runtime.pid -Force -ErrorAction SilentlyContinue
        Write-Host "已停止 daemon（pid $($runtime.pid)）"
        Start-Sleep -Seconds 1
    }
}

# 2) 停 DSH（受限版）
$processes = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
foreach ($process in $processes) {
    try { $process.CloseMainWindow() | Out-Null } catch { }
}
Start-Sleep -Seconds 8
Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# 3) 普通方式启动 DSH
$exe = Find-DshExe -Override $DshExe
$hostFile = Join-Path $env:USERPROFILE '.dsh\remote\host-desktop.json'
$previousHost = Get-HostInfo -File $hostFile
$previousPid = if ($previousHost -and $previousHost.pid) { [int]$previousHost.pid } else { 0 }

Write-Host "启动 DSH: $exe"
Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe)

# 4) 等宿主就绪
$deadline = (Get-Date).AddSeconds($WaitSeconds)
$ready = $false
while ((Get-Date) -lt $deadline) {
    $info = Get-HostInfo -File $hostFile
    if ($info -and $info.pid -and [int]$info.pid -ne $previousPid) {
        try {
            $client = New-Object System.Net.Sockets.TcpClient
            $task = $client.ConnectAsync('127.0.0.1', [int]$info.port)
            if ($task.Wait(2000) -and $client.Connected) { $ready = $true; $client.Close(); break }
            $client.Close()
        } catch {
            # 继续等
        }
    }
    Start-Sleep -Milliseconds 800
}
if (-not $ready) {
    Write-Host 'DSH 宿主未就绪，请手动打开 DSH 后运行 .\tools\start.ps1 -Background' -ForegroundColor Yellow
    exit 1
}
Write-Host "DSH 宿主已就绪: $($info.origin)"

# 5) 普通方式启动 daemon
& (Join-Path $PSScriptRoot 'start.ps1') -Background
Start-Sleep -Seconds 5

$health = $false
try {
    $response = Invoke-WebRequest 'http://127.0.0.1:7801/__dshremote/health' -UseBasicParsing -TimeoutSec 3
    $health = $response.StatusCode -eq 200
} catch {
    $health = $false
}
if (-not $health) {
    Write-Host 'daemon 未就绪，请查看 .data\daemon.log' -ForegroundColor Yellow
    exit 1
}

Write-Host ''
Write-Host '已恢复普通（管理员）启动。' -ForegroundColor Green
Write-Host '手机 App 刷新页面即可重连。'
