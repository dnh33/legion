@echo off
cd /d "%~dp0"
rem A prebuilt package carries its own runtime: no Node, no npm, no build.
if exist "%~dp0runtime\electron\electron.exe" (
  start "" "%~dp0runtime\electron\electron.exe" "%~dp0."
  exit /b 0
)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20+ is required. Install it with: winget install OpenJS.NodeJS.LTS
  pause
  exit /b 1
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo Dependencies missing - run setup.cmd first.
  pause
  exit /b 1
)
if not exist "dist\src\electron\main.js" call npm run build
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
