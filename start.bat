@echo off
cd /d "%~dp0"
node -v >nul 2>&1
if errorlevel 1 goto nonode
chcp 65001 >nul

:run
node server.js
rem exit code 3 = updated itself, start again (no new dashboard tab)
if errorlevel 3 if not errorlevel 4 (
  set NO_OPEN=1
  goto run
)
pause
exit /b

:nonode
echo Node.js is not installed on this computer.
echo Please install it from https://nodejs.org (LTS) and run this file again.
pause
