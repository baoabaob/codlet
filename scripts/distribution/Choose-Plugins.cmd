@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Initialize-Codlet.ps1" -Configure -NoLaunch
if errorlevel 1 pause
