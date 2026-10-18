# Install Android command-line SDK into D:\Android (default).
# Usage: pwsh -NoProfile -ExecutionPolicy Bypass -File tools\android-setup.ps1
# Requires JDK 17+ (Microsoft OpenJDK 21 on this machine).
param(
    [string]$SdkRoot = 'D:\Android',
    [string]$CmdlineToolsUrl = 'https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip',
    [string]$JdkHome = 'C:\Program Files\Microsoft\jdk-21.0.10.7-hotspot'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Step([string]$message) {
    Write-Host "[android-setup] $message"
}

if (-not (Test-Path $JdkHome)) {
    throw "JDK not found: $JdkHome (pass -JdkHome)"
}
$env:JAVA_HOME = $JdkHome

$sdkmanager = Join-Path $SdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat'
if (-not (Test-Path $sdkmanager)) {
    Write-Step "Downloading Android command-line tools ..."
    New-Item -ItemType Directory -Force -Path (Join-Path $SdkRoot 'cmdline-tools') | Out-Null
    $zip = Join-Path $env:TEMP 'android-commandlinetools.zip'
    Invoke-WebRequest -Uri $CmdlineToolsUrl -OutFile $zip
    Write-Step "Extracting command-line tools ..."
    $tmp = Join-Path $env:TEMP 'android-commandlinetools-extract'
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $source = Join-Path $tmp 'cmdline-tools'
    $target = Join-Path $SdkRoot 'cmdline-tools\latest'
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    Move-Item -Path $source -Destination $target
    Remove-Item -Recurse -Force $tmp
    Remove-Item -Force $zip
}

Write-Step "Accepting SDK licenses ..."
$yes = (1..40 | ForEach-Object { 'y' })
$yes | & $sdkmanager --sdk_root=$SdkRoot --licenses | Out-Null

Write-Step "Installing platform-tools / platforms;android-35 / build-tools;35.0.0 ..."
& $sdkmanager --sdk_root=$SdkRoot 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0' 'cmdline-tools;latest'

Write-Step "Done. Installed packages:"
& $sdkmanager --sdk_root=$SdkRoot --list_installed
Write-Step "SDK root: $SdkRoot"
