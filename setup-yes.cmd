@echo off
rem Unattended install/update: no questions. Stops a running Legion, installs, builds, makes the shortcuts and starts Legion.
rem Extra args go to setup.ps1 (e.g. -InstallDir "C:\Legion" -NoLaunch).
rem On success it closes at once. On failure it keeps the window open (pause) so the message can be read, unless input is
rem redirected (a script, CI, Task Scheduler), where it never waits.
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1" -Yes %*
set "LEGION_RC=%ERRORLEVEL%"
if "%LEGION_RC%"=="0" exit /b 0
powershell -NoProfile -Command "if ([Console]::IsInputRedirected) { exit 1 } else { exit 0 }"
if errorlevel 1 exit /b %LEGION_RC%
echo.
echo Legion setup failed (exit code %LEGION_RC%). Read the message above, fix it, then run setup-yes.cmd again.
echo.
pause
exit /b %LEGION_RC%
