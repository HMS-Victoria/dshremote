# dshremote 图形管理面板（Windows Forms，无需安装任何东西）
#
# 双击项目根目录下的 dshremote-gui.cmd 启动。
# 功能：查看/启动/停止 daemon、显示配对码与二维码入口、管理已配对设备、
#       查看 Tailscale 状态、开关开机自启、打开日志。
param(
    [string]$Screenshot = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $root '.data'
$runtimeFile = Join-Path $dataDir 'runtime.json'
$configFile = Join-Path $dataDir 'config.json'
$daemonBase = 'http://127.0.0.1:7801'
$tailscaleExe = 'C:\Program Files\Tailscale\tailscale.exe'

function Get-DaemonHealth {
    try {
        return Invoke-RestMethod ($daemonBase + '/__dshremote/health') -TimeoutSec 2
    } catch {
        return $null
    }
}

function Get-DaemonRuntime {
    if (-not (Test-Path $runtimeFile)) { return $null }
    try {
        $runtime = Get-Content $runtimeFile -Raw | ConvertFrom-Json
        if ($runtime -and $runtime.pid -and (Get-Process -Id $runtime.pid -ErrorAction SilentlyContinue)) { return $runtime }
        return $null
    } catch {
        return $null
    }
}

function Get-PairingInfo {
    try {
        return Invoke-RestMethod ($daemonBase + '/__dshremote/pairing') -TimeoutSec 2
    } catch {
        return $null
    }
}

function Get-ServerAddress {
    $ip = ''
    if (Test-Path $configFile) {
        try {
            $config = Get-Content $configFile -Raw | ConvertFrom-Json
            if ($config.publicUrl) { return [string]$config.publicUrl }
        } catch {
            # 忽略损坏配置
        }
    }
    try {
        $status = & $tailscaleExe status 2>&1 | Select-Object -First 1
        if ($status -and $status -match '^(\d+\.\d+\.\d+\.\d+)') { $ip = $Matches[1] }
    } catch {
        # Tailscale 未安装
    }
    if ($ip -ne '') { return 'http://' + $ip + ':7801' }
    return 'http://127.0.0.1:7801'
}

function Get-TailscaleSummary {
    if (-not (Test-Path $tailscaleExe)) { return '未安装' }
    try {
        $status = & $tailscaleExe status 2>&1 | Select-Object -First 1
        if (-not $status) { return '未登录/未连接' }
        if ($status -match '^(\d+\.\d+\.\d+\.\d+)\s+(\S+)') { return $Matches[1] + '（在线）' }
        return [string]$status
    } catch {
        return '未运行'
    }
}

function Get-AutostartState {
    try {
        $task = Get-ScheduledTask -TaskName 'dshremote-daemon' -ErrorAction Stop
        if ($task.State -eq 'Disabled') { return @{ text = '已禁用'; enabled = $false } }
        return @{ text = '已启用（登录后自动启动）'; enabled = $true }
    } catch {
        return @{ text = '未配置'; enabled = $false }
    }
}

function Set-AutostartState {
    param([bool]$Enabled)
    try {
        if (-not (Get-ScheduledTask -TaskName 'dshremote-daemon' -ErrorAction SilentlyContinue)) {
            [System.Windows.Forms.MessageBox]::Show('未找到计划任务 dshremote-daemon，请先运行安装脚本。', '提示')
            return
        }
        if ($Enabled) {
            Enable-ScheduledTask -TaskName 'dshremote-daemon' | Out-Null
        } else {
            Disable-ScheduledTask -TaskName 'dshremote-daemon' | Out-Null
        }
    } catch {
        [System.Windows.Forms.MessageBox]::Show('操作失败：' + $_.Exception.Message, '提示')
    }
}

function Start-DaemonFromGui {
    try {
        $startScript = Join-Path $root 'tools\start.ps1'
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startScript -Background | Out-Null
        Start-Sleep -Milliseconds 900
    } catch {
        [System.Windows.Forms.MessageBox]::Show('启动失败：' + $_.Exception.Message, '提示')
    }
}

function Stop-DaemonFromGui {
    $runtime = Get-DaemonRuntime
    if (-not $runtime) { return }
    try {
        Stop-Process -Id $runtime.pid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 600
    } catch {
        # 忽略
    }
}

function Rotate-Pairing {
    try {
        Invoke-RestMethod ($daemonBase + '/__dshremote/pairing/rotate') -Method Post -TimeoutSec 3 | Out-Null
    } catch {
        [System.Windows.Forms.MessageBox]::Show('无法生成新配对码（daemon 未运行？）', '提示')
    }
}

function Get-DeviceList {
    try {
        return @(Invoke-RestMethod ($daemonBase + '/__dshremote/devices') -TimeoutSec 2 | ForEach-Object { $_.devices } | Where-Object { $_ })
    } catch {
        return @()
    }
}

# ── 界面 ────────────────────────────────────────────────────────────────

$fontUi = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$fontCode = New-Object System.Drawing.Font('Consolas', 26, [System.Drawing.FontStyle]::Bold)
$fontSmall = New-Object System.Drawing.Font('Microsoft YaHei UI', 8)

$form = New-Object System.Windows.Forms.Form
$form.Text = 'DSH Remote 管理面板'
$form.Size = New-Object System.Drawing.Size(860, 700)
$form.StartPosition = 'CenterScreen'
$form.Font = $fontUi
$form.BackColor = [System.Drawing.Color]::FromArgb(246, 248, 251)
$form.MaximizeBox = $false

$panelStatus = New-Object System.Windows.Forms.Panel
$panelStatus.Dock = 'Top'
$panelStatus.Height = 86
$panelStatus.BackColor = [System.Drawing.Color]::FromArgb(30, 41, 59)
$form.Controls.Add($panelStatus)

$labelTitle = New-Object System.Windows.Forms.Label
$labelTitle.Text = 'DSH Remote 管理面板'
$labelTitle.ForeColor = [System.Drawing.Color]::White
$labelTitle.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 13, [System.Drawing.FontStyle]::Bold)
$labelTitle.Location = New-Object System.Drawing.Point(16, 10)
$labelTitle.AutoSize = $true
$panelStatus.Controls.Add($labelTitle)

$labelDaemon = New-Object System.Windows.Forms.Label
$labelDaemon.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
$labelDaemon.Location = New-Object System.Drawing.Point(18, 44)
$labelDaemon.AutoSize = $true
$labelDaemon.Font = $fontSmall
$panelStatus.Controls.Add($labelDaemon)

$labelTailscale = New-Object System.Windows.Forms.Label
$labelTailscale.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
$labelTailscale.Location = New-Object System.Drawing.Point(260, 44)
$labelTailscale.AutoSize = $true
$labelTailscale.Font = $fontSmall
$panelStatus.Controls.Add($labelTailscale)

$labelAutostart = New-Object System.Windows.Forms.Label
$labelAutostart.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
$labelAutostart.Location = New-Object System.Drawing.Point(480, 44)
$labelAutostart.AutoSize = $true
$labelAutostart.Font = $fontSmall
$panelStatus.Controls.Add($labelAutostart)

# 控制按钮
$panelButtons = New-Object System.Windows.Forms.FlowLayoutPanel
$panelButtons.Location = New-Object System.Drawing.Point(16, 96)
$panelButtons.Size = New-Object System.Drawing.Size(820, 40)
$form.Controls.Add($panelButtons)

function New-Button {
    param([string]$Text, [int]$Width = 110, [string]$Color = 'Primary')
    $button = New-Object System.Windows.Forms.Button
    $button.Text = $Text
    $button.Width = $Width
    $button.Height = 32
    $button.FlatStyle = 'Flat'
    if ($Color -eq 'Danger') {
        $button.BackColor = [System.Drawing.Color]::FromArgb(220, 38, 38)
        $button.ForeColor = [System.Drawing.Color]::White
    } elseif ($Color -eq 'Safe') {
        $button.BackColor = [System.Drawing.Color]::FromArgb(22, 163, 74)
        $button.ForeColor = [System.Drawing.Color]::White
    } else {
        $button.BackColor = [System.Drawing.Color]::FromArgb(37, 99, 235)
        $button.ForeColor = [System.Drawing.Color]::White
    }
    $button.FlatAppearance.BorderSize = 0
    return $button
}

$buttonStart = New-Button '启动 daemon' 100 'Safe'
$panelButtons.Controls.Add($buttonStart)
$buttonStop = New-Button '停止 daemon' 100 'Danger'
$panelButtons.Controls.Add($buttonStop)
$buttonRestart = New-Button '重启 daemon' 100
$panelButtons.Controls.Add($buttonRestart)
$buttonRefresh = New-Button '刷新' 76
$panelButtons.Controls.Add($buttonRefresh)

# 配对区
$groupPair = New-Object System.Windows.Forms.GroupBox
$groupPair.Text = '手机配对'
$groupPair.Location = New-Object System.Drawing.Point(16, 142)
$groupPair.Size = New-Object System.Drawing.Size(400, 196)
$form.Controls.Add($groupPair)

$labelCodeTitle = New-Object System.Windows.Forms.Label
$labelCodeTitle.Text = '当前配对码'
$labelCodeTitle.Location = New-Object System.Drawing.Point(16, 24)
$labelCodeTitle.AutoSize = $true
$groupPair.Controls.Add($labelCodeTitle)

$labelCode = New-Object System.Windows.Forms.Label
$labelCode.Text = '------'
$labelCode.Font = $fontCode
$labelCode.ForeColor = [System.Drawing.Color]::FromArgb(15, 23, 42)
$labelCode.Location = New-Object System.Drawing.Point(14, 44)
$labelCode.AutoSize = $true
$groupPair.Controls.Add($labelCode)

$labelCodeExpire = New-Object System.Windows.Forms.Label
$labelCodeExpire.Text = ''
$labelCodeExpire.ForeColor = [System.Drawing.Color]::FromArgb(100, 116, 139)
$labelCodeExpire.Location = New-Object System.Drawing.Point(18, 100)
$labelCodeExpire.AutoSize = $true
$labelCodeExpire.Font = $fontSmall
$groupPair.Controls.Add($labelCodeExpire)

$buttonRotate = New-Button '重新生成配对码' 150
$buttonRotate.Location = New-Object System.Drawing.Point(14, 126)
$buttonRotate.Size = New-Object System.Drawing.Size(150, 32)
$groupPair.Controls.Add($buttonRotate)

$buttonQr = New-Button '打开二维码页面' 150
$buttonQr.Location = New-Object System.Drawing.Point(176, 126)
$buttonQr.Size = New-Object System.Drawing.Size(150, 32)
$groupPair.Controls.Add($buttonQr)

$labelPairHint = New-Object System.Windows.Forms.Label
$labelPairHint.Text = '手机 DSH Remote：填右侧服务器地址 + 上面配对码（或扫二维码）'
$labelPairHint.ForeColor = [System.Drawing.Color]::FromArgb(100, 116, 139)
$labelPairHint.Location = New-Object System.Drawing.Point(16, 166)
$labelPairHint.AutoSize = $true
$labelPairHint.Font = $fontSmall
$groupPair.Controls.Add($labelPairHint)

# 服务器地址区
$groupServer = New-Object System.Windows.Forms.GroupBox
$groupServer.Text = '服务器地址（手机连接用）'
$groupServer.Location = New-Object System.Drawing.Point(428, 142)
$groupServer.Size = New-Object System.Drawing.Size(408, 196)
$form.Controls.Add($groupServer)

$textServer = New-Object System.Windows.Forms.TextBox
$textServer.ReadOnly = $true
$textServer.Font = New-Object System.Drawing.Font('Consolas', 12)
$textServer.Location = New-Object System.Drawing.Point(16, 32)
$textServer.Size = New-Object System.Drawing.Size(370, 30)
$groupServer.Controls.Add($textServer)

$buttonCopyServer = New-Button '复制地址' 110
$buttonCopyServer.Location = New-Object System.Drawing.Point(16, 76)
$buttonCopyServer.Size = New-Object System.Drawing.Size(110, 32)
$groupServer.Controls.Add($buttonCopyServer)

$labelServerHint = New-Object System.Windows.Forms.Label
$labelServerHint.Text = '手机需先连上同一 Tailscale 私有网络（App 开着 VPN）。'
$labelServerHint.ForeColor = [System.Drawing.Color]::FromArgb(100, 116, 139)
$labelServerHint.Location = New-Object System.Drawing.Point(16, 150)
$labelServerHint.AutoSize = $true
$labelServerHint.Font = $fontSmall
$groupServer.Controls.Add($labelServerHint)

$labelServerHint2 = New-Object System.Windows.Forms.Label
$labelServerHint2.Text = 'Tailscale 与梯子互斥：用 DSH 时先关梯子。'
$labelServerHint2.ForeColor = [System.Drawing.Color]::FromArgb(100, 116, 139)
$labelServerHint2.Location = New-Object System.Drawing.Point(16, 170)
$labelServerHint2.AutoSize = $true
$labelServerHint2.Font = $fontSmall
$groupServer.Controls.Add($labelServerHint2)

# 设备区
$groupDevices = New-Object System.Windows.Forms.GroupBox
$groupDevices.Text = '已配对设备'
$groupDevices.Location = New-Object System.Drawing.Point(16, 344)
$groupDevices.Size = New-Object System.Drawing.Size(820, 250)
$form.Controls.Add($groupDevices)

$listDevices = New-Object System.Windows.Forms.ListView
$listDevices.Location = New-Object System.Drawing.Point(12, 24)
$listDevices.Size = New-Object System.Drawing.Size(796, 210)
$listDevices.View = 'Details'
$listDevices.FullRowSelect = $true
$listDevices.GridLines = $true
[void]$listDevices.Columns.Add('设备 ID', 120)
[void]$listDevices.Columns.Add('名称', 120)
[void]$listDevices.Columns.Add('最后使用', 170)
[void]$listDevices.Columns.Add('到期时间', 170)
$groupDevices.Controls.Add($listDevices)

# 底部工具按钮
$panelTools = New-Object System.Windows.Forms.FlowLayoutPanel
$panelTools.Location = New-Object System.Drawing.Point(16, 604)
$panelTools.Size = New-Object System.Drawing.Size(820, 44)
$form.Controls.Add($panelTools)

$buttonRevoke = New-Button '吊销选中设备' 120 'Danger'
$panelTools.Controls.Add($buttonRevoke)
$buttonToggleAutostart = New-Button '切换开机自启' 120
$panelTools.Controls.Add($buttonToggleAutostart)
$buttonLog = New-Button '查看日志' 90
$panelTools.Controls.Add($buttonLog)
$buttonFolder = New-Button '打开项目目录' 110
$panelTools.Controls.Add($buttonFolder)
$buttonTailscale = New-Button '打开 Tailscale' 110
$panelTools.Controls.Add($buttonTailscale)

# ── 刷新逻辑 ────────────────────────────────────────────────────────────

function Refresh-Ui {
    $health = Get-DaemonHealth
    $runtime = Get-DaemonRuntime
    if ($health) {
        $mode = if ($runtime -and $runtime.hostMode -eq 'plugin') { '接管模式' } else { '自启模式' }
        $upstream = if ($runtime) { $runtime.upstream } else { '' }
        $labelDaemon.Text = 'daemon：运行中  pid ' + $health.pid + '  ' + $mode + '  ' + $upstream
        $labelDaemon.ForeColor = [System.Drawing.Color]::FromArgb(74, 222, 128)
    } else {
        $labelDaemon.Text = 'daemon：未运行'
        $labelDaemon.ForeColor = [System.Drawing.Color]::FromArgb(248, 113, 113)
    }
    $labelTailscale.Text = 'Tailscale：' + (Get-TailscaleSummary)
    $auto = Get-AutostartState
    $labelAutostart.Text = '开机自启：' + $auto.text

    $pairing = Get-PairingInfo
    if ($pairing -and $pairing.code) {
        $labelCode.Text = [string]$pairing.code
        if ($pairing.expiresAt) {
            try {
                $expires = ([datetimeoffset]::Parse([string]$pairing.expiresAt)).LocalDateTime
                if ($expires -lt (Get-Date)) {
                    $labelCodeExpire.Text = '已过期（' + $expires.ToString('HH:mm') + '），点「重新生成配对码」'
                    $labelCodeExpire.ForeColor = [System.Drawing.Color]::FromArgb(220, 38, 38)
                } else {
                    $labelCodeExpire.Text = '有效期至 ' + $expires.ToString('HH:mm:ss')
                    $labelCodeExpire.ForeColor = [System.Drawing.Color]::FromArgb(22, 101, 52)
                }
            } catch {
                $labelCodeExpire.Text = ''
            }
        }
    } else {
        $labelCode.Text = '------'
        $labelCodeExpire.Text = if ($health) { '' } else { 'daemon 未运行' }
    }

    $textServer.Text = Get-ServerAddress

    $devices = @(Get-DeviceList)
    $selected = if ($listDevices.SelectedItems.Count -gt 0) { $listDevices.SelectedItems[0].Text } else { '' }
    $listDevices.BeginUpdate()
    $listDevices.Items.Clear()
    foreach ($device in $devices) {
        $item = New-Object System.Windows.Forms.ListViewItem([string]$device.id)
        [void]$item.SubItems.Add([string]$device.name)
        [void]$item.SubItems.Add((Format-TimeText $device.lastSeenAt))
        [void]$item.SubItems.Add((Format-TimeText $device.expiresAt))
        [void]$listDevices.Items.Add($item)
        if ($selected -ne '' -and [string]$device.id -eq $selected) { $item.Selected = $true }
    }
    $listDevices.EndUpdate()
}

function Format-TimeText {
    param($value)
    if (-not $value) { return '' }
    try {
        return ([datetimeoffset]::Parse([string]$value)).LocalDateTime.ToString('yyyy-MM-dd HH:mm')
    } catch {
        return [string]$value
    }
}

# ── 事件 ────────────────────────────────────────────────────────────────

$buttonStart.Add_Click({ Start-DaemonFromGui; Refresh-Ui })
$buttonStop.Add_Click({ Stop-DaemonFromGui; Refresh-Ui })
$buttonRestart.Add_Click({ Stop-DaemonFromGui; Start-Sleep -Milliseconds 500; Start-DaemonFromGui; Refresh-Ui })
$buttonRefresh.Add_Click({ Refresh-Ui })
$buttonRotate.Add_Click({ Rotate-Pairing; Refresh-Ui })
$buttonQr.Add_Click({ Start-Process ($daemonBase + '/pair') })
$buttonCopyServer.Add_Click({
    try {
        [System.Windows.Forms.Clipboard]::SetText($textServer.Text)
        $buttonCopyServer.Text = '已复制'
        $timerCopy.Enabled = $true
    } catch {
        # 忽略
    }
})
$buttonRevoke.Add_Click({
    if ($listDevices.SelectedItems.Count -eq 0) {
        [System.Windows.Forms.MessageBox]::Show('请先在列表里选中一台设备。', '提示')
        return
    }
    $id = $listDevices.SelectedItems[0].Text
    $confirmed = [System.Windows.Forms.MessageBox]::Show('确定吊销设备 ' + $id + ' 吗？吊销后该设备需要重新配对。', '确认', 'YesNo', 'Warning')
    if ($confirmed -ne 'Yes') { return }
    try {
        $body = @{ id = $id } | ConvertTo-Json
        Invoke-RestMethod ($daemonBase + '/__dshremote/devices/revoke') -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 3 | Out-Null
    } catch {
        [System.Windows.Forms.MessageBox]::Show('吊销失败：' + $_.Exception.Message, '提示')
    }
    Refresh-Ui
})
$buttonToggleAutostart.Add_Click({
    $auto = Get-AutostartState
    Set-AutostartState -Enabled (-not $auto.enabled)
    Refresh-Ui
})
$buttonLog.Add_Click({
    $logFile = Join-Path $dataDir 'daemon.log'
    if (Test-Path $logFile) { Start-Process notepad.exe $logFile } else { [System.Windows.Forms.MessageBox]::Show('还没有日志文件。', '提示') }
})
$buttonFolder.Add_Click({ Start-Process explorer.exe $root })
$buttonTailscale.Add_Click({
    if (Test-Path $tailscaleExe) {
        Start-Process $tailscaleExe
    } else {
        Start-Process 'https://tailscale.com/download'
    }
})

# 刷新定时器
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({ Refresh-Ui })
$timer.Start()

$timerCopy = New-Object System.Windows.Forms.Timer
$timerCopy.Interval = 1500
$timerCopy.Add_Tick({ $buttonCopyServer.Text = '复制地址'; $timerCopy.Enabled = $false })

# 初始刷新
Refresh-Ui

if ($Screenshot -ne '') {
    # 自动截图模式：用于验证界面布局（手动跑消息循环，避免依赖 Application.Run）
    $form.Show()
    [System.Windows.Forms.Application]::DoEvents()
    $captured = $false
    $deadline = (Get-Date).AddSeconds(12)
    while ((Get-Date) -lt $deadline -and -not $captured) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 150
        try {
            $bitmap = New-Object System.Drawing.Bitmap($form.Width, $form.Height)
            $form.DrawToBitmap($bitmap, (New-Object System.Drawing.Rectangle(0, 0, $form.Width, $form.Height)))
            $bitmap.Save($Screenshot, [System.Drawing.Imaging.ImageFormat]::Png)
            $bitmap.Dispose()
            $captured = $true
        } catch {
            Start-Sleep -Milliseconds 300
        }
    }
    if (-not $captured) {
        (Get-Date).ToString('o') + ' capture failed' | Set-Content -Path (Join-Path $dataDir 'gui-capture.err')
    }
    $form.Close()
    [System.Windows.Forms.Application]::DoEvents()
    exit 0
}

[System.Windows.Forms.Application]::Run($form)
