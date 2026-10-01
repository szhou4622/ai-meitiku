@echo off
chcp 65001 >nul
set "SCRIPT_DIR=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%collect-xhs-download-diagnostics.ps1"
echo.
echo 如果上方显示“诊断完成”，请发送桌面生成的“AI媒体库-小红书诊断-日期时间.zip”。
pause
