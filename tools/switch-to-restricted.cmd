@echo off
rem 在独立窗口里把 DSH + dshremote daemon 切换为“受限令牌（无管理员权限）”运行。
rem 注意：请从文件资源管理器双击本文件运行，不要在 DSH 的对话/终端里运行（会重启 DSH）。
cd /d "%~dp0"
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-restricted.ps1"
echo.
echo 已在新窗口中执行切换脚本，本窗口可以关闭。
echo 如果新窗口一闪而过，请以管理员身份打开 PowerShell 后执行：
echo   cd /d "%~dp0.."
echo   .\tools\start-restricted.ps1
timeout /t 5 >nul
