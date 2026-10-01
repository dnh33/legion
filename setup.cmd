@echo off
rem Double-click to install/update Legion in %LOCALAPPDATA%\Programs\Legion. Extra args go to setup.ps1 (e.g. -InstallDir "C:\Legion").
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1" %*
echo.
pause
