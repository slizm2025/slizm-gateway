@echo off
chcp 65001 >nul
cd /d "%~dp0"
node scripts\gw.js start
if errorlevel 1 (
  echo.
  echo Startup failed. Recent log:
  node scripts\gw.js logs 25
)
pause
