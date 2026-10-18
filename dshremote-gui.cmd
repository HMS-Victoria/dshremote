@echo off
rem 双击启动 DSH Remote 图形管理面板
cd /d "%~dp0"
start "" powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0tools\gui.ps1"
