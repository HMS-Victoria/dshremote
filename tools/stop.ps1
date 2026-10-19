# 停止后台运行的 dshremote daemon（含自启模式下 spawn 的 dsh web 宿主）
# 用法：.\tools\stop.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runtimeFile = Join-Path $root '.data\runtime.json'

$daemonPid = $null
if (Test-Path $runtimeFile) {
    $runtime = Get-Content $runtimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($runtime.pid) { $daemonPid = [int]$runtime.pid }
}

if ($daemonPid -and (Get-Process -Id $daemonPid -ErrorAction SilentlyContinue)) {
    Write-Host ("停止 daemon（pid " + $daemonPid + "）…")
    Stop-Process -Id $daemonPid -Force -ErrorAction SilentlyContinue
} else {
    Write-Host 'daemon 未在运行'
}

# 自启模式会 spawn 一个 `dsh --profile web` 宿主；daemon 被强杀时它会变成孤儿，这里一并清理。
$hosts = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -match 'dsh-desktop-host\\lib\\cli\.js' -and $_.CommandLine -match '--profile web'
}
foreach ($host in $hosts) {
    Write-Host ("停止自启宿主（pid " + $host.ProcessId + "）…")
    Stop-Process -Id $host.ProcessId -Force -ErrorAction SilentlyContinue
}

Write-Host '已停止' -ForegroundColor Green
