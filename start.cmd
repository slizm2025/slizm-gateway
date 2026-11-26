@echo off
setlocal
cd /d "%~dp0"
start "" wscript.exe //Nologo "%~dp0start.vbs"
exit /b 0
