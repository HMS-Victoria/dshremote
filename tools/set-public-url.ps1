# 设置外网访问地址（用于 Tailscale Funnel / frp / 域名等隧道）
# 用法：
#   .\tools\set-public-url.ps1 -Url "https://your-pc.tailnet-name.ts.net"
#   .\tools\set-public-url.ps1 -Url "https://xxxx.frp.example.com" -Restart
param(
    [Parameter(Mandatory = $true)][string]$Url,
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$configFile = Join-Path $root '.data\config.json'

if ($Url -notmatch '^https?://') { throw "地址需要以 http:// 或 https:// 开头：$Url" }

$config = @{}
if (Test-Path $configFile) {
    $raw = Get-Content $configFile -Raw
    if ($raw.Trim() -ne '') {
        $parsed = $raw | ConvertFrom-Json
        foreach ($property in $parsed.PSObject.Properties) { $config[$property.Name] = $property.Value }
    }
}
$config['publicUrl'] = $Url.TrimEnd('/')
New-Item -ItemType Directory -Force -Path (Join-Path $root '.data') | Out-Null
($config | ConvertTo-Json -Depth 8) + "`n" | Set-Content -Path $configFile -Encoding utf8 -NoNewline

Write-Host ('已设置外网地址 publicUrl = ' + $config['publicUrl']) -ForegroundColor Green

if ($Restart) {
    & (Join-Path $PSScriptRoot 'stop.ps1')
    Start-Sleep -Seconds 1
    & (Join-Path $PSScriptRoot 'start.ps1') -Background
    Start-Sleep -Seconds 3
    & (Join-Path $PSScriptRoot 'pair-info.ps1')
} else {
    Write-Host '重启 daemon 后生效：' -ForegroundColor Yellow
    Write-Host '  .\tools\stop.ps1'
    Write-Host '  .\tools\start.ps1 -Background'
    Write-Host '  .\tools\pair-info.ps1'
}
