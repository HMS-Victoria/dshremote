@echo off
rem 在独立窗口里把 DSH + dshremote daemon 切回普通（管理员权限）启动。
rem 注意：请从文件资源管理器双击本文件运行，不要在 DSH 的对话/终端里运行（会重启 DSH）。
cd /d "%~dp0"
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-normal.ps1"
echo.
echo 已在新窗口中执行恢复脚本，本窗口可以关闭。
timeout /t 5 >nul
