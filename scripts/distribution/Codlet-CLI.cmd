@echo off
setlocal
if exist "%~dp0portable.mode" if not defined CODLET_HOME set "CODLET_HOME=%~dp0data"
"%~dp0codlet.exe" %*
