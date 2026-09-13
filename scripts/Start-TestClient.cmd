@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-TestClient.ps1" %*
set "codletStartExit=%errorlevel%"
if "%codletStartExit%"=="0" exit /b 0
echo.
echo Startup was not confirmed. Review the error and log paths above.
pause
exit /b %codletStartExit%
