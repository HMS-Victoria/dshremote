# 用「受限令牌」以普通用户权限运行 DSH + dshremote daemon（管理员登录不变）
#
# 原理：runas /trustlevel:0x20000 会生成一个受限令牌（Basic User），
# DSH/daemon 进程里没有管理员权限，但仍然是你的用户身份（可以读写你的文件）。
#
# 用法（在独立 PowerShell 窗口里执行，不要在 DSH 的对话/终端里跑，
#       因为本脚本会重启 DSH 桌面版）：
#   .\tools\start-restricted.ps1
#
# 回退普通（管理员）启动：
#   .\tools\start-normal.ps1
param(
    [string]$DshExe = '',
    [int]$WaitSeconds = 90,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $root '.data'
$runtimeFile = Join-Path $dataDir 'runtime.json'
$logFile = Join-Path $dataDir 'daemon.log'

# ── 工具函数 ─────────────────────────────────────────────────────────────

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

function Stop-Daemon {
    if (Test-Path $runtimeFile) {
        try {
            $runtime = Get-Content $runtimeFile -Raw | ConvertFrom-Json
            if ($runtime.pid) {
                Stop-Process -Id $runtime.pid -Force -ErrorAction SilentlyContinue
                Write-Host "已停止旧 daemon（pid $($runtime.pid)）"
                Start-Sleep -Seconds 1
            }
        } catch {
            # 忽略损坏的 runtime.json
        }
    }
    # 兜底：清理本项目目录下残留的 node src/index.js
    $escapedRoot = [regex]::Escape($root)
    $orphans = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -match 'src[\\/]+index\.js' -and $_.CommandLine -match $escapedRoot }
    foreach ($process in $orphans) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Stop-Dsh {
    $processes = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
    if (-not $processes) { Write-Host 'DSH 未在运行'; return }
    Write-Host '正在关闭 DSH 桌面版…'
    foreach ($process in $processes) {
        try { $process.CloseMainWindow() | Out-Null } catch { }
    }
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline -and (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) {
        Start-Sleep -Milliseconds 500
    }
    Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Write-Host 'DSH 已关闭'
}

function Get-HostInfo {
    param([string]$File)
    if (-not (Test-Path $File)) { return $null }
    try { return (Get-Content $File -Raw | ConvertFrom-Json) } catch { return $null }
}

function Wait-DshHost {
    param([string]$File, [int]$PreviousPid, [int]$Seconds)
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        $info = Get-HostInfo -File $File
        if ($info -and $info.pid -and [int]$info.pid -ne $PreviousPid) {
            # 等宿主端口真正可连接
            try {
                $client = New-Object System.Net.Sockets.TcpClient
                $task = $client.ConnectAsync('127.0.0.1', [int]$info.port)
                $connected = $task.Wait(2000) -and $client.Connected
                $client.Close()
                if ($connected) { return $info }
            } catch {
                # 下一轮再试
            }
        }
        Start-Sleep -Milliseconds 800
    }
    return $null
}

function Wait-DaemonHealth {
    param([int]$Seconds)
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest 'http://127.0.0.1:7801/__dshremote/health' -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) { return $true }
        } catch {
            # 还没起来
        }
        Start-Sleep -Milliseconds 700
    }
    return $false
}

# ── 主流程 ───────────────────────────────────────────────────────────────

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$exe = Find-DshExe -Override $DshExe
$hostFile = Join-Path $env:USERPROFILE '.dsh\remote\host-desktop.json'
$previousHost = Get-HostInfo -File $hostFile
$previousPid = if ($previousHost -and $previousHost.pid) { [int]$previousHost.pid } else { 0 }

Write-Host '=============================================='
Write-Host ' 切换到「受限令牌」模式（DSH/daemon 无管理员权限）'
Write-Host " DSH:    $exe"
Write-Host " 项目:   $root"
Write-Host '=============================================='

if ($DryRun) {
    $daemonPid = if (Test-Path $runtimeFile) { (Get-Content $runtimeFile -Raw | ConvertFrom-Json -ErrorAction SilentlyContinue).pid } else { $null }
    $dshCount = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count
    Write-Host ''
    Write-Host '[DryRun] 不会做任何改动。将要执行：'
    Write-Host ("  - 停止当前 daemon（pid: " + $(if ($daemonPid) { $daemonPid } else { '未运行' }) + "）")
    Write-Host ("  - 关闭当前 DSH（进程数: $dshCount）")
    Write-Host ('  - runas /trustlevel:0x20000 "' + $exe + '"')
    Write-Host '  - 等待宿主就绪后，用受限令牌隐藏启动 daemon'
    Write-Host '  - 校验 http://127.0.0.1:7801/__dshremote/health'
    Write-Host ''
    Write-Host '去掉 -DryRun 即可正式切换。'
    exit 0
}

Stop-Daemon
Stop-Dsh

Write-Host '正在以受限令牌启动 DSH…'
$startCommand = '"' + $exe + '"'
& runas.exe /trustlevel:0x20000 $startCommand
if ($LASTEXITCODE -ne 0) { throw "runas 启动 DSH 失败（exit=$LASTEXITCODE）" }

Write-Host '等待 DSH 宿主就绪…'
$hostInfo = Wait-DshHost -File $hostFile -PreviousPid $previousPid -Seconds $WaitSeconds
if (-not $hostInfo) {
    Write-Host 'DSH 宿主未在限定时间内就绪。可运行 .\tools\start-normal.ps1 回退。' -ForegroundColor Yellow
    exit 1
}
Write-Host ("DSH 宿主已就绪: " + $hostInfo.origin)

# 生成隐藏启动 daemon 的 VBS（runas 出来的窗口不可见）
$vbsPath = Join-Path $dataDir 'launch-daemon.vbs'
$vbsLines = @(
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))',
    'cmd = "cmd /c cd /d """ & root & "\server"" && node src/index.js >> """ & root & "\.data\daemon.log"" 2>&1"',
    'CreateObject("WScript.Shell").Run cmd, 0, False'
)
[System.IO.File]::WriteAllLines($vbsPath, $vbsLines, (New-Object System.Text.UTF8Encoding($false)))

Write-Host '正在以受限令牌启动 daemon…'
& runas.exe /trustlevel:0x20000 ('wscript.exe "' + $vbsPath + '"')
if ($LASTEXITCODE -ne 0) { throw "runas 启动 daemon 失败（exit=$LASTEXITCODE）" }

if (-not (Wait-DaemonHealth -Seconds 60)) {
    Write-Host 'daemon 未就绪，请检查 .data\daemon.log；可运行 .\tools\start-normal.ps1 回退。' -ForegroundColor Yellow
    exit 1
}

# 用受限身份记录一份权限清单，方便以后核对
$privFile = Join-Path $dataDir 'restricted-privs.txt'
& runas.exe /trustlevel:0x20000 ('cmd /c whoami /priv > "' + $privFile + '" 2>&1')
Start-Sleep -Seconds 2

$runtime = Get-Content $runtimeFile -Raw | ConvertFrom-Json
$tailscale = & 'C:\Program Files\Tailscale\tailscale.exe' funnel status 2>&1 | Out-String
$funnelOn = $tailscale -match 'Funnel on'

Write-Host ''
Write-Host '==============================================' -ForegroundColor Green
Write-Host ' 已切换到受限令牌模式' -ForegroundColor Green
Write-Host (" daemon pid:  " + $runtime.pid)
Write-Host (" 宿主模式:    " + $runtime.hostMode + "（" + $runtime.upstream + "）")
Write-Host (" 公网入口:    " + $(if ($funnelOn) { 'Tailscale Funnel 已开启' } else { 'Funnel 未开启（需要时运行: C:\Program Files\Tailscale\tailscale.exe funnel 7801）' }))
Write-Host (" 权限清单:    " + $privFile)
Write-Host '==============================================' -ForegroundColor Green
Write-Host ''
Write-Host '提示：'
Write-Host ' - 手机 App 刷新页面即可重连（最多等 1 分钟）。'
Write-Host ' - 受限模式下 DSH 不能做管理员操作（改系统/服务/装驱动等），但项目文件、命令、会话都正常。'
Write-Host ' - 想恢复管理员启动：.\tools\start-normal.ps1'
