@echo off
setlocal
cd /d "%~dp0"
start "" wscript.exe //Nologo "%~dp0open.vbs"
exit /b 0
