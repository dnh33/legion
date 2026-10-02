@echo off
rem Unattended install/update: no questions, no key press. Stops a running Legion, installs, builds, makes the shortcuts and starts Legion.
rem Extra args go to setup.ps1 (e.g. -InstallDir "C:\Legion" -NoLaunch).
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1" -Yes %*
exit /b %ERRORLEVEL%
