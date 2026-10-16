@echo off
rem Builds the prebuilt Windows package (for the owner / the builder, NOT for users: users only need the finished zip).
rem Needs Node.js 22.12+ and git on this PC. Usage: scripts\build-package.cmd --out D:\legion-release [--skip-build] [--allow-dirty]
setlocal
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Building the package needs Node.js 22.12 or newer on this PC: winget install OpenJS.NodeJS.LTS
  exit /b 1
)
node "%~dp0build-package.mjs" %*
exit /b %ERRORLEVEL%
