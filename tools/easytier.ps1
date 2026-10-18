# EasyTier 组网管理（电脑端）
#
# EasyTier 是一个开源的 P2P 组网工具：手机和电脑加入同一个「网络名+密码」的虚拟局域网，
# 互相用 10.x 虚拟 IP 通信，不需要把端口暴露到公网。
#
# 用法：
#   .\tools\easytier.ps1 -Action up        # 启动电脑端节点（管理员 PowerShell）
#   .\tools\easytier.ps1 -Action status    # 查看本机虚拟 IP / 已连接节点
#   .\tools\easytier.ps1 -Action down      # 停止
#   .\tools\easytier.ps1 -Action up -ConfigureDaemon   # 同时把 daemon 二维码地址设为虚拟网 IP 并重启 daemon
param(
    [ValidateSet('up', 'down', 'status')][string]$Action = 'status',
    [switch]$ConfigureDaemon
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $root '.data'
$configFile = Join-Path $dataDir 'easytier.json'
$pidFile = Join-Path $dataDir 'easytier-pid.json'
$logFile = Join-Path $dataDir 'easytier.log'
$errFile = Join-Path $dataDir 'easytier.err'

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

function Find-EasyTier {
    $base = Join-Path $root 'tools\bin\easytier'
    if (-not (Test-Path $base)) { throw "找不到 EasyTier 目录: $base（先运行 tools\download-easytier.ps1 或手动解压到这里）" }
    $core = Get-ChildItem $base -Recurse -Filter 'easytier-core.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    $cli = Get-ChildItem $base -Recurse -Filter 'easytier-cli.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $core) { throw '找不到 easytier-core.exe' }
    return @{ core = $core.FullName; cli = if ($cli) { $cli.FullName } else { $null } }
}

function Get-OrCreate-Config {
    if (Test-Path $configFile) {
        return (Get-Content $configFile -Raw | ConvertFrom-Json)
    }
    $secret = -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
    $nameSuffix = -join ((1..6) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
    $config = [pscustomobject]@{
        networkName   = "dshremote-$nameSuffix"
        networkSecret = $secret
        virtualIp     = '10.126.126.1'
        subnet        = '10.126.126.0/24'
        peers         = @('udp://public.easytier.cn:11010')
    }
    ($config | ConvertTo-Json -Depth 6) + "`n" | Set-Content -Path $configFile -Encoding utf8 -NoNewline
    Write-Host "已生成 EasyTier 网络配置: $configFile" -ForegroundColor Green
    return $config
}

function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Ensure-FirewallRule {
    param([string]$Subnet)
    $ruleName = 'dshremote EasyTier TCP 7801'
    if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) { return }
    if (-not (Test-IsAdmin)) {
        Write-Host '提示：需要管理员权限才能添加防火墙规则，请以管理员身份重新运行。' -ForegroundColor Yellow
        return
    }
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP `
        -LocalPort 7801 -RemoteAddress $Subnet -Profile Any | Out-Null
    Write-Host "已添加防火墙规则：仅允许 EasyTier 网段（$Subnet）访问 7801" -ForegroundColor Green
}

function Get-RunningProcess {
    param([string]$CorePath)
    if (Test-Path $pidFile) {
        try {
            $info = Get-Content $pidFile -Raw | ConvertFrom-Json
            $process = Get-Process -Id $info.pid -ErrorAction SilentlyContinue
            if ($process) { return $process }
        } catch {
            # 继续找
        }
    }
    return Get-Process -Name 'easytier-core' -ErrorAction SilentlyContinue | Select-Object -First 1
}

switch ($Action) {
    'status' {
        $config = Get-OrCreate-Config
        $bins = Find-EasyTier
        $process = Get-RunningProcess -CorePath $bins.core
        if (-not $process) {
            Write-Host 'EasyTier 未在运行' -ForegroundColor Yellow
            exit 1
        }
        Write-Host ("EasyTier 运行中（pid " + $process.Id + "）")
        if ($bins.cli) {
            Write-Host '=== 本机节点 ==='
            & $bins.cli node 2>&1 | Select-Object -First 12
            Write-Host '=== 对等节点 ==='
            & $bins.cli peer 2>&1 | Select-Object -First 20
        } else {
            Write-Host '（缺少 easytier-cli.exe，跳过详情）'
        }
        Write-Host ''
        Write-Host ("网络名: " + $config.networkName)
        Write-Host ("虚拟 IP: " + $config.virtualIp + "（daemon: http://" + $config.virtualIp + ":7801）")
    }

    'down' {
        $process = Get-RunningProcess -CorePath $null
        if ($process) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            Write-Host ("已停止 EasyTier（pid " + $process.Id + "）") -ForegroundColor Green
        } else {
            Write-Host 'EasyTier 未在运行'
        }
        Remove-Item $pidFile -ErrorAction SilentlyContinue
    }

    'up' {
        $config = Get-OrCreate-Config
        $bins = Find-EasyTier
        $existing = Get-RunningProcess -CorePath $bins.core
        if ($existing) {
            Write-Host ("EasyTier 已在运行（pid " + $existing.Id + "）") -ForegroundColor Yellow
        } else {
            $arguments = @(
                '--network-name', $config.networkName,
                '--network-secret', $config.networkSecret,
                '-i', $config.virtualIp
            )
            foreach ($peer in @($config.peers)) {
                $arguments += @('-p', $peer)
            }
            $process = Start-Process -FilePath $bins.core -ArgumentList $arguments `
                -RedirectStandardOutput $logFile -RedirectStandardError $errFile `
                -PassThru -WindowStyle Hidden
            Start-Sleep -Seconds 3
            if ($process.HasExited) {
                Write-Host 'EasyTier 启动失败，最后日志：' -ForegroundColor Red
                Get-Content $errFile -ErrorAction SilentlyContinue | Select-Object -Last 20
                exit 1
            }
            @{ pid = $process.Id; startedAt = (Get-Date).ToString('o') } | ConvertTo-Json |
                Set-Content -Path $pidFile -Encoding utf8 -NoNewline
            Write-Host ("EasyTier 已启动（pid " + $process.Id + "）") -ForegroundColor Green
        }
        Ensure-FirewallRule -Subnet $config.subnet

        Write-Host ''
        Write-Host '=============================================='
        Write-Host ' EasyTier 已就绪'
        Write-Host (" 网络名:  " + $config.networkName)
        Write-Host (" 网络密码: " + $config.networkSecret)
        Write-Host (" 本机虚拟 IP: " + $config.virtualIp)
        Write-Host (" daemon 地址: http://" + $config.virtualIp + ":7801")
        Write-Host '=============================================='
        Write-Host ''
        Write-Host '手机端：安装 EasyTier App，添加同样的网络名/密码（可加同样的公共节点），连接后设备会得到 10.126.126.x 地址。'
        Write-Host ('手机 DSH App 的服务器地址填: http://' + $config.virtualIp + ':7801')
        Write-Host ''

        if ($ConfigureDaemon) {
            & (Join-Path $PSScriptRoot 'set-public-url.ps1') -Url ("http://" + $config.virtualIp + ":7801") -Restart
        }
    }
}
