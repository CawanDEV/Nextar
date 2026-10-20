@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0local\start-windows.ps1"
set "NEXTAR_EXIT=%ERRORLEVEL%"
echo.
if not "%NEXTAR_EXIT%"=="0" echo O Nextar nao iniciou. Confira a mensagem acima.
pause
exit /b %NEXTAR_EXIT%
